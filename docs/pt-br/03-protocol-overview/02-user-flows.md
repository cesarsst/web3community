# Fluxos de usuário

**Para quem é:** dev ou usuário tentando entender o que acontece de ponta a ponta em cada ação típica.
**Pré-requisitos:** [Arquitetura](01-architecture.md).

Cada diagrama abaixo é um fluxo end-to-end. Seta simples = chamada de função. `|=>` = transição de estado implícita.

> **Remodel 2026-07-08**: os fluxos 1, 1b e 1c descrevem o trilho vigente (PSM → pay → fee/rev-share/app → claim). Os fluxos marcados como **legado** descrevem o ciclo burn-to-mint pré-remodel, mantido deployado por compatibilidade histórica.

## Fluxo 1 — Usuário compra CREDIT e paga em um app

Ator: **Charlie** (usuário final). Ele tem 1000 USDC e quer usar o ChatApp, cujo `projectId = 42`. O ChatApp captou uma rodada com rev-share de 8%.

```
Charlie.wallet (1000 USDC)
     |
     | 1. approve(psm, 1000 USDC)
     | 2. CreditPSM.buy(1000e6)
     |       |
     |       | USDC.safeTransferFrom(charlie, psm, 1000e6)
     |       | mintedOutstanding += 1000e18
     |       | CREDIT.mint(charlie, 1000e18, "psm:buy")
     |       v
     |       +-- Bought event  |=> Charlie tem 1000 CREDIT (1:1)
     |
     | 3. approve(feeRouterV2, 1000 CREDIT)
     | 4. FeeRouterV2.pay(projectId=42, amount=1000)
     v
FeeRouterV2.pay(42, 1000)
     |
     | Check: registry.isActive(42)
     | Check: amount > 0
     |
     | 5. puxa CREDIT
     | CREDIT.safeTransferFrom(charlie, router, 1000)
     |
     | 6. fee do protocolo: 1000 * 250 / 10000 = 25 CREDIT (2,5%)
     |    split da fee (4000/4000/2000):
     |      toTreasury = 10   (40% da fee = 1,0% do pagamento)
     |      toBuyback  = 10   (40% da fee = 1,0% do pagamento)
     |      toGrants   =  5   (residuo -> grants; 0,5% do pagamento)
     |
     | 7. rev-share: 1000 * FUNDING.revShareBpsOf(42)=800 / 10000 = 80
     |    CREDIT.safeTransfer(funding, 80)
     |    FUNDING.notifyRevenue(42, 80)
     |        |
     |        | accRevenuePerShare[42] += 80e18 * 1e18 / raised
     |        | totalRevenueDistributed[42] += 80
     |        v
     |        +-- RevenueNotified event
     |
     | 8. resto pro app, NA HORA:
     |    toApp = 1000 - 25 - 80 = 895 (89,5%)
     |    recipient = appRecipientOf[42] (ou owner do Registry)
     |    CREDIT.safeTransfer(recipient, 895)
     |
     | 9. grossVolumeOf[42] += 1000
     v
     +-------- PaymentRouted(42, charlie, 1000, 10, 10, 5, 80, 895)
```

**Efeitos pós-tx:**

- Nenhum CREDIT queimado — supply estável, lastro do PSM inalterado.
- `appOwner.balance += 895` em CREDIT (sem rodada de funding seriam 975 = 97,5%).
- Treasury +10, buyback de GOV +10, grants +5.
- Investidores da rodada do ChatApp têm +80 acruados pro-rata (sacáveis via `claim`).
- `grossVolumeOf[42] += 1000` — GMV on-chain do projeto.
- Charlie `|=>` pode usar o serviço do ChatApp (lógica do app, fora do protocolo).

## Fluxo 1b — Dono capta uma rodada de funding

Ator: **ChatApp team** (dono do `projectId = 42`, Active) quer capital antecipado; **Alice** e **Bob** têm GOV stakeado no ChatApp.

```
ChatAppOwner.wallet
     |
     | 1. ProjectFunding.openRound(42, target=10_000 CREDIT,
     |                             revShareBps=800 (8%), duration=30 dias)
     |       |
     |       | Check: registry.isActive(42) + owner
     |       | Check: rounds[42].status == None (UMA rodada por projeto)
     |       | Check: 100 <= 800 <= 3000 bps
     |       | Check: target >= minTarget (100 CREDIT default)
     |       | Check: 1 dia <= duration <= 90 dias
     |       v
     |       +-- RoundOpened(42, 10_000, 800, deadline)
     |
Alice (GOV stakeado no 42)
     | 2. approve + ProjectFunding.invest(42, 6_000)
     |       | Check: STAKING.getWeight(alice, 42) > 0   <- gate
     |       | sharesOf[42][alice] = 6_000
     |       +-- Invested(42, alice, 6_000, 6_000)
     |
Bob (GOV stakeado no 42)
     | 3. approve + ProjectFunding.invest(42, 4_000)
     |       | raised = 10_000 == target -> finaliza AUTOMATICAMENTE
     |       | status = Funded
     |       | CREDIT.safeTransfer(chatAppOwner, 10_000)
     |       +-- Invested + RoundFunded(42, 10_000, chatAppOwner)
     v
|=> Dono recebeu 10_000 CREDIT de capital antecipado.
|=> revShareBpsOf(42) = 800 -> todo pay() passa a descontar 8%.

(Cenario alternativo: prazo vence com raised < target
   -> qualquer um chama closeExpiredRound(42)  |=> Failed
   -> cada investidor chama refund(42) e recebe 100% de volta.)
```

## Fluxo 1c — Investidor saca receita (claim)

Ator: **Alice**, investiu 6.000 dos 10.000 CREDIT da rodada (60% das shares). O ChatApp já processou 50.000 CREDIT de GMV desde o funding.

```
Alice.wallet
     |
     | (opcional: preview)
     | funding.pendingRevenue(42, alice) -> 2_400 CREDIT
     |   (rev-share acumulado = 8% * 50_000 = 4_000; Alice = 60%)
     |
     | 1. ProjectFunding.claim(42)
     v
ProjectFunding.claim(42)
     |
     | Check: STAKING.getWeight(alice, 42) > 0
     |   (skin in the game: precisa MANTER GOV stakeado;
     |    sem stake o valor NAO expira - fica acruado ate re-stake)
     |
     | 2. amount = sharesOf * accRevenuePerShare - rewardDebt = 2_400
     | 3. atualiza rewardDebt (checkpoint MasterChef)
     | 4. CREDIT.safeTransfer(alice, 2_400)
     v
     +-------- RevenueClaimed(42, alice, 2_400)

|=> Alice pode segurar o CREDIT (estavel) ou resgatar USDC no PSM (sell 1:1).
```

## Fluxo 1-legado — Usuário paga em um app (burn-to-mint, pré-remodel)

> ⚠️ **LEGADO** — fluxo do FeeRouter V1 com split 70/20/10 e burn via BurnTracker. Detalhes na página [FeeRouter (V1)](../08-contracts-reference/08-FeeRouter.md). Resumo: `pay` puxava 1000 CREDIT, queimava 700 (`BurnTracker.burnAndRecord` → `burnByRole`), mandava 200 ao Treasury e 100 de rebate ao app. O burn alimentava a emissão da rodada seguinte no RewardDistributor.

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
- **Com peso > 0 no projeto, Alice pode `invest` na rodada de funding do 42 e `claim` rev-share** (Fluxos 1b e 1c) — o stake é o gate de investimento do remodel.

## Fluxo 3 — Staker reivindica reward de emissão (legado)

> ⚠️ **LEGADO** — claims de rodadas antigas do `RewardDistributorV2` continuam funcionando (direito nunca expira), mas não há novas rodadas de emissão desde o remodel 2026-07-08. A renda vigente do investidor é o rev-share do Fluxo 1c.

Ator: **Alice**, já stakou e rodada `R=5` foi finalizada.

```
Alice.wallet
     |
     | (opcional: preview)
     | rewardDistributorV2.previewClaim(alice, 5, 42) -> 156_750 CREDIT
     |
     | 1. claim
     v
RewardDistributorV2.claim(round=5, projectId=42)
     |
     | Check: roundData[5].finalized = true
     | Check: !claimed[5][42][alice]
     |
     | 2. _calculateClaim
     |
     |    share = _projectStakerShare(5, 42):
     |      - base = bucketEmissionByRound[5][STAKERS]
     |             = 55% * totalEmission (902_500) = 496_375 CREDIT
     |      - se totalBurnAtFinalize > 0:
     |          burnDoProjeto = burnByRoundProject[4][42] = 600_000
     |          totalBurn     = totalBurnByRound[4]       = 950_000
     |          share = 496_375 * 600_000 / 950_000 = 313_500 CREDIT
     |      - isInProbation(42)? (false - projeto tem > 30 dias de idade)
     |    share = 313_500
     |
     |    userWeight    = staking.getWeightAt(alice, 42, snapshotBlock_5) = 200_000
     |    projectWeight = staking.getTotalWeightAt(42, snapshotBlock_5)   = 400_000
     |
     |    amount = 313_500 * 200_000 / 400_000 = 156_750 CREDIT
     |
     | 3. claimed[5][42][alice] = true
     |
     | 4. Claimed event
     |
     | 5. CREDIT.mint(alice, 156_750, "rewardRoundV2:stakers")
     |            |
     |            | precisa de MINTER_ROLE
     |            | (RewardDistributorV2 tem)
     |            v
     |    totalSupply += 156_750
     |    balance[alice] += 156_750
     v
alice recebe 156_750 CREDIT
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
   |=> feeRouterV2.pay(42, ...) passa a funcionar
   |=> o dono ja pode abrir rodada no ProjectFunding (Fluxo 1b)
```

A partir daí o ChatApp pode aceitar pagamentos pelo FeeRouterV2 e abrir sua rodada de captação. (Legado: o passo de `RECORDER_ROLE` no BurnTracker e a penalidade de probation sobre share de rewards — dividido por 4 nos primeiros 30 dias — só afetam o trilho burn-to-mint antigo.)

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

## Fluxo 6 — Rodada de burn fecha e é finalizada (legado)

> ⚠️ **LEGADO** — o ciclo `closeRound`/`finalizeRound` pertence ao trilho burn-to-mint pré-remodel. Sem burn novo (o FeeRouterV2 não queima), não há emissão nova a finalizar.

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
   RewardDistributorV2.finalizeRound(5)
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
       | split bucketBps = [5500, 2500, 1500, 500]:
       |   stakers = 55% = 496_375  (lazy — mintado so no claim)
       |   lps     = 25% = 225_625  (mint + notify no LiquidityGauge;
       |                             fallback Treasury se gauge paused)
       |   apps    = 15% = 135_375  (mint direto p/ ownerRecipient(p),
       |                             proporcional ao burn de cada projeto em R=4)
       |   bonders =  5% =  45_125  (mint p/ Treasury + depositPolRefill)
       |
       | snapshotBlock = block.number
       |
       | roundData[5] = { 902_500, 950_000, snapshotBlock, true }
       | bucketEmissionByRound[5][0..3] gravado
       | lastFinalizedRound = 5
       | isFirstRoundFinalized = true
       v
       +-- RoundFinalizedV2 event (+ BucketEmissionMinted por bucket)

Estado: stakers podem agora chamar claim(5, projectId) — bucket stakers.
```

---

**Próximo →** [Fluxo de valor](03-economic-flows.md)
