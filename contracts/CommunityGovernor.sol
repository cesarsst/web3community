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
    {}

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
