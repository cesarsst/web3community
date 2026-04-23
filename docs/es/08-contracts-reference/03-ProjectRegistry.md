# ProjectRegistry

**Audiencia:** devs listando proyectos, auditores, stakers verificando status.
**Requisitos previos:** [Project whitelist](../02-core-concepts/06-project-whitelist.md).

## Visión rápida

Whitelist on-chain de proyectos/apps del ecosistema. Fuente única de verdad para:

- Quién es dueño de cada proyecto.
- Cuánto GOV fue bloqueado como colateral (skin in the game).
- Status del proyecto (`Pending`, `Active`, `Probation`, `Removed`).
- URI de metadata off-chain.

Consumido por `Staking`, `BurnTracker`, `RewardDistributor` y `FeeRouter` para gating y lookup de owner.

## Herencia

```
AccessControl (OZ)
```

Usa `SafeERC20` para movimiento de GOV.

## Parámetros y storage

| Nombre | Tipo | Descripción |
|---|---|---|
| `GOV_TOKEN` | `IERC20` immutable | Dirección del GovernanceToken |
| `minCollateral` | `uint256` | Colateral mínimo (producción: `10.000 * 1e18`) |
| `probationDuration` | `uint64` | Duración de la probation inicial (producción: `30 days`) |
| `_nextProjectId` | `uint256` private | Próximo ID (empieza en 1) |
| `_projects` | mapping | `projectId → Project` |
| `_pendingOwners` | mapping | `projectId → pendingOwner` |

### Struct `Project`

```solidity
struct Project {
    address owner;                // owner atual
    uint256 collateral;           // GOV lockado
    Status status;                // enum
    uint64 activatedAt;           // timestamp da 1a ativacao (0 se Pending)
    uint64 probationEndsAt;       // timestamp fim probation inicial
    string metadataURI;           // IPFS/Arweave
}
```

### Enum `Status`

```solidity
enum Status { Pending, Active, Probation, Removed }
```

## Roles y permisos

| Role | En producción |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funciones externas

### Governance-gated (`onlyRole(GOVERNANCE_ROLE)`)

#### `registerProject(owner, metadataURI, collateralAmount) → projectId`

Registra nuevo proyecto en `Pending`. Hace pull del colateral vía `transferFrom` desde el `owner`.

- **Revierte**: `ZeroAddress` (owner), `EmptyMetadataURI`, `InsufficientCollateral`, `InsufficientAllowance`.
- **Eventos**: `ProjectRegistered(projectId, owner, collateral, metadataURI)`.
- **Precondición**: el `owner` hizo `GOV.approve(registry, collateralAmount)` antes.

#### `activateProject(projectId)`

Pending → Active. Setea `activatedAt` y `probationEndsAt`.

- **Revierte**: `ProjectNotFound`, `InvalidStatus` (si no es Pending).
- **Eventos**: `ProjectActivated(projectId, activatedAt, probationEndsAt)`.

#### `setProbation(projectId)`

Active → Probation (punitiva).

- **Revierte**: `InvalidStatus` (tiene que estar Active).
- **Eventos**: `ProjectProbation(projectId)`.

#### `reactivate(projectId)`

Probation → Active. No altera `activatedAt` ni `probationEndsAt`.

- **Revierte**: `InvalidStatus` (tiene que estar Probation).
- **Eventos**: `ProjectReactivated(projectId)`.

#### `removeProject(projectId, slash, treasury)`

Status → Removed (terminal). Si `slash`, envía el colateral al `treasury`; si no, al owner.

- **Revierte**: `ProjectAlreadyRemoved`, `ZeroAddress` (si `slash && treasury == 0`).
- **Eventos**: `ProjectRemoved(projectId, slashed, collateralReturned)`.

#### `setMinCollateral(newMin)`

Ajusta colateral mínimo. Afecta solo registros futuros.

- **Revierte**: `ZeroAmount`.
- **Eventos**: `MinCollateralUpdated(old, new)`.

#### `setProbationDuration(newDuration)`

Ajusta probation inicial. Afecta solo activaciones futuras.

- **Revierte**: `ZeroAmount`.
- **Eventos**: `ProbationDurationUpdated(old, new)`.

### Owner-gated (owner del proyecto)

#### `updateMetadata(projectId, metadataURI)`

Actualiza URI. No requiere propuesta.

- **Revierte**: `ProjectAlreadyRemoved`, `NotProjectOwner`, `EmptyMetadataURI`.
- **Eventos**: `MetadataUpdated(projectId, newURI)`.

#### `transferProjectOwnership(projectId, newOwner)`

Inicia transferencia 2-step.

- **Revierte**: `NotProjectOwner`, `ProjectAlreadyRemoved`, `ZeroAddress`.
- **Eventos**: `OwnershipTransferInitiated(projectId, currentOwner, pendingOwner)`.

#### `acceptProjectOwnership(projectId)`

Acepta la transferencia (llamado por el `pendingOwner`).

- **Revierte**: `NotPendingOwner`.
- **Eventos**: `OwnershipTransferAccepted(projectId, previous, new)`.

### Views

- `govToken() → address` — dirección del token de colateral.
- `totalProjects() → uint256` — `_nextProjectId - 1`.
- `getProject(projectId) → Project` — revierte con `ProjectNotFound` si no existe.
- `isActive(projectId) → bool` — retorna `false` para inexistente (no revierte).
- `isInProbation(projectId) → bool` — probation **inicial por tiempo** solamente; `false` para Probation punitiva.
- `pendingOwner(projectId) → address`.

## Eventos

Todos listados arriba. Los campos `projectId`, `owner`, `currentOwner`, `pendingOwnerAddr`, `newOwner`, `previousOwner` son `indexed` donde aplica.

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | Dirección inválida |
| `ZeroAmount()` | Valor cero en setter |
| `EmptyMetadataURI()` | URI vacía |
| `InsufficientCollateral(provided, required)` | Colateral < `minCollateral` |
| `InsufficientAllowance(provided, required)` | Allowance < colateral |
| `ProjectNotFound(projectId)` | ID no existe |
| `ProjectAlreadyRemoved(projectId)` | Status es Removed |
| `InvalidStatus(projectId, current, expected)` | Transición inválida |
| `NotProjectOwner(projectId, caller)` | Caller no es owner |
| `NotPendingOwner(projectId, caller)` | Caller no es pending |

## Invariantes

- **I7 (Governance-gated)**: los registros y las transiciones son exclusivamente vía `GOVERNANCE_ROLE` (excepto metadata/ownership que son owner-gated).
- **Custodia fiel**: la suma de los `collateral` en proyectos no-`Removed` == `GOV.balanceOf(registry)`.
- **ID monotónico**: los IDs solo crecen; nunca se reutilizan.
- **Removed terminal**: una vez Removed, siempre Removed. La metadata se congela.
- **CEI en `registerProject` y `removeProject`**: effects antes de `safeTransfer`.

## Observaciones importantes

### Dos nociones de "probation"

- **Inicial por tiempo** (`isInProbation` view): aplicada automáticamente tras `activateProject`, dura `probationDuration`. El proyecto es `Active` pero recibe share de reward /4.
- **Punitiva** (status `Probation` del enum): la gobernanza mueve manualmente. Bloquea operaciones; no bypassea el lock.

Son distintas y coexisten.

### Sin topup / withdraw parcial en v1

Si v2 lo necesita, agregar funciones nuevas sin romper layout.

### Probation → Active preserva el anclaje

`reactivate` **no** recalcula `activatedAt` / `probationEndsAt`. Si el proyecto aún está dentro de la ventana inicial de probation, la penalización de reward se mantiene.

---

**Ver también**: [Staking](05-Staking.md), [FeeRouter](08-FeeRouter.md), [BurnTracker](06-BurnTracker.md).
