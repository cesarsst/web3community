# Glossary

**Audience:** any reader who hits an unfamiliar term on another page.
**Prerequisites:** none.

Terms used across the other pages. Definitions are based on the code, not on external convention.

## Alpha (α)

Multiplicative factor in the emission formula of [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md) / [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md). Applied to the previous round's burn. In production: `950000000000000000` (= 0.95 in 1e18 precision). Tunable by governance within bounds `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` — `MAX_ALPHA` was reduced from `1.1e18` to enforce IE1 (α < 1 permanent) by construction; see `audit/economist/2026-04-22-consistency-audit.md` C2.

## Bonders

Fourth bucket of `RewardDistributorV2` (default 5% of per-round emission). In CLP Phase 1, this bucket becomes an **earmarked POL refill** — `RewardDistributorV2` mints CREDIT directly to the Treasury, which accumulates it in the `polRefillBucket` ledger. In Phase 3 it will be recycled into a `BondDepository` (users swap ETH/CREDIT for vested CREDIT, the protocol accumulates liquidity via bonds).

## Bucket (emission split)

One of the 4 slices of V2 emission: stakers (default 55%), LPs (25%), apps (15%), bonders (5%). Each bucket has its own destination and distribution mechanism. They sum to exactly 10000 bps — see [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md).

## Burn

Permanent decrement of CREDIT `totalSupply` via the native ERC-20 `_burn`. It happens whenever a user pays inside an app and the `FeeRouter` forwards the `burnBps` slice to `BurnTracker.burnAndRecord`, which in turn calls `CreditToken.burnByRole`.

## BurnTracker

On-chain internal oracle that records burn per `(round, projectId)`. Consumed by `RewardDistributor` to compute each project's share. See [BurnTracker](../08-contracts-reference/06-BurnTracker.md).

## Cap (supply)

Maximum number of tokens that may exist. GOV has an **immutable** cap of 100M. CREDIT has no hardcoded cap — its inflation is controlled by `RewardDistributor` via per-round `capMax` (governance-tunable).

## Checkpoint (anti-flashloan)

On-chain history of staking weights per block. `Staking` writes a checkpoint at every change; `RewardDistributor` reads it at the round's `snapshotBlock` (the `block.number` when `finalizeRound` was called). It prevents anyone from staking in the same block as a query and capturing share artificially.

## CLP (Credit Liquidity Protocol)

April/2026 economic pivot (parecer `audit/economist/2026-04-24-clp-pivot.md`). Reorganises the protocol into four phases:

- **1.1 — FFP buyback**: floor defence via real USDC->CREDIT swap + burn.
- **1.2 — POL**: protocol-owned liquidity in the CREDIT/USDC pool.
- **1.3 — LiquidityGauge**: incentivises external LPs via a dedicated bucket (25% emission).
- **1.4 — Bucket-aware split**: `RewardDistributorV2` splits emission into 4 simultaneous buckets.
- **3 (future)**: BondDepository — users swap ETH/CREDIT for vested CREDIT.

## CREDIT

Burnable ERC-20 utility token of the protocol. Elastic supply. Used to pay inside the ecosystem's apps. Minted as a reward for stakers (lazy, via claim) and as direct push for LPs/apps/bonders by `RewardDistributorV2`. See [CreditToken](../08-contracts-reference/02-CreditToken.md).

## DAO (Decentralized Autonomous Organization)

Here: the `CommunityGovernor` + `CommunityTimelock` pair, which together control **every** economic contract of the protocol in production.

## FFP (Floating with Floor Price)

CREDIT price defence model (CLP Phase 1.1). Spot is free above the floor; when spot < floor for >= 24h, governance can propose `Treasury.executeBuyback(usdcAmount, minCreditOut)` which executes a USDC->CREDIT swap via Uniswap V3 and **burns** the bought CREDIT immediately. Floor is computed as `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)` — default `max(0.50 × MA90, $0.10)`. Per-event (20%) and monthly (30%) caps over the Treasury's USDC reserves. See [Treasury](../08-contracts-reference/04-Treasury.md).

## FeeRouter

Contract that receives CREDIT payments from users, splits them according to `split` (default 95% burn / 0% treasury / 5% rebate to app) and routes each slice to its destination. See [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

## Finalize (a round)

Permissionless action of freezing the computed emission for a round — writes immutable `RoundData` (totalEmission, totalBurnAtFinalize, snapshotBlock). After it, stakers may claim. Function: `RewardDistributor.finalizeRound(round)`.

## Floor schedule

Immutable 24-element array in `RewardDistributor`. `floorSchedule[R]` is the emission floor for round R. In production it decays linearly from 400,000 CREDIT (round 0) down to ~16,666 CREDIT (round 23). Rounds >= 24 have no floor.

## Genesis mint

One-shot initial CREDIT mint (10M in production) executed exactly once via `CreditToken.mintGenesis(to, amount)`. The one-shot flag `genesisMinted` blocks any subsequent call. Production recipient: `Treasury`.

## GOV

Governance ERC-20 token with the `ERC20Votes` extension. Immutable supply cap of 100M. Used to vote (via `getPastVotes`) and as staking collateral. See [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md).

## GOVERNANCE_ROLE

AccessControl role granted in production **only** to `CommunityTimelock`. Gates every governance-sensitive function across the protocol's economic contracts (Treasury, ProjectRegistry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy).

## LiquidityGauge

Adapter on top of the canonical `UniswapV3Staker` (Uniswap Foundation) that distributes the **LPs bucket** of `RewardDistributorV2` (default 25% of emission) to external LPs of the CREDIT/USDC pair. The user stakes the V3 NFT in the gauge -> earns CREDIT proportional to in-range time -> upon `unstake` the reward enters a 14-day linear vesting -> `harvest` claims the vested portion. See [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md).

## Lock (staking)

Time (in seconds) during which a stake position cannot be undone. Allowed range: `[MIN_LOCK=14 days, any time]`. Multiplier saturates at 4x from `MAX_LOCK=365 days`.

## MA90

90-day moving average of CREDIT price in USD, kept in the Treasury's `dailyPrices[90]` ring buffer. Updated by `recordDailyPrice` (permissionless, 22h cooldown). Used as the relative floor reference for FFP. Before bootstrapping (90 samples), `ma90Price()` returns 0 and the floor falls back to `floorAbsoluteUsd` only (default $0.10).

## Multiplier (staking)

Factor applied to `amount` to compute weight. Linear from 1x (14 days) to 4x (365 days), saturates at 4x above. Defined in `Staking._multiplier(lockDuration)`.

## ownerRecipient

Canonical address (with 48h timelock) that receives the apps bucket of `RewardDistributorV2`. Set via `proposeOwnerRecipient(projectId, newRecipient)` (owner only) -> 48h wait -> `applyOwnerRecipient(projectId)` (permissionless). Fallback is `project.owner` when no explicit recipient is set. Cancellable by the owner OR by `GOVERNANCE_ROLE` (escape hatch). See [ProjectRegistry](../08-contracts-reference/03-ProjectRegistry.md).

## POL (Protocol-Owned Liquidity)

Protocol's own liquidity in the CREDIT/USDC 0.3% pool. NFT custodied by Treasury (slot `polTokenId`), full-tick range (`-887220, 887220`). Provisioned via `Treasury.addPOL` (seed) or `addPOLFromRefill` (drains bonders bucket + USDC from free balance). No active rebalancing. See [Treasury](../08-contracts-reference/04-Treasury.md).

## Probation

Two distinct notions inside `ProjectRegistry`:

- **Initial time-based probation**: automatic window applied to every freshly activated project, lasting `probationDuration` (30 days in production). Stake and payments work normally, but **reward share is divided by 4** (25%). Detected via `isInProbation(projectId)`.
- **Punitive probation**: status of the `Project.Status` enum. Governance manually moves a project from `Active` to `Probation` for misbehaviour. Blocks new stakes and payments, but **never blocks unstake**.

## Proposal

Governor object containing `(targets, values, calldatas, descriptionHash)`. Goes through Pending -> Active -> Succeeded/Defeated -> Queued -> Executed (or Canceled/Expired). Only executable via Timelock after all delays.

## polRefillBucket

Treasury's internal ledger that accumulates the bonders bucket from `RewardDistributorV2` (default 5% of per-round emission). Drained by `Treasury.addPOLFromRefill(creditAmount, usdcAmount, ...)` which matches CREDIT from the ledger with USDC from the free balance for injection into `polTokenId`. CEI: ledger debited before the external call (idempotency on revert).

## Rebate

Slice (default 5%) of a CREDIT payment that the FeeRouter transfers to the project's `appRecipient`. It is how the app captures operating cash flow.

## Recorder (RECORDER_ROLE)

Role on `BurnTracker` granted to each listed app (typically to the `FeeRouter`). Authorises calls to `burnAndRecord`. Granted via a Governor-approved proposal.

## Round

Protocol's accounting period. Started in `BurnTracker` (`currentRound`). Open indefinitely until governance calls `closeRound()`, which increments `currentRound` and resets `roundStartedAt`. Target duration in production: 7 days (`roundDuration = 604800`).

## RewardDistributorV2

Bucket-aware version of the emission distributor (CLP Phase 1.4). Parallel re-deploy alongside V1 — V1 stays in claim-only mode during a 4-round migration window. V2 splits emission into 4 simultaneous buckets: stakers (lazy), LPs (push gauge), apps (push retrospective via burn), bonders (push POL refill). See [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md).

## Sanity cap

Maximum burn cap per `(round, projectId)` in `BurnTracker`. In production `10_000_000e18` CREDIT. Prevents an attack where a project burns absurd volume to capture a disproportionate share. Value 0 = disabled (explicit governance opt-out).

## Snapshot (vote)

Reference block to compute voting power for a proposal. `Governor` uses `getPastVotes(account, proposalSnapshot)`; `RewardDistributor` uses `getWeightAt(user, projectId, snapshotBlock)`. Both immune to flash-loans that move tokens within the same block.

## Split

`(burnBps, treasuryBps, rebateBps)` configuration in `FeeRouter` summing to exactly 10_000 bps = 100%. Global default 9500/0/500. May be overridden per project via `setProjectSplit` (governance) or per recipient via `setAppRecipient` (project owner only, for the rebate destination).

## Staking (directed)

Act of locking GOV against a specific `projectId` from the Registry. Defines weight = `amount * multiplier(lockDuration) / 1e18`. Weight feeds the reward share. See [Staking](../08-contracts-reference/05-Staking.md).

## Timelock

Contract that executes Governor decisions after a minimum delay (`minDelay`, in production 2 days). `CommunityTimelock` is a trivial subclass of OpenZeppelin's `TimelockController`. Sole holder of `GOVERNANCE_ROLE` in production.

## Treasury

DAO's multi-asset vault. Receives passively (direct ERC-20 transfers) and only releases funds via `onlyRole(GOVERNANCE_ROLE)` functions. See [Treasury](../08-contracts-reference/04-Treasury.md).

## Vesting

Gradual release of GOV to a team beneficiary over time, with cliff + linear schedule. One `TeamVesting` instance per member. See [TeamVesting](../08-contracts-reference/11-TeamVesting.md).

## Voting delay / period

Governor parameters in **blocks**:

- `votingDelay` = blocks between `propose` and the start of voting. Production: 7200 (~1 day at 12s/block).
- `votingPeriod` = voting duration. Production: 50400 (~7 days).

Both adjustable via `onlyGovernance` (proposal + Timelock execution).

## Weight (staking)

`amount * multiplier(lockDuration) / 1e18`. Read with historical snapshot via `Staking.getWeightAt` / `Staking.getTotalWeightAt` / `Staking.getGlobalWeightAt`.

---

**Next ->** [Reading paths](04-reading-paths.md)
