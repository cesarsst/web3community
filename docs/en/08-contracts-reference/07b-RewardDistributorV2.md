# RewardDistributorV2

**Audience:** stakers checking their claim, app owners, LPs, auditors, devs integrating UIs.
**Prerequisites:** [RewardDistributor (V1)](07-RewardDistributor.md), [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Quick view

**Bucket-aware** distributor for Phase 1.4 of the Credit Liquidity Protocol (CLP) pivot. Rewrites emission logic to support a split across **4 buckets** on each `finalizeRound`:

- **Stakers** (default 55%): pull-based via `claim`/`claimMany`. Keeps V1 mechanics (`projectShare × stakeShare`).
- **LPs** (default 25%): direct push to `LiquidityGauge` via `notifyRewardAmount`. When gauge is paused, fallback to `Treasury.depositPendingGaugeRewards`.
- **Apps** (default 15%): retrospective push (burn-based). `appShare(p) = appsAmount × burn_{R-1}(p) / totalBurnPrev`. Minted directly to `ProjectRegistry.ownerRecipient(p)`.
- **Bonders** (default 5%): push to `Treasury.depositPolRefill` (earmarked POL refill in Phase 1; recycled into `BondDepository` in Phase 3).

V2 is a **parallel deploy** alongside V1. V1 stays in claim-only mode during a 4-round migration window — governance revokes V1's `MINTER_ROLE` on CREDIT after the cutoff.

The TOTAL emission formula is identical to V1 (`min(max(alpha × burn, floor), capMax)`); the bucket split is applied AFTER the cap (IE3 strengthened — no bucket exceeds `bucketBps[i] × capMax`).

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Uses `SafeERC20`.

## Parameters and storage

### Constants — bucket layout

| Name | Value |
|---|---|
| `BUCKET_STAKERS` | `0` |
| `BUCKET_LPS` | `1` |
| `BUCKET_APPS` | `2` |
| `BUCKET_BONDERS` | `3` |
| `BPS_DENOMINATOR` | `10_000` |
| `MIN_BUCKET_STAKERS_BPS` | `3000` (30%) |
| `MIN_BUCKET_LPS_BPS` | `500` (5%) |
| `MAX_BUCKET_APPS_BPS` | `2500` (25%, IE4b) |
| `MAX_BUCKET_BONDERS_BPS` | `2000` (20%) |
| `SPLIT_TOLERANCE_WEI` | `3` |

### Constants — econ params (replicated from V1)

| Name | Value |
|---|---|
| `PRECISION` | `1e18` |
| `MIN_ALPHA` | `5e17` (0.5) |
| `MAX_ALPHA` | `99e16` (0.99 — IE1) |
| `MIN_CAPMAX` | `1e18` |
| `MAX_CAPMAX` | `100_000_000e18` |
| `FLOOR_SCHEDULE_LENGTH` | `24` |
| `PROBATION_PENALTY_DENOM` | `4` |

### Dependencies (immutable)

- `CREDIT` — CreditToken.
- `STAKING` — Staking.
- `BURN_TRACKER` — BurnTracker.
- `REGISTRY` — ProjectRegistry (queried for `ownerRecipient` and probation).
- `GAUGE` — LiquidityGauge (`ILiquidityGaugeRewards`).
- `TREASURY` — Treasury (`ITreasuryRewards`, slim interface).

### Storage — bucket params

| Name | Type | Description |
|---|---|---|
| `bucketBps[4]` | `uint16[4]` | Default `[5500, 2500, 1500, 500]`. Sum exactly 10000 |
| `gaugePoolId` | `uint256` | Destination pool in the gauge. Default `1` (CREDIT/USDC 0.3%) |
| `gaugeIncentiveDuration` | `uint32` | Default `7 days`. Bounds `[1h, 90d]` |

### Storage — emission (replicated from V1)

| Name | Type | Description |
|---|---|---|
| `alpha` | `uint256` | Default `0.95e18` |
| `capMax` | `uint256` | Default `5M × 1e18` in production |
| `floorSchedule` | `uint256[24]` | Immutable post-constructor |

### Storage — round state

| Name | Type | Description |
|---|---|---|
| `lastFinalizedRound` | `uint256` | — |
| `isFirstRoundFinalized` | `bool` | Distinguishes "round 0 finalized" from "none finalized" |
| `roundData[round]` | `RoundData` | Immutable snapshot |
| `bucketEmissionByRound[round][bucket]` | `uint256` | Per-bucket audit trail |
| `claimed[round][projectId][user]` | `bool` | Anti double-claim |

### Struct `RoundData`

```solidity
struct RoundData {
    uint256 totalEmission;
    uint256 totalBurnAtFinalize;
    uint64 snapshotBlock;
    bool finalized;
}
```

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

`finalizeRound` and `claim`/`claimMany` are **permissionless**.

## External functions

### `finalizeRound(uint256 round)`

Permissionless. Applies V1 formula before the split, distributes:

1. **Checks**: sequential, round closed, not finalized.
2. **Compute**: `totalEmission = min(max(alpha × burn_{R-1}, floor(R)), capMax)`.
3. **Split** into 4 values via `bucketBps`. Bonders bucket receives the **residue** of integer division (IE12 protection against 1-2 wei loss).
4. **Effects**: writes `roundData[round]` + `bucketEmissionByRound`.
5. **Interactions**:
   - **Apps**: loop over projects with burn in round R-1, mint directly to `ownerRecipient(p)`.
   - **LPs**: mint to self, approve gauge, `notifyRewardAmount` (or fallback Treasury if paused).
   - **Bonders**: mint to Treasury, `depositPolRefill`.
   - **Stakers**: NOT minted here (lazy via `claim`).
6. **Assert IE12**: scheduled/minted sum == totalEmission (3 wei tolerance).

**Bootstrap special case (`totalBurnPrev == 0`)**: apps bucket does NOT emit — bonders absorbs the residual. Without burn there is no economic signal to distribute among apps.

- **Reverts**: `RoundAlreadyFinalized`, `OutOfOrderFinalize(expected, provided)`, `RoundNotClosed(round)`, `EmissionMismatch(totalEmission, sumBuckets)`.
- **Events**: `RoundFinalizedV2(round, totalEmission, stakersAmount, lpsAmount, appsAmount, bondersAmount)` + N × `BucketEmissionMinted` + optional `GaugePauseFallback`.

### `claim(uint256 round, uint256 projectId) -> uint256 amount`

Claims the staker reward. Lazy mint. Only the stakers bucket is processed here — buckets LPs/apps/bonders were already pushed in `finalizeRound`.

Keeps V1 semantics: marks `claimed`, computes via `projectShare × stakeShare`, mints via `CREDIT.mint`. Difference: `projectShare` now uses `bucketEmissionByRound[round][BUCKET_STAKERS]` as the base, not `totalEmission`.

- **Reverts**: `RoundNotFinalized`, `AlreadyClaimed`.
- **Events**: `Claimed(user, round, projectId, amount)` if `amount > 0`.
- **ReentrancyGuard**: yes.

### `claimMany(uint256[] rounds, uint256[] projectIds) -> uint256 total`

Batch.

- **Reverts**: `ArrayLengthMismatch`, `EmptyBatch`, `AlreadyClaimed`.

### Governance setters

#### `setBucketBps(uint16[4] newBps)`

Updates the split. Not retroactive.

Per-bucket bounds (E.8):
- `stakers >= 30%` (preserves economic signal for Phase 2 gauge controller).
- `LPs >= 5%` (IE6 — incentivised liquidity).
- `apps <= 25%` (IE4b — anti self-extraction via wash burn).
- `bonders <= 20%` (Olympus showed > 20% unleashes ponzi).
- exact sum 10000.

- **Reverts**: `BucketBpsOutOfBounds(bucket, provided, min, max)`, `BucketBpsSumInvalid(sum)`.
- **Events**: `BucketBpsUpdated(oldBps, newBps)`.

#### `setAlpha(uint256 newAlpha)` / `setCapMax(uint256 newCap)`

Identical to V1. Bounds `[MIN_ALPHA, MAX_ALPHA]` / `[MIN_CAPMAX, MAX_CAPMAX]`.

#### `setGaugePoolId(uint256 newPoolId)` / `setGaugeIncentiveDuration(uint32 newDuration)`

Configures the LPs bucket destination. `gaugeIncentiveDuration` bounds `[1h, 90d]`.

### Views

- `previewClaim(user, round, projectId) -> uint256` — preview of the stakers bucket.
- `previewEmission(forRound) -> uint256` — TOTAL emission (before split).
- `getEmission(round) -> uint256` — `roundData[round].totalEmission`.
- `getBucketEmission(round, bucket) -> uint256` — scheduled per-bucket value.
- `getProjectStakerEmission(round, projectId) -> uint256` — project share IN THE STAKERS BUCKET (with probation penalty).
- `isFinalized(round) -> bool`.
- `getBucketBps() -> uint16[4]` — current split.

## Events

| Event | Indexed |
|---|---|
| `RoundFinalizedV2(round, totalEmission, stakers, lps, apps, bonders)` | `round` |
| `BucketEmissionMinted(round, bucket, recipient, amount)` | `round`, `bucket`, `recipient` |
| `GaugePauseFallback(round, amount)` | `round` |
| `Claimed(user, round, projectId, amount)` | `user`, `round`, `projectId` |
| `BucketBpsUpdated(oldBps, newBps)` | — |
| `AlphaUpdated(oldAlpha, newAlpha)` | — |
| `CapMaxUpdated(oldCap, newCap)` | — |
| `GaugePoolIdUpdated(old, new)` | — |
| `GaugeIncentiveDurationUpdated(old, new)` | — |

## Custom errors

| Error | When |
|---|---|
| `ZeroAddress()` | Zero address in constructor |
| `RoundNotClosed(round)` | `BurnTracker.currentRound() <= round` |
| `RoundAlreadyFinalized(round)` | Second finalize |
| `RoundNotFinalized(round)` | claim without finalize |
| `OutOfOrderFinalize(expected, provided)` | Skipped a round |
| `AlreadyClaimed(round, projectId, user)` | Re-claim |
| `ArrayLengthMismatch()` / `EmptyBatch()` | Malformed `claimMany` |
| `InvalidAlpha(provided, min, max)` | alpha outside the bound |
| `InvalidCapMax(provided, min, max)` | cap outside the bound |
| `BucketBpsSumInvalid(sum)` | Sum != 10000 |
| `BucketBpsOutOfBounds(bucket, provided, min, max)` | Bucket outside per-bucket bounds |
| `EmissionMismatch(totalEmission, sumBuckets)` | IE12 violated (defensive assert) |
| `InvalidGaugeIncentiveDuration(requested)` | Outside `[1h, 90d]` |

## Invariants

- **IE1** alpha < 1: `MAX_ALPHA = 0.99e18`.
- **IE2** Temporary floor: `floorSchedule[24]` replicated from V1.
- **IE3 (strengthened)**: cap applied BEFORE the split — no bucket exceeds `bucketBps[i] × capMax`.
- **IE4b (encoded)**: `bucketBps[apps] <= 2500`. Anti self-extraction via wash burn.
- **IE12 (created)**: sum of the 4 buckets == `totalEmission` with 3 wei tolerance. Validated in `finalizeRound` via assert.
- **I5**: anti-flashloan snapshot — `snapshotBlock` unique per round, all buckets use the same one.

## Important notes

### Why stakers is lazy but LPs/apps/bonders are push?

- **Stakers**: number of stakers may be thousands. Push would iterate every one — gas explosion. Pull (claim) delegates the cost to whoever benefits.
- **LPs**: 1 call (`notifyRewardAmount`) creates the incentive in the gauge — gauge does in-range accounting for every LP. Push is O(1).
- **Apps**: loop over `1..totalProjects`. Capped by DAO proposal frequency (expected < 1000 projects). Direct mint to `ownerRecipient`. Push is O(N projects with burn).
- **Bonders**: 1 call (`depositPolRefill`) — Treasury is the "bucket". Push is O(1).

### Apps receive via retrospective burn, not via gauge weights

Phase 1 has no gauge controller (it comes in Phase 2). For now, the economic signal to distribute among apps is the **previous round's burn** — the same signal V1 used for stakers. Reason: burn is already a real measure of app usage, with no need for additional voting.

Apps wishing to capture this bucket need to:

1. Be listed in the Registry (`isActive`).
2. Generate burn (= have paying users).
3. Have `ownerRecipient(projectId)` set (or use `project.owner` fallback). Explicit setting requires a **48h timelock** in the Registry — see `proposeOwnerRecipient` / `applyOwnerRecipient`.

### Apps bucket recipient with 48h timelock

To prevent the project owner from hot-swapping the recipient between `finalizeRound` and off-chain indexing (red flag E.3 #1 of the parecer), `ownerRecipient` in the Registry has a **48h timelock**:

1. `proposeOwnerRecipient(projectId, newRecipient)` — owner only.
2. Wait `OWNER_RECIPIENT_TIMELOCK = 48h`.
3. `applyOwnerRecipient(projectId)` — permissionless after `effectiveAt`.

If `ownerRecipient(projectId)` returns `address(0)` (Removed/inexistent), share evaporates — the difference falls under IE12 tolerance.

### Gauge paused fallback

If `gauge.paused() == true` at `finalizeRound`, V2:

1. Mints `lpsAmount` to Treasury (not to self).
2. Calls `Treasury.depositPendingGaugeRewards(lpsAmount)` — accumulates in the accounting ledger.
3. Emits `GaugePauseFallback(round, amount)`.

Without fallback, pausing the gauge would freeze `finalizeRound` for the entire round (red flag E.3 #2). After unpausing, governance calls `Treasury.flushPendingGaugeRewards(duration)`.

### Migration window — V1 vs V2

During the migration window (4 rounds):

- **V1** keeps executing `claim`/`claimMany` for old-round rewards. `finalizeRound` still works (but governance will stop calling and migrate to V2).
- **V2** starts finalising new rounds with bucket-aware split.
- Both have `MINTER_ROLE` on CREDIT during the window.
- After the cutoff (4 rounds), governance **revokes V1's `MINTER_ROLE`**. V1 turns read-only.

Stakers who haven't claimed their V1 rewards may do so anytime — V1 keeps responding to `claim`, but no longer mints CREDIT (the revoke blocks `mint`). This is **intentional**: V1 rewards are only accessible during the migration window.

### Numeric split example

With `totalEmission = 902_500 CREDIT` (e.g., alpha 0.95 × burn 950k) and default split `[5500, 2500, 1500, 500]`:

| Bucket | bps | Amount |
|---|---|---|
| Stakers | 5500 | 496_375 CREDIT |
| LPs | 2500 | 225_625 CREDIT |
| Apps | 1500 | 135_375 CREDIT |
| Bonders | 500 | 45_125 CREDIT |
| **Total** | **10000** | **902_500** |

Apps' 135_375 are split proportionally among projects with burn:

```
appShare(project X) = 135_375 × burn_{R-1}(X) / totalBurnPrev
```

Stakers' 496_375 feed `_projectShare` in the claim, which applies `projectShare × stakeShare` like V1.

---

**See also**: [RewardDistributor (V1)](07-RewardDistributor.md), [Treasury](04-Treasury.md), [LiquidityGauge](13-LiquidityGauge.md), [ProjectRegistry](03-ProjectRegistry.md).
