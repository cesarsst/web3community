# BurnTracker

**Audience:** devs of listed apps (granted `RECORDER_ROLE`), auditors.
**Prerequisites:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

## Quick overview

"Internal oracle" that on-chain accounts CREDIT burn per `(round, projectId)`. Single source of truth consumed by `RewardDistributor` to compute project share.

Every burn inside the platform goes through `burnAndRecord` — atomically burns CREDIT from the user (via `BURNER_ROLE` on CreditToken) and records the burn in the `(round, projectId)` pair.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

## Parameters and storage

| Name | Type | Value | Description |
|---|---|---|---|
| `MIN_ROUND_DURATION` | `uint64` constant | `1 days` | Lower bound |
| `MAX_ROUND_DURATION` | `uint64` constant | `30 days` | Upper bound |
| `CREDIT_TOKEN` | immutable | CREDIT | Tracked token |
| `REGISTRY` | immutable | Registry | For `isActive` gating |
| `currentRound` | `uint256` | starts at 0 | Current round |
| `roundStartedAt` | `uint64` | `block.timestamp` at deploy | Current round timestamp |
| `roundDuration` | `uint64` | production: `7 days` | Target duration |
| `maxBurnPerRoundPerProject` | `uint256` | production: `10M * 1e18` (0 = disables) | Sanity cap |
| `totalBurnByRound` | mapping | `round → uint256` | Total |
| `burnByRoundProject` | mapping | `round → projectId → uint256` | Per project |
| `projectsWithBurnCount` | mapping | `round → uint256` | Distinct count |

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |
| `RECORDER_ROLE` | `FeeRouter` (and each additional app via proposal) |

## External functions

### `burnAndRecord(uint256 projectId, address from, uint256 amount)`

Burns `amount` of CREDIT from `from` and records the burn in `(currentRound, projectId)`.

- **Who calls**: `RECORDER_ROLE`.
- **Reverts**: `ZeroAddress`, `ZeroAmount`, `ProjectNotActive`, `SanityCapExceeded`.
- **Events**: `BurnRecorded(round, projectId, from, amount, newTotalForProject)` + (from CREDIT) `BurnedByRole`.
- **ReentrancyGuard**: yes.

### Governance-gated

#### `closeRound()`

Closes current round, opens next. `currentRound++`, `roundStartedAt = now`.

- **Reverts**: only `AccessControlUnauthorizedAccount`.
- **Events**: `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)`.

`earlyClose = now < roundStartedAt + roundDuration`. Allows early close (emergency) or late (normal flow).

#### `setRoundDuration(uint64 newDuration)`

Adjusts target duration.

- **Reverts**: `InvalidRoundDuration(provided, min, max)`.
- **Events**: `RoundDurationUpdated(old, new)`.

#### `setMaxBurnPerRoundPerProject(uint256 newMax)`

Adjusts sanity cap. `0` disables.

- **Events**: `MaxBurnPerRoundPerProjectUpdated(old, new)`.

### Views

- `getCurrentRound() → uint256`.
- `getRoundEndsAt() → uint64` — `roundStartedAt + roundDuration`.
- `isRoundReadyToClose() → bool` — `now >= roundEndsAt`.
- `getBurnForProjectInRound(round, projectId) → uint256`.
- `getTotalBurnForRound(round) → uint256`.

## Events

| Event | Indexed |
|---|---|
| `BurnRecorded(round, projectId, from, amount, newTotalForProject)` | `round`, `projectId`, `from` |
| `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)` | `round` |
| `RoundDurationUpdated(oldDuration, newDuration)` | — |
| `MaxBurnPerRoundPerProjectUpdated(oldMax, newMax)` | — |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | `from` or dependencies |
| `ZeroAmount()` | `amount == 0` |
| `ProjectNotActive(projectId)` | Status ≠ Active |
| `SanityCapExceeded(projectId, attempted, cap)` | Accumulated + amount > cap |
| `InvalidRoundDuration(provided, min, max)` | Outside `[MIN_ROUND_DURATION, MAX_ROUND_DURATION]` |

## Invariants

- **I2 (Burn on consumption)**: `burnAndRecord` burns via native `burnByRole` (`_burn` decrements `totalSupply`). `totalSupply` drops by exactly `amount`.
- **I3 (sanity cap)**: `accumulated + amount <= cap` when `cap > 0`. Prevents wash-burn.
- **I4 (Governance)**: `closeRound`, `setRoundDuration`, `setMaxBurnPerRoundPerProject` require `GOVERNANCE_ROLE`.
- **I7 (Active gate)**: only `Active` projects accept `burnAndRecord`. Historical burn is not reverted if project changes status later.
- **Sequentiality**: `currentRound` only increments, never decrements. Accounting of past rounds stays accessible indefinitely.
- **CEI + ReentrancyGuard**: effects before the call to CreditToken.

## Important notes

### Why on-chain atomic (path "c")

Rejected alternatives:

- **Off-chain event listener**: depends on trusted indexer; creates a window between burn and record.
- **App records without burning**: trivial double-spend (would inflate rewards without deflation).
- **Adopted**: the app calls `BurnTracker.burnAndRecord(projectId, from, amount)` atomically. BurnTracker holds `BURNER_ROLE` on CreditToken and burns via `burnByRole` without allowance.

### `closeRound` governance-gated

Permissionless would be vulnerable — anyone would close at the moment most favorable to a specific project. Governance decides when to close.

### Close flow without RewardDistributor

The tracker **does not** call the distributor on close. The distributor consumes in pull mode (reading views). Avoids cyclic coupling.

### Round 0

Starts at `block.timestamp` at deploy. First close advances to round 1.

### Empty round

Round with no burn (`totalBurn == 0`) is allowed. `RoundClosed` event emits with `projectsCount = 0`.

### Fixed `tag` in the call to CREDIT

Always passes `"burnTracker"`. The rich tag (project, round) is already in the `BurnRecorded` event — avoids duplication.

---

**See also**: [RewardDistributor](07-RewardDistributor.md), [FeeRouter](08-FeeRouter.md), [CreditToken](02-CreditToken.md).
