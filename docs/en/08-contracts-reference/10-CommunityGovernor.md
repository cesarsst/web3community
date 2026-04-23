# CommunityGovernor

**Audience:** auditors, devs consulting proposals, delegates.
**Prerequisites:** [Governance (concept)](../02-core-concepts/05-governance.md), [Voting power](../07-governance/02-voting-power.md).

## Quick overview

The DAO's canonical Governor. Composed of the OpenZeppelin 5.0.2 stack:

```
Governor
GovernorSettings
GovernorCountingSimple
GovernorVotes
GovernorVotesQuorumFraction
GovernorTimelockControl
```

Voting power is read from `GovernanceToken` (ERC20Votes) — immune to flash loans. All execution routed via `CommunityTimelock` with delay.

## Inheritance

```
Governor (OZ)
GovernorSettings (OZ)
GovernorCountingSimple (OZ)
GovernorVotes (OZ)
GovernorVotesQuorumFraction (OZ)
GovernorTimelockControl (OZ)
```

## Parameters (via constructor)

| Parameter | Type | In production | Description |
|---|---|---|---|
| `token` | IVotes | GovernanceToken | Voting power source |
| `timelock` | TimelockController | CommunityTimelock | Executor |
| `initialVotingDelay` | uint48 (blocks) | `7200` (~1d) | Pending → Active |
| `initialVotingPeriod` | uint32 (blocks) | `50400` (~7d) | Voting duration |
| `initialProposalThreshold` | uint256 | `10_000 * 1e18` | Min voting power to propose |
| `initialQuorumNumerator` | uint256 | `4` | % of supply required |
| `name` EIP-712 | string | `"CommunityGovernor"` | **Immutable** |

## Roles and permissions

Does not use AccessControl directly. Parameter setters are `onlyGovernance` — called only by `_executor()` (the Timelock).

## External functions

### Propose

```solidity
function propose(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    string memory description
) public returns (uint256 proposalId);
```

- **Reverts**: `GovernorInsufficientProposerVotes` if `getVotes(msg.sender, clock()-1) < proposalThreshold`.
- **Events**: `ProposalCreated(...)`.

### Voting

```solidity
function castVote(uint256 proposalId, uint8 support) public returns (uint256 weight);
function castVoteWithReason(uint256 proposalId, uint8 support, string reason) public returns (uint256);
function castVoteBySig(uint256 proposalId, uint8 support, uint8 v, bytes32 r, bytes32 s) public returns (uint256);
function castVoteWithReasonAndParamsBySig(...) public returns (uint256);
```

- `support`: 0=Against, 1=For, 2=Abstain.
- **Events**: `VoteCast(voter, proposalId, support, weight, reason)`.

### Queue / Execute / Cancel

```solidity
function queue(uint256 proposalId) public returns (uint256);
function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public returns (uint256);

function execute(uint256 proposalId) public payable returns (uint256);
function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public payable returns (uint256);

function cancel(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public returns (uint256);
```

All permissionless (after the appropriate state).

- **Events**: `ProposalQueued`, `ProposalExecuted`, `ProposalCanceled`.

### Views

- `state(uint256 proposalId) → ProposalState` — enum 0..7.
- `proposalSnapshot(proposalId) → uint256` — snapshot block.
- `proposalDeadline(proposalId) → uint256` — closing block.
- `proposalProposer(proposalId) → address`.
- `proposalNeedsQueuing(proposalId) → bool`.
- `proposalEta(proposalId) → uint256` — estimated execution timestamp.
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

Called only via a proposal executed by the Timelock:

- `setVotingDelay(uint48 newDelay)`.
- `setVotingPeriod(uint32 newPeriod)`.
- `setProposalThreshold(uint256 newThreshold)`.
- `updateQuorumNumerator(uint256 newNumerator)`.
- `updateTimelock(TimelockController newTimelock)` — rare, critical change.
- `relay(target, value, data)` — executes arbitrary call as if it were the Governor.

## Events

| Event | Description |
|---|---|
| `ProposalCreated(id, proposer, targets, values, signatures, calldatas, voteStart, voteEnd, description)` | — |
| `VoteCast(voter, proposalId, support, weight, reason)` | Vote cast |
| `VoteCastWithParams(voter, proposalId, support, weight, reason, params)` | Vote with params |
| `ProposalQueued(id, etaSeconds)` | Queued in the Timelock |
| `ProposalExecuted(id)` | Executed |
| `ProposalCanceled(id)` | Canceled |
| `VotingDelaySet(old, new)` | — |
| `VotingPeriodSet(old, new)` | — |
| `ProposalThresholdSet(old, new)` | — |
| `QuorumNumeratorUpdated(old, new)` | — |

## Invariants

- **I4**: voting power isolated in `token()`; execution via Timelock; no bypass function.
- **I5 (Anti-flashloan)**: `IERC5805.getPastVotes` via ERC20Votes — immune snapshot.
- **I7**: the Governor is the only one authorized to propose actions the Timelock executes against `ProjectRegistry`.
- **Immutable domain separator**: `name = "CommunityGovernor"` in EIP-712. Changing would break every past signature (`castVoteBySig`, `delegateBySig` via token, etc.).
- **Block-based clock**: `GovernanceToken` does not override `clock()`. Fallback returns `block.number`. Delay/period in blocks.

## Important notes

### Mandatory overrides (multiple inheritance)

The contract resolves Governor vs extensions conflicts in:

- `votingDelay`, `votingPeriod`, `proposalThreshold` (Governor vs GovernorSettings).
- `quorum` (Governor vs GovernorVotesQuorumFraction).
- `state`, `proposalNeedsQueuing`, `_queueOperations`, `_executeOperations`, `_cancel`, `_executor` (Governor vs GovernorTimelockControl).

### `proposalEta` for UI

Returns `block.timestamp + timelockMinDelay` after queue. Useful to display "executes in X seconds".

### If you need to change quorum

```
governor.updateQuorumNumerator(5);  // changes from 4% to 5%
```

Only via approved proposal.

### If you need to change voting delay

```
governor.setVotingDelay(14400);  // ~2 days at 12s/block
```

Only via proposal.

### Quorum is over supply at the snapshot

```solidity
uint256 quorumRequired = (getPastTotalSupply(snapshot) * quorumNumerator) / 100;
```

Meets quorum when `forVotes + abstainVotes >= quorumRequired`. Uses `getPastTotalSupply` for immunity to supply manipulation after proposal.

### `name` immutability

The `name` is fixed in the OZ Governor's constructor. It goes into the EIP-712 domain separator. If renamed in an upgrade, every previous off-chain signature becomes invalid. **Never rename without an explicit migration.**

---

**See also**: [CommunityTimelock](09-CommunityTimelock.md), [GovernanceToken](01-GovernanceToken.md).
