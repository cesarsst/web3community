# Architecture

**Audience:** dev seeking a complete map of dependencies between contracts.
**Prerequisites:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Governance](../02-core-concepts/05-governance.md).

## The current rail (2026-07-08 remodel) — 3 new contracts

Since the remodel, the active economic flow goes through **CreditPSM → FeeRouterV2 → ProjectFunding**. The burn-to-mint cycle (V1 FeeRouter, BurnTracker, RewardDistributor V1/V2, LiquidityGauge) stays deployed as legacy, outside the current flow.

```
   [ user's USDC ]
        |
        | buy() 1:1 (6 -> 18 dec)                    sell() 1:1 (burns CREDIT,
        v                                            returns USDC)
   +-----------------------------+  <---------------------------------+
   |         CreditPSM           |                                    |
   |  USDC backing 100% held     |   MINTER_ROLE + BURNER_ROLE        |
   |  no withdrawal function     |   on CreditToken                   |
   +-------------+---------------+                                    |
                 | stable CREDIT (1:1 USDC)                           |
                 v                                                    |
   +-----------------------------+       +--------------------------+ |
   |        FeeRouterV2          |       |      ProjectFunding      | |
   |  pay(projectId, amount)     |       |  openRound (owner, 1x)   | |
   |  fee 2.5% (hard cap 5%)     |       |  invest (requires GOV    | |
   |    40% treasury             |       |    staked on project)    | |
   |    40% GOV buyback          | rev-  |  all-or-nothing          | |
   |    20% grants               | share |  claim (rev-share,       | |
   |  grossVolumeOf[projectId]   |------>|    never expires)        | |
   +------+---------------+-----+notify |  totalRevenueDistributed | |
          |               |     Revenue +------------+-------------+ |
          | isActive      |                          | getWeight     |
          v               | toApp (~89.5-97.5%)      v               |
   +--------------+       |                  +--------------+        |
   | Project-     |       +----------------> | Staking      |        |
   | Registry     |         appRecipient     | (GOV, invest |        |
   | (whitelist)  |         instantly        |  gate)       |        |
   +--------------+                          +--------------+        |
                                                                     |
   [ investor / app / treasury ] --- CREDIT redeemable at any time
```

Who calls whom (current rail):

| Caller | Calls | When |
|---|---|---|
| `CreditPSM.buy` | `USDC.safeTransferFrom` + `CREDIT.mint(user, ..., "psm:buy")` | 1:1 purchase |
| `CreditPSM.sell` | `CREDIT.safeTransferFrom` + `CREDIT.burnByRole(psm, ..., "psm:sell")` + `USDC.safeTransfer` | 1:1 redemption |
| `FeeRouterV2.pay` | `REGISTRY.isActive(projectId)` | gate |
| `FeeRouterV2.pay` | `CREDIT.safeTransferFrom(payer, router, amount)` | pulls the payment |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer` to treasury/buyback/grants | 40/40/20 fee split |
| `FeeRouterV2.pay` | `FUNDING.revShareBpsOf(projectId)` | reads the active rev-share |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer(funding, revShare)` + `FUNDING.notifyRevenue` | credits investors |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer(appRecipient, toApp)` | pays the app instantly |
| `ProjectFunding.openRound` | `REGISTRY.isActive` + `getProject(...).owner` | owner only, Active project |
| `ProjectFunding.invest` / `claim` | `STAKING.getWeight(investor, projectId)` | staked-GOV gate |
| `ProjectFunding.invest` (target hit) | `CREDIT.safeTransfer(owner, raised)` | all-or-nothing pays the owner |

Current-rail roles:

```
   CreditPSM
       |  holds MINTER_ROLE + BURNER_ROLE on CreditToken
       |  (no AccessControl of its own — zero admin surface)

   FeeRouterV2
       |  GOVERNANCE_ROLE (Timelock): setFeeBps (cap 500), setFeeSplit, setRecipients
       |  holds REVENUE_NOTIFIER_ROLE on ProjectFunding

   ProjectFunding
       |  GOVERNANCE_ROLE (Timelock): setMinTarget
       |  REVENUE_NOTIFIER_ROLE granted to FeeRouterV2
```

Per-contract reference: [CreditPSM](../08-contracts-reference/15-CreditPSM.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

## Legacy burn-to-mint rail map (pre-remodel) — remaining contracts

> ⚠️ **LEGACY** — the map below describes the burn-to-mint cycle superseded by the 2026-07-08 remodel. The contracts remain deployed for historical compatibility (old claims, on-chain data), but the current economic flow is the section above. Registry, Staking, Treasury, tokens and governance (Governor/Timelock) remain active on both rails.

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

## Who calls whom (legacy rail)

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

## Post-deploy: the role graph

```
   CommunityTimelock (self-administered after handoff)
       |
       |  holds GOVERNANCE_ROLE on:
       |  - FeeRouterV2 (fee, fee split, recipients)        [current]
       |  - ProjectFunding (minTarget)                      [current]
       |  - Treasury (incl. FFP, POL, Phase 1.4 ledgers)
       |  - ProjectRegistry (incl. cancelOwnerRecipient escape hatch)
       |  - BurnTracker                                     [legacy]
       |  - RewardDistributor (V1 — claim-only)             [legacy]
       |  - RewardDistributorV2                             [legacy]
       |  - FeeRouter                                       [legacy]
       |  - LiquidityGauge                                  [legacy]
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

   CreditPSM
       |
       |  holds MINTER_ROLE + BURNER_ROLE on CreditToken (current rail;
       |  burn always over its own balance, mint 1:1 backed)

   FeeRouterV2
       |
       |  holds REVENUE_NOTIFIER_ROLE on ProjectFunding
       |  (only address authorized to notifyRevenue)

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
CreditPSM             -> OZ: IERC20, IERC20Metadata, SafeERC20, ReentrancyGuard
                          + CreditToken
FeeRouterV2           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + ProjectRegistry, ProjectFunding
ProjectFunding        -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + ProjectRegistry, Staking
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
- **PSM backing** (I-PSM1): there is no USDC withdrawal function in the `CreditPSM` — not even for governance. Exact 1:1 conversion (I-PSM2).
- **Hard fee cap**: `FEE_BPS_CAP = 500` (5%) in FeeRouterV2 — not even an approved proposal can exceed it.
- **Funding bounds**: rev-share `[100, 3000]` bps and duration `[1, 90]` days are constants in ProjectFunding; all-or-nothing enforced on-chain.
- Anti-flashloan snapshots.
- Legacy: burn shape (native `_burn`), emission formula (invariant IE1, `MAX_ALPHA = 0.99e18`), V2 bucket bounds, IE12, FFP floor + caps.

**Trustworthy by governance** (changeable via proposal, but the change goes through every delay):

- FeeRouterV2 `feeBps` (up to the 500 cap), `feeSplit` (sums 10,000) and fee recipients.
- ProjectFunding `minTarget`.
- `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration` values (legacy).
- FeeRouter splits (legacy).
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
