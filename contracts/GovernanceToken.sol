// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title GovernanceToken (GOV)
 * @notice Token ERC-20 com voto on-chain (ERC-5805 via ERC20Votes) e supply cap imutável
 *         para a DAO Web3Community. Emissão controlada pelo owner, que em produção é o
 *         TimelockController (transferência em 2 passos via Ownable2Step).
 * @dev Invariantes atendidas nesta unidade:
 *      - I1: Supply total limitado ao {cap}, enforced em {_update}; mint acima reverte.
 *      - I5: Voto via snapshot (ERC20Votes), nunca `balanceOf` atual — previne flash loan
 *            attacks na votação.
 *      O contrato deliberadamente NÃO pré-minta supply no constructor: toda a distribuição
 *      (30/25/20/15/10) acontece via chamadas explícitas de {mint} pelo owner, permitindo
 *      que o deploy orquestre endereços de treasury, cofre de vesting, sale, etc. sem
 *      hardcode. Uma vez o cap atingido, novos mints são impossíveis.
 * @custom:security-contact security@web3community.example
 */
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes, Ownable2Step {
    /// @notice Supply máximo imutável em unidades mínimas (wei-equivalent, 1e18 precision).
    /// @dev Fixado em 100.000.000 * 10^18. Cabe em uint208 do ERC20Votes sem risco de overflow.
    // solhint-disable-next-line var-name-mixedcase
    uint256 public immutable CAP_SUPPLY;

    /// @notice Emitido em todo mint bem-sucedido, com uma tag livre para rastrear a distribuição.
    /// @param to Endereço que recebeu os tokens cunhados.
    /// @param amount Quantidade cunhada (em unidades mínimas).
    /// @param tag Rótulo off-chain para o bucket (ex.: "treasury", "team", "publicSale").
    event Minted(address indexed to, uint256 amount, string tag);

    /// @notice Tentativa de mint excederia o supply cap imutável.
    /// @param attemptedSupply Supply total que resultaria do mint solicitado.
    /// @param cap Supply cap atual (imutável).
    error CapExceeded(uint256 attemptedSupply, uint256 cap);

    /// @notice Endereço zero não é válido como destinatário.
    error ZeroAddress();

    /// @notice Valor zero não é permitido em operações que exigem amount > 0.
    error ZeroAmount();

    /**
     * @notice Cria o token de governança com cap fixo de 100M * 10^18.
     * @dev O domain separator do EIP-712 usa `name` + version "1" (ver {ERC20Permit}).
     *      `initialOwner` deve ser o deployer em testnet local e o TimelockController
     *      em testnet pública/mainnet (ver invariante I4).
     * @param name_ Nome ERC-20 legível (ex.: "Web3Community Governance").
     * @param symbol_ Símbolo ERC-20 curto (ex.: "GOV").
     * @param initialOwner Owner inicial com poder de cunhar até atingir o cap.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(initialOwner) {
        CAP_SUPPLY = 100_000_000 * 10 ** 18;
    }

    /**
     * @notice Retorna o supply cap imutável do token.
     * @return Cap em unidades mínimas (1e18 precision).
     */
    function cap() external view returns (uint256) {
        return CAP_SUPPLY;
    }

    /**
     * @notice Cunha `amount` tokens para `to`, desde que o cap não seja excedido.
     * @dev Apenas o owner atual pode chamar. Em produção o owner é o TimelockController,
     *      de modo que cada mint passa por proposta + votação + timelock. O parâmetro
     *      `tag` é só registro off-chain (via evento) e não afeta contabilidade on-chain.
     *      Reverte com {ZeroAddress} se `to == address(0)`, {ZeroAmount} se `amount == 0`
     *      e {CapExceeded} se a soma do supply ultrapassar {CAP_SUPPLY}.
     * @param to Destinatário dos tokens.
     * @param amount Quantidade a cunhar (em unidades mínimas).
     * @param tag Rótulo descritivo do bucket/propósito (apenas evento, opcional).
     */
    function mint(address to, uint256 amount, string calldata tag) external onlyOwner {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        _mint(to, amount);
        emit Minted(to, amount, tag);
    }

    /**
     * @notice Retorna o nonce atual de `ownerAddr` usado em {permit} e {delegateBySig}.
     * @param ownerAddr Endereço a consultar.
     * @return Nonce corrente.
     */
    function nonces(address ownerAddr) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(ownerAddr);
    }

    // ------------------------------------------------------------------
    // Internal overrides exigidos pela combinação ERC20 + ERC20Votes.
    // ------------------------------------------------------------------

    /**
     * @dev Hook unificado de transferências/mints/burns do ERC-20. Delega para
     *      {ERC20Votes._update}, que move voting units e aplica a proteção
     *      {ERC20ExceededSafeSupply} (limite uint208). Antes de chamar super,
     *      aplicamos o cap específico do projeto para falhar com erro mais
     *      descritivo ({CapExceeded}) em mints acima do limite.
     */
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from == address(0)) {
            uint256 attempted = totalSupply() + value;
            if (attempted > CAP_SUPPLY) {
                revert CapExceeded(attempted, CAP_SUPPLY);
            }
        }
        super._update(from, to, value);
    }

    /**
     * @dev Restringe o supply máximo reconhecido pelo ERC20Votes ao cap do projeto,
     *      garantindo que qualquer caminho interno que consulte `_maxSupply` respeite
     *      a invariante I1. Em resolução de conflitos de override, o mínimo prevalece.
     */
    function _maxSupply() internal view override returns (uint256) {
        return CAP_SUPPLY;
    }
}
