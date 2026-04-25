// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CreditToken} from "./CreditToken.sol";
import {BurnTracker} from "./BurnTracker.sol";
import {ProjectRegistry} from "./ProjectRegistry.sol";
import {Staking} from "./Staking.sol";
import {ILiquidityGaugeRewards} from "./interfaces/ILiquidityGaugeRewards.sol";
import {ITreasuryRewards} from "./interfaces/ITreasuryRewards.sol";

/**
 * @title RewardDistributorV2
 * @notice Distributor bucket-aware da Fase 1.4 do pivot Credit Liquidity
 *         Protocol. Reescreve a logica de emissao para suportar split
 *         entre 4 buckets em cada `finalizeRound`:
 *           - **Stakers** (default 55%): pull-based via {claim}/{claimMany},
 *             mantem mecanica V1 (`projectShare × stakeShare`).
 *           - **LPs** (default 25%): push direto para `LiquidityGauge`
 *             via `notifyRewardAmount`. Quando gauge paused, fallback
 *             para `Treasury.depositPendingGaugeRewards`.
 *           - **Apps** (default 15%): push retrospectivo (burn-based) —
 *             `appShare(p) = appsAmount × burn_{R-1}(p) / totalBurnPrev`,
 *             mintado direto para `ProjectRegistry.ownerRecipient(p)`.
 *           - **Bonders** (default 5%): push para
 *             `Treasury.depositPolRefill` (refill earmarkado do POL na
 *             Fase 1, sera reciclado para `BondDepository` na Fase 3).
 *
 *         O contrato e **deploy paralelo** ao V1 — V1 fica em modo
 *         claim-only durante a janela de migracao de 4 rounds (governance
 *         revoga `MINTER_ROLE` no CREDIT do V1 apos cutoff). V2 NAO mexe
 *         em storage de `Staking`, `BurnTracker` ou `ProjectRegistry`
 *         (additive only no Registry — vide `proposeOwnerRecipient`).
 *
 * @dev Spec congelado em `audit/economist/2026-04-24-clp-pivot.md` Anexo E.
 *      Decisoes-chave (E.1-E.8):
 *        - E.1 Mecanica: `bucketBps[4]` tunable via governance, com bounds
 *          + soma == 10000.
 *        - E.2 Apps: retrospectivo (burn-based), nao prospectivo (gauge
 *          weights ainda nao existem na Fase 1).
 *        - E.3 Stakers: direcionado por projeto (status quo da granularidade
 *          do V1) — preserva o vinculo `staker -> projeto` que a Fase 2
 *          usara como sinal para gauge weights.
 *        - E.4 LPs: push direto via `notifyRewardAmount`. Push trustless,
 *          sem janela politica.
 *        - E.5 Bonders: refill POL via earmark Treasury (auto-mode user
 *          aprovou).
 *        - E.6 Migracao: window de 4 rounds (V1 = claim-only).
 *        - E.7 Re-deploy isolado — `Staking` nao precisa setter.
 *        - E.8 Invariantes: IE3 (cap antes do split), IE4b (apps <= 25%),
 *          IE12 (soma buckets == totalEmission, lossless).
 *
 *      Invariantes economicas reafirmadas:
 *       - **IE1** alpha < 1: MAX_ALPHA = 0.99e18 (nao toca alpha).
 *       - **IE2** Floor temporario: `floorSchedule[24]` replicado do V1.
 *       - **IE3 (fortalecida)** Cap aplicado *antes* do split — nenhum
 *         bucket excede `bucketBps[i] × capMax`.
 *       - **IE4b (codificada)** `bucketBps[apps] <= 2500` em
 *         {setBucketBps}. Anti auto-extracao via wash burn.
 *       - **IE12 (criada)** Soma dos 4 buckets == `totalEmission` com
 *         tolerancia de 3 wei (residuo na divisao inteira). Validada em
 *         {finalizeRound} via assert.
 *       - **I5** Snapshot anti-flashloan: `snapshotBlock` unico por round,
 *         todos os buckets usam o mesmo.
 *
 *      Storage layout: contrato NOVO, nao proxy. Pode reorganizar livremente
 *      (nao ha herdeiros). Convencao: imutaveis -> constantes -> bucket
 *      params -> round state.
 *
 *      Reentrancy: `nonReentrant` em todas as funcoes que cunham CREDIT ou
 *      transferem para terceiros (CEI estrito). CREDIT.mint nao tem
 *      callback, mas o `notifyRewardAmount` do gauge e `depositPolRefill`
 *      do Treasury sao chamadas externas — guard como defesa-em-profundidade.
 *      No bucket apps, mint direto para `ownerRecipient` (endereco arbitrario
 *      controlado pelo owner do projeto via timelock 48h no Registry — vide
 *      `proposeOwnerRecipient`/`applyOwnerRecipient`); CREDIT nao tem hook
 *      e o `nonReentrant` cobre regressao.
 *
 * @custom:security-contact security@web3community.example
 */
contract RewardDistributorV2 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Snapshot imutavel de uma rodada apos {finalizeRound}.
    /// @param totalEmission Emissao total computada (em CREDIT wei).
    /// @param totalBurnAtFinalize Burn total da rodada anterior (imutavel
    ///                            apos finalize).
    /// @param snapshotBlock `block.number` no momento do finalize.
    /// @param finalized `true` se a rodada ja passou pelo finalize.
    struct RoundData {
        uint256 totalEmission;
        uint256 totalBurnAtFinalize;
        uint64 snapshotBlock;
        bool finalized;
    }

    // ------------------------------------------------------------------
    // Constants — bucket layout
    // ------------------------------------------------------------------

    /// @notice Indice do bucket "stakers" no array `bucketBps`.
    uint16 public constant BUCKET_STAKERS = 0;

    /// @notice Indice do bucket "LPs" no array `bucketBps`.
    uint16 public constant BUCKET_LPS = 1;

    /// @notice Indice do bucket "apps" no array `bucketBps`.
    uint16 public constant BUCKET_APPS = 2;

    /// @notice Indice do bucket "bonders" no array `bucketBps`.
    uint16 public constant BUCKET_BONDERS = 3;

    /// @notice Denominador de basis points (10000 = 100.00%).
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Lower bound do bucket "stakers": 30%. Garante incentivo de
    ///         alinhamento staker -> projeto suficiente para alimentar
    ///         o sinal economico que a Fase 2 usara.
    uint16 public constant MIN_BUCKET_STAKERS_BPS = 3000;

    /// @notice Lower bound do bucket "LPs": 5%. IE6 exige liquidez
    ///         incentivada enquanto POL nao for massivo.
    uint16 public constant MIN_BUCKET_LPS_BPS = 500;

    /// @notice Upper bound do bucket "apps": 25% (IE4b). Anti auto-extracao
    ///         via wash burn — projeto malicioso nao pode capturar mais que
    ///         25% via burn artificial.
    uint16 public constant MAX_BUCKET_APPS_BPS = 2500;

    /// @notice Upper bound do bucket "bonders": 20%. Olympus mostrou que
    ///         emissao bonder > 20% destrava ponzi.
    uint16 public constant MAX_BUCKET_BONDERS_BPS = 2000;

    /// @notice Tolerancia em wei para a invariante IE12 (lossless split).
    ///         Divisoes inteiras dos 3 primeiros buckets podem perder ate
    ///         3 wei combinados; o residuo cai sempre no bucket bonders
    ///         por construcao, mas o assert tolera 3 wei como margem
    ///         numerica (cap de auditoria, nao econ).
    uint256 public constant SPLIT_TOLERANCE_WEI = 3;

    // ------------------------------------------------------------------
    // Constants — econ params (replicadas do V1)
    // ------------------------------------------------------------------

    /// @notice Role concedida ao `TimelockController` em producao.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    /// @notice Precisao FP de `alpha`.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant PRECISION = 1e18;

    /// @notice Limite inferior de `alpha`.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MIN_ALPHA = 5e17;

    /// @notice Limite superior de `alpha` (IE1: alpha < 1 perpetuo).
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MAX_ALPHA = 99e16;

    /// @notice Limite inferior de `capMax`.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MIN_CAPMAX = 1e18;

    /// @notice Limite superior de `capMax`.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MAX_CAPMAX = 100_000_000e18;

    /// @notice Tamanho do schedule de floor (genesis decay).
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant FLOOR_SCHEDULE_LENGTH = 24;

    /// @notice Denominador do penalty de probation (25%).
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant PROBATION_PENALTY_DENOM = 4;

    // ------------------------------------------------------------------
    // Immutable dependencies
    // ------------------------------------------------------------------

    /// @notice Token de credito cunhado como reward.
    // solhint-disable-next-line var-name-mixedcase
    CreditToken public immutable CREDIT;

    /// @notice Contrato de staking (peso + snapshots).
    // solhint-disable-next-line var-name-mixedcase
    Staking public immutable STAKING;

    /// @notice BurnTracker consultado para burn historico por projeto/rodada.
    // solhint-disable-next-line var-name-mixedcase
    BurnTracker public immutable BURN_TRACKER;

    /// @notice Registry consultado para status do projeto e ownerRecipient.
    // solhint-disable-next-line var-name-mixedcase
    ProjectRegistry public immutable REGISTRY;

    /// @notice LiquidityGauge para o bucket LPs.
    // solhint-disable-next-line var-name-mixedcase
    ILiquidityGaugeRewards public immutable GAUGE;

    /// @notice Treasury — destino dos buckets bonders e fallback gauge.
    // solhint-disable-next-line var-name-mixedcase
    ITreasuryRewards public immutable TREASURY;

    // ------------------------------------------------------------------
    // Storage — bucket params
    // ------------------------------------------------------------------

    /// @notice Split em bps (basis points) entre os 4 buckets.
    ///         Ordem: `[stakers, lps, apps, bonders]`. Default
    ///         `[5500, 2500, 1500, 500]`. Soma == 10000 enforced em
    ///         {setBucketBps}.
    uint16[4] public bucketBps;

    /// @notice PoolId no `LiquidityGauge` para o qual o bucket LPs e
    ///         empurrado. Default 1 (CREDIT/USDC 0.3% no seed da Fase 1.3).
    ///         Mutavel via {setGaugePoolId}.
    uint256 public gaugePoolId;

    /// @notice Duracao em segundos da incentive criada em
    ///         `notifyRewardAmount`. Default `roundDuration` do BurnTracker
    ///         (typically 7d em prod). Bounds [1h, 90d] no setter.
    uint32 public gaugeIncentiveDuration;

    // ------------------------------------------------------------------
    // Storage — emissao (replicada do V1)
    // ------------------------------------------------------------------

    /// @notice Alpha (FP 1e18). Default 0.95e18 no constructor.
    uint256 public alpha;

    /// @notice Cap maximo por rodada (em CREDIT wei).
    uint256 public capMax;

    /// @notice Schedule imutavel de floor por rodada.
    uint256[24] public floorSchedule;

    // ------------------------------------------------------------------
    // Storage — round state
    // ------------------------------------------------------------------

    /// @notice Ultima rodada finalizada.
    uint256 public lastFinalizedRound;

    /// @notice Flag one-shot que distingue "round 0 ja finalizado" de
    ///         "nenhum round finalizado ainda".
    bool public isFirstRoundFinalized;

    /// @notice Snapshot imutavel por rodada.
    mapping(uint256 round => RoundData) public roundData;

    /// @notice Audit trail por bucket. `bucketEmissionByRound[round][bucket]`
    ///         registra o valor decidido por `finalizeRound` para auditoria
    ///         off-chain. Bucket stakers e o unico consumido em runtime
    ///         (em {claim}); demais buckets sao registrados aqui apenas
    ///         como evidencia (push ja foi executado).
    mapping(uint256 round => mapping(uint16 bucket => uint256 amount)) public bucketEmissionByRound;

    /// @notice `true` se (user, round, projectId) ja executou {claim}
    ///         com `amount > 0`. Evita double-claim.
    mapping(uint256 round => mapping(uint256 projectId => mapping(address user => bool))) public claimed;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido em {finalizeRound} apos split aplicado.
    /// @param round Rodada finalizada.
    /// @param totalEmission Emissao total apos cap.
    /// @param stakersAmount Bucket stakers (lazy claim).
    /// @param lpsAmount Bucket LPs (push gauge ou fallback Treasury).
    /// @param appsAmount Bucket apps (push direto aos owners).
    /// @param bondersAmount Bucket bonders (push Treasury polRefill).
    event RoundFinalizedV2(
        uint256 indexed round,
        uint256 totalEmission,
        uint256 stakersAmount,
        uint256 lpsAmount,
        uint256 appsAmount,
        uint256 bondersAmount
    );

    /// @notice Emitido em cada mint de bucket (audit trail granular).
    ///         Para o bucket stakers, `recipient = address(0)` (lazy mint).
    /// @param round Rodada.
    /// @param bucket Indice do bucket (0..3).
    /// @param recipient Destino do mint (`address(0)` se lazy).
    /// @param amount Quantidade cunhada (ou agendada para lazy).
    event BucketEmissionMinted(uint256 indexed round, uint16 indexed bucket, address indexed recipient, uint256 amount);

    /// @notice Emitido em {finalizeRound} quando o gauge esta paused — bucket
    ///         LPs cai no fallback `Treasury.depositPendingGaugeRewards`.
    /// @param round Rodada.
    /// @param amount Valor desviado para o Treasury.
    event GaugePauseFallback(uint256 indexed round, uint256 amount);

    /// @notice Emitido em {claim} (igual ao V1).
    event Claimed(address indexed user, uint256 indexed round, uint256 indexed projectId, uint256 amount);

    /// @notice Emitido em {setBucketBps}.
    event BucketBpsUpdated(uint16[4] oldBps, uint16[4] newBps);

    /// @notice Emitido em {setAlpha}.
    event AlphaUpdated(uint256 oldAlpha, uint256 newAlpha);

    /// @notice Emitido em {setCapMax}.
    event CapMaxUpdated(uint256 oldCap, uint256 newCap);

    /// @notice Emitido em {setGaugePoolId}.
    event GaugePoolIdUpdated(uint256 oldPoolId, uint256 newPoolId);

    /// @notice Emitido em {setGaugeIncentiveDuration}.
    event GaugeIncentiveDurationUpdated(uint32 oldDuration, uint32 newDuration);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAddress();
    error RoundNotClosed(uint256 round);
    error RoundAlreadyFinalized(uint256 round);
    error RoundNotFinalized(uint256 round);
    error OutOfOrderFinalize(uint256 expected, uint256 provided);
    error AlreadyClaimed(uint256 round, uint256 projectId, address user);
    error ArrayLengthMismatch();
    error EmptyBatch();
    error InvalidAlpha(uint256 provided, uint256 min, uint256 max);
    error InvalidCapMax(uint256 provided, uint256 min, uint256 max);

    /// @notice Soma dos buckets nao bate 10000 em {setBucketBps}.
    error BucketBpsSumInvalid(uint256 sum);

    /// @notice Bucket fora dos bounds operacionais em {setBucketBps}.
    /// @param bucket Indice do bucket (0..3).
    /// @param provided Valor fornecido.
    /// @param min Lower bound aplicavel (0 quando nao ha minimo).
    /// @param max Upper bound aplicavel (BPS_DENOMINATOR quando nao ha maximo).
    error BucketBpsOutOfBounds(uint16 bucket, uint16 provided, uint16 min, uint16 max);

    /// @notice IE12 violada em runtime (assert defensivo).
    error EmissionMismatch(uint256 totalEmission, uint256 sumBuckets);

    /// @notice Duracao da incentive do gauge fora dos bounds.
    error InvalidGaugeIncentiveDuration(uint32 requested);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o V2 amarrado aos contratos da Fase 1.3 + Treasury Fase
     *         1.4. Concede `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE` ao
     *         `admin`. Em producao admin = Timelock.
     * @dev Inicializa `bucketBps` com o split default `[5500, 2500, 1500, 500]`
     *      (aprovado em E.1) e valida bounds — esta primeira validacao e
     *      defensiva (defaults estao dentro dos bounds, mas o pattern garante
     *      que mudar o default no codigo no futuro nao bypass setter).
     *      `gaugeIncentiveDuration` inicial = 7 dias (round duration tipico
     *      de prod).
     * @param admin Endereco que recebe admin + governance.
     * @param credit_ Endereco do `CreditToken`.
     * @param staking_ Endereco do `Staking`.
     * @param burnTracker_ Endereco do `BurnTracker`.
     * @param registry_ Endereco do `ProjectRegistry` (Fase 1.4 com
     *                  `ownerRecipient` view).
     * @param gauge_ Endereco do `LiquidityGauge` (Fase 1.3).
     * @param treasury_ Endereco do `Treasury` (Fase 1.4 com bucket bonders).
     * @param initialAlpha Alpha inicial (FP 1e18).
     * @param initialCapMax Cap inicial (CREDIT wei).
     * @param initialFloorSchedule Array fixo de 24 valores.
     */
    constructor(
        address admin,
        address credit_,
        address staking_,
        address burnTracker_,
        address registry_,
        address gauge_,
        address treasury_,
        uint256 initialAlpha,
        uint256 initialCapMax,
        uint256[24] memory initialFloorSchedule
    ) {
        _checkConstructorAddresses(admin, credit_, staking_, burnTracker_, registry_, gauge_, treasury_);
        if (initialAlpha < MIN_ALPHA || initialAlpha > MAX_ALPHA) {
            revert InvalidAlpha(initialAlpha, MIN_ALPHA, MAX_ALPHA);
        }
        if (initialCapMax < MIN_CAPMAX || initialCapMax > MAX_CAPMAX) {
            revert InvalidCapMax(initialCapMax, MIN_CAPMAX, MAX_CAPMAX);
        }

        CREDIT = CreditToken(credit_);
        STAKING = Staking(staking_);
        BURN_TRACKER = BurnTracker(burnTracker_);
        REGISTRY = ProjectRegistry(registry_);
        GAUGE = ILiquidityGaugeRewards(gauge_);
        TREASURY = ITreasuryRewards(treasury_);

        alpha = initialAlpha;
        capMax = initialCapMax;
        for (uint256 i = 0; i < FLOOR_SCHEDULE_LENGTH; i++) {
            floorSchedule[i] = initialFloorSchedule[i];
        }

        // Defaults (E.1): 55/25/15/5.
        bucketBps[BUCKET_STAKERS] = 5500;
        bucketBps[BUCKET_LPS] = 2500;
        bucketBps[BUCKET_APPS] = 1500;
        bucketBps[BUCKET_BONDERS] = 500;
        gaugePoolId = 1;
        gaugeIncentiveDuration = 7 days;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    /// @dev Validacao agregada de zero-addresses no constructor — extraido
    ///      para manter o constructor abaixo do limite de linhas
    ///      (solhint function-max-lines).
    function _checkConstructorAddresses(
        address admin,
        address credit_,
        address staking_,
        address burnTracker_,
        address registry_,
        address gauge_,
        address treasury_
    ) private pure {
        if (
            admin == address(0) ||
            credit_ == address(0) ||
            staking_ == address(0) ||
            burnTracker_ == address(0) ||
            registry_ == address(0) ||
            gauge_ == address(0) ||
            treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
    }

    // ------------------------------------------------------------------
    // Core — finalizeRound
    // ------------------------------------------------------------------

    /**
     * @notice Finaliza a rodada `round`, aplicando o split bucket-aware.
     *         Permissionless — qualquer um pode destravar (pattern V1).
     * @dev Sequencia (CEI estrito):
     *       1. Checks: sequencial, round closed, not finalized.
     *       2. Computa `totalEmission` (formula V1: `min(max(alpha*burn,
     *          floor), capMax)`).
     *       3. Splits em 4 valores via `bucketBps`. Bucket bonders recebe o
     *          residuo da divisao inteira (proteje IE12 contra perda de
     *          1-2 wei).
     *       4. Effects: grava `roundData[round]` + `bucketEmissionByRound`.
     *       5. Interactions:
     *          - Bucket apps: loop em projetos com burn no round R-1, mint
     *            direto para `ownerRecipient(p)`.
     *          - Bucket LPs: mint para self, approve gauge, notify (ou
     *            fallback Treasury se paused).
     *          - Bucket bonders: mint para Treasury, depositPolRefill.
     *          - Bucket stakers: NAO mint aqui (lazy via {claim}).
     *       6. Assert IE12: soma dos 4 valores agendados/cunhados ==
     *          totalEmission (tolerancia {SPLIT_TOLERANCE_WEI}).
     *
     *      Nota sobre apps: se `totalBurnPrev == 0` (bootstrap), bucket apps
     *      NAO emite — bonders absorve o residuo. Decisao deliberada:
     *      sem burn nao ha sinal economico para distribuir entre apps;
     *      cair no bonders refill POL e a destinacao mais defensavel.
     *      Documentar em docs/governance/fase1-4-bucket-split.md.
     *
     *      Nota sobre projetos Removed durante claim: comportamento V1
     *      preservado. Snapshot no momento de finalize fixa o peso
     *      (`STAKING.getWeightAt(snapshot)`); status do Registry no
     *      momento do claim e consultado apenas para probation penalty.
     *      Removal entre finalize e claim "fantasma" rewards para
     *      stakers que nao conseguem unstake — coordenar via emergency
     *      unstake no Staking (vide red flag E.3 #5 do parecer).
     *
     * @param round Rodada a finalizar.
     */
    function finalizeRound(uint256 round) external nonReentrant {
        // ------------------------------ Checks
        if (roundData[round].finalized) {
            revert RoundAlreadyFinalized(round);
        }
        uint256 expected = isFirstRoundFinalized ? lastFinalizedRound + 1 : 0;
        if (round != expected) {
            revert OutOfOrderFinalize(expected, round);
        }
        if (BURN_TRACKER.currentRound() <= round) {
            revert RoundNotClosed(round);
        }

        // ------------------------------ Compute emission + split
        (uint256 totalEmission, uint256 totalBurnPrev) = _computeEmission(round);
        (uint256 stakersAmount, uint256 lpsAmount, uint256 appsAmount, uint256 bondersAmount) = _splitEmission(
            totalEmission,
            totalBurnPrev
        );

        // ------------------------------ Effects
        _commitRoundState(round, totalEmission, totalBurnPrev, stakersAmount, lpsAmount, appsAmount, bondersAmount);

        // ------------------------------ Interactions
        uint256 appsActuallyMinted = _emitAppsBucket(round, appsAmount, totalBurnPrev);
        if (lpsAmount > 0) {
            _emitLpsBucket(round, lpsAmount);
        }
        if (bondersAmount > 0) {
            _emitBondersBucket(round, bondersAmount);
        }

        // ------------------------------ IE12 invariant
        // Apps pode emitir menos que appsAmount por rounding (granularidade
        // burn_p / totalBurnPrev). Tolerancia SPLIT_TOLERANCE_WEI absorve
        // residuos. Diferenca nao e queimada, apenas nao-mintada. Auditavel
        // via diff entre `bucketEmissionByRound[round][APPS]` (escrito) e os
        // eventos granulares `BucketEmissionMinted` para BUCKET_APPS.
        uint256 sumBuckets = stakersAmount + lpsAmount + appsActuallyMinted + bondersAmount;
        if (sumBuckets > totalEmission || totalEmission - sumBuckets > SPLIT_TOLERANCE_WEI) {
            revert EmissionMismatch(totalEmission, sumBuckets);
        }

        emit RoundFinalizedV2(round, totalEmission, stakersAmount, lpsAmount, appsAmount, bondersAmount);
    }

    /// @dev Persiste roundData + bucketEmissionByRound + emite o evento
    ///      granular do bucket stakers (lazy mint = recipient zero).
    function _commitRoundState(
        uint256 round,
        uint256 totalEmission,
        uint256 totalBurnPrev,
        uint256 stakersAmount,
        uint256 lpsAmount,
        uint256 appsAmount,
        uint256 bondersAmount
    ) private {
        roundData[round] = RoundData({
            totalEmission: totalEmission,
            totalBurnAtFinalize: totalBurnPrev,
            snapshotBlock: uint64(block.number),
            finalized: true
        });
        lastFinalizedRound = round;
        isFirstRoundFinalized = true;

        bucketEmissionByRound[round][BUCKET_STAKERS] = stakersAmount;
        bucketEmissionByRound[round][BUCKET_LPS] = lpsAmount;
        bucketEmissionByRound[round][BUCKET_APPS] = appsAmount;
        bucketEmissionByRound[round][BUCKET_BONDERS] = bondersAmount;

        emit BucketEmissionMinted(round, BUCKET_STAKERS, address(0), stakersAmount);
    }

    /// @dev Calcula totalEmission e totalBurnPrev do `round` (formula V1).
    function _computeEmission(uint256 round) private view returns (uint256 totalEmission, uint256 totalBurnPrev) {
        totalBurnPrev = round == 0 ? 0 : BURN_TRACKER.getTotalBurnForRound(round - 1);
        uint256 alphaBurn = (totalBurnPrev * alpha) / PRECISION;
        uint256 floorAmount = round < FLOOR_SCHEDULE_LENGTH ? floorSchedule[round] : 0;
        uint256 rawEmission = alphaBurn > floorAmount ? alphaBurn : floorAmount;
        totalEmission = rawEmission > capMax ? capMax : rawEmission;
    }

    /// @dev Split em 4 buckets, com bonders absorvendo residuo de divisao
    ///      inteira. Em bootstrap (totalBurnPrev == 0), bucket apps cai em
    ///      bonders (sem sinal economico para distribuir entre apps).
    function _splitEmission(
        uint256 totalEmission,
        uint256 totalBurnPrev
    ) private view returns (uint256 stakersAmount, uint256 lpsAmount, uint256 appsAmount, uint256 bondersAmount) {
        stakersAmount = (totalEmission * bucketBps[BUCKET_STAKERS]) / BPS_DENOMINATOR;
        lpsAmount = (totalEmission * bucketBps[BUCKET_LPS]) / BPS_DENOMINATOR;
        appsAmount = (totalEmission * bucketBps[BUCKET_APPS]) / BPS_DENOMINATOR;
        bondersAmount = totalEmission - stakersAmount - lpsAmount - appsAmount;

        if (totalBurnPrev == 0 && appsAmount > 0) {
            bondersAmount += appsAmount;
            appsAmount = 0;
        }
    }

    // ------------------------------------------------------------------
    // Core — claim (bucket stakers, lazy)
    // ------------------------------------------------------------------

    /**
     * @notice Reivindica o reward de stakers para `(round, projectId)` do
     *         `msg.sender`. Mint lazy de CREDIT.
     * @dev Apenas o bucket stakers e processado aqui — buckets LPs/apps/
     *      bonders ja foram empurrados em {finalizeRound} no push direto.
     *      Mantem semantica V1: marca `claimed`, calcula via
     *      `projectShare × stakeShare`, mint via `CREDIT.mint`.
     * @param round Rodada.
     * @param projectId Projeto.
     * @return amount CREDIT cunhado.
     */
    function claim(uint256 round, uint256 projectId) external nonReentrant returns (uint256 amount) {
        amount = _claim(msg.sender, round, projectId);
    }

    /**
     * @notice Batch de claims.
     * @param rounds Array paralelo.
     * @param projectIds Array paralelo.
     * @return total Soma dos amounts cunhados.
     */
    function claimMany(
        uint256[] calldata rounds,
        uint256[] calldata projectIds
    ) external nonReentrant returns (uint256 total) {
        uint256 n = rounds.length;
        if (n != projectIds.length) {
            revert ArrayLengthMismatch();
        }
        if (n == 0) {
            revert EmptyBatch();
        }
        for (uint256 i = 0; i < n; i++) {
            total += _claim(msg.sender, rounds[i], projectIds[i]);
        }
    }

    // ------------------------------------------------------------------
    // Governance setters
    // ------------------------------------------------------------------

    /**
     * @notice Atualiza o split de buckets em bps. Soma deve ser exatamente
     *         10000; cada bucket deve respeitar bounds individuais (E.8).
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Nao retroativo — rodadas ja
     *      finalizadas mantem o split usado em finalize.
     * @param newBps `[stakers, lps, apps, bonders]` em bps.
     */
    function setBucketBps(uint16[4] calldata newBps) external onlyRole(GOVERNANCE_ROLE) {
        _validateBucketBps(newBps);
        uint16[4] memory old = bucketBps;
        bucketBps[0] = newBps[0];
        bucketBps[1] = newBps[1];
        bucketBps[2] = newBps[2];
        bucketBps[3] = newBps[3];
        emit BucketBpsUpdated(old, newBps);
    }

    /// @dev Valida bounds individuais (E.8) + soma == 10000.
    function _validateBucketBps(uint16[4] calldata newBps) private pure {
        if (newBps[BUCKET_STAKERS] < MIN_BUCKET_STAKERS_BPS) {
            revert BucketBpsOutOfBounds(
                BUCKET_STAKERS,
                newBps[BUCKET_STAKERS],
                MIN_BUCKET_STAKERS_BPS,
                BPS_DENOMINATOR
            );
        }
        if (newBps[BUCKET_LPS] < MIN_BUCKET_LPS_BPS) {
            revert BucketBpsOutOfBounds(BUCKET_LPS, newBps[BUCKET_LPS], MIN_BUCKET_LPS_BPS, BPS_DENOMINATOR);
        }
        if (newBps[BUCKET_APPS] > MAX_BUCKET_APPS_BPS) {
            revert BucketBpsOutOfBounds(BUCKET_APPS, newBps[BUCKET_APPS], 0, MAX_BUCKET_APPS_BPS);
        }
        if (newBps[BUCKET_BONDERS] > MAX_BUCKET_BONDERS_BPS) {
            revert BucketBpsOutOfBounds(BUCKET_BONDERS, newBps[BUCKET_BONDERS], 0, MAX_BUCKET_BONDERS_BPS);
        }
        uint256 sum = uint256(newBps[0]) + uint256(newBps[1]) + uint256(newBps[2]) + uint256(newBps[3]);
        if (sum != BPS_DENOMINATOR) {
            revert BucketBpsSumInvalid(sum);
        }
    }

    /**
     * @notice Atualiza `alpha`.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Bounds `[0.5e18, 0.99e18]`. Mesma
     *      semantica do V1 (apenas rounds nao finalizados).
     * @param newAlpha Novo alpha (FP 1e18).
     */
    function setAlpha(uint256 newAlpha) external onlyRole(GOVERNANCE_ROLE) {
        if (newAlpha < MIN_ALPHA || newAlpha > MAX_ALPHA) {
            revert InvalidAlpha(newAlpha, MIN_ALPHA, MAX_ALPHA);
        }
        uint256 old = alpha;
        alpha = newAlpha;
        emit AlphaUpdated(old, newAlpha);
    }

    /**
     * @notice Atualiza `capMax`.
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Bounds `[1e18, 100M*1e18]`.
     */
    function setCapMax(uint256 newCap) external onlyRole(GOVERNANCE_ROLE) {
        if (newCap < MIN_CAPMAX || newCap > MAX_CAPMAX) {
            revert InvalidCapMax(newCap, MIN_CAPMAX, MAX_CAPMAX);
        }
        uint256 old = capMax;
        capMax = newCap;
        emit CapMaxUpdated(old, newCap);
    }

    /**
     * @notice Atualiza `gaugePoolId` (pool destino do bucket LPs).
     * @dev `onlyRole(GOVERNANCE_ROLE)`. Sem validacao on-chain do poolId
     *      contra o gauge — proximo `finalizeRound` falhara se invalido,
     *      o que e tratavel via reset deste setter (governance).
     */
    function setGaugePoolId(uint256 newPoolId) external onlyRole(GOVERNANCE_ROLE) {
        uint256 old = gaugePoolId;
        gaugePoolId = newPoolId;
        emit GaugePoolIdUpdated(old, newPoolId);
    }

    /**
     * @notice Atualiza a duracao da incentive criada no gauge para o
     *         bucket LPs. Bounds `[1h, 90d]`.
     */
    function setGaugeIncentiveDuration(uint32 newDuration) external onlyRole(GOVERNANCE_ROLE) {
        if (newDuration < 1 hours || newDuration > 90 days) {
            revert InvalidGaugeIncentiveDuration(newDuration);
        }
        uint32 old = gaugeIncentiveDuration;
        gaugeIncentiveDuration = newDuration;
        emit GaugeIncentiveDurationUpdated(old, newDuration);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Preview do amount claimavel por `user` em (round, projectId).
     */
    function previewClaim(address user, uint256 round, uint256 projectId) external view returns (uint256 amount) {
        if (!roundData[round].finalized) {
            return 0;
        }
        if (claimed[round][projectId][user]) {
            return 0;
        }
        return _calculateClaim(user, round, projectId);
    }

    /**
     * @notice Preview da emissao total para `forRound`.
     */
    function previewEmission(uint256 forRound) external view returns (uint256) {
        if (roundData[forRound].finalized) {
            return roundData[forRound].totalEmission;
        }
        uint256 totalBurnPrev = forRound == 0 ? 0 : BURN_TRACKER.getTotalBurnForRound(forRound - 1);
        uint256 alphaBurn = (totalBurnPrev * alpha) / PRECISION;
        uint256 floorAmount = forRound < FLOOR_SCHEDULE_LENGTH ? floorSchedule[forRound] : 0;
        uint256 rawEmission = alphaBurn > floorAmount ? alphaBurn : floorAmount;
        return rawEmission > capMax ? capMax : rawEmission;
    }

    /// @notice Emissao total de uma rodada finalizada.
    function getEmission(uint256 round) external view returns (uint256) {
        return roundData[round].totalEmission;
    }

    /// @notice Bucket value de uma rodada finalizada.
    function getBucketEmission(uint256 round, uint16 bucket) external view returns (uint256) {
        return bucketEmissionByRound[round][bucket];
    }

    /// @notice Share do projeto na emissao de stakers da rodada (probation
    ///         penalty aplicado quando isInProbation).
    function getProjectStakerEmission(uint256 round, uint256 projectId) external view returns (uint256) {
        if (!roundData[round].finalized) {
            return 0;
        }
        return _projectStakerShare(round, projectId);
    }

    /// @notice `true` se `round` foi finalizado.
    function isFinalized(uint256 round) external view returns (bool) {
        return roundData[round].finalized;
    }

    /// @notice Snapshot do split atual.
    function getBucketBps() external view returns (uint16[4] memory) {
        return bucketBps;
    }

    // ------------------------------------------------------------------
    // Internal — bucket emission
    // ------------------------------------------------------------------

    /**
     * @dev Bucket apps: itera projetos `1..totalProjects` consultando burn
     *      no round R-1. Para cada projeto com burn > 0, mint
     *      `appsAmount × burn_p / totalBurnPrev` direto para
     *      `REGISTRY.ownerRecipient(p)`. Retorna o total efetivamente
     *      cunhado (pode diferir de `appsAmount` por rounding).
     *
     *      Loop bounded em `totalProjects` — o Registry e governance-only,
     *      portanto numero de projetos e limitado pela frequencia de
     *      propostas DAO. Em prod, esperamos < 1000 projetos no medio
     *      prazo; gas estimado ~50k por projeto com burn (mint + check).
     *      Se a base crescer alem disso, considerar o que faz parte da
     *      Fase 2 (gauge controller).
     */
    function _emitAppsBucket(
        uint256 round,
        uint256 appsAmount,
        uint256 totalBurnPrev
    ) private returns (uint256 totalMinted) {
        if (appsAmount == 0 || totalBurnPrev == 0 || round == 0) {
            return 0;
        }
        uint256 totalProjects = REGISTRY.totalProjects();
        for (uint256 pid = 1; pid <= totalProjects; pid++) {
            uint256 burnP = BURN_TRACKER.getBurnForProjectInRound(round - 1, pid);
            if (burnP == 0) {
                continue;
            }
            uint256 share = (appsAmount * burnP) / totalBurnPrev;
            if (share == 0) {
                continue;
            }
            address recipient = REGISTRY.ownerRecipient(pid);
            if (recipient == address(0)) {
                // Projeto Removed/inexistente — share evapora (nao cai em
                // ninguem). Diferenca cai sob tolerancia IE12.
                continue;
            }
            CREDIT.mint(recipient, share, "rewardRound:apps");
            totalMinted += share;
            emit BucketEmissionMinted(round, BUCKET_APPS, recipient, share);
        }
    }

    /**
     * @dev Bucket LPs: detecta pause do gauge; se paused, mint para Treasury
     *      e accumula em `pendingGaugeRewards`. Se ativo, mint para self,
     *      approve e notify.
     */
    function _emitLpsBucket(uint256 round, uint256 lpsAmount) private {
        if (GAUGE.paused()) {
            // Fallback: mint direto para Treasury, accumulate ledger.
            CREDIT.mint(address(TREASURY), lpsAmount, "rewardRound:lps:fallback");
            TREASURY.depositPendingGaugeRewards(lpsAmount);
            emit GaugePauseFallback(round, lpsAmount);
            emit BucketEmissionMinted(round, BUCKET_LPS, address(TREASURY), lpsAmount);
            return;
        }
        // Push direto via notify.
        CREDIT.mint(address(this), lpsAmount, "rewardRound:lps");
        IERC20(address(CREDIT)).forceApprove(address(GAUGE), lpsAmount);
        GAUGE.notifyRewardAmount(gaugePoolId, lpsAmount, gaugeIncentiveDuration);
        IERC20(address(CREDIT)).forceApprove(address(GAUGE), 0);
        emit BucketEmissionMinted(round, BUCKET_LPS, address(GAUGE), lpsAmount);
    }

    /**
     * @dev Bucket bonders: mint para Treasury, accumula em `polRefillBucket`.
     */
    function _emitBondersBucket(uint256 round, uint256 bondersAmount) private {
        CREDIT.mint(address(TREASURY), bondersAmount, "rewardRound:bonders");
        TREASURY.depositPolRefill(bondersAmount);
        emit BucketEmissionMinted(round, BUCKET_BONDERS, address(TREASURY), bondersAmount);
    }

    // ------------------------------------------------------------------
    // Internal — claim
    // ------------------------------------------------------------------

    function _claim(address user, uint256 round, uint256 projectId) private returns (uint256) {
        if (!roundData[round].finalized) {
            revert RoundNotFinalized(round);
        }
        if (claimed[round][projectId][user]) {
            revert AlreadyClaimed(round, projectId, user);
        }

        uint256 amount = _calculateClaim(user, round, projectId);
        if (amount == 0) {
            return 0;
        }

        // Effects.
        claimed[round][projectId][user] = true;
        emit Claimed(user, round, projectId, amount);

        // Interaction.
        CREDIT.mint(user, amount, "rewardRoundV2:stakers");
        return amount;
    }

    /**
     * @dev Calcula o amount que `user` pode claim no bucket stakers para
     *      `(round, projectId)`. Mesma logica do V1 mas usa
     *      `bucketEmissionByRound[round][BUCKET_STAKERS]` como base, em vez
     *      de `roundData[round].totalEmission`.
     */
    function _calculateClaim(address user, uint256 round, uint256 projectId) private view returns (uint256) {
        uint256 share = _projectStakerShare(round, projectId);
        if (share == 0) {
            return 0;
        }

        uint256 snapBlock = roundData[round].snapshotBlock;
        uint256 userWeight = STAKING.getWeightAt(user, projectId, snapBlock);
        if (userWeight == 0) {
            return 0;
        }
        uint256 projectWeight = STAKING.getTotalWeightAt(projectId, snapBlock);
        return (share * userWeight) / projectWeight;
    }

    /**
     * @dev Share do projeto NO BUCKET STAKERS. Diferente do V1 que usava
     *      `totalEmission` como base, aqui a base e `bucketEmissionByRound[round][BUCKET_STAKERS]`.
     *      Probation penalty aplicado.
     */
    function _projectStakerShare(uint256 round, uint256 projectId) private view returns (uint256) {
        RoundData storage rd = roundData[round];
        uint256 stakersBase = bucketEmissionByRound[round][BUCKET_STAKERS];
        if (stakersBase == 0) {
            return 0;
        }
        uint256 snapBlock = rd.snapshotBlock;
        uint256 totalBurnPrev = rd.totalBurnAtFinalize;

        uint256 projectShare;
        if (totalBurnPrev > 0) {
            uint256 burnPrev = round == 0 ? 0 : BURN_TRACKER.getBurnForProjectInRound(round - 1, projectId);
            if (burnPrev == 0) {
                return 0;
            }
            projectShare = (stakersBase * burnPrev) / totalBurnPrev;
        } else {
            uint256 globalWeight = STAKING.getGlobalWeightAt(snapBlock);
            if (globalWeight == 0) {
                return 0;
            }
            uint256 projectWeight = STAKING.getTotalWeightAt(projectId, snapBlock);
            if (projectWeight == 0) {
                return 0;
            }
            projectShare = (stakersBase * projectWeight) / globalWeight;
        }

        if (REGISTRY.isInProbation(projectId)) {
            projectShare = projectShare / PROBATION_PENALTY_DENOM;
        }
        return projectShare;
    }
}
