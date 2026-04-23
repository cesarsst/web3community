// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CreditToken} from "./CreditToken.sol";
import {BurnTracker} from "./BurnTracker.sol";
import {ProjectRegistry} from "./ProjectRegistry.sol";
import {Staking} from "./Staking.sol";

/**
 * @title RewardDistributor
 * @notice Coracao do modelo economico da Web3Community. Calcula a emissao de
 *         CREDIT por rodada (fase 4.1) e cunha-a sob demanda para stakers via
 *         claim pull-based. Consome (1) burn historico do {BurnTracker},
 *         (2) snapshot de peso global/por-projeto do {Staking} e (3) status
 *         dos projetos no {ProjectRegistry}.
 * @dev Formula da emissao por rodada R:
 *        emissao_R = min( max(alpha * burn_{R-1}, floor(R)), capMax )
 *      - alpha (FP 1e18) e o fator aplicado ao burn da rodada anterior.
 *        Default 0.95e18 — levemente deflacionario, para que a soma dos
 *        burns acumulados sempre supere a soma das emissoes se o uso
 *        permanecer constante.
 *      - floor(R) e um schedule decrescente de 24 rodadas (constructor-set,
 *        imutavel) que serve como "safety-net" de bootstrap — garante
 *        emissao positiva enquanto o ecossistema ainda nao gera burn.
 *      - capMax e o teto duro governance-tunable (default 5M CREDIT).
 *      A emissao por PROJETO dentro da rodada e calculada **sob demanda**
 *      em `_calculateClaim` (nao e pre-computada em `finalizeRound`) para
 *      que o custo de gas escale com o numero de claims efetuados, nao com
 *      o numero total de projetos listados no Registry:
 *        - Se `burn_{R-1}` > 0: projectShare = emissao * burn_{R-1,P} / burn_{R-1}
 *        - Se `burn_{R-1}` == 0 (bootstrap): projectShare via global weight
 *          do Staking — projectShare = emissao * totalWeight_P / globalWeight
 *          no snapshot do bloco de finalizacao. Requer `Staking.getGlobalWeightAt`
 *          (trilho de checkpoint global, O(1) por update).
 *      Probation (inicial por tempo no Registry): projectShare e multiplicado
 *      por 1/4 (25%). Os 75% restantes **nao sao redistribuidos** — sao
 *      simplesmente nao-cunhados. Decisao deliberada: redistribuir exigiria
 *      iteracao ou contador de "projetos nao-probation", aumentando complexidade
 *      e gas. A semantica "queima os 75%" e um desincentivo cristalino contra
 *      projetos em probation e preserva o cap economico.
 *
 *      **Pull-based claim**: nao ha push automatico de rewards. Cada staker
 *      chama {claim} ou {claimMany} para cunhar seus CREDIT ganhos. Evita
 *      gas explosion em rodadas com milhares de stakers e delega o custo
 *      para quem se beneficia.
 *
 *      **Snapshot semantics**: {finalizeRound} registra `block.number` como
 *      `snapshotBlock` da rodada. Todas as consultas de peso no claim usam
 *      esse bloco (via `getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt`),
 *      replicando a protecao anti-flash-loan da governanca ERC20Votes para
 *      a dimensao de share-of-rewards.
 *
 *      Invariantes economicas cobertas:
 *       - I2: burn gera reward por _consumo_, nao por volume passivo. Sem
 *         burn na rodada anterior, so o floor sustenta emissao.
 *       - I3: cap por rodada (capMax, governance-tunable) + schedule
 *         decrescente (floor) garantem emissao limitada por design.
 *       - I5: snapshot historico do Staking (ERC20Votes-like) impede
 *         flash-stake na rodada para capturar rewards.
 *       - I6: lock minimo 14d no Staking torna flash-stake inviavel.
 *       - I7: projetos entram via Registry apenas com proposta aprovada;
 *         probation punitiva (status != Active) retorna share zero.
 * @custom:security-contact security@web3community.example
 */
contract RewardDistributor is AccessControl, ReentrancyGuard {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Snapshot imutavel de uma rodada apos {finalizeRound}.
    /// @param totalEmission Emissao total calculada (em CREDIT wei).
    /// @param totalBurnAtFinalize Burn total da rodada anterior (imutavel
    ///                            apos finalize, evita depender do mapping
    ///                            do tracker em queries posteriores).
    /// @param snapshotBlock Block.number no momento do finalize. Usado para
    ///                      todas as consultas de peso no claim.
    /// @param finalized `true` se a rodada ja passou pelo finalize.
    struct RoundData {
        uint256 totalEmission;
        uint256 totalBurnAtFinalize;
        uint64 snapshotBlock;
        bool finalized;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Role concedida ao `TimelockController` em producao. Unica capaz
    ///         de ajustar {alpha} e {capMax}. {finalizeRound} e {claim} nao
    ///         sao role-gated (permission-less) — destravam sem governanca.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    /// @notice Precisao FP dos parametros economicos (alpha).
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant PRECISION = 1e18;

    /// @notice Limite inferior de {alpha}. 0.5e18 = 0.5 — abaixo torna a
    ///         emissao dominantemente controlada pelo floor, perdendo o
    ///         acoplamento com o burn real.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MIN_ALPHA = 5e17;

    /// @notice Limite superior de {alpha}. 0.99e18 = 0.99 — teto estritamente
    ///         menor que 1 por construcao, garantindo a invariante economica
    ///         IE1 (alpha < 1 permanente) por codigo e eliminando qualquer
    ///         caminho de governanca que transforme o protocolo em
    ///         inflacionario (emissao > burn). Anteriormente este teto era
    ///         1.1e18; a reducao foi ratificada pelo parecer dao-economist
    ///         em `audit/economist/2026-04-22-consistency-audit.md` (C2),
    ///         para alinhar o contrato a narrativa "levemente deflacionario"
    ///         da documentacao e dos core concepts.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MAX_ALPHA = 99e16;

    /// @notice Limite inferior de {capMax}. 1 CREDIT — impede cap zero
    ///         que zerava rewards sem aviso.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MIN_CAPMAX = 1e18;

    /// @notice Limite superior de {capMax}. 100M CREDIT — cap sanitario,
    ///         emissoes acima disso nunca fazem sentido economico.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant MAX_CAPMAX = 100_000_000e18;

    /// @notice Tamanho do schedule de floor (genesis decay). 24 rodadas e
    ///         ~6 meses com `roundDuration = 7d`.
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant FLOOR_SCHEDULE_LENGTH = 24;

    /// @notice Denominador do penalty de probation (25% = share / 4).
    // solhint-disable-next-line const-name-snakecase
    uint256 public constant PROBATION_PENALTY_DENOM = 4;

    // ------------------------------------------------------------------
    // Immutable dependencies
    // ------------------------------------------------------------------

    /// @notice Token de credito cunhado aos stakers como reward.
    // solhint-disable-next-line var-name-mixedcase
    CreditToken public immutable CREDIT;

    /// @notice Contrato de staking (peso + snapshots).
    // solhint-disable-next-line var-name-mixedcase
    Staking public immutable STAKING;

    /// @notice BurnTracker consultado para burn historico por projeto/rodada.
    // solhint-disable-next-line var-name-mixedcase
    BurnTracker public immutable BURN_TRACKER;

    /// @notice Registry consultado para status do projeto (isActive / isInProbation).
    // solhint-disable-next-line var-name-mixedcase
    ProjectRegistry public immutable REGISTRY;

    // ------------------------------------------------------------------
    // Governance-tunable params
    // ------------------------------------------------------------------

    /// @notice Alpha (FP 1e18). Multiplicador aplicado ao burn da rodada
    ///         anterior. Default 0.95e18.
    uint256 public alpha;

    /// @notice Cap maximo por rodada (em CREDIT wei). Teto duro da emissao.
    uint256 public capMax;

    /// @notice Schedule imutavel de floor por rodada. `floorSchedule[R]` e
    ///         aplicado ao round R. Rodadas >= 24 nao tem floor.
    uint256[24] public floorSchedule;

    // ------------------------------------------------------------------
    // Round state
    // ------------------------------------------------------------------

    /// @notice Ultima rodada finalizada. Junto com {isFirstRoundFinalized}
    ///         controla a invariante de sequencialidade em {finalizeRound}.
    uint256 public lastFinalizedRound;

    /// @notice Flag one-shot que distingue "round 0 ja finalizado" de
    ///         "nenhum round finalizado ainda" — sem ela nao tem como
    ///         representar o estado inicial com `lastFinalizedRound == 0`.
    bool public isFirstRoundFinalized;

    /// @notice Snapshot imutavel por rodada apos finalize.
    mapping(uint256 round => RoundData) public roundData;

    /// @notice `true` se (user, round, projectId) ja executou {claim} com
    ///         amount > 0. Evita double-claim.
    mapping(uint256 round => mapping(uint256 projectId => mapping(address user => bool))) public claimed;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido em {finalizeRound}. `totalEmission` e o valor da
    ///         formula (min(max(alpha*burn, floor), cap)).
    event RoundFinalized(
        uint256 indexed round,
        uint256 totalEmission,
        uint256 totalBurnAtFinalize,
        uint64 snapshotBlock
    );

    /// @notice Emitido a cada {claim} que cunhou CREDIT. `amount == 0` nao
    ///         emite — claim sem peso e no-op silencioso.
    event Claimed(address indexed user, uint256 indexed round, uint256 indexed projectId, uint256 amount);

    /// @notice Emitido em {setAlpha}.
    event AlphaUpdated(uint256 oldAlpha, uint256 newAlpha);

    /// @notice Emitido em {setCapMax}.
    event CapMaxUpdated(uint256 oldCap, uint256 newCap);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice A rodada ainda nao foi fechada no `BurnTracker`.
    error RoundNotClosed(uint256 round);

    /// @notice A rodada ja foi finalizada — `roundData[round].finalized == true`.
    error RoundAlreadyFinalized(uint256 round);

    /// @notice A rodada nao foi finalizada — claim/preview exigem finalize.
    error RoundNotFinalized(uint256 round);

    /// @notice Tentativa de finalizar fora de ordem. Exigimos sequencialidade:
    ///         round 0, depois 1, depois 2, etc.
    error OutOfOrderFinalize(uint256 expected, uint256 provided);

    /// @notice Claim duplicado para (round, projectId, user).
    error AlreadyClaimed(uint256 round, uint256 projectId, address user);

    /// @notice claimMany recebeu arrays de tamanhos diferentes.
    error ArrayLengthMismatch();

    /// @notice claimMany recebeu arrays vazios.
    error EmptyBatch();

    /// @notice alpha fora dos bounds permitidos.
    error InvalidAlpha(uint256 provided, uint256 min, uint256 max);

    /// @notice capMax fora dos bounds permitidos.
    error InvalidCapMax(uint256 provided, uint256 min, uint256 max);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o distributor amarrado aos contratos da fase 1-3 e
     *         recebe os parametros economicos iniciais.
     * @dev Valida todos os enderecos != 0, alpha em `[MIN_ALPHA, MAX_ALPHA]`,
     *      capMax em `[MIN_CAPMAX, MAX_CAPMAX]` e copia o floorSchedule para
     *      storage. O schedule tem tamanho fixo 24 — a assinatura usa
     *      `uint256[24]` para forcar o caller a passar os 24 valores (array
     *      dinamico exigiria check adicional de length).
     *      Concede `DEFAULT_ADMIN_ROLE` e `GOVERNANCE_ROLE` ao `admin`.
     *      Em producao o `admin` transfere `GOVERNANCE_ROLE` ao
     *      TimelockController e renuncia (invariante I4) via deploy script.
     * @param admin Endereco que recebe admin e governance inicial.
     * @param credit_ Endereco do `CreditToken`.
     * @param staking_ Endereco do `Staking`.
     * @param burnTracker_ Endereco do `BurnTracker`.
     * @param registry_ Endereco do `ProjectRegistry`.
     * @param initialAlpha Alpha inicial (FP 1e18, em `[MIN_ALPHA, MAX_ALPHA]`).
     * @param initialCapMax Cap inicial (CREDIT wei, em `[MIN_CAPMAX, MAX_CAPMAX]`).
     * @param initialFloorSchedule Array fixo de 24 valores (floor por rodada).
     */
    constructor(
        address admin,
        address credit_,
        address staking_,
        address burnTracker_,
        address registry_,
        uint256 initialAlpha,
        uint256 initialCapMax,
        uint256[24] memory initialFloorSchedule
    ) {
        if (
            admin == address(0) ||
            credit_ == address(0) ||
            staking_ == address(0) ||
            burnTracker_ == address(0) ||
            registry_ == address(0)
        ) {
            revert ZeroAddress();
        }
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

        alpha = initialAlpha;
        capMax = initialCapMax;
        for (uint256 i = 0; i < FLOOR_SCHEDULE_LENGTH; i++) {
            floorSchedule[i] = initialFloorSchedule[i];
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Core — state-changing
    // ------------------------------------------------------------------

    /**
     * @notice Finaliza a rodada `round`, calculando e gravando
     *         `roundData[round]`. Permissionless — qualquer um pode destravar
     *         claims apos o `closeRound` do `BurnTracker`.
     * @dev Ordem de checks:
     *       - round deve ser sequencial: `round == lastFinalizedRound + 1`
     *         (ou `round == 0` se `!isFirstRoundFinalized`).
     *       - `BurnTracker.currentRound() > round` — a rodada precisa ter
     *         sido fechada no tracker.
     *       - `!roundData[round].finalized` — nao refaz.
     *      Formula: emissao = min(max(alpha * burn_{R-1}, floor(R)), capMax).
     *      Para round 0 nao ha rodada anterior — `burn_{R-1}` e considerado
     *      0 (apenas o floor[0] define a emissao).
     *      Grava `snapshotBlock = block.number` para servir de ancora as
     *      consultas de peso no claim.
     *      Emite {RoundFinalized}.
     * @param round Rodada a finalizar.
     */
    function finalizeRound(uint256 round) external {
        // Checks. Ordem intencional: verificar "ja finalizado" antes de
        // "sequencial" para que a mensagem de erro em reentries seja
        // especifica (RoundAlreadyFinalized), nao o generico de ordem.
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

        // Computa burn da rodada anterior (0 no caso de round 0).
        uint256 totalBurnPrev = round == 0 ? 0 : BURN_TRACKER.getTotalBurnForRound(round - 1);

        // Formula emissao.
        uint256 alphaBurn = (totalBurnPrev * alpha) / PRECISION;
        uint256 floorAmount = round < FLOOR_SCHEDULE_LENGTH ? floorSchedule[round] : 0;
        uint256 rawEmission = alphaBurn > floorAmount ? alphaBurn : floorAmount;
        uint256 totalEmission = rawEmission > capMax ? capMax : rawEmission;

        // Effects.
        uint64 snapshotBlock = uint64(block.number);
        roundData[round] = RoundData({
            totalEmission: totalEmission,
            totalBurnAtFinalize: totalBurnPrev,
            snapshotBlock: snapshotBlock,
            finalized: true
        });
        lastFinalizedRound = round;
        isFirstRoundFinalized = true;

        emit RoundFinalized(round, totalEmission, totalBurnPrev, snapshotBlock);
    }

    /**
     * @notice Reivindica a parcela de rewards do `msg.sender` para
     *         (round, projectId). Calcula o valor sob demanda, marca
     *         `claimed[round][projectId][msg.sender] = true` e cunha
     *         CREDIT para o caller.
     * @dev Checks:
     *        - `roundData[round].finalized` (senao {RoundNotFinalized}).
     *        - `!claimed[round][projectId][msg.sender]` (senao {AlreadyClaimed}).
     *      Effects: marca claimed, emite {Claimed}.
     *      Interaction: `CREDIT.mint(msg.sender, amount, "rewardRound:<R>")`.
     *      Se `amount == 0` apos o calculo, nao marca claimed e nao cunha —
     *      deixa o usuario tentar de novo caso o estado mude (improvavel, mas
     *      evita "queimar" um slot de claim por erro).
     *      `nonReentrant` aplicado como defesa-em-profundidade (CREDIT.mint
     *      nao tem callback, mas blinda regressoes).
     * @param round Rodada.
     * @param projectId Projeto.
     * @return amount CREDIT cunhado.
     */
    function claim(uint256 round, uint256 projectId) external nonReentrant returns (uint256 amount) {
        amount = _claim(msg.sender, round, projectId);
    }

    /**
     * @notice Batch de claims por (round, projectId) para o `msg.sender`.
     *         Arrays paralelos.
     * @dev Reverte com {ArrayLengthMismatch} se lengths diferem e
     *      {EmptyBatch} se ambas vazias. Para cada par aplica a mesma
     *      logica de {claim} — entries com `amount == 0` sao ignoradas
     *      silenciosamente (nao marca claimed, nao revert). Entries ja
     *      claimadas revertem com {AlreadyClaimed}.
     * @param rounds Array de rodadas.
     * @param projectIds Array de projetos (mesmo tamanho).
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

    /**
     * @notice Atualiza {alpha}. Restrito a `GOVERNANCE_ROLE`.
     * @dev Reverte com {InvalidAlpha} se fora de `[MIN_ALPHA, MAX_ALPHA]`
     *      = `[0.5e18, 0.99e18]`. O teto 0.99 e intencional: garante
     *      por construcao a invariante economica IE1 (alpha < 1
     *      permanente), impedindo que qualquer proposta — mesmo
     *      aprovada por governanca — torne a emissao > burn. Ver
     *      `audit/economist/2026-04-22-consistency-audit.md` (C2).
     *      A mudanca afeta APENAS rodadas ainda nao finalizadas —
     *      rodadas com `finalized == true` tem `totalEmission` imutavel.
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
     * @notice Atualiza {capMax}. Restrito a `GOVERNANCE_ROLE`.
     * @dev Reverte com {InvalidCapMax} se fora de `[MIN_CAPMAX, MAX_CAPMAX]`.
     *      Mesma semantica de {setAlpha} (apenas rodadas nao finalizadas).
     * @param newCap Novo cap (CREDIT wei).
     */
    function setCapMax(uint256 newCap) external onlyRole(GOVERNANCE_ROLE) {
        if (newCap < MIN_CAPMAX || newCap > MAX_CAPMAX) {
            revert InvalidCapMax(newCap, MIN_CAPMAX, MAX_CAPMAX);
        }
        uint256 old = capMax;
        capMax = newCap;
        emit CapMaxUpdated(old, newCap);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Preview do amount claimavel por `user` em (round, projectId)
     *         sem side effects.
     * @dev Retorna 0 em qualquer caso de rejeicao (round nao finalizado,
     *      ja claimado, peso zero, projeto nao Active em bootstrap).
     *      Usa a mesma logica interna de {_claim}.
     * @param user Endereco do staker.
     * @param round Rodada.
     * @param projectId Projeto.
     * @return amount Valor que seria cunhado em um {claim} agora.
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
     * @notice Preview da emissao total para `forRound`, aplicando a formula
     *         atual sem gravar state.
     * @dev Para rounds finalizados, retorna `roundData[round].totalEmission`
     *      (imutavel). Para rounds nao finalizados com `forRound > 0`, le
     *      `totalBurnByRound[forRound - 1]` do tracker — se a rodada
     *      anterior ainda estiver aberta, o valor pode mudar ate o
     *      fechamento dela. Consumir com cuidado off-chain.
     * @param forRound Rodada a prever.
     * @return Emissao estimada.
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

    /// @notice Emissao de uma rodada finalizada (0 se nao finalizada).
    function getEmission(uint256 round) external view returns (uint256) {
        return roundData[round].totalEmission;
    }

    /// @notice Share de emissao para (round, projectId) — util pra UI. 0 se
    ///         round nao finalizado.
    function getProjectEmission(uint256 round, uint256 projectId) external view returns (uint256) {
        if (!roundData[round].finalized) {
            return 0;
        }
        return _projectShare(round, projectId);
    }

    /// @notice `true` se `round` passou pelo {finalizeRound}.
    function isFinalized(uint256 round) external view returns (bool) {
        return roundData[round].finalized;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /**
     * @dev Corpo compartilhado de {claim}/{claimMany}. Retorna o amount
     *      cunhado (0 se no-op).
     */
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

        // Interaction — CREDIT.mint. burnByRole/mint do CREDIT usam ERC20
        // nativo sem callback; nao ha vetor de reentrancia real.
        CREDIT.mint(user, amount, "rewardRound");
        return amount;
    }

    /**
     * @dev Calcula o amount que `user` pode claim em (round, projectId).
     *      Retorna 0 se projeto nao tem peso no snapshot ou user nao tem
     *      peso no projeto. Nao reverte — no-op silencioso.
     *      Aplica probation penalty (share / 4) se o projeto esta em
     *      probation inicial por tempo no Registry no momento da chamada.
     *      NOTA sobre probation: `isInProbation` e avaliado no momento do
     *      claim (nao do finalize). Isso e intencional — probation e por
     *      tempo no Registry (`probationEndsAt`), so pode "terminar"
     *      naturalmente. Se probation terminou entre finalize e claim, o
     *      usuario recebe share cheio. Como probationEndsAt e setado no
     *      activate e nao muda, nao ha vetor de manipulacao.
     */
    function _calculateClaim(address user, uint256 round, uint256 projectId) private view returns (uint256) {
        uint256 share = _projectShare(round, projectId);
        if (share == 0) {
            return 0;
        }

        RoundData storage rd = roundData[round];
        uint256 snapBlock = rd.snapshotBlock;
        uint256 userWeight = STAKING.getWeightAt(user, projectId, snapBlock);
        if (userWeight == 0) {
            return 0;
        }
        // Invariante do Staking: projectWeight >= userWeight. Se userWeight > 0,
        // projectWeight > 0 obrigatoriamente (o projeto agrega o user).
        // Portanto a divisao e sempre segura, sem checagem redundante.
        uint256 projectWeight = STAKING.getTotalWeightAt(projectId, snapBlock);
        return (share * userWeight) / projectWeight;
    }

    /**
     * @dev Calcula o share do projeto na emissao total da rodada. Aplica
     *      probation penalty. Sem user-weight aqui.
     */
    function _projectShare(uint256 round, uint256 projectId) private view returns (uint256) {
        RoundData storage rd = roundData[round];
        uint256 totalEmission = rd.totalEmission;
        if (totalEmission == 0) {
            return 0;
        }
        uint256 snapBlock = rd.snapshotBlock;
        uint256 totalBurnPrev = rd.totalBurnAtFinalize;

        uint256 projectShare;
        if (totalBurnPrev > 0) {
            // Caminho com burn: share por burn proporcional.
            uint256 burnPrev = round == 0 ? 0 : BURN_TRACKER.getBurnForProjectInRound(round - 1, projectId);
            if (burnPrev == 0) {
                return 0;
            }
            projectShare = (totalEmission * burnPrev) / totalBurnPrev;
        } else {
            // Bootstrap: share via global weight do Staking.
            uint256 globalWeight = STAKING.getGlobalWeightAt(snapBlock);
            if (globalWeight == 0) {
                return 0;
            }
            uint256 projectWeight = STAKING.getTotalWeightAt(projectId, snapBlock);
            if (projectWeight == 0) {
                return 0;
            }
            projectShare = (totalEmission * projectWeight) / globalWeight;
        }

        // Probation penalty: share / 4.
        if (REGISTRY.isInProbation(projectId)) {
            projectShare = projectShare / PROBATION_PENALTY_DENOM;
        }
        return projectShare;
    }
}
