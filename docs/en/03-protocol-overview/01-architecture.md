# Architecture

**Audience:** dev seeking a complete map of dependencies between contracts.
**Prerequisites:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Governance](../02-core-concepts/05-governance.md).

## Full map (post-CLP pivot, Phase 1)

```
                               +-----------------------------+
                               |     CommunityGovernor       |    (political layer)
                               |     - collects votes        |
                               |     - creates proposals     |
                               +-------------+---------------+
                                             | schedule()
                                             v
                               +-----------------------------+
                               |     CommunityTimelock       |    (executor)
                               |     holds GOVERNANCE_ROLE   |
                               |     on every contract below |
                               +----+-------------------+----+
                                    |                   |
          +---------+----------+----+----+--------+--------+----------+----------+
          |         |          |         |        |        |          |          |
          v         v          v         v        v        v          v          v
  +---------+  +----------+  +-------+  +------+  +-----+  +-------+  +-------+  +-----+
  |Project- |  | Treasury |  |Staking|  |Burn- |  |Fee- |  |Liquid-|  |Reward-|  |Reward
  |Registry |  | + FFP    |  |stake+ |  |Tracke|  |Route|  |ity-   |  |Distri-|  |Distri-
  | whtlst  |  | + POL    |  |weights|  |burn  |  |split|  |Gauge  |  |butor  |  |buto-
  | + ownerR|  | + buckets|  |       |  |      |  |     |  |LP rwd |  |  V1   |  |rV2
  +----+----+  +----+-----+  +---+---+  +--+---+  +--+--+  +---+---+  +---+---+  +---+--+
       |            ^            |         |        |        ^           ^         |
       | isActive/  |            |         |        |        |           |         |
       | isInProb./ | spend +    |         |        | apprv  | notify    | claim   | finaliz
       | ownerRecip.| addPOL     |         |        | +burn  | (LP rwd)  | (V1)    | + push
       v            | +buckets   v         v        v        |           |         | apps/lps/bond
      +-------------+----------------------+--------+--------+-----------+---------+
      |                          RewardDistributorV2                              |
      | totalEmission = min(max(alpha*burn, floor), capMax)                       |
      | split into 4 buckets: stakers (lazy) | LPs (push gauge) | apps (push)     |
      |                       | bonders (push Treasury polRefill)                 |
      +---------------------------------------------------------------------------+
                                             ^
                             grants MINTER_ROLE (V1 + V2, during migration window)
                             after cutoff: V1 loses MINTER_ROLE
                                             |
                               +-----------------------------+
                               |        CreditToken          |
                               |        ERC-20 burnable      |
                               +-----------------------------+
                                             ^
                                             | burnByRole
                               +-----------------------------+
                               |        BurnTracker          | (loops back here because
                               +-----------------------------+  it calls burnByRole on CREDIT)

   GovernanceToken (GOV) ---- staked in Staking
                         ---- collateral in ProjectRegistry
                         ---- vested in TeamVesting
                         ---- votes in CommunityGovernor

   External Uniswap V3 pool: CREDIT/USDC 0.3%
       ^                                ^
       | (POL custodied by Treasury)    | (external LP + UniswapV3Staker
       |                                |  controlled by LiquidityGauge)
       |                                |
   Treasury.polTokenId          LiquidityGauge.stake(tokenId, poolId)

   Auxiliary contracts:
   +----------------+   +------------------+
   |  TeamVesting   |   |   UserSubsidy    |
   |  GOV vesting   |   | CREDIT subsidy   |
   |  per-member    |   | via Merkle drops |
   +----------------+   +------------------+
   (funded by Timelock with GOV/CREDIT transferred from the Treasury)
```

## Who calls whom

| Caller | Calls | When |
|---|---|---|
| `FeeRouter.pay` | `CREDIT.transferFrom(user, this, amount)` | pulls the full amount |
| `FeeRouter.pay` | `CREDIT.transfer(recipient, toApp)` | pays rebate to the app |
| `FeeRouter.pay` | `CREDIT.transfer(treasury, toTreasury)` | when `treasuryBps > 0` |
| `FeeRouter.pay` | `CREDIT.forceApprove(burnTracker, burned)` + `BurnTracker.burnAndRecord` | burns the burn slice |
| `BurnTracker.burnAndRecord` | `CREDIT.burnByRole(from, amount, tag)` | native `_burn` |
| `RewardDistributorV2.finalizeRound` | `BurnTracker.getTotalBurnForRound(round-1)` | reads previous burn |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(ownerRecipient(p), share, "rewardRound:apps")` | apps bucket |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(self, lpsAmount)` + `gauge.notifyRewardAmount(...)` | LPs bucket (active gauge) |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(treasury, lpsAmount)` + `treasury.depositPendingGaugeRewards(...)` | LPs bucket (paused gauge) |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(treasury, bondersAmount)` + `treasury.depositPolRefill(...)` | bonders bucket |
| `RewardDistributorV2._calculateClaim` | `Staking.getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` | weight snapshot |
| `RewardDistributorV2._calculateClaim` | `ProjectRegistry.isInProbation(projectId)` | penalty |
| `RewardDistributorV2._claim` | `CREDIT.mint(user, amount, "rewardRoundV2:stakers")` | stakers bucket (lazy) |
| `Treasury.executeBuyback` | `swapRouter.exactInputSingle(USDC->CREDIT)` + `CREDIT.burnByRole(self, ...)` | FFP buyback |
| `Treasury.recordDailyPrice` | `priceOracle.peekTwapPrice(twapWindowSecs)` | updates MA90 + breach |
| `Treasury.addPOL` / `addPOLFromRefill` | `NPM.mint` or `NPM.increaseLiquidity` | provisions POL |
| `Treasury.flushPendingGaugeRewards` | `gauge.notifyRewardAmount(poolId, amount, duration)` | drains fallback |
| `LiquidityGauge.stake` | `NPM.safeTransferFrom(user->staker, tokenId, IncentiveKey)` | auto-stake on official staker |
| `LiquidityGauge.unstake` | `STAKER.unstakeToken/claimReward/withdrawToken` | exit + creates VestingPosition |
| `LiquidityGauge.harvest` | `CREDIT.safeTransfer(user, claimed)` | withdraws vested |
| `Staking.stake` / `increaseStake` | `ProjectRegistry.isActive(projectId)` | gate |
| `Staking.stake` | `GOV.safeTransferFrom(user, this, amount)` | pulls collateral |
| `Staking.unstake` | `ProjectRegistry.getProject(projectId)` | bypass if Removed |
| `Staking.unstake` | `GOV.safeTransfer(user, amount)` | returns |
| `ProjectRegistry.registerProject` | `GOV.safeTransferFrom(owner, this, collateral)` | pulls collateral |
| `ProjectRegistry.removeProject` | `GOV.safeTransfer(destination, collateral)` | returns or slashes |
| `FeeRouter.pay` | `ProjectRegistry.isActive(projectId)` | gate |
| `FeeRouter._effectiveRecipient` | `ProjectRegistry.getProject(projectId)` | dynamic owner lookup |
| `RewardDistributorV2._emitAppsBucket` | `ProjectRegistry.ownerRecipient(p)` | apps recipient (48h timelock) |
| `Treasury.payRebates` | `TOKEN.safeTransfer(app, amount)` | batch to apps |
| `CommunityGovernor._queueOperations` | `CommunityTimelock.schedule(...)` | queues execution |
| `CommunityTimelock.execute*` | `CALLS.execute(...)` | calls the target function (Registry, Treasury, etc.) |

## Post-deploy: the role graph (CLP Phase 1.4)

```
   CommunityTimelock (self-administered after handoff)
       |
       |  holds GOVERNANCE_ROLE on:
       |  - Treasury (incl. FFP, POL, Phase 1.4 ledgers)
       |  - ProjectRegistry (incl. cancelOwnerRecipient escape hatch)
       |  - BurnTracker
       |  - RewardDistributor (V1 — claim-only)
       |  - RewardDistributorV2
       |  - FeeRouter
       |  - LiquidityGauge
       |  - UserSubsidy
       |
       |  holds DEFAULT_ADMIN_ROLE on all of the above
       |
       |  is owner of:
       |  - GovernanceToken (after acceptOwnership)
       |  - each TeamVesting

   CommunityGovernor
       |
       |  holds PROPOSER_ROLE + CANCELLER_ROLE on the Timelock

   address(0)
       |
       |  counts as authorised executor on the Timelock
       |  (anyone may call execute after the delay)

   RewardDistributor (V1)
       |
       |  holds MINTER_ROLE on CreditToken (during the 4-round migration window)
       |  after cutoff: governance revokes MINTER_ROLE — V1 becomes read-only

   RewardDistributorV2
       |
       |  holds MINTER_ROLE on CreditToken (permanent)
       |  holds POL_REFILL_DEPOSITOR_ROLE on Treasury
       |  holds GAUGE_FALLBACK_DEPOSITOR_ROLE on Treasury
       |  holds REWARD_NOTIFIER_ROLE on LiquidityGauge

   BurnTracker
       |
       |  holds BURNER_ROLE on CreditToken

   FeeRouter
       |
       |  holds RECORDER_ROLE on BurnTracker (v1 bootstrap)
       |  newly listed apps also receive RECORDER_ROLE
       |  (via approved proposal + Timelock execution)

   LiquidityGauge
       |
       |  REWARD_NOTIFIER_ROLE plural:
       |  - granted to Treasury (manual path: flushPendingGaugeRewards)
       |  - granted to RewardDistributorV2 (automatic path in finalizeRound)
       |
       |  anti-self-dealing denylist:
       |  - Treasury, Staking, RewardDistributor*, FeeRouter denylisted
       |    at bootstrap (D.9 — protocol does not pay rewards to itself)
```

## Solidity import dependencies

```
GovernanceToken       -> OZ: ERC20, ERC20Permit, ERC20Votes, Ownable2Step
CreditToken           -> OZ: ERC20, ERC20Burnable, AccessControl
ProjectRegistry       -> OZ: IERC20, SafeERC20, AccessControl
Treasury              -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + interfaces: IUniswapV3SwapRouter, INonfungiblePositionManager,
                                        IChainlinkAggregator, ICreditPriceOracle,
                                        ICreditTokenBurnable, ILiquidityGaugeRewards
Staking               -> OZ: IERC20, SafeERC20, ReentrancyGuard, Checkpoints, SafeCast
                          + ProjectRegistry
BurnTracker           -> OZ: AccessControl, ReentrancyGuard
                          + CreditToken, ProjectRegistry
RewardDistributor     -> OZ: AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Staking
RewardDistributorV2   -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Staking
                          + interfaces: ILiquidityGaugeRewards, ITreasuryRewards
LiquidityGauge        -> OZ: IERC20, SafeERC20, IERC721, IERC721Receiver,
                              AccessControl, ReentrancyGuard, Pausable
                          + interfaces: IUniswapV3Staker, IUniswapV3Pool
FeeRouter             -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Treasury
CommunityTimelock     -> OZ: TimelockController
CommunityGovernor     -> OZ: Governor + 5 extensions
TeamVesting           -> OZ: IERC20, SafeERC20, Ownable, Ownable2Step
UserSubsidy           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard, MerkleProof
```

## Anti-flashloan — two parallel rails

The system protects two simultaneous dimensions against flash-loan manipulation:

1. **Vote** — `Governor` uses `ERC20Votes.getPastVotes(account, proposalSnapshot)`. Anyone taking a flash-loan in the voting block cannot vote, because the snapshot is in the past (`votingDelay` blocks before the current block).

2. **Reward weight** — `RewardDistributor` uses `Staking.getWeightAt(user, projectId, snapshotBlock)`. Flash-stake on the finalize block does not enter the reward, because the snapshot is written **at finalize time** and queried thereafter.

In both cases, the attacker would need to hold the position for **at least one block** before the reference window, and a flash-loan demands repayment within the same block — incompatible.

## Trust points

**Trustworthy by construction** (immutable, audited code):

- All OZ 5.0.2 libs pinned.
- GOV cap.
- Burn shape (native ERC-20 `_burn`, decrements `totalSupply`).
- Emission formula (`min(max(alpha*burn, floor), capMax)`) — invariant IE1 (`MAX_ALPHA = 0.99e18`).
- Anti-flashloan snapshots.
- Per-bucket bounds in V2 (`MIN_BUCKET_STAKERS_BPS = 3000`, etc.).
- IE12 (sum of buckets == totalEmission) — defensive assert in `finalizeRound`.
- FFP buyback floor + caps — bounds hardcoded in `_checkBounds`.

**Trustworthy by governance** (changeable via proposal, but the change goes through every delay):

- `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration` values.
- FeeRouter splits.
- V2 `bucketBps` (within per-bucket bounds).
- FFP parameters (`floorMultiplierBps`, `triggerDurationSecs`, caps, slippage).
- Governor parameters (voting delay, period, threshold, quorum).
- Gauge vesting duration (`[1d, 90d]`).

**Trustworthy from outside the system** (depends on external integration):

- Uniswap V3 — CREDIT/USDC pool, swap router, NPM, UniswapV3Staker. Canonical Uniswap Foundation addresses.
- Chainlink USDC/USD — feed for sanity check before buyback.
- CREDIT TWAP oracle — `priceOracle` set via governance.
- Off-chain data integrity in projects' `metadataURI` (the Registry stores only the CID).

---

**Next ->** [User flows](02-user-flows.md)
