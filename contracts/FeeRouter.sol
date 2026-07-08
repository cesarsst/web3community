// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CreditToken} from "./CreditToken.sol";
import {BurnTracker} from "./BurnTracker.sol";
import {ProjectRegistry} from "./ProjectRegistry.sol";
import {Treasury} from "./Treasury.sol";

/**
 * @title FeeRouter
 * @notice Interface unica de pagamento entre apps do ecossistema e o protocolo.
 *         Todo consumo de CREDIT feito por usuarios finais dentro de um app
 *         listado passa por {pay}, que divide o valor em 3 destinos conforme
 *         split configuravel:
 *          1. `burnBps` e queimado via {BurnTracker.burnAndRecord} —
 *             alimenta a metrica de burn por projeto usada pelo
 *             `RewardDistributor` na proxima rodada.
 *          2. `treasuryBps` e transferido ao `Treasury` multi-ativo da DAO.
 *          3. `rebateBps` e transferido ao `appRecipient` do projeto (rebate
 *             de revenue share para o app).
 *         O split default global seedado nos deploys e 70/20/10 (70% burn /
 *         20% treasury / 10% app — ver ignition/parameters/*.json); o valor
 *         e parametro do constructor. Splits podem ser substituidos
 *         por-projeto via governanca (`setProjectSplit`), e o recipient de
 *         rebate por-projeto e setavel pelo owner (`setAppRecipient`).
 * @dev Invariantes economicas atendidas nesta unidade:
 *      - I2 (burn no consumo): toda chamada {pay} que tenha `burnBps > 0`
 *        atomicamente queima a fatia via {BurnTracker.burnAndRecord}, que
 *        por sua vez chama {CreditToken.burnByRole} (_burn nativo, decrementa
 *        totalSupply). Nenhum caminho de {pay} desvia CREDIT queimado para
 *        dead-address, tesouraria ou re-mint.
 *      - I4 (governanca via Timelock): setters economicos (`setDefaultSplit`,
 *        `setProjectSplit`, `clearProjectSplit`) sao `onlyRole(GOVERNANCE_ROLE)`;
 *        em producao `GOVERNANCE_ROLE` e concedida exclusivamente ao
 *        `TimelockController`. `DEFAULT_ADMIN_ROLE` existe apenas para
 *        conceder/revogar roles (padrao OZ AccessControl); o deploy script
 *        transfere ambos ao Timelock e renuncia. {setAppRecipient} e
 *        owner-gated (analogo ao {updateMetadata} do Registry) porque
 *        rotacao do endereco de rebate e operacional e nao justifica ciclo
 *        completo de proposta/voto.
 *      - I7 (projetos via Registry): {pay} revalida `REGISTRY.isActive` cedo
 *        e reverte com {ProjectNotActive} em qualquer status != Active
 *        (Pending, Probation punitiva, Removed, inexistente). Dupla
 *        validacao com o {BurnTracker.burnAndRecord} — intencional:
 *        permite que treasury e rebate tambem sejam bloqueados sem depender
 *        do burn ser > 0.
 *
 *      Desenho deliberado:
 *      - {pay} e PUBLICA. Quem chama e irrelevante desde que `user` tenha
 *        aprovado o FeeRouter previamente. Isso habilita UX flexivel:
 *        apps podem chamar em nome do usuario (meta-tx-like com approve
 *        previo), smart wallets podem chamar direto, UIs podem chamar
 *        diretamente, etc. O payer economico e SEMPRE `user` (puxado via
 *        `transferFrom`); `msg.sender` e apenas o iniciador da tx.
 *      - Dust handling: o residuo `amount - burned - toTreasury` vai
 *        integralmente para o rebate do app. Isso evita perda de wei por
 *        arredondamento em divisoes nao-exatas (a soma final sempre
 *        reconstitui `amount`). Consequencia: em splits com `burnBps +
 *        treasuryBps + rebateBps == 10_000`, o app pode receber 1-2 wei
 *        a mais que o calculo nominal — aceitavel e auditavel.
 *      - Override por projeto usa FLAG `hasProjectSplit` separada do
 *        struct para distinguir "override nao setado" de "override com
 *        zeros validos". Sem flag, um split `{10000, 0, 0}` seria
 *        ambiguo com "sem override".
 *      - {setAppRecipient} com `address(0)` reseta para lookup dinamico
 *        em `REGISTRY.getProject(projectId).owner`. Consequencia desejada:
 *        se o owner transferir o projeto via Registry, o recipient default
 *        acompanha automaticamente sem exigir re-configuracao manual.
 *      - SEM SWEEP no v1. O FeeRouter nao custodia CREDIT entre chamadas —
 *        cada {pay} e atomico (recebe, distribui, queima e termina com
 *        saldo 0). Se alguma anomalia (ex.: token enviado diretamente por
 *        engano) deixar fundos presos, a remediacao e via upgrade/migration
 *        proposto pelo Governor. Adicionar sweep agora criaria superficie
 *        de centralizacao que a DAO prefere nao ter.
 *
 *      Reentrancia:
 *      - {pay} tem multiplos external calls: `credit.transferFrom` (entrada),
 *        `credit.transfer` (rebate), `credit.transfer` (treasury),
 *        `credit.approve` + `burnTracker.burnAndRecord` (burn). Embora
 *        `CreditToken` seja ERC-20 confiavel sem hooks de callback e o
 *        `BurnTracker.burnAndRecord` seja `nonReentrant`, aplicamos
 *        `nonReentrant` em {pay} como defesa-em-profundidade: protege
 *        contra regressoes futuras (ex.: se um dia CREDIT adicionar
 *        ERC-777-like hooks, ou se {BurnTracker} mudar).
 *      - Pattern CEI: checagens primeiro, depois transfer de entrada,
 *        depois distribuicoes. `approve` + `burnAndRecord` sao executados
 *        POR ULTIMO — qualquer reentrada via `burnAndRecord` encontra
 *        guard ativo e reverte.
 *
 *      Dependencias pos-deploy (responsabilidade do deploy script da fase 5):
 *       - {BurnTracker.grantRole(RECORDER_ROLE, feeRouter)} — sem isso,
 *         {pay} reverte em qualquer chamada com `burnBps > 0`. Essa role e
 *         concedida via proposta aprovada no Governor + execucao do Timelock.
 *       - Apps documentarem UX de approval: o usuario precisa ter feito
 *         `CREDIT.approve(feeRouter, amount)` antes de {pay} ser chamado.
 * @custom:security-contact security@web3community.example
 */
contract FeeRouter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Configuracao de split de um pagamento. Os 3 campos sao em
    ///         basis points (1 bp = 0.01%) e devem somar EXATAMENTE 10_000.
    /// @param burnBps Fatia queimada via {BurnTracker.burnAndRecord}.
    /// @param treasuryBps Fatia transferida ao {Treasury}.
    /// @param rebateBps Fatia transferida ao app (`appRecipient`).
    struct Split {
        uint16 burnBps;
        uint16 treasuryBps;
        uint16 rebateBps;
    }

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Role concedida ao `TimelockController` em producao. Unica role
    ///         capaz de ajustar `defaultSplit` e `projectSplit` (overrides).
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    /// @dev Denominador dos basis points. Usado na validacao de soma e nas
    ///      divisoes proporcionais em {pay}/{quote}.
    // solhint-disable-next-line const-name-snakecase
    uint256 private constant _BPS_DENOMINATOR = 10_000;

    // ------------------------------------------------------------------
    // Immutable dependencies
    // ------------------------------------------------------------------

    /// @notice Token de credito movido e queimado nesta rota de fees.
    // solhint-disable-next-line var-name-mixedcase
    CreditToken public immutable CREDIT;

    /// @notice Tracker responsavel por queimar o CREDIT e registrar burn por
    ///         projeto na rodada atual.
    // solhint-disable-next-line var-name-mixedcase
    BurnTracker public immutable BURN_TRACKER;

    /// @notice Registry consultado para validar status (`isActive`) e
    ///         resolver owner default do rebate.
    // solhint-disable-next-line var-name-mixedcase
    ProjectRegistry public immutable REGISTRY;

    /// @notice Cofre multi-ativo que recebe a fatia `treasuryBps` do split.
    // solhint-disable-next-line var-name-mixedcase
    Treasury public immutable TREASURY;

    // ------------------------------------------------------------------
    // Storage — split config
    // ------------------------------------------------------------------

    /// @notice Split global default aplicado a projetos sem override.
    ///         Seed atual dos deploys: 70/20/10 (ignition/parameters/*.json).
    Split public defaultSplit;

    /// @notice Override por-projeto. Use {hasProjectSplit} para saber se
    ///         o override existe (distinguir "nao setado" de "zeros validos").
    mapping(uint256 projectId => Split) public projectSplit;

    /// @notice Flag que sinaliza existencia de override em {projectSplit}.
    ///         Setada em {setProjectSplit}, limpa em {clearProjectSplit}.
    mapping(uint256 projectId => bool) public hasProjectSplit;

    /// @notice Destinatario explicito da fatia de rebate por projeto.
    ///         `address(0)` significa "usar `project.owner` do Registry"
    ///         (lookup dinamico — segue transferencias de ownership).
    mapping(uint256 projectId => address) public appRecipient;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido a cada {pay} bem-sucedido.
    /// @param projectId Projeto ao qual o pagamento foi atribuido.
    /// @param user Usuario economico (de quem o CREDIT saiu via `transferFrom`).
    /// @param payer Iniciador da tx (`msg.sender`).
    /// @param amount Valor total do pagamento (em wei de CREDIT).
    /// @param burned Fatia queimada via BurnTracker.
    /// @param toTreasury Fatia transferida ao Treasury.
    /// @param toApp Fatia transferida ao `appRecipient` efetivo.
    /// @param recipient Endereco que recebeu `toApp` (override ou owner).
    event Paid(
        uint256 indexed projectId,
        address indexed user,
        address indexed payer,
        uint256 amount,
        uint256 burned,
        uint256 toTreasury,
        uint256 toApp,
        address recipient
    );

    /// @notice Emitido em {setDefaultSplit}.
    /// @param oldSplit Split anterior.
    /// @param newSplit Split novo.
    event DefaultSplitUpdated(Split oldSplit, Split newSplit);

    /// @notice Emitido em {setProjectSplit}.
    /// @param projectId Projeto com override.
    /// @param newSplit Split aplicado.
    event ProjectSplitUpdated(uint256 indexed projectId, Split newSplit);

    /// @notice Emitido em {clearProjectSplit}.
    /// @param projectId Projeto cujo override foi removido.
    event ProjectSplitCleared(uint256 indexed projectId);

    /// @notice Emitido em {setAppRecipient}.
    /// @param projectId Projeto cujo recipient foi alterado.
    /// @param oldRecipient Valor anterior (pode ser `address(0)` = lookup dinamico).
    /// @param newRecipient Valor novo (pode ser `address(0)` = resetar para lookup).
    event AppRecipientUpdated(uint256 indexed projectId, address indexed oldRecipient, address indexed newRecipient);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Split informado nao soma 10_000 bps.
    /// @param burnBps Fatia de burn informada.
    /// @param treasuryBps Fatia de treasury informada.
    /// @param rebateBps Fatia de rebate informada.
    /// @param total Soma efetiva (`burnBps + treasuryBps + rebateBps`).
    error InvalidSplit(uint16 burnBps, uint16 treasuryBps, uint16 rebateBps, uint16 total);

    /// @notice Projeto nao esta em status Active (cobre Pending, Probation,
    ///         Removed e inexistente).
    /// @param projectId Projeto consultado.
    error ProjectNotActive(uint256 projectId);

    /// @notice Valor zero nao e permitido em operacoes que exigem > 0.
    error ZeroAmount();

    /// @notice Endereco zero nao e valido onde um endereco real e exigido.
    error ZeroAddress();

    /// @notice {setAppRecipient} chamado por alguem que nao e o owner do projeto.
    /// @param projectId Projeto em questao.
    /// @param caller Quem tentou chamar.
    error NotProjectOwner(uint256 projectId, address caller);

    /// @notice {clearProjectSplit} chamado em projeto sem override registrado.
    /// @param projectId Projeto em questao.
    error NoProjectSplit(uint256 projectId);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o router apontando para dependencias e seta o split default.
     * @dev Concede `DEFAULT_ADMIN_ROLE` e `GOVERNANCE_ROLE` ao `admin`. Em
     *      producao o deploy script transfere ambas ao TimelockController e
     *      renuncia as roles do admin inicial (invariante I4). BURNER_ROLE no
     *      CreditToken nao e concedido aqui — o {BurnTracker} ja detem
     *      essa role, e o FeeRouter interage com CREDIT apenas via
     *      transfer/transferFrom/approve padroes.
     *      Validacoes:
     *       - `admin`, `credit`, `burnTracker`, `registry`, `treasury` != 0.
     *       - `initialDefaultSplit` soma exatamente 10_000 bps.
     *      RECORDER_ROLE no {BurnTracker} (exigida por {pay}) e concedida via
     *      proposta aprovada no Governor + Timelock, apos deploy.
     * @param admin Endereco que recebe admin e governance inicial.
     * @param credit Endereco do {CreditToken}.
     * @param burnTracker Endereco do {BurnTracker}.
     * @param registry Endereco do {ProjectRegistry}.
     * @param treasury Endereco do {Treasury}.
     * @param initialDefaultSplit Split global inicial (soma == 10_000).
     */
    constructor(
        address admin,
        address credit,
        address burnTracker,
        address registry,
        address treasury,
        Split memory initialDefaultSplit
    ) {
        if (
            admin == address(0) ||
            credit == address(0) ||
            burnTracker == address(0) ||
            registry == address(0) ||
            treasury == address(0)
        ) {
            revert ZeroAddress();
        }
        _requireValidSplit(initialDefaultSplit);

        CREDIT = CreditToken(credit);
        BURN_TRACKER = BurnTracker(burnTracker);
        REGISTRY = ProjectRegistry(registry);
        TREASURY = Treasury(payable(treasury));

        defaultSplit = initialDefaultSplit;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Core — pay
    // ------------------------------------------------------------------

    /**
     * @notice Processa um pagamento de `user` no `projectId`, pullando
     *         `amount` de CREDIT via `transferFrom` e dividindo-o conforme
     *         o split efetivo (override do projeto, se existir; caso contrario,
     *         {defaultSplit}).
     * @dev Chamada publica: qualquer endereco pode iniciar, desde que `user`
     *      tenha aprovado ao FeeRouter pelo menos `amount` de CREDIT. O
     *      payer economico e sempre `user`; `msg.sender` so e registrado no
     *      evento {Paid.payer}.
     *      Pipeline (Checks → Effects → Interactions):
     *        1. Checks:
     *           - `user != 0`; `amount > 0`.
     *           - `REGISTRY.isActive(projectId)`.
     *        2. Interactions (entradas):
     *           - `transferFrom(user, this, amount)` — FeeRouter recebe o total.
     *        3. Calcula split (override ou default) e aloca `burned`,
     *           `toTreasury`, `toApp`. O residuo (`amount - burned -
     *           toTreasury`) vai integralmente para `toApp` (dust handling).
     *        4. Interactions (distribuicoes):
     *           - `transfer(recipient, toApp)` se `toApp > 0`.
     *           - `transfer(treasury, toTreasury)` se `toTreasury > 0`.
     *           - `approve(burnTracker, burned)` + `burnAndRecord(projectId,
     *             this, burned)` se `burned > 0` — o BurnTracker chama
     *             `CreditToken.burnByRole` que `_burn`a do FeeRouter.
     *      Reentrancy: modifier `nonReentrant` ativo durante todo o fluxo.
     *      Mesmo que um ERC-20 customizado com callback tentasse reentrar
     *      via `transfer` ou `approve`, o guard reverteria. `BurnTracker`
     *      tem seu proprio `nonReentrant`, cross-contract seguro.
     *      Gas: tipico ~180-220k para um split sem treasury (uma `transferFrom`,
     *      uma `transfer`, uma `approve`, uma chamada ao tracker que faz
     *      `_burn`). Splits que incluem treasury adicionam ~35k.
     * @param projectId Projeto ao qual o pagamento e atribuido. Deve estar Active.
     * @param user Endereco pagador economico. Deve ter aprovado o FeeRouter
     *             em pelo menos `amount` de CREDIT.
     * @param amount Valor a pagar (em wei de CREDIT). Deve ser > 0.
     * @return burned Fatia queimada via BurnTracker.
     * @return toTreasury Fatia transferida ao Treasury.
     * @return toApp Fatia transferida ao `appRecipient` efetivo.
     */
    function pay(
        uint256 projectId,
        address user,
        uint256 amount
    ) external nonReentrant returns (uint256 burned, uint256 toTreasury, uint256 toApp) {
        if (user == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (!REGISTRY.isActive(projectId)) {
            revert ProjectNotActive(projectId);
        }

        Split memory split = _effectiveSplit(projectId);
        address recipient = _effectiveRecipient(projectId);

        burned = (amount * split.burnBps) / _BPS_DENOMINATOR;
        toTreasury = (amount * split.treasuryBps) / _BPS_DENOMINATOR;
        // Dust handling: residuo do truncamento vai para o rebate.
        toApp = amount - burned - toTreasury;

        // Entrada: puxa o valor total do user. Usa SafeERC20 mesmo com CREDIT
        // conhecido — padronizacao com o resto do codebase e tolerancia a
        // eventuais tokens-wrappers futuros.
        IERC20(address(CREDIT)).safeTransferFrom(user, address(this), amount);

        if (toApp > 0) {
            IERC20(address(CREDIT)).safeTransfer(recipient, toApp);
        }
        if (toTreasury > 0) {
            IERC20(address(CREDIT)).safeTransfer(address(TREASURY), toTreasury);
        }
        if (burned > 0) {
            // `forceApprove` garante allowance exata mesmo se algum allowance
            // residual de uma chamada anterior tivesse sobrado (nao deveria,
            // mas e barato e correto).
            IERC20(address(CREDIT)).forceApprove(address(BURN_TRACKER), burned);
            BURN_TRACKER.burnAndRecord(projectId, address(this), burned);
        }

        emit Paid(projectId, user, msg.sender, amount, burned, toTreasury, toApp, recipient);
    }

    // ------------------------------------------------------------------
    // Governance-gated setters
    // ------------------------------------------------------------------

    /**
     * @notice Atualiza o split global default.
     * @dev Restrito a {GOVERNANCE_ROLE}. Reverte com {InvalidSplit} se a soma
     *      nao for exatamente 10_000 bps. A alteracao afeta somente pagamentos
     *      futuros de projetos sem override — overrides existentes permanecem
     *      inalterados.
     * @param newSplit Novo split (`burnBps + treasuryBps + rebateBps == 10_000`).
     */
    function setDefaultSplit(Split calldata newSplit) external onlyRole(GOVERNANCE_ROLE) {
        _requireValidSplit(newSplit);
        Split memory old = defaultSplit;
        defaultSplit = newSplit;
        emit DefaultSplitUpdated(old, newSplit);
    }

    /**
     * @notice Registra/atualiza override de split para `projectId`.
     * @dev Restrito a {GOVERNANCE_ROLE}. Ativa {hasProjectSplit[projectId]} e
     *      passa a aplicar o override em {pay} e {getEffectiveSplit}. Pode ser
     *      chamada em qualquer projectId (ativa ou nao) — o override so surte
     *      efeito quando o projeto estiver Active no momento de {pay}.
     * @param projectId Projeto alvo.
     * @param newSplit Split a aplicar (soma == 10_000).
     */
    function setProjectSplit(uint256 projectId, Split calldata newSplit) external onlyRole(GOVERNANCE_ROLE) {
        _requireValidSplit(newSplit);
        projectSplit[projectId] = newSplit;
        hasProjectSplit[projectId] = true;
        emit ProjectSplitUpdated(projectId, newSplit);
    }

    /**
     * @notice Remove o override de `projectId`, retomando o uso de {defaultSplit}.
     * @dev Restrito a {GOVERNANCE_ROLE}. Reverte com {NoProjectSplit} se nao
     *      houver override (idempotencia explicita — evita emitir evento
     *      espurio).
     * @param projectId Projeto alvo.
     */
    function clearProjectSplit(uint256 projectId) external onlyRole(GOVERNANCE_ROLE) {
        if (!hasProjectSplit[projectId]) {
            revert NoProjectSplit(projectId);
        }
        delete projectSplit[projectId];
        delete hasProjectSplit[projectId];
        emit ProjectSplitCleared(projectId);
    }

    // ------------------------------------------------------------------
    // Owner-gated setter
    // ------------------------------------------------------------------

    /**
     * @notice Registra/atualiza o endereco que recebe a fatia de rebate de
     *         `projectId`. Apenas o owner atual do projeto pode chamar.
     * @dev O owner e lido ao vivo do {ProjectRegistry.getProject} —
     *      `Registry.getProject` reverte com `ProjectNotFound` se o projectId
     *      nao existir, bubbling up naturalmente (nao precisamos replicar
     *      o erro aqui).
     *      Passar `address(0)` reseta para lookup dinamico: {pay} passara a
     *      ler `Registry.getProject(projectId).owner` a cada chamada,
     *      acompanhando transferencias de ownership automaticamente.
     *      Nao valida status do projeto — permite configurar recipient
     *      para um projeto Pending/Probation/Removed sem surpresas (as
     *      chamadas de {pay} ja bloqueiam status invalido independentemente).
     * @param projectId Projeto alvo.
     * @param recipient Novo recipient explicito, ou `address(0)` para voltar
     *                  ao lookup dinamico.
     */
    function setAppRecipient(uint256 projectId, address recipient) external {
        ProjectRegistry.Project memory p = REGISTRY.getProject(projectId);
        if (p.owner != msg.sender) {
            revert NotProjectOwner(projectId, msg.sender);
        }
        address old = appRecipient[projectId];
        appRecipient[projectId] = recipient;
        emit AppRecipientUpdated(projectId, old, recipient);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Retorna o split que seria aplicado a um {pay} em `projectId`
     *         com a configuracao atual.
     * @dev Override tem precedencia sobre {defaultSplit}.
     */
    function getEffectiveSplit(uint256 projectId) external view returns (Split memory) {
        return _effectiveSplit(projectId);
    }

    /**
     * @notice Retorna o endereco que receberia a fatia de rebate em um {pay}
     *         em `projectId` agora.
     * @dev Se {appRecipient}[projectId] estiver setado (!= 0), retorna esse
     *      valor. Caso contrario retorna `Registry.getProject(projectId).owner`
     *      (lookup dinamico). Reverte se o projeto nao existir (bubbles up
     *      de {Registry.getProject}).
     */
    function getEffectiveRecipient(uint256 projectId) external view returns (address) {
        return _effectiveRecipient(projectId);
    }

    /**
     * @notice Calcula (sem side effects) as 3 fatias de um pagamento de
     *         `amount` no `projectId`, usando o split efetivo corrente.
     * @dev Reverte com {ZeroAmount} se `amount == 0` — espelha a validacao
     *      do {pay} para que o caller nao se engane com "preview zero".
     *      NAO valida status do projeto: permite consultas even para projetos
     *      Pending/Probation/Removed (util para UI mostrar o split esperado
     *      antes de listar).
     */
    function quote(
        uint256 projectId,
        uint256 amount
    ) external view returns (uint256 burned, uint256 toTreasury, uint256 toApp) {
        if (amount == 0) {
            revert ZeroAmount();
        }
        Split memory split = _effectiveSplit(projectId);
        burned = (amount * split.burnBps) / _BPS_DENOMINATOR;
        toTreasury = (amount * split.treasuryBps) / _BPS_DENOMINATOR;
        toApp = amount - burned - toTreasury;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * @dev Resolve o split efetivo: override por projeto ou default.
     */
    function _effectiveSplit(uint256 projectId) private view returns (Split memory) {
        if (hasProjectSplit[projectId]) {
            return projectSplit[projectId];
        }
        return defaultSplit;
    }

    /**
     * @dev Resolve o recipient efetivo: override por projeto ou owner do
     *      Registry (lookup dinamico).
     */
    function _effectiveRecipient(uint256 projectId) private view returns (address) {
        address explicitRecipient = appRecipient[projectId];
        if (explicitRecipient != address(0)) {
            return explicitRecipient;
        }
        return REGISTRY.getProject(projectId).owner;
    }

    /**
     * @dev Valida que a soma dos 3 bps e exatamente 10_000. Reverte
     *      com {InvalidSplit} caso contrario.
     */
    function _requireValidSplit(Split memory split) private pure {
        // Soma em uint32 para evitar qualquer risco de overflow do uint16
        // (cada campo sozinho ja cabe em 10_000, mas a soma pode chegar a
        // 30_000 se os 3 forem maximos — ainda cabe em uint16, mas uint32
        // e defensivo e gera codigo mais claro para o static analyzer).
        uint32 total = uint32(split.burnBps) + uint32(split.treasuryBps) + uint32(split.rebateBps);
        if (total != _BPS_DENOMINATOR) {
            revert InvalidSplit(split.burnBps, split.treasuryBps, split.rebateBps, uint16(total));
        }
    }
}
