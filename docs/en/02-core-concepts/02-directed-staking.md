# Directed staking

**Audience:** dev or staker wanting to understand how reward weight is computed.
**Prerequisites:** [Dual-token](01-dual-token-economy.md).

## What "directed" means

When you call `Staking.stake(projectId, amount, lockDuration)`:

1. You choose **one** valid `projectId` in `ProjectRegistry` (the project must be `Active`).
2. You transfer `amount` of GOV to the `Staking` contract.
3. You accept a lock (minimum 14 days) during which you cannot withdraw.

Your weight becomes:

```
weight = amount * multiplier(lockDuration) / 1e18
```

where `multiplier` is linear between 1x (14 days) and 4x (365 days), saturating at 4x above. See `Staking._multiplier`.

**Weight only counts for that `projectId`.** Stake in another project = another position, another weight, independent accounting.

## Lock parameters

| Constant | Value | Semantics | Source |
|---|---|---|---|
| `MIN_LOCK` | 14 days | Minimum accepted lock. Below that, `stake` reverts with `LockTooShort`. | `Staking.MIN_LOCK` |
| `MAX_LOCK` | 365 days | **Multiplier saturation point** (not the maximum accepted lock — see note below). | `Staking.MAX_LOCK` |
| `MULTIPLIER_PRECISION` | 1e18 | Base of the weight arithmetic. | `Staking.MULTIPLIER_PRECISION` |
| `MAX_MULTIPLIER` | 4e18 | Maximum multiplier (applied when `lockDuration >= MAX_LOCK`). | `Staking.MAX_MULTIPLIER` |

> **Important — `MAX_LOCK` is saturation, not an accepted ceiling.** Locks above 365 days **are accepted literally**: the multiplier saturates at 4x, but the actual lock time is respected on `unstake`. The internal comment of `Staking.stake` (line 427) documents: "Locks above `{MAX_LOCK}` are accepted literally: the multiplier saturates at 4x, but the actual time is respected at unstake." This enables "veCRV-like" profiles (e.g., a 4-year lock for public signaling) without introducing an arbitrary cap. Locks below 14 days revert with `LockTooShort`.

## Position consolidation

A position is identified by `(user, projectId)`. There can be only **one** per pair. If you call `stake` on a pair that already has a position:

- `newAmount = old.amount + amount`
- `newLockDuration = max(remaining, lockDuration)` (the greater of the remaining old lock and the newly requested lock)
- `lockStartAt = block.timestamp` (**reset**)

Resetting `lockStartAt` is intentional. Without it, a user could extend weight indefinitely with micro-stakes without re-committing the old amount.

If you want to **increase** amount without resetting the lock, use `increaseStake(projectId, amount)` — preserves current `lockStartAt` and `lockDuration`.

If you want to **extend** the lock without touching the amount, use `extendLock(projectId, newLockDuration)` — always strictly greater than current.

## Weight as snapshot

Weight is historicized in `Checkpoints.Trace208` (OpenZeppelin) with key = `block.number` and value = `uint208`. Three parallel rails:

- **Per user-project** (`_userWeight[user][projectId]`)
- **Per project** (`_projectWeight[projectId]`) — sum across all users
- **Global** (`_globalWeightCheckpoints`) — sum across all projects

Queries:

- `getWeight(user, projectId)` — current weight.
- `getWeightAt(user, projectId, blockNumber)` — historical weight at block X.
- `getTotalWeight(projectId)` — current aggregate project weight.
- `getTotalWeightAt(projectId, blockNumber)` — historical.
- `getGlobalWeight()`, `getGlobalWeightAt(blockNumber)` — global weight.

`RewardDistributor` **always** queries `...At(block)` at the round's `snapshotBlock`, never the current value. That is the anti-flashloan protection analogous to `ERC20Votes`.

## Unstake

Calling `unstake(projectId, amount)` or `unstakeAll(projectId)`:

- **If the lock has not expired and the project is `Active`, `Pending`, or `Probation`**: reverts with `LockNotExpired`.
- **If the lock expired**: releases `amount` back to the user, updates weight.
- **Exception — project is `Removed`**: the lock is **bypassed**. The DAO removed the project; punishing the staker with a lock would be unfair. Emits `EarlyUnstakeAllowed` + `Unstaked`.

Initial time-based probation does **not** bypass lock. Punitive probation does **not** bypass lock. Only `Status.Removed` bypasses.

## Why directed and not generic

A generic staking ("earn general reward") creates a passive incentive: you stake, wait, collect. The DAO needs someone to **actively select** which projects deserve support — that someone is the staker. It is almost decentralized curation:

```
   Staker picks projects they believe
   will generate burn (= usage)
                |
                v
   Weight is tied to that project's success
                |
                v
   If project generates burn, staker earns reward
   If not, reward = zero for them

   => staker only wins if they picked well
```

The model punishes bad allocation. Supporting everyone "equally" requires staking in each one individually, which costs gas and immobilizes capital in proportion.

## How weight becomes reward

See [Rewards distribution](04-rewards-distribution.md). In short: inside a `projectId`, the project's emission slice is divided proportionally to each staker's weight at the round's `snapshotBlock`.

---

**Next →** [Burn-to-mint](03-burn-to-mint.md)
