// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CreditToken} from "./CreditToken.sol";
import {ProjectRegistry} from "./ProjectRegistry.sol";

/**
 * @title BurnTracker
 * @notice "Oracle interna" do modelo economico: contabiliza on-chain o burn de
 *         `CreditToken` (CREDIT) por `projectId` e por rodada, servindo como
 *         fonte unica da verdade para o futuro `RewardDistributor` (fase 4).
 *         Todo consumo de CREDIT dentro da plataforma passa por aqui via
 *         {burnAndRecord} — atomicamente a funcao queima o CREDIT do usuario
 *         (usando `BURNER_ROLE` do CreditToken) e grava o burn no par
 *         (round, projectId), mantendo tambem o total global da rodada e a
 *         contagem de projetos com burn (`projectsWithBurnCount`).
 * @dev Desenho — por que on-chain atomico (caminho "c") e nao event listener?
 *      Alternativas consideradas:
 *        (a) Apps queimam CREDIT direto e um indexer off-chain ouve o evento
 *            `Transfer(to=address(0))` para imputar burn a projeto.
 *            -> Rejeitada: depende de indexer confiavel, nao ha prova
 *               criptografica on-chain de "qual projeto consumiu este burn",
 *               e abre janela entre burn e record para race-conditions que
 *               o RewardDistributor nao consegue resolver deterministicamente.
 *        (b) Apps registram burn sem queimar e confiamos no app.
 *            -> Rejeitada: double-spend trivial (registrar burn sem queimar
 *               CREDIT inflacionaria reward sem deflacao).
 *        (c) Apps chamam `BurnTracker.burnAndRecord(projectId, from, amount)`
 *            atomicamente; o BurnTracker detem `BURNER_ROLE` no CreditToken e
 *            queima via `burnByRole` sem allowance. <-- Adotada.
 *      Como CreditToken.burnByRole NAO tem callback para o usuario `from`
 *      (apenas um `_burn` nativo ERC-20), o risco de reentrancia real e
 *      ZERO no nosso pipeline. Ainda assim aplicamos `nonReentrant` em
 *      {burnAndRecord} como defesa-em-profundidade: recorders sao terceiros
 *      (apps listados) e nao controlamos o bytecode deles. Um recorder
 *      malicioso nao consegue reentrar em `burnAndRecord` via `burnByRole`,
 *      mas se um dia adicionarmos hook / callback em outra via, o guard
 *      evita regressao silenciosa.
 *
 *      Invariantes atendidas nesta unidade:
 *       - I2 (burn no consumo): CREDIT e queimado via `_burn` nativo no
 *         CreditToken; `totalSupply` decrementa em exatamente `amount` a
 *         cada `burnAndRecord`. Teste integrado valida o decremento.
 *       - I3 (cap por rodada) — na dimensao CREDIT *queimado*, aplicamos um
 *         sanity cap por (round, projectId) via `maxBurnPerRoundPerProject`.
 *         NAO e o cap de mint (isso vive no futuro RewardDistributor); aqui
 *         evitamos wash-burn catastrofico: um projeto malicioso queimando
 *         10^30 CREDIT num unico tx para capturar share desproporcional
 *         dentro da rodada. Cap == 0 desliga o gating (opt-out explicito
 *         via governanca).
 *       - I4 (governanca via Timelock): {closeRound}, {setRoundDuration} e
 *         {setMaxBurnPerRoundPerProject} sao `onlyRole(GOVERNANCE_ROLE)`;
 *         `GOVERNANCE_ROLE` e concedida ao `TimelockController` em producao.
 *       - I7 (listagem via governanca): projetos so sao `Active` no Registry
 *         apos proposta aprovada no Governor + delay do Timelock;
 *         `burnAndRecord` le `Registry.isActive(projectId)` e reverte com
 *         `ProjectNotActive` caso contrario (Pending, Probation ou Removed).
 *         Decisao consciente: se um projeto vira Probation/Removed DEPOIS de
 *         ja ter queimado na rodada atual, o burn ja registrado nao e
 *         revertido — historia e historia e a matematica da rodada deve
 *         permanecer consistente. Apenas novos burns sao bloqueados.
 *
 *      Politica de close de rodada:
 *       - {closeRound} e `onlyRole(GOVERNANCE_ROLE)` — nunca permission-less.
 *         Motivacao: evitar race/captura onde qualquer um poderia fechar no
 *         instante mais favoravel a um projeto especifico. Governanca decide
 *         quando fechar, dentro ou fora do `roundDuration`.
 *       - Fechar antes do `roundDuration` e permitido (emergencia) e marcado
 *         no evento `RoundClosed.earlyClose = true`. Fechar depois do
 *         `roundDuration` e o fluxo normal, marcado com `earlyClose = false`.
 *       - Nao ha "abrir rodada" — round 0 comeca no constructor; cada
 *         closeRound incrementa e reinicia implicitamente (roundStartedAt
 *         passa a ser `block.timestamp`).
 *
 *      O BurnTracker NAO chama o RewardDistributor ao fechar. Distributor
 *      consome em pull, lendo as views deste contrato (arquitetura v1:
 *      pull-based claim). Evita acoplamento ciclico e falha de um lado
 *      travando o outro.
 *
 *      Dependencias pos-deploy (responsabilidade do deploy script da fase 5):
 *       - CreditToken precisa conceder `BURNER_ROLE` a este contrato. Isso
 *         nao e feito no constructor do BurnTracker porque BurnTracker nao
 *         pode self-grant em outro contrato.
 *       - Apps listados recebem `RECORDER_ROLE` via proposta de listing
 *         aprovada no Governor + Timelock (mesmo caminho do registro no
 *         ProjectRegistry).
 * @custom:security-contact security@web3community.example
 */
contract BurnTracker is AccessControl, ReentrancyGuard {
    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Role concedida ao `TimelockController`. Pode fechar rodada,
    ///         ajustar `roundDuration` e `maxBurnPerRoundPerProject`.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    /// @notice Role concedida a cada app listado (via proposta do Governor).
    ///         Autoriza {burnAndRecord}. Revogar a role suspende o app
    ///         imediatamente sem afetar burns passados.
    bytes32 public constant RECORDER_ROLE = keccak256("RECORDER_ROLE");

    // ------------------------------------------------------------------
    // Round duration bounds
    // ------------------------------------------------------------------

    /// @notice Duracao minima permitida de uma rodada (1 dia). Impede que
    ///         governanca configure rodadas micro-curtas que tornariam a
    ///         contabilidade ruidosa demais para rewards.
    // solhint-disable-next-line const-name-snakecase
    uint64 public constant MIN_ROUND_DURATION = 1 days;

    /// @notice Duracao maxima permitida (30 dias). Impede rodadas longas
    ///         demais que atrasariam emissao de rewards e criariam dead
    ///         weight no orcamento.
    // solhint-disable-next-line const-name-snakecase
    uint64 public constant MAX_ROUND_DURATION = 30 days;

    // ------------------------------------------------------------------
    // Immutable dependencies
    // ------------------------------------------------------------------

    /// @notice Token de credito cujo burn e rastreado.
    // solhint-disable-next-line var-name-mixedcase
    CreditToken public immutable CREDIT_TOKEN;

    /// @notice Registry consultado para validar status de projeto (Active).
    // solhint-disable-next-line var-name-mixedcase
    ProjectRegistry public immutable REGISTRY;

    // ------------------------------------------------------------------
    // Round state
    // ------------------------------------------------------------------

    /// @notice Identificador da rodada atual. Comeca em 0 no constructor;
    ///         incrementa em cada {closeRound}.
    uint256 public currentRound;

    /// @notice Timestamp (segundos) em que a rodada atual comecou. Setado
    ///         no constructor e em cada {closeRound}.
    uint64 public roundStartedAt;

    /// @notice Duracao alvo da rodada atual (segundos). Governance-tunable
    ///         via {setRoundDuration}. Alteracoes afetam a rodada atual para
    ///         fins de {getRoundEndsAt}/{isRoundReadyToClose}, mas o
    ///         controle efetivo de close esta em {closeRound} (governanca
    ///         decide).
    uint64 public roundDuration;

    /// @notice Teto de CREDIT queimavel por (round, projectId). Governance-
    ///         tunable. `0` = opt-out (sem limite). Default economico:
    ///         algo como 10M * 1e18, mas o constructor aceita qualquer
    ///         valor para permitir testes locais com caps pequenos.
    uint256 public maxBurnPerRoundPerProject;

    // ------------------------------------------------------------------
    // Accounting
    // ------------------------------------------------------------------

    /// @notice Soma total de CREDIT queimada no `round`.
    mapping(uint256 round => uint256) public totalBurnByRound;

    /// @notice CREDIT queimado no `round` atribuido a `projectId`.
    mapping(uint256 round => mapping(uint256 projectId => uint256)) public burnByRoundProject;

    /// @notice Quantos projetos DISTINTOS tiveram pelo menos 1 burn no `round`.
    ///         Incrementado apenas na primeira gravacao do projeto na rodada.
    ///         RewardDistributor usa isso para detectar "rodada sem burn" (=> 0
    ///         emissao) sem iterar.
    mapping(uint256 round => uint256) public projectsWithBurnCount;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido em cada {burnAndRecord} bem-sucedido.
    /// @param round Rodada em que o burn foi registrado.
    /// @param projectId Projeto ao qual o burn foi atribuido.
    /// @param from Usuario que teve CREDIT queimado.
    /// @param amount Quantidade queimada nesta chamada.
    /// @param newTotalForProject Total acumulado do projeto na rodada apos
    ///                           este burn (conveniencia para indexers).
    event BurnRecorded(
        uint256 indexed round,
        uint256 indexed projectId,
        address indexed from,
        uint256 amount,
        uint256 newTotalForProject
    );

    /// @notice Emitido em {closeRound}.
    /// @param round Rodada que acabou de fechar (valor anterior de `currentRound`).
    /// @param totalBurn Total de CREDIT queimado na rodada fechada.
    /// @param projectsCount Numero de projetos distintos com burn na rodada.
    /// @param closedAt Timestamp (seg) em que a rodada foi fechada.
    /// @param earlyClose `true` se a rodada foi fechada antes de atingir
    ///                   `roundDuration`; `false` caso contrario.
    event RoundClosed(
        uint256 indexed round,
        uint256 totalBurn,
        uint256 projectsCount,
        uint64 closedAt,
        bool earlyClose
    );

    /// @notice Emitido em {setRoundDuration}.
    event RoundDurationUpdated(uint64 oldDuration, uint64 newDuration);

    /// @notice Emitido em {setMaxBurnPerRoundPerProject}.
    event MaxBurnPerRoundPerProjectUpdated(uint256 oldMax, uint256 newMax);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Valor zero nao e permitido em operacoes que exigem > 0.
    error ZeroAmount();

    /// @notice Projeto nao esta em status `Active` (cobre Pending, Probation,
    ///         Removed e inexistente).
    /// @param projectId Projeto consultado.
    error ProjectNotActive(uint256 projectId);

    /// @notice Sanity cap por (round, projectId) seria ultrapassado.
    /// @param projectId Projeto em questao.
    /// @param attempted Total acumulado apos este burn (accumulated + amount).
    /// @param cap `maxBurnPerRoundPerProject` vigente.
    error SanityCapExceeded(uint256 projectId, uint256 attempted, uint256 cap);

    /// @notice `roundDuration` fora da faixa [`MIN_ROUND_DURATION`,
    ///         `MAX_ROUND_DURATION`].
    /// @param provided Valor tentado.
    /// @param min Limite inferior permitido.
    /// @param max Limite superior permitido.
    error InvalidRoundDuration(uint64 provided, uint64 min, uint64 max);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o tracker apontando para CREDIT e Registry. Round 0 comeca
     *         agora (`roundStartedAt = block.timestamp`).
     * @dev Concede `DEFAULT_ADMIN_ROLE` e `GOVERNANCE_ROLE` a `admin`. Em
     *      producao, `admin` e inicialmente o deployer e o deploy script
     *      transfere `GOVERNANCE_ROLE` ao TimelockController e renuncia
     *      (invariante I4). BURNER_ROLE no CREDIT e RECORDER_ROLE nos apps
     *      sao concedidos fora do constructor (pos-deploy).
     *      Valida:
     *       - `admin`, `creditToken`, `registry` != address(0)
     *       - `initialRoundDuration` em [`MIN_ROUND_DURATION`,
     *         `MAX_ROUND_DURATION`]
     *      `initialSanityCap == 0` e explicitamente aceito (sem limite).
     * @param admin Endereco que recebe admin e governance inicial.
     * @param creditToken Endereco do `CreditToken`.
     * @param registry Endereco do `ProjectRegistry`.
     * @param initialRoundDuration Duracao inicial da rodada (seg).
     * @param initialSanityCap Cap inicial por (round, project). 0 = sem limite.
     */
    constructor(
        address admin,
        address creditToken,
        address registry,
        uint64 initialRoundDuration,
        uint256 initialSanityCap
    ) {
        if (admin == address(0) || creditToken == address(0) || registry == address(0)) {
            revert ZeroAddress();
        }
        if (initialRoundDuration < MIN_ROUND_DURATION || initialRoundDuration > MAX_ROUND_DURATION) {
            revert InvalidRoundDuration(initialRoundDuration, MIN_ROUND_DURATION, MAX_ROUND_DURATION);
        }

        CREDIT_TOKEN = CreditToken(creditToken);
        REGISTRY = ProjectRegistry(registry);

        roundDuration = initialRoundDuration;
        maxBurnPerRoundPerProject = initialSanityCap;
        roundStartedAt = uint64(block.timestamp);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Core — state-changing
    // ------------------------------------------------------------------

    /**
     * @notice Queima `amount` de CREDIT do saldo de `from` e registra o burn
     *         no par (rodada atual, `projectId`) atomicamente. Chamado por
     *         cada app (portador de `RECORDER_ROLE`) quando o usuario consome
     *         um servico pago.
     * @dev Fluxo (Checks → Effects → Interactions):
     *        1. Checks:
     *           - `RECORDER_ROLE` (modifier).
     *           - `projectId` Active no Registry.
     *           - `from != address(0)`.
     *           - `amount > 0`.
     *           - Sanity cap: `accumulated + amount <= cap` (se cap > 0).
     *        2. Effects:
     *           - `burnByRoundProject[round][projectId] += amount`.
     *           - `totalBurnByRound[round] += amount`.
     *           - `projectsWithBurnCount[round]` += 1 SE este for o primeiro
     *             burn do projeto na rodada (accumulated era 0).
     *        3. Interactions:
     *           - `CreditToken.burnByRole(from, amount, tag)`.
     *      **Por que effects antes do burn?** O padrao CEI classico pede
     *      effects-antes-interactions para blindar contra reentrancia. Como
     *      `burnByRole` e do nosso proprio CreditToken e usa `_burn` nativo
     *      sem callback, nao ha vetor de reentrancia real — mas seguir CEI
     *      mantem consistencia com o restante do codebase e blinda contra
     *      regressoes futuras. Se o burn reverter (ex.: saldo insuficiente),
     *      toda a tx reverte e nenhum estado persiste — state-machine
     *      consistente.
     *      `nonReentrant` aplicado como defesa-em-profundidade (recorders
     *      sao apps terceiros, nao controlamos o bytecode deles).
     *      O parametro `tag` enviado ao CreditToken.burnByRole e fixado em
     *      `"burnTracker"` para auditabilidade off-chain do event log do
     *      CREDIT — o tag rico (projeto, round) ja e coberto pelo evento
     *      `BurnRecorded` deste contrato.
     * @param projectId Projeto ao qual atribuir o burn (deve estar Active).
     * @param from Usuario cujo CREDIT sera queimado.
     * @param amount Quantidade de CREDIT a queimar (> 0).
     */
    function burnAndRecord(
        uint256 projectId,
        address from,
        uint256 amount
    ) external onlyRole(RECORDER_ROLE) nonReentrant {
        if (from == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (!REGISTRY.isActive(projectId)) {
            revert ProjectNotActive(projectId);
        }

        uint256 round = currentRound;
        uint256 accumulated = burnByRoundProject[round][projectId];

        uint256 cap = maxBurnPerRoundPerProject;
        uint256 newTotalForProject = accumulated + amount;
        if (cap != 0 && newTotalForProject > cap) {
            revert SanityCapExceeded(projectId, newTotalForProject, cap);
        }

        // Effects.
        burnByRoundProject[round][projectId] = newTotalForProject;
        totalBurnByRound[round] += amount;
        if (accumulated == 0) {
            // Primeiro burn deste projeto na rodada — conta o projeto.
            unchecked {
                // Bound: <= numero de projetos no Registry. Nunca overflow.
                projectsWithBurnCount[round] = projectsWithBurnCount[round] + 1;
            }
        }

        emit BurnRecorded(round, projectId, from, amount, newTotalForProject);

        // Interaction: queima o CREDIT. Reverte se saldo insuficiente (ERC-20)
        // ou se o tracker perder BURNER_ROLE (AccessControl).
        CREDIT_TOKEN.burnByRole(from, amount, "burnTracker");
    }

    /**
     * @notice Fecha a rodada atual e abre a proxima. Incrementa
     *         `currentRound`, reseta `roundStartedAt = block.timestamp`.
     *         Accounting das rodadas fechadas e preservado on-chain
     *         indefinidamente (cada rodada tem seu proprio indice nos
     *         mappings).
     * @dev Restrita a `GOVERNANCE_ROLE` (Timelock em producao).
     *      Pode ser chamada a qualquer momento:
     *       - Se `block.timestamp >= roundStartedAt + roundDuration`,
     *         emite `RoundClosed` com `earlyClose = false` (fluxo normal).
     *       - Caso contrario, emite com `earlyClose = true` (emergencia /
     *         decisao governamental antecipada).
     *      Nao chama RewardDistributor — Distributor consome em pull via
     *      `getTotalBurnForRound` / `getBurnForProjectInRound` quando o
     *      proximo batch de rewards for executado.
     *      Empty round (sem nenhum burn) e permitido: o evento sai com
     *      totalBurn=0 e projectsCount=0; documenta explicitamente que
     *      rodada correu sem consumo.
     */
    function closeRound() external onlyRole(GOVERNANCE_ROLE) {
        uint256 round = currentRound;
        uint64 nowTs = uint64(block.timestamp);
        uint64 endsAt = roundStartedAt + roundDuration;
        bool earlyClose = nowTs < endsAt;

        uint256 totalBurn = totalBurnByRound[round];
        uint256 projectsCount = projectsWithBurnCount[round];

        // Effects.
        unchecked {
            // `currentRound` e uint256 — overflow teorico apos 2^256 rodadas.
            // Irrealista: 2^256 segundos >> idade do universo.
            currentRound = round + 1;
        }
        roundStartedAt = nowTs;

        emit RoundClosed(round, totalBurn, projectsCount, nowTs, earlyClose);
    }

    /**
     * @notice Atualiza a duracao alvo da rodada. Deve estar em
     *         [`MIN_ROUND_DURATION`, `MAX_ROUND_DURATION`].
     * @dev Restrita a `GOVERNANCE_ROLE`. A mudanca afeta a rodada atual
     *      para os views {getRoundEndsAt}/{isRoundReadyToClose} (e portanto
     *      quando a rodada sera considerada "pronta pra fechar" pelo
     *      proximo call de {closeRound}) — nao altera accounting de
     *      rodadas ja fechadas.
     * @param newDuration Nova duracao em segundos.
     */
    function setRoundDuration(uint64 newDuration) external onlyRole(GOVERNANCE_ROLE) {
        if (newDuration < MIN_ROUND_DURATION || newDuration > MAX_ROUND_DURATION) {
            revert InvalidRoundDuration(newDuration, MIN_ROUND_DURATION, MAX_ROUND_DURATION);
        }
        uint64 old = roundDuration;
        roundDuration = newDuration;
        emit RoundDurationUpdated(old, newDuration);
    }

    /**
     * @notice Atualiza o sanity cap por (round, project).
     * @dev Restrita a `GOVERNANCE_ROLE`. `0` desativa o limite (opt-out).
     *      A checagem em {burnAndRecord} usa o valor vigente no momento do
     *      burn — nao e retroativa. Se o cap for reduzido abaixo do
     *      acumulado atual de algum projeto, novos burns nesse projeto
     *      naquela rodada sao bloqueados imediatamente, mas o acumulado
     *      ja registrado permanece (historia preservada).
     * @param newMax Novo cap (wei). 0 = sem limite.
     */
    function setMaxBurnPerRoundPerProject(uint256 newMax) external onlyRole(GOVERNANCE_ROLE) {
        uint256 old = maxBurnPerRoundPerProject;
        maxBurnPerRoundPerProject = newMax;
        emit MaxBurnPerRoundPerProjectUpdated(old, newMax);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Sinonimo de `currentRound` (ergonomia de API — Distributor
    ///         pode preferir um getter nomeado).
    function getCurrentRound() external view returns (uint256) {
        return currentRound;
    }

    /// @notice Timestamp (seg) em que a rodada atual "termina" conforme a
    ///         duracao vigente. Uso consultivo; o close efetivo acontece
    ///         em {closeRound}.
    function getRoundEndsAt() external view returns (uint64) {
        return roundStartedAt + roundDuration;
    }

    /// @notice `true` se a rodada atual ja atingiu ou passou da sua
    ///         duracao alvo (pronta para close normal).
    function isRoundReadyToClose() external view returns (bool) {
        return block.timestamp >= uint256(roundStartedAt) + uint256(roundDuration);
    }

    /// @notice Valor de `burnByRoundProject[round][projectId]` — wrapper
    ///         explicito para callers que preferem uma API nomeada.
    function getBurnForProjectInRound(uint256 round, uint256 projectId) external view returns (uint256) {
        return burnByRoundProject[round][projectId];
    }

    /// @notice Valor de `totalBurnByRound[round]` — wrapper nomeado.
    function getTotalBurnForRound(uint256 round) external view returns (uint256) {
        return totalBurnByRound[round];
    }
}
