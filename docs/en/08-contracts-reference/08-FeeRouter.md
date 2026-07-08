# FeeRouter

> ⚠️ **LEGACY** — superseded by the 2026-07-08 remodel (see [FeeRouterV2](08b-FeeRouterV2.md), [CreditPSM](15-CreditPSM.md) and [ProjectFunding](16-ProjectFunding.md)). Kept deployed for historical compatibility.

**Audience:** devs of apps integrating payments, auditors.
**Prerequisites:** [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md).

## Quick overview

Single payment interface between users and apps. Every CREDIT consumption goes through `pay`, which splits into three destinations (burn / treasury / rebate) as per a configurable split. Production deploy default (CLP Phase 0): `(7000, 2000, 1000)` = 70% burn / 20% treasury / 10% rebate. The `defaultSplit` comes from the deploy parameters (`production.json`), it is not hardcoded — the `.sol` NatSpec still cites the historical 95/0/5 value.

`pay` is public — any address can initiate, as long as `user` has approved the FeeRouter. Economic payer is always `user`; `msg.sender` is the tx initiator.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Uses `SafeERC20`.

## Parameters and storage

| Name | Type | Description |
|---|---|---|
| `_BPS_DENOMINATOR` | constant | `10,000` |
| `CREDIT` | immutable | CreditToken |
| `BURN_TRACKER` | immutable | BurnTracker |
| `REGISTRY` | immutable | ProjectRegistry |
| `TREASURY` | immutable | Treasury |
| `defaultSplit` | `Split` | production deploy: `(7000, 2000, 1000)` (set via constructor from `production.json`) |
| `projectSplit` | mapping | per-project override |
| `hasProjectSplit` | mapping | override flag |
| `appRecipient` | mapping | explicit override; 0 = dynamic owner |

### Struct `Split`

```solidity
struct Split {
    uint16 burnBps;
    uint16 treasuryBps;
    uint16 rebateBps;
}
// sum must be 10000
```

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## External functions

### `pay(uint256 projectId, address user, uint256 amount) → (uint256 burned, uint256 toTreasury, uint256 toApp)`

Processes payment. Pulls `amount` from `user` via `transferFrom`, splits and distributes.

- **Who calls**: public. `user` must have `CREDIT.approve(feeRouter, amount)`.
- **Reverts**: `ZeroAddress` (user), `ZeroAmount`, `ProjectNotActive`, `SanityCapExceeded` (from BurnTracker).
- **Events**: `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` + (indirect) `BurnRecorded` from BurnTracker + `BurnedByRole` from CREDIT.
- **ReentrancyGuard**: yes.

Internal pipeline:

1. Check user, amount, `REGISTRY.isActive(projectId)`.
2. `CREDIT.safeTransferFrom(user, router, amount)`.
3. Compute `(burned, toTreasury, toApp)` with dust handling — residue goes to `toApp`.
4. Distribute: `safeTransfer(recipient, toApp)`, `safeTransfer(TREASURY, toTreasury)`.
5. `forceApprove(BURN_TRACKER, burned)` + `BURN_TRACKER.burnAndRecord(projectId, router, burned)`.

### Governance-gated

#### `setDefaultSplit(Split calldata newSplit)`

- **Reverts**: `InvalidSplit` if sum ≠ 10,000.
- **Events**: `DefaultSplitUpdated(old, new)`.

#### `setProjectSplit(uint256 projectId, Split calldata newSplit)`

Writes override. Activates `hasProjectSplit[projectId] = true`.

- **Reverts**: `InvalidSplit`.
- **Events**: `ProjectSplitUpdated(projectId, newSplit)`.

#### `clearProjectSplit(uint256 projectId)`

Removes override. Resumes `defaultSplit`.

- **Reverts**: `NoProjectSplit` if there was no override (explicit idempotency).
- **Events**: `ProjectSplitCleared(projectId)`.

### Owner-gated

#### `setAppRecipient(uint256 projectId, address recipient)`

Records explicit rebate address. `address(0)` resets to dynamic lookup (`Registry.getProject(projectId).owner`).

- **Who calls**: project owner in the Registry.
- **Reverts**: `NotProjectOwner` (or bubbles `ProjectNotFound` from the Registry).
- **Events**: `AppRecipientUpdated(projectId, oldRecipient, newRecipient)`.

### Views

- `getEffectiveSplit(uint256 projectId) → Split` — override or default.
- `getEffectiveRecipient(uint256 projectId) → address`.
- `quote(uint256 projectId, uint256 amount) → (uint256 burned, uint256 toTreasury, uint256 toApp)` — no side effects; reverts with `ZeroAmount` if amount zero.

## Events

| Event | Indexed |
|---|---|
| `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` | `projectId`, `user`, `payer` |
| `DefaultSplitUpdated(oldSplit, newSplit)` | — |
| `ProjectSplitUpdated(projectId, newSplit)` | `projectId` |
| `ProjectSplitCleared(projectId)` | `projectId` |
| `AppRecipientUpdated(projectId, oldRecipient, newRecipient)` | `projectId`, `oldRecipient`, `newRecipient` |

## Custom errors

| Error | When it occurs |
|---|---|
| `InvalidSplit(burnBps, treasuryBps, rebateBps, total)` | Sum ≠ 10,000 |
| `ProjectNotActive(projectId)` | Status ≠ Active |
| `ZeroAmount()` | `amount == 0` |
| `ZeroAddress()` | Zero address |
| `NotProjectOwner(projectId, caller)` | `setAppRecipient` not being owner |
| `NoProjectSplit(projectId)` | `clearProjectSplit` without override |

## Invariants

- **I2 (Burn on consumption)**: every `pay` with `burnBps > 0` triggers `BurnTracker.burnAndRecord` atomically.
- **I4 (Governance-gated setters)**: `setDefaultSplit`, `setProjectSplit`, `clearProjectSplit`.
- **I7 (Active gate)**: `pay` requires `isActive`. Double validation with BurnTracker.
- **Split sums to 10,000**: enforced on-chain in every setter and in the constructor.
- **No custody between calls**: every `pay` is atomic. FeeRouter ends with balance 0.
- **Dust handling**: `toApp = amount - burned - toTreasury`. Rounding residue goes to the rebate.
- **ReentrancyGuard + CEI**: guard active, approve + burnAndRecord last.

## Important notes

### Why `pay` is public

Enables flexible UX:

- **User pays directly** (signs tx).
- **App pays on behalf of the user** (gas sponsorship, after prior approve).
- **Relayer / smart wallet** (AA-style).

Economic payer is always `user` (via `transferFrom`). `msg.sender` only appears in the event.

### Dynamic recipient lookup

If `appRecipient[projectId] == 0`, the recipient is `REGISTRY.getProject(projectId).owner` — auto-updates when the owner changes via `transferProjectOwnership`. Eliminates the need for manual reconfig.

### No sweep in v1

`FeeRouter` does not custody CREDIT between calls. No funds get stuck. Anomalies (tokens sent by mistake) stay — resolvable only via upgrade (there is no upgrade path in v1). Adding sweep would create a centralization surface.

### Post-deploy dependencies

- `BurnTracker.grantRole(RECORDER_ROLE, feeRouter)` — done in Phase B of deploy.
- Individual apps call `FeeRouter.pay`, not BurnTracker directly.

---

**See also**: [BurnTracker](06-BurnTracker.md), [CreditToken](02-CreditToken.md), [Treasury](04-Treasury.md).
