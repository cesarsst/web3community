# Staking en proyectos

**Audiencia:** quien ya tiene GOV y quiere apoyar un proyecto — y habilitarse a invertir en su ronda.
**Requisitos previos:** [Directed staking (concepto)](../02-core-concepts/02-directed-staking.md), [Tener GOV](02-holding-gov.md).

> **⚠️ Actualización — remodel 2026-07-08.** Los pasos operacionales de stake/unstake de esta página siguen válidos. Lo que cambió es el **para qué**: el stake ya no genera rewards de emisión (legado) — es el requisito para invertir en la ronda del proyecto y reclamar rev-share vía [`ProjectFunding`](../08-contracts-reference/16-ProjectFunding.md). Los ejemplos con emisión/burn más abajo son del modelo anterior.

## El modelo mental en 3 líneas

1. Eliges **un** proyecto (`projectId`).
2. Bloqueas GOV por **14 a 365+ días** — multiplier 1x a 4x.
3. Rondas después, reclamas CREDIT proporcional al burn que ese proyecto generó × cuánto pesa tu stake dentro del proyecto.

## Eligiendo un proyecto

Antes de stakear, verifica en el Registry:

- Status = `Active` (los proyectos `Pending`/`Probation`/`Removed` bloquean stake nuevo).
- Edad del proyecto (si está en probation inicial por tiempo, el share es /4).
- Burn histórico en las últimas rondas (señal de tracción real).

Herramientas (vía UI del hub):

```solidity
// status
registry.getProject(projectId);            // struct completa
registry.isActive(projectId);              // bool
registry.isInProbation(projectId);         // probation inicial por tiempo

// burn historico
burnTracker.getBurnForProjectInRound(round, projectId);

// competencia
staking.getTotalWeight(projectId);         // cuanto peso ya tiene el proyecto
```

## Eligiendo el lock

Función en `Staking._multiplier`:

- `< 14 días`: revierte (`LockTooShort`).
- `14 días`: multiplier = 1x.
- `365 días`: multiplier = 4x.
- Entre 14 y 365 días: lineal.
- `> 365 días`: aceptado, multiplier satura en 4x (y el lock real se respeta).

```
  multiplier
       ^
   4x  |-----______________________
       |          _ _ _
   3x  |     ___-
       |   _-
   2x  | _-
       |_-
   1x  |
       +-------------------------------->  lockDuration
      14d                 365d
```

**Reglas de bolsillo:**

- Menor lock posible (14d, 1x): solo vale la pena si tienes certeza de salir pronto. APR efectivo bajo.
- Lock medio (90-180d, 1.6x–2.4x): flexibilidad vs peso, buen default.
- Lock máximo (365d, 4x): maximiza peso por GOV. Úsalo si confías en el proyecto por un año.
- Lock > 365d: no agrega peso, solo suma inmovilización. Raramente ventajoso a menos que quieras señalizar commitment extremo.

## La operación `stake`

```solidity
// Prerequisito: tienes GOV y ya aprobaste el Staking
GOV.approve(staking, amount);

// Staking
staking.stake(
    uint256 projectId,     // el proyecto elegido
    uint256 amount,        // wei de GOV
    uint64 lockDuration    // segundos, >= 14 dias
);
```

La función revierte si:

- `amount == 0` — `ZeroAmount`.
- `lockDuration < 14 days` — `LockTooShort`.
- El proyecto no está `Active` — `ProjectNotActive`.
- Allowance insuficiente — `ERC20InsufficientAllowance`.
- Balance insuficiente — `ERC20InsufficientBalance`.

En caso de éxito:

- GOV va al contrato Staking.
- `positions[you][projectId]` graba `{amount, lockStartAt=now, lockDuration}`.
- Tres checkpoints se escriben en `block.number`.
- El peso se calcula como `amount * multiplier(lockDuration) / 1e18`.

## Operaciones subsiguientes

### `increaseStake(projectId, amount)`

Aumenta el amount **sin resetear el lock**. `lockStartAt` y `lockDuration` quedan iguales.

Consecuencia: el peso aumenta proporcionalmente. Si el lock ya expiró, puedes inmediatamente llamar a `unstake` con el nuevo amount — el `increaseStake` no reabre el lock.

### `extendLock(projectId, newLockDuration)`

Aumenta el `lockDuration` (siempre estrictamente mayor que el actual). `lockStartAt` **no** cambia. Aumenta el peso.

Útil cuando tu lock está cerca de expirar y quieres extender la posición sin perder el peso.

### `stake` cuando ya hay posición (consolidación)

Si llamas a `stake` y ya tienes posición en `(user, projectId)`:

- `newAmount = old.amount + amount`.
- `newLockDuration = max(remaining, lockDuration)` — el mayor entre "lo que quedaba del lock antiguo" y "el nuevo lock pedido".
- **`lockStartAt` es reseteado** a `block.timestamp`.

Eso es diferente de `increaseStake` — `stake` resetea el lock. Elección consciente:

- `stake`: cuando quieres re-comprometer el tiempo.
- `increaseStake`: cuando solo quieres aumentar el principal.

## Unstake

```solidity
staking.unstake(projectId, amount);     // parcial
staking.unstakeAll(projectId);          // total
```

Condiciones:

- `amount > 0` y `amount <= position.amount`.
- **Lock expirado**: `block.timestamp >= lockStartAt + lockDuration`.
- **O el proyecto es `Removed`** — bypass del lock.

Si el lock aún está vigente y el proyecto no es `Removed`, revierte con `LockNotExpired`.

**Observación importante**: la probation punitiva (`Status.Probation`) **NO** bypassea el lock. Solo `Status.Removed` bypassea.

## Lo que ganas

Tras cada ronda R ser `finalizeRound`eada, puedes reclamar reward:

```
amount = projectShare(round, projectId)
       × tuPeso(round)
       ÷ pesoTotal(round)

projectShare = bucketStakers × burnDelProyectoEnR-1 ÷ burnTotalR-1
             (si no hubo burn: via peso global)

bucketStakers = 55% de la totalEmission en el split default del RewardDistributorV2
              (bucketBps[stakers] = 5500; el otro 45% va para LPs, apps
               y bonders — no pasan por el claim de staker)

Si el proyecto esta en probation inicial: projectShare /= 4.
```

La fórmula completa está en [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Simulación hipotética

Alice stakeó 50.000 GOV en el `projectId=42` con lock de 365 días (peso = 200k). El proyecto generó 600k de burn en la ronda R-1, el total de la ronda fue 950k, la emisión de la ronda R es 902.500 CREDIT (0,95 × 950k) — de los cuales el bucket stakers (55%) es lo que va al claim. El peso total en el proyecto (incluyendo a Alice) es 400k.

```
bucketStakers = 902_500 × 55% = 496_375 CREDIT
projectShare  = 496_375 × 600_000 / 950_000 = 313.500 CREDIT
aliceShare    = 313.500 × 200.000 / 400.000 = 156.750 CREDIT
```

Alice reclama 156.750 CREDIT en el round R. Si la ronda es semanal y mantiene la posición por un año con burn similar, captura ~8.15M CREDIT en 52 rondas (ilustrativo — la realidad depende de la dinámica del uso).

## Edge cases útiles

**Stake en más de un proyecto**: cada `projectId` es una posición independiente. Puedes stakear en 5 proyectos diferentes si tienes GOV suficiente.

**Emergency exit por Remoción**: si la DAO remueve el proyecto vía propuesta, tu lock es bypasseado. Emite evento `EarlyUnstakeAllowed` además de `Unstaked` — puedes retirar inmediatamente.

**Extend vs stake**: `extendLock` **no** cambia el amount. `stake` en una posición existente **suma al amount** y puede aumentar el lock. Úsalos según tu necesidad.

**El lock expiró y no retiraste**: tu posición aún genera peso con multiplier original. Si quieres parar de generar peso, haz `unstake` o `unstakeAll`. Ignorar simplemente = peso continúa acumulando.

---

**Siguiente →** [Votar en propuestas](04-voting.md)
