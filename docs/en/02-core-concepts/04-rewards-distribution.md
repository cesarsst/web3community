# Rewards distribution

> ⚠️ **LEGACY — entire page.** Emission-based distribution (the 55/25/15/5 buckets of `RewardDistributorV2`) was **replaced in the 2026-07-08 remodel**. The contracts remain deployed for historical claims, but there is no new emission: with no burn on the payment rail ([FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) burns nothing), the α·burn formula produces no emission.
>
> **The bridge to the current model**: investor income is no longer minted CREDIT (inflation) but **rev-share of real revenue** — anyone with GOV staked in a project can invest CREDIT in its round in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) (rev-share 1–30% of gross revenue, 1–90 day duration, all-or-nothing) and receives pro-rata on every payment routed through FeeRouterV2. Claims never expire. Start with [Value flow](../03-protocol-overview/03-economic-flows.md) and [Claiming rev-share](../04-for-users/05-claiming-rewards.md).

**Audience:** stakers, LPs, app owners and devs who want to understand exactly how a round's pool turned into claims/incentives in the old model.
**Prerequisites:** [Directed staking](02-directed-staking.md), [Burn-to-mint](03-burn-to-mint.md).

## Where we were: V1 -> V2 (bucket-aware split)

This page describes the **V2** model (CLP Phase 1.4), in production from April/2026 until the 2026-07-08 remodel. The V1 model (pre-pivot) remains operational in claim-only mode during a 4-round migration window — for details see [RewardDistributor (V1)](../08-contracts-reference/07-RewardDistributor.md).

V2 rewrites round finalisation to **split emission across 4 simultaneous buckets**:

| Bucket | Default | Destination | Mechanism |
|---|---|---|---|
| **Stakers** | 55% | whoever did directed staking on some project | pull (`claim`) |
| **LPs** | 25% | whoever provided LP on the CREDIT/USDC pair and staked in the [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md) | push to the gauge (`notifyRewardAmount`) |
| **Apps** | 15% | each project's `ownerRecipient`, proportional to the previous round's burn | push (direct mint) |
| **Bonders** | 5% | earmarked POL refill in the Treasury (Phase 3 becomes `BondDepository`) | push (`Treasury.depositPolRefill`) |

The TOTAL emission formula is the same as V1: `min(max(alpha × burn_{R-1}, floor(R)), capMax)`. The bucket split is applied **after** the cap (IE3 strengthened — no bucket exceeds `bucketBps[i] × capMax`).

Per-bucket bounds (E.8 of parecer 2026-04-24-clp-pivot.md):

- `stakers >= 30%`
- `LPs >= 5%`
- `apps <= 25%` (IE4b — anti self-extraction via wash burn)
- `bonders <= 20%` (Olympus showed > 20% unleashes ponzi)
- exact sum 10000 bps.

## Full round cycle (V2)

```
[Round R-1 open at BurnTracker]

Users pay in apps via FeeRouter
  -> FeeRouter.burnByRole burnBps% of value via BurnTracker.burnAndRecord
  -> BurnTracker increments:
       burnByRoundProject[R-1][projectId] += amount
       totalBurnByRound[R-1]              += amount

[End of the round's target window (roundDuration)]

Governance calls closeRound()
  -> currentRound moves from R-1 to R

[Anyone calls RewardDistributorV2.finalizeRound(R-1)]
  -> totalEmission = min(max(alpha * burn_{R-2}, floor(R-1)), capMax)
  -> SPLIT across 4 buckets (proportion bucketBps), bonders absorbs residue:
       stakersAmount = totalEmission * 5500 / 10000
       lpsAmount     = totalEmission * 2500 / 10000
       appsAmount    = totalEmission * 1500 / 10000
       bondersAmount = totalEmission - stakers - lps - apps

  Push for 3 buckets (in the same tx):
    APPS:  loop over projects with burn > 0:
             share = appsAmount * burn_p / totalBurnPrev
             CREDIT.mint(REGISTRY.ownerRecipient(p), share, "rewardRound:apps")
    LPS:   if gauge not paused:
             CREDIT.mint(self, lpsAmount)
             gauge.notifyRewardAmount(poolId, lpsAmount, duration)
           if paused:
             CREDIT.mint(treasury, lpsAmount)
             treasury.depositPendingGaugeRewards(lpsAmount)
    BONDERS: CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
             treasury.depositPolRefill(bondersAmount)

  Stakers: NOT minted here (lazy via claim)

  -> writes roundData[R-1] + bucketEmissionByRound[R-1][i]
  -> assert IE12: sum of 4 buckets == totalEmission (3 wei tolerance)

[Stakers call claim(R-1, projectId)]
  -> base of computation: bucketEmissionByRound[R-1][BUCKET_STAKERS]
  -> projectShare = base * projectBurn / totalBurn  (or via globalWeight in bootstrap)
  -> userAmount = projectShare * userWeight / projectWeight
  -> CREDIT.mint(user, userAmount, "rewardRoundV2:stakers")

[LPs withdraw via LiquidityGauge.harvest(user, maxAmount)]
  -> official Uniswap staker distributes in-range proportionally
  -> unstake() creates 14-day linear VestingPosition
  -> harvest pulls already-vested fraction

[App owners receive automatically at ownerRecipient]
  -> nothing to do — the mint happens inside finalizeRound

[Bonders don't exist in Phase 1 — bucket becomes POL refill]
  -> Treasury.polRefillBucket accumulates
  -> governance drains via addPOLFromRefill (DAO proposal)
```

Important note: **round R-1 can only be `finalizeRound`-ed after `BurnTracker` has closed R-1**, even if R isn't closed yet. The sequencing is:

- `closeRound` increments `currentRound`. So, to finalize round X, `BURN_TRACKER.currentRound() > X` is required.
- `finalizeRound` requires strict order: first R=0, then R=1, then R=2... no skipping.

## How a project's stakers-bucket share is computed (V2)

In `RewardDistributorV2._projectStakerShare(round, projectId)`:

**Base of the computation**: `stakersBase = bucketEmissionByRound[round][BUCKET_STAKERS]` — no longer `totalEmission`.

**If there was burn in the round:**

```
projectShare = stakersBase * projectBurnInRound / totalBurnInRound
```

**If there was no burn (bootstrap):**

```
projectShare = stakersBase * projectWeightAtSnapshot / globalWeightAtSnapshot
```

**And in any case:**

```
if isInProbation(projectId):
    projectShare = projectShare / 4
```

The 75% sliced off by probation **is never minted** — it is not redistributed and `CreditToken.totalSupply()` is **unaffected**. It is simply `projectShare` divided by 4 before mint.

## How a user's claim is computed (stakers bucket)

In `RewardDistributorV2._calculateClaim(user, round, projectId)`:

```
share = _projectStakerShare(round, projectId)
userWeight    = Staking.getWeightAt(user, projectId, snapshotBlock)
projectWeight = Staking.getTotalWeightAt(projectId, snapshotBlock)

amount = share * userWeight / projectWeight
```

If `userWeight == 0` or `share == 0`, returns 0 with no side effects — the user can retry later if state changes.

## How the apps bucket distributes

In `finalizeRound`, V2 iterates `pid in 1..totalProjects`:

```
for each project p:
    burnP = BURN_TRACKER.getBurnForProjectInRound(round - 1, p)
    if burnP == 0: skip
    appShare = appsAmount * burnP / totalBurnPrev
    if appShare == 0: skip
    recipient = REGISTRY.ownerRecipient(p)
    if recipient == address(0): skip  (project Removed/inexistent — share evaporates)
    CREDIT.mint(recipient, appShare, "rewardRound:apps")
```

**Bootstrap** (`totalBurnPrev == 0`): apps bucket does NOT emit — bonders absorbs. Without burn there is no economic signal to distribute among apps.

**Recipient with 48h timelock**: `ownerRecipient(p)` returns the explicit one set via `proposeOwnerRecipient` + `applyOwnerRecipient` (48h timelock), or falls back to `project.owner` when no explicit recipient was set. See [ProjectRegistry](../08-contracts-reference/03-ProjectRegistry.md).

## How the LPs bucket distributes

In `finalizeRound`, V2 detects gauge state:

- **Active gauge**: `CREDIT.mint(self, lpsAmount)` + `forceApprove(gauge, lpsAmount)` + `gauge.notifyRewardAmount(poolId, lpsAmount, duration)`. Creates a new incentive of `gaugeIncentiveDuration` seconds (default 7 days).
- **Paused gauge**: fallback to `Treasury.depositPendingGaugeRewards(lpsAmount)` + emits `GaugePauseFallback`. Without fallback, pausing the gauge would freeze the entire round finalisation.

LPs withdraw via `LiquidityGauge.harvest(user, maxAmount)` — the official Uniswap staker distributes proportionally to in-range time (`secondsInsideX128`). After `unstake`, rewards enter a 14-day linear vesting.

## How the bonders bucket feeds the POL

In `finalizeRound`, V2 mints `bondersAmount` directly to the Treasury and calls `Treasury.depositPolRefill(bondersAmount)`. This **only accumulates in the internal ledger** `polRefillBucket` — it does not move tokens into the pool yet.

When governance decides to refill the POL, it proposes `addPOLFromRefill(creditAmount, usdcAmount, ...)` on the Treasury. The contract:

1. Debits `creditAmount` from `polRefillBucket` (CEI).
2. Matches it with `usdcAmount` from the Treasury's free balance (sourced from `treasuryBps` of the FeeRouter).
3. Calls `NPM.increaseLiquidity` (or `mint` on first run).

Phase 3 of the CLP roadmap recycles this bucket into a `BondDepository` — users swap ETH/CREDIT for vested CREDIT and the protocol accumulates POL through bonds. For now, the bucket sustains POL directly.

## Pull-based — you pull your rewards

There is no automatic push. If you staked and rounds closed, **nothing happens until you call `claim`**. This is intentional:

- Avoids gas explosion on rounds with thousands of stakers.
- Delegates gas cost to whoever benefits (the staker).
- Allows batch claims via `claimMany(rounds[], projectIds[])` — you pay one tx and collect N rounds × N projects.

Consequence: if you forget to claim for several rounds, **the right persists**. There is no deadline. The only "cost" is that CREDIT is minted only when you request, not immediately.

## The snapshotBlock and why it matters

When someone calls `finalizeRound(R)`, the contract writes `snapshotBlock = block.number`. Every weight query in the subsequent claim uses **that** block, not the current one. Result: even if you staked after finalize, your weight in that round is zero.

This is the analogue of `getPastVotes` in ERC20Votes governance — anti-flashloan protection applied to the staking dimension.

## Probation — what you need to know as a staker

If you staked in a project that is in initial probation:

- Your emission share is divided by 4 during the window.
- The window is measured by timestamp, not by rounds.
- After `probationEndsAt`, the penalty disappears automatically (no action required from anyone).

If the project goes into **punitive Probation** (status `Probation` in the Registry), the penalty does not apply directly via RewardDistributor, but:

- New stakes are blocked (`Staking.stake` reverts with `ProjectNotActive`).
- New payments are blocked (`FeeRouter.pay` reverts).
- You can still **unstake** — the lock is **not** bypassed, but you are not prevented from leaving when it expires.

> **Cumulative scenario — long-term punitive Probation.** Stakers in a punitive `Probation` project are stuck until lock expiry **even without receiving emissions** (if there is no project burn, `share = 0`; the `/ 4` penalty doesn't apply here because the project isn't `isInProbation` initial — but there's also no share because there is no burn and the project can't receive payments). To mitigate, the DAO may propose a terminal `removeProject`, which bypasses the lock. **DAO good practice: avoid long-term punitive Probation.** Prefer terminal `removeProject(slash=true)` (with lock bypass for stakers) or quick `reactivate` when the cause can be fixed. Leaving the project frozen in Probation penalises the staker for an app/governance failure.

If the project goes into **Removed** (terminal):

- The lock is bypassed — you can unstake immediately.
- Future emissions for that project are zero (status `Removed` is never `isInProbation` and stops counting in `globalWeight` once all stakes have left).

## Edge cases

**Round with no burn and no global staking**: emission happens (via floor), but no claim works — `globalWeight == 0` and `_projectShare` returns 0 in the bootstrap path. CREDIT is not minted; the "pool" simply isn't allocated.

**Round with totalBurn > 0 but zero burn on your project**: your project gets share 0, your claim is 0. If you wanted capture, you should have staked into a project that generated burn.

**You staked between close and finalize**: your weight is only counted from the next `finalizeRound` block onwards. For the current round, `getWeightAt(you, project, snapshotBlock)` returns the weight you had at the previous finalize block (or 0 if you had none).

**Duplicate claim**: `claimed[round][projectId][user]` is marked `true` after the first claim with `amount > 0`. Reclaim attempts revert with `AlreadyClaimed`. A claim with `amount == 0` does **not** mark claimed — you can retry.

---

**Next ->** [Governance](05-governance.md)
