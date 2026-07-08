# BurnTracker

> ⚠️ **LEGADO — sustituido por el remodel 2026-07-08.** Los pagos ya no queman CREDIT: el riel vigente es el [FeeRouterV2](08b-FeeRouterV2.md) (fee 2,5%, sin burn) y la métrica de uso es `grossVolumeOf`. Este contrato sigue on-chain solo para consulta histórica del burn pre-remodel. Esta página se mantiene como referencia.

**Audiencia:** devs de apps listadas (ganan `RECORDER_ROLE`), auditores.
**Requisitos previos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

## Visión rápida

"Oracle interna" que contabiliza on-chain el burn de CREDIT por `(ronda, projectId)`. Única fuente de verdad consumida por el `RewardDistributor` para calcular share de proyecto.

Toda quema dentro de la plataforma pasa por `burnAndRecord` — atómicamente quema CREDIT del usuario (vía `BURNER_ROLE` en el CreditToken) y graba el burn en el par `(round, projectId)`.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

## Parámetros y storage

| Nombre | Tipo | Valor | Descripción |
|---|---|---|---|
| `MIN_ROUND_DURATION` | `uint64` constant | `1 days` | Límite inferior |
| `MAX_ROUND_DURATION` | `uint64` constant | `30 days` | Límite superior |
| `CREDIT_TOKEN` | immutable | CREDIT | Token rastreado |
| `REGISTRY` | immutable | Registry | Para gating `isActive` |
| `currentRound` | `uint256` | empieza en 0 | Ronda actual |
| `roundStartedAt` | `uint64` | `block.timestamp` en el deploy | Timestamp de la ronda actual |
| `roundDuration` | `uint64` | producción: `7 days` | Duración objetivo |
| `maxBurnPerRoundPerProject` | `uint256` | producción: `10M * 1e18` (0 = deshabilita) | Sanity cap |
| `totalBurnByRound` | mapping | `round → uint256` | Total |
| `burnByRoundProject` | mapping | `round → projectId → uint256` | Por proyecto |
| `projectsWithBurnCount` | mapping | `round → uint256` | Conteo distinto |

## Roles y permisos

| Role | En producción |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |
| `RECORDER_ROLE` | `FeeRouter` (y cada app adicional vía propuesta) |

## Funciones externas

### `burnAndRecord(uint256 projectId, address from, uint256 amount)`

Quema `amount` de CREDIT del `from` y registra burn en `(currentRound, projectId)`.

- **Quién llama**: `RECORDER_ROLE`.
- **Revierte**: `ZeroAddress`, `ZeroAmount`, `ProjectNotActive`, `SanityCapExceeded`.
- **Eventos**: `BurnRecorded(round, projectId, from, amount, newTotalForProject)` + (del CREDIT) `BurnedByRole`.
- **ReentrancyGuard**: sí.

### Governance-gated

#### `closeRound()`

Cierra ronda actual, abre la siguiente. `currentRound++`, `roundStartedAt = now`.

- **Revierte**: solo `AccessControlUnauthorizedAccount`.
- **Eventos**: `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)`.

`earlyClose = now < roundStartedAt + roundDuration`. Permite cierre anticipado (emergencia) o tardío (flujo normal).

#### `setRoundDuration(uint64 newDuration)`

Ajusta duración objetivo.

- **Revierte**: `InvalidRoundDuration(provided, min, max)`.
- **Eventos**: `RoundDurationUpdated(old, new)`.

#### `setMaxBurnPerRoundPerProject(uint256 newMax)`

Ajusta sanity cap. `0` deshabilita.

- **Eventos**: `MaxBurnPerRoundPerProjectUpdated(old, new)`.

### Views

- `getCurrentRound() → uint256`.
- `getRoundEndsAt() → uint64` — `roundStartedAt + roundDuration`.
- `isRoundReadyToClose() → bool` — `now >= roundEndsAt`.
- `getBurnForProjectInRound(round, projectId) → uint256`.
- `getTotalBurnForRound(round) → uint256`.

## Eventos

| Evento | Indexados |
|---|---|
| `BurnRecorded(round, projectId, from, amount, newTotalForProject)` | `round`, `projectId`, `from` |
| `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)` | `round` |
| `RoundDurationUpdated(oldDuration, newDuration)` | — |
| `MaxBurnPerRoundPerProjectUpdated(oldMax, newMax)` | — |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | `from` o dependencias |
| `ZeroAmount()` | `amount == 0` |
| `ProjectNotActive(projectId)` | Status ≠ Active |
| `SanityCapExceeded(projectId, attempted, cap)` | Acumulado + amount > cap |
| `InvalidRoundDuration(provided, min, max)` | Fuera de `[MIN_ROUND_DURATION, MAX_ROUND_DURATION]` |

## Invariantes

- **I2 (Burn en el consumo)**: `burnAndRecord` quema vía `burnByRole` nativo (`_burn` decrementa `totalSupply`). `totalSupply` cae en exactamente `amount`.
- **I3 (sanity cap)**: `accumulated + amount <= cap` cuando `cap > 0`. Impide wash-burn.
- **I4 (Governance)**: `closeRound`, `setRoundDuration`, `setMaxBurnPerRoundPerProject` exigen `GOVERNANCE_ROLE`.
- **I7 (Active gate)**: solo proyectos `Active` aceptan `burnAndRecord`. El burn histórico no se revierte si el proyecto cambia de status después.
- **Secuencialidad**: `currentRound` solo incrementa, nunca decrementa. El accounting de rondas pasadas permanece accesible indefinidamente.
- **CEI + ReentrancyGuard**: effects antes de la llamada al CreditToken.

## Observaciones importantes

### Por qué atomic on-chain (camino "c")

Alternativas rechazadas:

- **Event listener off-chain**: depende de indexer confiable; crea ventana entre burn y record.
- **App registra sin quemar**: double-spend trivial (inflaría rewards sin deflación).
- **Adoptada**: la app llama a `BurnTracker.burnAndRecord(projectId, from, amount)` atómicamente. BurnTracker posee `BURNER_ROLE` en el CreditToken y quema vía `burnByRole` sin allowance.

### `closeRound` governance-gated

Permissionless sería vulnerable — cualquiera cerraba en el instante más favorable a un proyecto específico. La gobernanza decide cuándo cerrar.

### Flujo de close sin RewardDistributor

El tracker **no** llama al distributor al cerrar. El distributor consume en pull (leyendo views). Evita acoplamiento cíclico.

### Ronda 0

Empieza en `block.timestamp` del deploy. El primer close pasa al round 1.

### Empty round

Una ronda sin burn (`totalBurn == 0`) está permitida. El evento `RoundClosed` sale con `projectsCount = 0`.

### `tag` fijo en la llamada a CREDIT

Pasa siempre `"burnTracker"`. El tag rico (proyecto, round) ya está en el evento `BurnRecorded` — evita duplicación.

---

**Ver también**: [RewardDistributor](07-RewardDistributor.md), [FeeRouter](08-FeeRouter.md), [CreditToken](02-CreditToken.md).
