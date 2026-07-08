# Staking in projects

**Audience:** someone who already has GOV and wants to support projects — and unlock the right to invest in their rounds.
**Prerequisites:** [Directed staking (concept)](../02-core-concepts/02-directed-staking.md), [Holding GOV](02-holding-gov.md).

> **Remodel 2026-07-08**: staking GOV **no longer yields CREDIT emission**. The stake is curation + **investment gate**: only those with GOV staked in the project can invest CREDIT in its round in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) and claim rev-share of real revenue.

## The mental model in 3 lines

1. You pick **one** project (`projectId`).
2. You lock GOV for **14 to 365+ days** — multiplier 1x to 4x.
3. With the stake active, you can **invest CREDIT in the project's round** and receive a % of its gross revenue on every payment (rev-share, pro-rata to what you invested).

## Picking a project

Before staking, check in the Registry:

- Status = `Active` (projects in `Pending`/`Probation`/`Removed` block new stake).
- On-chain historical GMV (`FeeRouterV2.grossVolumeOf`) — signal of real traction.
- The funding round, if any: target, rev-share (1-30%), deadline, how much has been raised.

Tools (via hub UI):

```solidity
// status
registry.getProject(projectId);            // full struct
registry.isActive(projectId);              // bool

// real traction
feeRouterV2.grossVolumeOf(projectId);      // accumulated GMV
funding.totalRevenueDistributed(projectId);// revenue already paid to investors

// funding round
funding.rounds(projectId);                 // target, raised, deadline, revShareBps, status

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

- For the ProjectFunding **investment gate**, any weight > 0 is enough — including the minimum lock (14d, 1x).
- Medium lock (90-180d, 1.6x–2.4x): flexibility vs curation/signaling weight, a good default.
- Maximum lock (365d, 4x): maximizes weight per GOV. Use if you are confident in the project for a year.
- Lock > 365d: adds no weight, only adds immobilization. Rarely worth it unless you want to signal extreme commitment.
- Remember: you must **keep** GOV staked in the project to claim rev-share (`claim`) — size the lock along with your investment horizon.

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

The stake itself **does not generate income** — it unlocks the investment. Income comes from [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md):

```
1. With GOV staked in the project, invest CREDIT in the open round:
   funding.invest(projectId, amount)      [shares = CREDIT invested, 1:1]

2. Round hits the target (Funded) -> rev-share activates

3. On every payment to the app (FeeRouterV2.pay), your slice accrues:
   your_slice = payment_revShare × your_shares / total_raised

4. Withdraw whenever you want: funding.claim(projectId)
   (requires GOV still staked; never expires)
```

The return is a **slice of real revenue** — verifiable on-chain via `pendingRevenue(projectId, you)` and `totalRevenueDistributed(projectId)`.

## Hypothetical simulation

Alice stakes 50,000 GOV in `projectId=42` with a 365-day lock (gate active). The project opened a 10,000 CREDIT round with 8% rev-share; Alice invests 2,500 CREDIT (25% of shares) and the round closes Funded. The app earns 2,000 CREDIT/month of GMV:

```
project's monthly revShare = 2,000 × 8% = 160 CREDIT
Alice's slice              = 160 × 2,500 / 10,000 = 40 CREDIT/month
per year                   = 480 CREDIT  (~19.2% p.a. on the 2,500 invested)
```

Illustrative — reality depends 100% on the app's revenue. Without GMV, there is no payout. The CREDIT received is stable: redeemable 1:1 for USDC in the PSM.

> **Legacy**: in the pre-remodel model, the staker claimed emitted CREDIT proportional to the project's burn (55% stakers bucket). The old formula is in [Rewards distribution (legacy)](../02-core-concepts/04-rewards-distribution.md); historical claims remain withdrawable.

## Useful edge cases

**Stake in more than one project**: each `projectId` is an independent position. You can stake in 5 different projects if you have enough GOV.

**Emergency exit by Removal**: if the DAO removes the project via proposal, your lock is bypassed. Emits `EarlyUnstakeAllowed` along with `Unstaked` — you can withdraw immediately.

**Extend vs stake**: `extendLock` does **not** change the amount. `stake` on an existing position **adds to the amount** and may increase the lock. Use accordingly.

**Lock expired and you did not withdraw**: your position still generates weight with the original multiplier. If you want to stop generating weight, do `unstake` or `unstakeAll`. Simply ignoring = weight keeps accruing.

---

**Next →** [Voting on proposals](04-voting.md)
