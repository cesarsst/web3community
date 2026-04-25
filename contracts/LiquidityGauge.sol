// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IUniswapV3Staker} from "./interfaces/IUniswapV3Staker.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";

/**
 * @title LiquidityGauge
 * @notice Adapter sobre o `UniswapV3Staker` canonico (Uniswap Foundation) que
 *         distribui o bucket de 25% da emissao de CREDIT para LPs do par
 *         CREDIT/USDC (e potencialmente outros pools whitelistados pela
 *         governanca). Implementa Fase 1.3 do pivot Credit Liquidity Protocol.
 *
 *         Fluxo do usuario:
 *           1. Usuario tem um NFT V3 (posicao concentrada num pool whitelistado).
 *           2. Usuario chama {stake} passando `tokenId` + `poolId`.
 *           3. NFT vai para o staker, comeca a acumular rewards in-range.
 *           4. Quando quiser sair, chama {unstake} — NFT volta, rewards entram
 *              em vesting linear de `vestingDuration` (default 14d).
 *           5. {harvest} saca CREDIT ja vestido. Vesting nao-vestido em caso
 *              de saida total e mantido na posicao ate completar.
 *           6. {emergencyUnstake} (sempre permitido, mesmo pausado) devolve o
 *              NFT mas DESCARTA rewards pendentes — fail-safe.
 *
 * @dev Decisoes congeladas em `audit/economist/2026-04-24-clp-pivot.md` Anexo D:
 *      - D.1 Whitelist governance-tunable, seed CREDIT/USDC 0.3%.
 *      - D.2 UniswapV3Staker oficial como base; gauge e adapter (sem
 *            reinventar custodia de NFT).
 *      - D.3 Reward proporcional a `liquidity in-range` (padrao staker oficial,
 *            secondsInsideX128).
 *      - D.4 Vesting linear 14d. {harvest} parcial. Saida antes do fim do
 *            vesting NAO penaliza positions ja criadas (vesting acumula
 *            independente — voce continua vestindo apos retirar o NFT).
 *      - D.5 Emissao continuous via {notifyRewardAmount} — cada chamada cria
 *            uma incentive nova no staker.
 *      - D.6 Sem boost cap explicito.
 *      - D.7 Role `REWARD_NOTIFIER` plural (Treasury manual + futuro
 *            RewardDistributor automatico).
 *      - D.8 {pause}/{unpause} bloqueia novo {stake}; {unstake}/{harvest}
 *            seguem operacionais. {emergencyUnstake} e fail-safe sempre.
 *      - D.9 Denylist anti self-dealing — Treasury (POL) nao pode stakear.
 *
 *      Decisoes adicionais nao cobertas pelo Anexo D:
 *      - Vesting position acumula apos {unstake}: o usuario nao precisa manter
 *        o NFT staked para continuar vestindo. Razao: rewards ja foram
 *        "ganhos" no staker oficial; segura-los na posicao postergaria
 *        valor sem proposito economico. Esta decisao tambem facilita
 *        compactacao das positions (positions terminadas saem do array).
 *      - {emergencyUnstake} descarta rewards do CICLO ATUAL (saldo em
 *        {IUniswapV3Staker.rewards} para `address(this)` no momento da saida)
 *        E NAO mexe em {VestingPosition}s previas — vesting in-flight nao
 *        sofre. Razao: vesting ja existente pertence ao usuario; o que se
 *        descarta e o reward que ainda nao virou vesting.
 *      - Funcao auxiliar {governanceRescueRewards} permite governance
 *        recuperar rewards orfaos no staker apos {emergencyUnstake} ou
 *        encerramento de incentive vencida via {endIncentiveAndRescue}.
 *
 *      Invariantes do projeto reafirmadas:
 *      - IE6 (liquidez DEX): gauge fortalece IE6 ao incentivar liquidez
 *        incremental alem do POL.
 *      - IE10 (nao pausar usuario): {pause} bloqueia ENTRADA, nao SAIDA.
 *
 *      Padroes de implementacao:
 *      - `AccessControl` com 2 roles: `GOVERNANCE_ROLE` (whitelist, denylist,
 *        pause, vesting params) e `REWARD_NOTIFIER_ROLE` (notify rewards).
 *      - `ReentrancyGuard` em toda funcao state-changing que toca tokens/NFTs.
 *      - `SafeERC20` em transfers de CREDIT (rewardToken).
 *      - CEI estrito em todas as funcoes de saida (effects antes de calls
 *        externas para o staker / NPM / token).
 *      - Custom errors em todas as falhas, sem `require(..., string)`.
 *      - `IERC721Receiver.onERC721Received` aceita NFT do user E do staker
 *        (este ultimo e disparado em {IUniswapV3Staker.withdrawToken}).
 *
 * @custom:security-contact security@web3community.example
 */
contract LiquidityGauge is AccessControl, ReentrancyGuard, Pausable, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Configuracao por pool whitelistado.
    /// @param pool Endereco do `IUniswapV3Pool` (CREDIT/USDC 0.3% no seed).
    /// @param enabled `false` desativa novos stakes mas mantem unstakes
    ///                operacionais (D.1 — pool removida da whitelist drena
    ///                ate todos os stakers sairem).
    /// @param currentIncentiveHash Hash `keccak256(abi.encode(key))` da
    ///                  incentive ativa. `bytes32(0)` significa "sem incentive
    ///                  ativa" — `stake()` reverte; usuarios podem
    ///                  unstake / harvest normalmente em incentives antigas.
    struct PoolConfig {
        address pool;
        bool enabled;
        bytes32 currentIncentiveHash;
    }

    /// @notice Estado de um stake gerenciado pelo gauge.
    /// @param owner Usuario que depositou o NFT (real owner).
    /// @param poolId Pool whitelistada onde o NFT esta staked.
    /// @param incentiveHash Hash da incentive (no momento do stake) — preserva
    ///                      ligacao mesmo se a pool sofrer rollover de
    ///                      incentive.
    /// @param stakedAt Timestamp UNIX (seg) do {stake}.
    struct Stake {
        address owner;
        uint256 poolId;
        bytes32 incentiveHash;
        uint64 stakedAt;
    }

    /// @notice Stream de vesting linear de rewards de CREDIT pertencente a um
    ///         usuario.
    /// @param totalAmount Quantidade total de CREDIT a vestar.
    /// @param claimedAmount Quantidade ja sacada via {harvest}.
    /// @param startedAt Timestamp UNIX (seg) em que o vesting comecou.
    /// @param endsAt Timestamp UNIX (seg) em que o vesting completa
    ///               (`startedAt + vestingDuration` no momento da criacao).
    struct VestingPosition {
        uint256 totalAmount;
        uint256 claimedAmount;
        uint64 startedAt;
        uint64 endsAt;
    }

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Role com poder de governance — whitelist/denylist, pause,
    ///         vesting params, rescue de rewards orfaos. Concedida ao
    ///         `TimelockController` em producao (IE governance).
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    /// @notice Role autorizada a notificar emissao de rewards. Concedida ao
    ///         {Treasury} (caminho manual via Timelock) e/ou ao
    ///         {RewardDistributor} (caminho automatico, Fase 1.4).
    ///         Plural (D.7).
    bytes32 public constant REWARD_NOTIFIER_ROLE = keccak256("REWARD_NOTIFIER_ROLE");

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Vesting minimo aceito em {setVestingDuration} (1 dia).
    // solhint-disable-next-line const-name-snakecase
    uint32 public constant VESTING_DURATION_MIN = 1 days;

    /// @notice Vesting maximo aceito em {setVestingDuration} (90 dias).
    // solhint-disable-next-line const-name-snakecase
    uint32 public constant VESTING_DURATION_MAX = 90 days;

    /// @notice Duracao minima de uma incentive criada via
    ///         {notifyRewardAmount} (1 hora). Valor abaixo disso e
    ///         incompativel com o staker oficial (rewards/segundo overflow
    ///         em valores pequenos) e atende a alinhamento dev/prod
    ///         (1h em ambiente dev, 7d em prod).
    // solhint-disable-next-line const-name-snakecase
    uint32 public constant INCENTIVE_DURATION_MIN = 1 hours;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    /// @notice Token distribuido como reward (CREDIT).
    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable CREDIT_TOKEN;

    /// @notice Staker canonico Uniswap V3.
    // solhint-disable-next-line var-name-mixedcase
    IUniswapV3Staker public immutable UNISWAP_V3_STAKER;

    /// @notice NPM canonico Uniswap V3 (NFT manager das posicoes LP). Usado
    ///         como `IERC721` — o gauge nao consome `mint`/`positions`/etc.,
    ///         apenas `safeTransferFrom`. Em mainnet aponta para
    ///         `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`.
    // solhint-disable-next-line var-name-mixedcase
    IERC721 public immutable POSITION_MANAGER;

    // ------------------------------------------------------------------
    // Storage — vesting params
    // ------------------------------------------------------------------

    /// @notice Duracao do vesting linear aplicado a rewards (seg). Default
    ///         14 dias (D.4). Mutavel via {setVestingDuration} dentro de
    ///         `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]`.
    uint32 public vestingDuration = 14 days;

    // ------------------------------------------------------------------
    // Storage — pool whitelist
    // ------------------------------------------------------------------

    /// @notice Numero de pools whitelistadas. `poolId` e atribuido a partir
    ///         de `1` para que `0` signifique "nao whitelistada" no
    ///         {poolIdByAddress}.
    uint256 public poolCount;

    /// @notice Configuracao por `poolId`.
    mapping(uint256 poolId => PoolConfig config) public pools;

    /// @notice Lookup reverso de `pool address` -> `poolId`. `0` significa
    ///         nao whitelistada.
    mapping(address pool => uint256 poolId) public poolIdByAddress;

    /// @notice Reconstrucao de IncentiveKey a partir do hash. Necessario para
    ///         passar `key` em `stakeToken`/`unstakeToken`/`endIncentive` apos
    ///         rollover de incentive.
    mapping(bytes32 incentiveHash => IUniswapV3Staker.IncentiveKey key) private _incentivesByHash;

    // ------------------------------------------------------------------
    // Storage — stakes
    // ------------------------------------------------------------------

    /// @notice Estado por NFT staked (`tokenId` -> `Stake`). `owner == address(0)`
    ///         significa "nao gerenciado".
    mapping(uint256 tokenId => Stake stake) public stakes;

    // ------------------------------------------------------------------
    // Storage — vesting positions
    // ------------------------------------------------------------------

    /// @notice Posicoes de vesting por usuario. Pode haver multiplas
    ///         (acumulacao em cada {unstake}).
    mapping(address user => VestingPosition[] positions) private _vestings;

    // ------------------------------------------------------------------
    // Storage — denylist (D.9)
    // ------------------------------------------------------------------

    /// @notice Endereco -> denied. Treasury e demais contratos do protocolo
    ///         devem entrar aqui via {setDenylist} pelo bootstrap (D.9).
    mapping(address account => bool denied) public denylisted;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido quando uma pool e adicionada a whitelist.
    /// @param poolId Identificador interno (`1`-based).
    /// @param pool Endereco do `IUniswapV3Pool`.
    event PoolAdded(uint256 indexed poolId, address indexed pool);

    /// @notice Emitido quando uma pool e habilitada/desabilitada.
    /// @param poolId Identificador interno.
    /// @param enabled Novo estado.
    event PoolEnabledSet(uint256 indexed poolId, bool enabled);

    /// @notice Emitido quando uma incentive nova e criada via
    ///         {notifyRewardAmount}.
    /// @param poolId Pool alvo.
    /// @param incentiveHash Hash `keccak256(abi.encode(key))`.
    /// @param amount Reward total (CREDIT) cuja distribuicao foi delegada
    ///               ao staker.
    /// @param startTime Inicio de vesting da incentive no staker.
    /// @param endTime Fim de vesting da incentive no staker.
    event RewardNotified(
        uint256 indexed poolId,
        bytes32 indexed incentiveHash,
        uint256 amount,
        uint256 startTime,
        uint256 endTime
    );

    /// @notice Emitido quando governance encerra incentive expirada e resgata
    ///         o refund.
    /// @param poolId Pool alvo.
    /// @param incentiveHash Hash da incentive encerrada.
    /// @param refund Quantidade de CREDIT devolvida pelo staker.
    event IncentiveEnded(uint256 indexed poolId, bytes32 indexed incentiveHash, uint256 refund);

    /// @notice Emitido em {stake}.
    /// @param user Real owner do NFT (msg.sender).
    /// @param tokenId NFT id.
    /// @param poolId Pool de destino.
    /// @param incentiveHash Incentive em que o NFT foi staked.
    event Staked(address indexed user, uint256 indexed tokenId, uint256 indexed poolId, bytes32 incentiveHash);

    /// @notice Emitido em {unstake}.
    /// @param user Real owner.
    /// @param tokenId NFT id.
    /// @param rewardAmount Reward bruto (antes de vesting) movido para
    ///                     {VestingPosition} do usuario.
    event Unstaked(address indexed user, uint256 indexed tokenId, uint256 rewardAmount);

    /// @notice Emitido em {emergencyUnstake} (rewards descartados).
    /// @param user Real owner.
    /// @param tokenId NFT id.
    /// @param forfeitedRewards Quantidade de CREDIT que ficou no staker.
    event EmergencyUnstaked(address indexed user, uint256 indexed tokenId, uint256 forfeitedRewards);

    /// @notice Emitido em {harvest}.
    /// @param user Beneficiario.
    /// @param amount Quantidade efetivamente transferida.
    event Harvested(address indexed user, uint256 amount);

    /// @notice Emitido em {setVestingDuration}.
    /// @param oldDuration Valor anterior em segundos.
    /// @param newDuration Novo valor em segundos.
    event VestingDurationSet(uint32 oldDuration, uint32 newDuration);

    /// @notice Emitido em {setDenylist}.
    /// @param account Endereco afetado.
    /// @param denied Novo estado.
    event DenylistSet(address indexed account, bool denied);

    /// @notice Emitido em {governanceRescueRewards}.
    /// @param to Destinatario (geralmente o Treasury).
    /// @param amount Quantidade resgatada.
    event RewardsRescued(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Valor zero nao permitido.
    error ZeroAmount();

    /// @notice Pool nao whitelistada (poolId invalido) ou pool ja registrada.
    /// @param poolId poolId fornecido (0 se duplicacao).
    error InvalidPool(uint256 poolId);

    /// @notice Pool desabilitada para novos stakes.
    /// @param poolId poolId.
    error PoolDisabled(uint256 poolId);

    /// @notice Pool sem incentive ativa — {stake} reverte (nada a vestar).
    /// @param poolId poolId.
    error NoActiveIncentive(uint256 poolId);

    /// @notice Endereco esta na denylist (D.9). Aplicavel a {stake}.
    /// @param account Endereco bloqueado.
    error Denylisted(address account);

    /// @notice tokenId nao gerenciado por este gauge.
    /// @param tokenId NFT id.
    error StakeNotFound(uint256 tokenId);

    /// @notice Caller nao e o owner registrado do stake.
    /// @param tokenId NFT id.
    /// @param expected Owner real.
    /// @param actual Caller.
    error NotStakeOwner(uint256 tokenId, address expected, address actual);

    /// @notice Vesting duration fora dos limites permitidos.
    /// @param requested Valor pedido.
    error InvalidVestingDuration(uint32 requested);

    /// @notice Solicitacao de resgate excede saldo disponivel.
    /// @param requested Quantia pedida.
    /// @param available Saldo do gauge.
    error InsufficientBalance(uint256 requested, uint256 available);

    /// @notice Incentive duration fora dos limites permitidos.
    /// @param requested Duracao pedida (seg).
    error InvalidIncentiveDuration(uint32 requested);

    /// @notice Incentive ainda nao expirou — `endIncentive` reverteria no staker.
    /// @param incentiveHash Hash da incentive.
    /// @param endsAt Timestamp UNIX em que expira.
    error IncentiveNotExpired(bytes32 incentiveHash, uint256 endsAt);

    /// @notice Pool ja possui incentive ativa nao expirada — abrir nova
    ///         exigiria coexistencia de duas (nao suportado neste adapter
    ///         simplificado). Governance deve {endIncentive} antes.
    /// @param poolId poolId.
    /// @param currentIncentiveHash Incentive atual.
    error IncentiveOverlap(uint256 poolId, bytes32 currentIncentiveHash);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Constroi o gauge.
     * @param admin Recebe `DEFAULT_ADMIN_ROLE` E `GOVERNANCE_ROLE`. Em
     *              producao deve ser o `TimelockController`. Em dev pode ser
     *              EOA, com transferencia subsequente para o Timelock.
     * @param creditToken Endereco do CREDIT (rewardToken).
     * @param uniswapV3Staker Endereco do staker canonico (mainnet
     *                        `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`,
     *                        ou mock em testes).
     * @param positionManager Endereco do NPM canonico Uniswap V3.
     */
    constructor(address admin, address creditToken, address uniswapV3Staker, address positionManager) {
        if (admin == address(0)) revert ZeroAddress();
        if (creditToken == address(0)) revert ZeroAddress();
        if (uniswapV3Staker == address(0)) revert ZeroAddress();
        if (positionManager == address(0)) revert ZeroAddress();

        CREDIT_TOKEN = IERC20(creditToken);
        UNISWAP_V3_STAKER = IUniswapV3Staker(uniswapV3Staker);
        POSITION_MANAGER = IERC721(positionManager);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // External — governance (pool whitelist, denylist, vesting params)
    // ------------------------------------------------------------------

    /**
     * @notice Adiciona um pool a whitelist. Pool comeca `enabled = true` mas
     *         SEM incentive ativa (precisa de {notifyRewardAmount} antes do
     *         primeiro stake).
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Reverte se a pool ja esta whitelistada.
     * @param pool Endereco do `IUniswapV3Pool`.
     * @return poolId Identificador atribuido (`1`-based).
     */
    function addPool(address pool) external onlyRole(GOVERNANCE_ROLE) returns (uint256 poolId) {
        if (pool == address(0)) revert ZeroAddress();
        if (poolIdByAddress[pool] != 0) revert InvalidPool(0);

        poolCount += 1;
        poolId = poolCount;
        pools[poolId] = PoolConfig({pool: pool, enabled: true, currentIncentiveHash: bytes32(0)});
        poolIdByAddress[pool] = poolId;

        emit PoolAdded(poolId, pool);
    }

    /**
     * @notice Habilita/desabilita uma pool whitelistada.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. NAO afeta stakes existentes — eles
     *      continuam vestindo na incentive em que foram staked, e podem
     *      unstake normalmente. Apenas {stake} novo na pool e bloqueado.
     * @param poolId Pool alvo.
     * @param enabled Novo estado.
     */
    function setPoolEnabled(uint256 poolId, bool enabled) external onlyRole(GOVERNANCE_ROLE) {
        PoolConfig storage cfg = pools[poolId];
        if (cfg.pool == address(0)) revert InvalidPool(poolId);
        cfg.enabled = enabled;
        emit PoolEnabledSet(poolId, enabled);
    }

    /**
     * @notice Atualiza a duracao do vesting linear aplicado a novos
     *         {VestingPosition}s.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Bounds em
     *      `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]`. NAO retroativo —
     *      positions ja criadas mantem o `endsAt` original.
     * @param newDuration Nova duracao em segundos.
     */
    function setVestingDuration(uint32 newDuration) external onlyRole(GOVERNANCE_ROLE) {
        if (newDuration < VESTING_DURATION_MIN || newDuration > VESTING_DURATION_MAX) {
            revert InvalidVestingDuration(newDuration);
        }
        uint32 old = vestingDuration;
        vestingDuration = newDuration;
        emit VestingDurationSet(old, newDuration);
    }

    /**
     * @notice Marca/desmarca um endereco como denylisted (D.9). Denylisted
     *         nao podem chamar {stake}.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Bootstrap deve denylistar Treasury e
     *      demais contratos do protocolo (Staking, RewardDistributor,
     *      FeeRouter, BondDepository quando existir).
     * @param account Endereco.
     * @param denied Novo estado.
     */
    function setDenylist(address account, bool denied) external onlyRole(GOVERNANCE_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        denylisted[account] = denied;
        emit DenylistSet(account, denied);
    }

    /**
     * @notice Pausa entrada de novos stakes. {unstake}/{harvest} continuam
     *         operacionais; {emergencyUnstake} sempre operacional.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. IE10-friendly (nao bloqueia saida).
     */
    function pause() external onlyRole(GOVERNANCE_ROLE) {
        _pause();
    }

    /**
     * @notice Despausa.
     * @dev `onlyRole(GOVERNANCE_ROLE)`.
     */
    function unpause() external onlyRole(GOVERNANCE_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------
    // External — reward notification (REWARD_NOTIFIER_ROLE)
    // ------------------------------------------------------------------

    /**
     * @notice Cria nova incentive no staker canonico para uma pool
     *         whitelistada. Caller transfere `amount` CREDIT para este
     *         contrato (via allowance previo) e este contrato repassa para o
     *         staker. A incentive comeca AGORA (`block.timestamp`) e termina
     *         em `block.timestamp + duration`.
     * @dev Reverte se a pool atual ja tem incentive ativa nao expirada
     *      (precisa {endIncentive} antes — modelo simplificado de 1 incentive
     *      por pool por vez). Roles: `REWARD_NOTIFIER_ROLE`. Pre-condicoes:
     *      caller ja aprovou `amount` para este contrato.
     * @param poolId Pool alvo.
     * @param amount Quantidade total de CREDIT a distribuir.
     * @param duration Duracao da incentive (seg). Min `INCENTIVE_DURATION_MIN`.
     * @return incentiveHash Hash da incentive criada.
     */
    function notifyRewardAmount(
        uint256 poolId,
        uint256 amount,
        uint32 duration
    ) external onlyRole(REWARD_NOTIFIER_ROLE) nonReentrant returns (bytes32 incentiveHash) {
        if (amount == 0) revert ZeroAmount();
        if (duration < INCENTIVE_DURATION_MIN) revert InvalidIncentiveDuration(duration);

        PoolConfig storage cfg = pools[poolId];
        if (cfg.pool == address(0)) revert InvalidPool(poolId);

        // Bloqueia overlap — o gauge so referencia uma incentive ativa por pool.
        bytes32 currentHash = cfg.currentIncentiveHash;
        if (currentHash != bytes32(0)) {
            uint256 endTimePrev = _incentivesByHash[currentHash].endTime;
            if (endTimePrev > block.timestamp) {
                revert IncentiveOverlap(poolId, currentHash);
            }
            // Incentive previa expirada: governance pode encerrar via
            // {endIncentive} para resgatar refund. Aqui apenas substituimos.
        }

        uint256 startTime = block.timestamp;
        uint256 endTime = block.timestamp + duration;

        IUniswapV3Staker.IncentiveKey memory key = IUniswapV3Staker.IncentiveKey({
            rewardToken: CREDIT_TOKEN,
            pool: IUniswapV3Pool(cfg.pool),
            startTime: startTime,
            endTime: endTime,
            refundee: address(this)
        });

        incentiveHash = keccak256(abi.encode(key));

        // Effects ANTES do call externo: registra a incentive E faz pull do
        // CREDIT do notifier.
        _incentivesByHash[incentiveHash] = key;
        cfg.currentIncentiveHash = incentiveHash;

        CREDIT_TOKEN.safeTransferFrom(msg.sender, address(this), amount);

        // Approve + createIncentive. O staker faz pull do CREDIT da gauge.
        // forceApprove zera approve previo antes de setar (compat com tokens
        // nao-ERC20-strict; CREDIT e estrito, mas o pattern e seguro).
        CREDIT_TOKEN.forceApprove(address(UNISWAP_V3_STAKER), amount);
        UNISWAP_V3_STAKER.createIncentive(key, amount);

        emit RewardNotified(poolId, incentiveHash, amount, startTime, endTime);
    }

    /**
     * @notice Encerra a incentive ATUAL da pool (precisa estar expirada) e
     *         resgata o refund de volta para o gauge — onde fica disponivel
     *         para {governanceRescueRewards} ou para nova {notifyRewardAmount}.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Limpa `currentIncentiveHash` da pool.
     * @param poolId Pool alvo.
     * @return refund Quantidade devolvida pelo staker.
     */
    function endIncentive(uint256 poolId) external onlyRole(GOVERNANCE_ROLE) nonReentrant returns (uint256 refund) {
        PoolConfig storage cfg = pools[poolId];
        if (cfg.pool == address(0)) revert InvalidPool(poolId);

        bytes32 incentiveHash = cfg.currentIncentiveHash;
        if (incentiveHash == bytes32(0)) revert NoActiveIncentive(poolId);

        IUniswapV3Staker.IncentiveKey memory key = _incentivesByHash[incentiveHash];
        if (key.endTime > block.timestamp) {
            revert IncentiveNotExpired(incentiveHash, key.endTime);
        }

        // Effects antes do call.
        cfg.currentIncentiveHash = bytes32(0);

        refund = UNISWAP_V3_STAKER.endIncentive(key);
        emit IncentiveEnded(poolId, incentiveHash, refund);
    }

    /**
     * @notice Resgata CREDIT orfaos no gauge (refunds de incentives encerradas
     *         OU rewards forfeit em {emergencyUnstake} ja claimados). Para o
     *         destinatario indicado.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Use com criterio — em producao
     *      destinatario deve ser o Treasury.
     * @param to Destinatario.
     * @param amount Quantidade. Se `amount == type(uint256).max`, transfere
     *               todo o saldo de CREDIT do gauge.
     */
    function governanceRescueRewards(address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 balance = CREDIT_TOKEN.balanceOf(address(this));
        uint256 transferAmount = amount == type(uint256).max ? balance : amount;
        if (transferAmount == 0) revert ZeroAmount();
        if (transferAmount > balance) revert InsufficientBalance(transferAmount, balance);
        CREDIT_TOKEN.safeTransfer(to, transferAmount);
        emit RewardsRescued(to, transferAmount);
    }

    // ------------------------------------------------------------------
    // External — user (stake / unstake / harvest)
    // ------------------------------------------------------------------

    /**
     * @notice Deposita o NFT no gauge e auto-stakeia na incentive ativa da
     *         pool indicada. NFT precisa estar `approve`-d para este contrato
     *         OU enviado via `safeTransferFrom` direto (nesse caso
     *         {onERC721Received} ignora — fluxo e gauge-pull, nao push).
     * @dev `nonReentrant` + `whenNotPaused`. Reverte se sender denylisted
     *      (D.9). Reverte se pool desabilitada ou sem incentive ativa.
     * @param tokenId NFT id (Uniswap V3 NPM).
     * @param poolId Pool whitelistada onde o NFT corresponde.
     */
    function stake(uint256 tokenId, uint256 poolId) external nonReentrant whenNotPaused {
        if (denylisted[msg.sender]) revert Denylisted(msg.sender);

        PoolConfig storage cfg = pools[poolId];
        if (cfg.pool == address(0)) revert InvalidPool(poolId);
        if (!cfg.enabled) revert PoolDisabled(poolId);

        bytes32 incentiveHash = cfg.currentIncentiveHash;
        if (incentiveHash == bytes32(0)) revert NoActiveIncentive(poolId);

        IUniswapV3Staker.IncentiveKey memory key = _incentivesByHash[incentiveHash];

        // Effects antes do interaction.
        stakes[tokenId] = Stake({
            owner: msg.sender,
            poolId: poolId,
            incentiveHash: incentiveHash,
            stakedAt: uint64(block.timestamp)
        });

        // Pull do NFT do user para o gauge (precisa de approve previo).
        POSITION_MANAGER.safeTransferFrom(msg.sender, address(this), tokenId);

        // Repasse para o staker COM data — staker faz auto-stake na incentive.
        // O staker oficial implementa onERC721Received que decodifica a
        // IncentiveKey e chama _stakeToken internamente.
        POSITION_MANAGER.safeTransferFrom(address(this), address(UNISWAP_V3_STAKER), tokenId, abi.encode(key));

        emit Staked(msg.sender, tokenId, poolId, incentiveHash);
    }

    /**
     * @notice Desfaz o stake do NFT no staker, recolhe rewards acumulados,
     *         devolve o NFT ao owner e cria uma {VestingPosition} com vesting
     *         linear. Se nao havia rewards (in-range time = 0), apenas devolve
     *         o NFT.
     * @dev `nonReentrant`. NAO `whenNotPaused` — usuario sempre pode sair
     *      (IE10).
     * @param tokenId NFT id.
     */
    function unstake(uint256 tokenId) external nonReentrant {
        Stake memory s = stakes[tokenId];
        if (s.owner == address(0)) revert StakeNotFound(tokenId);
        if (s.owner != msg.sender) revert NotStakeOwner(tokenId, s.owner, msg.sender);

        IUniswapV3Staker.IncentiveKey memory key = _incentivesByHash[s.incentiveHash];

        // Effects: limpa estado do stake antes das interactions.
        delete stakes[tokenId];

        // Unstake na incentive. O staker canonico processa o tempo in-range
        // do tokenId e credita rewards em `rewards[creditToken][address(this)]`.
        // (Caso `endIncentive` ja tenha sido executado, o staker reverte —
        // protegido pelo proprio staker que nao permite endIncentive enquanto
        // ha NFTs staked).
        UNISWAP_V3_STAKER.unstakeToken(key, tokenId);

        // Saca TODO o saldo disponivel para o gauge. Em fluxo serial (1 unstake
        // por vez), `earned` corresponde ao ganho deste `tokenId`; em fluxo
        // concorrente, ganhos se misturam, mas o protocolo distribui ao
        // primeiro a unstake (FIFO) — comportamento aceito (Anexo D D.3 e
        // padrao staker oficial).
        uint256 earned = UNISWAP_V3_STAKER.claimReward(CREDIT_TOKEN, address(this), 0);

        if (earned > 0) {
            _createVestingPosition(s.owner, earned);
        }

        // Devolve o NFT ao owner. O staker exige que o caller seja o
        // depositor original (= o gauge, que enviou via safeTransferFrom no
        // stake).
        UNISWAP_V3_STAKER.withdrawToken(tokenId, s.owner, "");

        emit Unstaked(s.owner, tokenId, earned);
    }

    /**
     * @notice Saida emergencial — devolve NFT ao owner. Rewards pendentes no
     *         staker (do ciclo atual) sao DESCARTADOS — viram saldo do gauge
     *         disponivel para {governanceRescueRewards}. Vesting in-flight
     *         (positions previas) nao e afetado.
     * @dev `nonReentrant`. Funciona MESMO PAUSADO (fail-safe IE10).
     * @param tokenId NFT id.
     */
    function emergencyUnstake(uint256 tokenId) external nonReentrant {
        Stake memory s = stakes[tokenId];
        if (s.owner == address(0)) revert StakeNotFound(tokenId);
        if (s.owner != msg.sender) revert NotStakeOwner(tokenId, s.owner, msg.sender);

        IUniswapV3Staker.IncentiveKey memory key = _incentivesByHash[s.incentiveHash];

        delete stakes[tokenId];

        // Tenta unstake. Se falhar (incentive em estado invalido, edge case),
        // ainda tentamos devolver o NFT.
        // solhint-disable-next-line no-empty-blocks
        try UNISWAP_V3_STAKER.unstakeToken(key, tokenId) {} catch {
            // ignored — fail-safe path, queremos garantir que o NFT volte.
        }

        // Tenta claim total. Forfeited = quantia que vai parar no saldo do
        // gauge mas NAO entra em VestingPosition do user (descartada do ponto
        // de vista do user — fica para governance resgatar).
        uint256 forfeited = 0;
        // solhint-disable-next-line no-empty-blocks
        try UNISWAP_V3_STAKER.claimReward(CREDIT_TOKEN, address(this), 0) returns (uint256 claimed) {
            forfeited = claimed;
        } catch {
            // ignored — se claim falhar, rewards continuam no staker.
        }

        UNISWAP_V3_STAKER.withdrawToken(tokenId, s.owner, "");

        emit EmergencyUnstaked(s.owner, tokenId, forfeited);
    }

    /**
     * @notice Saca CREDIT ja vestido nas {VestingPosition}s do `user`.
     *         Compacta positions totalmente claimadas (anti-bloat).
     * @dev `nonReentrant`. Caller pode harvestar para outrem (sem prejuizo
     *      ao owner — apenas inicia transferencia).
     * @param user Beneficiario.
     * @param maxAmount Limite superior (use `type(uint256).max` para tudo).
     * @return claimed Quantidade efetivamente transferida.
     */
    function harvest(address user, uint256 maxAmount) external nonReentrant returns (uint256 claimed) {
        if (user == address(0)) revert ZeroAddress();

        VestingPosition[] storage positions = _vestings[user];
        uint256 len = positions.length;
        if (len == 0) {
            return 0;
        }

        uint256 remaining = maxAmount;

        // Iteracao com compactacao em-loco (swap-and-pop). Indice manual `i`
        // porque positions removidas sao substituidas por positions[len-1].
        uint256 i = 0;
        while (i < len) {
            VestingPosition storage vp = positions[i];
            uint256 vestedNow = _vestedOfPosition(vp, block.timestamp);
            uint256 unclaimed = vestedNow - vp.claimedAmount;

            if (unclaimed > 0 && remaining > 0) {
                uint256 take = unclaimed > remaining ? remaining : unclaimed;
                vp.claimedAmount += take;
                claimed += take;
                remaining -= take;
            }

            // Se a position completou (vesting terminou e tudo claimado), remove.
            bool exhausted = vp.claimedAmount >= vp.totalAmount && block.timestamp >= vp.endsAt;
            if (exhausted) {
                positions[i] = positions[len - 1];
                positions.pop();
                len -= 1;
                // NAO incrementa i — checa o que foi swappado.
            } else {
                i += 1;
            }

            if (remaining == 0) {
                // Continua iterando apenas para compactar positions exauridas
                // que ja estavam na frente, mas sem saquear mais. Para evitar
                // loop O(n) quando o user passou maxAmount baixo, paramos.
                break;
            }
        }

        if (claimed > 0) {
            CREDIT_TOKEN.safeTransfer(user, claimed);
        }

        emit Harvested(user, claimed);
    }

    // ------------------------------------------------------------------
    // External — views
    // ------------------------------------------------------------------

    /**
     * @notice Soma de vested e claimable atual nas positions do `user`.
     * @param user Beneficiario.
     * @return vested Soma de `vestedOfPosition` em todas as positions
     *                (inclui ja claimado).
     * @return claimable Soma de `vested - claimed` (saldo ainda sacavel).
     */
    function vestedAmount(address user) external view returns (uint256 vested, uint256 claimable) {
        VestingPosition[] storage positions = _vestings[user];
        uint256 len = positions.length;
        for (uint256 i = 0; i < len; i++) {
            VestingPosition storage vp = positions[i];
            uint256 v = _vestedOfPosition(vp, block.timestamp);
            vested += v;
            claimable += (v - vp.claimedAmount);
        }
    }

    /**
     * @notice Numero de {VestingPosition}s do `user`.
     * @param user Beneficiario.
     * @return count Tamanho do array.
     */
    function vestingCountOf(address user) external view returns (uint256 count) {
        return _vestings[user].length;
    }

    /**
     * @notice Detalhe de uma {VestingPosition} especifica.
     * @param user Beneficiario.
     * @param index Indice no array (0..vestingCountOf-1).
     * @return position Copia da position.
     */
    function vestingAt(address user, uint256 index) external view returns (VestingPosition memory position) {
        return _vestings[user][index];
    }

    /**
     * @notice Reconstroi a IncentiveKey associada a um hash. Util para
     *         off-chain compor calls direto ao staker (ex.: dashboards).
     * @param incentiveHash Hash.
     * @return key A struct IncentiveKey.
     */
    function incentiveByHash(bytes32 incentiveHash) external view returns (IUniswapV3Staker.IncentiveKey memory key) {
        return _incentivesByHash[incentiveHash];
    }

    /**
     * @notice Rewards atualmente acumulados no staker para `(CREDIT, address(this))`.
     *         Util para diagnostico e off-chain dashboards. NAO equivale a
     *         "rewards do tokenId" individualmente — o staker contabiliza
     *         em batch para o owner do deposit.
     * @return rewardsBalance Saldo atual.
     */
    function pendingRewardsAtStaker() external view returns (uint256 rewardsBalance) {
        return UNISWAP_V3_STAKER.rewards(CREDIT_TOKEN, address(this));
    }

    // ------------------------------------------------------------------
    // IERC721Receiver
    // ------------------------------------------------------------------

    /**
     * @notice Aceita NFTs ERC-721 enviados a este contrato. Usado em 2 contextos:
     *         (1) gauge faz pull do NFT em {stake} via `safeTransferFrom`;
     *         (2) staker devolve NFT em {withdrawToken} no fluxo {unstake}/
     *             {emergencyUnstake}.
     * @dev Sempre retorna o selector — NAO inspeciona `data`. O fluxo de stake
     *      e gauge-driven (gauge faz pull e repassa para o staker), entao a
     *      logica esta nas funcoes externas, nao no callback.
     * @return selector Selector ERC721Receiver canonico.
     */
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /// @dev Calcula vested cumulativo (incluindo ja claimado) de uma position
    ///      em `nowTs`. Linear: 0 antes de `startedAt`, total apos `endsAt`,
    ///      proporcional ao meio.
    function _vestedOfPosition(VestingPosition storage vp, uint256 nowTs) internal view returns (uint256 vested) {
        if (nowTs <= vp.startedAt) return 0;
        if (nowTs >= vp.endsAt) return vp.totalAmount;
        uint256 elapsed = nowTs - vp.startedAt;
        uint256 duration = vp.endsAt - vp.startedAt;
        // Math: totalAmount * elapsed / duration. Sem perda economica no
        // ordering (totalAmount cabe em uint256 trivialmente; elapsed e
        // duration sao seg).
        return (vp.totalAmount * elapsed) / duration;
    }

    /// @dev Cria uma nova {VestingPosition} com `vestingDuration` corrente.
    ///      `amount > 0` ja garantido pelos callers.
    function _createVestingPosition(address user, uint256 amount) internal {
        uint64 startedAt = uint64(block.timestamp);
        uint64 endsAt = startedAt + vestingDuration;
        _vestings[user].push(
            VestingPosition({totalAmount: amount, claimedAmount: 0, startedAt: startedAt, endsAt: endsAt})
        );
    }
}
