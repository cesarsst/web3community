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
| `treasury` | address | Treasury | Target scanned in `propose` for the supermajority gate (removePOL / role management). `address(0)` accepted in dev without a treasury — in that case the scan never marks a proposal as Supermajority. **Immutable** (`TREASURY`) |
| `initialVotingDelay` | uint48 (blocks) | `7200` (~1d) | Pending → Active |
| `initialVotingPeriod` | uint32 (blocks) | `50400` (~7d) | Voting duration |
| `initialProposalThreshold` | uint256 | `10_000 * 1e18` | Min voting power to propose |
| `initialQuorumNumerator` | uint256 | `4` | % of supply required |
| `name` EIP-712 | string | `"CommunityGovernor"` | **Immutable** |

> **Note**: the constructor gained the `treasury` argument (3rd position, after `token` and `timelock`) in CLP Phase 1.2 — deploy scripts, fixtures and `ignition/modules/Dao.ts` already propagate the Treasury address.

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

After `super.propose`, the Governor **scans** `targets`/`calldatas` and classifies the `ProposalType`. If any call marks the proposal as sensitive, the ENTIRE proposal becomes `Supermajority` (a mixed batch contaminates — correct by design; otherwise packing the sensitive call alongside popular calls would be the vector to dilute the 75% requirement).

- **Reverts**: `GovernorInsufficientProposerVotes` if `getVotes(msg.sender, clock()-1) < proposalThreshold`.
- **Events**: `ProposalCreated(...)` + `ProposalTypeSet(proposalId, proposalType)` (always emitted, also for `Standard`, for off-chain indexing).

## Supermajority 75% for POL removal

The rule "POL removals require a 75% supermajority" — previously just a **cultural norm** — became **code** (Phase 1.2). The gate:

- **Counting**: for `Supermajority` proposals, `_voteSucceeded` requires `forVotes >= 3 * againstVotes` **AND** `forVotes > 0`. This equals For ≥ 75% of the decisive For/Against votes (Abstain stays out of the ratio, consistent with `GovernorCountingSimple`'s `COUNTING_MODE`). Inclusive threshold: an exact 75.0% passes. The `forVotes > 0` guard closes the edge case of quorum reached with Abstain only (without it, `0 >= 3*0` would make the supermajority weaker than a simple majority).
- **What gets marked**: any call with `calldatas[i].length >= 4` whose selector is:
  - `Treasury.removePOL` (`REMOVE_POL_SELECTOR`, `0x6a71d4b3`), with target `== TREASURY`; **or**
  - **role management** (`grantRole` `0x2f2ff15d` / `revokeRole` `0xd547741f` / `renounceRole` `0x36568abe`, derived from `IAccessControl`) with target on the `TREASURY` **or the Timelock itself** (`timelock()`).
- **Selectors are public constants**: `REMOVE_POL_SELECTOR`, `GRANT_ROLE_SELECTOR`, `REVOKE_ROLE_SELECTOR`, `RENOUNCE_ROLE_SELECTOR` — the compiler keeps them in sync if the signatures change.

### Why the ">25% of POL" fraction is not measured at propose

The POL position's liquidity changes between `propose` and `execute` (compounded fees, intermediate adds/removes), so any proportional check at propose would be evadable or imprecise. **Conservative by design**: EVERY proposal containing `removePOL` requires 75%, regardless of the removed fraction.

### Anti-bypass analysis

Why nested calls do not circumvent the rule:

- The Timelock executes exactly the calldatas registered in the approved proposal (the operation hash covers targets/values/calldatas) — there is no way to "inject" an unscanned `removePOL`.
- `Treasury.removePOL` is gated by `GOVERNANCE_ROLE`, granted in production ONLY to the Timelock — no intermediary contract forwards the call.
- **Re-authorization vector (grantRole)**: in production the Timelock holds the Treasury's `DEFAULT_ADMIN_ROLE`; a proposal could grant the Treasury's `GOVERNANCE_ROLE`/`DEFAULT_ADMIN_ROLE` to a third party who would call `removePOL` DIRECTLY. That is why the scan also marks role management with the Treasury as target.
- **Equivalent vector on the Timelock**: granting the Timelock's `PROPOSER_ROLE` to a third party would let it schedule `removePOL` outside the Governor (the Timelock holds the Treasury's `GOVERNANCE_ROLE`). That is why the scan also marks role management targeting the Timelock itself.
- **Nested calls fail at AccessControl**: any `grantRole` on the Treasury/Timelock requires `msg.sender` to hold the admin role (the Timelock); an intermediary contract is never the Timelock.

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
- `TREASURY() → address` — immutable, target of the supermajority scan.
- `proposalRequiresSupermajority(uint256 proposalId) → bool` — `true` if the proposal was marked `Supermajority` at `propose`.
- `REMOVE_POL_SELECTOR / GRANT_ROLE_SELECTOR / REVOKE_ROLE_SELECTOR / RENOUNCE_ROLE_SELECTOR → bytes4` — scanned selectors.

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
| `ProposalTypeSet(proposalId, proposalType)` | Emitted on every `propose` with the type (`Standard` / `Supermajority`) for off-chain indexing |
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
- **75% supermajority for POL (on-chain)**: proposals containing `Treasury.removePOL` — or role management on the Treasury/Timelock, which would re-authorize who can call `removePOL` — require `forVotes >= 3 * againstVotes` AND `forVotes > 0`. A mixed batch contaminates the entire proposal.
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
