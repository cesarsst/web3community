# RewardDistributorV2

> ⚠️ **LEGADO — sustituido por el remodel 2026-07-08.** La emisión por buckets (55/25/15/5) pertenece al modelo burn-to-mint anterior. En el modelo vigente no hay emisión: la renta del inversor viene de rev-share sobre receita real vía [ProjectFunding](16-ProjectFunding.md) + [FeeRouterV2](08b-FeeRouterV2.md). Este contrato solo atiende claims históricos. Esta página se mantiene como referencia.

**Para quién es:** stakers consultando claim, owners de apps, LPs, auditores, devs integrando UIs.
**Prerrequisitos:** [RewardDistributor (V1)](07-RewardDistributor.md), [Distribución de rewards](../02-core-concepts/04-rewards-distribution.md).

## Vista rápida

Distributor **bucket-aware** de la Fase 1.4 del pivote Credit Liquidity Protocol (CLP). Reescribe la lógica de emisión para soportar split entre **4 buckets** en cada `finalizeRound`:

- **Stakers** (default 55%): pull-based vía `claim`/`claimMany`. Mantiene la mecánica V1 (`projectShare × stakeShare`).
- **LPs** (default 25%): push directo al `LiquidityGauge` vía `notifyRewardAmount`. Cuando el gauge está paused, fallback a `Treasury.depositPendingGaugeRewards`.
- **Apps** (default 15%): push retrospectivo (burn-based). `appShare(p) = appsAmount × burn_{R-1}(p) / totalBurnPrev`. Minteado directo a `ProjectRegistry.ownerRecipient(p)`.
- **Bonders** (default 5%): push a `Treasury.depositPolRefill` (refill earmarkado del POL en la Fase 1; reciclado a `BondDepository` en la Fase 3).

V2 es **deploy paralelo** al V1. V1 queda en modo claim-only durante la ventana de migración de 4 rondas — la gobernanza revoca el `MINTER_ROLE` del V1 en CREDIT tras el cutoff.

La fórmula de emisión TOTAL es idéntica al V1 (`min(max(alpha × burn, floor), capMax)`); el split en buckets se aplica DESPUÉS del cap (IE3 fortalecida — ningún bucket excede `bucketBps[i] × capMax`).

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parámetros y storage

### Constants — bucket layout

| Nombre | Valor |
|---|---|
| `BUCKET_STAKERS` | `0` |
| `BUCKET_LPS` | `1` |
| `BUCKET_APPS` | `2` |
| `BUCKET_BONDERS` | `3` |
| `BPS_DENOMINATOR` | `10_000` |
| `MIN_BUCKET_STAKERS_BPS` | `3000` (30%) |
| `MIN_BUCKET_LPS_BPS` | `500` (5%) |
| `MAX_BUCKET_APPS_BPS` | `2500` (25%, IE4b) |
| `MAX_BUCKET_BONDERS_BPS` | `2000` (20%) |
| `SPLIT_TOLERANCE_WEI` | `3` |

### Constants — econ params (replicadas del V1)

| Nombre | Valor |
|---|---|
| `PRECISION` | `1e18` |
| `MIN_ALPHA` | `5e17` (0.5) |
| `MAX_ALPHA` | `99e16` (0.99 — IE1) |
| `MIN_CAPMAX` | `1e18` |
| `MAX_CAPMAX` | `100_000_000e18` |
| `FLOOR_SCHEDULE_LENGTH` | `24` |
| `PROBATION_PENALTY_DENOM` | `4` |

### Dependencias (immutable)

- `CREDIT` — CreditToken.
- `STAKING` — Staking.
- `BURN_TRACKER` — BurnTracker.
- `REGISTRY` — ProjectRegistry (consultado para `ownerRecipient` y probation).
- `GAUGE` — LiquidityGauge (`ILiquidityGaugeRewards`).
- `TREASURY` — Treasury (`ITreasuryRewards`, slim interface).

### Storage — bucket params

| Nombre | Tipo | Descripción |
|---|---|---|
| `bucketBps[4]` | `uint16[4]` | Default `[5500, 2500, 1500, 500]`. Suma exacta 10000 |
| `gaugePoolId` | `uint256` | Pool destino en el gauge. Default `1` (CREDIT/USDC 0.3%) |
| `gaugeIncentiveDuration` | `uint32` | Default `7 days`. Bounds `[1h, 90d]` |

### Storage — emisión (replicada del V1)

| Nombre | Tipo | Descripción |
|---|---|---|
| `alpha` | `uint256` | Default `0.95e18` |
| `capMax` | `uint256` | Default `5M × 1e18` en producción |
| `floorSchedule` | `uint256[24]` | Inmutable post-constructor |

### Storage — round state

| Nombre | Tipo | Descripción |
|---|---|---|
| `lastFinalizedRound` | `uint256` | — |
| `isFirstRoundFinalized` | `bool` | Distingue "round 0 finalizado" de "ninguno finalizado" |
| `roundData[round]` | `RoundData` | Snapshot inmutable |
| `bucketEmissionByRound[round][bucket]` | `uint256` | Audit trail por bucket |
| `claimed[round][projectId][user]` | `bool` | Anti double-claim |

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

`finalizeRound` y `claim`/`claimMany` son **permissionless**.

## Funciones externas

### `finalizeRound(uint256 round)`

Permissionless. Aplica la fórmula V1 antes del split, distribuye:

1. **Checks**: secuencial, round closed, no finalizado.
2. **Compute**: `totalEmission = min(max(alpha × burn_{R-1}, floor(R)), capMax)`.
3. **Split** en 4 valores vía `bucketBps`. El bucket bonders recibe el **residuo** de la división entera (protección IE12 contra pérdida de 1-2 wei).
4. **Effects**: graba `roundData[round]` + `bucketEmissionByRound`.
5. **Interactions**:
   - **Apps**: loop sobre proyectos con burn en el round R-1, mint directo a `ownerRecipient(p)`.
   - **LPs**: mint a self, approve gauge, `notifyRewardAmount` (o fallback Treasury si paused).
   - **Bonders**: mint al Treasury, `depositPolRefill`.
   - **Stakers**: NO se mintea aquí (lazy vía `claim`).
6. **Assert IE12**: suma agendada/minteada == totalEmission (tolerancia 3 wei).

**Caso especial bootstrap (`totalBurnPrev == 0`)**: el bucket apps NO emite — bonders absorbe el residual. Sin burn no hay señal económica para distribuir entre apps.

- **Revierte**: `RoundAlreadyFinalized`, `OutOfOrderFinalize(expected, provided)`, `RoundNotClosed(round)`, `EmissionMismatch(totalEmission, sumBuckets)`.
- **Eventos**: `RoundFinalizedV2(round, totalEmission, stakersAmount, lpsAmount, appsAmount, bondersAmount)` + N × `BucketEmissionMinted` + opcional `GaugePauseFallback`.

### `claim(uint256 round, uint256 projectId) -> uint256 amount`

Reclama reward de stakers. Mint lazy. Sólo el bucket stakers se procesa aquí — los buckets LPs/apps/bonders ya fueron empujados en `finalizeRound`.

Mantiene la semántica V1: marca `claimed`, calcula vía `projectShare × stakeShare`, mint vía `CREDIT.mint`. Diferencia: `projectShare` ahora usa `bucketEmissionByRound[round][BUCKET_STAKERS]` como base, no `totalEmission`.

- **Revierte**: `RoundNotFinalized`, `AlreadyClaimed`.
- **Eventos**: `Claimed(user, round, projectId, amount)` si `amount > 0`.
- **ReentrancyGuard**: sí.

### `claimMany(uint256[] rounds, uint256[] projectIds) -> uint256 total`

Batch.

- **Revierte**: `ArrayLengthMismatch`, `EmptyBatch`, `AlreadyClaimed`.

### Governance setters

#### `setBucketBps(uint16[4] newBps)`

Actualiza el split. No retroactivo.

Bounds individuales (E.8):
- `stakers >= 30%` (preserva señal económica para Phase 2 gauge controller).
- `LPs >= 5%` (IE6 — liquidez incentivada).
- `apps <= 25%` (IE4b — anti auto-extracción vía wash burn).
- `bonders <= 20%` (Olympus mostró que > 20% destrababa ponzi).
- suma exacta 10000.

- **Revierte**: `BucketBpsOutOfBounds(bucket, provided, min, max)`, `BucketBpsSumInvalid(sum)`.
- **Eventos**: `BucketBpsUpdated(oldBps, newBps)`.

#### `setAlpha(uint256 newAlpha)` / `setCapMax(uint256 newCap)`

Idéntico al V1. Bounds `[MIN_ALPHA, MAX_ALPHA]` / `[MIN_CAPMAX, MAX_CAPMAX]`.

#### `setGaugePoolId(uint256 newPoolId)` / `setGaugeIncentiveDuration(uint32 newDuration)`

Configura el destino del bucket LPs. `gaugeIncentiveDuration` bounds `[1h, 90d]`.

### Views

- `previewClaim(user, round, projectId) -> uint256` — preview del bucket stakers.
- `previewEmission(forRound) -> uint256` — emisión TOTAL (antes del split).
- `getEmission(round) -> uint256` — `roundData[round].totalEmission`.
- `getBucketEmission(round, bucket) -> uint256` — valor agendado por bucket.
- `getProjectStakerEmission(round, projectId) -> uint256` — share del proyecto EN EL BUCKET STAKERS (con probation penalty).
- `isFinalized(round) -> bool`.
- `getBucketBps() -> uint16[4]` — split actual.

## Eventos

| Evento | Indexados |
|---|---|
| `RoundFinalizedV2(round, totalEmission, stakers, lps, apps, bonders)` | `round` |
| `BucketEmissionMinted(round, bucket, recipient, amount)` | `round`, `bucket`, `recipient` |
| `GaugePauseFallback(round, amount)` | `round` |
| `Claimed(user, round, projectId, amount)` | `user`, `round`, `projectId` |
| `BucketBpsUpdated(oldBps, newBps)` | — |
| `AlphaUpdated(oldAlpha, newAlpha)` | — |
| `CapMaxUpdated(oldCap, newCap)` | — |
| `GaugePoolIdUpdated(old, new)` | — |
| `GaugeIncentiveDurationUpdated(old, new)` | — |

## Errores customizados

| Error | Cuándo |
|---|---|
| `ZeroAddress()` | Dirección cero en el constructor |
| `RoundNotClosed(round)` | `BurnTracker.currentRound() <= round` |
| `RoundAlreadyFinalized(round)` | Segundo finalize |
| `RoundNotFinalized(round)` | claim sin finalize |
| `OutOfOrderFinalize(expected, provided)` | Saltó una ronda |
| `AlreadyClaimed(round, projectId, user)` | Re-claim |
| `ArrayLengthMismatch()` / `EmptyBatch()` | `claimMany` malformado |
| `InvalidAlpha(provided, min, max)` | alpha fuera del bound |
| `InvalidCapMax(provided, min, max)` | cap fuera del bound |
| `BucketBpsSumInvalid(sum)` | Suma != 10000 |
| `BucketBpsOutOfBounds(bucket, provided, min, max)` | Bucket fuera de los bounds individuales |
| `EmissionMismatch(totalEmission, sumBuckets)` | IE12 violada (assert defensivo) |
| `InvalidGaugeIncentiveDuration(requested)` | Fuera de `[1h, 90d]` |

## Invariantes

- **IE1** alpha < 1: `MAX_ALPHA = 0.99e18`.
- **IE2** Floor temporal: `floorSchedule[24]` replicado del V1.
- **IE3 (fortalecida)**: cap aplicado ANTES del split — ningún bucket excede `bucketBps[i] × capMax`.
- **IE4b (codificada)**: `bucketBps[apps] <= 2500`. Anti auto-extracción vía wash burn.
- **IE12 (creada)**: suma de los 4 buckets == `totalEmission` con tolerancia de 3 wei. Validada en `finalizeRound` vía assert.
- **I5**: snapshot anti-flashloan — `snapshotBlock` único por round, todos los buckets usan el mismo.

## Notas importantes

### ¿Por qué stakers es lazy pero LPs/apps/bonders son push?

- **Stakers**: el número de stakers puede ser de miles. Push iteraría todos — explosión de gas. Pull (claim) delega el costo a quien se beneficia.
- **LPs**: 1 llamada (`notifyRewardAmount`) crea la incentive en el gauge — el gauge hace la contabilidad in-range para todos los LPs. Push es O(1).
- **Apps**: loop sobre `1..totalProjects`. Limitado por la frecuencia de propuestas DAO (esperado < 1000 proyectos). Mint directo a `ownerRecipient`. Push es O(N proyectos con burn).
- **Bonders**: 1 llamada (`depositPolRefill`) — el Treasury es el "bucket". Push es O(1).

### Apps recibe vía burn retrospectivo, no por gauge weights

La Fase 1 no tiene gauge controller (viene en la Fase 2). Por ahora, la señal económica para distribuir entre apps es el **burn de la ronda anterior** — la misma señal que el V1 usaba para stakers. Razón: el burn ya es una medida real del uso de la app, sin necesidad de votación adicional.

Apps que quieran capturar este bucket necesitan:

1. Estar listadas en el Registry (`isActive`).
2. Generar burn (= tener usuarios pagando).
3. Tener `ownerRecipient(projectId)` seteado (o usar fallback `project.owner`). Setear explícitamente requiere **timelock 48h** en el Registry — ver `proposeOwnerRecipient` / `applyOwnerRecipient`.

### Recipient del bucket apps con timelock 48h

Para evitar que el owner del proyecto haga hot-swap del recipient entre `finalizeRound` e indexación off-chain (red flag E.3 #1 del parecer), el `ownerRecipient` en el Registry tiene **timelock de 48h**:

1. `proposeOwnerRecipient(projectId, newRecipient)` — sólo owner.
2. Espera `OWNER_RECIPIENT_TIMELOCK = 48h`.
3. `applyOwnerRecipient(projectId)` — permissionless tras `effectiveAt`.

Si `ownerRecipient(projectId)` retorna `address(0)` (Removed/inexistente), la share evapora — la diferencia cae bajo la tolerancia IE12.

### Fallback gauge paused

Si `gauge.paused() == true` en el momento de `finalizeRound`, el V2:

1. Mintea `lpsAmount` al Treasury (no a self).
2. Llama `Treasury.depositPendingGaugeRewards(lpsAmount)` — acumula en ledger contable.
3. Emite `GaugePauseFallback(round, amount)`.

Sin fallback, pausar el gauge trabaría `finalizeRound` de la ronda entera (red flag E.3 #2). Tras despausar, la gobernanza llama `Treasury.flushPendingGaugeRewards(duration)`.

### Migration window — V1 vs V2

Durante la ventana de migración (4 rondas):

- **V1** sigue ejecutando `claim`/`claimMany` para rewards de rondas antiguas. `finalizeRound` aún funciona (pero la gobernanza dejará de llamar y migrará a V2).
- **V2** comienza a finalizar nuevas rondas con bucket-aware split.
- Ambos tienen `MINTER_ROLE` en CREDIT durante la ventana.
- Tras el cutoff (4 rondas), la gobernanza **revoca el `MINTER_ROLE` del V1**. V1 vuelve read-only.

Stakers que no reclamaron sus rewards V1 pueden hacerlo en cualquier momento — V1 sigue respondiendo a `claim`, sólo que ya no acuña CREDIT (la revocación del MINTER_ROLE bloquea el `mint`). Esto es **intencional**: los rewards V1 sólo son accesibles en la ventana de migración.

### Ejemplo numérico de split

Con `totalEmission = 902_500 CREDIT` (ej.: alpha 0.95 × burn 950k) y split por defecto `[5500, 2500, 1500, 500]`:

| Bucket | bps | Amount |
|---|---|---|
| Stakers | 5500 | 496_375 CREDIT |
| LPs | 2500 | 225_625 CREDIT |
| Apps | 1500 | 135_375 CREDIT |
| Bonders | 500 | 45_125 CREDIT |
| **Total** | **10000** | **902_500** |

Los 135_375 de apps se reparten proporcionalmente entre proyectos con burn:

```
appShare(proyecto X) = 135_375 × burn_{R-1}(X) / totalBurnPrev
```

Los 496_375 de stakers alimentan `_projectShare` en el claim, que aplica `projectShare × stakeShare` como el V1.

---

**Ver también**: [RewardDistributor (V1)](07-RewardDistributor.md), [Treasury](04-Treasury.md), [LiquidityGauge](13-LiquidityGauge.md), [ProjectRegistry](03-ProjectRegistry.md).
