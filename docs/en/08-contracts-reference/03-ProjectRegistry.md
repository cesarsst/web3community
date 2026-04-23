# ProjectRegistry

**Audience:** devs listing projects, auditors, stakers checking status.
**Prerequisites:** [Project whitelist](../02-core-concepts/06-project-whitelist.md).

## Quick overview

On-chain whitelist of ecosystem projects/apps. Single source of truth for:

- Who owns each project.
- How much GOV was locked as collateral (skin in the game).
- Project status (`Pending`, `Active`, `Probation`, `Removed`).
- Off-chain metadata URI.

Consumed by `Staking`, `BurnTracker`, `RewardDistributor`, and `FeeRouter` for gating and owner lookup.

## Inheritance

```
AccessControl (OZ)
```

Uses `SafeERC20` for GOV movement.

## Parameters and storage

| Name | Type | Description |
|---|---|---|
| `GOV_TOKEN` | `IERC20` immutable | Address of the GovernanceToken |
| `minCollateral` | `uint256` | Minimum collateral (production: `10_000 * 1e18`) |
| `probationDuration` | `uint64` | Initial probation duration (production: `30 days`) |
| `_nextProjectId` | `uint256` private | Next ID (starts at 1) |
| `_projects` | mapping | `projectId → Project` |
| `_pendingOwners` | mapping | `projectId → pendingOwner` |

### Struct `Project`

```solidity
struct Project {
    address owner;                // current owner
    uint256 collateral;           // GOV locked
    Status status;                // enum
    uint64 activatedAt;           // timestamp of 1st activation (0 if Pending)
    uint64 probationEndsAt;       // timestamp of initial probation end
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

#### `registerProject(owner, metadataURI, collateralAmount) → projectId`

Registers a new project in `Pending`. Pulls collateral via `transferFrom` from `owner`.

- **Reverts**: `ZeroAddress` (owner), `EmptyMetadataURI`, `InsufficientCollateral`, `InsufficientAllowance`.
- **Events**: `ProjectRegistered(projectId, owner, collateral, metadataURI)`.
- **Precondition**: `owner` did `GOV.approve(registry, collateralAmount)` beforehand.

#### `activateProject(projectId)`

Pending → Active. Sets `activatedAt` and `probationEndsAt`.

- **Reverts**: `ProjectNotFound`, `InvalidStatus` (if not Pending).
- **Events**: `ProjectActivated(projectId, activatedAt, probationEndsAt)`.

#### `setProbation(projectId)`

Active → Probation (punitive).

- **Reverts**: `InvalidStatus` (must be Active).
- **Events**: `ProjectProbation(projectId)`.

#### `reactivate(projectId)`

Probation → Active. Does not alter `activatedAt` or `probationEndsAt`.

- **Reverts**: `InvalidStatus` (must be Probation).
- **Events**: `ProjectReactivated(projectId)`.

#### `removeProject(projectId, slash, treasury)`

Status → Removed (terminal). If `slash`, sends collateral to `treasury`; otherwise, to owner.

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

Updates URI. Does not require a proposal.

- **Reverts**: `ProjectAlreadyRemoved`, `NotProjectOwner`, `EmptyMetadataURI`.
- **Events**: `MetadataUpdated(projectId, newURI)`.

#### `transferProjectOwnership(projectId, newOwner)`

Starts 2-step transfer.

- **Reverts**: `NotProjectOwner`, `ProjectAlreadyRemoved`, `ZeroAddress`.
- **Events**: `OwnershipTransferInitiated(projectId, currentOwner, pendingOwner)`.

#### `acceptProjectOwnership(projectId)`

Accepts the transfer (called by `pendingOwner`).

- **Reverts**: `NotPendingOwner`.
- **Events**: `OwnershipTransferAccepted(projectId, previous, new)`.

### Views

- `govToken() → address` — collateral token address.
- `totalProjects() → uint256` — `_nextProjectId - 1`.
- `getProject(projectId) → Project` — reverts with `ProjectNotFound` if nonexistent.
- `isActive(projectId) → bool` — returns `false` for nonexistent (does not revert).
- `isInProbation(projectId) → bool` — **initial time-based** probation only; `false` for punitive Probation.
- `pendingOwner(projectId) → address`.

## Events

All listed above. Fields `projectId`, `owner`, `currentOwner`, `pendingOwnerAddr`, `newOwner`, `previousOwner` are `indexed` where applicable.

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | Invalid address |
| `ZeroAmount()` | Zero value in setter |
| `EmptyMetadataURI()` | Empty URI |
| `InsufficientCollateral(provided, required)` | Collateral < `minCollateral` |
| `InsufficientAllowance(provided, required)` | Allowance < collateral |
| `ProjectNotFound(projectId)` | ID does not exist |
| `ProjectAlreadyRemoved(projectId)` | Status is Removed |
| `InvalidStatus(projectId, current, expected)` | Invalid transition |
| `NotProjectOwner(projectId, caller)` | Caller is not owner |
| `NotPendingOwner(projectId, caller)` | Caller is not pending |

## Invariants

- **I7 (Governance-gated)**: registrations and transitions are exclusively via `GOVERNANCE_ROLE` (except metadata/ownership which are owner-gated).
- **Faithful custody**: sum of `collateral` across non-`Removed` projects == `GOV.balanceOf(registry)`.
- **Monotonic ID**: IDs only grow; never reused.
- **Removed terminal**: once Removed, always Removed. Metadata freezes.
- **CEI in `registerProject` and `removeProject`**: effects before `safeTransfer`.

## Important notes

### Two notions of "probation"

- **Initial time-based** (`isInProbation` view): automatically applied after `activateProject`, lasts `probationDuration`. Project is `Active` but receives reward share /4.
- **Punitive** (`Probation` status of the enum): governance moves it manually. Blocks operations; does not bypass lock.

They are distinct and coexist.

### No topup / partial withdraw in v1

If v2 needs it, add new functions without breaking the layout.

### Probation → Active preserves anchoring

`reactivate` does **not** recompute `activatedAt` / `probationEndsAt`. If the project is still inside the initial probation window, the reward penalty is preserved.

---

**See also**: [Staking](05-Staking.md), [FeeRouter](08-FeeRouter.md), [BurnTracker](06-BurnTracker.md).
