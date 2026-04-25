# ProjectRegistry

**Audience:** devs listing projects, auditors, stakers checking status.
**Prerequisites:** [Project whitelist](../02-core-concepts/06-project-whitelist.md).

## Quick view

On-chain whitelist of ecosystem projects/apps. Single source of truth for:

- Who owns each project.
- How much GOV was locked as collateral (skin in the game).
- Project status (`Pending`, `Active`, `Probation`, `Removed`).
- Off-chain metadata URI.
- **`ownerRecipient`** — canonical destination for the apps bucket of `RewardDistributorV2` (Phase 1.4), with 48h timelock.

Consumed by `Staking`, `BurnTracker`, `RewardDistributor`/`RewardDistributorV2` and `FeeRouter` for gating and owner/recipient lookup.

## Inheritance

```
AccessControl (OZ)
```

Uses `SafeERC20` for GOV movements.

## Parameters and storage

### Constants

| Name | Value |
|---|---|
| `OWNER_RECIPIENT_TIMELOCK` | `48 hours` |

### Storage

| Name | Type | Description |
|---|---|---|
| `GOV_TOKEN` | `IERC20` immutable | GovernanceToken address |
| `minCollateral` | `uint256` | Minimum collateral (production: `10,000 * 1e18`) |
| `probationDuration` | `uint64` | Initial probation duration (production: `30 days`) |
| `_nextProjectId` | `uint256` private | Next ID (starts at 1) |
| `_projects` | mapping | `projectId -> Project` |
| `_pendingOwners` | mapping | `projectId -> pendingOwner` |
| `_ownerRecipient` | mapping | `projectId -> explicit recipient` (Phase 1.4) |
| `pendingOwnerRecipient` | mapping | `projectId -> PendingRecipientChange` |

### Struct `PendingRecipientChange`

```solidity
struct PendingRecipientChange {
    address newRecipient;  // address(0) = "clear explicit"
    uint64 effectiveAt;    // block.timestamp + 48h on propose
}
```

### Struct `Project`

```solidity
struct Project {
    address owner;                // current owner
    uint256 collateral;           // GOV locked
    Status status;                // enum
    uint64 activatedAt;           // timestamp of 1st activation (0 if Pending)
    uint64 probationEndsAt;       // timestamp end of initial probation
    string metadataURI;           // IPFS/Arweave
}
```

### Enum `Status`

```solidity
enum Status { Pending, Active, Probation, Removed }
```

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## External functions

### Governance-gated (`onlyRole(GOVERNANCE_ROLE)`)

#### `registerProject(owner, metadataURI, collateralAmount) -> projectId`

Registers a new project as `Pending`. Pulls collateral via `transferFrom` from `owner`.

- **Reverts**: `ZeroAddress` (owner), `EmptyMetadataURI`, `InsufficientCollateral`, `InsufficientAllowance`.
- **Events**: `ProjectRegistered(projectId, owner, collateral, metadataURI)`.
- **Pre-condition**: `owner` ran `GOV.approve(registry, collateralAmount)` beforehand.

#### `activateProject(projectId)`

Pending -> Active. Sets `activatedAt` and `probationEndsAt`.

- **Reverts**: `ProjectNotFound`, `InvalidStatus` (if not Pending).
- **Events**: `ProjectActivated(projectId, activatedAt, probationEndsAt)`.

#### `setProbation(projectId)`

Active -> Probation (punitive).

- **Reverts**: `InvalidStatus` (must be Active).
- **Events**: `ProjectProbation(projectId)`.

#### `reactivate(projectId)`

Probation -> Active. Does not change `activatedAt` nor `probationEndsAt`.

- **Reverts**: `InvalidStatus` (must be Probation).
- **Events**: `ProjectReactivated(projectId)`.

#### `removeProject(projectId, slash, treasury)`

Status -> Removed (terminal). If `slash`, sends collateral to `treasury`; otherwise to the owner.

- **Reverts**: `ProjectAlreadyRemoved`, `ZeroAddress` (if `slash && treasury == 0`).
- **Events**: `ProjectRemoved(projectId, slashed, collateralReturned)`.

#### `setMinCollateral(newMin)`

Adjusts minimum collateral. Affects only future registrations.

- **Reverts**: `ZeroAmount`.
- **Events**: `MinCollateralUpdated(old, new)`.

#### `setProbationDuration(newDuration)`

Adjusts initial probation. Affects only future activations.

- **Reverts**: `ZeroAmount`.
- **Events**: `ProbationDurationUpdated(old, new)`.

### Owner-gated (project owner)

#### `updateMetadata(projectId, metadataURI)`

Updates URI. No proposal required.

- **Reverts**: `ProjectAlreadyRemoved`, `NotProjectOwner`, `EmptyMetadataURI`.
- **Events**: `MetadataUpdated(projectId, newURI)`.

#### `transferProjectOwnership(projectId, newOwner)`

Initiates 2-step transfer.

- **Reverts**: `NotProjectOwner`, `ProjectAlreadyRemoved`, `ZeroAddress`.
- **Events**: `OwnershipTransferInitiated(projectId, currentOwner, pendingOwner)`.

#### `acceptProjectOwnership(projectId)`

Accepts the transfer (called by `pendingOwner`).

- **Reverts**: `NotPendingOwner`.
- **Events**: `OwnershipTransferAccepted(projectId, previous, new)`.

### ownerRecipient timelock (Phase 1.4)

#### `proposeOwnerRecipient(uint256 projectId, address newRecipient)` — project owner

Initiates a proposal to change `ownerRecipient`. Resets the 48h clock. `newRecipient = address(0)` resets to fallback (= project owner).

- **Reverts**: `ProjectAlreadyRemoved`, `NotProjectOwner`.
- **Events**: `OwnerRecipientProposed(projectId, owner, newRecipient, effectiveAt)`.

#### `applyOwnerRecipient(uint256 projectId)` — permissionless

Applies the proposal after `effectiveAt`. Bots/keepers may call.

- **Reverts**: `NoPendingOwnerRecipient`, `OwnerRecipientTimelockActive(effectiveAt, now)`.
- **Events**: `OwnerRecipientApplied(projectId, oldRecipient, newRecipient)`.

#### `cancelOwnerRecipient(uint256 projectId)` — project owner OR `GOVERNANCE_ROLE`

Cancels a pending proposal. Escape hatch in case the owner is compromised.

- **Reverts**: `NoPendingOwnerRecipient`, `NotProjectOwner` (if caller is neither owner nor governance).
- **Events**: `OwnerRecipientCancelled(projectId, canceller)`.

### Views

- `govToken() -> address` — collateral token address.
- `totalProjects() -> uint256` — `_nextProjectId - 1`.
- `getProject(projectId) -> Project` — reverts `ProjectNotFound` if not present.
- `isActive(projectId) -> bool` — returns `false` for inexistent (does not revert).
- `isInProbation(projectId) -> bool` — **initial time-based probation** only; `false` for punitive Probation.
- `pendingOwner(projectId) -> address`.
- `ownerRecipient(projectId) -> address` — explicit recipient or fallback to `project.owner`. `address(0)` if project inexistent.

## Events

All listed above. Fields `projectId`, `owner`, `currentOwner`, `pendingOwnerAddr`, `newOwner`, `previousOwner` are `indexed` where applicable.

## Custom errors

| Error | When |
|---|---|
| `ZeroAddress()` | Invalid address |
| `ZeroAmount()` | Zero value in setter |
| `EmptyMetadataURI()` | Empty URI |
| `InsufficientCollateral(provided, required)` | Collateral < `minCollateral` |
| `InsufficientAllowance(provided, required)` | Allowance < collateral |
| `ProjectNotFound(projectId)` | ID does not exist |
| `ProjectAlreadyRemoved(projectId)` | Status is Removed |
| `InvalidStatus(projectId, current, expected)` | Invalid transition |
| `NotProjectOwner(projectId, caller)` | Caller is not the owner |
| `NotPendingOwner(projectId, caller)` | Caller is not pending |
| `NoPendingOwnerRecipient(projectId)` | apply/cancel without pending proposal |
| `OwnerRecipientTimelockActive(effectiveAt, now)` | apply before `effectiveAt` |

## Invariants

- **I7 (Governance-gated)**: registrations and transitions are exclusively via `GOVERNANCE_ROLE` (except metadata/ownership which are owner-gated).
- **Faithful custody**: sum of `collateral` over non-`Removed` projects == `GOV.balanceOf(registry)`.
- **Monotonic ID**: IDs only grow; never reused.
- **Removed terminal**: once Removed, always Removed. Metadata freezes.
- **CEI in `registerProject` and `removeProject`**: effects before `safeTransfer`.

## Important notes

### Two notions of "probation"

- **Initial time-based** (`isInProbation` view): automatically applied after `activateProject`, lasts `probationDuration`. The project is `Active` but receives reward share / 4.
- **Punitive** (status `Probation` of the enum): governance manually moves. Blocks operations; does not bypass lock.

They are distinct and coexist.

### No topup / partial withdraw in v1

If v2 needs them, add new functions without breaking the layout.

### Probation -> Active preserves anchoring

`reactivate` does **not** recompute `activatedAt` / `probationEndsAt`. If the project is still inside the initial probation window, the reward penalty stays.

### Why `ownerRecipient` has a 48h timelock

With CLP Phase 1.4, `RewardDistributorV2` mints CREDIT directly to `ownerRecipient(projectId)` upon round finalisation. Without a timelock, the owner could hot-swap between `finalizeRound` and off-chain indexing, diverting the entire apps bucket to a hostile address before stakers/auditors notice.

48h is compatible with the DAO's operational cycle (proposal + main Timelock execution take ~2 days). `cancelOwnerRecipient` is available both to the owner and to `GOVERNANCE_ROLE` — escape hatch in case the owner key is compromised and the proposal is malicious.

`ownerRecipient` returns the explicit value when set, or falls back to `project.owner` — preserves compatibility with old projects that never called `proposeOwnerRecipient`.

---

**See also**: [Staking](05-Staking.md), [FeeRouter](08-FeeRouter.md), [BurnTracker](06-BurnTracker.md).
