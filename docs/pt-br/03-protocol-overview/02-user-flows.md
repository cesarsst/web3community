# Fluxos de usuário

**Para quem é:** dev ou usuário tentando entender o que acontece de ponta a ponta em cada ação típica.
**Pré-requisitos:** [Arquitetura](01-architecture.md).

Cada diagrama abaixo é um fluxo end-to-end. Seta simples = chamada de função. `|=>` = transição de estado implícita.

## Fluxo 1 — Usuário paga em um app

Ator: **Charlie** (usuário final). Ele tem 1000 CREDIT e quer usar o ChatApp, cujo `projectId = 42`.

```
Charlie.wallet
     |
     | 1. approve(feeRouter, 1000 CREDIT)
     v
CreditToken  |=> allowance[charlie][feeRouter] = 1000
     |
     | 2. app UI constroi tx:
     |    feeRouter.pay(42, charlie, 1000)
     |    (tx pode ser assinada pelo Charlie ou por um relayer
     |     que paga o gas; usuario economico e sempre `charlie`)
     v
FeeRouter.pay(projectId=42, user=charlie, amount=1000)
     |
     | Check: registry.isActive(42)
     | Check: user != 0, amount > 0
     |
     | 3. puxa CREDIT
     | CREDIT.safeTransferFrom(charlie, router, 1000)
     |
     | 4. calcula split default = (9500, 0, 500)
     |    burned = 950, toTreasury = 0, toApp = 50
     |
     | 5. resolve recipient = registry.getProject(42).owner
     |    (ou appRecipient[42] se setado)
     |
     | 6. paga rebate
     | CREDIT.safeTransfer(recipient, 50)
     |
     | 7. aciona burn
     | CREDIT.forceApprove(burnTracker, 950)
     | BurnTracker.burnAndRecord(42, router, 950)
     |        |
     |        | check: registry.isActive(42)
     |        | check: acumulado + 950 <= sanityCap
     |        |
     |        | 8. atualiza storage do tracker
     |        | burnByRoundProject[R][42] += 950
     |        | totalBurnByRound[R]       += 950
     |        | projectsWithBurnCount[R]  += 1 (se 1a vez)
     |        |
     |        | 9. queima
     |        | CREDIT.burnByRole(router, 950, "burnTracker")
     |        |        |
     |        |        | _burn(router, 950) => totalSupply -= 950
     |        |        v
     |        +-------- BurnedByRole event
     |
     |  Paid event emitted
```

**Efeitos pós-tx:**

- Supply de CREDIT caiu em 950.
- `appOwner.balance += 50` em CREDIT.
- `burnByRoundProject[R][42] += 950` on-chain.
- Charlie `|=>` pode usar o serviço do ChatApp (lógica do app, fora do protocolo).

## Fluxo 2 — Staker abre posição em um projeto

Ator: **Alice**, tem 50.000 GOV e quer stakar por 1 ano no `projectId = 42`.

```
Alice.wallet
     |
     | 1. approve(staking, 50_000 GOV)
     v
GovernanceToken  |=> allowance[alice][staking] = 50_000

     | 2. Alice escolhe lockDuration = 365 dias
     | multiplier esperado = 4x (satura no MAX_LOCK)
     |
     v
Staking.stake(projectId=42, amount=50_000 GOV, lockDuration=31_536_000)
     |
     | Check: amount > 0
     | Check: lockDuration >= MIN_LOCK (14 dias)
     | Check: REGISTRY.isActive(42)
     |
     | 3. Se nao existia posicao:
     |    positions[alice][42] = { amount=50_000, lockStartAt=now, lockDuration=365d }
     |
     | 4. Atualiza agregados
     | totalStakedByProject[42] += 50_000
     | totalStaked              += 50_000
     |
     | 5. Calcula peso
     | weight = 50_000 * 4e18 / 1e18 = 200_000
     |
     | 6. Escreve 3 checkpoints em block.number
     | _userWeight[alice][42].push(block.number, 200_000)
     | _projectWeight[42].push(block.number, oldProjectW - 0 + 200_000)
     | _globalWeightCheckpoints.push(block.number, oldGlobalW - 0 + 200_000)
     |
     | 7. Puxa GOV
     | GOV.safeTransferFrom(alice, staking, 50_000)
     |
     +-------- Staked event emitted
```

**Efeitos pós-tx:**

- Alice imobilizou 50k GOV por 365 dias.
- Peso total do `projectId=42` subiu em 200k.
- Peso global subiu em 200k.
- Alice não pode `unstake` até `now + 365 dias` (exceto se projeto virar `Removed`).

## Fluxo 3 — Staker reivindica reward

Ator: **Alice**, já stakou e rodada `R=5` foi finalizada.

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
     |      - se totalBurnAtFinalize > 0:
     |          burnDoProjeto = burnByRoundProject[4][42] = 600_000
     |          totalBurn     = totalBurnByRound[4]       = 950_000
     |          share = 905_000 * 600_000 / 950_000 = 571_578 CREDIT
     |      - isInProbation(42)? (false - projeto tem > 30 dias de idade)
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
     |            | precisa de MINTER_ROLE
     |            | (RewardDistributor tem)
     |            v
     |    totalSupply += 285_789
     |    balance[alice] += 285_789
     v
alice recebe 285_789 CREDIT
```

## Fluxo 4 — DAO lista um projeto novo

Ator: **ChatApp team** quer listar `ChatApp` como `projectId` novo.

```
0. ChatApp team tem 10_000+ GOV

1. ChatApp team prepara metadata off-chain
   - IPFS upload de JSON { name, description, icon, contracts, ... }
   - recebe CID: ipfs://Qm...

2. alguem com threshold (10k GOV delegados) propoe no Governor:
   targets   = [registry]
   calldatas = [registry.registerProject.encode(chatAppOwner, "ipfs://Qm...", 10_000e18)]

3. Votacao (1d delay + 7d period)
   Se vence com quorum 4% e For > Against:

4. Governor.queue() -> Timelock.schedule(...)
5. ChatApp team chama GOV.approve(registry, 10_000)
   (antes da execucao; pode ser feito a qualquer momento)

6. Apos minDelay (2d), qualquer um chama Timelock.execute(...)
   -> registry.registerProject(chatAppOwner, "ipfs://Qm...", 10_000e18)
        |
        | Check: GOVERNANCE_ROLE (Timelock tem)
        | Check: colateral >= minCollateral (10k)
        | Check: allowance >= 10k
        |
        | projectId = 42 (_nextProjectId++)
        | grava projeto como Pending
        | GOV.safeTransferFrom(chatAppOwner, registry, 10_000)

   |=> Projeto existe como Pending, colateral lockado

7. Segunda proposta (pode estar na mesma batch):
   registry.activateProject(42)
   burnTracker.grantRole(RECORDER_ROLE, feeRouter)
     (se FeeRouter ainda nao tem; em v1 ja tem desde o deploy)

8. Apos aprovacao + delay:
   |=> projectId=42 fica Active
   |=> probationEndsAt = now + 30 dias
   |=> feeRouter.pay(42, ...) passa a funcionar
```

A partir daí o ChatApp pode aceitar pagamentos. Durante os próximos 30 dias, seu share de rewards é dividido por 4 (probation inicial).

## Fluxo 5 — Unstake após lock

Ator: **Alice**, stakou 50k GOV com lock de 365 dias, já se passaram 366 dias.

```
Alice.wallet
     |
     | 1. unstake (ou unstakeAll)
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
     | se !projectRemoved && block.timestamp < unlockAt:
     |     revert LockNotExpired
     | (aqui block.timestamp = lockStartAt + 366d, passou)
     |
     | 3. Effects
     | remaining = 50_000 - 50_000 = 0
     | delete positions[alice][42]
     | totalStakedByProject[42] -= 50_000
     | totalStaked              -= 50_000
     |
     | 4. checkpoint com newUserWeight = 0
     | _userWeight[alice][42].push(block.number, 0)
     | _projectWeight[42].push(block.number, oldP - 200_000 + 0)
     | _globalWeightCheckpoints.push(block.number, oldG - 200_000)
     |
     | 5. GOV.safeTransfer(alice, 50_000)
     v
     +-------- Unstaked event (sem EarlyUnstakeAllowed pq lock expirou)
```

## Fluxo 6 — Rodada fecha e é finalizada

Ator: **governança** (via proposta) e depois **qualquer um**.

```
Estado pre-close: BurnTracker.currentRound = 5, roundStartedAt = timestamp antigo

1. Proposal aprovada:
   BurnTracker.closeRound()
       |
       | only GOVERNANCE_ROLE (Timelock tem)
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
        Dados de R=5 continuam acessiveis via views.

2. Qualquer um (Alice, bot, etc) chama:
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

**Próximo →** [Fluxo de valor](03-economic-flows.md)
