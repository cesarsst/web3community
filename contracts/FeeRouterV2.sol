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
    error ZeroHalfLife();

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

    /// @notice Meia-vida padrao do decaimento do volume recente: 30 dias.
    /// @dev Valor de sinal (D4), governavel via {setVolumeHalfLife}. Escolha: 30
    ///      dias e uma janela suficientemente longa p/ nao penalizar apps com
    ///      cadencia mensal legitima, e curta o bastante p/ que uma rajada de
    ///      wash evapore em poucos meses (ver parecer §6, correcao D4).
    uint256 private constant DEFAULT_VOLUME_HALF_LIFE = 30 days; // 2_592_000 s

    /// @notice Teto de meias-vidas consideradas no decaimento antes de zerar.
    /// @dev Apos MAX_DECAY_HALF_LIVES meias-vidas o fator (1/2)^n < 1/2^64 e o
    ///      volume recente e tratado como ~0 (evaporou). Cap p/ limitar o loop
    ///      de gas a no maximo 64 iteracoes de shift; qualquer sinal de wash em
    ///      rajada some muito antes disso.
    uint256 private constant MAX_DECAY_HALF_LIVES = 64;

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
    /// @dev So conta pagamentos qualificados (nao-self). Ver {pay} (guarda D1) e
    ///      o parecer audit/economist/2026-07-10-wash-signal-integrity.md.
    mapping(uint256 projectId => uint256) public grossVolumeOf;

    /// @notice Numero de pagadores DISTINTOS por projeto (metrica de sinal honesto).
    /// @dev So conta pagadores nao-self. E este o numero que a UI e qualquer
    ///      automacao devem ler no lugar da soma bruta grossVolumeOf, pois um
    ///      loop de dois enderecos (wash) nao o move. Ver parecer 2026-07-10.
    mapping(uint256 projectId => uint256) public uniquePayersOf;

    /// @notice Marca se um endereco ja pagou (qualificado) um projeto.
    /// @dev Usado p/ incrementar uniquePayersOf so na primeira vez do pagador.
    mapping(uint256 projectId => mapping(address payer => bool)) public hasPaid;

    /// @notice Volume "recente" com decaimento (D4): valor JA decaido ate
    ///         {_recentVolumeUpdatedAt}. Nao e a soma bruta eterna — esse acumulador
    ///         esquece o passado com meia-vida {volumeHalfLife}.
    /// @dev So conta pagamentos qualificados (nao-self), como grossVolumeOf. E este
    ///      o numero que a UI/automacao passam a ler p/ fins de sinal/automacao (ver
    ///      {recentVolumeOf} e o parecer §6, correcao D4). Nao usar p/ auditoria/
    ///      historico — p/ isso ha grossVolumeOf, que nao evapora.
    mapping(uint256 projectId => uint256) private _recentVolume;

    /// @notice Timestamp do ultimo update de {_recentVolume} por projeto.
    mapping(uint256 projectId => uint64) private _recentVolumeUpdatedAt;

    /// @notice Meia-vida do decaimento do volume recente, em SEGUNDOS (governavel).
    /// @dev Default DEFAULT_VOLUME_HALF_LIFE (30 dias). Ver {setVolumeHalfLife}.
    uint256 public volumeHalfLife;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Pagamento processado, com detalhamento completo.
    /// @dev `selfPayment` = o pagador e o owner OU o appRecipient do projeto.
    ///      Nesse caso o split de valor ocorre normalmente (conservacao intacta),
    ///      mas os contadores de sinal (grossVolumeOf, uniquePayersOf) NAO sao
    ///      creditados — pagar a si mesmo nao e sinal de tracao. Campo adicionado
    ///      no FIM p/ nao mexer na ordem/posicao dos parametros indexados
    ///      existentes. Ver audit/economist/2026-07-10-wash-signal-integrity.md.
    event PaymentRouted(
        uint256 indexed projectId,
        address indexed payer,
        uint256 amount,
        uint256 feeToTreasury,
        uint256 feeToBuyback,
        uint256 feeToGrants,
        uint256 revShare,
        uint256 toApp,
        bool selfPayment
    );
    event FeeUpdated(uint16 previousBps, uint16 currentBps);
    event FeeSplitUpdated(uint16 treasuryBps, uint16 buybackBps, uint16 grantsBps);
    event RecipientsUpdated(address treasury, address buyback, address grants);
    event AppRecipientUpdated(uint256 indexed projectId, address recipient);
    event VolumeHalfLifeUpdated(uint256 previous, uint256 current);

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
        volumeHalfLife = DEFAULT_VOLUME_HALF_LIFE;

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
     *
     *      Guarda anti-self-payment (D1): quando o pagador e o proprio
     *      appRecipient OU o owner do projeto, o pagamento e marcado como
     *      self-payment. O split de valor (fee/rev-share/app) ocorre
     *      NORMALMENTE — conservacao intacta, nada e revertido, pois um app
     *      pode ter motivo legitimo raro de consumir a si mesmo — mas os
     *      CONTADORES DE SINAL (grossVolumeOf, uniquePayersOf) NAO sao
     *      creditados: pagar a si mesmo nao e prova de tracao e, se contado,
     *      falsificaria GMV/pagadores por 2,5%/ciclo (wash-payment). Escolha de
     *      desenho: ignorar (nao reverter) em vez de bloquear; o custo e apenas
     *      um app com fluxo proprio legitimo perder aquele registro de sinal —
     *      aceitavel, pois self-payment nunca deveria contar como sinal.
     *      Ver audit/economist/2026-07-10-wash-signal-integrity.md (D1/D2).
     */
    function pay(uint256 projectId, uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (!REGISTRY.isActive(projectId)) {
            revert ProjectNotActive(projectId);
        }

        // ---- resolve o appRecipient e o owner ANTES da reparticao (guarda D1).
        //      appRecipient tem fallback para o owner do Registry.
        address projectOwner = REGISTRY.getProject(projectId).owner;
        address appRecipient = appRecipientOf[projectId];
        if (appRecipient == address(0)) {
            appRecipient = projectOwner;
        }

        // ---- self-payment: pagador coincide com o destino do proprio app.
        //      So afeta os contadores de sinal; o split de valor e igual.
        bool selfPayment = (msg.sender == appRecipient || msg.sender == projectOwner);

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

        CREDIT.safeTransfer(appRecipient, toApp);

        // ---- contadores de sinal: so pagamentos qualificados (nao-self) contam.
        if (!selfPayment) {
            grossVolumeOf[projectId] += amount;
            // pagador unico (D2): incrementa so na primeira vez daquele endereco.
            if (!hasPaid[projectId][msg.sender]) {
                hasPaid[projectId][msg.sender] = true;
                uniquePayersOf[projectId] += 1;
            }
            // volume recente com decaimento (D4): decai o acumulado ate agora,
            // soma o amount e regrava o timestamp. E este numero (via
            // {recentVolumeOf}) que a UI/automacao leem — wash em rajada evapora.
            _recentVolume[projectId] = _decayedVolume(projectId) + amount;
            _recentVolumeUpdatedAt[projectId] = uint64(block.timestamp);
        }

        emit PaymentRouted(
            projectId, msg.sender, amount, toTreasury, toBuyback, toGrants, revShare, toApp, selfPayment
        );
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

    /// @notice Ajusta a meia-vida do decaimento do volume recente (D4).
    /// @dev Rejeita 0 (evita divisao por zero / decaimento infinito). O novo valor
    ///      so afeta decaimentos FUTUROS: o {_recentVolume} ja gravado permanece,
    ///      e passa a decair na nova cadencia a partir do proximo {_decayedVolume}.
    ///      Espelha o padrao dos demais setters (setFeeBps etc).
    function setVolumeHalfLife(uint256 newHalfLifeSeconds) external onlyRole(GOVERNANCE_ROLE) {
        if (newHalfLifeSeconds == 0) {
            revert ZeroHalfLife();
        }
        emit VolumeHalfLifeUpdated(volumeHalfLife, newHalfLifeSeconds);
        volumeHalfLife = newHalfLifeSeconds;
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
    // Volume recente com decaimento (D4)
    // ------------------------------------------------------------------

    /**
     * @notice Volume "recente" do projeto, com decaimento por meia-vida.
     * @dev E ESTE o numero que a UI e qualquer automacao devem ler p/ fins de
     *      sinal/tracao — substitui {grossVolumeOf} nesse papel (parecer §6, D4).
     *      {grossVolumeOf} continua sendo a soma bruta eterna, so p/ auditoria/
     *      historico. Aqui, o volume ESQUECE o passado: sem novos pagamentos,
     *      decai a ~metade a cada {volumeHalfLife} segundos, de modo que (a) uma
     *      rajada de wash evapora e (b) automacao indexada a volume nao e
     *      drenavel por volume falso historico. Monotonicamente nao-crescente no
     *      tempo decorrido; nunca reverte.
     */
    function recentVolumeOf(uint256 projectId) external view returns (uint256) {
        return _decayedVolume(projectId);
    }

    /**
     * @notice Aplica o decaimento exponencial ao {_recentVolume} do projeto.
     * @dev Aproximacao SEM floats: decaimento por meias-vidas INTEIRAS (cada uma
     *      divide por 2 via shift) + interpolacao LINEAR no resto fracionario da
     *      ultima meia-vida. Formalmente, com elapsed = q*H + r (q inteiro,
     *      0 <= r < H):
     *          exato:   v * 2^-(q + r/H)
     *          usado:   (v >> q) * (1 - (r/H)/2)   == (v >> q) * (2H - r) / (2H)
     *      i.e. dentro de uma meia-vida a curva 2^-x (convexa) e aproximada pela
     *      reta secante entre x=0 (fator 1) e x=1 (fator 1/2).
     *
     *      ERRO MAXIMO: a secante superestima 2^-x; o desvio maximo ocorre em
     *      x ~ 0,5 (meia meia-vida), onde 2^-0.5 = 0,7071 vs. reta 0,75 →
     *      +0,0429 absoluto, ~+6,1% relativo. E um vies de super-estimacao
     *      LIMITADO e transitorio dentro de cada meia-vida; e um SINAL, nao um
     *      valor financeiro. Monotonico: nao-crescente em elapsed (o produto
     *      (v>>q)*(2H-r)/(2H) so cai enquanto r cresce, e ao virar a meia-vida
     *      q incrementa e r zera sem salto p/ cima). Cap em MAX_DECAY_HALF_LIVES:
     *      alem disso o fator < 2^-64 e retornamos 0 (evaporou).
     *
     *      Overflow: v <= soma de amounts (nunca acima de grossVolumeOf); os
     *      unicos produtos sao (v>>q) * (2H - r) com (2H - r) <= 2H <= 2*halfLife.
     *      halfLife e um parametro de governanca sensato (segundos); em pratica
     *      (v>>q) e pequeno quando q>0. Ainda assim a multiplicacao e CHECKED
     *      (sem unchecked) — reverteria em overflow em vez de silenciar, mas isso
     *      exigiria v e halfLife absurdamente grandes simultaneamente.
     */
    function _decayedVolume(uint256 projectId) internal view returns (uint256) {
        uint256 v = _recentVolume[projectId];
        // v==0 e block.timestamp<=updatedAt caem naturalmente no calculo abaixo
        // (0 decai p/ 0; elapsed==0 nao decai) — sem guardas de igualdade estrita.

        uint256 updatedAt = _recentVolumeUpdatedAt[projectId];
        // Guarda defensiva contra timestamp nao-monotonico: nunca subtrai negativo.
        if (block.timestamp < updatedAt) {
            return v;
        }

        uint256 elapsed = block.timestamp - updatedAt;
        uint256 halfLife = volumeHalfLife; // > 0 por invariante (constructor/setter)

        uint256 wholeHalfLives = elapsed / halfLife;
        if (wholeHalfLives >= MAX_DECAY_HALF_LIVES) {
            return 0; // fator < 2^-64: evaporou
        }

        // meias-vidas inteiras: divide por 2 a cada uma.
        v >>= wholeHalfLives;

        // resto fracionario: interpolacao linear entre fator 1 e fator 1/2.
        // fator = (2H - r) / (2H), com r = tempo dentro da meia-vida corrente.
        // r calculado por subtracao (nao modulo) — evita falso-positivo de PRNG.
        uint256 remainder = elapsed - wholeHalfLives * halfLife;
        if (remainder > 0) {
            uint256 twoH = halfLife * 2;
            v = (v * (twoH - remainder)) / twoH;
        }

        return v;
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
