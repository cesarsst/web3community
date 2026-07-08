# Glosario

**Para quién es:** cualquier lector que se tope con un término extraño en otra página.
**Prerrequisitos:** ninguno.

Términos usados en las demás páginas. Definiciones basadas en el código, no en convención externa.

Los términos marcados **(legado)** pertenecen al modelo anterior al remodel 2026-07-08 (burn-to-mint). Se mantienen porque los contratos siguen on-chain y las páginas históricas los citan — pero **no describen el modelo vigente**.

## accRevenuePerShare

Acumulador de receita por share en [`ProjectFunding`](../08-contracts-reference/16-ProjectFunding.md) (precisión `ACC_PRECISION = 1e18`, patrón MasterChef). Cada `notifyRevenue` suma `amount × 1e18 / raised`; el claim del inversor es `shares × acc / 1e18 - rewardDebt`. Costo O(1) por pago y O(1) por claim, independiente del número de inversores.

## All-or-nothing

Regla de las rondas de captación: el dueño del proyecto **solo** recibe el capital si la ronda alcanza el 100% del alvo antes del deadline. Si vence sin alcanzarlo, la ronda pasa a `Failed` y cada inversor retira el 100% de lo aportado vía `refund()`. Protege al inversor de financiar a medias un proyecto inviable.

## Alpha (α) (legado)

Factor multiplicativo de la fórmula de emisión de [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md) / [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md) (0.95 en producción). Sin función en el modelo vigente: el remodel eliminó la emisión de rewards.

## Bonders (legado)

Cuarto bucket del `RewardDistributorV2` (5% de la emisión por ronda), earmarkado para refill del POL. Parte del pivote CLP, anterior al remodel.

## Bucket (split de emisión) (legado)

Una de las 4 porciones de la emisión V2: stakers (55%), LPs (25%), apps (15%), bonders (5%). Sin función en el modelo vigente — no hay emisión que dividir.

## Burn (quema)

Decremento permanente del `totalSupply` de CREDIT vía `_burn` nativo del ERC-20. **En el modelo vigente ocurre en un único lugar**: `CreditPSM.sell()`, cuando un usuario redime CREDIT por USDC (el CREDIT devuelto se quema y el respaldo sale 1:1). Los pagos en apps **ya no queman** — eso era el modelo legado (`FeeRouter` V1 → `BurnTracker`).

## BurnTracker (legado)

Oráculo on-chain interno que contabilizaba burn por `(ronda, projectId)` para alimentar la emisión del `RewardDistributor`. Sustituido por el remodel: la métrica de uso vigente es `FeeRouterV2.grossVolumeOf`. Ver [BurnTracker](../08-contracts-reference/06-BurnTracker.md).

## Buyback (de GOV)

Destino del 40% de la fee del protocolo en el [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) (`buybackRecipient`). Financia recompra continua de GOV con ingresos reales — es el mecanismo por el cual GOV captura valor del volumen de pagos. No confundir con el FFP buyback de CREDIT del modelo CLP (legado).

## Cap (de supply)

Límite máximo de tokens existentes. GOV tiene cap **inmutable** de 100M. CREDIT no tiene cap: su supply es elástico y sigue la demanda de saldos de pago — cada unidad minteada por el PSM está respaldada 1:1 por USDC retenido.

## Checkpoint (anti-flashloan)

Historial on-chain de pesos de staking por bloque. `Staking` escribe checkpoints en cada cambio; el Governor lee votos en bloque pasado (`getPastVotes`). En el modelo vigente, `ProjectFunding` usa el peso **actual** (`getWeight > 0`) como gate de `invest`/`claim` — el capital comprometido (CREDIT) es la protección económica, no el snapshot.

## CLP (Credit Liquidity Protocol) (legado)

Pivote económico de abril/2026 (FFP buyback, POL, LiquidityGauge, buckets del V2). Superado por el remodel 2026-07-08: con CREDIT estable 1:1 vía PSM, la defensa de floor y los incentivos de liquidez dejaron de ser necesarios.

## CREDIT

Token ERC-20 de pago del protocolo, **estable 1:1 con USDC**. Se mintea al depositar USDC en el [`CreditPSM`](../08-contracts-reference/15-CreditPSM.md) (`buy`) y se quema al redimir (`sell`). Respaldo 100% retenido en el PSM, sin función de retiro. Medio de pago de las apps y moneda de las rondas de captación. Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## CreditPSM (PSM)

Peg Stability Module: contrato que convierte USDC ↔ CREDIT a 1:1, sin fee (`contracts/CreditPSM.sol`). `buy(usdcAmount)` deposita USDC y mintea CREDIT (6→18 decimales, factor `SCALE = 1e12`); `sell(creditAmount)` quema CREDIT y devuelve USDC. Invariante central: `USDC.balanceOf(PSM) >= mintedOutstanding` (normalizado) — **no existe ninguna función de retiro del respaldo, ni para la gobernanza**. Ver [CreditPSM](../08-contracts-reference/15-CreditPSM.md).

## CreditPriceOracle (legado)

Adapter TWAP Uniswap V3 + Chainlink que alimentaba el precio del CREDIT para el FFP del Treasury. Con CREDIT estable 1:1 vía PSM, el precio dejó de flotar y el oracle perdió su función económica.

## DAO (Decentralized Autonomous Organization)

Aquí: el conjunto `CommunityGovernor` + `CommunityTimelock`, que juntos controlan **todos** los contratos económicos del protocolo en producción.

## Fee del protocolo (feeBps)

Porcentaje que el [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) descuenta de cada pago: **2,5%** default (`feeBps = 250`), con techo duro inmutable de **5%** (`FEE_BPS_CAP = 500`) que ni la gobernanza puede superar. Comparable a un procesador de pagos (Stripe ~3,8%), no a una app store (15–30%).

## FeeRouter (V1) (legado)

Router de pagos del modelo burn-to-mint: split 70% burn / 20% treasury / 10% rebate. Sustituido por el `FeeRouterV2`. Ver [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

## FeeRouterV2

Riel de pagos del modelo vigente (`contracts/FeeRouterV2.sol`). `pay(projectId, amount)` descuenta la fee de 2,5% (split 40/40/20), transfiere el rev-share del proyecto al `ProjectFunding` (si hay ronda financiada) y envía el resto al dueño de la app en la misma transacción. Registra `grossVolumeOf` y emite `PaymentRouted` con el detalle de las 5 parcelas. Ver [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

## FeeSplit (40/40/20)

Repartición interna de la fee del protocolo entre tres destinos: **40% tesorería** (opex de la DAO), **40% buyback de GOV**, **20% grants** (fomento de nuevas apps). Configurada en bps de la propia fee (suma obligatoria 10000); ajustable por gobernanza vía `setFeeSplit`.

## FFP (Floating con Floor Price) (legado)

Modelo de defensa de precio del CREDIT (Fase 1.1 CLP): buyback + quema cuando spot < floor. Sin función con CREDIT pegged 1:1 — el "floor" ahora es el propio respaldo del PSM.

## Finalize (de ronda) (legado)

Congelamiento de la emisión calculada de una ronda en el `RewardDistributor`. No confundir con `finalizeRound` interno de `ProjectFunding` (`_fund`), que paga al dueño cuando la ronda de captación alcanza el alvo.

## Floor schedule (legado)

Array inmutable de 24 pisos de emisión del `RewardDistributor` para el bootstrap. Sin función en el modelo vigente.

## Genesis mint

Acuñación inicial única de CREDIT (10M en producción) ejecutada exactamente una vez vía `CreditToken.mintGenesis(to, amount)`. Anterior al remodel: el CREDIT genesis **no** tiene respaldo en el PSM (`mintedOutstanding` solo cuenta lo minteado vía `buy`). El PSM tolera redenciones de CREDIT legado clampeando el contador en cero, limitadas al USDC disponible.

## GOV

Token de gobernanza ERC-20 con la extensión `ERC20Votes`. Cap inmutable de supply de 100M. Tres funciones en el modelo vigente: **votar** (vía `getPastVotes`), **habilitar inversión** (solo quien tiene GOV stakeado en un proyecto puede invertir en su ronda y reclamar rev-share) y **capturar valor** (40% de la fee del protocolo financia buyback continuo). Ver [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md).

## GOVERNANCE_ROLE

Rol AccessControl concedido en producción **únicamente** al `CommunityTimelock`. Gate de toda función gobernanza-sensible. En el modelo vigente: `FeeRouterV2.setFeeBps/setFeeSplit/setRecipients` y `ProjectFunding.setMinTarget` (además de los contratos pre-remodel que siguen operativos: Treasury, ProjectRegistry, Staking).

## grossVolumeOf (GMV)

`FeeRouterV2.grossVolumeOf[projectId]`: volumen bruto acumulado de pagos de un proyecto, registrado on-chain. **La métrica principal para inversores** — permite auditar la facturación real de una app antes de invertir en su ronda y estimar el rendimiento del rev-share.

## Grants

20% de la fee del protocolo, destinado a fomentar nuevas apps del ecosistema (`grantsRecipient` en el `FeeRouterV2`). La asignación concreta de los grants es decisión de gobernanza.

## LiquidityGauge (legado)

Adapter sobre `UniswapV3Staker` que distribuía el bucket LPs (25% de la emisión) a LPs del par CREDIT/USDC. Sin función en el modelo vigente: no hay emisión y la conversión CREDIT↔USDC pasa por el PSM, no por pool. Ver [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md).

## Lock (de staking)

Tiempo (en segundos) durante el cual una posición de stake no puede deshacerse. Rango permitido: `[MIN_LOCK=14 días, cualquier tiempo]`. El multiplier satura en 4x a partir de `MAX_LOCK=365 días`.

## minTarget

Alvo mínimo de una ronda de captación en `ProjectFunding` (anti-spam). Default `100e18` (100 CREDIT); ajustable por gobernanza vía `setMinTarget`.

## Multiplier (de staking)

Factor aplicado al `amount` para calcular el peso. Lineal de 1x (14 días) a 4x (365 días), satura en 4x por encima. Definido en `Staking._multiplier(lockDuration)`.

## ownerRecipient

Dirección canónica (con timelock 48h) configurable en el `ProjectRegistry` para recibir fondos en nombre del proyecto. En el modelo vigente, el destino de los pagos del `FeeRouterV2` es `appRecipientOf[projectId]` (rotado por el dueño vía `setAppRecipient`), con fallback al `owner` del Registry. Ver [ProjectRegistry](../08-contracts-reference/03-ProjectRegistry.md).

## PaymentRouted

Evento del `FeeRouterV2` emitido en cada pago, con el detalle completo de las 5 parcelas: `feeToTreasury`, `feeToBuyback`, `feeToGrants`, `revShare`, `toApp`. Base de la contabilidad on-chain del protocolo.

## POL (Protocol-Owned Liquidity) (legado)

Liquidez propia del protocolo en el pool CREDIT/USDC (Fase 1.2 CLP). Con el PSM como riel de conversión 1:1, el pool dejó de ser la vía canónica de entrada/salida.

## Probation

Dos nociones distintas en el `ProjectRegistry`:

- **Probation inicial por tiempo**: ventana automática de 30 días para proyectos recién activados. En el modelo legado dividía la share de rewards por 4; en el modelo vigente no afecta pagos ni rondas.
- **Probation punitiva**: estado del enum `Project.Status`. La gobernanza mueve manualmente un proyecto de `Active` a `Probation` por mala conducta. Bloquea stake nuevo y pagos (`FeeRouterV2.pay` exige `isActive`), e impide abrir rondas de captación — pero **nunca bloquea unstake**.

## ProjectFunding

Contrato de captación + redistribución de receita del modelo vigente (`contracts/ProjectFunding.sol`). El dueño de un proyecto Active abre **una** ronda (alvo en CREDIT, rev-share 1%–30%, plazo 1–90 días); inversores con GOV stakeado aportan CREDIT; all-or-nothing; una vez `Funded`, el `FeeRouterV2` acredita el rev-share de cada pago pro-rata a las shares. Ver [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

## Proposal (propuesta)

Objeto del Governor que contiene `(targets, values, calldatas, descriptionHash)`. Pasa por estados Pending -> Active -> Succeeded/Defeated -> Queued -> Executed (o Canceled/Expired). Sólo ejecutable vía Timelock después de todos los delays.

## Rebate (legado)

Porción (10% en el split legado) que el `FeeRouter` V1 transfería a la app. En el modelo vigente la app no recibe un "rebate": recibe **todo el resto** del pago (~97,5% sin rev-share; ~89,5% con rev-share de 8%).

## Remodel 2026-07-08

Cambio de modelo económico: de "burn-to-mint deflacionario" a "riel de pagos + financiamiento por rev-share". Pilares: `CreditPSM` (CREDIT estable 1:1), `FeeRouterV2` (fee 2,5%, split 40/40/20) y `ProjectFunding` (rondas all-or-nothing con rev-share 1%–30%). Motivación: la tasa efectiva de ~80% sobre las apps hacía del bypass la estrategia dominante (`audit/economist/2026-07-08-feerouter-bypass.md`).

## Rev-share (revShareBps)

Porcentaje de los ingresos **brutos** de un proyecto que sus inversores reciben, definido por el dueño al abrir la ronda: entre `MIN_REV_SHARE_BPS = 100` (1%) y `MAX_REV_SHARE_BPS = 3000` (30%). Activo solo si la ronda alcanzó el alvo (`Funded`); mientras no, `revShareBpsOf` retorna 0 y el pago entero (menos fee) va a la app.

## REVENUE_NOTIFIER_ROLE

Rol de `ProjectFunding` concedido únicamente al `FeeRouterV2`: autoriza `notifyRevenue(projectId, amount)`, la contabilización del rev-share de cada pago. El router transfiere el CREDIT **antes** de notificar — el funding solo contabiliza, nunca hace pull.

## rewardDebt

Checkpoint del inversor contra `accRevenuePerShare` (patrón MasterChef) en `ProjectFunding`. Garantiza que cada inversor solo reclame la receita acumulada desde su última interacción.

## Ronda de captación (Round de ProjectFunding)

Estructura `Round {target, raised, deadline, revShareBps, status}` — única por proyecto (MVP). Estados: `None` (nunca abierta) → `Open` (captando) → `Funded` (alvo alcanzado, rev-share activo) o `Failed` (plazo vencido; refunds liberados). Bounds: alvo ≥ `minTarget`, rev-share 1%–30%, duración 1–90 días.

No confundir con la **ronda contable** del modelo legado (`BurnTracker.currentRound`), que cadenciaba la emisión de rewards.

## Sanity cap (legado)

Límite de burn por `(ronda, projectId)` en el `BurnTracker`. Sin función en el modelo vigente.

## Shares (de inversión)

Participación de un inversor en una ronda de `ProjectFunding`: `sharesOf[projectId][investor]` = CREDIT invertido (1:1, inmutable después del `Funded`). Base del pro-rata de la distribución de receita.

## Snapshot (de voto)

Bloque de referencia para calcular voting power de una propuesta. `Governor` usa `getPastVotes(account, proposalSnapshot)` — inmune a flash-loans que muevan tokens en el mismo bloque.

## Split (legado)

Configuración `(burnBps, treasuryBps, rebateBps)` del `FeeRouter` V1 (70/20/10 en producción). En el modelo vigente, el término análogo es el **FeeSplit** 40/40/20 del `FeeRouterV2` — que reparte la *fee*, no el pago entero.

## Staking (direccionado)

Acto de lockear GOV en un `projectId` específico del Registry. En el modelo vigente cumple dos funciones: **señal de compromiso** con el proyecto y **gate de inversión** — `ProjectFunding.invest` y `claim` exigen `getWeight(investor, projectId) > 0`. Ya no genera rewards de emisión (legado). Ver [Staking](../08-contracts-reference/05-Staking.md).

## Timelock

Contrato que ejecuta decisiones del Governor con un retraso mínimo (`minDelay`, en producción 2 días). `CommunityTimelock` es subclase trivial del `TimelockController` de OpenZeppelin. Único portador del `GOVERNANCE_ROLE` en producción.

## Treasury

Cofre multi-activo de la DAO. Recibe el 40% de la fee del protocolo (≈ 1% del GMV) para opex, además de colateral slasheado y otros activos. Sólo libera fondos vía propuesta (`onlyRole(GOVERNANCE_ROLE)`). **Importante:** el respaldo USDC del PSM está segregado — no es parte del Treasury y no existe función para moverlo. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## Vesting

Liberación gradual de GOV a un beneficiario del equipo a lo largo del tiempo, con cliff + lineal. Una instancia de `TeamVesting` por miembro. Ver [TeamVesting](../08-contracts-reference/11-TeamVesting.md).

## Voting delay / period

Parámetros del Governor en **bloques**:

- `votingDelay` = bloques entre `propose` y la apertura de la votación. Producción: 7200 (~1 día a 12s/bloque).
- `votingPeriod` = duración de la votación. Producción: 50400 (~7 días).

Ambos ajustables vía `onlyGovernance` (propuesta + ejecución por el Timelock).

## Weight (peso de staking)

`amount * multiplier(lockDuration) / 1e18`. En el modelo vigente, `ProjectFunding` lo consulta en vivo (`Staking.getWeight(investor, projectId) > 0`) como gate de `invest` y `claim`. Las views históricas (`getWeightAt`, etc.) permanecen para los claims legados.

---

**Siguiente ->** [Itinerarios de lectura](04-reading-paths.md)
