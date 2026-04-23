# CommunityTimelock

**Audience:** anyone needing to audit the governance's executor layer.
**Prerequisites:** [Governance (concept)](../02-core-concepts/05-governance.md).

## Quick overview

Identity wrapper over OpenZeppelin 5.0.2's `TimelockController`. Executes, with delay, all decisions approved by `CommunityGovernor`. In production, it is the sole holder of `GOVERNANCE_ROLE` / `DEFAULT_ADMIN_ROLE` in the economic contracts (Treasury, Registry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy) and is `owner` of the GovernanceToken.

No additional code — inherits entire `TimelockController`. Reason: keep on-chain identity (name "CommunityTimelock" on Etherscan) without introducing extra surface.

## Inheritance

```
TimelockController (OZ 5.0.2)
  - AccessControl
  - IERC721Receiver (to receive NFTs via transfer)
  - IERC1155Receiver (ditto)
```

## Parameters (via constructor, inherited)

```solidity
constructor(
    uint256 minDelay,
    address[] memory proposers,
    address[] memory executors,
    address admin
)
```

### Production values

| Parameter | Value | Reason |
|---|---|---|
| `minDelay` | `172800` (2 days) | Reaction window for malicious proposal |
| `proposers` | `[]` | Governor is granted via `grantRole` at deploy |
| `executors` | `[address(0)]` | Anyone can execute after the delay |
| `admin` | deployer (bootstrap), renounced after handoff | Timelock becomes self-administered |

## Roles (defined in `TimelockController`)

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | **Self** (Timelock is admin of itself) |
| `PROPOSER_ROLE` | `CommunityGovernor` |
| `CANCELLER_ROLE` | `CommunityGovernor` |
| `EXECUTOR_ROLE` | `address(0)` — any address executes |

## External functions (inherited from TimelockController)

### Proposal → scheduling

#### `schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)`

Schedules a single operation. Requires `PROPOSER_ROLE`.

#### `scheduleBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt, uint256 delay)`

Batch.

### Execution

#### `execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt)`

Executes a single operation after `minDelay`. Requires `EXECUTOR_ROLE` — in production it is `address(0)`, so anyone calls.

#### `executeBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt)`

Batch.

### Cancellation

#### `cancel(bytes32 id)`

Cancels a pending operation. Requires `CANCELLER_ROLE`.

### Views

- `getMinDelay() → uint256`.
- `hashOperation(target, value, data, predecessor, salt) → bytes32`.
- `hashOperationBatch(...) → bytes32`.
- `isOperation(id) → bool`.
- `isOperationPending(id) → bool`.
- `isOperationReady(id) → bool` — passed the delay.
- `isOperationDone(id) → bool`.
- `getTimestamp(id) → uint256` — timestamp when it becomes ready.

### Admin

#### `updateDelay(uint256 newDelay)`

Adjusts `minDelay`. Can only be called by `this` (auto-governance) — requires approved proposal.

- **Events**: `MinDelayChange(oldDuration, newDuration)`.

## Events (inherited)

- `CallScheduled(id, index, target, value, data, predecessor, delay)`.
- `CallExecuted(id, index, target, value, data)`.
- `CallSalt(id, salt)`.
- `Cancelled(id)`.
- `MinDelayChange(oldDuration, newDuration)`.

## Invariants

- **Self-administered post-handoff**: `DEFAULT_ADMIN_ROLE` belongs to the Timelock itself. Role change requires approved proposal.
- **Proposer = Governor**: sole authorized to `schedule`.
- **Open executor**: any address executes after the delay (the delay is already the security gate).
- **Canceller = Governor**: only via `_cancel` in a counter-proposal. No unilateral guardian in v1.
- **Timelock cannot be "bypassed"**: every state-changing function of the economic contracts requires `GOVERNANCE_ROLE`, which is exclusive to the Timelock.

## Important notes

### Why `address(0)` as executor

Operation parameters and targets are already immutable after `schedule`. The delay has already expired when someone calls `execute`. Requiring a dedicated `EXECUTOR_ROLE` would only add operational friction — it would always need an active executor EOA. Any party can click "execute" without altering the result.

### `CANCELLER_ROLE` only with Governor

`GovernorTimelockControl._cancel` calls `Timelock.cancel` when canceling a proposal via governance. We do not grant `CANCELLER_ROLE` to anyone else (nor a multisig guardian) — an external canceler could DoS valid proposals, violating "the vote is the source of truth".

### Practical immutability

Even though the Timelock is `self-administered`, there is no "upgrade" of the contract itself. If the DAO needs Timelock v2, it must:

1. Deploy new Timelock.
2. Propose via v1: grant `GOVERNANCE_ROLE` (new) and revoke (v1) in all economic contracts.
3. Similar for GovernanceToken `transferOwnership`.
4. Propose in Governor v1 to change `timelock` reference (if Governor supports) or deploy a new Governor.

That path is complex and requires multiple proposals — intentional.

### Recommended deploy strategy

1. Deploy Timelock with `proposers = []`, `executors = [0x0]`, `admin = deployer`.
2. Deploy Governor pointing at Timelock.
3. Deployer: `grantRole(PROPOSER_ROLE, governor)` + `grantRole(CANCELLER_ROLE, governor)`.
4. Deployer: `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`. Timelock becomes self-administered.

Documented in [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

### No `PAUSE`

There is no unilateral pause button. If it is necessary to stop some operation, the DAO approves a specific proposal — for example, `Registry.setProbation` to suspend a malicious project.

---

**See also**: [CommunityGovernor](10-CommunityGovernor.md).
