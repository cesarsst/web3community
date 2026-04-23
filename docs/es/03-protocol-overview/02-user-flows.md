# Flujos de usuario

**Audiencia:** dev o usuario tratando de entender lo que pasa de punta a punta en cada accion tipica.
**Requisitos previos:** [Arquitectura](01-architecture.md).

Cada diagrama abajo es un flujo end-to-end. Flecha simple = llamada de funcion. `|=>` = transicion de estado implicita.

## Flujo 1 — Usuario paga en una app

Actor: **Charlie** (usuario final). Tiene 1000 CREDIT y quiere usar ChatApp, cuyo `projectId = 42`.

```
Charlie.wallet
     |
     | 1. approve(feeRouter, 1000 CREDIT)
     v
CreditToken  |=> allowance[charlie][feeRouter] = 1000
     |
     | 2. app UI construye tx:
     |    feeRouter.pay(42, charlie, 1000)
     |    (tx puede ser firmada por Charlie o por un relayer
     |     que paga el gas; el usuario economico es siempre `charlie`)
     v
FeeRouter.pay(projectId=42, user=charlie, amount=1000)
     |
     | Check: registry.isActive(42)
     | Check: user != 0, amount > 0
     |
     | 3. pull CREDIT
     | CREDIT.safeTransferFrom(charlie, router, 1000)
     |
     | 4. calcula split default = (9500, 0, 500)
     |    burned = 950, toTreasury = 0, toApp = 50
     |
     | 5. resuelve recipient = registry.getProject(42).owner
     |    (o appRecipient[42] si esta seteado)
     |
     | 6. paga rebate
     | CREDIT.safeTransfer(recipient, 50)
     |
     | 7. dispara burn
     | CREDIT.forceApprove(burnTracker, 950)
     | BurnTracker.burnAndRecord(42, router, 950)
     |        |
     |        | check: registry.isActive(42)
     |        | check: acumulado + 950 <= sanityCap
     |        |
     |        | 8. actualiza storage del tracker
     |        | burnByRoundProject[R][42] += 950
     |        | totalBurnByRound[R]       += 950
     |        | projectsWithBurnCount[R]  += 1 (se 1a vez)
     |        |
     |        | 9. quema
     |        | CREDIT.burnByRole(router, 950, "burnTracker")
     |        |        |
     |        |        | _burn(router, 950) => totalSupply -= 950
     |        |        v
     |        +-------- BurnedByRole event
     |
     |  Paid event emitted
```

**Efectos post-tx:**

- Supply de CREDIT cayo en 950.
- `appOwner.balance += 50` en CREDIT.
- `burnByRoundProject[R][42] += 950` on-chain.
- Charlie `|=>` puede usar el servicio del ChatApp (logica del app, fuera del protocolo).

## Flujo 2 — Staker abre posicion en un proyecto

Actor: **Alice**, tiene 50.000 GOV y quiere stakear por 1 año en el `projectId = 42`.

```
Alice.wallet
     |
     | 1. approve(staking, 50_000 GOV)
     v
GovernanceToken  |=> allowance[alice][staking] = 50_000

     | 2. Alice elige lockDuration = 365 dias
     | multiplier esperado = 4x (satura en MAX_LOCK)
     |
     v
Staking.stake(projectId=42, amount=50_000 GOV, lockDuration=31_536_000)
     |
     | Check: amount > 0
     | Check: lockDuration >= MIN_LOCK (14 dias)
     | Check: REGISTRY.isActive(42)
     |
     | 3. Si no existia posicion:
     |    positions[alice][42] = { amount=50_000, lockStartAt=now, lockDuration=365d }
     |
     | 4. Actualiza agregados
     | totalStakedByProject[42] += 50_000
     | totalStaked              += 50_000
     |
     | 5. Calcula peso
     | weight = 50_000 * 4e18 / 1e18 = 200_000
     |
     | 6. Escribe 3 checkpoints en block.number
     | _userWeight[alice][42].push(block.number, 200_000)
     | _projectWeight[42].push(block.number, oldProjectW - 0 + 200_000)
     | _globalWeightCheckpoints.push(block.number, oldGlobalW - 0 + 200_000)
     |
     | 7. Pull GOV
     | GOV.safeTransferFrom(alice, staking, 50_000)
     |
     +-------- Staked event emitted
```

**Efectos post-tx:**

- Alice inmovilizo 50k GOV por 365 dias.
- El peso total del `projectId=42` subio en 200k.
- El peso global subio en 200k.
- Alice no puede `unstake` hasta `now + 365 dias` (excepto si el proyecto pasa a `Removed`).

## Flujo 3 — Staker reclama reward

Actor: **Alice**, ya stakeo y la ronda `R=5` fue finalizada.

```
Alice.wallet
     |
     | (opcional: preview)
     | rewardDistributor.previewClaim(alice, 5, 42) -> 3421.7 CREDIT
     |
     | 1. claim
     v
RewardDistributor.claim(round=5, projectId=42)
     |
     | Check: roundData[5].finalized = true
     | Check: !claimed[5][42][alice]
     |
     | 2. _calculateClaim
     |
     |    share = _projectShare(5, 42):
     |      - totalEmission = roundData[5].totalEmission = 905_000 CREDIT
     |      - si totalBurnAtFinalize > 0:
     |          burnDelProyecto = burnByRoundProject[4][42] = 600_000
     |          totalBurn       = totalBurnByRound[4]       = 950_000
     |          share = 905_000 * 600_000 / 950_000 = 571_578 CREDIT
     |      - isInProbation(42)? (false - proyecto tiene > 30 dias)
     |    share = 571_578
     |
     |    userWeight    = staking.getWeightAt(alice, 42, snapshotBlock_5) = 200_000
     |    projectWeight = staking.getTotalWeightAt(42, snapshotBlock_5)   = 400_000
     |
     |    amount = 571_578 * 200_000 / 400_000 = 285_789 CREDIT
     |
     | 3. claimed[5][42][alice] = true
     |
     | 4. Claimed event
     |
     | 5. CREDIT.mint(alice, 285_789, "rewardRound")
     |            |
     |            | requiere MINTER_ROLE
     |            | (RewardDistributor lo tiene)
     |            v
     |    totalSupply += 285_789
     |    balance[alice] += 285_789
     v
alice recibe 285_789 CREDIT
```

## Flujo 4 — La DAO lista un proyecto nuevo

Actor: **El equipo de ChatApp** quiere listar `ChatApp` como `projectId` nuevo.

```
0. ChatApp team tiene 10_000+ GOV

1. ChatApp team prepara metadata off-chain
   - IPFS upload de JSON { name, description, icon, contracts, ... }
   - recibe CID: ipfs://Qm...

2. alguien con threshold (10k GOV delegados) propone en el Governor:
   targets   = [registry]
   calldatas = [registry.registerProject.encode(chatAppOwner, "ipfs://Qm...", 10_000e18)]

3. Votacion (1d delay + 7d period)
   Si gana con quorum 4% y For > Against:

4. Governor.queue() -> Timelock.schedule(...)
5. ChatApp team llama GOV.approve(registry, 10_000)
   (antes de la ejecucion; puede hacerse en cualquier momento)

6. Tras minDelay (2d), cualquiera llama Timelock.execute(...)
   -> registry.registerProject(chatAppOwner, "ipfs://Qm...", 10_000e18)
        |
        | Check: GOVERNANCE_ROLE (Timelock lo tiene)
        | Check: colateral >= minCollateral (10k)
        | Check: allowance >= 10k
        |
        | projectId = 42 (_nextProjectId++)
        | graba proyecto como Pending
        | GOV.safeTransferFrom(chatAppOwner, registry, 10_000)

   |=> Proyecto existe como Pending, colateral lockeado

7. Segunda propuesta (puede ir en la misma batch):
   registry.activateProject(42)
   burnTracker.grantRole(RECORDER_ROLE, feeRouter)
     (si FeeRouter aun no lo tiene; en v1 ya lo tiene desde el deploy)

8. Tras aprobacion + delay:
   |=> projectId=42 queda Active
   |=> probationEndsAt = now + 30 dias
   |=> feeRouter.pay(42, ...) passa a funcionar
```

A partir de ahi el ChatApp puede aceptar pagos. Durante los proximos 30 dias, su share de rewards se divide por 4 (probation inicial).

## Flujo 5 — Unstake despues del lock

Actor: **Alice**, stakeo 50k GOV con lock de 365 dias, ya pasaron 366 dias.

```
Alice.wallet
     |
     | 1. unstake (o unstakeAll)
     v
Staking.unstake(projectId=42, amount=50_000)
     |
     | Check: amount > 0
     | Check: positions[alice][42].amount > 0
     | Check: amount <= position.amount
     |
     | 2. verifica lock
     | projectRemoved = REGISTRY.getProject(42).status == Removed  // false
     | unlockAt = lockStartAt + lockDuration
     | si !projectRemoved && block.timestamp < unlockAt:
     |     revert LockNotExpired
     | (aqui block.timestamp = lockStartAt + 366d, ya paso)
     |
     | 3. Effects
     | remaining = 50_000 - 50_000 = 0
     | delete positions[alice][42]
     | totalStakedByProject[42] -= 50_000
     | totalStaked              -= 50_000
     |
     | 4. checkpoint con newUserWeight = 0
     | _userWeight[alice][42].push(block.number, 0)
     | _projectWeight[42].push(block.number, oldP - 200_000 + 0)
     | _globalWeightCheckpoints.push(block.number, oldG - 200_000)
     |
     | 5. GOV.safeTransfer(alice, 50_000)
     v
     +-------- Unstaked event (sin EarlyUnstakeAllowed porque lock expiro)
```

## Flujo 6 — La ronda cierra y es finalizada

Actor: **la gobernanza** (via propuesta) y despues **cualquiera**.

```
Estado pre-close: BurnTracker.currentRound = 5, roundStartedAt = timestamp antiguo

1. Propuesta aprobada:
   BurnTracker.closeRound()
       |
       | only GOVERNANCE_ROLE (Timelock lo tiene)
       |
       | earlyClose = now < roundStartedAt + roundDuration?
       | totalBurn = totalBurnByRound[5]
       | projectsCount = projectsWithBurnCount[5]
       |
       | currentRound = 6
       | roundStartedAt = now
       v
       +-- RoundClosed event

Estado: BurnTracker.currentRound = 6.
        Datos de R=5 siguen accesibles via views.

2. Cualquiera (Alice, bot, etc) llama:
   RewardDistributor.finalizeRound(5)
       |
       | Check: !roundData[5].finalized
       | Check: expected = 5 (lastFinalizedRound + 1)
       | Check: BurnTracker.currentRound() = 6 > 5
       |
       | totalBurnPrev = BurnTracker.getTotalBurnForRound(4) = 950_000
       | alphaBurn = 950_000 * 0.95e18 / 1e18 = 902_500
       | floorAmount = floorSchedule[5] = 316_666 (declinando)
       | rawEmission = max(902_500, 316_666) = 902_500
       | totalEmission = min(902_500, capMax=5_000_000) = 902_500
       |
       | snapshotBlock = block.number
       |
       | roundData[5] = { 902_500, 950_000, snapshotBlock, true }
       | lastFinalizedRound = 5
       | isFirstRoundFinalized = true
       v
       +-- RoundFinalized event

Estado: stakers podem agora chamar claim(5, projectId).
```

---

**Siguiente →** [Flujo de valor](03-economic-flows.md)
