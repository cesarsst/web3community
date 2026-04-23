# Staking

**Audience:** devs reading staker weight, auditors, curious users.
**Prerequisites:** [Directed staking](../02-core-concepts/02-directed-staking.md).

## Quick overview

Vault for staking directed per project. User locks GOV in a specific `projectId` of `ProjectRegistry` and receives `weight = amount * multiplier(lockDuration) / 1e18`. Weight feeds reward share in `RewardDistributor`.

Minimum lock 14 days, accepted maximum unlimited (multiplier saturates at 4x from 365 days). New stake only in `Active` projects. Unstake bypasses lock if project became `Removed`.

## Inheritance

```
ReentrancyGuard (OZ)
```

Uses `SafeERC20`, `Checkpoints.Trace208`, `SafeCast`.

## Parameters and storage

| Name | Type | Value | Description |
|---|---|---|---|
| `MIN_LOCK` | `uint256` constant | `14 days` | Minimum lock |
| `MAX_LOCK` | `uint256` constant | `365 days` | Multiplier saturation |
| `MULTIPLIER_PRECISION` | `uint256` constant | `1e18` | FP precision |
| `MAX_MULTIPLIER` | `uint256` constant | `4e18` | 4x |
| `GOV_TOKEN` | `IERC20` immutable | GOV | Staked token |
| `REGISTRY` | `ProjectRegistry` immutable | Registry | For gating |
| `positions` | mapping | `user → projectId → StakePosition` | Positions |
| `totalStakedByProject` | mapping | `projectId → uint256` | Aggregate GOV |
| `totalStaked` | `uint256` | — | Global |
| `_userWeight` | mapping | `user → projectId → Trace208` | Checkpoints |
| `_projectWeight` | mapping | `projectId → Trace208` | Checkpoints |
| `_globalWeightCheckpoints` | `Trace208` | — | Global |

### Struct `StakePosition`

```solidity
struct StakePosition {
    uint256 amount;
    uint64 lockStartAt;
    uint64 lockDuration;
}
```

## Roles and permissions

**No roles.** Staking is not privileged — every function is business logic (position ownership, project status, lock expiration). Does not use `AccessControl`.

## External functions

### State-changing

#### `stake(uint256 projectId, uint256 amount, uint64 lockDuration)`

Opens or consolidates position. If a position already exists: `newAmount = old + amount`, `newLockDuration = max(remaining, lockDuration)`, `lockStartAt = now` (**reset**).

- **Reverts**: `ZeroAmount`, `LockTooShort`, `ProjectNotActive`, ERC-20 errors.
- **Events**: `Staked(user, projectId, amount, lockDuration, lockStartAt, weight)`.
- **ReentrancyGuard**: yes.

#### `increaseStake(uint256 projectId, uint256 amount)`

Increases `amount` **preserving** `lockStartAt` and `lockDuration`.

- **Reverts**: `ZeroAmount`, `PositionNotFound`, `ProjectNotActive`.
- **Events**: `StakeIncreased(user, projectId, amountAdded, newAmount, newWeight)`.

#### `extendLock(uint256 projectId, uint64 newLockDuration)`

Extends `lockDuration`. Always strictly greater than the current.

- **Reverts**: `PositionNotFound`, `CannotShortenLock`.
- **Events**: `LockExtended(user, projectId, newLockDuration, newWeight)`.

#### `unstake(uint256 projectId, uint256 amount)`

Removes `amount`. If `projectRemoved`, bypasses lock; otherwise requires expired lock.

- **Reverts**: `ZeroAmount`, `PositionNotFound`, `InsufficientStake`, `LockNotExpired`.
- **Events**: `Unstaked(user, projectId, amount, remaining, newWeight)` + (if bypass) `EarlyUnstakeAllowed(user, projectId, amount)`.

#### `unstakeAll(uint256 projectId)`

Shortcut for `unstake` with `amount = position.amount`.

- **Events**: same as `unstake`.

### Views

- `getPosition(user, projectId) → StakePosition`.
- `getWeight(user, projectId) → uint256`.
- `getTotalWeight(projectId) → uint256`.
- `getWeightAt(user, projectId, blockNumber) → uint256` — snapshot.
- `getTotalWeightAt(projectId, blockNumber) → uint256` — snapshot.
- `getGlobalWeight() → uint256`.
- `getGlobalWeightAt(blockNumber) → uint256`.
- `getLockEnd(user, projectId) → uint64` — expiration timestamp.
- `isUnlocked(user, projectId) → bool`.
- `multiplier(lockDuration) → uint256` — pure, computes multiplier.

## Events

| Event | Emitted in | Indexed parameters |
|---|---|---|
| `Staked(user, projectId, amount, lockDuration, lockStartAt, weight)` | `stake` | `user`, `projectId` |
| `StakeIncreased(user, projectId, amountAdded, newAmount, newWeight)` | `increaseStake` | `user`, `projectId` |
| `LockExtended(user, projectId, newLockDuration, newWeight)` | `extendLock` | `user`, `projectId` |
| `Unstaked(user, projectId, amount, remaining, newWeight)` | `unstake`/`unstakeAll` | `user`, `projectId` |
| `EarlyUnstakeAllowed(user, projectId, amount)` | `unstake` with bypass (Removed project) | `user`, `projectId` |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | Constructor with zero address |
| `ZeroAmount()` | `amount == 0` |
| `ProjectNotActive(projectId)` | Status ≠ Active on stake/increase |
| `LockTooShort(provided, minimum)` | `lockDuration < 14 days` |
| `LockNotExpired(unlockAt, nowTs)` | Attempt to unstake before lock end, non-Removed project |
| `CannotShortenLock(current, provided)` | `newLockDuration <= lockDuration` on extend |
| `PositionNotFound(user, projectId)` | Nonexistent position |
| `InsufficientStake(requested, available)` | `amount > position.amount` |

## Invariants

- **I5 (Anti-flashloan on weight)**: `getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` via `Checkpoints.Trace208`, queryable at `blockNumber < block.number`. `RewardDistributor` uses at the round's `snapshotBlock`.
- **I6 (Minimum lock)**: `MIN_LOCK = 14 days`, enforced on stake and extend.
- **Conservation**: `totalStaked == SUM(totalStakedByProject[i])` always. `globalWeight == SUM(projectWeight[i])` always.
- **Bypass only by `Removed`**: probation (initial or punitive) does **not** bypass lock.
- **CEI + ReentrancyGuard**: effects before `safeTransfer`, guard active in every function that moves GOV.

## Important notes

### Three checkpoint rails

The contract maintains **three** weight tracks — per user-project, per project, global. The per-project aggregate is updated in O(1) at each update via diff `newUserWeight - oldUserWeight`. Global same. Avoids iteration over N stakers.

### Multiplier formula

```
multiplier(d) = 1e18                                   if d == 14d
multiplier(d) = 1e18 + (d-14d) * (4e18-1e18)/(365d-14d) if 14d < d < 365d
multiplier(d) = 4e18                                   if d >= 365d
```

Pure, no storage.

### Locks > `MAX_LOCK`

Accepted literally. The multiplier saturates at 4x but the actual time is respected. That is, you can stake with `lockDuration = 2 years` — you get weight 4x × amount, but you cannot unstake before 2 years.

### `stake` consolidation resetting `lockStartAt`

Intentional. Prevents micro-stakes from extending weight indefinitely without re-committing the old amount. If you want to increase amount without resetting the lock, use `increaseStake`.

### Checkpoints `uint48` key

Tick = `block.number` fits in `uint48` for ~8920 years at 1s block time. Value = weight fits in `uint208` with headroom (theoretical max weight: 100M GOV × 4x = 4e26, well below 2^208 ~ 4.11e62).

---

**See also**: [RewardDistributor](07-RewardDistributor.md), [ProjectRegistry](03-ProjectRegistry.md).
