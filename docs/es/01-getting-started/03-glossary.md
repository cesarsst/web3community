# Glosario

**Audiencia:** cualquier lector que se tope con un término extraño en otra página.
**Requisitos previos:** ninguno.

Términos usados en las otras páginas. Definiciones basadas en el código, no en convenciones externas.

## Alpha (α)

Factor multiplicador de la fórmula de emisión en [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md). Aplicado al burn de la ronda anterior. En producción `950000000000000000` (= 0.95 en precisión 1e18). Ajustable vía gobernanza dentro de los bounds `[MIN_ALPHA=0.5e18, MAX_ALPHA=1.1e18]`.

## Burn (quema)

Decremento permanente del `totalSupply` de CREDIT vía `_burn` nativo del ERC-20. Ocurre cuando un usuario paga en una app y el `FeeRouter` reenvía la porción de `burnBps` al `BurnTracker.burnAndRecord`, que a su vez llama a `CreditToken.burnByRole`.

## BurnTracker

Oráculo interno on-chain que contabiliza el burn por `(ronda, projectId)`. Consumido por el `RewardDistributor` para calcular el share de cada proyecto. Ver [BurnTracker](../08-contracts-reference/06-BurnTracker.md).

## Cap (de supply)

Límite máximo de tokens que pueden existir. GOV tiene un cap **inmutable** de 100M. CREDIT no tiene cap hardcodeado — su inflación es controlada por el `RewardDistributor` vía `capMax` por ronda (ajustable vía gobernanza).

## Checkpoint (anti-flashloan)

Historiografía on-chain de pesos de staking por bloque. `Staking` escribe checkpoints en cada cambio; `RewardDistributor` lee en el `snapshotBlock` de la ronda (block.number de cuándo se llamó a `finalizeRound`). Impide que alguien stakee en el mismo bloque de una consulta para capturar share artificialmente.

## CREDIT

Token utilitario ERC-20 quemable del protocolo. Supply elástico. Usado para pagar dentro de las apps del ecosistema. Acuñado como reward para los stakers vía `RewardDistributor`. Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## DAO (Decentralized Autonomous Organization)

Aquí se refiere al conjunto `CommunityGovernor` + `CommunityTimelock`, que juntos controlan **todos** los contratos económicos del protocolo en producción.

## FeeRouter

Contrato que recibe pagos en CREDIT de los usuarios, divide según `split` (default 95% burn / 0% treasury / 5% rebate a la app) y distribuye cada porción a su destino. Ver [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

## Finalize (de ronda)

Acción permissionless de congelar la emisión calculada para una ronda — graba `RoundData` inmutable (totalEmission, totalBurnAtFinalize, snapshotBlock). Después de eso, los stakers pueden reclamar. Función: `RewardDistributor.finalizeRound(round)`.

## Floor schedule

Array inmutable de 24 valores en `RewardDistributor`. `floorSchedule[R]` es el piso de emisión de la ronda R. En producción decae linealmente de 400.000 CREDIT (ronda 0) a ~16.666 CREDIT (ronda 23). Rondas >= 24 no tienen floor.

## Genesis mint

Acuñación inicial única de CREDIT (10M en producción) hecha una sola vez vía `CreditToken.mintGenesis(to, amount)`. El flag one-shot `genesisMinted` bloquea llamadas posteriores. Destinatario en producción: `Treasury`.

## GOV

Token de gobernanza ERC-20 con extensión `ERC20Votes`. Supply cap inmutable de 100M. Usado para votar (vía `getPastVotes`) y como colateral de staking. Ver [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md).

## GOVERNANCE_ROLE

Rol AccessControl concedido en producción **solo** al `CommunityTimelock`. Gate en todas las funciones sensibles a gobernanza de los contratos económicos (Treasury, ProjectRegistry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy).

## Lock (de staking)

Tiempo (en segundos) durante el cual una posición de stake no puede deshacerse. Rango permitido: `[MIN_LOCK=14 dias, cualquier tiempo]`. El multiplier satura en 4x a partir de `MAX_LOCK=365 dias`.

## Multiplier (de staking)

Factor aplicado al `amount` para calcular peso. Lineal de 1x (14 días) a 4x (365 días), satura en 4x por arriba. Definido en `Staking._multiplier(lockDuration)`.

## Probation

Dos nociones distintas en `ProjectRegistry`:

- **Probation inicial por tiempo**: ventana automática aplicada a todo proyecto recién activado, durante `probationDuration` (30 días en producción). El stake y los pagos funcionan normalmente, pero el **share de rewards se divide por 4** (25%). Detectada vía `isInProbation(projectId)`.
- **Probation punitiva**: estado del enum `Project.Status`. La gobernanza mueve manualmente un proyecto de `Active` a `Probation` por mala conducta. Bloquea stake nuevo y pagos, pero **nunca bloquea el unstake**.

## Proposal (propuesta)

Objeto del Governor con `(targets, values, calldatas, descriptionHash)`. Pasa por los estados Pending → Active → Succeeded/Defeated → Queued → Executed (o Canceled/Expired). Solo ejecutable vía Timelock después de todos los delays.

## Rebate

Porción (default 5%) de un pago en CREDIT que el FeeRouter transfiere al `appRecipient` del proyecto. Es como la app captura caja operacional.

## Recorder (RECORDER_ROLE)

Rol en el `BurnTracker` concedido a cada app listada (típicamente al `FeeRouter`). Autoriza la llamada `burnAndRecord`. Concedido vía propuesta aprobada en el Governor.

## Round / Ronda

Período de tiempo contable del protocolo. Iniciado en `BurnTracker` (`currentRound`). Abierto indefinidamente hasta que la gobernanza llame a `closeRound()`, que incrementa `currentRound` y resetea `roundStartedAt`. Duración objetivo en producción: 7 días (`roundDuration = 604800`).

## Sanity cap

Límite máximo de burn por `(ronda, projectId)` en el `BurnTracker`. En producción `10_000_000e18` CREDIT. Previene ataque en que un proyecto queme volumen absurdo para capturar share desproporcionado. Valor 0 = desactivado (opt-out explícito por gobernanza).

## Snapshot (de voto)

Bloque de referencia para calcular voting power de una propuesta. `Governor` usa `getPastVotes(account, proposalSnapshot)`; `RewardDistributor` usa `getWeightAt(user, projectId, snapshotBlock)`. Ambos inmunes a flash-loans que muevan tokens en el mismo bloque.

## Split

Configuración `(burnBps, treasuryBps, rebateBps)` en el `FeeRouter` que suma exactamente 10_000 bps = 100%. Default global 9500/0/500. Puede ser reemplazada por proyecto vía `setProjectSplit` (gobernanza) o por hora vía `setAppRecipient` (owner del proyecto solo para el recipient del rebate).

## Staking (dirigido)

Acto de bloquear GOV en un `projectId` específico del Registry. Define peso = `amount * multiplier(lockDuration) / 1e18`. El peso alimenta el share de rewards. Ver [Staking](../08-contracts-reference/05-Staking.md).

## Timelock

Contrato que ejecuta decisiones del Governor con atraso mínimo (`minDelay`, en producción 2 días). `CommunityTimelock` es una subclase trivial del `TimelockController` de OpenZeppelin. Único portador de `GOVERNANCE_ROLE` en producción.

## Treasury

Cofre multi-activo de la DAO. Recibe pasivamente (transferencias ERC-20 directas) y solo libera fondos vía una función `onlyRole(GOVERNANCE_ROLE)`. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## Vesting

Liberación gradual de GOV para un beneficiario del equipo a lo largo del tiempo, con cliff + lineal. Una instancia de `TeamVesting` por miembro. Ver [TeamVesting](../08-contracts-reference/11-TeamVesting.md).

## Voting delay / period

Parámetros del Governor en **bloques**:

- `votingDelay` = bloques entre `propose` y apertura de la votación. En producción 7200 (~1 día a 12s/bloque).
- `votingPeriod` = duración de la votación. En producción 50400 (~7 días).

Ambos ajustables vía `onlyGovernance` (propuesta + ejecución por el Timelock).

## Weight (peso de staking)

`amount * multiplier(lockDuration) / 1e18`. Leído con snapshot histórico vía `Staking.getWeightAt` / `Staking.getTotalWeightAt` / `Staking.getGlobalWeightAt`.

---

**Siguiente →** [Rutas de lectura](04-reading-paths.md)
