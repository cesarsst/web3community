// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ProjectRegistry} from "./ProjectRegistry.sol";
import {Staking} from "./Staking.sol";

/**
 * @title  ProjectFunding
 * @notice Captacao + redistribuicao de receita por projeto (remodel 2026-07-08).
 *         Substitui a emissao inflacionaria de CREDIT como fonte de renda do
 *         investidor: quem financia um projeto compra o direito a uma fatia
 *         (`revShareBps`) da receita bruta futura, paga automaticamente pelo
 *         {FeeRouterV2} a cada pagamento.
 *
 *         Ciclo:
 *          1. Dono do projeto (Registry) abre rodada: alvo em CREDIT,
 *             rev-share oferecido (bps) e prazo.
 *          2. Investidores com peso de GOV stakeado NO projeto
 *             ({Staking.getWeight}) >= {minInvestWeight} depositam CREDIT ate o
 *             alvo (piso anti-sybil de entrada, D3).
 *          3. Alvo batido -> pagamento automatico ao dono ({_fund}) e rev-share ativo.
 *             Prazo vencido sem alvo -> rodada falha, {refund} devolve 100%.
 *          4. {FeeRouterV2} chama {notifyRevenue} a cada pagamento; investidor
 *             saca com {claim} (exige manter GOV stakeado no projeto).
 *
 * @dev Decisoes de desenho:
 *      - Uma rodada bem-sucedida POR PROJETO (MVP). Rodadas subsequentes
 *        exigiriam empilhar pools de shares com bps distintos — fora de
 *        escopo; documentado para V2.
 *      - Shares = CREDIT investido (1:1, imutavel apos finalize).
 *      - Distribuicao usa acumulador `accRevenuePerShare` (padrao MasterChef,
 *        1e18 de precisao) — O(1) por pagamento, O(1) por claim.
 *      - Gates de stake ASSIMETRICOS (D3, parecer
 *        `audit/economist/2026-07-10-wash-signal-integrity.md` §6):
 *          * {invest} exige peso >= {minInvestWeight} (piso ajustavel > 0) —
 *            barreira de ENTRADA anti-sybil: fabricar N "investidores" fake
 *            passa a exigir capital real (GOV) travado por carteira.
 *          * {claim} mantem o gate ORIGINAL peso > 0 — o piso NAO se aplica na
 *            SAIDA: quem ja investiu e reduziu o stake (mas mantem algum) nao
 *            pode ser barrado de sacar rev-share ja conquistado (evita punir
 *            retroativamente e travar fundos).
 *        Sem stake o valor NAO e perdido — fica acruado ate o investidor
 *        voltar a stakear.
 *      - All-or-nothing: rodada so paga o dono se bater o alvo. Protege o
 *        investidor de financiar pela metade um projeto inviavel.
 */
contract ProjectFunding is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAmount();
    error ZeroAddress();
    error ProjectNotActive(uint256 projectId);
    error NotProjectOwner(uint256 projectId, address caller);
    error RoundAlreadyExists(uint256 projectId);
    error RoundNotFound(uint256 projectId);
    error RoundNotOpen(uint256 projectId);
    error RoundStillOpen(uint256 projectId);
    error RoundNotFailed(uint256 projectId);
    error RevShareOutOfBounds(uint16 provided, uint16 min, uint16 max);
    error TargetOutOfBounds(uint256 provided, uint256 min);
    error DurationOutOfBounds(uint64 provided, uint64 min, uint64 max);
    error NoGovStaked(uint256 projectId, address investor);
    error InsufficientStakeWeight(uint256 projectId, address investor, uint256 have, uint256 required);
    error ExceedsTarget(uint256 requested, uint256 remaining);
    error NothingToRefund(uint256 projectId, address investor);
    error NothingToClaim(uint256 projectId, address investor);
    error NoActiveShares(uint256 projectId);

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum RoundStatus {
        None,       // nunca aberta
        Open,       // captando
        Funded,     // alvo batido, rev-share ativo
        Failed      // prazo vencido sem alvo; refunds liberados
    }

    struct Round {
        uint256 target;         // alvo em CREDIT (18d)
        uint256 raised;         // captado ate agora
        uint64 deadline;        // timestamp limite
        uint16 revShareBps;     // fatia da receita bruta oferecida
        RoundStatus status;
    }

    // ------------------------------------------------------------------
    // Constants / roles
    // ------------------------------------------------------------------

    /// @notice Role do FeeRouterV2 — unico autorizado a notificar receita.
    bytes32 public constant REVENUE_NOTIFIER_ROLE = keccak256("REVENUE_NOTIFIER_ROLE");

    /// @notice Governanca (Timelock) — ajusta bounds.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    uint16 public constant MIN_REV_SHARE_BPS = 100;   // 1%
    uint16 public constant MAX_REV_SHARE_BPS = 3000;  // 30%
    uint64 public constant MIN_ROUND_DURATION = 1 days;
    uint64 public constant MAX_ROUND_DURATION = 90 days;
    uint256 public constant ACC_PRECISION = 1e18;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable CREDIT;
    // solhint-disable-next-line var-name-mixedcase
    ProjectRegistry public immutable REGISTRY;
    // solhint-disable-next-line var-name-mixedcase
    Staking public immutable STAKING;

    /// @notice Alvo minimo de rodada (anti-spam). Ajustavel por governanca.
    uint256 public minTarget = 100e18;

    /// @notice Piso de peso de stake (unidades de {Staking.getWeight}, i.e.
    ///         `amount * multiplier / 1e18`) exigido para {invest}. Barreira
    ///         anti-sybil na ENTRADA da rodada (mitigacao D3 do parecer
    ///         `audit/economist/2026-07-10-wash-signal-integrity.md` §6): forca
    ///         o atacante a imobilizar CAPITAL REAL (GOV travado) por carteira
    ///         "investidora", encarecendo a auto-rodada / o sybil de investidor.
    ///         Default = 100e18 = stakar ~100 GOV no lock minimo (multiplier 1x)
    ///         — nao proibitivo para o investidor pequeno legitimo, mas > 0 (o
    ///         gate antigo aceitava qualquer poeira de GOV, inclusive self-stake
    ///         trivial). Ajustavel por governanca via {setMinInvestWeight}.
    ///         NAO se aplica ao {claim} (ver NatSpec de {claim}).
    uint256 public minInvestWeight;

    /// @notice Rodada (unica) de cada projeto.
    mapping(uint256 projectId => Round) public rounds;

    /// @notice Shares do investidor (== CREDIT investido) por projeto.
    mapping(uint256 projectId => mapping(address investor => uint256)) public sharesOf;

    /// @notice Acumulador de receita por share (escala ACC_PRECISION).
    mapping(uint256 projectId => uint256) public accRevenuePerShare;

    /// @notice Checkpoint do investidor contra o acumulador (padrao MasterChef).
    mapping(uint256 projectId => mapping(address investor => uint256)) public rewardDebt;

    /// @notice Receita total ja distribuida por projeto (auditoria/UI).
    mapping(uint256 projectId => uint256) public totalRevenueDistributed;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event RoundOpened(uint256 indexed projectId, uint256 target, uint16 revShareBps, uint64 deadline);
    event Invested(uint256 indexed projectId, address indexed investor, uint256 amount, uint256 totalRaised);
    event RoundFunded(uint256 indexed projectId, uint256 raised, address indexed paidTo);
    event RoundFailed(uint256 indexed projectId, uint256 raised);
    event Refunded(uint256 indexed projectId, address indexed investor, uint256 amount);
    event RevenueNotified(uint256 indexed projectId, uint256 amount);
    event RevenueClaimed(uint256 indexed projectId, address indexed investor, uint256 amount);
    event MinTargetUpdated(uint256 previous, uint256 current);
    event MinInvestWeightUpdated(uint256 previous, uint256 current);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(address admin, address credit, address registry, address staking) {
        if (admin == address(0) || credit == address(0) || registry == address(0) || staking == address(0)) {
            revert ZeroAddress();
        }
        CREDIT = IERC20(credit);
        REGISTRY = ProjectRegistry(registry);
        STAKING = Staking(staking);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);

        // Piso anti-sybil de entrada (D3). 100e18 = ~100 GOV no lock minimo
        // (multiplier 1x). Ver NatSpec de {minInvestWeight}.
        minInvestWeight = 100e18;
    }

    // ------------------------------------------------------------------
    // Rodada
    // ------------------------------------------------------------------

    /**
     * @notice Abre a rodada de captacao do projeto. So o dono (Registry).
     */
    function openRound(
        uint256 projectId,
        uint256 target,
        uint16 revShareBps,
        uint64 duration
    ) external nonReentrant {
        if (!REGISTRY.isActive(projectId)) {
            revert ProjectNotActive(projectId);
        }
        if (REGISTRY.getProject(projectId).owner != msg.sender) {
            revert NotProjectOwner(projectId, msg.sender);
        }
        if (rounds[projectId].status != RoundStatus.None) {
            revert RoundAlreadyExists(projectId);
        }
        if (revShareBps < MIN_REV_SHARE_BPS || revShareBps > MAX_REV_SHARE_BPS) {
            revert RevShareOutOfBounds(revShareBps, MIN_REV_SHARE_BPS, MAX_REV_SHARE_BPS);
        }
        if (target < minTarget) {
            revert TargetOutOfBounds(target, minTarget);
        }
        if (duration < MIN_ROUND_DURATION || duration > MAX_ROUND_DURATION) {
            revert DurationOutOfBounds(duration, MIN_ROUND_DURATION, MAX_ROUND_DURATION);
        }

        uint64 deadline = uint64(block.timestamp) + duration;
        rounds[projectId] = Round({
            target: target,
            raised: 0,
            deadline: deadline,
            revShareBps: revShareBps,
            status: RoundStatus.Open
        });

        emit RoundOpened(projectId, target, revShareBps, deadline);
    }

    /**
     * @notice Investe CREDIT na rodada aberta. Exige peso de stake de GOV no
     *         projeto >= {minInvestWeight} (piso anti-sybil de entrada, D3).
     * @dev Alvo batido finaliza automaticamente (paga o dono, ativa rev-share).
     *      Gate = `STAKING.getWeight(msg.sender, projectId) >= minInvestWeight`
     *      (reverte {InsufficientStakeWeight}). E uma barreira de ENTRADA: o
     *      {claim} usa gate diferente (peso > 0) — ver NatSpec de {claim}.
     *      Mitigacao D3 do parecer
     *      `audit/economist/2026-07-10-wash-signal-integrity.md` §6: força o
     *      atacante a imobilizar capital real (GOV) por carteira "investidora",
     *      encarecendo a auto-rodada.
     */
    function invest(uint256 projectId, uint256 amount) external nonReentrant {
        Round storage r = rounds[projectId];
        if (r.status != RoundStatus.Open) {
            revert RoundNotOpen(projectId);
        }
        if (block.timestamp > r.deadline) {
            revert RoundNotOpen(projectId);
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        // D3: piso de peso minimo de stake para investir. Substitui o gate
        // antigo `getWeight > 0` (que aceitava qualquer poeira / self-stake
        // trivial) por um PISO ajustavel — barreira anti-sybil de ENTRADA.
        uint256 weight = STAKING.getWeight(msg.sender, projectId);
        if (weight < minInvestWeight) {
            revert InsufficientStakeWeight(projectId, msg.sender, weight, minInvestWeight);
        }
        uint256 remaining = r.target - r.raised;
        if (amount > remaining) {
            revert ExceedsTarget(amount, remaining);
        }

        // Effects antes de interactions (CEI) — o token e confiavel (CREDIT,
        // sem hooks), mas manter a ordem canonica elimina a classe inteira.
        r.raised += amount;
        sharesOf[projectId][msg.sender] += amount;
        emit Invested(projectId, msg.sender, amount, r.raised);

        CREDIT.safeTransferFrom(msg.sender, address(this), amount);

        if (r.raised == r.target) {
            _fund(projectId, r);
        }
    }

    /**
     * @notice Encerra rodada com prazo vencido e alvo nao batido (-> Failed).
     *         Permissionless — qualquer um pode "carimbar" a falha.
     */
    function closeExpiredRound(uint256 projectId) external nonReentrant {
        Round storage r = rounds[projectId];
        if (r.status != RoundStatus.Open) {
            revert RoundNotOpen(projectId);
        }
        if (block.timestamp <= r.deadline) {
            revert RoundStillOpen(projectId);
        }
        r.status = RoundStatus.Failed;
        emit RoundFailed(projectId, r.raised);
    }

    /**
     * @notice Devolve 100% do investido numa rodada Failed.
     */
    function refund(uint256 projectId) external nonReentrant {
        Round storage r = rounds[projectId];
        if (r.status != RoundStatus.Failed) {
            revert RoundNotFailed(projectId);
        }
        uint256 amount = sharesOf[projectId][msg.sender];
        if (amount == 0) {
            revert NothingToRefund(projectId, msg.sender);
        }
        sharesOf[projectId][msg.sender] = 0;
        r.raised -= amount;
        CREDIT.safeTransfer(msg.sender, amount);
        emit Refunded(projectId, msg.sender, amount);
    }

    /// @dev Alvo batido: paga o dono e ativa o rev-share.
    function _fund(uint256 projectId, Round storage r) private {
        r.status = RoundStatus.Funded;
        address owner = REGISTRY.getProject(projectId).owner;
        CREDIT.safeTransfer(owner, r.raised);
        emit RoundFunded(projectId, r.raised, owner);
    }

    // ------------------------------------------------------------------
    // Receita
    // ------------------------------------------------------------------

    /**
     * @notice Recebe a fatia de rev-share de um pagamento. So FeeRouterV2.
     * @dev O router ja transferiu `amount` de CREDIT para este contrato
     *      (pull pattern no router via safeTransfer direto). Aqui apenas
     *      atualizamos o acumulador.
     */
    function notifyRevenue(uint256 projectId, uint256 amount) external onlyRole(REVENUE_NOTIFIER_ROLE) {
        if (amount == 0) {
            revert ZeroAmount();
        }
        Round storage r = rounds[projectId];
        if (r.status != RoundStatus.Funded || r.raised == 0) {
            revert NoActiveShares(projectId);
        }
        accRevenuePerShare[projectId] += (amount * ACC_PRECISION) / r.raised;
        totalRevenueDistributed[projectId] += amount;
        emit RevenueNotified(projectId, amount);
    }

    /**
     * @notice Saca a receita acumulada do investidor no projeto.
     * @dev Exige GOV ainda stakeado no projeto (skin in the game): gate
     *      ORIGINAL `getWeight > 0` (reverte {NoGovStaked}). O valor nunca
     *      expira — sem stake ele apenas fica retido ate re-stake.
     *
     *      DECISAO DE DESENHO (D3, parecer 2026-07-10 §6): o piso
     *      {minInvestWeight} do {invest} deliberadamente NAO se aplica aqui. O
     *      piso e uma barreira de ENTRADA (anti-sybil no momento de investir),
     *      nao uma trava de SAIDA. Um investidor legitimo que ja investiu e
     *      depois reduziu o stake (mas mantem algum) nao pode ser impedido de
     *      sacar rev-share que JA conquistou — subir o piso no claim puniria
     *      retroativamente quem entrou antes de uma mudança de parametro e
     *      criaria risco de fundos presos. Por isso o claim mantem o gate
     *      `peso > 0`, nao `peso >= minInvestWeight`.
     */
    function claim(uint256 projectId) external nonReentrant returns (uint256 amount) {
        if (STAKING.getWeight(msg.sender, projectId) == 0) {
            revert NoGovStaked(projectId, msg.sender);
        }
        amount = _pending(projectId, msg.sender);
        if (amount == 0) {
            revert NothingToClaim(projectId, msg.sender);
        }
        rewardDebt[projectId][msg.sender] =
            (sharesOf[projectId][msg.sender] * accRevenuePerShare[projectId]) / ACC_PRECISION;
        CREDIT.safeTransfer(msg.sender, amount);
        emit RevenueClaimed(projectId, msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Governance
    // ------------------------------------------------------------------

    /// @notice Ajusta o alvo minimo de rodada.
    function setMinTarget(uint256 newMin) external onlyRole(GOVERNANCE_ROLE) {
        emit MinTargetUpdated(minTarget, newMin);
        minTarget = newMin;
    }

    /// @notice Ajusta o piso de peso de stake exigido para {invest} (D3).
    /// @dev So afeta o gate de ENTRADA ({invest}); o {claim} mantem `peso > 0`.
    function setMinInvestWeight(uint256 newMin) external onlyRole(GOVERNANCE_ROLE) {
        emit MinInvestWeightUpdated(minInvestWeight, newMin);
        minInvestWeight = newMin;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Rev-share ativo do projeto (0 se nao Funded) — consumido pelo router.
    function revShareBpsOf(uint256 projectId) external view returns (uint16) {
        Round storage r = rounds[projectId];
        return r.status == RoundStatus.Funded ? r.revShareBps : 0;
    }

    /// @notice Receita pendente de claim do investidor.
    function pendingRevenue(uint256 projectId, address investor) external view returns (uint256) {
        return _pending(projectId, investor);
    }

    function _pending(uint256 projectId, address investor) private view returns (uint256) {
        uint256 accumulated = (sharesOf[projectId][investor] * accRevenuePerShare[projectId]) / ACC_PRECISION;
        return accumulated - rewardDebt[projectId][investor];
    }
}
