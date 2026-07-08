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

import {Treasury} from "./Treasury.sol";

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
 *      PROPOSAL TYPES (supermajoridade para remocao de POL):
 *      A regra "remocoes >25% do POL exigem supermaioria 75%" (antes apenas
 *      norma cultural, ver docs/governance/fase1-2-pol.md §5) e agora
 *      enforced on-chain. {propose} escaneia targets+calldatas: qualquer call
 *      com `target == TREASURY` e selector de {Treasury.removePOL} OU de
 *      gestao de roles (grantRole/revokeRole/renounceRole, no TREASURY ou no
 *      proprio Timelock — ver analise anti-bypass abaixo) marca a proposta
 *      como {ProposalType.Supermajority}, e {_voteSucceeded} passa a
 *      exigir `forVotes >= 3 * againstVotes` (For >= 75% dos votos decisivos
 *      For/Against; Abstain fora da razao, coerente com o COUNTING_MODE do
 *      {GovernorCountingSimple}).
 *
 *      Decisao de design — fracao ">25% do POL" NAO e mensuravel no momento
 *      do propose: a liquidez da posicao POL muda entre propose e execute
 *      (fees compostos, adds/removes intermediarios), entao qualquer check
 *      proporcional no propose seria burlavel ou impreciso. Conservador por
 *      design: TODA proposta contendo removePOL exige 75%, independente da
 *      fracao removida.
 *
 *      Anti-bypass (por que chamadas aninhadas nao contornam a regra):
 *      - O Timelock so executa exatamente os calldatas registrados na
 *        proposta aprovada (hash de operacao cobre targets/values/calldatas);
 *        nao ha como "injetar" um removePOL que nao foi escaneado no propose.
 *      - {Treasury.removePOL} e gated por GOVERNANCE_ROLE, concedida em
 *        producao APENAS ao Timelock — nenhum contrato intermediario chamado
 *        pela proposta consegue reencaminhar a chamada ao Treasury.
 *      - Vetor de re-autorizacao de roles (grantRole): em producao o
 *        Timelock detem DEFAULT_ADMIN_ROLE do Treasury, entao uma proposta
 *        poderia conceder GOVERNANCE_ROLE (ou DEFAULT_ADMIN_ROLE) do
 *        Treasury a um terceiro que chamaria removePOL DIRETO, sem nova
 *        votacao. Por isso o scan tambem marca como Supermajority QUALQUER
 *        call de gestao de roles ({IAccessControl.grantRole},
 *        {IAccessControl.revokeRole}, {IAccessControl.renounceRole}) com
 *        target no TREASURY.
 *      - Vetor equivalente no Timelock: conceder PROPOSER_ROLE do Timelock a
 *        um terceiro permitiria agendar um removePOL fora do Governor (o
 *        Timelock e o detentor da GOVERNANCE_ROLE do Treasury). O scan
 *        portanto marca como Supermajority tambem calls de gestao de roles
 *        com target no proprio Timelock ({timelock()}).
 *      - Nested calls nao escapam: qualquer grantRole no Treasury/Timelock
 *        exige `msg.sender` com a role admin correspondente (Timelock em
 *        producao); um contrato intermediario chamado pela proposta nunca e
 *        o Timelock, entao a indirecao falha no AccessControl.
 *      - Batch misto: uma proposta que mistura removePOL (ou gestao de
 *        roles do Treasury/Timelock) com outras calls e contaminada INTEIRA
 *        pelo tipo Supermajority. Correto por design — caso contrario,
 *        empacotar a call sensivel junto de calls populares seria exatamente
 *        o vetor de diluicao do requisito de 75%.
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

    /// @notice Selector de {Treasury.removePOL}
    ///         (`removePOL(uint128,uint256,uint256,uint256)` = 0x6a71d4b3).
    ///         Derivado do proprio tipo {Treasury} — o compilador garante
    ///         sincronia se a assinatura mudar em refactor futuro.
    bytes4 public constant REMOVE_POL_SELECTOR = Treasury.removePOL.selector;

    /// @notice Selector de {IAccessControl.grantRole}
    ///         (`grantRole(bytes32,address)` = 0x2f2ff15d). Gestao de roles
    ///         do Treasury/Timelock e vetor de bypass do gate de 75%
    ///         (re-autorizar quem pode chamar removePOL) — ver NatSpec do
    ///         contrato.
    bytes4 public constant GRANT_ROLE_SELECTOR = IAccessControl.grantRole.selector;

    /// @notice Selector de {IAccessControl.revokeRole}
    ///         (`revokeRole(bytes32,address)` = 0xd547741f).
    bytes4 public constant REVOKE_ROLE_SELECTOR = IAccessControl.revokeRole.selector;

    /// @notice Selector de {IAccessControl.renounceRole}
    ///         (`renounceRole(bytes32,address)` = 0x36568abe).
    bytes4 public constant RENOUNCE_ROLE_SELECTOR = IAccessControl.renounceRole.selector;

    /// @notice Endereco do {Treasury} cuja remocao de POL exige
    ///         supermaioria. Imutavel — em deploy dev sem treasury pode ser
    ///         `address(0)`, e nesse caso o scan de {propose} nunca marca
    ///         proposta alguma como Supermajority.
    address public immutable TREASURY;

    /// @notice `true` se a proposta `proposalId` foi marcada como
    ///         {ProposalType.Supermajority} no {propose} (contem ao menos
    ///         uma call `TREASURY.removePOL`). Default `false` = Standard.
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
     * @param treasury Endereco do {Treasury} para o scan de removePOL em
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
     *         call do batch tem `target == TREASURY` com selector de
     *         {Treasury.removePOL} OU de gestao de roles
     *         (grantRole/revokeRole/renounceRole), ou `target == timelock()`
     *         com selector de gestao de roles, a proposta INTEIRA e marcada
     *         como Supermajority (75%). Emite {ProposalTypeSet} sempre
     *         (tambem para Standard), para indexacao off-chain.
     * @dev Decisao de design: a fracao ">25% do POL" nao e mensuravel no
     *      momento do propose (a liquidez da posicao muda entre propose e
     *      execute), entao TODA proposta contendo removePOL exige 75% —
     *      conservador por design. Gestao de roles do Treasury/Timelock
     *      entra no mesmo gate porque re-autoriza quem pode chamar removePOL
     *      (grant de GOVERNANCE_ROLE/DEFAULT_ADMIN_ROLE do Treasury, grant
     *      de PROPOSER_ROLE do Timelock) — sem isso uma proposta de maioria
     *      simples contornaria o requisito de 75%. Ver NatSpec do contrato
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
            address timelockAddr = timelock();
            uint256 len = targets.length;
            for (uint256 i = 0; i < len; ++i) {
                if (calldatas[i].length < 4) {
                    continue;
                }
                bytes4 selector = bytes4(calldatas[i]);
                bool sensitiveTreasuryCall = targets[i] == TREASURY &&
                    (selector == REMOVE_POL_SELECTOR || _isRoleManagementSelector(selector));
                bool sensitiveTimelockCall = targets[i] == timelockAddr && _isRoleManagementSelector(selector);
                if (sensitiveTreasuryCall || sensitiveTimelockCall) {
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
     *      {Treasury.removePOL}, entao exige a mesma supermaioria de 75%.
     */
    function _isRoleManagementSelector(bytes4 selector) internal pure returns (bool) {
        return
            selector == GRANT_ROLE_SELECTOR ||
            selector == REVOKE_ROLE_SELECTOR ||
            selector == RENOUNCE_ROLE_SELECTOR;
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
