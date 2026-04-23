# User flows

**Audience:** dev or user trying to understand what happens end-to-end in each typical action.
**Prerequisites:** [Architecture](01-architecture.md).

Each diagram below is an end-to-end flow. Simple arrow = function call. `|=>` = implicit state transition.

## Flow 1 — User pays in an app

Actor: **Charlie** (end user). He has 1000 CREDIT and wants to use ChatApp, whose `projectId = 42`.

```
Charlie.wallet
     |
     | 1. approve(feeRouter, 1000 CREDIT)
     v
CreditToken  |=> allowance[charlie][feeRouter] = 1000
     |
     | 2. app UI builds tx:
     |    feeRouter.pay(42, charlie, 1000)
     |    (tx can be signed by Charlie or by a relayer
     |     that pays the gas; economic user is always `charlie`)
     v
FeeRouter.pay(projectId=42, user=charlie, amount=1000)
     |
     | Check: registry.isActive(42)
     | Check: user != 0, amount > 0
     |
     | 3. pulls CREDIT
     | CREDIT.safeTransferFrom(charlie, router, 1000)
     |
     | 4. computes default split = (9500, 0, 500)
     |    burned = 950, toTreasury = 0, toApp = 50
     |
     | 5. resolves recipient = registry.getProject(42).owner
     |    (or appRecipient[42] if set)
     |
     | 6. pays rebate
     | CREDIT.safeTransfer(recipient, 50)
     |
     | 7. triggers burn
     | CREDIT.forceApprove(burnTracker, 950)
     | BurnTracker.burnAndRecord(42, router, 950)
     |        |
     |        | check: registry.isActive(42)
     |        | check: cumulative + 950 <= sanityCap
     |        |
     |        | 8. updates tracker storage
     |        | burnByRoundProject[R][42] += 950
     |        | totalBurnByRound[R]       += 950
     |        | projectsWithBurnCount[R]  += 1 (if first time)
     |        |
     |        | 9. burns
     |        | CREDIT.burnByRole(router, 950, "burnTracker")
     |        |        |
     |        |        | _burn(router, 950) => totalSupply -= 950
     |        |        v
     |        +-------- BurnedByRole event
     |
     |  Paid event emitted
```

**Post-tx effects:**

- CREDIT supply dropped by 950.
- `appOwner.balance += 50` in CREDIT.
- `burnByRoundProject[R][42] += 950` on-chain.
- Charlie `|=>` can use ChatApp's service (app logic, outside the protocol).

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

## Flow 3 — Staker claims reward

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
   |=> feeRouter.pay(42, ...) starts working
```

From then on ChatApp can accept payments. During the next 30 days, its reward share is divided by 4 (initial probation).

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

## Flow 6 — Round closes and is finalized

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
