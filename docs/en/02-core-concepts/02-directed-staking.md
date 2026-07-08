# Directed staking

**Audience:** dev or staker wanting to understand what staking GOV does and how weight is computed.
**Prerequisites:** [Dual-token](01-dual-token-economy.md).

> **Remodel 2026-07-08**: staking GOV **no longer yields CREDIT emission**. In the current model it serves three roles: (1) **curation** — publicly signals which projects you have conviction in; (2) **investment gate** — `invest` and `claim` in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) require GOV staked in the project; (3) **governance** (long-term weight). Investor income comes from **rev-share of real revenue**, not emission.

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

The current consumer of weight is **[ProjectFunding](../08-contracts-reference/16-ProjectFunding.md)**: `invest` and `claim` require `getWeight(investor, projectId) > 0` (skin in the game). The (legacy) `RewardDistributor` queried `...At(block)` at the round's `snapshotBlock`, never the current value — an anti-flashloan protection analogous to `ERC20Votes`, which the checkpoints still provide.

## Unstake

Calling `unstake(projectId, amount)` or `unstakeAll(projectId)`:

- **If the lock has not expired and the project is `Active`, `Pending`, or `Probation`**: reverts with `LockNotExpired`.
- **If the lock expired**: releases `amount` back to the user, updates weight.
- **Exception — project is `Removed`**: the lock is **bypassed**. The DAO removed the project; punishing the staker with a lock would be unfair. Emits `EarlyUnstakeAllowed` + `Unstaked`.

Initial time-based probation does **not** bypass lock. Punitive probation does **not** bypass lock. Only `Status.Removed` bypasses.

## Why directed and not generic

A generic staking ("earn general reward") creates a passive incentive: you stake, wait, collect. The DAO needs someone to **actively select** which projects deserve support — that someone is the staker. It is decentralized curation with skin in the game:

```
   Staker picks projects they believe in
   and locks GOV in them (14-365 day lock)
                |
                v
   The stake opens the funding door: only those
   with GOV staked IN the project can invest
   CREDIT in its round and claim rev-share
   (ProjectFunding)
                |
                v
   If the app sells, the investor receives a %
   of REAL revenue on every payment
   If it does not sell, rev-share = zero

   => whoever funds is whoever already signaled conviction
```

The model punishes bad allocation: capital (locked GOV + invested CREDIT) is tied to the project's success. Supporting everyone "equally" requires staking in each one individually, which costs gas and immobilizes capital in proportion.

## How weight becomes income

In the current model, weight **does not generate emission** — it is the **gate**: with `getWeight(you, projectId) > 0` you can invest CREDIT in the project's round and claim rev-share of gross revenue (1–30%, set in the round). Distribution is pro-rata to investment shares (CREDIT invested, 1:1), not to stake weight. See [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). Important: **unstaking does not forfeit accrued rev-share** — the `claim` is merely held until you stake again (it never expires).

> **Legacy**: in the pre-remodel model, the project's emission slice was divided proportionally to each staker's weight at the round's `snapshotBlock` — see [Rewards distribution (legacy)](04-rewards-distribution.md).

---

**Next →** [Burn-to-mint (legacy)](03-burn-to-mint.md)
