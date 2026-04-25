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

- **Genesis mint de CREDIT** (10M en producción). Única entrada "programática" inicial.
- **Porción de `treasuryBps`** del split del `FeeRouter` (default 0; recomendación CLP: subir a `(7000, 2000, 1000)` para alimentar USDC del refill POL).
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
- **Drenar fallback gauge** — `flushPendingGaugeRewards(duration)` envía ledger acumulado de vuelta al gauge tras despausarse.
- **Financiar operaciones off-chain** — `transfer` a un multisig operacional.

## Fees — el FeeRouter

Interfaz **única** de pago entre usuarios y apps. Función principal:

```solidity
function pay(uint256 projectId, address user, uint256 amount)
    external returns (uint256 burned, uint256 toTreasury, uint256 toApp);
```

El `user` debe haber hecho `approve(feeRouter, amount)` en CREDIT **antes**. `msg.sender` es quien inicia la tx — puede ser el usuario, la app, un relayer, una smart wallet.

## Split por defecto — 95 / 0 / 5

En producción (`ignition/parameters/production.json`):

```
burnBps     = 9500   (95% quemado vía BurnTracker)
treasuryBps = 0      (nada al Treasury en el default)
rebateBps   = 500    (5% al appRecipient)
```

La suma debe ser exactamente 10_000 (`_BPS_DENOMINATOR`). Splits diferentes son rechazados con `InvalidSplit`.

Decisión de diseño: 0% al treasury en el default **para no erosionar el incentivo al burn**. El Treasury recibe ingresos por otras vías (genesis ya minteado, slash, donaciones, buyback gestionado). Si en el futuro la DAO quiere capturar parte directa, basta proponer `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})` — la arquitectura lo permite.

### Consecuencia estructural — Treasury sin ingresos recurrentes en el default

Con `treasuryBps = 0` en producción, el Treasury **no acumula ingresos operacionales automáticos**. Las entradas recurrentes del split son cero — restan sólo:

- Slash de colateral de proyectos removidos con `slash == true` (eventual).
- Sobras de campañas `UserSubsidy.closeCampaign` (eventual).
- Donaciones externas y ETH enviado directo.
- Bucket bonders y fallback gauge (Fase 1.4) — esos **acumulan en ledgers separados** (`polRefillBucket` y `pendingGaugeRewards`), no en el balance libre. El bucket bonders es earmarkado para refill POL; sólo sirve para eso.

**Para que la Fase 1.4 (CLP) opere plenamente — es decir, para que `addPOLFromRefill` tenga USDC para casar con el CREDIT del bucket bonders —, el Treasury necesita USDC entrando recurrentemente.** La única fuente estructural para eso es elevar `treasuryBps > 0` en el `FeeRouter`. La recomendación operacional del parecer es `(7000, 2000, 1000)` (70% burn / 20% treasury / 10% rebate), que:

- Reduce la quema de 95% a 70% — más CREDIT en circulación.
- Direcciona 20% al Treasury en USDC/CREDIT (depende de quién paga y cómo).
- Mantiene 10% de rebate para apps.

Esa decisión es de la DAO vía `setDefaultSplit`. Sin eso, el bucket bonders queda acumulando CREDIT en el ledger sin que la gobernanza pueda drenarlo (faltaría USDC).

## Override por proyecto

Algunos proyectos pueden negociar splits diferentes vía propuesta:

```solidity
feeRouter.setProjectSplit(projectId, Split({burnBps, treasuryBps, rebateBps}));
```

La flag `hasProjectSplit[projectId]` señala que existe override. `clearProjectSplit` lo remueve.

Uso típico: una app de alto volumen que aceptaría tasa efectiva mayor (porque tiene otra fuente de ingreso) puede negociar `8000/1500/500` (15% treasury), financiando más agresivamente el cofre.

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
                                      | split = 9500/0/500
                                      v
                        burned = 950, toTreasury = 0, toApp = 50
                                      |
          +---------------------------+----------------------------+
          |                           |                            |
          v                           v                            v
   approve(tracker, 950)       (sin transfer al             transfer(appRecipient, 50)
   tracker.burnAndRecord       Treasury en este split)
                                                              appRecipient es
                                                              projectOwner por default
                                      |
   tracker llama                      |
   credit.burnByRole(router, 950)    |
                                      |
   CREDIT.totalSupply -= 950          |
   burnByRoundProject[R][pid] += 950  |
   totalBurnByRound[R] += 950         |
                                      v
                              Paid event emitted
```

Después de la tx: **FeeRouter tiene 0 CREDIT**. Nunca custodia entre llamadas. Cada `pay` es atómico.

## Salidas de ETH

El Treasury acepta ETH vía `receive` y puede retirar vía `sweepETH(to, amount)`. Usa `call{value}` (no `transfer`/`send`) para compatibilidad con destinos que son contratos con `receive` pesado. Si el destino rechaza, reverte con `ETHTransferFailed`.

El uso es de **cortesía** — el protocolo opera primariamente en ERC-20 (CREDIT, GOV, stables). Se acepta ETH para no dejar donaciones trabadas pero no es el flujo principal.

## Buyback — FFP real (Fase 1.1)

A partir del pivote CLP, `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)` **ejecuta swap real** de USDC -> CREDIT vía Uniswap V3 + quema inmediata. Defensa del **floor price** según el modelo Floating-con-Floor-Price (FFP). Detalles en [Treasury](../08-contracts-reference/04-Treasury.md).

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

La política "supermayoría 75% para remociones > 25%" es responsabilidad del `CommunityGovernor` (proposal type), no de este contrato.

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

USDC viene del balance libre del Treasury — depende de `treasuryBps > 0` en el `FeeRouter` (ver sección anterior).

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

Tras despausar el gauge, la gobernanza llama `Treasury.flushPendingGaugeRewards(duration)`:

```
Treasury.flushPendingGaugeRewards (Timelock ejecuta)
  -> requiere gauge no paused, ledger > 0
  -> approve(gauge, amount), gauge.notifyRewardAmount(poolId, amount, duration)
  -> reset approve
```

## Resumen

| Componente | Función | Gatekeeping |
|---|---|---|
| Treasury | Custodia multi-activo | `GOVERNANCE_ROLE` en las salidas |
| FeeRouter | Interfaz de pago | `GOVERNANCE_ROLE` en setters, público en `pay` |
| Split por defecto | 95% burn / 0% treasury / 5% rebate (recomendación CLP: `(7000, 2000, 1000)`) | Ajustable por propuesta |
| Split por proyecto | Override vía `setProjectSplit` | `GOVERNANCE_ROLE` |
| Recipient del rebate | Owner del proyecto (dinámico) o explícito | Owner del proyecto (setter) |
| Buyback FFP | Real (Fase 1.1) — swap USDC->CREDIT + quema | `GOVERNANCE_ROLE` |
| POL | Liquidez propia CREDIT/USDC rango full | `GOVERNANCE_ROLE` |
| Bucket bonders | 5% emisión -> ledger refill POL | `POL_REFILL_DEPOSITOR_ROLE` (V2) |
| Fallback gauge | Ledger paused -> flush manual | `GAUGE_FALLBACK_DEPOSITOR_ROLE` (V2) + gobernanza |

---

**Siguiente ->** [Arquitectura](../03-protocol-overview/01-architecture.md)
