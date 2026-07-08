# Treasury y fees

**Para quién es:** quien quiere entender el flujo de caja del protocolo.
**Prerrequisitos:** [Dual-token](01-dual-token-economy.md), [Gobernanza](05-governance.md).

## El cofre de la DAO

`Treasury` es el cofre multi-activo central. Tres propiedades fundamentales:

1. **Recibe pasivamente**. No hay función `deposit`. Cualquiera transfiere ERC-20 (o ETH vía `receive`) directamente a la dirección del Treasury.
2. **Sólo libera vía gobernanza**. Toda función de salida exige `GOVERNANCE_ROLE`.
3. **Sin pause**. Deliberadamente no hay función para congelar salidas. Cualquier poder unilateral de congelar la tesorería sería vector de captura.

A partir del pivote CLP (Fase 1, abril/2026), el Treasury también ejecuta cuatro funciones económicas adicionales:

| Función | Fase CLP | Resumen |
|---|---|---|
| **FFP buyback** | 1.1 | Swap real USDC -> CREDIT + quema inmediata, defendiendo el floor |
| **POL** | 1.2 | Liquidez propia en el pool CREDIT/USDC (NFT custodiado, rango full) |
| **Bucket bonders** | 1.4 | Recibe 5% de la emisión por ronda como ledger `polRefillBucket` |
| **Fallback gauge** | 1.4 | Acumula bucket LPs en `pendingGaugeRewards` cuando gauge paused |

El Treasury recibe:

- **Genesis mint de CREDIT** (10M en producción — parámetro `genesisAmount` del deploy). Única entrada "programática" inicial.
- **Porción de `treasuryBps`** del split del `FeeRouter` (default de producción: `2000` = 20%, split `(7000, 2000, 1000)`). Llega en **CREDIT** — quien paga vía `FeeRouter.pay` paga en CREDIT.
- **Colateral de slash** de proyectos removidos con `slash == true`.
- **Subsidios devueltos** de campañas `UserSubsidy.closeCampaign`.
- **Bucket bonders** del `RewardDistributorV2` (5% de la emisión por ronda — ledger `polRefillBucket`).
- **Bucket LPs** cuando gauge paused (ledger `pendingGaugeRewards`).
- **Cualquier donación** que la DAO decida aceptar.

## Qué hace la DAO con el Treasury

Operaciones típicas, todas vía propuesta:

- **Pagar rebates a apps** (`payRebates(token, apps[], amounts[], round)`).
- **Patrocinar campañas de `UserSubsidy`** — transferir CREDIT antes de `createCampaign`.
- **Fondear `TeamVesting`** — transferir GOV al vesting del beneficiario.
- **Ejecutar FFP buyback** — `executeBuyback(usdcAmount, minCreditOut)` swap USDC -> CREDIT + quema inmediata (Fase 1.1).
- **Agregar POL** — `addPOL(creditAmount, usdcAmount, ...)` provisiona liquidez en el par CREDIT/USDC (Fase 1.2).
- **Refilar POL con bucket bonders** — `addPOLFromRefill(creditAmount, usdcAmount, ...)` casa CREDIT del ledger con USDC del balance libre.
- **Drenar fallback gauge** — `flushPendingGaugeRewards(amount, poolId, duration)` envía el ledger acumulado (total o parcial) de vuelta al gauge tras despausarse.
- **Financiar operaciones off-chain** — `transfer` a un multisig operacional.

## Fees — el FeeRouter

Interfaz **única** de pago entre usuarios y apps. Función principal:

```solidity
function pay(uint256 projectId, address user, uint256 amount)
    external returns (uint256 burned, uint256 toTreasury, uint256 toApp);
```

El `user` debe haber hecho `approve(feeRouter, amount)` en CREDIT **antes**. `msg.sender` es quien inicia la tx — puede ser el usuario, la app, un relayer, una smart wallet.

## Split por defecto — 70 / 20 / 10

En producción (`ignition/parameters/production.json`):

```
burnBps     = 7000   (70% quemado vía BurnTracker)
treasuryBps = 2000   (20% para el Treasury)
rebateBps   = 1000   (10% para el appRecipient)
```

La suma debe ser exactamente 10_000 (`_BPS_DENOMINATOR`). Splits diferentes son rechazados con `InvalidSplit`.

Decisión de diseño: este es el split "Fase 0" recomendado en el parecer CLP, horneado en los parámetros de deploy — el pre-requisito de la Fase 1.4 (Treasury con ingreso recurrente) se satisface en un deploy fresh, sin depender de propuesta posterior. El trade-off es explícito: quema 70% (en vez del 95% del diseño pre-CLP), captura 20% para el cofre y sube el rebate a 10%. Si la DAO quiere rebalancear, basta proponer `setDefaultSplit` — la arquitectura lo permite.

### Ingreso recurrente del split — y la denominación importa

Con `treasuryBps = 2000`, el Treasury acumula **ingreso operacional recurrente en CREDIT** (los pagos vía `FeeRouter.pay` son en CREDIT). Además de él, entran:

- Slash de colateral de proyectos removidos con `slash == true` (eventual).
- Sobras de campañas `UserSubsidy.closeCampaign` (eventual).
- Donaciones externas y ETH enviado directo.
- Bucket bonders y fallback gauge (Fase 1.4) — esos **acumulan en ledgers separados** (`polRefillBucket` y `pendingGaugeRewards`), no en el balance libre. El bucket bonders es earmarkado para refill POL; sólo sirve para eso.

**Atención a la denominación en el refill del POL**: `addPOLFromRefill` casa CREDIT del `polRefillBucket` con **USDC** del balance libre — y la porción `treasuryBps` llega en CREDIT, no en USDC. Las fuentes reales de USDC del Treasury son **bootstrap externo** (donación/venta aprobada por la DAO) y **`collectPOLFees`** (fees de la propia posición POL acumulan en ambos tokens del par). Si falta USDC, el CREDIT del bucket no queda atrapado para siempre: la gobernanza puede reciclarlo vía `writeDownPolRefillBucket` (ver "Segregación on-chain" abajo).

## Override por proyecto

Algunos proyectos pueden negociar splits diferentes vía propuesta:

```solidity
feeRouter.setProjectSplit(projectId, Split({burnBps, treasuryBps, rebateBps}));
```

La flag `hasProjectSplit[projectId]` señala que existe override. `clearProjectSplit` lo remueve.

Uso típico: una app de alto volumen que aceptaría tasa efectiva mayor (porque tiene otra fuente de ingreso) puede negociar `6000/3000/1000` (30% treasury), financiando más agresivamente el cofre que el default de 20%.

## Recipient del rebate

Por default, el rebate va a `ProjectRegistry.getProject(projectId).owner`. Si el owner transfiere el proyecto, el destino cambia automáticamente — **lookup dinámico**.

El owner actual puede setear una dirección explícita vía:

```solidity
feeRouter.setAppRecipient(projectId, recipient);
```

Útil cuando el owner es un multisig y el rebate debe caer en una wallet operacional separada. Pasar `address(0)` resetea al lookup dinámico.

**No es governance-gated** — es owner-gated. La rotación operacional de caja no requiere propuesta.

## Manejo de dust

En splits con división no exacta:

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- el residuo cae aquí
```

En vez de redondear separadamente cada porción (perdiendo wei), `toApp` captura el residuo. Consecuencia: la app puede recibir 1-2 wei más que el cálculo nominal. Aceptable y auditable.

## Flujo completo de un pago

```
user tiene 1000 CREDIT              FeeRouter
user llama approve(feeRouter, 1000) --- allowance OK
user llama pay(projectId, user, 1000)
                                      |
                                      v
                      Check: projectId esta Active
                      Check: user != 0, amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                      FeeRouter tiene 1000 CREDIT
                                      |
                                      | split = 7000/2000/1000
                                      v
                        burned = 700, toTreasury = 200, toApp = 100
                                      |
          +---------------------------+----------------------------+
          |                           |                            |
          v                           v                            v
   approve(tracker, 700)       transfer(treasury, 200)      transfer(appRecipient, 100)
   tracker.burnAndRecord
                                                              appRecipient es
                                                              projectOwner por default
                                      |
   tracker llama                      |
   credit.burnByRole(router, 700)    |
                                      |
   CREDIT.totalSupply -= 700          |
   burnByRoundProject[R][pid] += 700  |
   totalBurnByRound[R] += 700         |
                                      v
                              Paid event emitted
```

Después de la tx: **FeeRouter tiene 0 CREDIT**. Nunca custodia entre llamadas. Cada `pay` es atómico.

## Salidas de ETH

El Treasury acepta ETH vía `receive` y puede retirar vía `sweepETH(to, amount)`. Usa `call{value}` (no `transfer`/`send`) para compatibilidad con destinos que son contratos con `receive` pesado. Si el destino rechaza, reverte con `ETHTransferFailed`.

El uso es de **cortesía** — el protocolo opera primariamente en ERC-20 (CREDIT, GOV, stables). Se acepta ETH para no dejar donaciones trabadas pero no es el flujo principal.

## Buyback — FFP real (Fase 1.1)

A partir del pivote CLP, `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)` **ejecuta swap real** de USDC -> CREDIT vía Uniswap V3 + quema inmediata. Defensa del **floor price** según el modelo Floating-con-Floor-Price (FFP). Detalles en [Treasury](../08-contracts-reference/04-Treasury.md).

El `priceOracle` tiene implementación de producción real: el **`CreditPriceOracle`** (`contracts/CreditPriceOracle.sol`), adapter del `ICreditPriceOracle` que deriva el TWAP del CREDIT en USD (18 decimales) del pool Uniswap V3 CREDIT/USDC y convierte USDC -> USD vía feed Chainlink USDC/USD (staleness máxima de 6h + banda de sanidad fija `[9900, 10100]` bps, espejando los defaults del Treasury). Todas las direcciones del oracle son `immutable`.

Pre-condiciones verificadas on-chain (todas obligatorias):

1. **Infra seteada** — `priceOracle`, `swapRouter` y `chainlinkUsdcFeed` configurados vía gobernanza. Sin eso, `BuybackInfraMissing`.
2. **Spot < floor** — TWAP del CREDIT (leído del `priceOracle`) debajo de `currentFloorPrice()`.
3. **Breach duró >= 24h** — `block.timestamp - lastFloorBreachTimestamp >= triggerDurationSecs`. Actualizado por `recordDailyPrice` (permissionless, cooldown 22h).
4. **USDC no despegado** — Chainlink USDC/USD entre `[0.99, 1.01]` (banda configurable en bps).
5. **Cap por evento** — `usdcAmount <= 20%` de las reservas USDC del Treasury (snapshot momentáneo).
6. **Cap mensual** — gasto cumulativo del mes `<= 30%` del snapshot tomado en el primer buyback del mes.

El CREDIT comprado es **siempre quemado** (`CreditToken.burnByRole(self, creditOut, "treasury:buyback")`). Nunca acumulado. Razón: acumular crearía agente endógeno de captura en el protocolo.

`recordDailyPrice` es la función keeper que alimenta el ring buffer de 90 muestras (`dailyPrices[90]`) y actualiza el checkpoint de breach. El bootstrap del MA90 exige 90 invocaciones consecutivas (~90 días). Antes de eso, `currentFloorPrice` retorna sólo `floorAbsoluteUsd` (default $0.10) — diseño deliberado para no bloquear bootstrap.

## POL (Protocol-Owned Liquidity, Fase 1.2)

El Treasury custodia una posición NFT en el pool CREDIT/USDC 0.3%. Rango full ticks (`-887220, 887220`). Decisión (ver `audit/economist/2026-04-24-pol-params.md`):

- Sin rebalance activo (concentrado exigiría gestión off-chain).
- Capital eficiente lo suficiente para mercados early-stage.
- Auditable trivialmente (ticks fijos).

API:

- `addPOL(creditAmount, usdcAmount, amount0Min, amount1Min, deadline)` — primera vez `mint`, después `increaseLiquidity` en el mismo `polTokenId`.
- `removePOL(liquidityAmount, ...)` — `decreaseLiquidity` + `collect`. NO quema el NFT (la posición queda disponible para reuso).
- `collectPOLFees(amount0Max, amount1Max)` — colecta fees acumulados, sin auto-compound.
- `polTokensOrdered()` view — devuelve el orden real `(token0, token1)` en el pool, útil para que el proponente DAO calcule `amount{0,1}Min`.

La supermayoría de 75% para remoción de POL es responsabilidad del `CommunityGovernor` (proposal type), no de este contrato — y ahora está **on-chain**: toda propuesta que contenga `Treasury.removePOL` (cualquier fracción, no sólo > 25%) se marca `Supermajority` en el `propose` y sólo vence con `forVotes >= 3 × againstVotes`. Ver [Gobernanza](05-governance.md).

## Bucket bonders y refill POL (Fase 1.4)

En cada `RewardDistributorV2.finalizeRound`, 5% (default) de la emisión es minteado directamente al Treasury y contabilizado en `polRefillBucket`:

```
RewardDistributorV2.finalizeRound(R)
  -> CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
  -> Treasury.depositPolRefill(bondersAmount)
     - polRefillBucket += bondersAmount
```

Cuando la gobernanza decide refilar el POL, propone `addPOLFromRefill(creditAmount, usdcAmount, ...)`:

```
Treasury.addPOLFromRefill (Timelock ejecuta la propuesta)
  -> debita polRefillBucket (CEI: antes del call externo)
  -> _orderTokens + _approveNPM + _provisionLiquidity
  -> NPM.increaseLiquidity (o mint si primera vez)
```

USDC viene del balance libre del Treasury — y como la porción `treasuryBps` del `FeeRouter` llega en CREDIT, las fuentes reales de USDC son bootstrap externo y `collectPOLFees` (ver sección "Ingreso recurrente del split").

La Fase 3 del roadmap CLP recicla este bucket en un `BondDepository` — los usuarios cambian ETH/CREDIT por CREDIT vested y el protocolo acumula POL vía bonds. Por ahora, el ledger sostiene el POL directamente.

## Fallback gauge paused (Fase 1.4)

Si el `LiquidityGauge` está paused en el momento de `finalizeRound`, el V2 no puede llamar `notifyRewardAmount`. Para no trabar la finalización de la ronda entera, V2 hace fallback:

```
RewardDistributorV2.finalizeRound(R) con gauge.paused() == true
  -> CREDIT.mint(treasury, lpsAmount, "rewardRound:lps:fallback")
  -> Treasury.depositPendingGaugeRewards(lpsAmount)
     - pendingGaugeRewards += lpsAmount
  -> emit GaugePauseFallback(R, lpsAmount)
```

Tras despausar el gauge, la gobernanza llama `Treasury.flushPendingGaugeRewards(amount, poolId, duration)`:

```
Treasury.flushPendingGaugeRewards (Timelock ejecuta)
  -> requiere gauge no paused, ledger > 0
  -> amount = 0 es centinela: drena el ledger entero; amount parcial permitido
     (amount > ledger revierte con PendingGaugeRewardsInsufficient)
  -> poolId = 0 es centinela: usa el poolId default configurado
     (los poolIds del gauge son 1-based)
  -> approve(gauge, amount), gauge.notifyRewardAmount(poolId, amount, duration)
  -> reset approve
```

El flush parcial + poolId explícito existen para evitar freeze: si un incentive equivalente ya está activo en el gauge (`IncentiveOverlap`), la gobernanza consigue drenar por partes o hacia otro pool.

## Segregación on-chain de los ledgers (invariante convertida en código)

Los dos ledgers contables (`polRefillBucket` y `pendingGaugeRewards`) son **enforced on-chain en los dos sentidos**:

- **Salidas genéricas no invaden reservas**: `transfer`, `batchTransfer`, `payRebates` y `addPOL` en CREDIT están limitadas a `unreservedCreditBalance()` (= `balanceOf(CREDIT) − polRefillBucket − pendingGaugeRewards`). El intento de invadir revierte con `TransferExceedsUnreservedCredit`. Las únicas salidas que tocan las reservas son las dedicadas (`addPOLFromRefill` y `flushPendingGaugeRewards`), que decrementan el ledger correspondiente.
- **Depósitos exigen respaldo**: `depositPolRefill` y `depositPendingGaugeRewards` revierten con `DepositExceedsCreditBalance` si la reserva agregada post-depósito excede el `balanceOf(CREDIT)` — imposible inflar el ledger sin el CREDIT correspondiente (el V2 mintea antes de depositar, en la misma tx).
- **Válvulas de escape auditables**: `writeDownPolRefillBucket` / `writeDownPendingGaugeRewards` (gobernanza, eventos `PolRefillWrittenDown` / `PendingGaugeWrittenDown`) reducen explícitamente un ledger, liberando el CREDIT al balance libre — escape de freeze y reciclaje del bucket bonders.

## Resumen

| Componente | Función | Gatekeeping |
|---|---|---|
| Treasury | Custodia multi-activo | `GOVERNANCE_ROLE` en las salidas |
| FeeRouter | Interfaz de pago | `GOVERNANCE_ROLE` en setters, público en `pay` |
| Split por defecto | 70% burn / 20% treasury / 10% rebate (`(7000, 2000, 1000)` en producción) | Ajustable por propuesta |
| Split por proyecto | Override vía `setProjectSplit` | `GOVERNANCE_ROLE` |
| Recipient del rebate | Owner del proyecto (dinámico) o explícito | Owner del proyecto (setter) |
| Buyback FFP | Real (Fase 1.1) — swap USDC->CREDIT + quema | `GOVERNANCE_ROLE` |
| POL | Liquidez propia CREDIT/USDC rango full | `GOVERNANCE_ROLE` |
| Bucket bonders | 5% emisión -> ledger refill POL | `POL_REFILL_DEPOSITOR_ROLE` (V2) |
| Fallback gauge | Ledger paused -> flush manual | `GAUGE_FALLBACK_DEPOSITOR_ROLE` (V2) + gobernanza |

---

**Siguiente ->** [Arquitectura](../03-protocol-overview/01-architecture.md)
