# Treasury

**Audience:** devs building integrations with the treasury, auditors, governance proposers.
**Prerequisites:** [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md), [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Quick view

DAO multi-asset custody. Receives any ERC-20 passively (and ETH via `receive`). Only outflow path is `GOVERNANCE_ROLE` — no admin can drain funds outside the governance cycle (invariant I4).

From the Credit Liquidity Protocol (CLP, April/2026) pivot, the Treasury also:

1. **Executes FFP buyback** (Phase 1.1) — real USDC -> CREDIT swap via Uniswap V3 + immediate burn, defending the **floor price** when spot breaks below MA90 for 24h.
2. **Provisions POL** (Phase 1.2) — Protocol-Owned Liquidity in the CREDIT/USDC 0.3% pool, NFT custodied by the Treasury, full-tick range.
3. **Receives bonders bucket** (Phase 1.4) — `RewardDistributorV2` deposits 5% of per-round emission into an internal ledger (`polRefillBucket`) governance drains via `addPOLFromRefill`.
4. **Gauge paused fallback** (Phase 1.4) — if `LiquidityGauge.paused()` at the time of `finalizeRound`, V2 deposits the LPs bucket in a second ledger (`pendingGaugeRewards`) drained later via `flushPendingGaugeRewards`.

No `deposit` function for passive tokens — any payer uses `token.transfer(treasury, amount)` directly. **No pause** — unilateral power to freeze would be a capture vector.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Uses `SafeERC20`.

## Parameters and storage

### Constants

| Name | Value |
|---|---|
| `BPS_DENOMINATOR` | `10_000` |
| `MA_WINDOW_DAYS` | `90` |
| `RECORD_COOLDOWN` | `22 hours` |
| `CHAINLINK_MAX_STALENESS` | `6 hours` |
| `POL_TICK_LOWER` | `-887220` (full range, tickSpacing 60) |
| `POL_TICK_UPPER` | `887220` |

### Immutables (constructor)

- `CREDIT_TOKEN` — defended CREDIT address.
- `USDC_TOKEN` — buyback origin stablecoin. `address(0)` accepted in dev (buyback disabled until re-deploy with the official address).

### Storage — FFP (Phase 1.1)

| Name | Type | Default | Bounds |
|---|---|---|---|
| `priceOracle` | `ICreditPriceOracle` | `address(0)` | governance setter |
| `swapRouter` | `IUniswapV3SwapRouter` | `address(0)` | governance setter |
| `swapFeeTier` | `uint24` | `3000` (0.3%) | any non-zero |
| `chainlinkUsdcFeed` | `IChainlinkAggregator` | `address(0)` | governance setter |
| `floorMultiplierBps` | `uint16` | `5000` (0.50 × MA90) | `[3000, 8000]` |
| `floorAbsoluteUsd` | `uint256` | `1e17` ($0.10) | `[1e16, 1e19]` |
| `triggerDurationSecs` | `uint32` | `24 hours` | `[1h, 7d]` |
| `twapWindowSecs` | `uint32` | `30 minutes` | `[5min, 2h]` |
| `chainlinkSanityLowBps` | `uint16` | `9900` (0.99) | `[9000, 9999]` |
| `chainlinkSanityHighBps` | `uint16` | `10100` (1.01) | `[10001, 11000]` |
| `capPerEventBps` | `uint16` | `2000` (20%) | `[100, 5000]` |
| `capMonthlyBps` | `uint16` | `3000` (30%) | `[100, 7000]` |
| `slippageMaxBps` | `uint16` | `100` (1%) | `[10, 500]` |
| `lastFloorBreachTimestamp` | `uint256` | `0` | — |
| `dailyPrices[90]` | `uint256[90]` | ring buffer | — |
| `dailyPriceCount` | `uint16` | grows up to 90, then stops | — |
| `dailyPriceCursor` | `uint16` | next position to write | — |
| `dailyPriceSum` | `uint256` | running sum (O(1) MA) | — |
| `monthlySpent[monthIdx]` | mapping | USDC spent in the month | — |
| `monthlyReservesSnapshot[monthIdx]` | mapping | denominator of the monthly cap | — |

### Storage — POL (Phase 1.2)

| Name | Type | Description |
|---|---|---|
| `positionManager` | `INonfungiblePositionManager` | Uniswap V3 NPM |
| `polTokenId` | `uint256` | NFT id of the POL position (`0` = not seeded) |

### Storage — Phase 1.4 (bonders bucket + gauge fallback)

| Name | Type | Description |
|---|---|---|
| `polRefillBucket` | `uint256` | Bonders bucket internal ledger |
| `pendingGaugeRewards` | `uint256` | Gauge-paused fallback ledger |
| `liquidityGauge` | `ILiquidityGaugeRewards` | Flush destination |
| `liquidityGaugePoolId` | `uint256` | Default pool in the gauge |

## Roles and permissions

| Role | In production | Granted to |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | Grant/revoke roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | All fund outflows, buyback, POL, setters |
| `POL_REFILL_DEPOSITOR_ROLE` | `RewardDistributorV2` | `depositPolRefill` |
| `GAUGE_FALLBACK_DEPOSITOR_ROLE` | `RewardDistributorV2` | `depositPendingGaugeRewards` |

## External functions

### Basic outflows (`GOVERNANCE_ROLE`)

#### `transfer(IERC20 token, address to, uint256 amount)`

Transfers ERC-20 from the treasury.

- **Reverts**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`.
- **Events**: `Transferred(token, to, amount)`.

#### `batchTransfer(IERC20 token, address[] recipients, uint256[] amounts)`

Batch.

- **Reverts**: `ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance`.
- **Events**: N × `Transferred` + 1 × `BatchTransferred(token, total, recipientCount)`.

#### `payRebates(IERC20 token, address[] apps, uint256[] amounts, uint256 round)`

Mechanically equivalent to `batchTransfer`, with the semantic event `RebatesPaid(token, round, total, appCount)`.

#### `sweepETH(address payable to, uint256 amount)`

Withdraws custodied ETH.

- **Reverts**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `ETHTransferFailed`.
- **Events**: `ETHSwept(to, amount)`.

#### `receive() external payable`

Accepts ETH. Emits `ETHReceived(sender, amount)`.

### FFP — recordDailyPrice (permissionless)

#### `recordDailyPrice()`

Writes the current TWAP price into the ring buffer and updates the breach checkpoint. Permissionless, protected by `RECORD_COOLDOWN` (22h).

- **Breach update**:
  - Spot >= floor -> resets `lastFloorBreachTimestamp = 0`.
  - Spot < floor and timestamp == 0 -> marks current timestamp.
  - Spot < floor and timestamp > 0 -> preserves (no reset).
- **Bootstrap**: while `dailyPriceCount < 90`, `ma90Price()` returns 0 and the floor falls back to `floorAbsoluteUsd` only. Bootstrap requires 90 consecutive invocations (~90 days with daily keeper).
- **Reverts**: `BuybackInfraMissing` (oracle not set), `RecordCooldownActive(nextAllowedAt)`, `InvalidOraclePrice`.
- **Events**: `DailyPriceRecorded(caller, priceUsd18, ma90Usd18, sampleCount)`.

### FFP — executeBuyback (`GOVERNANCE_ROLE`)

#### `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)`

Executes a CREDIT buyback paid in USDC and immediate burn. Floor price defence.

**Pre-conditions (all on-chain):**

1. Infra set (oracle, router, feed) — otherwise `BuybackInfraMissing`.
2. Spot TWAP < `currentFloorPrice()` — `SpotAboveFloor` if above.
3. `block.timestamp - lastFloorBreachTimestamp >= triggerDurationSecs` — `BreachDurationInsufficient`.
4. Chainlink USDC/USD between `[chainlinkSanityLowBps, chainlinkSanityHighBps]` and fresh — `UsdcDepegDetected`/`ChainlinkStale`/`InvalidChainlinkAnswer`.
5. `usdcAmount <= per-event cap` (20% of current reserves) — `CapPerEventExceeded`.
6. `monthlySpent + usdcAmount <= monthly cap` (30% of the month snapshot) — `CapMonthlyExceeded`.
7. `usdcAmount > 0`, `minCreditOut > 0` — `ZeroAmount`.

**Action:**

1. Approve `usdcAmount` to the router.
2. `exactInputSingle(USDC -> CREDIT, recipient = treasury, amountOutMinimum = minCreditOut)`.
3. `CreditToken.burnByRole(treasury, creditOut, "treasury:buyback")` — bought CREDIT is ALWAYS burned (never accumulated).
4. Reset approve to 0.

- **Events**: `BuybackExecuted(usdcSpent, creditBurned, floorUsd, spotUsd, monthIndex)`.
- **ReentrancyGuard**: yes.

### POL — addPOL / removePOL / collectPOLFees (`GOVERNANCE_ROLE`)

#### `addPOL(uint256 creditAmount, uint256 usdcAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)`

Provisions liquidity in the CREDIT/USDC pool. FULL range (`POL_TICK_LOWER`, `POL_TICK_UPPER`). NFT custodied by the Treasury.

- First call (`polTokenId == 0`): `mint`. Stores tokenId.
- Subsequent: `increaseLiquidity` on the same tokenId.

`amount0Min`/`amount1Min` in POOL order (`token0 < token1` by address). Use the `polTokensOrdered()` view to discover ordering before submitting the proposal.

- **Reverts**: `ZeroAmount`, `BuybackInfraMissing` (USDC or positionManager not set).
- **Events**: `POLAdded(tokenId, liquidityAdded, creditAmount, usdcAmount)`.

#### `removePOL(uint128 liquidityAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)`

`decreaseLiquidity` + `collect`. Does NOT burn the NFT (a position with 0 liquidity stays available for reuse via `addPOL`).

Exit policy: the "supermajority 75% for removals > 25%" gate is the responsibility of `CommunityGovernor` (proposal type), not this contract.

- **Reverts**: `ZeroAmount`, `POLNotInitialized`, `BuybackInfraMissing`.
- **Events**: `POLRemoved(tokenId, liquidityRemoved, amount0Out, amount1Out)`.

#### `collectPOLFees(uint128 amount0Max, uint128 amount1Max)`

Collects fees accrued by the POL position. No auto-compound — to reinvest, governance calls `collectPOLFees` -> `addPOL` in separate proposals (or batch via Timelock's `executeBatch`).

- **Reverts**: `POLNotInitialized`, `BuybackInfraMissing`.
- **Events**: `POLFeesCollected(tokenId, amount0, amount1)`.

### Phase 1.4 — Bonders bucket + gauge fallback

#### `depositPolRefill(uint256 amount)` — `POL_REFILL_DEPOSITOR_ROLE`

Accumulates `amount` in `polRefillBucket`. Called by `RewardDistributorV2` after minting CREDIT directly to this Treasury.

- **Reverts**: `ZeroAmount`.
- **Events**: `PolRefillDeposited(amount, newBucketTotal)`.

#### `addPOLFromRefill(uint256 creditAmount, uint256 usdcAmount, ...)` — `GOVERNANCE_ROLE`

Drains `creditAmount` from `polRefillBucket` matched with `usdcAmount` from the Treasury's free balance for injection into `polTokenId`. Reuses `_orderTokens` + `_provisionLiquidity`.

USDC comes from the Treasury's free balance (fed by `treasuryBps` of the FeeRouter — split `(7000, 2000, 1000)` must be live).

CEI: ledger debited BEFORE the external call (idempotency on revert).

- **Reverts**: `ZeroAmount`, `BuybackInfraMissing`, `PolRefillBucketInsufficient(requested, available)`.
- **Events**: `POLAdded` + `PolRefillUsed(creditUsed, usdcUsed, newBucketTotal)`.

#### `depositPendingGaugeRewards(uint256 amount)` — `GAUGE_FALLBACK_DEPOSITOR_ROLE`

Accounting fallback when `gauge.paused() == true` at `finalizeRound`. Without this path, pausing the gauge would freeze finalisation of the entire round (red flag E.3 #2).

- **Reverts**: `ZeroAmount`.
- **Events**: `PendingGaugeDeposited(amount, newPendingTotal)`.

#### `flushPendingGaugeRewards(uint32 duration)` — `GOVERNANCE_ROLE`

Drains `pendingGaugeRewards` to the gauge via `notifyRewardAmount(poolId, amount, duration)`. Approves CREDIT, drains, reset approve.

- **Reverts**: `LiquidityGaugeNotSet`, `LiquidityGaugePaused`, `NoPendingGaugeRewards`.
- **Events**: `PendingGaugeFlushed(amount, poolId, duration)`.

#### `setLiquidityGauge(ILiquidityGaugeRewards gauge, uint256 poolId)` — `GOVERNANCE_ROLE`

Configures flush destination.

- **Events**: `LiquidityGaugeSet(gauge, poolId)`.

### FFP / POL setters (`GOVERNANCE_ROLE`)

`setPriceOracle`, `setSwapRouter`, `setSwapFeeTier`, `setChainlinkFeed`, `setFloorMultiplierBps`, `setFloorAbsoluteUsd`, `setTriggerDurationSecs`, `setTwapWindowSecs`, `setChainlinkSanityLowBps`, `setChainlinkSanityHighBps`, `setCapPerEventBps`, `setCapMonthlyBps`, `setSlippageMaxBps`, `setPositionManager`. Each one with bounds documented in the storage table.

- **Events**: `BuybackInfraUpdated(paramKey, addr, numeric)` for infra; `BuybackParamsUpdated(paramKey, newValue)` for numeric params.

### Views

- `balanceOf(IERC20 token) -> uint256`.
- `currentMonthIndex() -> uint256` — `block.timestamp / 30 days`.
- `ma90Price() -> uint256` — average in USD 18 dec (0 if not bootstrapped).
- `currentFloorPrice() -> uint256` — `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)`.
- `polPosition() -> (tokenId, liquidity, tickLower, tickUpper, tokensOwed0, tokensOwed1)` — reverts `POLNotInitialized`.
- `polTokensOrdered() -> (token0, token1, creditIsToken0)` — actual pair order in the pool.

## Events

| Event | When | Indexed |
|---|---|---|
| `Transferred(token, to, amount)` | Every outflow | `token`, `to` |
| `BatchTransferred(token, total, count)` | `batchTransfer` | `token` |
| `RebatesPaid(token, round, total, count)` | `payRebates` | `token`, `round` |
| `ETHReceived(from, amount)` | `receive` | `from` |
| `ETHSwept(to, amount)` | `sweepETH` | `to` |
| `BuybackExecuted(...)` | `executeBuyback` | `monthIndex` |
| `DailyPriceRecorded(caller, price, ma90, count)` | `recordDailyPrice` | `caller` |
| `BuybackParamsUpdated(paramKey, newValue)` | Numeric FFP setters | `paramKey` |
| `BuybackInfraUpdated(paramKey, addr, numeric)` | Infra setters | `paramKey`, `addr` |
| `POLAdded(tokenId, liquidity, creditAmount, usdcAmount)` | `addPOL` / `addPOLFromRefill` | `tokenId` |
| `POLRemoved(tokenId, liquidity, amount0, amount1)` | `removePOL` | `tokenId` |
| `POLFeesCollected(tokenId, amount0, amount1)` | `collectPOLFees` | `tokenId` |
| `PolRefillDeposited(amount, newTotal)` | `depositPolRefill` | — |
| `PolRefillUsed(creditUsed, usdcUsed, newTotal)` | `addPOLFromRefill` | — |
| `PendingGaugeDeposited(amount, newTotal)` | `depositPendingGaugeRewards` | — |
| `PendingGaugeFlushed(amount, poolId, duration)` | `flushPendingGaugeRewards` | `poolId` |
| `LiquidityGaugeSet(gauge, poolId)` | `setLiquidityGauge` | `gauge` |

## Custom errors

### Originals

`ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance(token, requested, available)`, `ETHTransferFailed`.

### FFP

| Error | When |
|---|---|
| `BuybackInfraMissing()` | Oracle/router/feed not set |
| `SpotAboveFloor(spot, floor)` | Spot >= floor |
| `BreachDurationInsufficient(elapsed, required)` | Breach < trigger duration |
| `UsdcDepegDetected(answer, low, high)` | Chainlink outside band |
| `ChainlinkStale(updatedAt, maxStaleness)` | Frozen feed |
| `InvalidChainlinkAnswer(answer)` | answer <= 0 |
| `CapPerEventExceeded(requested, cap)` | Exceeds event cap |
| `CapMonthlyExceeded(requested, alreadySpent, cap)` | Exceeds monthly cap |
| `RecordCooldownActive(nextAllowedAt)` | 22h cooldown active |
| `ParamOutOfBounds(provided, min, max)` | Setter outside bounds |
| `InvalidOraclePrice()` | Oracle returned 0 |

### POL / Phase 1.4

| Error | When |
|---|---|
| `POLNotInitialized()` | `polTokenId == 0` in remove/collect |
| `PolRefillBucketInsufficient(requested, available)` | `addPOLFromRefill` exceeds ledger |
| `LiquidityGaugeNotSet()` | `flushPendingGaugeRewards` without gauge |
| `LiquidityGaugePaused()` | Flush with gauge paused |
| `NoPendingGaugeRewards()` | Flush with empty ledger |

## Invariants

- **I4 (Governance-only exit)**: every value outflow requires `GOVERNANCE_ROLE`. In production, exclusive to the Timelock.
- **IE7 (FFP)**: buyback executed below the floor with TWAP 30min + 1% max slippage + per-event and monthly caps over the USDC reserves.
- **CREDIT bought is always burned** — never accumulated in treasury. Reinforces deflationary narrative and prevents capture via internal CREDIT whaledom.
- **No pause**: no unilateral power to freeze the treasury. Residual risk accepted in exchange for decentralisation.
- **CEI**: ledgers debited before external calls (`addPOLFromRefill`, `flushPendingGaugeRewards`).
- **ReentrancyGuard**: every value outflow + `recordDailyPrice` (external oracle).

## Important notes

### Why CREDIT bought is always burned

Accumulating CREDIT in the Treasury via buyback would create an endogenous capture agent: the protocol holding its own token. That:

1. Concentrates economic power in the cash box.
2. Distorts demand signals (Treasury would be permanent residual buyer).
3. Invites opportunistic proposals to use that CREDIT in non-deflationary flows.

Burning immediately aligns the buyback with the FFP's "demand-driven deflation" narrative.

### MA90 bootstrap

MA90 is only valid after 90 consecutive samples. Before that, `currentFloorPrice` returns `floorAbsoluteUsd` only (default $0.10). Consequence: the protocol may run for 90 days with **minimal** defence before the relative floor activates — deliberate design so bootstrap isn't blocked due to oracle absence.

### Monthly cap uses snapshot, not current balance

Snapshot is taken on the first buyback of the month. Reason: prevents an attacker from manipulating the cap by increasing USDC reserves during the month (e.g., big donation on day 28 would double the remaining ceiling).

### POL full vs concentrated range

Decision (see `audit/economist/2026-04-24-pol-params.md`): full range (`-887220`, `887220`). Reasons:

- No active rebalance (concentrated would require off-chain management).
- Capital-efficient enough in early-stage markets.
- Trivially auditable (fixed ticks, no dynamic decision).

Migration to concentrated may happen in Phase 2 once the DAO has TVL/volume data.

### POL refill — full flow

```
RewardDistributorV2.finalizeRound(R)
  -> CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
  -> Treasury.depositPolRefill(bondersAmount)
     - polRefillBucket += bondersAmount

(when governance decides)

DAO proposal: addPOLFromRefill(creditAmount, usdcAmount, ...)
  -> Treasury (Timelock executes)
  -> debit polRefillBucket
  -> _orderTokens + _approveNPM + _provisionLiquidity
  -> NPM.increaseLiquidity (or mint if first)
  -> approve reset 0
```

### USDC for refill comes from FeeRouter

For `addPOLFromRefill` to have USDC to match the CREDIT, `FeeRouter` must be set to split `(7000, 2000, 1000)` (70% burn / 20% treasury / 10% rebate). Default is `(9500, 0, 500)` — that split is a **documented prerequisite** for Phase 1.4 to produce recurring USDC. DAO decision via `setDefaultSplit`.

### ETH receipt

`receive` emits `ETHReceived` — not a silent payable. Constructor is not payable.

### Non-standard tokens

`SafeERC20` on every outflow. `forceApprove` on every approve (mainnet USDT requires reset to 0 before new set).

---

**See also**: [FeeRouter](08-FeeRouter.md), [LiquidityGauge](13-LiquidityGauge.md), [RewardDistributorV2](07b-RewardDistributorV2.md), [UserSubsidy](12-UserSubsidy.md), [TeamVesting](11-TeamVesting.md).
