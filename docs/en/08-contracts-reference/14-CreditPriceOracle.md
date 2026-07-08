# CreditPriceOracle

**Audience:** auditors, devs integrating the FFP buyback, keepers of `recordDailyPrice`.
**Prerequisites:** [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md), [Treasury (reference)](04-Treasury.md).

## Quick view

Production adapter for `ICreditPriceOracle`: derives the **CREDIT TWAP in USD** (18 decimals) from the Uniswap V3 CREDIT/USDC pool, converting USDC → USD via a Chainlink USDC/USD feed. It is the **real** oracle the `Treasury` consumes in `recordDailyPrice` and `executeBuyback` (previously the adapter existed only as a test mock).

Deliberate design — a **dumb, deterministic adapter**:

- **NO owner, NO setters, NO mutable storage** — the entire configuration is immutable in the constructor. If any parameter needs to change (pool, feed, band), you deploy another adapter and governance points at the new address via `Treasury.setPriceOracle`.
- The **TWAP window is a call parameter**: the `Treasury` passes its own `twapWindowSecs` (default 30 min). The adapter has no opinion about the window size — it only rejects zero.
- `peekTwapPrice` is implemented as `view` (a valid tightening of the non-view interface): no internal state is updated.

> **License note**: this contract is **GPL-2.0-or-later** (the rest of the repo is MIT). It contains a faithful port of Uniswap V3's `TickMath.getSqrtRatioAtTick` (v3-core @ 0.7.6, GPL-2.0-or-later) to 0.8.24. The only adaptation is the `unchecked` block (the algorithm relies on controlled wrap-around that 0.8.x would revert on) and the custom error in place of `require(..., 'T')`. `_quoteAtTick` follows v3-periphery's `OracleLibrary.getQuoteAtTick`, using OpenZeppelin's `Math.mulDiv` (512-bit) in place of Uniswap's `FullMath`.

## `peekTwapPrice` pipeline

1. `pool.observe([secondsAgo, 0])` → `tickCumulatives`.
2. Arithmetic mean tick = `delta / window`, rounded toward −∞ for non-divisible negative deltas (Uniswap's `OracleLibrary` convention — without it the price would bias upward).
3. Tick → `sqrtPriceX96` via the `TickMath.getSqrtRatioAtTick` port.
4. Quote 1 whole CREDIT in raw USDC units, handling both `token0`/`token1` orderings (order detected in the constructor via `pool.token0()`).
5. Scale USDC (6 dec in production) → 18 dec (`USDC_TO_USD18_SCALE = 10^(18 - usdcDecimals)`).
6. Multiply by the Chainlink USDC/USD price (max staleness 6h + fixed sanity band `[9900, 10100]` bps), so the return is **real USD** and not nominal USDC.
   - **Explicit fallback**: if the feed is `address(0)` at deploy, the adapter assumes **1 USDC = 1 USD** (no-Chainlink mode, for networks where the feed does not exist — a deliberate deploy decision).

## Inheritance

No contract inheritance — it only implements the `ICreditPriceOracle` interface. Uses OpenZeppelin's `IERC20Metadata` and `Math`.

## Parameters and storage

### Constants

| Name | Value | Description |
|---|---|---|
| `BPS_DENOMINATOR` | `10_000` | Basis-points denominator |
| `CHAINLINK_MAX_STALENESS` | `6 hours` | Max age of the feed answer (same value as `Treasury`) |
| `CHAINLINK_SANITY_LOW_BPS` | `9900` (0.99) | Lower USDC/USD sanity band — **fixed** |
| `CHAINLINK_SANITY_HIGH_BPS` | `10_100` (1.01) | Upper band — **fixed** |
| `MIN_TICK` | `-887272` | Uniswap V3 minimum tick |
| `MAX_TICK` | `887272` | Uniswap V3 maximum tick |

> The sanity band is **fixed by design** (setter-less adapter), mirroring the `Treasury` defaults. The `Treasury` already applies its own (configurable) band in `executeBuyback`; the check here is defense in depth for `recordDailyPrice`, which does not go through the Treasury's `_enforceChainlinkSanity`. A different band ⇒ a new deploy.

### Immutables (constructor)

| Name | Type | Description |
|---|---|---|
| `POOL` | `IUniswapV3Pool` | Uniswap V3 CREDIT/USDC pool, TWAP source |
| `CREDIT_TOKEN` | `address` | CREDIT token (quote base) |
| `USDC_TOKEN` | `address` | USDC token (quote counter) |
| `CHAINLINK_USDC_FEED` | `IChainlinkAggregator` | USDC/USD feed. `address(0)` = no-Chainlink mode (1:1) |
| `CREDIT_IS_TOKEN0` | `bool` | `true` if CREDIT is the pool's `token0` (detected via `pool.token0()`) |
| `CREDIT_UNIT` | `uint128` | 1 whole CREDIT in raw units (`10^decimals` of CREDIT) |
| `USDC_TO_USD18_SCALE` | `uint256` | Scale factor raw USDC → 18 dec (`10^(18 - usdcDecimals)`; production USDC: `10^12`) |

## Constructor

```solidity
constructor(address pool_, address credit_, address usdc_, address chainlinkUsdcFeed_)
```

- Validates that the pool actually contains the `{credit, usdc}` pair (in either order) and detects the order via `pool.token0()`.
- Reads the `decimals` of both tokens ONCE and freezes the scale factors — ERC-20 decimals are immutable in practice; if a token migrates, you deploy another adapter.
- `chainlinkUsdcFeed_ == address(0)` enables the 1 USDC = 1 USD fallback (no staleness/band check — use only on networks without the feed, an explicit deploy decision).

- **Reverts**:
  - `ZeroAddress` if `pool_`, `credit_` or `usdc_` is zero.
  - `PoolTokenMismatch(token0, token1)` if `(pool.token0(), pool.token1())` does not match `{credit, usdc}`.
  - `UnsupportedDecimals(decimals)` if CREDIT or USDC has more than 18 decimals.

## External functions

### `peekTwapPrice(uint32 secondsAgo) → uint256 priceUsd18`

Returns the CREDIT TWAP in USD with 18 decimals for the most recent `secondsAgo` window. Implemented as `view` — the `Treasury` calls it via a normal CALL and it works identically.

- **Reverts**:
  - `ZeroTwapWindow` if `secondsAgo == 0`.
  - `ObserveFailed(reason)` if the pool reverts in `observe` (e.g., `"OLD"` when the observation ring-buffer cardinality is insufficient for the window).
  - `InvalidTick(tick)` if the mean tick falls outside `[MIN_TICK, MAX_TICK]`.
  - `InvalidChainlinkAnswer` / `ChainlinkStale` / `UsdcDepegDetected` depending on the feed state (only when a feed is configured).
- **No events** (view). **No storage** — it keeps no state.

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | Zero address in pool/credit/usdc in the constructor |
| `PoolTokenMismatch(token0, token1)` | Pool pair does not match `{CREDIT, USDC}` |
| `UnsupportedDecimals(decimals)` | Token with more than 18 decimals |
| `ZeroTwapWindow()` | `secondsAgo == 0` (the Treasury never sends zero — bounds `[5min, 2h]`) |
| `ObserveFailed(reason)` | `pool.observe` reverted (e.g., `"OLD"`) — raw revert bytes attached |
| `InvalidTick(tick)` | Mean tick outside `[MIN_TICK, MAX_TICK]` — corrupted pool or invalid mock |
| `ChainlinkStale(updatedAt, maxStaleness)` | Feed returns stale data |
| `InvalidChainlinkAnswer(answer)` | Feed returns a price ≤ 0 |
| `UsdcDepegDetected(reportedAnswer, lowBound, highBound)` | USDC/USD feed outside the `[9900, 10100]` bps band |

## Invariants

- **Total immutability**: no owner, no setters, no mutable storage. Config change ⇒ new deploy + `Treasury.setPriceOracle`.
- **Real USD, not nominal USDC**: the output is multiplied by the Chainlink USDC/USD price (or 1:1 in fallback), so a USDC depeg does not silently pass as a valid CREDIT price.
- **Defense in depth**: the fixed sanity band protects `recordDailyPrice`, which lacks the Treasury's check.
- **Numeric convention**: `1e18 = $1.00`, `5e17 = $0.50` — same as the `ICreditPriceOracle` interface.

## Important notes

### Why the TWAP window is not immutable

The adapter is agnostic to the window size — the `Treasury` decides (`twapWindowSecs`, configurable in `[5min, 2h]`). This way, tuning the buyback window does not require re-deploying the oracle. The adapter only rejects `secondsAgo == 0`.

### No-Chainlink mode (1:1 fallback)

`CHAINLINK_USDC_FEED == address(0)` makes the adapter treat 1 USDC = 1 USD without a staleness or band check. It is deliberate for environments (dev/testnet or networks without the official feed) where the feed does not exist. On production mainnet the feed **must** be supplied — otherwise a USDC depeg would go undetected.

### Pair-order detection

The `token0`/`token1` order is detected in the constructor via `pool.token0()` and frozen in `CREDIT_IS_TOKEN0`. `_quoteAtTick` uses that flag to quote 1 CREDIT in USDC in the correct direction, without relying on address ordering at runtime.

### Relationship with the Treasury

- `Treasury.recordDailyPrice` reads `priceOracle.peekTwapPrice(twapWindowSecs)` — permissionless, 22h cooldown.
- `Treasury.executeBuyback` reads the same value to compare spot vs floor.
- While `Treasury.priceOracle == address(0)`, both revert with `BuybackInfraMissing` — the buyback stays disabled until governance sets the adapter via `setPriceOracle`.

---

**See also**: [Treasury](04-Treasury.md), [CreditToken](02-CreditToken.md), [LiquidityGauge](13-LiquidityGauge.md).
