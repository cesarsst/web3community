# Directed staking

**Audiencia:** dev o staker que quiere entender cómo se calcula el peso de rewards.
**Requisitos previos:** [Dual-token](01-dual-token-economy.md).

## Qué significa "dirigido"

Cuando llamas a `Staking.stake(projectId, amount, lockDuration)`:

1. Eliges **un** `projectId` válido en el `ProjectRegistry` (el proyecto tiene que estar `Active`).
2. Transfieres `amount` de GOV al contrato `Staking`.
3. Asumes un lock (mínimo 14 días) durante el cual no puedes retirar.

Tu peso queda:

```
weight = amount * multiplier(lockDuration) / 1e18
```

donde `multiplier` es lineal entre 1x (14 días) y 4x (365 días), saturando en 4x por arriba. Ver `Staking._multiplier`.

**El peso solo cuenta para ese `projectId`.** Stake en otro proyecto = otra posición, otro peso, contabilidad independiente.

## Parámetros de lock

| Constante | Valor | Fuente |
|---|---|---|
| `MIN_LOCK` | 14 días | `Staking.MIN_LOCK` |
| `MAX_LOCK` | 365 días | `Staking.MAX_LOCK` |
| `MULTIPLIER_PRECISION` | 1e18 | `Staking.MULTIPLIER_PRECISION` |
| `MAX_MULTIPLIER` | 4e18 | `Staking.MAX_MULTIPLIER` |

Locks por encima de 365 días **son aceptados** — el multiplier satura en 4x, pero el tiempo real de lock se respeta en el `unstake`. Locks por debajo de 14 días revierten con `LockTooShort`.

## Consolidación de posición

Una posición se identifica por `(user, projectId)`. Solo puede haber **una** por par. Si llamas a `stake` en un par que ya tiene posición:

- `newAmount = old.amount + amount`
- `newLockDuration = max(remaining, lockDuration)` (el mayor entre lo que quedaba del lock antiguo y el nuevo lock pedido)
- `lockStartAt = block.timestamp` (**reset**)

El reset del `lockStartAt` es intencional. Sin él, un usuario podría ir extendiendo el peso indefinidamente con micro-stakes sin volver a comprometer el amount antiguo.

Si quieres **aumentar** el amount sin resetear el lock, usa `increaseStake(projectId, amount)` — preserva `lockStartAt` y `lockDuration` actuales.

Si quieres **extender** el lock sin tocar el amount, usa `extendLock(projectId, newLockDuration)` — siempre estrictamente mayor que el actual.

## Peso como snapshot

El peso se historiza en `Checkpoints.Trace208` (OpenZeppelin) con clave = `block.number` y valor = `uint208`. Tres rieles paralelos:

- **Por usuario-proyecto** (`_userWeight[user][projectId]`)
- **Por proyecto** (`_projectWeight[projectId]`) — suma de todos los usuarios
- **Global** (`_globalWeightCheckpoints`) — suma de todos los proyectos

Consultas:

- `getWeight(user, projectId)` — peso actual.
- `getWeightAt(user, projectId, blockNumber)` — peso histórico en el bloco X.
- `getTotalWeight(projectId)` — peso agregado actual del proyecto.
- `getTotalWeightAt(projectId, blockNumber)` — histórico.
- `getGlobalWeight()`, `getGlobalWeightAt(blockNumber)` — peso global.

El `RewardDistributor` **siempre** consulta `...At(block)` en el `snapshotBlock` de la ronda, nunca el valor actual. Esa es la protección anti-flashloan análoga a la de `ERC20Votes`.

## Unstake

Llamando a `unstake(projectId, amount)` o `unstakeAll(projectId)`:

- **Si el lock aún no expiró y el proyecto está `Active` o `Pending` o `Probation`**: revierte con `LockNotExpired`.
- **Si el lock expiró**: libera `amount` de vuelta al usuario, actualiza peso.
- **Excepción — el proyecto está `Removed`**: el lock es **bypasseado**. La DAO removió el proyecto; castigar al staker con lock sería injusto. Emite `EarlyUnstakeAllowed` + `Unstaked`.

La probation inicial por tiempo **no** bypassea el lock. La probation punitiva **no** bypassea el lock. Solo `Status.Removed` bypassea.

## Por qué dirigido y no genérico

Un staking genérico ("gano reward general") crea incentivo pasivo: stakeas, esperas, cosechas. La DAO necesita que alguien **seleccione activamente** qué proyectos merecen apoyo — ese alguien es el staker. Es casi una curaduría descentralizada:

```
   Staker elige proyectos que cree
   que van a generar burn (= uso)
                |
                v
   Peso queda atado al exito de ese proyecto
                |
                v
   Si el proyecto genera burn, el staker gana reward
   Si no genera, reward = cero para el

   => staker solo gana si eligio bien
```

El modelo castiga la mala asignación. Apoyar a todos "por igual" exige stakear en cada uno individualmente, lo que cuesta gas e inmoviliza capital en proporción.

## Cómo el peso se vuelve reward

Ver [Rewards distribution](04-rewards-distribution.md). En resumen: dentro de un `projectId`, la porción de emisión del proyecto se divide proporcionalmente al peso de cada staker en el `snapshotBlock` de la ronda.

---

**Siguiente →** [Burn-to-mint](03-burn-to-mint.md)
