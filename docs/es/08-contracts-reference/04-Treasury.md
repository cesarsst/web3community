# Treasury

**Para quién es:** devs construyendo integraciones con la tesorería, auditores, governance proposers.
**Prerrequisitos:** [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md), [Distribución de rewards](../02-core-concepts/04-rewards-distribution.md).

## Vista rápida

> **⚠️ Actualización — remodel 2026-07-08.** El Treasury sigue vigente como cofre de la DAO: hoy su ingreso recurrente es el **40% de la fee del `FeeRouterV2`** (≈ 1% del GMV) para opex. Los mecanismos CLP descritos abajo (FFP buyback, POL, ledgers de buckets) son **legado** — con CREDIT estable 1:1 vía [`CreditPSM`](15-CreditPSM.md) no hay floor que defender ni emisión que reciclar. Importante: el respaldo USDC del PSM está **segregado** y fuera del alcance del Treasury.

Custodia multi-activo de la DAO. Recibe pasivamente cualquier ERC-20 (y ETH vía `receive`). La única vía de salida es `GOVERNANCE_ROLE` — ningún admin puede drenar fondos fuera del ciclo de gobernanza (invariante I4).

A partir del pivote Credit Liquidity Protocol (CLP, abril/2026 — hoy legado), el Treasury también:

1. **Ejecuta FFP buyback** (Fase 1.1) — swap real USDC -> CREDIT vía Uniswap V3 + quema inmediata, defendiendo el **floor price** cuando el spot rompe debajo del MA90 por 24h.
2. **Provisiona POL** (Fase 1.2) — Protocol-Owned Liquidity en el pool CREDIT/USDC 0.3%, NFT custodiado por el Treasury, rango full ticks.
3. **Recibe bucket bonders** (Fase 1.4) — `RewardDistributorV2` deposita 5% de la emisión por ronda en un ledger interno (`polRefillBucket`) que la gobernanza drena vía `addPOLFromRefill`.
4. **Fallback gauge paused** (Fase 1.4) — si `LiquidityGauge.paused()` en el momento de `finalizeRound`, V2 deposita el bucket LPs en un segundo ledger (`pendingGaugeRewards`) drenado luego vía `flushPendingGaugeRewards`.

Sin función `deposit` para tokens pasivos — cualquier pagador usa `token.transfer(treasury, amount)` directo. **Sin pause** — poder unilateral de congelar sería vector de captura.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parámetros y storage

### Constants

| Nombre | Valor |
|---|---|
| `BPS_DENOMINATOR` | `10_000` |
| `MA_WINDOW_DAYS` | `90` |
| `RECORD_COOLDOWN` | `22 hours` |
| `CHAINLINK_MAX_STALENESS` | `6 hours` |
| `POL_TICK_LOWER` | `-887220` (full range, tickSpacing 60) |
| `POL_TICK_UPPER` | `887220` |

### Immutables (constructor)

- `CREDIT_TOKEN` — dirección del CREDIT defendido.
- `USDC_TOKEN` — stablecoin de origen de los buybacks. `address(0)` aceptado en dev (buyback queda deshabilitado hasta re-deploy con dirección oficial).

### Storage — FFP (Fase 1.1)

| Nombre | Tipo | Default | Bounds |
|---|---|---|---|
| `priceOracle` | `ICreditPriceOracle` | `address(0)` | governance setter |
| `swapRouter` | `IUniswapV3SwapRouter` | `address(0)` | governance setter |
| `swapFeeTier` | `uint24` | `3000` (0.3%) | cualquier no-cero |
| `chainlinkUsdcFeed` | `IChainlinkAggregator` | `address(0)` | governance setter |
| `floorMultiplierBps` | `uint16` | `5000` (0.50 × MA90) | `[3000, 8000]` |
| `floorAbsoluteUsd` | `uint256` | `1e17` ($0.10) | `[1e16, 1e19]` |
| `triggerDurationSecs` | `uint32` | `24 hours` | `[1h, 7d]` |
| `twapWindowSecs` | `uint32` | `30 minutes` | `[5min, 2h]` |
| `chainlinkSanityLowBps` | `uint16` | `9900` (0.99) | `[9000, 9999]` |
| `chainlinkSanityHighBps` | `uint16` | `10100` (1.01) | `[10001, 11000]` |
| `capPerEventBps` | `uint16` | `2000` (20%) | `[100, 5000]` |
| `capMonthlyBps` | `uint16` | `3000` (30%) | `[100, 7000]` |
| `slippageMaxBps` | `uint16` | `100` (1%) | `[10, 500]` |
| `lastFloorBreachTimestamp` | `uint256` | `0` | — |
| `dailyPrices[90]` | `uint256[90]` | ring buffer | — |
| `dailyPriceCount` | `uint16` | crece hasta 90, después para | — |
| `dailyPriceCursor` | `uint16` | próxima posición a escribir | — |
| `dailyPriceSum` | `uint256` | suma corriente (O(1) MA) | — |
| `monthlySpent[monthIdx]` | mapping | USDC gastado en el mes | — |
| `monthlyReservesSnapshot[monthIdx]` | mapping | denominador del cap mensual | — |

### Storage — POL (Fase 1.2)

| Nombre | Tipo | Descripción |
|---|---|---|
| `positionManager` | `INonfungiblePositionManager` | NPM Uniswap V3 |
| `polTokenId` | `uint256` | NFT id de la posición POL (`0` = no seedada) |

### Storage — Fase 1.4 (bucket bonders + gauge fallback)

| Nombre | Tipo | Descripción |
|---|---|---|
| `polRefillBucket` | `uint256` | Ledger interno del bucket bonders |
| `pendingGaugeRewards` | `uint256` | Ledger fallback gauge paused |
| `liquidityGauge` | `ILiquidityGaugeRewards` | Destino del flush |
| `liquidityGaugePoolId` | `uint256` | Pool default en el gauge |

## Roles y permisos

| Role | En producción | Concedida a |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | Conceder/revocar roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | Toda salida de fondos, buyback, POL, setters |
| `POL_REFILL_DEPOSITOR_ROLE` | `RewardDistributorV2` | `depositPolRefill` |
| `GAUGE_FALLBACK_DEPOSITOR_ROLE` | `RewardDistributorV2` | `depositPendingGaugeRewards` |

## Funciones externas

### Salidas básicas (`GOVERNANCE_ROLE`)

#### `transfer(IERC20 token, address to, uint256 amount)`

Transfiere ERC-20 del treasury.

- **Revierte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`.
- **Eventos**: `Transferred(token, to, amount)`.

#### `batchTransfer(IERC20 token, address[] recipients, uint256[] amounts)`

Batch.

- **Revierte**: `ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance`.
- **Eventos**: N × `Transferred` + 1 × `BatchTransferred(token, total, recipientCount)`.

#### `payRebates(IERC20 token, address[] apps, uint256[] amounts, uint256 round)`

Mecánicamente equivalente a `batchTransfer`, con el evento semántico `RebatesPaid(token, round, total, appCount)`.

#### `sweepETH(address payable to, uint256 amount)`

Retira ETH custodiado.

- **Revierte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `ETHTransferFailed`.
- **Eventos**: `ETHSwept(to, amount)`.

#### `receive() external payable`

Acepta ETH. Emite `ETHReceived(sender, amount)`.

### FFP — recordDailyPrice (permissionless)

#### `recordDailyPrice()`

Graba el precio TWAP actual en el ring buffer y actualiza el checkpoint de breach. Permissionless, protegido por `RECORD_COOLDOWN` (22h).

- **Update del breach**:
  - Spot >= floor -> resetea `lastFloorBreachTimestamp = 0`.
  - Spot < floor y timestamp == 0 -> marca timestamp actual.
  - Spot < floor y timestamp > 0 -> preserva (no resetea).
- **Bootstrap**: mientras `dailyPriceCount < 90`, `ma90Price()` retorna 0 y el floor cae a `floorAbsoluteUsd` solamente. Bootstrap exige 90 invocaciones consecutivas (~90 días con keeper diario).
- **Revierte**: `BuybackInfraMissing` (oracle no seteado), `RecordCooldownActive(nextAllowedAt)`, `InvalidOraclePrice`.
- **Eventos**: `DailyPriceRecorded(caller, priceUsd18, ma90Usd18, sampleCount)`.

### FFP — executeBuyback (`GOVERNANCE_ROLE`)

#### `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)`

Ejecuta buyback de CREDIT pagado en USDC y quema inmediata. Defensa del floor price.

**Pre-condiciones (todas on-chain):**

1. Infra seteada (oracle, router, feed) — caso contrario `BuybackInfraMissing`.
2. Spot TWAP < `currentFloorPrice()` — `SpotAboveFloor` si está arriba.
3. `block.timestamp - lastFloorBreachTimestamp >= triggerDurationSecs` — `BreachDurationInsufficient`.
4. Chainlink USDC/USD entre `[chainlinkSanityLowBps, chainlinkSanityHighBps]` y fresco — `UsdcDepegDetected`/`ChainlinkStale`/`InvalidChainlinkAnswer`.
5. `usdcAmount <= cap por evento` (20% de las reservas actuales) — `CapPerEventExceeded`.
6. `monthlySpent + usdcAmount <= cap mensual` (30% del snapshot del mes) — `CapMonthlyExceeded`.
7. `usdcAmount > 0`, `minCreditOut > 0` — `ZeroAmount`.

**Acción:**

1. Approve `usdcAmount` al router.
2. `exactInputSingle(USDC -> CREDIT, recipient = treasury, amountOutMinimum = minCreditOut)`.
3. `CreditToken.burnByRole(treasury, creditOut, "treasury:buyback")` — el CREDIT comprado es SIEMPRE quemado (nunca acumulado).
4. Reset approve a 0.

- **Eventos**: `BuybackExecuted(usdcSpent, creditBurned, floorUsd, spotUsd, monthIndex)`.
- **ReentrancyGuard**: sí.

### POL — addPOL / removePOL / collectPOLFees (`GOVERNANCE_ROLE`)

#### `addPOL(uint256 creditAmount, uint256 usdcAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)`

Provisiona liquidez en el pool CREDIT/USDC. Rango FULL (`POL_TICK_LOWER`, `POL_TICK_UPPER`). NFT custodiado por el Treasury.

- Primera llamada (`polTokenId == 0`): `mint`. Almacena tokenId.
- Subsiguientes: `increaseLiquidity` en el mismo tokenId.

`amount0Min`/`amount1Min` en orden del POOL (`token0 < token1` por dirección). Usá la view `polTokensOrdered()` para descubrir el orden antes de enviar la propuesta.

- **Revierte**: `ZeroAmount`, `BuybackInfraMissing` (USDC o positionManager no seteados).
- **Eventos**: `POLAdded(tokenId, liquidityAdded, creditAmount, usdcAmount)`.

#### `removePOL(uint128 liquidityAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)`

`decreaseLiquidity` + `collect`. NO quema el NFT (posición con 0 liquidez queda disponible para reuso vía `addPOL`).

Política de exit: el gate "supermayoría 75% para remociones > 25%" es responsabilidad del `CommunityGovernor` (proposal type), no de este contrato.

- **Revierte**: `ZeroAmount`, `POLNotInitialized`, `BuybackInfraMissing`.
- **Eventos**: `POLRemoved(tokenId, liquidityRemoved, amount0Out, amount1Out)`.

#### `collectPOLFees(uint128 amount0Max, uint128 amount1Max)`

Colecta fees acumulados por la posición POL. Sin auto-compound — para reinvertir, gobernanza llama `collectPOLFees` -> `addPOL` en propuestas separadas (o batch vía `executeBatch` del Timelock).

- **Revierte**: `POLNotInitialized`, `BuybackInfraMissing`.
- **Eventos**: `POLFeesCollected(tokenId, amount0, amount1)`.

### Fase 1.4 — Bucket bonders + gauge fallback

#### `depositPolRefill(uint256 amount)` — `POL_REFILL_DEPOSITOR_ROLE`

Acumula `amount` en `polRefillBucket`. Llamado por `RewardDistributorV2` tras acuñar CREDIT directamente a este Treasury.

- **Revierte**: `ZeroAmount`.
- **Eventos**: `PolRefillDeposited(amount, newBucketTotal)`.

#### `addPOLFromRefill(uint256 creditAmount, uint256 usdcAmount, ...)` — `GOVERNANCE_ROLE`

Drena `creditAmount` del `polRefillBucket` casado con `usdcAmount` del balance libre del Treasury para inyección en `polTokenId`. Reusa `_orderTokens` + `_provisionLiquidity`.

USDC viene del balance libre del Treasury (alimentado por `treasuryBps` del FeeRouter — split `(7000, 2000, 1000)` debe estar live).

CEI: debita ledger ANTES de la llamada externa (idempotencia en revert).

- **Revierte**: `ZeroAmount`, `BuybackInfraMissing`, `PolRefillBucketInsufficient(requested, available)`.
- **Eventos**: `POLAdded` + `PolRefillUsed(creditUsed, usdcUsed, newBucketTotal)`.

#### `depositPendingGaugeRewards(uint256 amount)` — `GAUGE_FALLBACK_DEPOSITOR_ROLE`

Fallback contable cuando `gauge.paused() == true` en `finalizeRound`. Sin este camino, pausar el gauge trabaría la finalización de la ronda entera (red flag E.3 #2).

- **Revierte**: `ZeroAmount`.
- **Eventos**: `PendingGaugeDeposited(amount, newPendingTotal)`.

#### `flushPendingGaugeRewards(uint32 duration)` — `GOVERNANCE_ROLE`

Drena `pendingGaugeRewards` al gauge vía `notifyRewardAmount(poolId, amount, duration)`. Aprueba CREDIT, drena, reset approve.

- **Revierte**: `LiquidityGaugeNotSet`, `LiquidityGaugePaused`, `NoPendingGaugeRewards`.
- **Eventos**: `PendingGaugeFlushed(amount, poolId, duration)`.

#### `setLiquidityGauge(ILiquidityGaugeRewards gauge, uint256 poolId)` — `GOVERNANCE_ROLE`

Configura destino del flush.

- **Eventos**: `LiquidityGaugeSet(gauge, poolId)`.

### Setters FFP / POL (`GOVERNANCE_ROLE`)

`setPriceOracle`, `setSwapRouter`, `setSwapFeeTier`, `setChainlinkFeed`, `setFloorMultiplierBps`, `setFloorAbsoluteUsd`, `setTriggerDurationSecs`, `setTwapWindowSecs`, `setChainlinkSanityLowBps`, `setChainlinkSanityHighBps`, `setCapPerEventBps`, `setCapMonthlyBps`, `setSlippageMaxBps`, `setPositionManager`. Cada uno con bounds documentados en la tabla de storage.

- **Eventos**: `BuybackInfraUpdated(paramKey, addr, numeric)` para infra; `BuybackParamsUpdated(paramKey, newValue)` para params numéricos.

### Views

- `balanceOf(IERC20 token) -> uint256`.
- `currentMonthIndex() -> uint256` — `block.timestamp / 30 days`.
- `ma90Price() -> uint256` — promedio en USD 18 dec (0 si no bootstrapped).
- `currentFloorPrice() -> uint256` — `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)`.
- `polPosition() -> (tokenId, liquidity, tickLower, tickUpper, tokensOwed0, tokensOwed1)` — revierte `POLNotInitialized`.
- `polTokensOrdered() -> (token0, token1, creditIsToken0)` — orden real del par en el pool.

## Eventos

| Evento | Cuándo | Indexados |
|---|---|---|
| `Transferred(token, to, amount)` | Toda salida | `token`, `to` |
| `BatchTransferred(token, total, count)` | `batchTransfer` | `token` |
| `RebatesPaid(token, round, total, count)` | `payRebates` | `token`, `round` |
| `ETHReceived(from, amount)` | `receive` | `from` |
| `ETHSwept(to, amount)` | `sweepETH` | `to` |
| `BuybackExecuted(...)` | `executeBuyback` | `monthIndex` |
| `DailyPriceRecorded(caller, price, ma90, count)` | `recordDailyPrice` | `caller` |
| `BuybackParamsUpdated(paramKey, newValue)` | Setters numéricos FFP | `paramKey` |
| `BuybackInfraUpdated(paramKey, addr, numeric)` | Setters de infra | `paramKey`, `addr` |
| `POLAdded(tokenId, liquidity, creditAmount, usdcAmount)` | `addPOL` / `addPOLFromRefill` | `tokenId` |
| `POLRemoved(tokenId, liquidity, amount0, amount1)` | `removePOL` | `tokenId` |
| `POLFeesCollected(tokenId, amount0, amount1)` | `collectPOLFees` | `tokenId` |
| `PolRefillDeposited(amount, newTotal)` | `depositPolRefill` | — |
| `PolRefillUsed(creditUsed, usdcUsed, newTotal)` | `addPOLFromRefill` | — |
| `PendingGaugeDeposited(amount, newTotal)` | `depositPendingGaugeRewards` | — |
| `PendingGaugeFlushed(amount, poolId, duration)` | `flushPendingGaugeRewards` | `poolId` |
| `LiquidityGaugeSet(gauge, poolId)` | `setLiquidityGauge` | `gauge` |

## Errores customizados

### Originales

`ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance(token, requested, available)`, `ETHTransferFailed`.

### FFP

| Error | Cuándo |
|---|---|
| `BuybackInfraMissing()` | Oracle/router/feed no seteados |
| `SpotAboveFloor(spot, floor)` | Spot >= floor |
| `BreachDurationInsufficient(elapsed, required)` | Breach < trigger duration |
| `UsdcDepegDetected(answer, low, high)` | Chainlink fuera de banda |
| `ChainlinkStale(updatedAt, maxStaleness)` | Feed congelado |
| `InvalidChainlinkAnswer(answer)` | answer <= 0 |
| `CapPerEventExceeded(requested, cap)` | Excede cap evento |
| `CapMonthlyExceeded(requested, alreadySpent, cap)` | Excede cap mensual |
| `RecordCooldownActive(nextAllowedAt)` | Cooldown 22h activo |
| `ParamOutOfBounds(provided, min, max)` | Setter fuera de bounds |
| `InvalidOraclePrice()` | Oracle retornó 0 |

### POL / Fase 1.4

| Error | Cuándo |
|---|---|
| `POLNotInitialized()` | `polTokenId == 0` en remove/collect |
| `PolRefillBucketInsufficient(requested, available)` | `addPOLFromRefill` excede ledger |
| `LiquidityGaugeNotSet()` | `flushPendingGaugeRewards` sin gauge |
| `LiquidityGaugePaused()` | Flush con gauge paused |
| `NoPendingGaugeRewards()` | Flush con ledger vacío |

## Invariantes

- **I4 (Salida sólo por governance)**: toda salida de valor exige `GOVERNANCE_ROLE`. En producción, exclusivo del Timelock.
- **IE7 (FFP)**: buyback ejecutado debajo del floor con TWAP 30min + slippage máximo 1% + cap por evento y mensual sobre las reservas USDC.
- **CREDIT comprado siempre se quema** — nunca acumulado en treasury. Refuerza la narrativa deflacionaria e impide captura vía whaledom interno de CREDIT.
- **Sin pause**: ningún poder unilateral de congelar la tesorería. Riesgo residual aceptado a cambio de descentralización.
- **CEI**: ledgers debitados antes de llamadas externas (`addPOLFromRefill`, `flushPendingGaugeRewards`).
- **ReentrancyGuard**: todas las salidas de valor + `recordDailyPrice` (oracle externo).

## Notas importantes

### Por qué el CREDIT comprado siempre se quema

Acumular CREDIT en el Treasury vía buyback crearía un agente endógeno de captura: el protocolo manteniendo su propio token. Eso:

1. Concentraría poder económico en la caja.
2. Distorsionaría señales de demanda (Treasury sería comprador residual permanente).
3. Invitaría propuestas oportunistas para usar ese CREDIT en flujos no deflacionarios.

Quemar inmediatamente alinea el buyback con la narrativa "demand-driven deflation" del FFP.

### Bootstrap del MA90

El MA90 sólo se considera válido tras 90 muestras consecutivas. Antes de eso, `currentFloorPrice` retorna `floorAbsoluteUsd` solamente (default $0.10). Consecuencia: el protocolo puede correr 90 días con defensa **mínima** antes de que el floor relativo se active — diseño deliberado para no bloquear bootstrap por falta de oracle.

### Cap mensual usa snapshot, no balance corriente

El snapshot se toma en el primer buyback del mes. Razón: impide que un atacante manipule el cap aumentando reservas USDC durante el mes (ej.: donación grande el día 28 que duplicaría el techo restante).

### POL rango full vs concentrado

Decisión (ver `audit/economist/2026-04-24-pol-params.md`): rango full (`-887220`, `887220`). Razones:

- Sin rebalance activo (concentrado exigiría gestión off-chain).
- Capital eficiente lo suficiente en mercados early-stage.
- Auditable trivialmente (ticks fijos, sin decisión dinámica).

Migración a concentrado puede ocurrir en la Fase 2 cuando la DAO tenga datos de TVL/volumen.

### Refill POL — flujo completo

```
RewardDistributorV2.finalizeRound(R)
  -> CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
  -> Treasury.depositPolRefill(bondersAmount)
     - polRefillBucket += bondersAmount

(cuando la gobernanza decide)

Propuesta DAO: addPOLFromRefill(creditAmount, usdcAmount, ...)
  -> Treasury (Timelock ejecuta)
  -> debita polRefillBucket
  -> _orderTokens + _approveNPM + _provisionLiquidity
  -> NPM.increaseLiquidity (o mint si primera)
  -> approve reset 0
```

### USDC del refill viene del FeeRouter

Para que `addPOLFromRefill` tenga USDC para casar con el CREDIT, el `FeeRouter` debe estar en split `(7000, 2000, 1000)` activo (70% burn / 20% treasury / 10% rebate). El default es `(9500, 0, 500)` — ese split es **prerrequisito documental** para que la Fase 1.4 produzca USDC recurrente. Decisión de la DAO vía `setDefaultSplit`.

### Recepción de ETH

`receive` emite `ETHReceived` — no es payable silencioso. El constructor no es payable.

### Tokens no estándar

`SafeERC20` en todas las salidas. `forceApprove` en todos los approves (USDT mainnet exige reset a 0 antes de nuevo set).

---

**Ver también**: [FeeRouter](08-FeeRouter.md), [LiquidityGauge](13-LiquidityGauge.md), [RewardDistributorV2](07b-RewardDistributorV2.md), [UserSubsidy](12-UserSubsidy.md), [TeamVesting](11-TeamVesting.md).
