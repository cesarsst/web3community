# CreditPriceOracle

**Para quién es:** auditores, devs integrando el buyback FFP, keepers de `recordDailyPrice`.
**Prerrequisitos:** [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md), [Treasury (referencia)](04-Treasury.md).

## Visión rápida

Adapter de producción del `ICreditPriceOracle`: deriva el **TWAP del CREDIT en USD** (18 decimales) a partir del pool Uniswap V3 CREDIT/USDC, convirtiendo USDC → USD vía feed Chainlink USDC/USD. Es el oracle **real** que el `Treasury` consume en `recordDailyPrice` y `executeBuyback` (antes el adapter solo existía como mock de test).

Diseño deliberado — **adapter tonto y determinístico**:

- **SIN owner, SIN setters, SIN storage mutable** — toda la configuración es inmutable en el constructor. Si cualquier parámetro necesita cambiar (pool, feed, banda), se deploya otro adapter y la gobernanza apunta la nueva dirección vía `Treasury.setPriceOracle`.
- La **ventana TWAP es parámetro de la llamada**: el `Treasury` pasa su `twapWindowSecs` (default 30 min). El adapter no opina sobre el tamaño de la ventana — solo rechaza cero.
- `peekTwapPrice` está implementada como `view` (restricción válida de la interfaz no-view): ningún estado interno se actualiza.

> **Nota de licencia**: este contrato es **GPL-2.0-or-later** (el resto del repo es MIT). Contiene un port fiel del `TickMath.getSqrtRatioAtTick` de Uniswap V3 (v3-core @ 0.7.6, GPL-2.0-or-later) a 0.8.24. La única adaptación es el bloque `unchecked` (el algoritmo depende de wrap-around controlado que el 0.8.x chequearía) y el custom error en lugar de `require(..., 'T')`. `_quoteAtTick` sigue el `OracleLibrary.getQuoteAtTick` de v3-periphery, usando `Math.mulDiv` de OpenZeppelin (512 bits) en lugar del `FullMath` de Uniswap.

## Pipeline de `peekTwapPrice`

1. `pool.observe([secondsAgo, 0])` → `tickCumulatives`.
2. Tick medio aritmético = `delta / ventana`, redondeado hacia −∞ en deltas negativos no divisibles (convención `OracleLibrary` de Uniswap — sin eso el precio se sesgaría hacia arriba).
3. Tick → `sqrtPriceX96` vía port del `TickMath.getSqrtRatioAtTick`.
4. Cotización de 1 CREDIT entero en unidades brutas de USDC, tratando ambos órdenes `token0`/`token1` (orden detectado en el constructor vía `pool.token0()`).
5. Escala USDC (6 dec en producción) → 18 dec (`USDC_TO_USD18_SCALE = 10^(18 - usdcDecimals)`).
6. Multiplica por el precio Chainlink USDC/USD (staleness máx 6h + banda de sanidad fija `[9900, 10100]` bps), para que el retorno sea **USD real** y no USDC nominal.
   - **Fallback explícito**: si el feed es `address(0)` en el deploy, el adapter asume **1 USDC = 1 USD** (modo sin Chainlink, para redes donde el feed no existe — decisión deliberada de deploy).

## Herencia

Ninguna herencia de contrato — implementa solo la interfaz `ICreditPriceOracle`. Usa `IERC20Metadata` y `Math` de OpenZeppelin.

## Parámetros y storage

### Constants

| Nombre | Valor | Descripción |
|---|---|---|
| `BPS_DENOMINATOR` | `10_000` | Denominador de basis points |
| `CHAINLINK_MAX_STALENESS` | `6 hours` | Edad máxima de la respuesta del feed (mismo valor que el `Treasury`) |
| `CHAINLINK_SANITY_LOW_BPS` | `9900` (0.99) | Banda inferior de sanidad USDC/USD — **fija** |
| `CHAINLINK_SANITY_HIGH_BPS` | `10_100` (1.01) | Banda superior — **fija** |
| `MIN_TICK` | `-887272` | Tick mínimo Uniswap V3 |
| `MAX_TICK` | `887272` | Tick máximo Uniswap V3 |

> La banda de sanidad es **fija por diseño** (adapter sin setters), espejando los defaults del `Treasury`. El `Treasury` ya aplica su propia banda (configurable) en `executeBuyback`; el chequeo aquí es defensa en profundidad para `recordDailyPrice`, que no pasa por el `_enforceChainlinkSanity` del Treasury. Banda diferente ⇒ nuevo deploy.

### Immutables (constructor)

| Nombre | Tipo | Descripción |
|---|---|---|
| `POOL` | `IUniswapV3Pool` | Pool Uniswap V3 CREDIT/USDC fuente del TWAP |
| `CREDIT_TOKEN` | `address` | Token CREDIT (base de la cotización) |
| `USDC_TOKEN` | `address` | Token USDC (quote de la cotización) |
| `CHAINLINK_USDC_FEED` | `IChainlinkAggregator` | Feed USDC/USD. `address(0)` = modo sin Chainlink (1:1) |
| `CREDIT_IS_TOKEN0` | `bool` | `true` si CREDIT es el `token0` del pool (detectado vía `pool.token0()`) |
| `CREDIT_UNIT` | `uint128` | 1 CREDIT entero en unidades brutas (`10^decimals` del CREDIT) |
| `USDC_TO_USD18_SCALE` | `uint256` | Factor de escala USDC bruto → 18 dec (`10^(18 - usdcDecimals)`; USDC de producción: `10^12`) |

## Constructor

```solidity
constructor(address pool_, address credit_, address usdc_, address chainlinkUsdcFeed_)
```

- Valida que el pool realmente contiene el par `{credit, usdc}` (en cualquier orden) y detecta el orden vía `pool.token0()`.
- Lee los `decimals` de ambos tokens UNA vez y congela los factores de escala — los decimals de un ERC-20 son inmutables en la práctica; si un token migra, se deploya otro adapter.
- `chainlinkUsdcFeed_ == address(0)` activa el fallback 1 USDC = 1 USD (sin chequeo de staleness/banda — usar solo en redes sin el feed, decisión explícita de deploy).

- **Revierte**:
  - `ZeroAddress` si `pool_`, `credit_` o `usdc_` es cero.
  - `PoolTokenMismatch(token0, token1)` si `(pool.token0(), pool.token1())` no corresponde a `{credit, usdc}`.
  - `UnsupportedDecimals(decimals)` si CREDIT o USDC tiene más de 18 decimales.

## Funciones externas

### `peekTwapPrice(uint32 secondsAgo) → uint256 priceUsd18`

Retorna el TWAP del CREDIT en USD con 18 decimales para la ventana `secondsAgo` más reciente. Implementada como `view` — el `Treasury` la llama vía CALL normal y funciona idénticamente.

- **Revierte**:
  - `ZeroTwapWindow` si `secondsAgo == 0`.
  - `ObserveFailed(reason)` si el pool revierte en el `observe` (ej.: `"OLD"` cuando la cardinality del ring buffer de observaciones es insuficiente para la ventana).
  - `InvalidTick(tick)` si el tick medio sale de `[MIN_TICK, MAX_TICK]`.
  - `InvalidChainlinkAnswer` / `ChainlinkStale` / `UsdcDepegDetected` según el estado del feed (solo cuando el feed está configurado).
- **Sin eventos** (view). **Sin storage** — no mantiene estado.

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | Dirección cero en pool/credit/usdc en el constructor |
| `PoolTokenMismatch(token0, token1)` | El par del pool no corresponde a `{CREDIT, USDC}` |
| `UnsupportedDecimals(decimals)` | Token con más de 18 decimales |
| `ZeroTwapWindow()` | `secondsAgo == 0` (el Treasury nunca envía cero — bounds `[5min, 2h]`) |
| `ObserveFailed(reason)` | `pool.observe` revirtió (ej.: `"OLD"`) — bytes crudos del revert anexados |
| `InvalidTick(tick)` | Tick medio fuera de `[MIN_TICK, MAX_TICK]` — pool corrupto o mock inválido |
| `ChainlinkStale(updatedAt, maxStaleness)` | El feed retorna dato stale |
| `InvalidChainlinkAnswer(answer)` | El feed retorna precio ≤ 0 |
| `UsdcDepegDetected(reportedAnswer, lowBound, highBound)` | Feed USDC/USD fuera de la banda `[9900, 10100]` bps |

## Invariantes

- **Inmutabilidad total**: sin owner, sin setters, sin storage mutable. Cambio de configuración ⇒ nuevo deploy + `Treasury.setPriceOracle`.
- **USD real, no USDC nominal**: la salida se multiplica por el precio Chainlink USDC/USD (o 1:1 en el fallback), de modo que un depeg del USDC no pasa silenciosamente como precio válido del CREDIT.
- **Defensa en profundidad**: la banda de sanidad fija protege `recordDailyPrice`, que no tiene el chequeo del Treasury.
- **Convención numérica**: `1e18 = $1.00`, `5e17 = $0.50` — la misma de la interfaz `ICreditPriceOracle`.

## Observaciones importantes

### Por qué la ventana TWAP no es inmutable

El adapter es agnóstico al tamaño de la ventana — quien decide es el `Treasury` (`twapWindowSecs`, configurable en `[5min, 2h]`). Así, ajustar la ventana del buyback no exige re-deploy del oracle. El adapter solo rechaza `secondsAgo == 0`.

### Modo sin Chainlink (fallback 1:1)

`CHAINLINK_USDC_FEED == address(0)` hace que el adapter trate 1 USDC = 1 USD sin chequeo de staleness o banda. Es deliberado para entornos (dev/testnet o redes sin el feed oficial) donde el feed no existe. En producción mainnet, el feed **debe** ser provisto — de lo contrario un depeg del USDC no sería detectado.

### Detección de orden del par

El orden `token0`/`token1` se detecta en el constructor vía `pool.token0()` y se congela en `CREDIT_IS_TOKEN0`. `_quoteAtTick` usa ese flag para cotizar 1 CREDIT en USDC en la dirección correcta, sin depender de ordenación por dirección en runtime.

### Relación con el Treasury

- `Treasury.recordDailyPrice` lee `priceOracle.peekTwapPrice(twapWindowSecs)` — permissionless, cooldown 22h.
- `Treasury.executeBuyback` lee el mismo valor para comparar spot vs floor.
- Mientras `Treasury.priceOracle == address(0)`, ambos revierten con `BuybackInfraMissing` — el buyback queda deshabilitado hasta que la gobernanza setee el adapter vía `setPriceOracle`.

---

**Ver también**: [Treasury](04-Treasury.md), [CreditToken](02-CreditToken.md), [LiquidityGauge](13-LiquidityGauge.md).
