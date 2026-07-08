# FeeRouter

**Audiencia:** devs de apps integrando pagos, auditores.
**Requisitos previos:** [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md).

## Visión rápida

Interfaz única de pago entre usuarios y apps. Todo consumo de CREDIT pasa por `pay`, que divide en tres destinos (burn / treasury / rebate) según el split configurable. Default de deploy en producción (Fase 0 del CLP): `(7000, 2000, 1000)` = 70% burn / 20% treasury / 10% rebate. El `defaultSplit` viene de los parámetros de deploy (`production.json`), no está hardcodeado — la NatSpec del `.sol` aún cita el valor histórico 95/0/5.

`pay` es público — cualquier dirección puede iniciar, siempre que `user` haya aprobado al FeeRouter. El payer económico es siempre `user`; `msg.sender` es el iniciador de la tx.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parámetros y storage

| Nombre | Tipo | Descripción |
|---|---|---|
| `_BPS_DENOMINATOR` | constant | `10.000` |
| `CREDIT` | immutable | CreditToken |
| `BURN_TRACKER` | immutable | BurnTracker |
| `REGISTRY` | immutable | ProjectRegistry |
| `TREASURY` | immutable | Treasury |
| `defaultSplit` | `Split` | deploy producción: `(7000, 2000, 1000)` (seteado vía constructor a partir de `production.json`) |
| `projectSplit` | mapping | override por proyecto |
| `hasProjectSplit` | mapping | flag de override |
| `appRecipient` | mapping | override explícito; 0 = owner dinámico |

### Struct `Split`

```solidity
struct Split {
    uint16 burnBps;
    uint16 treasuryBps;
    uint16 rebateBps;
}
// soma tem que ser 10000
```

## Roles y permisos

| Role | En producción |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funciones externas

### `pay(uint256 projectId, address user, uint256 amount) → (uint256 burned, uint256 toTreasury, uint256 toApp)`

Procesa pago. Hace pull de `amount` desde `user` vía `transferFrom`, divide y distribuye.

- **Quién llama**: público. `user` tiene que tener `CREDIT.approve(feeRouter, amount)`.
- **Revierte**: `ZeroAddress` (user), `ZeroAmount`, `ProjectNotActive`, `SanityCapExceeded` (del BurnTracker).
- **Eventos**: `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` + (indirecto) `BurnRecorded` del BurnTracker + `BurnedByRole` del CREDIT.
- **ReentrancyGuard**: sí.

Pipeline interno:

1. Check user, amount, `REGISTRY.isActive(projectId)`.
2. `CREDIT.safeTransferFrom(user, router, amount)`.
3. Calcula `(burned, toTreasury, toApp)` con dust handling — el residuo va a `toApp`.
4. Distribuye: `safeTransfer(recipient, toApp)`, `safeTransfer(TREASURY, toTreasury)`.
5. `forceApprove(BURN_TRACKER, burned)` + `BURN_TRACKER.burnAndRecord(projectId, router, burned)`.

### Governance-gated

#### `setDefaultSplit(Split calldata newSplit)`

- **Revierte**: `InvalidSplit` si la suma ≠ 10.000.
- **Eventos**: `DefaultSplitUpdated(old, new)`.

#### `setProjectSplit(uint256 projectId, Split calldata newSplit)`

Graba override. Activa `hasProjectSplit[projectId] = true`.

- **Revierte**: `InvalidSplit`.
- **Eventos**: `ProjectSplitUpdated(projectId, newSplit)`.

#### `clearProjectSplit(uint256 projectId)`

Remueve override. Retoma `defaultSplit`.

- **Revierte**: `NoProjectSplit` si no había override (idempotencia explícita).
- **Eventos**: `ProjectSplitCleared(projectId)`.

### Owner-gated

#### `setAppRecipient(uint256 projectId, address recipient)`

Registra dirección explícita de rebate. `address(0)` resetea al lookup dinámico (`Registry.getProject(projectId).owner`).

- **Quién llama**: owner del proyecto en el Registry.
- **Revierte**: `NotProjectOwner` (o bubble `ProjectNotFound` del Registry).
- **Eventos**: `AppRecipientUpdated(projectId, oldRecipient, newRecipient)`.

### Views

- `getEffectiveSplit(uint256 projectId) → Split` — override o default.
- `getEffectiveRecipient(uint256 projectId) → address`.
- `quote(uint256 projectId, uint256 amount) → (uint256 burned, uint256 toTreasury, uint256 toApp)` — sin side effects; revierte con `ZeroAmount` si amount cero.

## Eventos

| Evento | Indexados |
|---|---|
| `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` | `projectId`, `user`, `payer` |
| `DefaultSplitUpdated(oldSplit, newSplit)` | — |
| `ProjectSplitUpdated(projectId, newSplit)` | `projectId` |
| `ProjectSplitCleared(projectId)` | `projectId` |
| `AppRecipientUpdated(projectId, oldRecipient, newRecipient)` | `projectId`, `oldRecipient`, `newRecipient` |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `InvalidSplit(burnBps, treasuryBps, rebateBps, total)` | Suma ≠ 10.000 |
| `ProjectNotActive(projectId)` | Status ≠ Active |
| `ZeroAmount()` | `amount == 0` |
| `ZeroAddress()` | Dirección cero |
| `NotProjectOwner(projectId, caller)` | `setAppRecipient` sin ser owner |
| `NoProjectSplit(projectId)` | `clearProjectSplit` sin override |

## Invariantes

- **I2 (Burn en el consumo)**: todo `pay` con `burnBps > 0` acciona `BurnTracker.burnAndRecord` atómicamente.
- **I4 (Governance-gated setters)**: `setDefaultSplit`, `setProjectSplit`, `clearProjectSplit`.
- **I7 (Active gate)**: `pay` exige `isActive`. Doble validación con BurnTracker.
- **Split suma 10.000**: enforceado on-chain en todos los setters y en el constructor.
- **Sin custodia entre llamadas**: cada `pay` es atómico. El FeeRouter termina con saldo 0.
- **Dust handling**: `toApp = amount - burned - toTreasury`. El residuo de redondeo va al rebate.
- **ReentrancyGuard + CEI**: guard activo, approve + burnAndRecord al último.

## Observaciones importantes

### Por qué `pay` es público

Habilita UX flexible:

- **El user paga directo** (firma tx).
- **La app paga en nombre del user** (gas sponsorship, tras approve previo).
- **Relayer / smart wallet** (AA-style).

El payer económico es siempre `user` (vía `transferFrom`). `msg.sender` solo aparece en el evento.

### Lookup dinámico de recipient

Si `appRecipient[projectId] == 0`, el recipient es `REGISTRY.getProject(projectId).owner` — se actualiza automáticamente cuando el owner cambia vía `transferProjectOwnership`. Elimina la necesidad de re-config manual.

### Sin sweep en v1

`FeeRouter` no custodia CREDIT entre llamadas. Ningún fondo queda atascado. Las anomalías (tokens enviados por error) quedan — resolvibles solo vía upgrade (no hay upgrade path en v1). Agregar sweep crearía superficie de centralización.

### Dependencias post-deploy

- `BurnTracker.grantRole(RECORDER_ROLE, feeRouter)` — hecho en la Fase B del deploy.
- Las apps individuales llaman a `FeeRouter.pay`, no directo al BurnTracker.

---

**Ver también**: [BurnTracker](06-BurnTracker.md), [CreditToken](02-CreditToken.md), [Treasury](04-Treasury.md).
