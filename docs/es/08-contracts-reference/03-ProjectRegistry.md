# ProjectRegistry

**Para quién es:** devs listando proyectos, auditores, stakers verificando status.
**Prerrequisitos:** [Project whitelist](../02-core-concepts/06-project-whitelist.md).

## Vista rápida

Whitelist on-chain de proyectos/apps del ecosistema. Fuente única de la verdad para:

- Quién es dueño de cada proyecto.
- Cuánto GOV se lockeó como colateral (skin in the game).
- Status del proyecto (`Pending`, `Active`, `Probation`, `Removed`).
- URI de metadata off-chain.
- **`ownerRecipient`** — destinatario canónico con timelock de 48h (usado por el bucket apps del `RewardDistributorV2`, legado).

Consumido en el modelo vigente por `Staking`, [`FeeRouterV2`](08b-FeeRouterV2.md) (gate `isActive` + fallback de recipient) y [`ProjectFunding`](16-ProjectFunding.md) (gate `isActive` + validación de owner en `openRound`). Consumidores legados: `BurnTracker`, `RewardDistributor`/`RewardDistributorV2`, `FeeRouter` V1.

## Herencia

```
AccessControl (OZ)
```

Usa `SafeERC20` para movimientos de GOV.

## Parámetros y storage

### Constants

| Nombre | Valor |
|---|---|
| `OWNER_RECIPIENT_TIMELOCK` | `48 hours` |

### Storage

| Nombre | Tipo | Descripción |
|---|---|---|
| `GOV_TOKEN` | `IERC20` immutable | Dirección del GovernanceToken |
| `minCollateral` | `uint256` | Colateral mínimo (producción: `10.000 * 1e18`) |
| `probationDuration` | `uint64` | Duración de la probation inicial (producción: `30 days`) |
| `_nextProjectId` | `uint256` private | Próximo ID (empieza en 1) |
| `_projects` | mapping | `projectId -> Project` |
| `_pendingOwners` | mapping | `projectId -> pendingOwner` |
| `_ownerRecipient` | mapping | `projectId -> recipient explícito` (Fase 1.4) |
| `pendingOwnerRecipient` | mapping | `projectId -> PendingRecipientChange` |

### Struct `PendingRecipientChange`

```solidity
struct PendingRecipientChange {
    address newRecipient;  // address(0) = "limpiar explícito"
    uint64 effectiveAt;    // block.timestamp + 48h en propose
}
```

### Struct `Project`

```solidity
struct Project {
    address owner;                // owner actual
    uint256 collateral;           // GOV lockeado
    Status status;                // enum
    uint64 activatedAt;           // timestamp de la 1ra activación (0 si Pending)
    uint64 probationEndsAt;       // timestamp fin probation inicial
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

#### `registerProject(owner, metadataURI, collateralAmount) -> projectId`

Registra nuevo proyecto en `Pending`. Jala colateral vía `transferFrom` del `owner`.

- **Revierte**: `ZeroAddress` (owner), `EmptyMetadataURI`, `InsufficientCollateral`, `InsufficientAllowance`.
- **Eventos**: `ProjectRegistered(projectId, owner, collateral, metadataURI)`.
- **Pre-condición**: `owner` hizo `GOV.approve(registry, collateralAmount)` antes.

#### `activateProject(projectId)`

Pending -> Active. Setea `activatedAt` y `probationEndsAt`.

- **Revierte**: `ProjectNotFound`, `InvalidStatus` (si no es Pending).
- **Eventos**: `ProjectActivated(projectId, activatedAt, probationEndsAt)`.

#### `setProbation(projectId)`

Active -> Probation (punitiva).

- **Revierte**: `InvalidStatus` (debe estar Active).
- **Eventos**: `ProjectProbation(projectId)`.

#### `reactivate(projectId)`

Probation -> Active. No altera `activatedAt` ni `probationEndsAt`.

- **Revierte**: `InvalidStatus` (debe estar Probation).
- **Eventos**: `ProjectReactivated(projectId)`.

#### `removeProject(projectId, slash, treasury)`

Status -> Removed (terminal). Si `slash`, envía colateral al `treasury`; sino, al owner.

- **Revierte**: `ProjectAlreadyRemoved`, `ZeroAddress` (si `slash && treasury == 0`).
- **Eventos**: `ProjectRemoved(projectId, slashed, collateralReturned)`.

#### `setMinCollateral(newMin)`

Ajusta colateral mínimo. Afecta sólo registros futuros.

- **Revierte**: `ZeroAmount`.
- **Eventos**: `MinCollateralUpdated(old, new)`.

#### `setProbationDuration(newDuration)`

Ajusta probation inicial. Afecta sólo activaciones futuras.

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

Acepta la transferencia (llamada por el `pendingOwner`).

- **Revierte**: `NotPendingOwner`.
- **Eventos**: `OwnershipTransferAccepted(projectId, previous, new)`.

### ownerRecipient timelock (Fase 1.4)

#### `proposeOwnerRecipient(uint256 projectId, address newRecipient)` — owner del proyecto

Inicia propuesta de cambio del `ownerRecipient`. Resetea el clock de 48h. `newRecipient = address(0)` resetea al fallback (= owner del proyecto).

- **Revierte**: `ProjectAlreadyRemoved`, `NotProjectOwner`.
- **Eventos**: `OwnerRecipientProposed(projectId, owner, newRecipient, effectiveAt)`.

#### `applyOwnerRecipient(uint256 projectId)` — permissionless

Aplica la propuesta tras `effectiveAt`. Bots/keepers pueden llamar.

- **Revierte**: `NoPendingOwnerRecipient`, `OwnerRecipientTimelockActive(effectiveAt, now)`.
- **Eventos**: `OwnerRecipientApplied(projectId, oldRecipient, newRecipient)`.

#### `cancelOwnerRecipient(uint256 projectId)` — owner del proyecto O `GOVERNANCE_ROLE`

Cancela propuesta pendiente. Escape hatch si el owner está comprometido.

- **Revierte**: `NoPendingOwnerRecipient`, `NotProjectOwner` (si caller no es owner ni governance).
- **Eventos**: `OwnerRecipientCancelled(projectId, canceller)`.

### Views

- `govToken() -> address` — dirección del token de colateral.
- `totalProjects() -> uint256` — `_nextProjectId - 1`.
- `getProject(projectId) -> Project` — revierte con `ProjectNotFound` si no existe.
- `isActive(projectId) -> bool` — retorna `false` para inexistente (no revierte).
- `isInProbation(projectId) -> bool` — probation **inicial por tiempo** solamente; `false` para Probation punitiva.
- `pendingOwner(projectId) -> address`.
- `ownerRecipient(projectId) -> address` — recipient explícito o fallback a `project.owner`. `address(0)` si proyecto inexistente.

## Eventos

Todos listados arriba. Campos `projectId`, `owner`, `currentOwner`, `pendingOwnerAddr`, `newOwner`, `previousOwner` son `indexed` cuando aplica.

## Errores customizados

| Error | Cuándo |
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
| `NoPendingOwnerRecipient(projectId)` | apply/cancel sin propuesta pendiente |
| `OwnerRecipientTimelockActive(effectiveAt, now)` | apply antes del `effectiveAt` |

## Invariantes

- **I7 (Governance-gated)**: registros y transiciones son exclusivamente vía `GOVERNANCE_ROLE` (excepto metadata/ownership que son owner-gated).
- **Custodia fiel**: suma de `collateral` en proyectos no-`Removed` == `GOV.balanceOf(registry)`.
- **ID monotónico**: los IDs sólo crecen; nunca se reutilizan.
- **Removed terminal**: una vez Removed, siempre Removed. Metadata se congela.
- **CEI en `registerProject` y `removeProject`**: effects antes de `safeTransfer`.

## Notas importantes

### Dos nociones de "probation"

- **Inicial por tiempo** (`isInProbation` view): aplicada automáticamente tras `activateProject`, dura `probationDuration`. El proyecto es `Active` pero recibe share de reward / 4.
- **Punitiva** (status `Probation` del enum): la gobernanza mueve manualmente. Bloquea operaciones; no bypassa lock.

Son distintas y coexisten.

### Sin topup / withdraw parcial en v1

Si v2 lo necesita, agregar nuevas funciones sin romper layout.

### Probation -> Active preserva anclaje

`reactivate` **no** recalcula `activatedAt` / `probationEndsAt`. Si el proyecto sigue dentro de la ventana inicial de probation, la penalidad de reward se mantiene.

### Por qué `ownerRecipient` tiene timelock de 48h

Con la Fase 1.4 del CLP, el `RewardDistributorV2` mintea CREDIT directo a `ownerRecipient(projectId)` al finalizar la ronda. Sin timelock, el owner podría hacer hot-swap entre `finalizeRound` e indexación off-chain, desviando el bucket apps entero a una dirección hostil sin que stakers/auditores noten a tiempo.

48h es compatible con el ciclo operacional de la DAO (propuesta + ejecución del Timelock principal toma ~2 días). `cancelOwnerRecipient` está disponible tanto para el owner como para `GOVERNANCE_ROLE` — escape hatch si la llave del owner es comprometida y la propuesta es maliciosa.

`ownerRecipient` retorna el explícito cuando seteado, o cae a `project.owner` como fallback — preserva compatibilidad con proyectos antiguos que jamás llamaron `proposeOwnerRecipient`.

---

**Ver también**: [Staking](05-Staking.md), [FeeRouter](08-FeeRouter.md), [BurnTracker](06-BurnTracker.md).
