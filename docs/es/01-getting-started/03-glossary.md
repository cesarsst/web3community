# Glosario

**Para quién es:** cualquier lector que se tope con un término extraño en otra página.
**Prerrequisitos:** ninguno.

Términos usados en las demás páginas. Definiciones basadas en el código, no en convención externa.

## Alpha (α)

Factor multiplicativo de la fórmula de emisión de [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md) / [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md). Aplicado al burn de la ronda anterior. En producción: `950000000000000000` (= 0.95 con precisión 1e18). Ajustable por gobernanza dentro de los bounds `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` — `MAX_ALPHA` se redujo de `1.1e18` para garantizar IE1 (α < 1 permanente) por construcción; ver `audit/economist/2026-04-22-consistency-audit.md` C2.

## Bonders

Cuarto bucket del `RewardDistributorV2` (default 5% de la emisión por ronda). En la Fase 1 del CLP, este bucket se vuelve un **refill earmarkado del POL** — `RewardDistributorV2` mintea CREDIT directo al Treasury, que acumula en el ledger `polRefillBucket`. En la Fase 3 será reciclado en un `BondDepository` (los usuarios cambian ETH/CREDIT por CREDIT vested, el protocolo acumula liquidez vía bonds).

## Bucket (split de emisión)

Una de las 4 porciones de la emisión V2: stakers (default 55%), LPs (25%), apps (15%), bonders (5%). Cada bucket tiene destino y mecanismo de distribución propios. Suma exacta de 10000 bps — ver [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md).

## Burn (quema)

Decremento permanente del `totalSupply` de CREDIT vía el `_burn` nativo del ERC-20. Ocurre cuando un usuario paga en una app y el `FeeRouter` envía la porción `burnBps` al `BurnTracker.burnAndRecord`, que a su vez llama a `CreditToken.burnByRole`.

## BurnTracker

Oráculo on-chain interno que contabiliza burn por `(ronda, projectId)`. Consumido por `RewardDistributor` para calcular la share de cada proyecto. Ver [BurnTracker](../08-contracts-reference/06-BurnTracker.md).

## Cap (de supply)

Límite máximo de tokens existentes. GOV tiene cap **inmutable** de 100M. CREDIT no tiene cap hardcoded — su inflación es controlada por `RewardDistributor` vía `capMax` por ronda (ajustable por gobernanza).

## Checkpoint (anti-flashloan)

Historial on-chain de pesos de staking por bloque. `Staking` escribe checkpoints en cada cambio; `RewardDistributor` lee en el `snapshotBlock` de la ronda (block.number cuando se llamó `finalizeRound`). Impide que alguien stakee en el mismo bloque de una consulta y capture share artificialmente.

## CLP (Credit Liquidity Protocol)

Pivote económico de abril/2026 (parecer `audit/economist/2026-04-24-clp-pivot.md`). Reorganiza el protocolo en cuatro fases:

- **1.1 — FFP buyback**: defensa del floor vía swap real USDC->CREDIT + quema.
- **1.2 — POL**: liquidez propia del protocolo en el pool CREDIT/USDC.
- **1.3 — LiquidityGauge**: incentiva LPs externos vía bucket dedicado (25% emisión).
- **1.4 — Bucket-aware split**: `RewardDistributorV2` divide la emisión en 4 buckets simultáneos.
- **3 (futuro)**: BondDepository — los usuarios cambian ETH/CREDIT por CREDIT vested.

## CREDIT

Token utilitario ERC-20 quemable del protocolo. Supply elástico. Usado para pagar dentro de las apps del ecosistema. Minteado como reward para stakers (lazy, vía claim) y como push directo para LPs/apps/bonders por `RewardDistributorV2`. Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## CreditPriceOracle

Adapter de producción del `ICreditPriceOracle` (`contracts/CreditPriceOracle.sol`). Deriva el TWAP del CREDIT en USD (18 decimales) del pool Uniswap V3 CREDIT/USDC y convierte USDC → USD vía feed Chainlink USDC/USD (staleness máxima 6h, banda de sanidad fija `[9900, 10100]` bps). Direcciones inmutables, seteadas en el constructor. Es la fuente de precio del `Treasury` en el FFP (`peekTwapPrice`).

## DAO (Decentralized Autonomous Organization)

Aquí: el conjunto `CommunityGovernor` + `CommunityTimelock`, que juntos controlan **todos** los contratos económicos del protocolo en producción.

## FFP (Floating con Floor Price)

Modelo de defensa de precio del CREDIT (Fase 1.1 CLP). El spot es libre por encima del floor (leído del `CreditPriceOracle` en producción); cuando spot < floor por >= 24h, la gobernanza puede proponer `Treasury.executeBuyback(usdcAmount, minCreditOut)` que ejecuta swap USDC->CREDIT vía Uniswap V3 y **quema** el CREDIT comprado inmediatamente. Floor calculado como `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)` — default `max(0.50 × MA90, $0.10)`. Caps por evento (20%) y mensual (30%) sobre las reservas USDC del Treasury. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## FeeRouter

Contrato que recibe pagos en CREDIT de los usuarios, divide según `split` (default de producción 70% burn / 20% treasury / 10% rebate a la app) y dirige cada porción a su destino. Ver [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

## Finalize (de ronda)

Acción permissionless de congelar la emisión calculada para una ronda — escribe `RoundData` inmutable (totalEmission, totalBurnAtFinalize, snapshotBlock). Después de eso, los stakers pueden reclamar. Función: `RewardDistributor.finalizeRound(round)`.

## Floor schedule

Array inmutable de 24 valores en `RewardDistributor`. `floorSchedule[R]` es el piso de emisión de la ronda R. En producción decae linealmente de 400.000 CREDIT (ronda 0) a ~16.666 CREDIT (ronda 23). Rondas >= 24 no tienen floor.

## Genesis mint

Acuñación inicial única de CREDIT (10M en producción) ejecutada exactamente una vez vía `CreditToken.mintGenesis(to, amount)`. La flag one-shot `genesisMinted` bloquea cualquier llamada subsiguiente. Destinatario en producción: `Treasury`.

## GOV

Token de gobernanza ERC-20 con la extensión `ERC20Votes`. Cap inmutable de supply de 100M. Usado para votar (vía `getPastVotes`) y como colateral de staking. Ver [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md).

## GOVERNANCE_ROLE

Rol AccessControl concedido en producción **únicamente** al `CommunityTimelock`. Gate de toda función gobernanza-sensible en los contratos económicos del protocolo (Treasury, ProjectRegistry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy).

## LiquidityGauge

Adapter sobre el `UniswapV3Staker` canónico (Uniswap Foundation) que distribuye el **bucket LPs** del `RewardDistributorV2` (default 25% de la emisión) a LPs externos del par CREDIT/USDC. El usuario stakea el NFT V3 en el gauge -> recibe CREDIT proporcional al tiempo in-range -> después del `unstake` el reward entra en vesting lineal de 14 días -> `harvest` retira lo vested. Ver [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md).

## Lock (de staking)

Tiempo (en segundos) durante el cual una posición de stake no puede deshacerse. Rango permitido: `[MIN_LOCK=14 días, cualquier tiempo]`. El multiplier satura en 4x a partir de `MAX_LOCK=365 días`.

## MA90

Promedio móvil de 90 días del precio del CREDIT en USD, mantenido en el ring buffer `dailyPrices[90]` del Treasury. Actualizado por `recordDailyPrice` (permissionless, cooldown 22h). Usado como referencia del floor relativo del FFP. Antes del bootstrap (90 muestras), `ma90Price()` retorna 0 y el floor cae a `floorAbsoluteUsd` solamente (default $0.10).

## Multiplier (de staking)

Factor aplicado al `amount` para calcular el peso. Lineal de 1x (14 días) a 4x (365 días), satura en 4x por encima. Definido en `Staking._multiplier(lockDuration)`.

## ownerRecipient

Dirección canónica (con timelock 48h) que recibe el bucket apps del `RewardDistributorV2`. Se setea vía `proposeOwnerRecipient(projectId, newRecipient)` (sólo owner) -> espera 48h -> `applyOwnerRecipient(projectId)` (permissionless). Fallback es `project.owner` cuando no hay recipient explícito seteado. Cancelable por el owner O por `GOVERNANCE_ROLE` (escape hatch). Ver [ProjectRegistry](../08-contracts-reference/03-ProjectRegistry.md).

## POL (Protocol-Owned Liquidity)

Liquidez propia del protocolo en el pool CREDIT/USDC 0.3%. NFT custodiado por el Treasury (slot `polTokenId`), rango full ticks (`-887220, 887220`). Provisionada vía `Treasury.addPOL` (seed) o `addPOLFromRefill` (drena bucket bonders + USDC del balance libre). Sin rebalance activo. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## Probation

Dos nociones distintas en el `ProjectRegistry`:

- **Probation inicial por tiempo**: ventana automática aplicada a todo proyecto recién activado, durante `probationDuration` (30 días en producción). Stake y pagos funcionan normalmente, pero **la share de rewards se divide por 4** (25%). Detectada vía `isInProbation(projectId)`.
- **Probation punitiva**: estado del enum `Project.Status`. La gobernanza mueve manualmente un proyecto de `Active` a `Probation` por mala conducta. Bloquea stake nuevo y pagos, pero **nunca bloquea unstake**.

## Proposal (propuesta)

Objeto del Governor que contiene `(targets, values, calldatas, descriptionHash)`. Pasa por estados Pending -> Active -> Succeeded/Defeated -> Queued -> Executed (o Canceled/Expired). Sólo ejecutable vía Timelock después de todos los delays.

## polRefillBucket

Ledger interno del Treasury que acumula el bucket bonders del `RewardDistributorV2` (5% default de la emisión por ronda). Drenado por `Treasury.addPOLFromRefill(creditAmount, usdcAmount, ...)` que casa CREDIT del ledger con USDC del balance libre para inyección en `polTokenId`. CEI: debita el ledger antes de la llamada externa (idempotencia en revert).

## Rebate

Porción (default 5%) de un pago en CREDIT que el FeeRouter transfiere al `appRecipient` del proyecto. Es como la app captura caja operacional.

## Recorder (RECORDER_ROLE)

Rol en el `BurnTracker` concedido a cada app listada (típicamente al `FeeRouter`). Autoriza la llamada `burnAndRecord`. Concedido vía propuesta aprobada en el Governor.

## Round / Ronda

Período de tiempo contable del protocolo. Iniciado en `BurnTracker` (`currentRound`). Abierto indefinidamente hasta que la gobernanza llame `closeRound()`, que incrementa `currentRound` y resetea `roundStartedAt`. Duración objetivo en producción: 7 días (`roundDuration = 604800`).

## RewardDistributorV2

Versión bucket-aware del distributor de emisión (Fase 1.4 CLP). Re-deploy paralelo al V1 — V1 queda en modo claim-only durante migración de 4 rondas. V2 divide la emisión en 4 buckets simultáneos: stakers (lazy), LPs (push gauge), apps (push retrospectivo vía burn), bonders (push refill POL). Ver [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md).

## Sanity cap

Límite máximo de burn por `(ronda, projectId)` en el `BurnTracker`. En producción `10_000_000e18` CREDIT. Previene un ataque en que un proyecto quema volumen absurdo para capturar share desproporcionado. Valor 0 = desactivado (opt-out explícito por gobernanza).

## Snapshot (de voto)

Bloque de referencia para calcular voting power de una propuesta. `Governor` usa `getPastVotes(account, proposalSnapshot)`; `RewardDistributor` usa `getWeightAt(user, projectId, snapshotBlock)`. Ambos inmunes a flash-loans que muevan tokens en el mismo bloque.

## Split

Configuración `(burnBps, treasuryBps, rebateBps)` en el `FeeRouter` que suma exactamente 10_000 bps = 100%. Default global en producción: 7000/2000/1000 (`ignition/parameters/production.json`). Puede ser sobrescrito por proyecto vía `setProjectSplit` (gobernanza) o por destinatario vía `setAppRecipient` (sólo owner del proyecto, para el destino del rebate).

## Staking (direccionado)

Acto de lockear GOV en un `projectId` específico del Registry. Define peso = `amount * multiplier(lockDuration) / 1e18`. El peso alimenta la share de rewards. Ver [Staking](../08-contracts-reference/05-Staking.md).

## Timelock

Contrato que ejecuta decisiones del Governor con un retraso mínimo (`minDelay`, en producción 2 días). `CommunityTimelock` es subclase trivial del `TimelockController` de OpenZeppelin. Único portador del `GOVERNANCE_ROLE` en producción.

## Treasury

Cofre multi-activo de la DAO. Recibe pasivamente (transferencias ERC-20 directas) y sólo libera fondos vía función `onlyRole(GOVERNANCE_ROLE)`. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## Vesting

Liberación gradual de GOV a un beneficiario del equipo a lo largo del tiempo, con cliff + lineal. Una instancia de `TeamVesting` por miembro. Ver [TeamVesting](../08-contracts-reference/11-TeamVesting.md).

## Voting delay / period

Parámetros del Governor en **bloques**:

- `votingDelay` = bloques entre `propose` y la apertura de la votación. Producción: 7200 (~1 día a 12s/bloque).
- `votingPeriod` = duración de la votación. Producción: 50400 (~7 días).

Ambos ajustables vía `onlyGovernance` (propuesta + ejecución por el Timelock).

## Weight (peso de staking)

`amount * multiplier(lockDuration) / 1e18`. Leído con snapshot histórico vía `Staking.getWeightAt` / `Staking.getTotalWeightAt` / `Staking.getGlobalWeightAt`.

---

**Siguiente ->** [Itinerarios de lectura](04-reading-paths.md)
