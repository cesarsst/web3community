// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
// solhint-disable-next-line max-line-length
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";


/**
 * @title CommunityGovernor
 * @notice Governor canonico da DAO Web3Community, composto pelo stack OZ 5.0.x:
 *         {Governor} + {GovernorSettings} + {GovernorCountingSimple} +
 *         {GovernorVotes} + {GovernorVotesQuorumFraction} +
 *         {GovernorTimelockControl}.
 *
 *         Voting power e lida do {GovernanceToken} (ERC20Votes), garantindo que
 *         flash loans nao influenciem propostas (invariante I5). Toda execucao
 *         bem-sucedida e roteada via {CommunityTimelock}, que aplica delay e
 *         mantem os contratos economicos isolados de chamadas ad-hoc do Governor.
 *
 * @dev Decisoes de parametro (ajustaveis depois via {setVotingDelay},
 *      {setVotingPeriod}, {setProposalThreshold}, {updateQuorumNumerator},
 *      todas `onlyGovernance`):
 *
 *      PRODUCAO (sugestao):
 *          votingDelay    = 7200 blocks  (~1 dia @ 12s/block)
 *          votingPeriod   = 50400 blocks (~7 dias @ 12s/block)
 *          threshold      = 10_000 * 1e18 GOV (0,01% do cap) — baixo para nao
 *                           calcificar governanca, mas > 0 para bloquear proposta
 *                           spam vinda de contas sem skin in the game
 *          quorumFraction = 4%           (padrao OZ/Compound; balanceia
 *                           participacao real vs risco de captura por minoria)
 *
 *      DEV / TESTES:
 *          votingDelay    = 1 block
 *          votingPeriod   = 50 blocks
 *          threshold      = 10_000 * 1e18 GOV (mantem o mesmo para cobrir o
 *                           guard em teste unitario)
 *          quorumFraction = 4%
 *
 *      O nome "CommunityGovernor" e usado como `name` do EIP-712 no constructor
 *      do {Governor}; mudar o nome quebra o domain separator e invalida
 *      assinaturas previas de {castVoteBySig} / {castVoteWithReasonAndParamsBySig}.
 *      Nunca renomear sem migracao.
 *
 *      Clock mode: delegamos ao token via {GovernorVotes.clock} — {GovernanceToken}
 *      nao sobrescreve `clock()`, entao a fallback do ERC20Votes retorna
 *      `block.number`, e o Governor passa a operar em numero de blocos.
 *      Toda a aritmetica de delay/period aqui e em BLOCKS.
 *
 *      Invariantes atendidas:
 *      - I4: voting power isolada em `token()`; execucao via Timelock; nenhuma
 *        funcao bypass admin.
 *      - I5: {IERC5805.getPastVotes} via ERC20Votes — snapshot imune a flash
 *        loans no bloco do voto.
 *      - I7: o Governor e o unico autorizado a propor acoes que o Timelock
 *        executa contra {ProjectRegistry}, entao registro/alteracao de
 *        projetos obriga proposta aprovada.
 *
 *      Overrides obrigatorios:
 *      - {votingDelay}, {votingPeriod}, {proposalThreshold}: hierarquia exige
 *        resolver Governor vs GovernorSettings.
 *      - {quorum}: resolve Governor vs GovernorVotesQuorumFraction.
 *      - {state}, {proposalNeedsQueuing}, {_queueOperations},
 *        {_executeOperations}, {_cancel}, {_executor}: resolve Governor vs
 *        GovernorTimelockControl.
 *      - {supportsInterface}: nao e necessario override composto aqui — no OZ
 *        5.0.2 apenas {Governor} define; deixamos como herdado.
 *
 *      PROPOSAL TYPES (supermajoridade para chamadas sensiveis):
 *      {propose} escaneia os calldatas: qualquer call cujo selector esteja em
 *      {isSensitiveSelector} — gestao de roles em QUALQUER contrato,
 *      `updateDelay` do Timelock, `mint` de GOV/CREDIT, `transferOwnership`
 *      do GOV, `transfer`/`transferETH` do Treasury, `setRecipients` do
 *      FeeRouterV2, `removeProject` do Registry — marca a proposta como
 *      {ProposalType.Supermajority}, e {_voteSucceeded} passa a exigir
 *      `forVotes >= 3 * againstVotes` (For >= 75% dos votos decisivos
 *      For/Against; Abstain fora da razao, coerente com o COUNTING_MODE do
 *      {GovernorCountingSimple}). Ate 2026-09-23 o scan era restrito a
 *      gestao de roles com target Treasury/Timelock, o que deixava em
 *      maioria simples o mint de CREDIT sem lastro (via grantRole no
 *      CreditToken), a diluicao de GOV e o esvaziamento direto do cofre
 *      (parecer `audit/economist/2026-09-23-conceptual-gaming-review.md`).
 *      `TREASURY` continua imutavel e exposto; `address(0)` desliga o scan
 *      (deploy dev sem treasury).
 *
 *      Anti-bypass (por que chamadas aninhadas nao contornam a regra):
 *      - O Timelock so executa exatamente os calldatas registrados na
 *        proposta aprovada (hash de operacao cobre targets/values/calldatas);
 *        nao ha como "injetar" uma call sensivel que nao foi escaneada no
 *        propose.
 *      - Nested calls nao escapam: qualquer grantRole no Treasury/Timelock
 *        exige `msg.sender` com a role admin correspondente (Timelock em
 *        producao); um contrato intermediario chamado pela proposta nunca e
 *        o Timelock, entao a indirecao falha no AccessControl.
 *      - Batch misto: uma proposta que mistura gestao de roles do
 *        Treasury/Timelock com outras calls e contaminada INTEIRA pelo tipo
 *        Supermajority. Correto por design — caso contrario, empacotar a
 *        call sensivel junto de calls populares seria exatamente o vetor de
 *        diluicao do requisito de 75%.
 *
 * @custom:security-contact security@web3community.example
 */
contract CommunityGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    // ------------------------------------------------------------------
    // Proposal types — supermajoridade para remocao de POL
    // ------------------------------------------------------------------

    /// @notice Tipos de proposta reconhecidos por este Governor.
    ///         - Standard: contagem padrao do {GovernorCountingSimple}
    ///           (For > Against).
    ///         - Supermajority: exige For >= 75% dos votos decisivos
    ///           (`forVotes >= 3 * againstVotes`; Abstain fora da razao).
    enum ProposalType {
        Standard,
        Supermajority
    }

    /// @notice Selector de {IAccessControl.grantRole}
    ///         (`grantRole(bytes32,address)` = 0x2f2ff15d). Gestao de roles
    ///         do Treasury/Timelock decide quem movimenta o cofre — exige o
    ///         gate de 75% (ver NatSpec do contrato).
    bytes4 public constant GRANT_ROLE_SELECTOR = IAccessControl.grantRole.selector;

    /// @notice Selector de {IAccessControl.revokeRole}
    ///         (`revokeRole(bytes32,address)` = 0xd547741f).
    bytes4 public constant REVOKE_ROLE_SELECTOR = IAccessControl.revokeRole.selector;

    /// @notice Selector de {IAccessControl.renounceRole}
    ///         (`renounceRole(bytes32,address)` = 0x36568abe).
    bytes4 public constant RENOUNCE_ROLE_SELECTOR = IAccessControl.renounceRole.selector;

    /// @notice `TimelockController.updateDelay(uint256)` — zerar o delay
    ///         torna toda proposta seguinte de execucao imediata.
    bytes4 public constant UPDATE_DELAY_SELECTOR = TimelockController.updateDelay.selector;

    /// @notice `mint(address,uint256,string)` — assinatura compartilhada por
    ///         {GovernanceToken.mint} (dilui GOV ate o cap) e
    ///         {CreditToken.mint} (CREDIT sem lastro).
    bytes4 public constant MINT_SELECTOR = bytes4(keccak256("mint(address,uint256,string)"));

    /// @notice `Ownable.transferOwnership(address)` — muda quem pode mintar GOV.
    bytes4 public constant TRANSFER_OWNERSHIP_SELECTOR = bytes4(keccak256("transferOwnership(address)"));

    /// @notice `Treasury.transfer(IERC20,address,uint256)` — saida de tokens do cofre.
    bytes4 public constant TREASURY_TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,address,uint256)"));

    /// @notice `Treasury.transferETH(address,uint256)` — saida de ETH do cofre.
    bytes4 public constant TREASURY_TRANSFER_ETH_SELECTOR = bytes4(keccak256("transferETH(address,uint256)"));

    /// @notice `FeeRouterV2.setRecipients(address,address,address)` — redireciona 100% da fee.
    bytes4 public constant SET_RECIPIENTS_SELECTOR = bytes4(keccak256("setRecipients(address,address,address)"));

    /// @notice `ProjectRegistry.removeProject(uint256,bool,address)` — slash de
    ///         colateral para endereco arbitrario.
    bytes4 public constant REMOVE_PROJECT_SELECTOR = bytes4(keccak256("removeProject(uint256,bool,address)"));

    /// @notice Endereco do {Treasury} cuja remocao de POL exige
    ///         supermaioria. Imutavel — em deploy dev sem treasury pode ser
    ///         `address(0)`, e nesse caso o scan de {propose} nunca marca
    ///         proposta alguma como Supermajority.
    address public immutable TREASURY;

    /// @notice `true` se a proposta `proposalId` foi marcada como
    ///         {ProposalType.Supermajority} no {propose} (contem ao menos
    ///         uma call de gestao de roles no Treasury/Timelock). Default `false` = Standard.
    mapping(uint256 proposalId => bool requiresSupermajority) public proposalRequiresSupermajority;

    /// @notice Emitido em todo {propose} com o tipo atribuido a proposta,
    ///         para indexacao off-chain (subgraph/frontend sinalizam o
    ///         requisito de 75% antes da votacao abrir).
    /// @param proposalId Id da proposta (hashProposal).
    /// @param proposalType Tipo atribuido ({ProposalType}).
    event ProposalTypeSet(uint256 indexed proposalId, ProposalType proposalType);

    /**
     * @notice Cria o CommunityGovernor amarrado a um token ERC20Votes e a um
     *         Timelock. O nome "CommunityGovernor" trava o domain separator do
     *         EIP-712 — nao altere em upgrades.
     * @dev Parametros sao imediatamente setados via {GovernorSettings} e
     *      {GovernorVotesQuorumFraction}; podem ser alterados apos deploy
     *      apenas via proposta governance (onlyGovernance dos respectivos
     *      setters), ou seja, passando pelo Timelock.
     *      Guards implicitos OZ:
     *      - `GovernorInvalidVotingPeriod(0)` reverte se `initialVotingPeriod == 0`
     *        ({GovernorSettings._setVotingPeriod}).
     *      - `GovernorInvalidQuorumFraction(n, 100)` reverte se
     *        `initialQuorumNumerator > 100`
     *        ({GovernorVotesQuorumFraction._updateQuorumNumerator}).
     * @param token Token ERC20Votes fonte de voting power (GovernanceToken).
     * @param timelock Timelock que executa as propostas aprovadas.
     * @param treasury Endereco do {Treasury} para o scan de gestao de roles em
     *                 {propose}. `address(0)` e aceito (deploy dev sem
     *                 treasury) — nesse caso nenhuma proposta e marcada como
     *                 Supermajority.
     * @param initialVotingDelay Delay em blocos entre propor e abrir a votacao.
     * @param initialVotingPeriod Duracao da votacao em blocos (>0 obrigatorio).
     * @param initialProposalThreshold Minimo de voting power delegado para
     *                                 propor (em wei-equivalent do GOV).
     * @param initialQuorumNumerator Numerador da fracao de quorum sobre 100
     *                               (4 = 4%).
     */
    constructor(
        IVotes token,
        TimelockController timelock,
        address treasury,
        uint48 initialVotingDelay,
        uint32 initialVotingPeriod,
        uint256 initialProposalThreshold,
        uint256 initialQuorumNumerator
    )
        Governor("CommunityGovernor")
        GovernorSettings(initialVotingDelay, initialVotingPeriod, initialProposalThreshold)
        GovernorVotes(token)
        GovernorVotesQuorumFraction(initialQuorumNumerator)
        GovernorTimelockControl(timelock)
    {
        TREASURY = treasury;
    }

    // ------------------------------------------------------------------
    // Proposal types — propose scan + regra de contagem
    // ------------------------------------------------------------------

    /**
     * @notice Cria uma proposta e classifica seu {ProposalType}. Se qualquer
     *         call do batch tem selector em {isSensitiveSelector} (em
     *         qualquer target), a proposta INTEIRA e marcada como
     *         Supermajority (75%). Emite {ProposalTypeSet} sempre (tambem
     *         para Standard), para indexacao off-chain.
     * @dev Decisao de design: o scan e por SELECTOR, nao por (target,
     *      selector). Filtrar por target exigiria conhecer no constructor
     *      todos os contratos economicos (e qualquer contrato futuro com
     *      GOVERNANCE_ROLE ficaria de fora); o custo do falso-positivo e so
     *      exigir 75% de uma call inocente. Ver NatSpec do contrato
     *      para a analise anti-bypass completa (timelock so executa os
     *      calldatas da proposta; Treasury so aceita GOVERNANCE_ROLE =
     *      timelock; nested calls falham no AccessControl; batch misto
     *      contamina a proposta inteira).
     *
     *      O scan roda apos {Governor.propose} (threshold e validacoes OZ
     *      primeiro); a marcacao e um effect interno sem interacao externa,
     *      entao CEI e preservado. Com `TREASURY == address(0)` o scan e
     *      pulado por completo (deploy dev sem treasury — nao ha POL a
     *      proteger, e nenhum target legitimo e o endereco zero).
     *
     *      `calldatas[i].length >= 4` evita falso-positivo de conversao
     *      `bytes4` sobre calldata curta (a conversao pad-a-zeros de
     *      Solidity >=0.8.5 poderia casar um prefixo truncado).
     */
    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override returns (uint256) {
        uint256 proposalId = super.propose(targets, values, calldatas, description);

        ProposalType proposalType = ProposalType.Standard;
        if (TREASURY != address(0)) {
            uint256 len = calldatas.length;
            for (uint256 i = 0; i < len; ++i) {
                if (calldatas[i].length < 4) {
                    continue;
                }
                if (isSensitiveSelector(bytes4(calldatas[i]))) {
                    proposalType = ProposalType.Supermajority;
                    proposalRequiresSupermajority[proposalId] = true;
                    break;
                }
            }
        }

        emit ProposalTypeSet(proposalId, proposalType);
        return proposalId;
    }

    /**
     * @dev `true` para os tres selectors de gestao de roles do
     *      {IAccessControl} (grantRole/revokeRole/renounceRole). Usado pelo
     *      scan de {propose} para fechar o vetor de re-autorizacao: alterar
     *      quem detem roles no Treasury ou no Timelock muda quem pode chamar
     *      fundos do Treasury, entao exige a mesma supermaioria de 75%.
     */
    function _isRoleManagementSelector(bytes4 selector) internal pure returns (bool) {
        return
            selector == GRANT_ROLE_SELECTOR ||
            selector == REVOKE_ROLE_SELECTOR ||
            selector == RENOUNCE_ROLE_SELECTOR;
    }

    /**
     * @notice `true` se `selector` pertence ao conjunto de chamadas que exigem
     *         supermaioria (75%) em QUALQUER target.
     * @dev Conjunto (parecer `audit/economist/2026-09-23-conceptual-gaming-review.md`
     *      #2/#3/#8):
     *      - gestao de roles (`grantRole`/`revokeRole`/`renounceRole`) em
     *        qualquer contrato: unico caminho para criar um novo minter de
     *        CREDIT, um novo GOVERNANCE_ROLE no FeeRouter/Registry/Funding ou
     *        um novo PROPOSER no Timelock;
     *      - `updateDelay` — zerar o delay do Timelock anula a ultima defesa;
     *      - `mint(address,uint256,string)` — GOV (diluicao) e CREDIT (sem lastro);
     *      - `transferOwnership` — muda o owner do GOV (quem minta);
     *      - `transfer`/`transferETH` do Treasury — saida do cofre;
     *      - `setRecipients` — redireciona 100% da fee;
     *      - `removeProject` — slash de colateral para endereco arbitrario.
     *      Target-agnostico de proposito: a lista antiga (so Treasury/Timelock)
     *      deixava `grantRole(MINTER_ROLE)` no CreditToken em maioria simples.
     *      Falso-positivo (call inocente com um desses selectors em outro
     *      contrato) so encarece a proposta para 75% — conservador por design.
     */
    function isSensitiveSelector(bytes4 selector) public pure returns (bool) {
        return
            _isRoleManagementSelector(selector) ||
            selector == UPDATE_DELAY_SELECTOR ||
            selector == MINT_SELECTOR ||
            selector == TRANSFER_OWNERSHIP_SELECTOR ||
            selector == TREASURY_TRANSFER_SELECTOR ||
            selector == TREASURY_TRANSFER_ETH_SELECTOR ||
            selector == SET_RECIPIENTS_SELECTOR ||
            selector == REMOVE_PROJECT_SELECTOR;
    }

    /**
     * @notice Regra de sucesso da votacao. Para propostas Standard delega ao
     *         {GovernorCountingSimple} (For > Against). Para Supermajority
     *         exige `forVotes >= 3 * againstVotes` E `forVotes > 0`.
     * @dev `forVotes >= 3 * againstVotes` equivale a
     *      `forVotes / (forVotes + againstVotes) >= 75%` dos votos decisivos
     *      — Abstain fica fora da razao, exatamente como no CountingSimple
     *      (Abstain conta apenas para quorum). Threshold inclusivo: 75.0%
     *      exatos passam.
     *
     *      `forVotes > 0` fecha o edge case de quorum atingido apenas com
     *      Abstain: sem ele, `0 >= 3 * 0` tornaria a supermaioria MAIS fraca
     *      que a maioria simples (que exige For > Against, falso em 0/0).
     *
     *      Overflow de `3 * againstVotes` e impossivel na pratica (voting
     *      power limitado pelo cap de 100M GOV << 2^256/3); em cenario
     *      degenerado a aritmetica checked do 0.8.x reverte em vez de
     *      wrappear — fail-safe.
     */
    function _voteSucceeded(
        uint256 proposalId
    ) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        if (proposalRequiresSupermajority[proposalId]) {
            (uint256 againstVotes, uint256 forVotes, ) = proposalVotes(proposalId);
            return forVotes > 0 && forVotes >= 3 * againstVotes;
        }
        return super._voteSucceeded(proposalId);
    }

    // ------------------------------------------------------------------
    // Overrides requeridos pela multipla heranca (Governor vs extensoes)
    // ------------------------------------------------------------------

    /**
     * @notice Retorna o delay (em blocos) aplicado entre a criacao de uma
     *         proposta e a abertura da janela de votacao.
     * @dev Resolve conflito Governor vs GovernorSettings — o valor efetivo
     *      vem do {GovernorSettings}.
     */
    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    /**
     * @notice Retorna a duracao (em blocos) da janela de votacao de uma
     *         proposta.
     * @dev Resolve conflito Governor vs GovernorSettings.
     */
    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    /**
     * @notice Retorna o minimo de voting power delegado exigido para criar uma
     *         proposta.
     * @dev Resolve conflito Governor vs GovernorSettings. Mantem 10_000e18 GOV
     *      como patamar para evitar spam sem calcificar.
     */
    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    /**
     * @notice Quantidade absoluta de votos necessaria para atingir quorum
     *         num dado `timepoint` (normalmente o bloco de snapshot da
     *         proposta).
     * @dev Resolve conflito Governor vs GovernorVotesQuorumFraction. Usa o
     *      `getPastTotalSupply` do ERC20Votes para garantir snapshot — evita
     *      dependencia do supply atual e, por tabela, ataques que diluam
     *      supply pos-proposal para alcancar quorum artificialmente.
     */
    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(timepoint);
    }

    /**
     * @notice Estado atual da proposta `proposalId`. Pode ser Pending, Active,
     *         Canceled, Defeated, Succeeded, Queued, Expired ou Executed.
     * @dev Resolve conflito Governor vs GovernorTimelockControl — este ultimo
     *      reescreve para refletir o estado do Timelock apos o queue
     *      (Queued / Executed / Canceled).
     */
    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    /**
     * @notice Indica se uma proposta precisa passar por {queue} antes de
     *         {execute}. Com Timelock acoplado, sempre `true`.
     * @dev Resolve conflito Governor vs GovernorTimelockControl.
     */
    function proposalNeedsQueuing(
        uint256 proposalId
    ) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    /**
     * @dev Hook interno de queue. Roteado para o Timelock via
     *      {GovernorTimelockControl._queueOperations}.
     */
    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    /**
     * @dev Hook interno de execucao. Roteado para o Timelock via
     *      {GovernorTimelockControl._executeOperations}.
     */
    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    /**
     * @dev Hook interno de cancelamento. Cancela a proposta no Governor e, se
     *      ja estiver enfileirada, no Timelock. Apenas atingivel pelo flow
     *      {cancel(...)} publico (proposer) ou via onlyGovernance em extensoes.
     */
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    /**
     * @dev Endereco que executa efetivamente as chamadas aprovadas — o
     *      Timelock neste stack. Usado pelo modifier `onlyGovernance` para
     *      saber quem pode chamar funcoes protegidas.
     */
    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
