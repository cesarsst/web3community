# CommunityGovernor

**Para quem é:** auditores, devs consultando propostas, delegates.
**Pré-requisitos:** [Governance (conceito)](../02-core-concepts/05-governance.md), [Voting power](../07-governance/02-voting-power.md).

## Visão rápida

Governor canônico da DAO. Composto pelo stack OpenZeppelin 5.0.2:

```
Governor
GovernorSettings
GovernorCountingSimple
GovernorVotes
GovernorVotesQuorumFraction
GovernorTimelockControl
```

Voting power lida do `GovernanceToken` (ERC20Votes) — imune a flash-loans. Toda execução roteada via `CommunityTimelock` com delay.

## Herança

```
Governor (OZ)
GovernorSettings (OZ)
GovernorCountingSimple (OZ)
GovernorVotes (OZ)
GovernorVotesQuorumFraction (OZ)
GovernorTimelockControl (OZ)
```

## Parâmetros (via constructor)

| Parâmetro | Tipo | Em produção | Descrição |
|---|---|---|---|
| `token` | IVotes | GovernanceToken | Fonte de voting power |
| `timelock` | TimelockController | CommunityTimelock | Executor |
| `initialVotingDelay` | uint48 (blocos) | `7200` (~1d) | Pending → Active |
| `initialVotingPeriod` | uint32 (blocos) | `50400` (~7d) | Duração da votação |
| `initialProposalThreshold` | uint256 | `10_000 * 1e18` | Min voting power para propor |
| `initialQuorumNumerator` | uint256 | `4` | % do supply necessário |
| `name` EIP-712 | string | `"CommunityGovernor"` | **Imutável** |

## Roles e permissões

Não usa AccessControl direto. Setters de parâmetros são `onlyGovernance` — chamados apenas pelo `_executor()` (o Timelock).

## Funções externas

### Propose

```solidity
function propose(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    string memory description
) public returns (uint256 proposalId);
```

- **Reverte**: `GovernorInsufficientProposerVotes` se `getVotes(msg.sender, clock()-1) < proposalThreshold`.
- **Eventos**: `ProposalCreated(...)`.

### Voting

```solidity
function castVote(uint256 proposalId, uint8 support) public returns (uint256 weight);
function castVoteWithReason(uint256 proposalId, uint8 support, string reason) public returns (uint256);
function castVoteBySig(uint256 proposalId, uint8 support, uint8 v, bytes32 r, bytes32 s) public returns (uint256);
function castVoteWithReasonAndParamsBySig(...) public returns (uint256);
```

- `support`: 0=Against, 1=For, 2=Abstain.
- **Eventos**: `VoteCast(voter, proposalId, support, weight, reason)`.

### Queue / Execute / Cancel

```solidity
function queue(uint256 proposalId) public returns (uint256);
function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public returns (uint256);

function execute(uint256 proposalId) public payable returns (uint256);
function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public payable returns (uint256);

function cancel(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public returns (uint256);
```

Todas permissionless (após estado apropriado).

- **Eventos**: `ProposalQueued`, `ProposalExecuted`, `ProposalCanceled`.

### Views

- `state(uint256 proposalId) → ProposalState` — enum 0..7.
- `proposalSnapshot(proposalId) → uint256` — bloco de snapshot.
- `proposalDeadline(proposalId) → uint256` — bloco de encerramento.
- `proposalProposer(proposalId) → address`.
- `proposalNeedsQueuing(proposalId) → bool`.
- `proposalEta(proposalId) → uint256` — timestamp estimado de execução.
- `proposalVotes(proposalId) → (against, for, abstain)`.
- `hasVoted(proposalId, account) → bool`.
- `votingDelay() → uint256`.
- `votingPeriod() → uint256`.
- `proposalThreshold() → uint256`.
- `quorum(uint256 timepoint) → uint256`.
- `quorumNumerator() → uint256`.
- `quorumDenominator() → uint256` — `100`.
- `token() → IERC5805`.
- `timelock() → address`.

### Setters (onlyGovernance)

Chamados apenas via proposta executada pelo Timelock:

- `setVotingDelay(uint48 newDelay)`.
- `setVotingPeriod(uint32 newPeriod)`.
- `setProposalThreshold(uint256 newThreshold)`.
- `updateQuorumNumerator(uint256 newNumerator)`.
- `updateTimelock(TimelockController newTimelock)` — raro, mudança crítica.
- `relay(target, value, data)` — executa chamada arbitrária como se fosse o Governor.

## Eventos

| Evento | Descrição |
|---|---|
| `ProposalCreated(id, proposer, targets, values, signatures, calldatas, voteStart, voteEnd, description)` | — |
| `VoteCast(voter, proposalId, support, weight, reason)` | Voto emitido |
| `VoteCastWithParams(voter, proposalId, support, weight, reason, params)` | Voto com params |
| `ProposalQueued(id, etaSeconds)` | Queued no Timelock |
| `ProposalExecuted(id)` | Executado |
| `ProposalCanceled(id)` | Cancelado |
| `VotingDelaySet(old, new)` | — |
| `VotingPeriodSet(old, new)` | — |
| `ProposalThresholdSet(old, new)` | — |
| `QuorumNumeratorUpdated(old, new)` | — |

## Invariantes

- **I4**: voting power isolada em `token()`; execução via Timelock; nenhuma função bypass.
- **I5 (Anti-flashloan)**: `IERC5805.getPastVotes` via ERC20Votes — snapshot imune.
- **I7**: o Governor é o único autorizado a propor ações que o Timelock executa contra `ProjectRegistry`.
- **Domain separator imutável**: `name = "CommunityGovernor"` no EIP-712. Alterar quebraria todas as assinaturas passadas (`castVoteBySig`, `delegateBySig` via token, etc.).
- **Clock em blocos**: `GovernanceToken` não sobrescreve `clock()`. Fallback retorna `block.number`. Delay/period em blocos.

## Observações importantes

### Overrides obrigatórios (múltipla herança)

O contrato resolve conflitos Governor vs extensões em:

- `votingDelay`, `votingPeriod`, `proposalThreshold` (Governor vs GovernorSettings).
- `quorum` (Governor vs GovernorVotesQuorumFraction).
- `state`, `proposalNeedsQueuing`, `_queueOperations`, `_executeOperations`, `_cancel`, `_executor` (Governor vs GovernorTimelockControl).

### `proposalEta` para UI

Retorna `block.timestamp + timelockMinDelay` após queue. Útil para mostrar "executa em X segundos".

### Se precisar mudar quorum

```
governor.updateQuorumNumerator(5);  // muda de 4% para 5%
```

Só via proposta aprovada.

### Se precisar mudar voting delay

```
governor.setVotingDelay(14400);  // ~2 dias a 12s/bloco
```

Só via proposta.

### Quorum é sobre supply no snapshot

```solidity
uint256 quorumNecessario = (getPastTotalSupply(snapshot) * quorumNumerator) / 100;
```

Atende quorum quando `forVotes + abstainVotes >= quorumNecessario`. Usa `getPastTotalSupply` para imunidade a manipulação de supply pós-proposta.

### Inalterabilidade do `name`

O `name` é fixo no constructor do Governor OZ. Ele vai no domain separator do EIP-712. Se renomear em upgrade, todas as assinaturas off-chain prévias viram inválidas. **Nunca renomear sem migração explícita.**

---

**Ver também**: [CommunityTimelock](09-CommunityTimelock.md), [GovernanceToken](01-GovernanceToken.md).
