// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ProjectRegistry
 * @notice Whitelist on-chain de projetos/apps do ecossistema Web3Community. Fonte
 *         unica da verdade para: quem e owner de cada projeto, quanto GOV foi
 *         lockado como colateral (skin in the game), qual o status do projeto
 *         (Pending -> Active -> Probation -> Removed) e qual a metadata off-chain
 *         (IPFS/Arweave URI). Consumido por `Staking`, `ProjectFunding` e
 *         `FeeRouterV2`.
 * @dev Invariantes atendidas nesta unidade:
 *      - I7: Projetos sao adicionados/alterados/removidos apenas pelo
 *        `TimelockController` (portador de `GOVERNANCE_ROLE` em producao).
 *        A unica excecao e {updateMetadata} e {transferProjectOwnership} /
 *        {acceptProjectOwnership} — owner-gated, nao governance.
 *      - Custodia de colateral: Registry detem exatamente a soma dos
 *        colaterais declarados em projetos nao-Removed. Remocao move o valor
 *        para o treasury (slash) ou para o owner (clean).
 *      Desenho deliberado de duas nocoes distintas de "probation":
 *       - Probation por TEMPO (view {isInProbation}): true enquanto
 *         `block.timestamp < probationEndsAt` e `status == Active`.
 *         Probation inicial automatica aplicada a todo projeto recem-ativado
 *         durante `probationDuration`; sinaliza projeto recem-ativado (o
 *         consumo desse sinal fica a cargo de consumidores externos).
 *       - Probation PUNITIVA (status `Probation` do enum): governanca move
 *         manualmente um projeto Active para Probation por ma conduta;
 *         {isInProbation} retorna false nesse caso (porque status != Active),
 *         e {isActive} tambem retorna false — o projeto fica temporariamente
 *         suspenso ate {reactivate}.
 *      Reentrancia: {registerProject} e {removeProject} movem ERC-20 via
 *      {SafeERC20}. Como o token e o proprio GOV (ERC20Votes conhecido, sem
 *      hooks de callback), `ReentrancyGuard` seria redundante — seguimos o
 *      padrao CEI estritamente (Checks -> Effects -> Interactions) em ambas
 *      as funcoes, e qualquer integracao futura com GOV que mude esse modelo
 *      exige nova auditoria deste contrato.
 *      Reentrancia adicional: {updateMetadata} e {transferProjectOwnership}
 *      nao movem tokens — nao aplicavel.
 *      v1: nao ha topup/withdraw parcial de colateral. Uma vez registrado,
 *      o colateral so pode ser liberado via {removeProject}. Se v2 precisar
 *      de topup dentro dos limites de status, basta adicionar funcoes novas
 *      sem quebrar layout.
 * @custom:security-contact security@web3community.example
 */
contract ProjectRegistry is AccessControl {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Estados possiveis de um projeto. Transicoes validas:
    ///         Pending -> Active;
    ///         Active -> Probation; Active -> Removed;
    ///         Probation -> Active; Probation -> Removed;
    ///         Removed e terminal.
    enum Status {
        Pending,
        Active,
        Probation,
        Removed
    }

    /// @notice Registro completo de um projeto.
    /// @param owner Endereco com direito de atualizar metadata e iniciar
    ///              transferencia de ownership.
    /// @param collateral Quantidade de GOV lockada no Registry (wei).
    /// @param status Estado atual na maquina de status.
    /// @param activatedAt Timestamp (segundos) da primeira ativacao; 0 enquanto
    ///                    Pending. Nao e atualizado em transicoes posteriores
    ///                    (Probation/Active) para manter o ancoramento original.
    /// @param probationEndsAt Timestamp em que a probation inicial por tempo
    ///                        termina. Calculado em {activateProject} como
    ///                        `activatedAt + probationDuration`.
    /// @param metadataURI URI off-chain (IPFS/Arweave) com o restante dos
    ///                    dados (nome, descricao, icone, contract addresses
    ///                    do app, etc).
    struct Project {
        address owner;
        uint256 collateral;
        Status status;
        uint64 activatedAt;
        uint64 probationEndsAt;
        string metadataURI;
    }

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Role concedida ao `TimelockController` em producao. Unica role
    ///         capaz de registrar, ativar, colocar em probation punitiva,
    ///         reativar, remover projetos e ajustar parametros economicos.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // ------------------------------------------------------------------
    // Immutable / storage
    // ------------------------------------------------------------------

    /// @notice Token de governanca (GOV) usado como colateral.
    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable GOV_TOKEN;

    /// @notice Colateral minimo exigido para registrar um novo projeto (wei).
    uint256 public minCollateral;

    /// @notice Duracao da probation inicial automatica aplicada a projetos
    ///         recem-ativados (segundos). Afeta apenas ativacoes futuras.
    uint64 public probationDuration;

    /// @dev Contador incremental — proximo ID a ser atribuido. Comeca em 1
    ///      para que o ID 0 seja sempre invalido (simplifica checks).
    uint256 private _nextProjectId;

    /// @dev Mapeamento projectId => registro.
    mapping(uint256 => Project) private _projects;

    /// @dev Mapeamento projectId => endereco pendente da transferencia de
    ///      ownership 2-step. address(0) = nenhuma transferencia em curso.
    mapping(uint256 => address) private _pendingOwners;

    // ------------------------------------------------------------------
    // ownerRecipient timelocked — endereco canonico de recebimento por projeto,
    // ------------------------------------------------------------------
    //
    // Motivacao: um consumidor externo (ex.: distribuicao de valor por
    // projeto) pode pagar direto para `ownerRecipient(projectId)`. Se o
    // setter fosse imediato, o owner do projeto poderia hot-swap o recipient
    // entre o pagamento e o instante em que a tx e indexada off-chain,
    // desviando rewards para outro endereco. A mitigacao e um timelock
    // operacional de 48h: setter so propoe a mudanca; aplicacao e separada e
    // qualquer um pode trigger apos `effectiveAt`.
    //
    // Storage segue ao final do layout original (este contrato NAO e proxy,
    // mas mantemos a convencao de auditabilidade — append-only).

    /// @notice Pending update de ownerRecipient com timelock de 48h.
    /// @param newRecipient Endereco que sera ativado em `effectiveAt`.
    /// @param effectiveAt Unix timestamp (seg) em que {applyOwnerRecipient}
    ///                    pode ser chamado por qualquer um. `0` indica
    ///                    "sem proposta pendente".
    struct PendingRecipientChange {
        address newRecipient;
        uint64 effectiveAt;
    }

    /// @notice Recipient ativo por projeto. Default `address(0)` significa
    ///         "use `owner` como fallback" (ver {ownerRecipient(uint256)}).
    ///         Quando setado via {applyOwnerRecipient}, vira o destino canonico
    ///         de valor por projeto (consumidor externo).
    mapping(uint256 projectId => address recipient) private _ownerRecipient;

    /// @notice Proposta pendente por projectId. Apenas uma proposta ativa por
    ///         vez — nova {proposeOwnerRecipient} sobrescreve.
    mapping(uint256 projectId => PendingRecipientChange) public pendingOwnerRecipient;

    /// @notice Delay operacional do timelock para setar o ownerRecipient.
    ///         48 horas — congelado no parecer 2026-04-24-clp-pivot.md (E.3).
    uint64 public constant OWNER_RECIPIENT_TIMELOCK = 48 hours;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido ao registrar um novo projeto (status Pending).
    /// @param projectId ID atribuido (sempre >= 1).
    /// @param owner Owner declarado na criacao.
    /// @param collateral Quantidade de GOV lockada.
    /// @param metadataURI URI off-chain.
    event ProjectRegistered(uint256 indexed projectId, address indexed owner, uint256 collateral, string metadataURI);

    /// @notice Emitido ao mover um projeto de Pending para Active.
    /// @param projectId ID do projeto.
    /// @param activatedAt Timestamp (seg) da ativacao.
    /// @param probationEndsAt Timestamp (seg) em que a probation inicial
    ///                        termina.
    event ProjectActivated(uint256 indexed projectId, uint64 activatedAt, uint64 probationEndsAt);

    /// @notice Emitido ao mover Active para Probation (punitiva).
    event ProjectProbation(uint256 indexed projectId);

    /// @notice Emitido ao mover Probation para Active.
    event ProjectReactivated(uint256 indexed projectId);

    /// @notice Emitido na remocao terminal.
    /// @param projectId ID removido.
    /// @param slashed `true` se o colateral foi enviado ao treasury;
    ///                `false` se foi devolvido ao owner.
    /// @param collateralReturned Quantidade movida para o destino (treasury
    ///                           se slashed, owner caso contrario).
    event ProjectRemoved(uint256 indexed projectId, bool slashed, uint256 collateralReturned);

    /// @notice Emitido em {updateMetadata}.
    event MetadataUpdated(uint256 indexed projectId, string newMetadataURI);

    /// @notice Emitido em {transferProjectOwnership}.
    event OwnershipTransferInitiated(
        uint256 indexed projectId,
        address indexed currentOwner,
        address indexed pendingOwnerAddr
    );

    /// @notice Emitido em {acceptProjectOwnership}.
    event OwnershipTransferAccepted(uint256 indexed projectId, address indexed previousOwner, address indexed newOwner);

    /// @notice Emitido em {setMinCollateral}.
    event MinCollateralUpdated(uint256 oldMin, uint256 newMin);

    /// @notice Emitido em {setProbationDuration}.
    event ProbationDurationUpdated(uint64 oldDuration, uint64 newDuration);

    // ------------------------------------------------------------------
    // Events — ownerRecipient timelock
    // ------------------------------------------------------------------

    /// @notice Emitido quando uma proposta de mudanca do ownerRecipient e
    ///         registrada. Aplicacao requer aguardar `effectiveAt`.
    /// @param projectId ID do projeto.
    /// @param proposer Endereco que registrou a proposta (owner do projeto).
    /// @param newRecipient Endereco proposto.
    /// @param effectiveAt Timestamp UNIX (seg) a partir do qual
    ///                    {applyOwnerRecipient} pode ser chamado.
    event OwnerRecipientProposed(
        uint256 indexed projectId,
        address indexed proposer,
        address indexed newRecipient,
        uint64 effectiveAt
    );

    /// @notice Emitido em {applyOwnerRecipient} quando a proposta e ativada.
    /// @param projectId ID do projeto.
    /// @param oldRecipient Endereco antes da aplicacao (pode ser `address(0)`
    ///                     se ainda usava o owner como fallback).
    /// @param newRecipient Novo endereco ativo (canonico).
    event OwnerRecipientApplied(uint256 indexed projectId, address indexed oldRecipient, address indexed newRecipient);

    /// @notice Emitido em {cancelOwnerRecipient}.
    event OwnerRecipientCancelled(uint256 indexed projectId, address indexed canceller);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Valor zero nao e permitido em operacoes que exigem > 0.
    error ZeroAmount();

    /// @notice URI de metadata vazia nao e permitida.
    error EmptyMetadataURI();

    /// @notice Colateral declarado abaixo do minimo vigente.
    /// @param provided Quantidade enviada pelo chamador.
    /// @param required `minCollateral` atual.
    error InsufficientCollateral(uint256 provided, uint256 required);

    /// @notice Allowance insuficiente do owner para o Registry executar o
    ///         `transferFrom` de registerProject. Preferimos revert explicito
    ///         aqui para mensagem de auditoria mais clara do que o revert
    ///         generico do ERC-20.
    /// @param provided Allowance atual.
    /// @param required Quantidade necessaria.
    error InsufficientAllowance(uint256 provided, uint256 required);

    /// @notice Projeto com `projectId` nao existe.
    error ProjectNotFound(uint256 projectId);

    /// @notice Projeto ja esta em status Removed — operacao bloqueada.
    error ProjectAlreadyRemoved(uint256 projectId);

    /// @notice Status atual nao permite a transicao solicitada.
    /// @param projectId ID do projeto.
    /// @param current Status atual (enum).
    /// @param expected Status exigido para a operacao (enum).
    error InvalidStatus(uint256 projectId, Status current, Status expected);

    /// @notice Chamador nao e o owner do projeto.
    error NotProjectOwner(uint256 projectId, address caller);

    /// @notice Chamador nao e o pending owner registrado para o projeto.
    error NotPendingOwner(uint256 projectId, address caller);

    /// @notice Tentativa de aplicar ownerRecipient antes do `effectiveAt`.
    /// @param effectiveAt Timestamp UNIX (seg) a partir do qual a aplicacao
    ///                    e valida.
    /// @param nowTs `block.timestamp` atual.
    error OwnerRecipientTimelockActive(uint64 effectiveAt, uint64 nowTs);

    /// @notice Nao ha proposta pendente para o projectId.
    error NoPendingOwnerRecipient(uint256 projectId);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o registry apontando para o token de colateral e concede
     *         `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE` ao `initialAdmin`.
     * @dev Em producao o `initialAdmin` deve transferir `GOVERNANCE_ROLE` para
     *      o `TimelockController` e renunciar a propria role apos a transicao
     *      (via `grantRole`/`renounceRole` no script de deploy da fase 5).
     *      Params iniciais sao imediatamente ajustaveis via
     *      {setMinCollateral} e {setProbationDuration}.
     * @param govToken_ Endereco do `GovernanceToken` (GOV). Revertido se 0.
     * @param initialAdmin Endereco que recebe ambas as roles. Revertido se 0.
     * @param initialMinCollateral Valor inicial de `minCollateral` (wei).
     * @param initialProbationDuration Duracao inicial da probation automatica
     *                                 (segundos).
     */
    constructor(
        address govToken_,
        address initialAdmin,
        uint256 initialMinCollateral,
        uint64 initialProbationDuration
    ) {
        if (govToken_ == address(0) || initialAdmin == address(0)) {
            revert ZeroAddress();
        }
        if (initialMinCollateral == 0 || initialProbationDuration == 0) {
            revert ZeroAmount();
        }

        GOV_TOKEN = IERC20(govToken_);
        minCollateral = initialMinCollateral;
        probationDuration = initialProbationDuration;
        _nextProjectId = 1;

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(GOVERNANCE_ROLE, initialAdmin);
    }

    // ------------------------------------------------------------------
    // Public view — exposes immutable as function for ABI ergonomics
    // ------------------------------------------------------------------

    /// @notice Endereco do token de colateral (GOV).
    function govToken() external view returns (address) {
        return address(GOV_TOKEN);
    }

    /// @notice Total de projetos ja registrados (inclui Removed).
    function totalProjects() external view returns (uint256) {
        return _nextProjectId - 1;
    }

    /**
     * @notice Retorna a struct completa do projeto.
     * @dev Reverte com {ProjectNotFound} se `projectId` nao existe.
     * @param projectId ID do projeto.
     * @return Project armazenado.
     */
    function getProject(uint256 projectId) external view returns (Project memory) {
        _requireExists(projectId);
        return _projects[projectId];
    }

    /**
     * @notice `true` se o projeto esta em status `Active` (inclui janela de
     *         probation automatica).
     * @dev Retorna `false` para projetos inexistentes em vez de reverter —
     *      permite uso em callers (Staking, FeeRouterV2) sem try/catch.
     */
    function isActive(uint256 projectId) external view returns (bool) {
        if (!_exists(projectId)) {
            return false;
        }
        return _projects[projectId].status == Status.Active;
    }

    /**
     * @notice `true` se o projeto esta dentro da probation INICIAL POR TEMPO.
     *         Probation punitiva (status `Probation` do enum) retorna `false`
     *         aqui — a semantica deste view e estritamente "recem-ativado,
     *         com peso de reward reduzido". Callers devem combinar com
     *         `getProject(id).status == Status.Probation` para punitiva.
     * @dev Nao reverte para projetos inexistentes (ver {isActive}).
     */
    function isInProbation(uint256 projectId) external view returns (bool) {
        if (!_exists(projectId)) {
            return false;
        }
        Project storage p = _projects[projectId];
        if (p.status != Status.Active) {
            return false;
        }
        return block.timestamp < p.probationEndsAt;
    }

    /**
     * @notice Endereco pendente numa transferencia de ownership 2-step.
     *         `address(0)` se nao ha transferencia em curso ou projeto
     *         nao existe.
     */
    function pendingOwner(uint256 projectId) external view returns (address) {
        return _pendingOwners[projectId];
    }

    // ------------------------------------------------------------------
    // Governance-gated state changes
    // ------------------------------------------------------------------

    /**
     * @notice Registra um novo projeto em status `Pending`. Puxa `collateralAmount`
     *         de GOV do `owner` via `transferFrom` (o `owner` precisa ter
     *         aprovado o Registry antes).
     * @dev Restrito a `GOVERNANCE_ROLE` (invariante I7). O Registry confirma
     *      explicitamente a allowance antes do `transferFrom` para falhar com
     *      {InsufficientAllowance} em vez da mensagem generica do ERC-20.
     *      CEI: todos os checks primeiro, entao updates de storage (inclui
     *      incremento do contador e gravacao do registro), e somente no final
     *      o `safeTransferFrom`. Como o token e o GOV — ERC20Votes conhecido
     *      sem callbacks ao destinatario — CEI e suficiente sem
     *      `ReentrancyGuard`.
     * @param owner Owner do projeto (detentor do colateral e do poder de
     *              atualizar metadata / iniciar transferencia).
     * @param metadataURI URI off-chain. Nao pode ser vazia.
     * @param collateralAmount Quantidade de GOV a lockar. Deve ser >=
     *                         `minCollateral`.
     * @return projectId ID atribuido ao novo projeto (>= 1).
     */
    function registerProject(
        address owner,
        string calldata metadataURI,
        uint256 collateralAmount
    ) external onlyRole(GOVERNANCE_ROLE) returns (uint256 projectId) {
        if (owner == address(0)) {
            revert ZeroAddress();
        }
        if (bytes(metadataURI).length == 0) {
            revert EmptyMetadataURI();
        }
        uint256 minCol = minCollateral;
        if (collateralAmount < minCol) {
            revert InsufficientCollateral(collateralAmount, minCol);
        }

        uint256 allowance = GOV_TOKEN.allowance(owner, address(this));
        if (allowance < collateralAmount) {
            revert InsufficientAllowance(allowance, collateralAmount);
        }

        projectId = _nextProjectId;
        unchecked {
            _nextProjectId = projectId + 1;
        }

        _projects[projectId] = Project({
            owner: owner,
            collateral: collateralAmount,
            status: Status.Pending,
            activatedAt: 0,
            probationEndsAt: 0,
            metadataURI: metadataURI
        });

        emit ProjectRegistered(projectId, owner, collateralAmount, metadataURI);

        // Interaction (after Effects): pull collateral.
        GOV_TOKEN.safeTransferFrom(owner, address(this), collateralAmount);
    }

    /**
     * @notice Ativa um projeto `Pending`, setando `activatedAt` = block.timestamp
     *         e `probationEndsAt` = activatedAt + `probationDuration`.
     * @dev Restrito a `GOVERNANCE_ROLE`. Reverte com {InvalidStatus} se o
     *      projeto nao esta em `Pending`.
     * @param projectId ID do projeto.
     */
    function activateProject(uint256 projectId) external onlyRole(GOVERNANCE_ROLE) {
        Project storage p = _requireProject(projectId);
        if (p.status != Status.Pending) {
            revert InvalidStatus(projectId, p.status, Status.Pending);
        }

        uint64 nowTs = uint64(block.timestamp);
        uint64 endsAt = nowTs + probationDuration;

        p.status = Status.Active;
        p.activatedAt = nowTs;
        p.probationEndsAt = endsAt;

        emit ProjectActivated(projectId, nowTs, endsAt);
    }

    /**
     * @notice Move um projeto `Active` para `Probation` (punitiva). Nao altera
     *         `activatedAt` nem `probationEndsAt` — mantem o ancoramento
     *         original para que, apos {reactivate}, a probation por tempo
     *         permaneca consistente se ainda estiver dentro da janela.
     * @dev Restrito a `GOVERNANCE_ROLE`.
     * @param projectId ID do projeto.
     */
    function setProbation(uint256 projectId) external onlyRole(GOVERNANCE_ROLE) {
        Project storage p = _requireProject(projectId);
        if (p.status != Status.Active) {
            revert InvalidStatus(projectId, p.status, Status.Active);
        }
        p.status = Status.Probation;
        emit ProjectProbation(projectId);
    }

    /**
     * @notice Reabilita um projeto em `Probation`, movendo de volta para
     *         `Active`.
     * @dev Restrito a `GOVERNANCE_ROLE`.
     * @param projectId ID do projeto.
     */
    function reactivate(uint256 projectId) external onlyRole(GOVERNANCE_ROLE) {
        Project storage p = _requireProject(projectId);
        if (p.status != Status.Probation) {
            revert InvalidStatus(projectId, p.status, Status.Probation);
        }
        p.status = Status.Active;
        emit ProjectReactivated(projectId);
    }

    /**
     * @notice Remove um projeto (terminal). Se `slash == true`, o colateral
     *         vai para `treasury`; caso contrario, e devolvido ao owner atual.
     * @dev Restrito a `GOVERNANCE_ROLE`. Pode ser chamado em qualquer status
     *      != `Removed` (inclusive `Pending`). CEI: marca como `Removed`,
     *      zera `collateral` na storage e so entao executa o transfer —
     *      mesmo padrao de {registerProject}.
     *      Revert com {ZeroAddress} apenas quando `slash == true` e
     *      `treasury == address(0)`. Para `slash == false`, o destino e o
     *      owner do projeto, que nunca e zero (validado na criacao).
     * @param projectId ID do projeto.
     * @param slash `true` para enviar o colateral ao treasury; `false` para
     *              devolver ao owner.
     * @param treasury Destino do colateral em caso de slash. Ignorado se
     *                 `slash == false`.
     */
    function removeProject(uint256 projectId, bool slash, address treasury) external onlyRole(GOVERNANCE_ROLE) {
        Project storage p = _requireProject(projectId);
        if (p.status == Status.Removed) {
            revert ProjectAlreadyRemoved(projectId);
        }
        if (slash && treasury == address(0)) {
            revert ZeroAddress();
        }

        uint256 amount = p.collateral;
        address destination = slash ? treasury : p.owner;

        // Effects
        p.status = Status.Removed;
        p.collateral = 0;
        // Cancela qualquer transferencia de ownership pendente.
        if (_pendingOwners[projectId] != address(0)) {
            delete _pendingOwners[projectId];
        }

        emit ProjectRemoved(projectId, slash, amount);

        // Interaction. `amount` e sempre > 0 porque {registerProject} exige
        // `collateralAmount >= minCollateral`, e `minCollateral` nunca pode
        // ser zero (validado em {setMinCollateral} e no constructor).
        GOV_TOKEN.safeTransfer(destination, amount);
    }

    /**
     * @notice Atualiza `minCollateral`. Afeta apenas registros futuros.
     * @dev Restrito a `GOVERNANCE_ROLE`. Reverte com {ZeroAmount} se
     *      `newMin == 0`.
     */
    function setMinCollateral(uint256 newMin) external onlyRole(GOVERNANCE_ROLE) {
        if (newMin == 0) {
            revert ZeroAmount();
        }
        uint256 old = minCollateral;
        minCollateral = newMin;
        emit MinCollateralUpdated(old, newMin);
    }

    /**
     * @notice Atualiza `probationDuration`. Afeta apenas projetos ativados
     *         apos a mudanca — `probationEndsAt` ja gravado em projetos
     *         existentes nao e alterado.
     * @dev Restrito a `GOVERNANCE_ROLE`. Reverte com {ZeroAmount} se
     *      `newDuration == 0`.
     */
    function setProbationDuration(uint64 newDuration) external onlyRole(GOVERNANCE_ROLE) {
        if (newDuration == 0) {
            revert ZeroAmount();
        }
        uint64 old = probationDuration;
        probationDuration = newDuration;
        emit ProbationDurationUpdated(old, newDuration);
    }

    // ------------------------------------------------------------------
    // Owner-gated state changes
    // ------------------------------------------------------------------

    /**
     * @notice Atualiza a `metadataURI` do projeto. Somente o owner atual pode
     *         chamar — permite que correcoes off-chain (mudanca de icone, de
     *         CID do IPFS, de contract addresses do app) nao precisem passar
     *         pelo ciclo de governanca.
     * @dev Reverte com {ProjectAlreadyRemoved} se status == Removed (a URI
     *      fica congelada apos remocao).
     */
    function updateMetadata(uint256 projectId, string calldata metadataURI) external {
        Project storage p = _requireProject(projectId);
        if (p.status == Status.Removed) {
            revert ProjectAlreadyRemoved(projectId);
        }
        if (p.owner != msg.sender) {
            revert NotProjectOwner(projectId, msg.sender);
        }
        if (bytes(metadataURI).length == 0) {
            revert EmptyMetadataURI();
        }
        p.metadataURI = metadataURI;
        emit MetadataUpdated(projectId, metadataURI);
    }

    /**
     * @notice Inicia uma transferencia 2-step de ownership. O `newOwner` so
     *         assume apos chamar {acceptProjectOwnership}.
     * @dev Motivacao: mesma de `Ownable2Step` (OZ). Evita transferencia para
     *      endereco errado/inalcancavel. Uma segunda chamada antes do accept
     *      simplesmente sobrescreve o pendente.
     */
    function transferProjectOwnership(uint256 projectId, address newOwner) external {
        Project storage p = _requireProject(projectId);
        if (p.status == Status.Removed) {
            revert ProjectAlreadyRemoved(projectId);
        }
        if (p.owner != msg.sender) {
            revert NotProjectOwner(projectId, msg.sender);
        }
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }
        _pendingOwners[projectId] = newOwner;
        emit OwnershipTransferInitiated(projectId, msg.sender, newOwner);
    }

    /**
     * @notice Aceita a transferencia de ownership. Deve ser chamado pelo
     *         `pendingOwner` registrado para o projeto.
     */
    function acceptProjectOwnership(uint256 projectId) external {
        Project storage p = _requireProject(projectId);
        address pending = _pendingOwners[projectId];
        if (pending == address(0) || pending != msg.sender) {
            revert NotPendingOwner(projectId, msg.sender);
        }
        address previous = p.owner;
        p.owner = pending;
        delete _pendingOwners[projectId];
        emit OwnershipTransferAccepted(projectId, previous, pending);
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /// @dev `true` se `projectId` foi atribuido (>= 1 e < `_nextProjectId`).
    function _exists(uint256 projectId) private view returns (bool) {
        return projectId != 0 && projectId < _nextProjectId;
    }

    /// @dev Reverte com {ProjectNotFound} se `projectId` nao existe.
    function _requireExists(uint256 projectId) private view {
        if (!_exists(projectId)) {
            revert ProjectNotFound(projectId);
        }
    }

    /// @dev Combina {_requireExists} com retorno de storage pointer —
    ///      reduz gas e reuso de codigo em todas as funcoes state-changing.
    function _requireProject(uint256 projectId) private view returns (Project storage) {
        _requireExists(projectId);
        return _projects[projectId];
    }

    // ------------------------------------------------------------------
    // ownerRecipient timelock (anti hot-swap de recebedor)
    // ------------------------------------------------------------------

    /**
     * @notice Endereco canonico de recebimento de valor por projeto,
     *         Endereco canonico de recebimento por projeto. Consultavel por
     *         qualquer consumidor externo.
     * @dev Quando nunca foi setado para o projectId, retorna o `owner` atual
     *      do projeto como fallback — preserva compatibilidade com o modelo
     *      simples: sem override explicito, paga o proprio owner.
     *      Para projetos que jamais existiram, retorna `address(0)`.
     * @param projectId ID do projeto.
     * @return recipient Endereco canonico (nunca `address(0)` para projetos
     *                   existentes).
     */
    function ownerRecipient(uint256 projectId) external view returns (address recipient) {
        if (!_exists(projectId)) {
            return address(0);
        }
        address explicit = _ownerRecipient[projectId];
        if (explicit != address(0)) {
            return explicit;
        }
        return _projects[projectId].owner;
    }

    /**
     * @notice Inicia uma proposta de mudanca do ownerRecipient. A proposta
     *         so pode ser aplicada via {applyOwnerRecipient} apos
     *         {OWNER_RECIPIENT_TIMELOCK} (48h) terem decorrido.
     * @dev `onlyOwner` (do projeto). Sobrescreve qualquer proposta pendente
     *      previa — o relogio reinicia. Reverte se projeto Removed (recipient
     *      fica congelado, simetrico a {updateMetadata}).
     *
     *      Justificativa do timelock: um consumidor externo pode pagar valor
     *      direto para `ownerRecipient`. Sem janela de espera, o owner poderia
     *      hot-swap o recipient entre o pagamento e o instante observavel
     *      off-chain, desviando fundos. 48h e compativel com o ciclo
     *      operacional da DAO (proposta + execucao do Timelock levam ~2d).
     * @param projectId ID do projeto.
     * @param newRecipient Endereco proposto. `address(0)` reseta para o
     *                     fallback (= owner atual do projeto).
     */
    function proposeOwnerRecipient(uint256 projectId, address newRecipient) external {
        Project storage p = _requireProject(projectId);
        if (p.status == Status.Removed) {
            revert ProjectAlreadyRemoved(projectId);
        }
        if (p.owner != msg.sender) {
            revert NotProjectOwner(projectId, msg.sender);
        }

        uint64 effectiveAt = uint64(block.timestamp) + OWNER_RECIPIENT_TIMELOCK;
        pendingOwnerRecipient[projectId] = PendingRecipientChange({
            newRecipient: newRecipient,
            effectiveAt: effectiveAt
        });

        emit OwnerRecipientProposed(projectId, msg.sender, newRecipient, effectiveAt);
    }

    /**
     * @notice Aplica a proposta pendente de ownerRecipient. Permissionless —
     *         qualquer um pode chamar apos `effectiveAt`. Reverte se nao
     *         houver proposta pendente.
     * @dev O design permissionless e deliberado: o owner ja sinalizou intencao
     *      em {proposeOwnerRecipient}, e atrasar a aplicacao apenas penaliza o
     *      proprio owner. Bots ou keepers podem aplicar sem custo de
     *      governanca.
     *      Se a proposta foi `address(0)`, o efeito e "limpar o explicit
     *      recipient" (volta ao fallback = owner do projeto).
     * @param projectId ID do projeto.
     */
    function applyOwnerRecipient(uint256 projectId) external {
        _requireExists(projectId);
        PendingRecipientChange memory pending = pendingOwnerRecipient[projectId];
        if (pending.effectiveAt == 0) {
            revert NoPendingOwnerRecipient(projectId);
        }
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < pending.effectiveAt) {
            revert OwnerRecipientTimelockActive(pending.effectiveAt, nowTs);
        }

        address oldRecipient = _ownerRecipient[projectId];
        _ownerRecipient[projectId] = pending.newRecipient;
        delete pendingOwnerRecipient[projectId];

        emit OwnerRecipientApplied(projectId, oldRecipient, pending.newRecipient);
    }

    /**
     * @notice Cancela uma proposta pendente. Pode ser chamado pelo owner do
     *         projeto OU por qualquer portador de `GOVERNANCE_ROLE` (escape
     *         hatch caso a proposta seja maliciosa e o owner esteja
     *         comprometido).
     * @dev Reverte se nao ha proposta pendente. Cancelamento e idempotente
     *      apos clearing.
     * @param projectId ID do projeto.
     */
    function cancelOwnerRecipient(uint256 projectId) external {
        Project storage p = _requireProject(projectId);
        if (pendingOwnerRecipient[projectId].effectiveAt == 0) {
            revert NoPendingOwnerRecipient(projectId);
        }
        if (p.owner != msg.sender && !hasRole(GOVERNANCE_ROLE, msg.sender)) {
            revert NotProjectOwner(projectId, msg.sender);
        }
        delete pendingOwnerRecipient[projectId];
        emit OwnerRecipientCancelled(projectId, msg.sender);
    }
}
