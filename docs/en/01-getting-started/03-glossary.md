# Glossary

**Audience:** any reader who runs into an unfamiliar term on another page.
**Prerequisites:** none.

Terms used on the other pages. Definitions based on the code, not on external convention.

## Alpha (α)

Multiplier factor of the emission formula in [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md). Applied to the previous round's burn. In production `950000000000000000` (= 0.95 in 1e18 precision). Adjustable via governance within the bounds `[MIN_ALPHA=0.5e18, MAX_ALPHA=1.1e18]`.

## Burn

Permanent decrement of CREDIT `totalSupply` via native ERC-20 `_burn`. Happens when a user pays in an app and the `FeeRouter` forwards the `burnBps` slice to `BurnTracker.burnAndRecord`, which in turn calls `CreditToken.burnByRole`.

## BurnTracker

Internal on-chain oracle that accounts burn by `(round, projectId)`. Consumed by `RewardDistributor` to compute each project's share. See [BurnTracker](../08-contracts-reference/06-BurnTracker.md).

## Cap (of supply)

Maximum number of tokens that can exist. GOV has an **immutable** cap of 100M. CREDIT has no hardcoded cap — its inflation is controlled by `RewardDistributor` via `capMax` per round (adjustable via governance).

## Checkpoint (anti-flashloan)

On-chain historiography of staking weights per block. `Staking` writes checkpoints on each change; `RewardDistributor` reads at the round's `snapshotBlock` (block.number when `finalizeRound` was called). Prevents someone from staking in the same block as a query to capture share artificially.

## CREDIT

Burnable ERC-20 utility token of the protocol. Elastic supply. Used to pay inside the ecosystem's apps. Minted as a reward to stakers via `RewardDistributor`. See [CreditToken](../08-contracts-reference/02-CreditToken.md).

## DAO (Decentralized Autonomous Organization)

Here it refers to the pair `CommunityGovernor` + `CommunityTimelock`, which together control **all** the protocol's economic contracts in production.

## FeeRouter

Contract that receives CREDIT payments from users, splits them according to `split` (default 95% burn / 0% treasury / 5% rebate to the app), and distributes each slice to its destination. See [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

## Finalize (a round)

Permissionless action of freezing the emission computed for a round — records immutable `RoundData` (totalEmission, totalBurnAtFinalize, snapshotBlock). After that, stakers can claim. Function: `RewardDistributor.finalizeRound(round)`.

## Floor schedule

Immutable array of 24 values in `RewardDistributor`. `floorSchedule[R]` is the emission floor of round R. In production it decays linearly from 400,000 CREDIT (round 0) to ~16,666 CREDIT (round 23). Rounds >= 24 have no floor.

## Genesis mint

Unique initial minting of CREDIT (10M in production) done only once via `CreditToken.mintGenesis(to, amount)`. One-shot `genesisMinted` flag blocks subsequent calls. Recipient in production: `Treasury`.

## GOV

ERC-20 governance token with `ERC20Votes` extension. Immutable supply cap of 100M. Used to vote (via `getPastVotes`) and as staking collateral. See [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md).

## GOVERNANCE_ROLE

AccessControl role granted in production **only** to `CommunityTimelock`. Gates every governance-sensitive function of the economic contracts (Treasury, ProjectRegistry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy).

## Lock (of staking)

Time (in seconds) during which a stake position cannot be undone. Allowed range: `[MIN_LOCK=14 days, any time]`. Multiplier saturates at 4x above `MAX_LOCK=365 days`.

## Multiplier (of staking)

Factor applied to `amount` to compute weight. Linear from 1x (14 days) to 4x (365 days), saturates at 4x above. Defined in `Staking._multiplier(lockDuration)`.

## Probation

Two distinct notions in `ProjectRegistry`:

- **Initial time-based probation**: automatic window applied to every newly activated project, during `probationDuration` (30 days in production). Stake and payments work normally, but **rewards share is divided by 4** (25%). Detected via `isInProbation(projectId)`.
- **Punitive probation**: status of the `Project.Status` enum. Governance manually moves a project from `Active` to `Probation` for misconduct. Blocks new stake and payments, but **never blocks unstake**.

## Proposal

Governor object containing `(targets, values, calldatas, descriptionHash)`. Goes through states Pending → Active → Succeeded/Defeated → Queued → Executed (or Canceled/Expired). Only executable via Timelock after all delays.

## Rebate

Slice (default 5%) of a CREDIT payment that FeeRouter transfers to the project's `appRecipient`. This is how the app captures operational cash.

## Recorder (RECORDER_ROLE)

Role on `BurnTracker` granted to every listed app (typically to `FeeRouter`). Authorizes calls to `burnAndRecord`. Granted via an approved Governor proposal.

## Round

Accounting time period of the protocol. Started in `BurnTracker` (`currentRound`). Open indefinitely until governance calls `closeRound()`, which increments `currentRound` and resets `roundStartedAt`. Target duration in production: 7 days (`roundDuration = 604800`).

## Sanity cap

Maximum burn cap per `(round, projectId)` in `BurnTracker`. In production `10_000_000e18` CREDIT. Prevents an attack where a project burns absurd volume to capture disproportionate share. Value 0 = disabled (explicit opt-out by governance).

## Snapshot (of vote)

Reference block to compute voting power of a proposal. `Governor` uses `getPastVotes(account, proposalSnapshot)`; `RewardDistributor` uses `getWeightAt(user, projectId, snapshotBlock)`. Both immune to flash loans that move tokens in the same block.

## Split

`(burnBps, treasuryBps, rebateBps)` configuration in `FeeRouter` that sums exactly to 10_000 bps = 100%. Global default 9500/0/500. Can be overridden per project via `setProjectSplit` (governance) or per-hour via `setAppRecipient` (project owner, but only for the rebate recipient).

## Staking (directed)

Act of locking GOV in a specific `projectId` of the Registry. Sets weight = `amount * multiplier(lockDuration) / 1e18`. Weight feeds rewards share. See [Staking](../08-contracts-reference/05-Staking.md).

## Timelock

Contract that executes Governor decisions with a minimum delay (`minDelay`, 2 days in production). `CommunityTimelock` is a trivial subclass of OpenZeppelin's `TimelockController`. The only holder of `GOVERNANCE_ROLE` in production.

## Treasury

DAO's multi-asset vault. Receives passively (direct ERC-20 transfers) and only releases funds via an `onlyRole(GOVERNANCE_ROLE)` function. See [Treasury](../08-contracts-reference/04-Treasury.md).

## Vesting

Gradual release of GOV to a team beneficiary over time, with cliff + linear. One `TeamVesting` instance per member. See [TeamVesting](../08-contracts-reference/11-TeamVesting.md).

## Voting delay / period

Governor parameters in **blocks**:

- `votingDelay` = blocks between `propose` and the opening of voting. In production 7200 (~1 day at 12s/block).
- `votingPeriod` = voting duration. In production 50400 (~7 days).

Both adjustable via `onlyGovernance` (proposal + execution by the Timelock).

## Weight (staking)

`amount * multiplier(lockDuration) / 1e18`. Read with historic snapshot via `Staking.getWeightAt` / `Staking.getTotalWeightAt` / `Staking.getGlobalWeightAt`.

---

**Next →** [Reading paths](04-reading-paths.md)
