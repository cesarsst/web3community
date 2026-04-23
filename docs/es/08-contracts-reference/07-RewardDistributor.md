# RewardDistributor

**Audiencia:** stakers consultando preview, auditores, devs integrando UIs de reward.
**Requisitos previos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Visión rápida

Corazón del modelo económico. Calcula la emisión de CREDIT por ronda y la acuña bajo demanda para stakers vía claim pull-based. Único holder de `MINTER_ROLE` en el CreditToken en producción.

Fórmula: `emissao_R = min(max(alpha * burn_{R-1}, floor(R)), capMax)`. La emisión por proyecto se computa bajo demanda en `_calculateClaim` para escalar el costo de gas con el número de claims, no con el número de proyectos.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

## Parámetros y storage

### Constants

| Nombre | Valor |
|---|---|
| `PRECISION` | `1e18` |
| `MIN_ALPHA` | `5e17` (0.5) |
| `MAX_ALPHA` | `11e17` (1.1) |
| `MIN_CAPMAX` | `1e18` |
| `MAX_CAPMAX` | `100_000_000e18` |
| `FLOOR_SCHEDULE_LENGTH` | `24` |
| `PROBATION_PENALTY_DENOM` | `4` |

### Dependencias (immutable)

- `CREDIT` — CreditToken.
- `STAKING` — Staking.
- `BURN_TRACKER` — BurnTracker.
- `REGISTRY` — ProjectRegistry.

### Storage

| Nombre | Tipo | Descripción |
|---|---|---|
| `alpha` | `uint256` | producción: `0.95e18`. Ajustable vía gobernanza. |
| `capMax` | `uint256` | producción: `5M * 1e18`. Ajustable. |
| `floorSchedule` | `uint256[24]` | inmutable post-constructor |
| `lastFinalizedRound` | `uint256` | — |
| `isFirstRoundFinalized` | `bool` | one-shot para marcar "round 0 finalizado" |
| `roundData` | mapping | `round → RoundData` |
| `claimed` | mapping | `round → projectId → user → bool` |

### Struct `RoundData`

```solidity
struct RoundData {
    uint256 totalEmission;
    uint256 totalBurnAtFinalize;
    uint64 snapshotBlock;
    bool finalized;
}
```

## Roles y permisos

| Role | En producción |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

`finalizeRound` y `claim` / `claimMany` son **permissionless** — cualquiera los llama.

## Funciones externas

### `finalizeRound(uint256 round)`

Graba `roundData[round]` inmutable. Permissionless.

- **Revierte**: `RoundAlreadyFinalized`, `OutOfOrderFinalize(expected, provided)`, `RoundNotClosed(round)`.
- **Eventos**: `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)`.

Precondiciones:

- `!roundData[round].finalized`.
- `round == expected` (secuencial).
- `BURN_TRACKER.currentRound() > round`.

### `claim(uint256 round, uint256 projectId) → uint256 amount`

Reclama el reward del `msg.sender`. Marca `claimed` y acuña CREDIT si `amount > 0`.

- **Revierte**: `RoundNotFinalized`, `AlreadyClaimed`.
- **Eventos**: `Claimed(user, round, projectId, amount)` si `amount > 0`.
- **ReentrancyGuard**: sí.

### `claimMany(uint256[] rounds, uint256[] projectIds) → uint256 total`

Batch.

- **Revierte**: `ArrayLengthMismatch`, `EmptyBatch`, `AlreadyClaimed` en cualquier par.
- Las entries con `amount == 0` son no-op (no marcan claimed).

### Governance-gated

#### `setAlpha(uint256 newAlpha)`

- **Revierte**: `InvalidAlpha(provided, min, max)` si está fuera de `[MIN_ALPHA, MAX_ALPHA]`.
- **Eventos**: `AlphaUpdated(old, new)`.
- Afecta solo rondas no finalizadas.

#### `setCapMax(uint256 newCap)`

- **Revierte**: `InvalidCapMax(provided, min, max)` si está fuera de `[MIN_CAPMAX, MAX_CAPMAX]`.
- **Eventos**: `CapMaxUpdated(old, new)`.

### Views

- `previewClaim(user, round, projectId) → uint256` — sin side effects.
- `previewEmission(forRound) → uint256` — aplica la fórmula con el state actual.
- `getEmission(round) → uint256` — `roundData[round].totalEmission`.
- `getProjectEmission(round, projectId) → uint256` — share del proyecto.
- `isFinalized(round) → bool`.

## Eventos

| Evento | Indexados |
|---|---|
| `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)` | `round` |
| `Claimed(user, round, projectId, amount)` | `user`, `round`, `projectId` |
| `AlphaUpdated(oldAlpha, newAlpha)` | — |
| `CapMaxUpdated(oldCap, newCap)` | — |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | Dirección cero en el constructor |
| `RoundNotClosed(round)` | `BurnTracker.currentRound() <= round` |
| `RoundAlreadyFinalized(round)` | Segundo intento de finalize |
| `RoundNotFinalized(round)` | claim/preview sin finalize |
| `OutOfOrderFinalize(expected, provided)` | Saltó ronda |
| `AlreadyClaimed(round, projectId, user)` | Re-claim |
| `ArrayLengthMismatch()` | `claimMany` arrays diferentes |
| `EmptyBatch()` | `claimMany` vacío |
| `InvalidAlpha(provided, min, max)` | alpha fuera del bound |
| `InvalidCapMax(provided, min, max)` | cap fuera del bound |

## Invariantes

- **I2**: el burn genera reward por consumo, no por volumen pasivo.
- **I3**: cap por ronda (`capMax` + schedule decreciente) garantiza emisión limitada.
- **I5**: snapshot histórico del Staking (`getWeightAt`) impide flash-stake.
- **I6**: lock mínimo 14d en el Staking vuelve flash-stake inviable.
- **I7**: penalización probation para proyectos nuevos (25% share).
- **Secuencialidad**: `finalizeRound` solo acepta `round == lastFinalizedRound + 1` (o 0 si primero).
- **Inmutabilidad de round finalized**: tras finalize, `roundData[round]` es inmutable. Cambio de `alpha`/`capMax` afecta solo rondas aún no finalizadas.
- **No-op silencioso**: `claim` con `amount == 0` no marca `claimed[...][user] = true` — permite retry si el estado cambió.

## Observaciones importantes

### Dos caminos de `_projectShare`

**Con burn anterior:**

```
share = emision * burnProyectoPrev / totalBurnPrev
```

**Sin burn anterior (bootstrap):**

```
share = emision * projectWeightSnapshot / globalWeightSnapshot
```

Detección: `rd.totalBurnAtFinalize == 0`. Requiere `Staking.getGlobalWeightAt` (riel global, O(1) por update en el Staking).

### Probation penalty aplicada en el claim

`REGISTRY.isInProbation(projectId)` se consulta en el momento del claim, **no** del finalize. Si la probation terminó entre finalize y claim, el usuario recibe share completo. No hay vector de manipulación porque `probationEndsAt` se setea en `activateProject` y nunca cambia.

### FloorSchedule inmutable

Grabado en el constructor. 24 entradas. Rondas >= 24 no tienen floor. En producción: decae linealmente de 400k a ~16.666 CREDIT.

### Schedule `uint256[24]` en el constructor

Array FIJO (no dinámico) obliga al caller a pasar exactamente 24 valores. Array dinámico exigiría check adicional — aquí es barato y explícito.

### El admin inicial renuncia tras handoff

Deploy: `DEFAULT_ADMIN_ROLE` y `GOVERNANCE_ROLE` al `admin` (deployer). El handoff transfiere ambas al Timelock y renuncia. En producción, solo el Timelock gobierna.

---

**Ver también**: [Staking](05-Staking.md), [BurnTracker](06-BurnTracker.md), [CreditToken](02-CreditToken.md).
