// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ProjectRegistry} from "./ProjectRegistry.sol";
import {ProjectFunding} from "./ProjectFunding.sol";

/**
 * @title  FeeRouterV2
 * @notice Trilho de pagamento da Web3Community: taxa competitiva com
 *         processadores de pagamento e investimento por fatia de receita.
 *
 *          pay(projectId, 100 CREDIT):
 *            - fee do protocolo (default 2,5%) ->
 *                40% treasury | 40% buyback GOV | 20% grants
 *            - rev-share do projeto (ProjectFunding.revShareBpsOf, 0 se o
 *              projeto nunca captou) -> investidores, via notifyRevenue
 *            - resto -> appRecipient do projeto
 *
 *         CREDIT e trilho de pagamento estavel (mint/redeem 1:1 no CreditPSM).
 *         A renda do investidor vem de receita real; o valor do GOV vem do
 *         buyback financiado pela fee.
 *
 * @dev - Governanca via Timelock: setters economicos sao GOVERNANCE_ROLE.
 *      - {pay} exige projeto Active no Registry.
 *      - feeBps tem teto duro FEE_BPS_CAP (5%) — mesmo governanca nao passa.
 *      - Recipients do split (treasury/buyback/grants) sao enderecos
 *        configuraveis; os eventos carregam o detalhamento por parcela para
 *        transparencia contabil on-chain mesmo quando apontam pro mesmo
 *        endereco (MVP dev: os tres = Treasury).
 *      - {setAppRecipient} e owner-gated (rotacao operacional do recipient).
 */
contract FeeRouterV2 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ProjectNotActive(uint256 projectId);
    error NotProjectOwner(uint256 projectId, address caller);
    error FeeAboveCap(uint16 provided, uint16 cap);
    error SplitDoesNotSumTo10000(uint256 sum);

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Reparticao interna da fee (bps da PROPRIA fee, soma 10000).
    struct FeeSplit {
        uint16 treasuryBps;
        uint16 buybackBps;
        uint16 grantsBps;
    }

    // ------------------------------------------------------------------
    // Constants / roles
    // ------------------------------------------------------------------

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    /// @notice Teto duro da fee do protocolo: 5%.
    uint16 public constant FEE_BPS_CAP = 500;

    uint256 private constant BPS = 10_000;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable CREDIT;
    // solhint-disable-next-line var-name-mixedcase
    ProjectRegistry public immutable REGISTRY;
    // solhint-disable-next-line var-name-mixedcase
    ProjectFunding public immutable FUNDING;

    /// @notice Fee do protocolo em bps do pagamento (default 250 = 2,5%).
    uint16 public feeBps;

    /// @notice Reparticao da fee entre os tres destinos.
    FeeSplit public feeSplit;

    /// @notice Destinos da fee.
    address public treasuryRecipient;
    address public buybackRecipient;
    address public grantsRecipient;

    /// @notice Recipient de pagamento por projeto (fallback: owner do Registry).
    mapping(uint256 projectId => address) public appRecipientOf;

    /// @notice Volume bruto acumulado por projeto (metrica on-chain p/ investidores).
    mapping(uint256 projectId => uint256) public grossVolumeOf;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Pagamento processado, com detalhamento completo.
    event PaymentRouted(
        uint256 indexed projectId,
        address indexed payer,
        uint256 amount,
        uint256 feeToTreasury,
        uint256 feeToBuyback,
        uint256 feeToGrants,
        uint256 revShare,
        uint256 toApp
    );
    event FeeUpdated(uint16 previousBps, uint16 currentBps);
    event FeeSplitUpdated(uint16 treasuryBps, uint16 buybackBps, uint16 grantsBps);
    event RecipientsUpdated(address treasury, address buyback, address grants);
    event AppRecipientUpdated(uint256 indexed projectId, address recipient);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        address admin,
        address credit,
        address registry,
        address funding,
        address treasury_,
        address buyback_,
        address grants_,
        uint16 initialFeeBps,
        FeeSplit memory initialSplit
    ) {
        if (
            admin == address(0) || credit == address(0) || registry == address(0) || funding == address(0)
                || treasury_ == address(0) || buyback_ == address(0) || grants_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (initialFeeBps > FEE_BPS_CAP) {
            revert FeeAboveCap(initialFeeBps, FEE_BPS_CAP);
        }
        _validateSplit(initialSplit);

        CREDIT = IERC20(credit);
        REGISTRY = ProjectRegistry(registry);
        FUNDING = ProjectFunding(funding);
        treasuryRecipient = treasury_;
        buybackRecipient = buyback_;
        grantsRecipient = grants_;
        feeBps = initialFeeBps;
        feeSplit = initialSplit;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Pagamento
    // ------------------------------------------------------------------

    /**
     * @notice Paga `amount` de CREDIT ao projeto `projectId`.
     * @dev Ordem: fee -> rev-share -> app. Tudo atomico. O rev-share e
     *      transferido ao ProjectFunding ANTES do notifyRevenue (o funding
     *      contrato so contabiliza, nao puxa).
     */
    function pay(uint256 projectId, uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (!REGISTRY.isActive(projectId)) {
            revert ProjectNotActive(projectId);
        }

        CREDIT.safeTransferFrom(msg.sender, address(this), amount);

        // ---- fee do protocolo
        uint256 fee = (amount * feeBps) / BPS;
        uint256 toTreasury = (fee * feeSplit.treasuryBps) / BPS;
        uint256 toBuyback = (fee * feeSplit.buybackBps) / BPS;
        uint256 toGrants = fee - toTreasury - toBuyback; // residuo -> grants

        // ---- rev-share do projeto (0 se nunca captou)
        uint256 revShare = (amount * FUNDING.revShareBpsOf(projectId)) / BPS;

        // ---- app fica com o resto
        uint256 toApp = amount - fee - revShare;

        if (toTreasury > 0) CREDIT.safeTransfer(treasuryRecipient, toTreasury);
        if (toBuyback > 0) CREDIT.safeTransfer(buybackRecipient, toBuyback);
        if (toGrants > 0) CREDIT.safeTransfer(grantsRecipient, toGrants);
        if (revShare > 0) {
            CREDIT.safeTransfer(address(FUNDING), revShare);
            FUNDING.notifyRevenue(projectId, revShare);
        }

        address appRecipient = appRecipientOf[projectId];
        if (appRecipient == address(0)) {
            appRecipient = REGISTRY.getProject(projectId).owner;
        }
        CREDIT.safeTransfer(appRecipient, toApp);

        grossVolumeOf[projectId] += amount;

        emit PaymentRouted(projectId, msg.sender, amount, toTreasury, toBuyback, toGrants, revShare, toApp);
    }

    // ------------------------------------------------------------------
    // Governance / operacional
    // ------------------------------------------------------------------

    /// @notice Ajusta a fee do protocolo (teto duro FEE_BPS_CAP).
    function setFeeBps(uint16 newFeeBps) external onlyRole(GOVERNANCE_ROLE) {
        if (newFeeBps > FEE_BPS_CAP) {
            revert FeeAboveCap(newFeeBps, FEE_BPS_CAP);
        }
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Ajusta a reparticao interna da fee.
    function setFeeSplit(FeeSplit calldata newSplit) external onlyRole(GOVERNANCE_ROLE) {
        _validateSplit(newSplit);
        feeSplit = newSplit;
        emit FeeSplitUpdated(newSplit.treasuryBps, newSplit.buybackBps, newSplit.grantsBps);
    }

    /// @notice Ajusta os destinos da fee.
    function setRecipients(address treasury_, address buyback_, address grants_)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (treasury_ == address(0) || buyback_ == address(0) || grants_ == address(0)) {
            revert ZeroAddress();
        }
        treasuryRecipient = treasury_;
        buybackRecipient = buyback_;
        grantsRecipient = grants_;
        emit RecipientsUpdated(treasury_, buyback_, grants_);
    }

    /// @notice Dono do projeto rotaciona o recipient de pagamento.
    function setAppRecipient(uint256 projectId, address recipient) external {
        if (REGISTRY.getProject(projectId).owner != msg.sender) {
            revert NotProjectOwner(projectId, msg.sender);
        }
        if (recipient == address(0)) {
            revert ZeroAddress();
        }
        appRecipientOf[projectId] = recipient;
        emit AppRecipientUpdated(projectId, recipient);
    }

    function _validateSplit(FeeSplit memory s) private pure {
        uint256 sum = uint256(s.treasuryBps) + s.buybackBps + s.grantsBps;
        if (sum != BPS) {
            revert SplitDoesNotSumTo10000(sum);
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Preview do detalhamento de um pagamento (UI).
    function previewPay(uint256 projectId, uint256 amount)
        external
        view
        returns (uint256 fee, uint256 revShare, uint256 toApp)
    {
        fee = (amount * feeBps) / BPS;
        revShare = (amount * FUNDING.revShareBpsOf(projectId)) / BPS;
        toApp = amount - fee - revShare;
    }
}
