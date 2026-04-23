# Staking in projects

**Audience:** someone who already has GOV and wants to receive CREDIT as reward.
**Prerequisites:** [Directed staking (concept)](../02-core-concepts/02-directed-staking.md), [Holding GOV](02-holding-gov.md).

## The mental model in 3 lines

1. You pick **one** project (`projectId`).
2. You lock GOV for **14 to 365+ days** — multiplier 1x to 4x.
3. Rounds later, you claim CREDIT proportional to the burn that project generated × how much your weight represents inside the project.

## Picking a project

Before staking, check in the Registry:

- Status = `Active` (projects in `Pending`/`Probation`/`Removed` block new stake).
- Project age (if in initial time-based probation, share is /4).
- Historical burn in the last rounds (signal of real traction).

Tools (via hub UI):

```solidity
// status
registry.getProject(projectId);            // full struct
registry.isActive(projectId);              // bool
registry.isInProbation(projectId);         // initial time-based probation

// historical burn
burnTracker.getBurnForProjectInRound(round, projectId);

// competition
staking.getTotalWeight(projectId);         // how much weight already in the project
```

## Picking the lock

Function in `Staking._multiplier`:

- `< 14 days`: reverts (`LockTooShort`).
- `14 days`: multiplier = 1x.
- `365 days`: multiplier = 4x.
- Between 14 and 365 days: linear.
- `> 365 days`: accepted, multiplier saturates at 4x (and the actual lock is respected).

```
  multiplier
       ^
   4x  |-----______________________
       |          _ _ _
   3x  |     ___-
       |   _-
   2x  | _-
       |_-
   1x  |
       +-------------------------------->  lockDuration
      14d                 365d
```

**Rules of thumb:**

- Minimum possible lock (14d, 1x): only worth it if you are sure you will exit early. Low effective APR.
- Medium lock (90-180d, 1.6x–2.4x): flexibility vs weight, a good default.
- Maximum lock (365d, 4x): maximizes weight per GOV. Use if you are confident in the project for a year.
- Lock > 365d: adds no weight, only adds immobilization. Rarely worth it unless you want to signal extreme commitment.

## The `stake` operation

```solidity
// Prereq: you have GOV and have already approved Staking
GOV.approve(staking, amount);

// Staking
staking.stake(
    uint256 projectId,     // the chosen project
    uint256 amount,        // wei of GOV
    uint64 lockDuration    // seconds, >= 14 days
);
```

The function reverts if:

- `amount == 0` — `ZeroAmount`.
- `lockDuration < 14 days` — `LockTooShort`.
- Project is not `Active` — `ProjectNotActive`.
- Insufficient allowance — `ERC20InsufficientAllowance`.
- Insufficient balance — `ERC20InsufficientBalance`.

On success:

- GOV goes to the Staking contract.
- `positions[you][projectId]` stores `{amount, lockStartAt=now, lockDuration}`.
- Three checkpoints are written at `block.number`.
- Weight is computed as `amount * multiplier(lockDuration) / 1e18`.

## Subsequent operations

### `increaseStake(projectId, amount)`

Increases amount **without resetting the lock**. `lockStartAt` and `lockDuration` stay the same.

Consequence: weight increases proportionally. If the lock already expired, you can immediately call `unstake` with the new amount — `increaseStake` does not reopen the lock.

### `extendLock(projectId, newLockDuration)`

Increases `lockDuration` (always strictly greater than current). `lockStartAt` does **not** change. Increases weight.

Useful when your lock is about to expire and you want to extend the position without losing weight.

### `stake` when there is already a position (consolidation)

If you call `stake` and you already have a position in `(user, projectId)`:

- `newAmount = old.amount + amount`.
- `newLockDuration = max(remaining, lockDuration)` — the greater between "what was left of the old lock" and "the newly requested lock".
- **`lockStartAt` is reset** to `block.timestamp`.

This is different from `increaseStake` — `stake` resets the lock. Conscious choice:

- `stake`: when you want to re-commit time.
- `increaseStake`: when you only want to increase the principal.

## Unstake

```solidity
staking.unstake(projectId, amount);     // partial
staking.unstakeAll(projectId);          // full
```

Conditions:

- `amount > 0` and `amount <= position.amount`.
- **Lock expired**: `block.timestamp >= lockStartAt + lockDuration`.
- **OR project is `Removed`** — lock bypass.

If the lock is still active and the project is not `Removed`, it reverts with `LockNotExpired`.

**Important note**: punitive probation (`Status.Probation`) does **NOT** bypass the lock. Only `Status.Removed` bypasses.

## What you earn

After each round R is `finalizeRound`ed, you can claim reward:

```
amount = projectShare(round, projectId)
       × yourWeight(round)
       ÷ totalWeight(round)

projectShare = totalEmission × projectBurnInR-1 ÷ totalBurnR-1
             (if no burn: via global weight)

If project in initial probation: projectShare /= 4.
```

The full formula is in [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Hypothetical simulation

Alice staked 50,000 GOV in `projectId=42` with a 365-day lock (weight = 200k). The project generated 600k of burn in round R-1, total for the round was 950k, emission of round R is 902k CREDIT. Total weight in the project (including Alice) is 400k.

```
projectShare = 902_000 × 600_000 / 950_000 = 569,684 CREDIT
aliceShare   = 569,684 × 200,000 / 400,000 = 284,842 CREDIT
```

Alice claims 284,842 CREDIT in round R. If the round is weekly and she keeps the position for a year with similar burn, she captures ~14.8M CREDIT over 52 rounds (illustrative — reality depends on usage dynamics).

## Useful edge cases

**Stake in more than one project**: each `projectId` is an independent position. You can stake in 5 different projects if you have enough GOV.

**Emergency exit by Removal**: if the DAO removes the project via proposal, your lock is bypassed. Emits `EarlyUnstakeAllowed` along with `Unstaked` — you can withdraw immediately.

**Extend vs stake**: `extendLock` does **not** change the amount. `stake` on an existing position **adds to the amount** and may increase the lock. Use accordingly.

**Lock expired and you did not withdraw**: your position still generates weight with the original multiplier. If you want to stop generating weight, do `unstake` or `unstakeAll`. Simply ignoring = weight keeps accruing.

---

**Next →** [Voting on proposals](04-voting.md)
