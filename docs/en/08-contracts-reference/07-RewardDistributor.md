# RewardDistributor (V1)

**Audience:** stakers checking unclaimed V1 reward previews, auditors, devs integrating reward UIs.
**Prerequisites:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Rewards distribution](../02-core-concepts/04-rewards-distribution.md), [RewardDistributorV2](07b-RewardDistributorV2.md).

> **Status post-CLP pivot (Phase 1.4):** V1 enters **claim-only** mode during the 4-round migration window. `finalizeRound` keeps working but won't be called in production anymore — new rounds are finalised by [RewardDistributorV2](07b-RewardDistributorV2.md). After the cutoff, governance **revokes V1's `MINTER_ROLE`** on the CreditToken, and `claim` keeps responding (without minting) until stakers clear their historical rewards. The doc below describes V1 as deployed.

## Quick view

V1 emission distributor (pre-CLP). Computes per-round CREDIT emission and mints on demand for stakers via pull-based claim.

Formula: `emission_R = min(max(alpha * burn_{R-1}, floor(R)), capMax)`. **All** emission is treated as a single stakers bucket (no LPs/apps/bonders split — that is V2). Per-project emission is computed on demand in `_calculateClaim` to scale gas with claim count, not project count.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

## Parameters and storage

### Constants

| Name | Value |
|---|---|
| `PRECISION` | `1e18` |
| `MIN_ALPHA` | `5e17` (0.5) |
| `MAX_ALPHA` | `99e16` (0.99) — reduced from `11e17` to enforce IE1 (α<1 permanent) by construction; see `audit/economist/2026-04-22-consistency-audit.md` C2 |
| `MIN_CAPMAX` | `1e18` |
| `MAX_CAPMAX` | `100_000_000e18` |
| `FLOOR_SCHEDULE_LENGTH` | `24` |
| `PROBATION_PENALTY_DENOM` | `4` |

### Dependencies (immutable)

- `CREDIT` — CreditToken.
- `STAKING` — Staking.
- `BURN_TRACKER` — BurnTracker.
- `REGISTRY` — ProjectRegistry.

### Storage

| Name | Type | Description |
|---|---|---|
| `alpha` | `uint256` | production: `0.95e18`. Tunable by governance. |
| `capMax` | `uint256` | production: `5M * 1e18`. Tunable. |
| `floorSchedule` | `uint256[24]` | immutable post-constructor |
| `lastFinalizedRound` | `uint256` | — |
| `isFirstRoundFinalized` | `bool` | one-shot to mark "round 0 finalized" |
| `roundData` | mapping | `round -> RoundData` |
| `claimed` | mapping | `round -> projectId -> user -> bool` |

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

`finalizeRound` and `claim` / `claimMany` are **permissionless** — anyone can call.

## External functions

### `finalizeRound(uint256 round)`

Writes immutable `roundData[round]`. Permissionless.

- **Reverts**: `RoundAlreadyFinalized`, `OutOfOrderFinalize(expected, provided)`, `RoundNotClosed(round)`.
- **Events**: `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)`.

Pre-conditions:

- `!roundData[round].finalized`.
- `round == expected` (sequential).
- `BURN_TRACKER.currentRound() > round`.

### `claim(uint256 round, uint256 projectId) -> uint256 amount`

Claims `msg.sender`'s reward. Marks `claimed` and mints CREDIT if `amount > 0`.

- **Reverts**: `RoundNotFinalized`, `AlreadyClaimed`.
- **Events**: `Claimed(user, round, projectId, amount)` if `amount > 0`.
- **ReentrancyGuard**: yes.

### `claimMany(uint256[] rounds, uint256[] projectIds) -> uint256 total`

Batch.

- **Reverts**: `ArrayLengthMismatch`, `EmptyBatch`, `AlreadyClaimed` on any pair.
- Entries with `amount == 0` are no-ops (do not mark claimed).

### Governance-gated

#### `setAlpha(uint256 newAlpha)`

- **Reverts**: `InvalidAlpha(provided, min, max)` if outside `[MIN_ALPHA, MAX_ALPHA]`.
- **Events**: `AlphaUpdated(old, new)`.
- Affects only non-finalized rounds.

#### `setCapMax(uint256 newCap)`

- **Reverts**: `InvalidCapMax(provided, min, max)` if outside `[MIN_CAPMAX, MAX_CAPMAX]`.
- **Events**: `CapMaxUpdated(old, new)`.

### Views

- `previewClaim(user, round, projectId) -> uint256` — no side effects.
- `previewEmission(forRound) -> uint256` — applies formula with current state.
- `getEmission(round) -> uint256` — `roundData[round].totalEmission`.
- `getProjectEmission(round, projectId) -> uint256` — project share.
- `isFinalized(round) -> bool`.

## Events

| Event | Indexed |
|---|---|
| `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)` | `round` |
| `Claimed(user, round, projectId, amount)` | `user`, `round`, `projectId` |
| `AlphaUpdated(oldAlpha, newAlpha)` | — |
| `CapMaxUpdated(oldCap, newCap)` | — |

## Custom errors

| Error | When |
|---|---|
| `ZeroAddress()` | Zero address in constructor |
| `RoundNotClosed(round)` | `BurnTracker.currentRound() <= round` |
| `RoundAlreadyFinalized(round)` | Second finalize attempt |
| `RoundNotFinalized(round)` | claim/preview without finalize |
| `OutOfOrderFinalize(expected, provided)` | Skipped a round |
| `AlreadyClaimed(round, projectId, user)` | Re-claim |
| `ArrayLengthMismatch()` | `claimMany` arrays differ |
| `EmptyBatch()` | empty `claimMany` |
| `InvalidAlpha(provided, min, max)` | alpha outside the bound |
| `InvalidCapMax(provided, min, max)` | cap outside the bound |

## Invariants

- **I2**: burn yields rewards through consumption, not through passive volume.
- **I3**: per-round cap (`capMax` + decreasing schedule) ensures bounded emission.
- **I5**: historical Staking snapshot (`getWeightAt`) prevents flash-stake.
- **I6**: 14d minimum lock in Staking makes flash-stake infeasible.
- **I7**: probation penalty for new projects (25% share).
- **Sequentiality**: `finalizeRound` only accepts `round == lastFinalizedRound + 1` (or 0 if first).
- **Finalised round immutability**: after finalize, `roundData[round]` is immutable. Changing `alpha`/`capMax` only affects rounds yet to be finalized.
- **Silent no-op**: `claim` with `amount == 0` does not mark `claimed[...][user] = true` — allows retry if state changed.

## Important notes

### Two `_projectShare` paths

**With previous burn:**

```
share = emission * projectBurnPrev / totalBurnPrev
```

**Without previous burn (bootstrap):**

```
share = emission * projectWeightSnapshot / globalWeightSnapshot
```

Detection: `rd.totalBurnAtFinalize == 0`. Requires `Staking.getGlobalWeightAt` (global rail, O(1) per Staking update).

### Probation penalty applied at claim

`REGISTRY.isInProbation(projectId)` is queried at the time of claim, **not** finalize. If probation ended between finalize and claim, the user receives the full share. There is no manipulation vector because `probationEndsAt` is set on `activateProject` and never changes.

### Immutable FloorSchedule

Written in the constructor. 24 entries. Rounds >= 24 have no floor. In production: decays linearly from 400k down to ~16,666 CREDIT.

### `uint256[24]` schedule in constructor

FIXED array (not dynamic) forces the caller to pass exactly 24 values. A dynamic array would require an extra check — here it is cheap and explicit.

### Initial admin renounces after handoff

Deploy: `DEFAULT_ADMIN_ROLE` and `GOVERNANCE_ROLE` granted to `admin` (deployer). Handoff transfers both to the Timelock and renounces. In production, only the Timelock governs.

### Migration to V2 (CLP Phase 1.4)

The migration window is **4 rounds**:

1. V2 starts finalising new rounds with bucket-aware split.
2. V1 keeps responding to `claim`/`claimMany` for old rounds.
3. Both have `MINTER_ROLE` on CREDIT during the window.
4. **After the cutoff**: governance revokes V1's `MINTER_ROLE` on CreditToken. V1 turns read-only — `claim` still computes the amount but `mint` fails. Stakers who haven't cleared V1 rewards lose access to them.

Stakers should claim **aggressively** during the migration window so as not to lose V1 rewards.

---

**See also**: [RewardDistributorV2](07b-RewardDistributorV2.md), [Staking](05-Staking.md), [BurnTracker](06-BurnTracker.md), [CreditToken](02-CreditToken.md).
