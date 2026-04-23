// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title TeamVesting
 * @notice Cofre de vesting linear com cliff para distribuir GOV a um unico
 *         beneficiario do time. Padrao de deploy: uma instancia por membro
 *         (ou grupo custodiado por multi-sig). Simplifica contabilidade
 *         off-chain e isola revogacao — se alguem sai, a DAO revoga APENAS
 *         aquela instancia, sem afetar os demais.
 * @dev Convencoes de vesting:
 *      - `start` = timestamp de inicio do vesting (normalmente TGE).
 *      - `cliff` = offset em segundos a partir de `start`. Antes de
 *        `start + cliff`, releasable == 0.
 *      - `duration` = duracao TOTAL em segundos (inclui o cliff). Depois
 *        de `start + duration`, releasable == alocacao total.
 *      - Entre `start + cliff` e `start + duration`, o vested cresce
 *        linearmente por (timestamp - start) / duration — ou seja, no
 *        exato momento do cliff o beneficiario recebe `cliff / duration`
 *        da alocacao de uma vez (padrao "hockey stick" da industria).
 *
 *      Exemplo da proposta de distribuicao do repo (cliff 12m + linear 36m):
 *        cliff    = 365 days
 *        duration = 4 * 365 days  (= cliff + 3 anos = 48 meses totais)
 *        No TGE+12m, libera 25% de uma vez; depois disso pinga linearmente
 *        ate TGE+48m, quando libera os 75% restantes completos.
 *
 *      Custodia:
 *      - Alocacao e capturada dinamicamente: `totalAllocation() =
 *        balanceOf(this) + released`. Ou seja, o `owner` (Timelock) funda
 *        o contrato transferindo GOV via `gov.transfer(vesting, X)` apos
 *        o deploy, e o cronograma automaticamente reflete essa quantia.
 *        Transferencias adicionais posteriores aumentam a alocacao em
 *        tempo real (raramente desejavel; a DAO pode evitar simplesmente
 *        nao enviando mais). Esse e o mesmo padrao do OZ `VestingWallet`.
 *
 *      Revogacao:
 *      - O `owner` (Timelock via proposta) pode chamar {revoke} uma unica
 *        vez. Efeitos: (1) congela a fronteira de vesting em
 *        `totalAllocatedAtRevoke = vestedAmount(now)`; (2) devolve o
 *        saldo nao-vested imediatamente para `returnTo` (Treasury
 *        normalmente). O beneficiario continua podendo chamar {release}
 *        para sacar qualquer porcao vested-but-not-yet-released. Apos
 *        revoke, `vestedAmount` fica travado em `totalAllocatedAtRevoke`
 *        — o cronograma nao retoma se mais tokens forem enviados depois
 *        (imutabilidade contratual pos-revogacao).
 *
 *      Ownable2Step:
 *      - Deliberadamente escolhido (em vez de AccessControl) porque a
 *        autoridade sobre revogacao e inerentemente singular (DAO via
 *        Timelock) e o mecanismo 2-step protege contra transferencia
 *        de propriedade para endereco errado durante migracao.
 *
 *      Nao pausavel:
 *      - Mesma racional do Treasury: adicionar pause exigiria definir
 *        quem pode pausar, e qualquer poder unilateral de congelar o
 *        vesting do time e um vetor de captura. Se houver necessidade
 *        de "pausa", a DAO aprova uma proposta de {revoke} — que e
 *        semanticamente mais honesto.
 * @custom:security-contact security@web3community.example
 */
contract TeamVesting is Ownable2Step {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    /// @notice Token sendo vested (em producao: GOV).
    IERC20 public immutable token;

    /// @notice Endereco que recebe os tokens liberados.
    address public immutable beneficiary;

    /// @notice Timestamp (unix seconds) em que o cronograma inicia.
    uint64 public immutable start;

    /// @notice Offset em segundos a partir de `start`. Antes do cliff,
    ///         releasable == 0.
    uint64 public immutable cliff;

    /// @notice Duracao TOTAL do cronograma em segundos (inclui o cliff).
    uint64 public immutable duration;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @notice Total ja sacado pelo beneficiario via {release}.
    uint256 public released;

    /// @notice `true` apos uma chamada bem-sucedida a {revoke}.
    bool public revoked;

    /// @notice Timestamp do revoke (0 se nao revogado).
    uint64 public revokedAt;

    /// @notice Fronteira de vesting travada no momento do revoke. Apos
    ///         revoke, {vestedAmount} retorna sempre este valor.
    uint256 public totalAllocatedAtRevoke;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido a cada liberacao para o beneficiario via {release}.
    /// @param beneficiary Endereco que recebeu.
    /// @param amount Quantidade transferida.
    event Released(address indexed beneficiary, uint256 amount);

    /// @notice Emitido na unica chamada a {revoke} bem-sucedida.
    /// @param returnedTo Destinatario da porcao nao-vested (Treasury).
    /// @param unvestedReturned Quantidade devolvida (pode ser zero se
    ///        revoke ocorre apos `start + duration`).
    /// @param frozenVested Valor congelado de {vestedAmount} pos-revoke.
    event Revoked(address indexed returnedTo, uint256 unvestedReturned, uint256 frozenVested);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Duracao zero nao faz sentido (divisao por zero).
    error ZeroDuration();

    /// @notice Cliff maior que duracao seria trava permanente.
    error CliffExceedsDuration();

    /// @notice Nada liberado (vested <= released ou cliff nao atingido).
    error NothingToRelease();

    /// @notice {revoke} e one-shot.
    error AlreadyRevoked();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Configura cronograma imutavel. O contrato nao detem tokens
     *         ainda — o owner funda transferindo `token` para este
     *         endereco apos o deploy.
     * @dev Nao valida que `start` e futuro: a DAO pode deliberadamente
     *      iniciar o cronograma no passado (ex.: reconhecimento de
     *      servico anterior ao TGE). Se o beneficiario chama {release}
     *      logo apos o deploy e o passado for suficiente, o primeiro
     *      saque e imediato — comportamento intencional.
     * @param token_ ERC-20 sendo vested (GOV em producao).
     * @param beneficiary_ Endereco que recebe os releases.
     * @param start_ Timestamp de inicio do cronograma (unix seconds).
     * @param cliff_ Offset em segundos a partir de `start_`. Use 0 para
     *        desabilitar cliff.
     * @param duration_ Duracao total em segundos (inclui o cliff).
     * @param owner_ Endereco com poder de revogar (Timelock em producao).
     */
    constructor(
        address token_,
        address beneficiary_,
        uint64 start_,
        uint64 cliff_,
        uint64 duration_,
        address owner_
    ) Ownable(owner_) {
        if (token_ == address(0) || beneficiary_ == address(0)) {
            revert ZeroAddress();
        }
        if (duration_ == 0) {
            revert ZeroDuration();
        }
        if (cliff_ > duration_) {
            revert CliffExceedsDuration();
        }
        token = IERC20(token_);
        beneficiary = beneficiary_;
        start = start_;
        cliff = cliff_;
        duration = duration_;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Quantidade total ja vested em `timestamp`. Depois de
     *         revoke, retorna `totalAllocatedAtRevoke` (travado).
     * @param timestamp Unix seconds para consultar.
     */
    function vestedAmount(uint64 timestamp) public view returns (uint256) {
        return _vestedAmount(timestamp);
    }

    /**
     * @notice Quantidade pronta para saque agora (vested - released).
     */
    function releasable() public view returns (uint256) {
        uint256 vested = _vestedAmount(uint64(block.timestamp));
        if (vested <= released) {
            return 0;
        }
        return vested - released;
    }

    /**
     * @notice Alocacao total atualmente reconhecida pelo contrato.
     * @dev Antes de revoke: `balanceOf(this) + released`. Apos revoke:
     *      a fronteira congelada — o beneficiario so tem direito ao
     *      que estava vested no momento do revoke, independente de
     *      quanto saldo o contrato ainda carrega.
     */
    function totalAllocation() public view returns (uint256) {
        if (revoked) {
            return totalAllocatedAtRevoke;
        }
        return token.balanceOf(address(this)) + released;
    }

    // ------------------------------------------------------------------
    // Mutating — beneficiary
    // ------------------------------------------------------------------

    /**
     * @notice Saca tudo que esta releasable para o beneficiario.
     * @dev Pull-based: qualquer um pode chamar (ex.: o proprio
     *      beneficiario, um keeper), mas os tokens sempre vao para
     *      `beneficiary`. Reverte com {NothingToRelease} se nao ha
     *      nada para sacar — evita tx poluindo logs.
     *      CEI: checks -> effect (released += amount) -> interaction
     *      (safeTransfer). `safeTransfer` em token arbitrario e
     *      suficiente porque o owner e o Timelock (controle indireto
     *      do beneficiary); nao ha superficie de reentrancy relevante
     *      dado que `released` e incrementado antes da interacao.
     */
    function release() external {
        uint256 amount = releasable();
        if (amount == 0) {
            revert NothingToRelease();
        }
        released += amount;
        emit Released(beneficiary, amount);
        token.safeTransfer(beneficiary, amount);
    }

    // ------------------------------------------------------------------
    // Mutating — owner (DAO via Timelock)
    // ------------------------------------------------------------------

    /**
     * @notice Revoga o vesting. Congela a fronteira de vesting e devolve
     *         o saldo nao-vested para `returnTo` (Treasury).
     * @dev One-shot: chamadas subsequentes revertem com {AlreadyRevoked}.
     *      NAO transfere o vested-but-unreleased para o beneficiario
     *      automaticamente — o beneficiario deve chamar {release} para
     *      coletar. Essa separacao e intencional: mantem a UX "pull"
     *      do vested e evita transferencia surpresa para `beneficiary`
     *      (que pode ser um multi-sig offline no momento da proposta).
     *
     *      Cenarios por timing:
     *      - Antes do cliff: `vested = 0`, tudo volta para `returnTo`.
     *      - Entre cliff e duration: parte volta, parte fica travada
     *        pro beneficiario.
     *      - Depois de duration: nada volta (tudo ja era vested); o
     *        contrato so trava a fronteira em `totalAllocation`.
     *
     *      `released` NAO e alterado — continua contabilizando saques
     *      passados. O invariante `released <= totalAllocatedAtRevoke`
     *      e garantido porque em qualquer saque passado `released <=
     *      vestedAmount(t) <= vestedAmount(now)`.
     * @param returnTo Destinatario da porcao nao-vested. Tipicamente
     *        o Treasury da DAO.
     */
    function revoke(address returnTo) external onlyOwner {
        if (revoked) {
            revert AlreadyRevoked();
        }
        if (returnTo == address(0)) {
            revert ZeroAddress();
        }

        uint256 vestedNow = _vestedAmount(uint64(block.timestamp));
        uint256 currentBalance = token.balanceOf(address(this));
        uint256 total = currentBalance + released;
        uint256 unvested = total > vestedNow ? total - vestedNow : 0;

        revoked = true;
        revokedAt = uint64(block.timestamp);
        totalAllocatedAtRevoke = vestedNow;

        emit Revoked(returnTo, unvested, vestedNow);
        if (unvested > 0) {
            token.safeTransfer(returnTo, unvested);
        }
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /**
     * @dev Formula linear padrao OZ:
     *        vested(t) = 0                                  se t < start + cliff
     *        vested(t) = total                              se t >= start + duration
     *        vested(t) = total * (t - start) / duration     caso contrario
     *      Apos revoke, ignora a formula e retorna
     *      `totalAllocatedAtRevoke` (fronteira travada).
     */
    function _vestedAmount(uint64 timestamp) private view returns (uint256) {
        if (revoked) {
            return totalAllocatedAtRevoke;
        }
        uint64 cliffEnd = start + cliff;
        if (timestamp < cliffEnd) {
            return 0;
        }
        uint256 total = token.balanceOf(address(this)) + released;
        if (timestamp >= start + duration) {
            return total;
        }
        return (total * (timestamp - start)) / duration;
    }
}
