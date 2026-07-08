# User flows

**Audience:** dev or user trying to understand what happens end-to-end in each typical action.
**Prerequisites:** [Architecture](01-architecture.md).

Each diagram below is an end-to-end flow. Simple arrow = function call. `|=>` = implicit state transition.

> **2026-07-08 remodel**: flows 1, 1b and 1c describe the current rail (PSM → pay → fee/rev-share/app → claim). Flows marked **legacy** describe the pre-remodel burn-to-mint cycle, kept deployed for historical compatibility.

## Flow 1 — User buys CREDIT and pays in an app

Actor: **Charlie** (end user). He has 1000 USDC and wants to use ChatApp, whose `projectId = 42`. ChatApp raised a round at an 8% rev-share.

```
Charlie.wallet (1000 USDC)
     |
     | 1. approve(psm, 1000 USDC)
     | 2. CreditPSM.buy(1000e6)
     |       |
     |       | USDC.safeTransferFrom(charlie, psm, 1000e6)
     |       | mintedOutstanding += 1000e18
     |       | CREDIT.mint(charlie, 1000e18, "psm:buy")
     |       v
     |       +-- Bought event  |=> Charlie has 1000 CREDIT (1:1)
     |
     | 3. approve(feeRouterV2, 1000 CREDIT)
     | 4. FeeRouterV2.pay(projectId=42, amount=1000)
     v
FeeRouterV2.pay(42, 1000)
     |
     | Check: registry.isActive(42)
     | Check: amount > 0
     |
     | 5. pulls CREDIT
     | CREDIT.safeTransferFrom(charlie, router, 1000)
     |
     | 6. protocol fee: 1000 * 250 / 10000 = 25 CREDIT (2.5%)
     |    fee split (4000/4000/2000):
     |      toTreasury = 10   (40% of the fee = 1.0% of the payment)
     |      toBuyback  = 10   (40% of the fee = 1.0% of the payment)
     |      toGrants   =  5   (residue -> grants; 0.5% of the payment)
     |
     | 7. rev-share: 1000 * FUNDING.revShareBpsOf(42)=800 / 10000 = 80
     |    CREDIT.safeTransfer(funding, 80)
     |    FUNDING.notifyRevenue(42, 80)
     |        |
     |        | accRevenuePerShare[42] += 80e18 * 1e18 / raised
     |        | totalRevenueDistributed[42] += 80
     |        v
     |        +-- RevenueNotified event
     |
     | 8. the rest to the app, INSTANTLY:
     |    toApp = 1000 - 25 - 80 = 895 (89.5%)
     |    recipient = appRecipientOf[42] (or the Registry owner)
     |    CREDIT.safeTransfer(recipient, 895)
     |
     | 9. grossVolumeOf[42] += 1000
     v
     +-------- PaymentRouted(42, charlie, 1000, 10, 10, 5, 80, 895)
```

**Post-tx effects:**

- No CREDIT burned — supply stable, PSM backing untouched.
- `appOwner.balance += 895` in CREDIT (without a funding round it would be 975 = 97.5%).
- Treasury +10, GOV buyback +10, grants +5.
- ChatApp's round investors accrued +80 pro-rata (withdrawable via `claim`).
- `grossVolumeOf[42] += 1000` — the project's on-chain GMV.
- Charlie `|=>` can use ChatApp's service (app logic, outside the protocol).

## Flow 1b — Owner raises a funding round

Actor: **ChatApp team** (owner of `projectId = 42`, Active) wants upfront capital; **Alice** and **Bob** have GOV staked on ChatApp.

```
ChatAppOwner.wallet
     |
     | 1. ProjectFunding.openRound(42, target=10_000 CREDIT,
     |                             revShareBps=800 (8%), duration=30 days)
     |       |
     |       | Check: registry.isActive(42) + owner
     |       | Check: rounds[42].status == None (ONE round per project)
     |       | Check: 100 <= 800 <= 3000 bps
     |       | Check: target >= minTarget (100 CREDIT default)
     |       | Check: 1 day <= duration <= 90 days
     |       v
     |       +-- RoundOpened(42, 10_000, 800, deadline)
     |
Alice (GOV staked on 42)
     | 2. approve + ProjectFunding.invest(42, 6_000)
     |       | Check: STAKING.getWeight(alice, 42) > 0   <- gate
     |       | sharesOf[42][alice] = 6_000
     |       +-- Invested(42, alice, 6_000, 6_000)
     |
Bob (GOV staked on 42)
     | 3. approve + ProjectFunding.invest(42, 4_000)
     |       | raised = 10_000 == target -> finalizes AUTOMATICALLY
     |       | status = Funded
     |       | CREDIT.safeTransfer(chatAppOwner, 10_000)
     |       +-- Invested + RoundFunded(42, 10_000, chatAppOwner)
     v
|=> Owner received 10_000 CREDIT of upfront capital.
|=> revShareBpsOf(42) = 800 -> every pay() now deducts 8%.

(Alternative scenario: deadline passes with raised < target
   -> anyone calls closeExpiredRound(42)  |=> Failed
   -> each investor calls refund(42) and gets 100% back.)
```

## Flow 1c — Investor withdraws revenue (claim)

Actor: **Alice**, invested 6,000 of the round's 10,000 CREDIT (60% of shares). ChatApp has processed 50,000 CREDIT of GMV since funding.

```
Alice.wallet
     |
     | (optional: preview)
     | funding.pendingRevenue(42, alice) -> 2_400 CREDIT
     |   (accrued rev-share = 8% * 50_000 = 4_000; Alice = 60%)
     |
     | 1. ProjectFunding.claim(42)
     v
ProjectFunding.claim(42)
     |
     | Check: STAKING.getWeight(alice, 42) > 0
     |   (skin in the game: must KEEP GOV staked;
     |    without stake the value does NOT expire - it stays
     |    accrued until re-stake)
     |
     | 2. amount = sharesOf * accRevenuePerShare - rewardDebt = 2_400
     | 3. updates rewardDebt (MasterChef checkpoint)
     | 4. CREDIT.safeTransfer(alice, 2_400)
     v
     +-------- RevenueClaimed(42, alice, 2_400)

|=> Alice can hold the CREDIT (stable) or redeem USDC at the PSM (sell 1:1).
```

## Flow 1-legacy — User pays in an app (burn-to-mint, pre-remodel)

> ⚠️ **LEGACY** — V1 FeeRouter flow with the 70/20/10 split and burn via BurnTracker. Details on the [FeeRouter (V1)](../08-contracts-reference/08-FeeRouter.md) page. Summary: `pay` pulled 1000 CREDIT, burned 700 (`BurnTracker.burnAndRecord` → `burnByRole`), sent 200 to the Treasury and 100 as rebate to the app. The burn fed the next round's emission in the RewardDistributor.

## Flow 2 — Staker opens a position in a project

Actor: **Alice**, has 50,000 GOV and wants to stake for 1 year in `projectId = 42`.

```
Alice.wallet
     |
     | 1. approve(staking, 50_000 GOV)
     v
GovernanceToken  |=> allowance[alice][staking] = 50_000

     | 2. Alice picks lockDuration = 365 days
     | expected multiplier = 4x (saturates at MAX_LOCK)
     |
     v
Staking.stake(projectId=42, amount=50_000 GOV, lockDuration=31_536_000)
     |
     | Check: amount > 0
     | Check: lockDuration >= MIN_LOCK (14 days)
     | Check: REGISTRY.isActive(42)
     |
     | 3. If there was no position yet:
     |    positions[alice][42] = { amount=50_000, lockStartAt=now, lockDuration=365d }
     |
     | 4. Updates aggregates
     | totalStakedByProject[42] += 50_000
     | totalStaked              += 50_000
     |
     | 5. Computes weight
     | weight = 50_000 * 4e18 / 1e18 = 200_000
     |
     | 6. Writes 3 checkpoints at block.number
     | _userWeight[alice][42].push(block.number, 200_000)
     | _projectWeight[42].push(block.number, oldProjectW - 0 + 200_000)
     | _globalWeightCheckpoints.push(block.number, oldGlobalW - 0 + 200_000)
     |
     | 7. Pulls GOV
     | GOV.safeTransferFrom(alice, staking, 50_000)
     |
     +-------- Staked event emitted
```

**Post-tx effects:**

- Alice has immobilized 50k GOV for 365 days.
- Total weight of `projectId=42` went up by 200k.
- Global weight went up by 200k.
- Alice cannot `unstake` until `now + 365 days` (unless the project turns `Removed`).
- **With weight > 0 on the project, Alice can `invest` in 42's funding round and `claim` rev-share** (Flows 1b and 1c) — the stake is the remodel's investment gate.

## Flow 3 — Staker claims emission reward (legacy)

> ⚠️ **LEGACY** — claims of old `RewardDistributor` rounds keep working (the right never expires), but there are no new emission rounds since the 2026-07-08 remodel. The investor's current income is the rev-share of Flow 1c.

Actor: **Alice**, already staked and round `R=5` has been finalized.

```
Alice.wallet
     |
     | (optional: preview)
     | rewardDistributor.previewClaim(alice, 5, 42) -> 3421.7 CREDIT
     |
     | 1. claim
     v
RewardDistributor.claim(round=5, projectId=42)
     |
     | Check: roundData[5].finalized = true
     | Check: !claimed[5][42][alice]
     |
     | 2. _calculateClaim
     |
     |    share = _projectShare(5, 42):
     |      - totalEmission = roundData[5].totalEmission = 905_000 CREDIT
     |      - if totalBurnAtFinalize > 0:
     |          projectBurn = burnByRoundProject[4][42] = 600_000
     |          totalBurn   = totalBurnByRound[4]       = 950_000
     |          share = 905_000 * 600_000 / 950_000 = 571_578 CREDIT
     |      - isInProbation(42)? (false - project is > 30 days old)
     |    share = 571_578
     |
     |    userWeight    = staking.getWeightAt(alice, 42, snapshotBlock_5) = 200_000
     |    projectWeight = staking.getTotalWeightAt(42, snapshotBlock_5)   = 400_000
     |
     |    amount = 571_578 * 200_000 / 400_000 = 285_789 CREDIT
     |
     | 3. claimed[5][42][alice] = true
     |
     | 4. Claimed event
     |
     | 5. CREDIT.mint(alice, 285_789, "rewardRound")
     |            |
     |            | requires MINTER_ROLE
     |            | (RewardDistributor has it)
     |            v
     |    totalSupply += 285_789
     |    balance[alice] += 285_789
     v
alice receives 285_789 CREDIT
```

## Flow 4 — DAO lists a new project

Actor: **ChatApp team** wants to list `ChatApp` as a new `projectId`.

```
0. ChatApp team has 10_000+ GOV

1. ChatApp team prepares off-chain metadata
   - IPFS upload of JSON { name, description, icon, contracts, ... }
   - receives CID: ipfs://Qm...

2. someone with threshold (10k GOV delegated) proposes in Governor:
   targets   = [registry]
   calldatas = [registry.registerProject.encode(chatAppOwner, "ipfs://Qm...", 10_000e18)]

3. Voting (1d delay + 7d period)
   If it wins with 4% quorum and For > Against:

4. Governor.queue() -> Timelock.schedule(...)
5. ChatApp team calls GOV.approve(registry, 10_000)
   (before execution; can be done at any time)

6. After minDelay (2d), anyone calls Timelock.execute(...)
   -> registry.registerProject(chatAppOwner, "ipfs://Qm...", 10_000e18)
        |
        | Check: GOVERNANCE_ROLE (Timelock has)
        | Check: collateral >= minCollateral (10k)
        | Check: allowance >= 10k
        |
        | projectId = 42 (_nextProjectId++)
        | writes project as Pending
        | GOV.safeTransferFrom(chatAppOwner, registry, 10_000)

   |=> Project exists as Pending, collateral locked

7. Second proposal (can be in the same batch):
   registry.activateProject(42)
   burnTracker.grantRole(RECORDER_ROLE, feeRouter)
     (if FeeRouter does not have it yet; in v1 it already does since deploy)

8. After approval + delay:
   |=> projectId=42 becomes Active
   |=> probationEndsAt = now + 30 days
   |=> feeRouterV2.pay(42, ...) starts working
   |=> the owner can already open a ProjectFunding round (Flow 1b)
```

From then on ChatApp can accept payments through FeeRouterV2 and open its fundraising round. (Legacy: the BurnTracker `RECORDER_ROLE` step and the probation penalty on reward share — divided by 4 in the first 30 days — only affect the old burn-to-mint rail.)

## Flow 5 — Unstake after lock

Actor: **Alice**, staked 50k GOV with a 365-day lock, 366 days have passed.

```
Alice.wallet
     |
     | 1. unstake (or unstakeAll)
     v
Staking.unstake(projectId=42, amount=50_000)
     |
     | Check: amount > 0
     | Check: positions[alice][42].amount > 0
     | Check: amount <= position.amount
     |
     | 2. checks lock
     | projectRemoved = REGISTRY.getProject(42).status == Removed  // false
     | unlockAt = lockStartAt + lockDuration
     | if !projectRemoved && block.timestamp < unlockAt:
     |     revert LockNotExpired
     | (here block.timestamp = lockStartAt + 366d, passed)
     |
     | 3. Effects
     | remaining = 50_000 - 50_000 = 0
     | delete positions[alice][42]
     | totalStakedByProject[42] -= 50_000
     | totalStaked              -= 50_000
     |
     | 4. checkpoint with newUserWeight = 0
     | _userWeight[alice][42].push(block.number, 0)
     | _projectWeight[42].push(block.number, oldP - 200_000 + 0)
     | _globalWeightCheckpoints.push(block.number, oldG - 200_000)
     |
     | 5. GOV.safeTransfer(alice, 50_000)
     v
     +-------- Unstaked event (no EarlyUnstakeAllowed because lock expired)
```

## Flow 6 — Burn round closes and is finalized (legacy)

> ⚠️ **LEGACY** — the `closeRound`/`finalizeRound` cycle belongs to the pre-remodel burn-to-mint rail. Without new burn (FeeRouterV2 burns nothing), there is no new emission to finalize.

Actor: **governance** (via proposal) and then **anyone**.

```
Pre-close state: BurnTracker.currentRound = 5, roundStartedAt = old timestamp

1. Approved proposal:
   BurnTracker.closeRound()
       |
       | only GOVERNANCE_ROLE (Timelock has)
       |
       | earlyClose = now < roundStartedAt + roundDuration?
       | totalBurn = totalBurnByRound[5]
       | projectsCount = projectsWithBurnCount[5]
       |
       | currentRound = 6
       | roundStartedAt = now
       v
       +-- RoundClosed event

State: BurnTracker.currentRound = 6.
       R=5 data remains accessible via views.

2. Anyone (Alice, bot, etc.) calls:
   RewardDistributor.finalizeRound(5)
       |
       | Check: !roundData[5].finalized
       | Check: expected = 5 (lastFinalizedRound + 1)
       | Check: BurnTracker.currentRound() = 6 > 5
       |
       | totalBurnPrev = BurnTracker.getTotalBurnForRound(4) = 950_000
       | alphaBurn = 950_000 * 0.95e18 / 1e18 = 902_500
       | floorAmount = floorSchedule[5] = 316_666 (declining)
       | rawEmission = max(902_500, 316_666) = 902_500
       | totalEmission = min(902_500, capMax=5_000_000) = 902_500
       |
       | snapshotBlock = block.number
       |
       | roundData[5] = { 902_500, 950_000, snapshotBlock, true }
       | lastFinalizedRound = 5
       | isFirstRoundFinalized = true
       v
       +-- RoundFinalized event

State: stakers can now call claim(5, projectId).
```

---

**Next →** [Value flow](03-economic-flows.md)
