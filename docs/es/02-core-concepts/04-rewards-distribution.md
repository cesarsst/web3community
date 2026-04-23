# Distribución de rewards

**Audiencia:** stakers y devs que quieren entender exactamente cómo el pool de una ronda se convierte en claim del usuario.
**Requisitos previos:** [Directed staking](02-directed-staking.md), [Burn-to-mint](03-burn-to-mint.md).

## Ciclo completo de una ronda

```
[Ronda R-1 abierta en BurnTracker]

Usuarios pagan en apps via FeeRouter
  -> FeeRouter.burnByRole 95% del valor via BurnTracker.burnAndRecord
  -> BurnTracker incrementa:
       burnByRoundProject[R-1][projectId] += amount
       totalBurnByRound[R-1]              += amount
       projectsWithBurnCount[R-1]         += 1 (1a vez por proyecto)

[Fin de la ventana objetivo de la ronda (roundDuration)]

Gobernanza llama closeRound()
  -> currentRound pasa de R-1 a R
  -> roundStartedAt = block.timestamp (ronda R abierta)
  -> datos de R-1 siguen accesibles via views

[Cualquiera llama finalizeRound(R-1) en RewardDistributor]
  -> lee BurnTracker.getTotalBurnForRound(R-2)  (o 0 si R-1 == 0)
  -> calcula emision = min(max(alpha * burn_{R-2}, floor(R-1)), capMax)
  -> graba roundData[R-1] = { totalEmission, totalBurnAtFinalize, snapshotBlock, finalized: true }

[Stakers llaman claim(R-1, projectId)]
  -> si !finalized: revierte
  -> si ya reclamó: revierte
  -> calcula amount y acuña CREDIT via CREDIT.mint
```

Observación importante: **la ronda R-1 solo puede ser `finalizeRound`eada después de que el `BurnTracker` haya cerrado la R-1**, incluso si aún no cerró la R. La secuencialidad es:

- `closeRound` incrementa `currentRound`. Por lo tanto, para finalizar la ronda X, es necesario que `BURN_TRACKER.currentRound() > X`.
- `finalizeRound` exige orden estricto: primero R=0, después R=1, después R=2... No puede saltar.

## Cómo se calcula el share de un proyecto

En `RewardDistributor._projectShare(round, projectId)`:

**Si hubo burn en la ronda:**

```
projectShare = totalEmission * burnDelProyectoEnLaRonda / totalBurnDeLaRonda
```

**Si no hubo burn (bootstrap):**

```
projectShare = totalEmission * weightDelProyectoEnSnapshot / weightGlobalEnSnapshot
```

**Y en cualquier caso:**

```
si isInProbation(projectId):
    projectShare = projectShare / 4
```

El 75% cortado por la probation **no se redistribuye** — simplemente no entra en el `CREDIT.mint`.

## Cómo se calcula el claim de un usuario

En `RewardDistributor._calculateClaim(user, round, projectId)`:

```
share = _projectShare(round, projectId)
userWeight   = Staking.getWeightAt(user, projectId, snapshotBlock)
projectWeight = Staking.getTotalWeightAt(projectId, snapshotBlock)

amount = share * userWeight / projectWeight
```

Si `userWeight == 0` o `share == 0`, retorna 0 sin side effects — el usuario puede intentar de nuevo después si el estado cambia (raro, pero evita "quemar" el slot de claim por error).

## Pull-based — tú reclamas tus rewards

No hay push automático. Si stakeaste y se cerraron rondas, **no pasa nada hasta que llames a `claim`**. Es intencional:

- Evita gas explosion en rondas con miles de stakers.
- Delega el costo de gas a quien se beneficia (el staker).
- Permite claim en batch vía `claimMany(rounds[], projectIds[])` — pagas una tx y recolectas N rondas × N proyectos.

Consecuencia: si olvidas reclamar durante varias rondas, **el derecho persiste**. No hay deadline. El único "costo" es que el CREDIT se acuña solo cuando lo solicitas, no de inmediato.

## El snapshotBlock y por qué importa

Cuando alguien llama a `finalizeRound(R)`, el contrato graba `snapshotBlock = block.number`. Toda consulta de peso posterior en el claim usa **ese** bloque, no el actual. Resultado: aunque hayas stakeado después del finalize, tu peso en esa ronda es cero.

Eso es el análogo del `getPastVotes` de la gobernanza ERC20Votes — una protección anti-flashloan aplicada a la dimensión de staking.

## Probation — lo que necesitas saber como staker

Si stakeaste en un proyecto que está en probation inicial:

- Tu share de emisión queda dividido por 4 durante la ventana.
- La ventana se mide en timestamp, no en rondas.
- Tras `probationEndsAt`, la penalización desaparece automáticamente (no requiere acción de nadie).

Si el proyecto pasa a **Probation punitiva** (status `Probation` en el Registry), la penalización no se aplica directamente por el RewardDistributor, pero:

- Los nuevos stakes están bloqueados (`Staking.stake` revierte con `ProjectNotActive`).
- Los nuevos pagos están bloqueados (`FeeRouter.pay` revierte).
- Aún puedes **hacer unstake** — el lock **no** es bypasseado, pero no quedas impedido de salir cuando expire.

Si el proyecto pasa a **Removed** (terminal):

- El lock es bypasseado — puedes hacer unstake inmediatamente.
- Emisiones futuras para ese proyecto son cero (el status `Removed` nunca está `isInProbation` ni cuenta en `globalWeight` después de que todos los stakes salen).

## Edge cases

**Ronda sin burn y sin staking global**: la emisión ocurre (vía floor), pero ningún claim funciona — `globalWeight == 0` y `_projectShare` retorna 0 en el camino bootstrap. CREDIT no se acuña; el "pool" simplemente no se asigna.

**Ronda con burn total > 0 pero sin burn en tu proyecto**: tu proyecto recibe share 0, tu claim es 0. Si querías captura, necesitabas haber stakeado en un proyecto que generó burn.

**Stakeaste entre el close y el finalize**: tu peso solo se cuenta a partir del bloque del próximo `finalizeRound`. Para la ronda actual, `getWeightAt(tú, proyecto, snapshotBlock)` retorna el peso que tenías en el bloque del finalize anterior (o 0 si no tenías).

**Claim duplicado**: `claimed[round][projectId][user]` se marca `true` tras el primer claim con `amount > 0`. Un intento de reclaim revierte con `AlreadyClaimed`. Un claim con `amount == 0` **no** marca claimed — puedes intentar de nuevo.

---

**Siguiente →** [Gobernanza](05-governance.md)
