# Distribución de rewards

**Para quién es:** stakers, LPs, owners de apps y devs que quieren entender exactamente cómo el pool de una ronda se vuelve claim/incentive.
**Prerrequisitos:** [Directed staking](02-directed-staking.md), [Burn-to-mint](03-burn-to-mint.md).

## Dónde estamos: V1 (legado) -> V2 (bucket-aware split)

Esta página describe el modelo **V2** (Fase 1.4 del pivote CLP), en producción a partir de abril/2026. El modelo V1 (pre-pivote) sigue funcionando en modo claim-only durante una ventana de migración de 4 rondas — para detalles ver [RewardDistributor (V1)](../08-contracts-reference/07-RewardDistributor.md). El pre-requisito de la Fase 1.4 en el lado de los fees está satisfecho: el split default del `FeeRouter` en producción es **`70/20/10`** (`burnBps=7000, treasuryBps=2000, rebateBps=1000` en `ignition/parameters/production.json`), dando al Treasury ingreso recurrente en CREDIT.

V2 reescribe la finalización de ronda para **dividir la emisión en 4 buckets simultáneos**:

| Bucket | Default | Destino | Mecanismo |
|---|---|---|---|
| **Stakers** | 55% | quien hizo stake direccionado en algún proyecto | pull (`claim`) |
| **LPs** | 25% | quien hizo LP en el par CREDIT/USDC y stakeó en el [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md) | push al gauge (`notifyRewardAmount`) |
| **Apps** | 15% | `ownerRecipient` de cada proyecto, proporcional al burn de la ronda anterior | push (mint directo) |
| **Bonders** | 5% | refill earmarkado del POL en el Treasury (Fase 3 se vuelve `BondDepository`) | push (`Treasury.depositPolRefill`) |

La fórmula de emisión TOTAL es la misma del V1: `min(max(alpha × burn_{R-1}, floor(R)), capMax)`. El split en buckets se aplica **después** del cap (IE3 fortalecida — ningún bucket excede `bucketBps[i] × capMax`).

Bounds individuales por bucket (E.8 del parecer 2026-04-24-clp-pivot.md):

- `stakers >= 30%`
- `LPs >= 5%`
- `apps <= 25%` (IE4b — anti auto-extracción vía wash burn)
- `bonders <= 20%` (Olympus mostró que > 20% destrababa ponzi)
- suma exacta 10000 bps.

## Ciclo completo de una ronda (V2)

```
[Ronda R-1 abierta en BurnTracker]

Usuarios pagan en apps via FeeRouter
  -> FeeRouter.burnByRole burnBps% del valor via BurnTracker.burnAndRecord
  -> BurnTracker incrementa:
       burnByRoundProject[R-1][projectId] += amount
       totalBurnByRound[R-1]              += amount

[Fin de la ventana objetivo de la ronda (roundDuration)]

Gobernanza llama closeRound()
  -> currentRound pasa de R-1 a R

[Cualquiera llama RewardDistributorV2.finalizeRound(R-1)]
  -> totalEmission = min(max(alpha * burn_{R-2}, floor(R-1)), capMax)
  -> SPLIT en 4 buckets (proporcion bucketBps), bonders absorbe residuo:
       stakersAmount = totalEmission * 5500 / 10000
       lpsAmount     = totalEmission * 2500 / 10000
       appsAmount    = totalEmission * 1500 / 10000
       bondersAmount = totalEmission - stakers - lps - apps

  Push a 3 buckets (en la misma tx):
    APPS:  loop sobre proyectos con burn > 0:
             share = appsAmount * burn_p / totalBurnPrev
             CREDIT.mint(REGISTRY.ownerRecipient(p), share, "rewardRound:apps")
    LPS:   si gauge no paused:
             CREDIT.mint(self, lpsAmount)
             gauge.notifyRewardAmount(poolId, lpsAmount, duration)
           si paused:
             CREDIT.mint(treasury, lpsAmount)
             treasury.depositPendingGaugeRewards(lpsAmount)
    BONDERS: CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
             treasury.depositPolRefill(bondersAmount)

  Stakers: NO se mintea aqui (lazy via claim)

  -> escribe roundData[R-1] + bucketEmissionByRound[R-1][i]
  -> assert IE12: suma de los 4 buckets == totalEmission (tolerancia 3 wei)

[Stakers llaman claim(R-1, projectId)]
  -> base del calculo: bucketEmissionByRound[R-1][BUCKET_STAKERS]
  -> projectShare = base * burnProyecto / totalBurn  (o via globalWeight en bootstrap)
  -> userAmount = projectShare * userWeight / projectWeight
  -> CREDIT.mint(user, userAmount, "rewardRoundV2:stakers")

[LPs retiran via LiquidityGauge.harvest(user, maxAmount)]
  -> staker oficial Uniswap distribuye in-range proporcionalmente
  -> unstake() crea VestingPosition de 14 dias lineal
  -> harvest jala fraccion ya vested

[Owners de apps reciben automaticamente en ownerRecipient]
  -> nada que hacer — el mint ocurre en finalizeRound

[Bonders no existen en la Fase 1 — bucket se vuelve refill POL]
  -> Treasury.polRefillBucket acumula
  -> gobernanza drena via addPOLFromRefill (propuesta DAO)
```

Nota importante: **la ronda R-1 sólo puede ser `finalizeRound`-ada después de que el `BurnTracker` haya cerrado la R-1**, aunque aún no haya cerrado R. La secuencialidad es:

- `closeRound` incrementa `currentRound`. Por lo tanto, para finalizar la ronda X, se requiere `BURN_TRACKER.currentRound() > X`.
- `finalizeRound` exige orden estricto: primero R=0, luego R=1, después R=2... no se puede saltar.

## Cómo se calcula la share del bucket stakers de un proyecto (V2)

En `RewardDistributorV2._projectStakerShare(round, projectId)`:

**Base del cálculo**: `stakersBase = bucketEmissionByRound[round][BUCKET_STAKERS]` — ya no es `totalEmission`.

**Si hubo burn en la ronda:**

```
projectShare = stakersBase * burnDelProyectoEnRonda / totalBurnDeRonda
```

**Si no hubo burn (bootstrap):**

```
projectShare = stakersBase * weightDelProyectoEnSnapshot / weightGlobalEnSnapshot
```

**Y en cualquier caso:**

```
si isInProbation(projectId):
    projectShare = projectShare / 4
```

El 75% recortado por probation **nunca se mintea** — no se redistribuye y `CreditToken.totalSupply()` **no se ve afectado**. Es simplemente `projectShare` dividido por 4 antes del mint.

## Cómo se calcula el claim de un usuario (bucket stakers)

En `RewardDistributorV2._calculateClaim(user, round, projectId)`:

```
share = _projectStakerShare(round, projectId)
userWeight    = Staking.getWeightAt(user, projectId, snapshotBlock)
projectWeight = Staking.getTotalWeightAt(projectId, snapshotBlock)

amount = share * userWeight / projectWeight
```

Si `userWeight == 0` o `share == 0`, retorna 0 sin side effects — el usuario puede reintentar más tarde si el estado cambió.

## Cómo distribuye el bucket apps

En `finalizeRound`, V2 itera `pid in 1..totalProjects`:

```
para cada proyecto p:
    burnP = BURN_TRACKER.getBurnForProjectInRound(round - 1, p)
    si burnP == 0: salta
    appShare = appsAmount * burnP / totalBurnPrev
    si appShare == 0: salta
    recipient = REGISTRY.ownerRecipient(p)
    si recipient == address(0): salta  (proyecto Removed/inexistente — share evapora)
    CREDIT.mint(recipient, appShare, "rewardRound:apps")
```

**Bootstrap** (`totalBurnPrev == 0`): el bucket apps NO emite — bonders absorbe. Sin burn, no hay señal económica para distribuir entre apps.

**Recipient con timelock 48h**: `ownerRecipient(p)` retorna el explícito seteado vía `proposeOwnerRecipient` + `applyOwnerRecipient` (timelock 48h), o cae a `project.owner` como fallback cuando no hay recipient explícito. Ver [ProjectRegistry](../08-contracts-reference/03-ProjectRegistry.md).

## Cómo distribuye el bucket LPs

En `finalizeRound`, V2 detecta el estado del gauge:

- **Gauge activo**: `CREDIT.mint(self, lpsAmount)` + `forceApprove(gauge, lpsAmount)` + `gauge.notifyRewardAmount(poolId, lpsAmount, duration)`. Crea una incentive nueva de `gaugeIncentiveDuration` segundos (default 7 días).
- **Gauge paused**: fallback a `Treasury.depositPendingGaugeRewards(lpsAmount)` + emite `GaugePauseFallback`. Sin fallback, pausar el gauge trabaría la finalización de la ronda entera.

Los LPs retiran vía `LiquidityGauge.harvest(user, maxAmount)` — el staker oficial Uniswap distribuye proporcionalmente al tiempo in-range (`secondsInsideX128`). Después del `unstake`, los rewards entran en vesting lineal de 14 días.

## Cómo el bucket bonders alimenta el POL

En `finalizeRound`, V2 mintea `bondersAmount` directo al Treasury y llama `Treasury.depositPolRefill(bondersAmount)`. Esto sólo **acumula en el ledger interno** `polRefillBucket` — todavía no mueve tokens al pool.

Cuando la gobernanza decide refilar el POL, propone `addPOLFromRefill(creditAmount, usdcAmount, ...)` en el Treasury. El contrato:

1. Debita `creditAmount` del `polRefillBucket` (CEI).
2. Casa con `usdcAmount` del balance libre del Treasury (proveniente de `treasuryBps` del FeeRouter).
3. Llama `NPM.increaseLiquidity` (o `mint` en la primera vez).

La Fase 3 del roadmap CLP recicla este bucket en un `BondDepository` — los usuarios cambian ETH/CREDIT por CREDIT vested y el protocolo acumula POL vía bonds. Por ahora, el bucket sostiene el POL directamente.

## Pull-based — vos jalás tus rewards

No hay push automático. Si stakeaste y se cerraron rondas, **nada ocurre hasta que llames `claim`**. Esto es intencional:

- Evita explosión de gas en rondas con miles de stakers.
- Delega el costo de gas a quien se beneficia (el staker).
- Permite claim en batch vía `claimMany(rounds[], projectIds[])` — pagás una tx y cobrás N rondas × N proyectos.

Consecuencia: si te olvidás de hacer claim por varias rondas, **el derecho persiste**. No hay deadline. El único "costo" es que el CREDIT se acuña sólo cuando lo solicitás, no inmediatamente.

## El snapshotBlock y por qué importa

Cuando alguien llama `finalizeRound(R)`, el contrato escribe `snapshotBlock = block.number`. Toda consulta de peso subsiguiente en el claim usa **ese** bloque, no el actual. Resultado: aunque hayas stakeado después del finalize, tu peso en esa ronda es cero.

Es el análogo del `getPastVotes` de la gobernanza ERC20Votes — protección anti-flashloan aplicada a la dimensión de staking.

## Probation — qué necesitás saber como staker

Si stakeaste en un proyecto que está en probation inicial:

- Tu share de emisión se divide por 4 durante la ventana.
- La ventana se mide en timestamp, no en rondas.
- Después de `probationEndsAt`, la penalidad desaparece automáticamente (no requiere acción de nadie).

Si el proyecto entra en **Probation punitiva** (status `Probation` en el Registry), la penalidad no se aplica directamente vía RewardDistributor, pero:

- Stakes nuevos se bloquean (`Staking.stake` reverte con `ProjectNotActive`).
- Pagos nuevos se bloquean (`FeeRouter.pay` reverte).
- Aún podés **unstake** — el lock **no** se bypassa, pero no quedás impedido de salir cuando expire.

> **Escenario acumulativo — Probation punitiva de largo plazo.** Los stakers en proyecto `Probation` punitiva quedan presos hasta que expire el lock **incluso sin recibir emisiones** (si no hay burn del proyecto, `share = 0`; la penalidad `/ 4` no aplica aquí porque el proyecto no está en `isInProbation` inicial — pero tampoco hay share porque no hay burn y el proyecto no puede recibir pagos). Para mitigar, la DAO puede proponer `removeProject` terminal, que bypassa el lock. **Buena práctica de la DAO: evitar Probation punitiva de largo plazo.** Preferir `removeProject(slash=true)` terminal (con bypass de lock para stakers) o `reactivate` rápido cuando la causa pueda resolverse. Dejar el proyecto congelado en Probation es penalizar al staker por una falla del app/gobernanza.

Si el proyecto entra en **Removed** (terminal):

- El lock se bypassa — podés unstake inmediatamente.
- Las emisiones futuras para ese proyecto son cero (status `Removed` nunca es `isInProbation` y deja de contar en `globalWeight` después de que todos los stakes salgan).

## Edge cases

**Ronda sin burn y sin staking global**: la emisión ocurre (vía floor), pero ningún claim funciona — `globalWeight == 0` y `_projectShare` retorna 0 en el camino bootstrap. No se acuña CREDIT; el "pool" simplemente no se aloca.

**Ronda con burn total > 0 pero sin burn en tu proyecto**: tu proyecto recibe share 0, tu claim es 0. Si querías captura, deberías haber stakeado en un proyecto que generó burn.

**Stakeaste entre close y finalize**: tu peso sólo se cuenta a partir del bloque del próximo `finalizeRound`. Para la ronda actual, `getWeightAt(vos, proyecto, snapshotBlock)` retorna el peso que tenías en el bloque del finalize anterior (o 0 si no tenías).

**Claim duplicado**: `claimed[round][projectId][user]` se marca `true` tras el primer claim con `amount > 0`. Intentos de reclaim revierten con `AlreadyClaimed`. Un claim con `amount == 0` **no** marca claimed — podés reintentar.

---

**Siguiente ->** [Gobernanza](05-governance.md)
