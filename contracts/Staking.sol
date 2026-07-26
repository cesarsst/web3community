// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ProjectRegistry} from "./ProjectRegistry.sol";

/**
 * @title Staking
 * @notice Cofre de stake direcionado por projeto. O usuario lockeia GOV em um
 *         `projectId` do {ProjectRegistry} e recebe `weight` proporcional ao
 *         amount e a duracao do lock. No modelo vigente (remodel 2026-07-08) o
 *         stake e sinal de curadoria e PRE-REQUISITO para investir e sacar
 *         rev-share no {ProjectFunding} (`getWeight(user, projectId) > 0`).
 *         Nao ha emissao/rewards atrelados ao peso.
 * @dev Decisoes economicas fixadas (confirmadas com o user):
 *      - Lock minimo 14 dias, maximo 365 dias (multiplier satura em 4x acima).
 *      - Curva linear 1x (14d) -> 4x (365d). Valores fora do range: < 14d
 *        revertem com {LockTooShort}; > 365d NAO revertem (multiplier = 4x
 *        e o tempo real de lock e preservado).
 *      - Stake so e aceito em projetos `Active`. Probation/Removed bloqueiam
 *        stake novo, mas NUNCA bloqueiam unstake (usuario nao fica preso por
 *        decisao de governanca).
 *      - Projeto em `Removed` libera o stake imediatamente (bypass do lock):
 *        a DAO removeu o projeto, nao o staker; seria punitivo manter o lock.
 *      - Consolidacao em {stake} segue Opcao B: se ja existe posicao, o novo
 *        amount soma ao existente, o lockDuration passa a ser
 *        `max(remaining, newLockDuration)` e `lockStartAt` reseta para
 *        `block.timestamp`. Reset do start e intencional: sem ele, o usuario
 *        poderia alongar o peso indefinidamente fazendo micro-stakes sem
 *        re-commitar o amount antigo. Com o reset, qualquer acrescimo de
 *        amount re-inicia o compromisso temporal sobre TODA a posicao.
 *
 *      Invariantes atendidas nesta unidade:
 *      - I5 (anti-flashloan): expomos {getWeightAt} e {getTotalWeightAt} via
 *        `Checkpoints.Trace208` para snapshots historicos imunes a
 *        flash-stake. Consumidores que ponderem por peso historico devem
 *        consultar por um blockNumber ancorado no passado, nunca pelo valor
 *        corrente.
 *      - I6 (lock minimo 14d) — {LockTooShort} revert em {stake} e
 *        {extendLock}; {unstake} reverte com {LockNotExpired} enquanto o lock
 *        esta vigente (excecao de {unstake} documentada para status Removed).
 *      - Compat com {ProjectRegistry}: le `isActive` para gating de stake e
 *        le `getProject(projectId).status == Removed` para bypass de lock em
 *        unstake. Nenhuma role nova e necessaria — Staking nao e privilegiado
 *        na governanca.
 *
 *      Escolhas de implementacao:
 *      - `Checkpoints.Trace208` (chave uint48=block.number, valor uint208).
 *        Peso maximo teorico por (user, projeto): 100M * 1e18 * 4 = 4e26,
 *        cabe trivialmente em uint208 (~4.11e62). Chave cabe em uint48 por
 *        ~8920 anos em 1s block time. Documentado em {_pushCheckpoint}.
 *      - `ReentrancyGuard` em todas as 5 funcoes state-changing que tocam
 *        GOV. Mesmo sendo GOV um ERC20Votes conhecido sem callbacks, o guard
 *        e barato (~2k gas) e blinda contra regressao futura.
 *      - `SafeERC20` em todas as transferencias.
 *      - CEI estrito: effects antes de safeTransfer/safeTransferFrom.
 *      - Custom errors para todas as falhas. Eventos com `indexed` em
 *        `user` e `projectId` para indexacao off-chain.
 * @custom:security-contact security@web3community.example
 */
contract Staking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Posicao de stake unica por par (user, projectId).
    /// @param amount GOV atualmente lockado nesta posicao (wei). `0` significa
    ///               posicao inexistente/deletada.
    /// @param lockStartAt Timestamp (seg) em que o lock atual comecou. Reset
    ///                    em {stake} ao consolidar; preservado em
    ///                    {increaseStake} e {extendLock}.
    /// @param lockDuration Duracao absoluta do lock (seg) a partir de
    ///                     `lockStartAt`. Pode exceder `MAX_LOCK` (o
    ///                     multiplier saturam; o tempo real de lock e
    ///                     respeitado em {unstake}).
    struct StakePosition {
        uint256 amount;
        uint64 lockStartAt;
        uint64 lockDuration;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Duracao minima do lock (14 dias). Stake/extend abaixo revertem.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MIN_LOCK = 14 days;

    /// @notice Duracao apos a qual o multiplier satura em `MAX_MULTIPLIER`.
    ///         Locks acima ainda sao aceitos — apenas nao incrementam peso.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MAX_LOCK = 365 days;

    /// @notice Precisao fixa do multiplier. `1e18` = 1.0x.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MULTIPLIER_PRECISION = 1e18;

    /// @notice Multiplier maximo (4x) atingido em `MAX_LOCK`.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MAX_MULTIPLIER = 4e18;

    // ------------------------------------------------------------------
    // Immutable / storage
    // ------------------------------------------------------------------

    /// @notice Token de governanca (GOV) travado como colateral de stake.
    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable GOV_TOKEN;

    /// @notice Registry consultado para validar status de projeto (Active para
    ///         stake novo; Removed para bypass de lock em unstake).
    // solhint-disable-next-line var-name-mixedcase
    ProjectRegistry public immutable REGISTRY;

    /// @notice Posicao de stake por (user, projectId). `amount == 0` indica
    ///         posicao inexistente.
    mapping(address user => mapping(uint256 projectId => StakePosition)) public positions;

    /// @notice Soma agregada de `amount` por projeto.
    mapping(uint256 projectId => uint256) public totalStakedByProject;

    /// @notice Total global de GOV lockado (soma entre todos os projetos).
    uint256 public totalStaked;

    /// @dev Historico de peso total por projeto (chave = block.number).
    mapping(uint256 projectId => Checkpoints.Trace208) private _projectWeight;

    /// @dev Historico de peso por (user, projectId) (chave = block.number).
    mapping(address user => mapping(uint256 projectId => Checkpoints.Trace208)) private _userWeight;

    /// @dev Historico de peso global (soma de todos os projetos) (chave = block.number).
    ///      Exposto via {getTotalWeightAt} para consumidores que precisem da
    ///      fracao de um projeto no peso total (projectWeight / globalWeight)
    ///      sem iterar projetos on-chain.
    Checkpoints.Trace208 private _globalWeightCheckpoints;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido ao abrir ou consolidar uma posicao via {stake}.
    /// @param user Staker.
    /// @param projectId Projeto destino.
    /// @param amount Quantidade adicionada nesta chamada (nao o total da posicao).
    /// @param lockDuration Nova `lockDuration` aplicada (resultado da
    ///                     consolidacao max(remaining, newLockDuration)).
    /// @param lockStartAt Timestamp (seg) do (re)start do lock.
    /// @param weight Peso total da posicao apos a consolidacao.
    event Staked(
        address indexed user,
        uint256 indexed projectId,
        uint256 amount,
        uint64 lockDuration,
        uint64 lockStartAt,
        uint256 weight
    );

    /// @notice Emitido em {increaseStake}.
    /// @param user Staker.
    /// @param projectId Projeto.
    /// @param amountAdded Quantidade adicionada.
    /// @param newAmount Amount total da posicao apos o acrescimo.
    /// @param newWeight Peso total apos o acrescimo (lockDuration inalterado).
    event StakeIncreased(
        address indexed user,
        uint256 indexed projectId,
        uint256 amountAdded,
        uint256 newAmount,
        uint256 newWeight
    );

    /// @notice Emitido em {extendLock}.
    /// @param user Staker.
    /// @param projectId Projeto.
    /// @param newLockDuration Nova `lockDuration` (sempre > anterior).
    /// @param newWeight Peso total recalculado.
    event LockExtended(address indexed user, uint256 indexed projectId, uint64 newLockDuration, uint256 newWeight);

    /// @notice Emitido em {unstake} e {unstakeAll}.
    /// @param user Staker.
    /// @param projectId Projeto.
    /// @param amount Quantidade removida.
    /// @param remaining Amount restante da posicao apos a remocao (0 = posicao deletada).
    /// @param newWeight Peso restante (0 se a posicao foi deletada).
    event Unstaked(
        address indexed user,
        uint256 indexed projectId,
        uint256 amount,
        uint256 remaining,
        uint256 newWeight
    );

    /// @notice Emitido quando o unstake acontece com lock ainda vigente porque
    ///         o projeto esta `Removed`. Complemento de {Unstaked} para
    ///         rastreabilidade off-chain de bypass de lock.
    /// @param user Staker.
    /// @param projectId Projeto (em status Removed no momento da chamada).
    /// @param amount Quantidade removida sob bypass.
    event EarlyUnstakeAllowed(address indexed user, uint256 indexed projectId, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido como construtor/registry/token.
    error ZeroAddress();

    /// @notice Valor zero nao e permitido em operacoes que exigem amount > 0.
    error ZeroAmount();

    /// @notice Projeto nao esta em status `Active` — stake novo bloqueado.
    /// @param projectId ID do projeto.
    error ProjectNotActive(uint256 projectId);

    /// @notice `lockDuration` abaixo de {MIN_LOCK}.
    /// @param provided Duracao passada.
    /// @param minimum {MIN_LOCK}.
    error LockTooShort(uint64 provided, uint256 minimum);

    /// @notice Lock ainda nao expirou e o projeto nao esta `Removed`.
    /// @param unlockAt Timestamp em que o lock expira.
    /// @param nowTs Timestamp atual.
    error LockNotExpired(uint64 unlockAt, uint256 nowTs);

    /// @notice Tentativa de encurtar o lock via {extendLock}.
    /// @param current `lockDuration` atual.
    /// @param provided `lockDuration` solicitado.
    error CannotShortenLock(uint64 current, uint64 provided);

    /// @notice Posicao inexistente para o par (user, projectId) solicitado.
    error PositionNotFound(address user, uint256 projectId);

    /// @notice Tentativa de remover mais do que a posicao contem.
    /// @param requested Quantidade solicitada.
    /// @param available Amount atual da posicao.
    error InsufficientStake(uint256 requested, uint256 available);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o cofre de staking apontando para o token GOV e o registry.
     * @dev Nenhuma role e concedida — o contrato nao tem superficie
     *      privilegiada. Toda funcao state-changing e gated por logica de
     *      negocio (ownership da posicao, status do projeto, expiracao do
     *      lock) e nao por `AccessControl`.
     *      Revertido se qualquer endereco e zero.
     * @param govToken_ Endereco do `GovernanceToken` (GOV).
     * @param registry_ Endereco do `ProjectRegistry`.
     */
    constructor(address govToken_, address registry_) {
        if (govToken_ == address(0) || registry_ == address(0)) {
            revert ZeroAddress();
        }
        GOV_TOKEN = IERC20(govToken_);
        REGISTRY = ProjectRegistry(registry_);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Retorna a posicao completa para o par (user, projectId).
     * @dev Retorna struct zerada se nao ha posicao — chamadores que queiram
     *      distinguir "existe vs nao existe" devem checar `amount > 0`.
     * @param user Staker.
     * @param projectId Projeto.
     * @return Posicao completa (pode ser zerada).
     */
    function getPosition(address user, uint256 projectId) external view returns (StakePosition memory) {
        return positions[user][projectId];
    }

    /**
     * @notice Peso atual do (user, projectId). Zero se posicao nao existe.
     * @param user Staker.
     * @param projectId Projeto.
     * @return weight Peso corrente (amount * multiplier(lockDuration)).
     */
    function getWeight(address user, uint256 projectId) external view returns (uint256) {
        StakePosition storage p = positions[user][projectId];
        if (p.amount == 0) {
            return 0;
        }
        return _weight(p.amount, p.lockDuration);
    }

    /**
     * @notice Peso total agregado no projeto.
     * @param projectId Projeto.
     * @return Soma dos pesos de todas as posicoes vivas no projeto.
     */
    function getTotalWeight(uint256 projectId) external view returns (uint256) {
        return _projectWeight[projectId].latest();
    }

    /**
     * @notice Peso historico do (user, projectId) no bloco `blockNumber`.
     * @dev Consulta `Checkpoints.Trace208.upperLookupRecent` — retorna o peso
     *      vigente no ultimo checkpoint com chave <= `blockNumber`. Usado para
     *      snapshots historicos imunes a flash-stake.
     *      IMPORTANTE: so e confiavel para `blockNumber < block.number`; para
     *      o bloco corrente, o checkpoint pode ainda estar sendo escrito.
     * @param user Staker.
     * @param projectId Projeto.
     * @param blockNumber Bloco de referencia.
     * @return Peso no bloco consultado.
     */
    function getWeightAt(address user, uint256 projectId, uint256 blockNumber) external view returns (uint256) {
        return _userWeight[user][projectId].upperLookupRecent(_toUint48(blockNumber));
    }

    /**
     * @notice Peso total agregado historico do projeto em `blockNumber`.
     * @dev Mesmas premissas de {getWeightAt}.
     * @param projectId Projeto.
     * @param blockNumber Bloco de referencia.
     * @return Peso total no bloco consultado.
     */
    function getTotalWeightAt(uint256 projectId, uint256 blockNumber) external view returns (uint256) {
        return _projectWeight[projectId].upperLookupRecent(_toUint48(blockNumber));
    }

    /**
     * @notice Peso global agregado corrente — soma de {getTotalWeight} para
     *         todos os projetos.
     * @dev Util para computar o share de um projeto no peso global (sem
     *      anterior) para computar o share de cada projeto sem iterar
     *      on-chain: `share_projeto = getTotalWeightAt(projectId, b) /
     *      getGlobalWeightAt(b)`. O agregado e atualizado em O(1) em cada
     *      {_writeCheckpoints} e usa o mesmo `Checkpoints.Trace208` dos outros
     *      trilhos de peso (mesmas invariantes de overflow).
     * @return Peso global atual.
     */
    function getGlobalWeight() external view returns (uint256) {
        return _globalWeightCheckpoints.latest();
    }

    /**
     * @notice Peso global historico em `blockNumber`.
     * @dev Mesmas premissas de {getWeightAt}: confiavel para
     *      `blockNumber < block.number`. No bloco corrente o checkpoint pode
     *      ainda estar sendo escrito.
     * @param blockNumber Bloco de referencia.
     * @return Peso global no bloco consultado.
     */
    function getGlobalWeightAt(uint256 blockNumber) external view returns (uint256) {
        return _globalWeightCheckpoints.upperLookupRecent(_toUint48(blockNumber));
    }

    /**
     * @notice Timestamp em que o lock do (user, projectId) expira.
     * @dev Retorna 0 se a posicao nao existe.
     * @param user Staker.
     * @param projectId Projeto.
     * @return Timestamp (seg) de expiracao.
     */
    function getLockEnd(address user, uint256 projectId) external view returns (uint64) {
        StakePosition storage p = positions[user][projectId];
        if (p.amount == 0) {
            return 0;
        }
        return p.lockStartAt + p.lockDuration;
    }

    /**
     * @notice `true` se o lock ja expirou (ou nao ha posicao).
     * @dev NAO considera status `Removed` do projeto — bypass de lock em
     *      Removed e aplicado dentro de {unstake}. Este view e estritamente
     *      sobre a expiracao temporal.
     * @param user Staker.
     * @param projectId Projeto.
     * @return `true` se `block.timestamp >= lockStartAt + lockDuration`
     *         ou se a posicao nao existe; `false` caso contrario.
     */
    function isUnlocked(address user, uint256 projectId) external view returns (bool) {
        StakePosition storage p = positions[user][projectId];
        if (p.amount == 0) {
            return true;
        }
        return block.timestamp >= uint256(p.lockStartAt) + uint256(p.lockDuration);
    }

    /**
     * @notice Multiplier linear em [1e18, 4e18] para `lockDuration`.
     * @dev Reverte com {LockTooShort} se `lockDuration < MIN_LOCK`.
     *      Satura em `MAX_MULTIPLIER` para `lockDuration >= MAX_LOCK`.
     *      Em [MIN_LOCK, MAX_LOCK]:
     *        multiplier = 1e18 + (d - MIN_LOCK) * (4e18 - 1e18) / (MAX_LOCK - MIN_LOCK)
     *      Pure para permitir testes numericos e uso pela UI sem estado.
     * @param lockDuration Duracao do lock (seg).
     * @return Multiplier em precisao 1e18.
     */
    function multiplier(uint64 lockDuration) external pure returns (uint256) {
        return _multiplier(lockDuration);
    }

    // ------------------------------------------------------------------
    // Core — state-changing
    // ------------------------------------------------------------------

    /**
     * @notice Abre ou consolida uma posicao de stake no `projectId`.
     * @dev Semantica de consolidacao (Opcao B):
     *        - Se nao ha posicao: grava {amount, lockDuration, lockStartAt=now}.
     *        - Se ha posicao: newAmount = old.amount + amount;
     *                        newLockDuration = max(remainingOld, lockDuration);
     *                        lockStartAt = now (reset intencional — ver
     *                        NatSpec contract-level).
     *      Reverts:
     *        - {ZeroAmount} se `amount == 0`.
     *        - {LockTooShort} se `lockDuration < MIN_LOCK`.
     *        - {ProjectNotActive} se projeto nao esta `Active` (inclui
     *          inexistente, `Pending`, `Probation` punitiva e `Removed`).
     *      Locks acima de {MAX_LOCK} sao aceitos literalmente: o multiplier
     *      satura em 4x, mas o tempo real e respeitado na hora do unstake.
     *      CEI: effects antes do `safeTransferFrom`. `nonReentrant` aplicado.
     *      Emite {Staked}.
     * @param projectId Projeto destino (deve estar Active no Registry).
     * @param amount Quantidade de GOV a lockar (> 0).
     * @param lockDuration Duracao (seg) do lock (>= {MIN_LOCK}).
     */
    function stake(uint256 projectId, uint256 amount, uint64 lockDuration) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (lockDuration < MIN_LOCK) {
            revert LockTooShort(lockDuration, MIN_LOCK);
        }
        if (!REGISTRY.isActive(projectId)) {
            revert ProjectNotActive(projectId);
        }

        StakePosition storage p = positions[msg.sender][projectId];

        uint64 nowTs = uint64(block.timestamp);
        uint256 newAmount = p.amount + amount;
        uint64 newLockDuration = lockDuration;
        if (p.amount != 0) {
            // Consolidacao: max(remainingOld, lockDuration). `remainingOld` e
            // calculado relativo a `p.lockStartAt + p.lockDuration - now`,
            // saturado em 0 se o lock ja expirou.
            uint64 unlockAt = p.lockStartAt + p.lockDuration;
            uint64 remaining = unlockAt > nowTs ? unlockAt - nowTs : 0;
            if (remaining > newLockDuration) {
                newLockDuration = remaining;
            }
        }

        p.amount = newAmount;
        p.lockDuration = newLockDuration;
        p.lockStartAt = nowTs;

        totalStakedByProject[projectId] += amount;
        totalStaked += amount;

        uint256 newWeight = _weight(newAmount, newLockDuration);
        _writeCheckpoints(msg.sender, projectId, newWeight);

        emit Staked(msg.sender, projectId, amount, newLockDuration, nowTs, newWeight);

        GOV_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Aumenta `amount` de uma posicao existente PRESERVANDO
     *         `lockStartAt` e `lockDuration`.
     * @dev Peso aumenta proporcionalmente ao amount (mesmo multiplier).
     *      **NAO reabre lock expirado** — se a posicao ja esta unlocked,
     *      `increaseStake` nao altera o tempo; o staker pode imediatamente
     *      chamar `unstake` sobre o novo total. Para re-committar
     *      temporalmente, use {stake} (consolidacao Opcao B com reset de
     *      `lockStartAt`).
     *      Reverts:
     *        - {ZeroAmount} se `amount == 0`.
     *        - {PositionNotFound} se nao ha posicao para `msg.sender` em
     *          `projectId`.
     *        - {ProjectNotActive} se projeto nao esta `Active` (staker
     *          deve aguardar reativacao ou migrar via {stake} em outro
     *          projeto Active).
     *      CEI: effects antes do `safeTransferFrom`. `nonReentrant` aplicado.
     *      Emite {StakeIncreased}.
     * @param projectId Projeto.
     * @param amount Quantidade a adicionar (> 0).
     */
    function increaseStake(uint256 projectId, uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        StakePosition storage p = positions[msg.sender][projectId];
        if (p.amount == 0) {
            revert PositionNotFound(msg.sender, projectId);
        }
        if (!REGISTRY.isActive(projectId)) {
            revert ProjectNotActive(projectId);
        }

        uint256 newAmount = p.amount + amount;
        p.amount = newAmount;

        totalStakedByProject[projectId] += amount;
        totalStaked += amount;

        uint256 newWeight = _weight(newAmount, p.lockDuration);
        _writeCheckpoints(msg.sender, projectId, newWeight);

        emit StakeIncreased(msg.sender, projectId, amount, newAmount, newWeight);

        GOV_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Estende a `lockDuration` de uma posicao existente. Nunca
     *         encurta. NAO altera `lockStartAt`.
     * @dev Mesmo o lock ja tendo expirado, `extendLock` funciona: re-ativa
     *      o lock com a nova duracao medida a partir do `lockStartAt`
     *      original (ou seja, `newUnlockAt = lockStartAt + newLockDuration`).
     *      Reverts:
     *        - {PositionNotFound} se nao ha posicao.
     *        - {CannotShortenLock} se `newLockDuration <= lockDuration`
     *          atual (inclusive igual — nao ha valor em re-escrever o mesmo).
     *      {LockTooShort} nao pode ocorrer aqui: a duracao atual ja e
     *      >= MIN_LOCK por invariante de {stake}, e so aceitamos valores
     *      estritamente maiores.
     *      CEI + nonReentrant. Nao move tokens — o guard e defensivo contra
     *      regressoes futuras que introduzam call externo.
     *      Emite {LockExtended}.
     * @param projectId Projeto.
     * @param newLockDuration Nova duracao absoluta desde `lockStartAt` (seg).
     *                        Deve ser > `lockDuration` atual.
     */
    function extendLock(uint256 projectId, uint64 newLockDuration) external nonReentrant {
        StakePosition storage p = positions[msg.sender][projectId];
        if (p.amount == 0) {
            revert PositionNotFound(msg.sender, projectId);
        }
        if (newLockDuration <= p.lockDuration) {
            revert CannotShortenLock(p.lockDuration, newLockDuration);
        }

        p.lockDuration = newLockDuration;
        uint256 newWeight = _weight(p.amount, newLockDuration);
        _writeCheckpoints(msg.sender, projectId, newWeight);

        emit LockExtended(msg.sender, projectId, newLockDuration, newWeight);
    }

    /**
     * @notice Remove `amount` de GOV de uma posicao. Se `amount` iguala o
     *         saldo da posicao, a posicao e deletada (storage zerado).
     * @dev Requisitos:
     *        - `amount > 0` e posicao existente.
     *        - `amount <= position.amount`.
     *        - Lock expirado OU projeto em status `Removed` (bypass).
     *      Probation (punitiva ou inicial por tempo) NAO bypassa o lock —
     *      apenas remocao terminal bypassa.
     *      Reverts:
     *        - {ZeroAmount} se `amount == 0`.
     *        - {PositionNotFound} se nao ha posicao.
     *        - {InsufficientStake} se `amount > position.amount`.
     *        - {LockNotExpired} se lock vigente E projeto nao e `Removed`.
     *      Se projeto esta `Removed`, emite {EarlyUnstakeAllowed} alem de
     *      {Unstaked}. CEI: storage zerado antes do `safeTransfer`.
     *      `nonReentrant` aplicado.
     *      Emite {Unstaked} (sempre) e {EarlyUnstakeAllowed} (se bypass).
     * @param projectId Projeto.
     * @param amount Quantidade a remover (> 0, <= position.amount).
     */
    function unstake(uint256 projectId, uint256 amount) external nonReentrant {
        _unstake(projectId, amount);
    }

    /**
     * @notice Atalho: remove o saldo total da posicao.
     * @dev Semanticamente identico a {unstake} chamado com
     *      `amount = positions[msg.sender][projectId].amount`.
     *      Reverts:
     *        - {PositionNotFound} se nao ha posicao.
     *        - {LockNotExpired} se lock vigente E projeto nao e `Removed`
     *          (via `_unstake`).
     *      Emite {Unstaked} e (se bypass) {EarlyUnstakeAllowed}.
     * @param projectId Projeto.
     */
    function unstakeAll(uint256 projectId) external nonReentrant {
        StakePosition storage p = positions[msg.sender][projectId];
        if (p.amount == 0) {
            revert PositionNotFound(msg.sender, projectId);
        }
        _unstake(projectId, p.amount);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /**
     * @dev Corpo compartilhado de {unstake}/{unstakeAll}. Nao usa `nonReentrant`
     *      por si — o guard e aplicado nas funcoes externas.
     */
    function _unstake(uint256 projectId, uint256 amount) private {
        if (amount == 0) {
            revert ZeroAmount();
        }
        StakePosition storage p = positions[msg.sender][projectId];
        if (p.amount == 0) {
            revert PositionNotFound(msg.sender, projectId);
        }
        if (amount > p.amount) {
            revert InsufficientStake(amount, p.amount);
        }

        bool projectRemoved = _isProjectRemoved(projectId);
        if (!projectRemoved) {
            uint64 unlockAt = p.lockStartAt + p.lockDuration;
            if (block.timestamp < unlockAt) {
                revert LockNotExpired(unlockAt, block.timestamp);
            }
        }

        uint256 remaining = p.amount - amount;
        uint256 newWeight;
        if (remaining == 0) {
            delete positions[msg.sender][projectId];
            newWeight = 0;
        } else {
            p.amount = remaining;
            newWeight = _weight(remaining, p.lockDuration);
        }

        totalStakedByProject[projectId] -= amount;
        totalStaked -= amount;
        _writeCheckpoints(msg.sender, projectId, newWeight);

        if (projectRemoved) {
            emit EarlyUnstakeAllowed(msg.sender, projectId, amount);
        }
        emit Unstaked(msg.sender, projectId, amount, remaining, newWeight);

        GOV_TOKEN.safeTransfer(msg.sender, amount);
    }

    /**
     * @dev Le o Registry e retorna `true` se o projeto esta em status
     *      `Removed`. Abstraido em helper para permitir teste isolado do
     *      caminho de bypass.
     */
    function _isProjectRemoved(uint256 projectId) private view returns (bool) {
        ProjectRegistry.Project memory proj = REGISTRY.getProject(projectId);
        return proj.status == ProjectRegistry.Status.Removed;
    }

    /**
     * @dev Calcula peso = amount * multiplier(duration) / MULTIPLIER_PRECISION.
     *      Sem overflow em uint256: amount <= GOV cap (100M * 1e18 = 1e26),
     *      multiplier <= 4e18, produto <= 4e44 — muito abaixo de 2^256.
     */
    function _weight(uint256 amount, uint64 duration) private pure returns (uint256) {
        return (amount * _multiplier(duration)) / MULTIPLIER_PRECISION;
    }

    /**
     * @dev Multiplier com saturacao em {MAX_MULTIPLIER} para `duration >=
     *      MAX_LOCK`, revert para `duration < MIN_LOCK`, e interpolacao
     *      linear em [MIN_LOCK, MAX_LOCK). A ordem
     *      `delta * (MAX_MULTIPLIER - MULTIPLIER_PRECISION)` antes da divisao
     *      preserva precisao e nao overflow (ambos em uint64/uint256 seguros:
     *      delta <= ~3.1e7 seg, fator <= 3e18, produto <= ~1e26).
     */
    function _multiplier(uint64 duration) private pure returns (uint256) {
        if (duration < MIN_LOCK) {
            revert LockTooShort(duration, MIN_LOCK);
        }
        if (duration >= MAX_LOCK) {
            return MAX_MULTIPLIER;
        }
        uint256 delta = uint256(duration) - MIN_LOCK;
        uint256 slope = MAX_MULTIPLIER - MULTIPLIER_PRECISION;
        return MULTIPLIER_PRECISION + (delta * slope) / (MAX_LOCK - MIN_LOCK);
    }

    /**
     * @dev Escreve checkpoint (user, projeto e global) com o peso corrente.
     *      Chave = `block.number` (uint48), valor = peso (uint208).
     *      O agregado por projeto e recomputado como
     *      `oldProjectWeight - oldUserWeight + newUserWeight` — isso evita
     *      iterar sobre N stakers. O global usa o mesmo diff
     *      (`newUserWeight - oldUserWeight`) aplicado sobre o total global,
     *      preservando a invariante `globalWeight == SUM(projectWeight)` em
     *      O(1) por escrita.
     *      O diff e derivado dos valores correntes ANTES deste push; apos
     *      o push, os 3 trilhos ficam consistentes.
     *      `upperLookupRecent` / `latest` retornam o valor atual antes do
     *      novo push por essa razao (chamamos antes de `push`).
     */
    function _writeCheckpoints(address user, uint256 projectId, uint256 newUserWeight) private {
        Checkpoints.Trace208 storage userT = _userWeight[user][projectId];
        Checkpoints.Trace208 storage projT = _projectWeight[projectId];

        uint256 oldUserWeight = userT.latest();
        uint256 oldProjectWeight = projT.latest();
        uint256 oldGlobalWeight = _globalWeightCheckpoints.latest();
        // Reconstruir total: subtrai peso anterior do user (0 se nao tinha),
        // soma novo peso do user. Nao pode underflow: oldProjectWeight >=
        // oldUserWeight por invariante (projeto agrega todos os usuarios);
        // oldGlobalWeight >= oldUserWeight por invariante (global agrega
        // todos os projetos, que por sua vez agregam todos os usuarios).
        uint256 newProjectWeight = oldProjectWeight - oldUserWeight + newUserWeight;
        uint256 newGlobalWeight = oldGlobalWeight - oldUserWeight + newUserWeight;

        uint48 key = _toUint48(block.number);
        userT.push(key, _toUint208(newUserWeight));
        projT.push(key, _toUint208(newProjectWeight));
        _globalWeightCheckpoints.push(key, _toUint208(newGlobalWeight));
    }

    /// @dev SafeCast local — usa a lib OZ pra revert explicito em overflow.
    function _toUint48(uint256 v) private pure returns (uint48) {
        return SafeCast.toUint48(v);
    }

    /// @dev SafeCast local — mesma logica, mas para o valor de peso.
    function _toUint208(uint256 v) private pure returns (uint208) {
        return SafeCast.toUint208(v);
    }
}
