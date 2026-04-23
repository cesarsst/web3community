# Rewards distribution

**Audience:** stakers and devs wanting to understand exactly how a round's pool becomes a user claim.
**Prerequisites:** [Directed staking](02-directed-staking.md), [Burn-to-mint](03-burn-to-mint.md).

## Full lifecycle of a round

```
[Round R-1 open in BurnTracker]

Users pay in apps via FeeRouter
  -> FeeRouter.burnByRole 95% of value via BurnTracker.burnAndRecord
  -> BurnTracker increments:
       burnByRoundProject[R-1][projectId] += amount
       totalBurnByRound[R-1]              += amount
       projectsWithBurnCount[R-1]         += 1 (first time per project)

[End of round target window (roundDuration)]

Governance calls closeRound()
  -> currentRound goes from R-1 to R
  -> roundStartedAt = block.timestamp (round R open)
  -> data from R-1 stays accessible via views

[Anyone calls finalizeRound(R-1) on RewardDistributor]
  -> reads BurnTracker.getTotalBurnForRound(R-2)  (or 0 if R-1 == 0)
  -> computes emission = min(max(alpha * burn_{R-2}, floor(R-1)), capMax)
  -> writes roundData[R-1] = { totalEmission, totalBurnAtFinalize, snapshotBlock, finalized: true }

[Stakers call claim(R-1, projectId)]
  -> if !finalized: revert
  -> if already claimed: revert
  -> computes amount and mints CREDIT via CREDIT.mint
```

Important note: **round R-1 can only be `finalizeRound`ed after `BurnTracker` has closed R-1**, even if R has not been closed yet. The sequence is:

- `closeRound` increments `currentRound`. So, to finalize round X, it is required that `BURN_TRACKER.currentRound() > X`.
- `finalizeRound` enforces strict order: first R=0, then R=1, then R=2... You cannot skip.

## How a project's share is computed

In `RewardDistributor._projectShare(round, projectId)`:

**If there was burn in the round:**

```
projectShare = totalEmission * projectBurnInRound / totalBurnInRound
```

**If there was no burn (bootstrap):**

```
projectShare = totalEmission * projectWeightAtSnapshot / globalWeightAtSnapshot
```

**And in either case:**

```
if isInProbation(projectId):
    projectShare = projectShare / 4
```

The 75% cut by probation **are never minted** — they do not enter `CREDIT.mint`, they are not redistributed, and `CreditToken.totalSupply()` is **not affected**. It is not `_burn` (which would reduce previously-minted supply); it is simply `projectShare` divided by 4 before the mint, per `contracts/RewardDistributor.sol:615-618`.

## How a user's claim is computed

In `RewardDistributor._calculateClaim(user, round, projectId)`:

```
share = _projectShare(round, projectId)
userWeight    = Staking.getWeightAt(user, projectId, snapshotBlock)
projectWeight = Staking.getTotalWeightAt(projectId, snapshotBlock)

amount = share * userWeight / projectWeight
```

If `userWeight == 0` or `share == 0`, it returns 0 with no side effects — the user can try again later if state changes (rare, but avoids "burning" the claim slot by mistake).

## Pull-based — you pull your rewards

There is no automatic push. If you staked and rounds closed, **nothing happens until you call `claim`**. This is intentional:

- Avoids gas explosions in rounds with thousands of stakers.
- Delegates the gas cost to whoever benefits (the staker).
- Allows batch claim via `claimMany(rounds[], projectIds[])` — you pay one tx and collect N rounds × N projects.

Consequence: if you forget to claim for several rounds, **the right persists**. There is no deadline. The only "cost" is that CREDIT is only minted when you request it, not immediately.

## The snapshotBlock and why it matters

When someone calls `finalizeRound(R)`, the contract records `snapshotBlock = block.number`. Every subsequent weight query during claim uses **that** block, not the current one. Result: even if you staked after the finalize, your weight for that round is zero.

This is the analog of `getPastVotes` from ERC20Votes governance — an anti-flashloan protection applied to the staking dimension.

## Probation — what you need to know as a staker

If you staked in a project that is in initial probation:

- Your emission share is divided by 4 during the window.
- The window is measured in timestamp, not in rounds.
- After `probationEndsAt`, the penalty vanishes automatically (no action needed from anyone).

If the project turns into **punitive Probation** (`Probation` status in the Registry), the penalty is not applied directly by RewardDistributor, but:

- New stakes are blocked (`Staking.stake` reverts with `ProjectNotActive`).
- New payments are blocked (`FeeRouter.pay` reverts).
- You can still **unstake** — the lock is **not** bypassed, but you are not prevented from leaving when it expires.

> **Cumulative scenario — long-term punitive Probation.** Stakers on a project in punitive `Probation` stay locked until expiry **even without receiving emissions** (if there is no project burn, `share = 0`; the `/ 4` penalty does not apply here because the project is not in initial `isInProbation` — but there is also no share because there is no burn and the project cannot receive payments). To mitigate, the DAO can propose terminal `removeProject`, which bypasses the lock. **DAO best practice: avoid long-term punitive Probation.** Prefer terminal `removeProject(slash=true)` (with lock bypass for stakers) or quick `reactivate` when the cause is solvable. Leaving the project frozen in Probation is punishing the staker for app/governance failure.

If the project turns into **Removed** (terminal):

- The lock is bypassed — you can unstake immediately.
- Future emissions to that project are zero (`Removed` status is never `isInProbation` nor counted in `globalWeight` once all stakes exit).

## Edge cases

**Round with no burn and no global staking**: emission happens (via floor), but no claim works — `globalWeight == 0` and `_projectShare` returns 0 in the bootstrap path. CREDIT is not minted; the "pool" simply is not allocated.

**Round with total burn > 0 but no burn in your project**: your project gets share 0, your claim is 0. If you wanted capture, you needed to stake in a project that generated burn.

**You staked between close and finalize**: your weight is only counted starting from the block of the next `finalizeRound`. For the current round, `getWeightAt(you, project, snapshotBlock)` returns the weight you had at the previous finalize's block (or 0 if you had none).

**Duplicate claim**: `claimed[round][projectId][user]` is set to `true` after the first claim with `amount > 0`. A retry reverts with `AlreadyClaimed`. A claim with `amount == 0` does **not** mark claimed — you can try again.

---

**Next →** [Governance](05-governance.md)
