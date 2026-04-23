# CommunityGovernor

**Audiencia:** auditores, devs consultando propuestas, delegates.
**Requisitos previos:** [Governance (concepto)](../02-core-concepts/05-governance.md), [Voting power](../07-governance/02-voting-power.md).

## Visión rápida

Governor canónico de la DAO. Compuesto por el stack OpenZeppelin 5.0.2:

```
Governor
GovernorSettings
GovernorCountingSimple
GovernorVotes
GovernorVotesQuorumFraction
GovernorTimelockControl
```

El voting power se lee desde el `GovernanceToken` (ERC20Votes) — inmune a flash-loans. Toda ejecución es ruteada vía `CommunityTimelock` con delay.

## Herencia

```
Governor (OZ)
GovernorSettings (OZ)
GovernorCountingSimple (OZ)
GovernorVotes (OZ)
GovernorVotesQuorumFraction (OZ)
GovernorTimelockControl (OZ)
```

## Parámetros (vía constructor)

| Parámetro | Tipo | En producción | Descripción |
|---|---|---|---|
| `token` | IVotes | GovernanceToken | Fuente de voting power |
| `timelock` | TimelockController | CommunityTimelock | Executor |
| `initialVotingDelay` | uint48 (bloques) | `7200` (~1d) | Pending → Active |
| `initialVotingPeriod` | uint32 (bloques) | `50400` (~7d) | Duración de la votación |
| `initialProposalThreshold` | uint256 | `10_000 * 1e18` | Min voting power para proponer |
| `initialQuorumNumerator` | uint256 | `4` | % del supply necesario |
| `name` EIP-712 | string | `"CommunityGovernor"` | **Inmutable** |

## Roles y permisos

No usa AccessControl directo. Los setters de parámetros son `onlyGovernance` — llamados solo por el `_executor()` (el Timelock).

## Funciones externas

### Propose

```solidity
function propose(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    string memory description
) public returns (uint256 proposalId);
```

- **Revierte**: `GovernorInsufficientProposerVotes` si `getVotes(msg.sender, clock()-1) < proposalThreshold`.
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

Todas permissionless (tras el estado apropiado).

- **Eventos**: `ProposalQueued`, `ProposalExecuted`, `ProposalCanceled`.

### Views

- `state(uint256 proposalId) → ProposalState` — enum 0..7.
- `proposalSnapshot(proposalId) → uint256` — bloque del snapshot.
- `proposalDeadline(proposalId) → uint256` — bloque de cierre.
- `proposalProposer(proposalId) → address`.
- `proposalNeedsQueuing(proposalId) → bool`.
- `proposalEta(proposalId) → uint256` — timestamp estimado de ejecución.
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

Llamados solo vía propuesta ejecutada por el Timelock:

- `setVotingDelay(uint48 newDelay)`.
- `setVotingPeriod(uint32 newPeriod)`.
- `setProposalThreshold(uint256 newThreshold)`.
- `updateQuorumNumerator(uint256 newNumerator)`.
- `updateTimelock(TimelockController newTimelock)` — raro, cambio crítico.
- `relay(target, value, data)` — ejecuta llamada arbitraria como si fuera el Governor.

## Eventos

| Evento | Descripción |
|---|---|
| `ProposalCreated(id, proposer, targets, values, signatures, calldatas, voteStart, voteEnd, description)` | — |
| `VoteCast(voter, proposalId, support, weight, reason)` | Voto emitido |
| `VoteCastWithParams(voter, proposalId, support, weight, reason, params)` | Voto con params |
| `ProposalQueued(id, etaSeconds)` | Queued en el Timelock |
| `ProposalExecuted(id)` | Ejecutado |
| `ProposalCanceled(id)` | Cancelado |
| `VotingDelaySet(old, new)` | — |
| `VotingPeriodSet(old, new)` | — |
| `ProposalThresholdSet(old, new)` | — |
| `QuorumNumeratorUpdated(old, new)` | — |

## Invariantes

- **I4**: voting power aislado en `token()`; ejecución vía Timelock; ninguna función bypass.
- **I5 (Anti-flashloan)**: `IERC5805.getPastVotes` vía ERC20Votes — snapshot inmune.
- **I7**: el Governor es el único autorizado a proponer acciones que el Timelock ejecuta contra `ProjectRegistry`.
- **Domain separator inmutable**: `name = "CommunityGovernor"` en el EIP-712. Alterar rompería todas las firmas pasadas (`castVoteBySig`, `delegateBySig` vía token, etc.).
- **Clock en bloques**: `GovernanceToken` no sobrescribe `clock()`. El fallback retorna `block.number`. Delay/period en bloques.

## Observaciones importantes

### Overrides obligatorios (múltiple herencia)

El contrato resuelve conflictos Governor vs extensiones en:

- `votingDelay`, `votingPeriod`, `proposalThreshold` (Governor vs GovernorSettings).
- `quorum` (Governor vs GovernorVotesQuorumFraction).
- `state`, `proposalNeedsQueuing`, `_queueOperations`, `_executeOperations`, `_cancel`, `_executor` (Governor vs GovernorTimelockControl).

### `proposalEta` para UI

Retorna `block.timestamp + timelockMinDelay` tras el queue. Útil para mostrar "ejecuta en X segundos".

### Si hay que cambiar quorum

```
governor.updateQuorumNumerator(5);  // muda de 4% para 5%
```

Solo vía propuesta aprobada.

### Si hay que cambiar voting delay

```
governor.setVotingDelay(14400);  // ~2 dias a 12s/bloco
```

Solo vía propuesta.

### El quorum es sobre supply en el snapshot

```solidity
uint256 quorumNecessario = (getPastTotalSupply(snapshot) * quorumNumerator) / 100;
```

Se alcanza quorum cuando `forVotes + abstainVotes >= quorumNecessario`. Usa `getPastTotalSupply` para inmunidad a manipulación de supply post-propuesta.

### Inalterabilidad del `name`

El `name` es fijo en el constructor del Governor OZ. Va en el domain separator del EIP-712. Si lo renombras en upgrade, todas las firmas off-chain previas se vuelven inválidas. **Nunca renombrar sin migración explícita.**

---

**Ver también**: [CommunityTimelock](09-CommunityTimelock.md), [GovernanceToken](01-GovernanceToken.md).
