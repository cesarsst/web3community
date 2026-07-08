# Flujos de usuario

**Audiencia:** dev o usuario tratando de entender lo que pasa de punta a punta en cada accion tipica.
**Requisitos previos:** [Arquitectura](01-architecture.md).

Cada diagrama abajo es un flujo end-to-end del **modelo vigente (remodel 2026-07-08)**. Flecha simple = llamada de funcion. `|=>` = transicion de estado implicita. Los flujos del modelo legado (burn en pagos, claim de emisión, cierre de rondas contables) están en las páginas de contratos marcadas como legado.

## Flujo 1 — Usuario compra CREDIT en el PSM

Actor: **Charlie** (usuario final). Tiene 1000 USDC y quiere saldo para usar apps.

```
Charlie.wallet
     |
     | 1. approve(psm, 1000e6 USDC)
     v
USDC  |=> allowance[charlie][psm] = 1000e6
     |
     | 2. psm.buy(1000e6)
     v
CreditPSM.buy(usdcAmount=1000e6)
     |
     | Check: usdcAmount > 0
     |
     | 3. creditOut = 1000e6 * SCALE(1e12) = 1000e18
     |
     | 4. USDC.safeTransferFrom(charlie, psm, 1000e6)
     |    mintedOutstanding += 1000e18
     |    CREDIT.mint(charlie, 1000e18, "psm:buy")
     |
     +-------- Bought(charlie, 1000e6, 1000e18)
```

**Efectos post-tx:** Charlie tiene 1000 CREDIT; el PSM retiene 1000 USDC como respaldo. Sin fee, sin slippage. El camino inverso es `sell(creditAmount)` — quema el CREDIT y devuelve USDC 1:1 (el monto debe ser múltiplo de `1e12`; el polvo revierte con `DustAmount` en vez de confiscarse).

## Flujo 2 — Usuario paga en una app

Actor: **Charlie**. Tiene 1000 CREDIT y quiere usar ChatApp (`projectId = 42`), que tiene una ronda financiada con rev-share de 8%.

```
Charlie.wallet
     |
     | 1. approve(feeRouterV2, 1000e18 CREDIT)
     v
CreditToken  |=> allowance[charlie][routerV2] = 1000e18
     |
     | 2. feeRouterV2.pay(42, 1000e18)
     |    (el payer economico es msg.sender — sin parametro `user` como en V1)
     v
FeeRouterV2.pay(projectId=42, amount=1000e18)
     |
     | Check: amount > 0
     | Check: registry.isActive(42)
     |
     | 3. pull CREDIT
     | CREDIT.safeTransferFrom(charlie, router, 1000)
     |
     | 4. fee del protocolo: feeBps = 250 (2,5%)
     |    fee        = 1000 * 2,5%  = 25
     |    toTreasury = 25 * 40%     = 10    (40% de la fee)
     |    toBuyback  = 25 * 40%     = 10    (40% de la fee — buyback de GOV)
     |    toGrants   = 25 - 10 - 10 = 5     (residuo -> grants)
     |
     | 5. rev-share del proyecto
     |    revShare = 1000 * funding.revShareBpsOf(42) = 1000 * 8% = 80
     |    (0 si el proyecto nunca tuvo ronda Funded)
     |
     | 6. resto para la app
     |    toApp = 1000 - 25 - 80 = 895   (~89,5%; seria 975 = 97,5% sin rev-share)
     |
     | 7. transferencias (misma tx):
     | CREDIT.safeTransfer(treasuryRecipient, 10)
     | CREDIT.safeTransfer(buybackRecipient, 10)
     | CREDIT.safeTransfer(grantsRecipient, 5)
     | CREDIT.safeTransfer(projectFunding, 80)
     |        + funding.notifyRevenue(42, 80)   // acumula pro-rata a los inversores
     | CREDIT.safeTransfer(appRecipient(42), 895)  // fallback: owner del Registry
     |
     | 8. grossVolumeOf[42] += 1000   (metrica on-chain para inversores)
     |
     +-------- PaymentRouted(42, charlie, 1000, 10, 10, 5, 80, 895)
```

**Efectos post-tx:**

- La app recibió 895 CREDIT **al instante** (no hay claim ni espera de ronda).
- Los inversores de la ronda acumularon 80 CREDIT pro-rata (retirables vía `claim`).
- El supply de CREDIT **no cambió** — nada se quema en un pago.
- Charlie `|=>` puede usar el servicio del ChatApp (lógica de la app, fuera del protocolo).

## Flujo 3 — Staker abre posicion en un proyecto

Actor: **Alice**, tiene 50.000 GOV y quiere stakear por 1 año en el `projectId = 42` — requisito para poder invertir en la ronda del proyecto.

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
     | 4. Actualiza agregados + checkpoints (peso = 50_000 * 4 = 200_000)
     |
     | 5. GOV.safeTransferFrom(alice, staking, 50_000)
     |
     +-------- Staked event emitted
```

**Efectos post-tx:**

- Alice inmovilizo 50k GOV por 365 dias.
- `staking.getWeight(alice, 42) > 0` |=> Alice **puede invertir** en la ronda del proyecto 42 y reclamar rev-share.
- Alice no puede `unstake` hasta `now + 365 dias` (excepto si el proyecto pasa a `Removed`).

En el modelo vigente el stake **no genera emisión** — es señal de compromiso y llave de inversión.

## Flujo 4 — Dueño abre ronda y Alice invierte

Actores: **el equipo de ChatApp** (dueño del proyecto 42) y **Alice** (staker del flujo 3).

```
1. Dueño abre la ronda (una unica por proyecto):
   ProjectFunding.openRound(42, target=10_000e18, revShareBps=800, duration=30 days)
       |
       | Check: REGISTRY.isActive(42) y msg.sender == owner
       | Check: rounds[42].status == None      (nunca abrio antes)
       | Check: 100 <= revShareBps <= 3000     (1% a 30%)
       | Check: target >= minTarget (100e18 default)
       | Check: 1 day <= duration <= 90 days
       |
       | rounds[42] = { target: 10_000, raised: 0,
       |                deadline: now+30d, revShareBps: 800, status: Open }
       +-- RoundOpened(42, 10_000e18, 800, deadline)

2. Alice invierte (necesita GOV stakeado en el 42):
   CREDIT.approve(funding, 4_000e18)
   ProjectFunding.invest(42, 4_000e18)
       |
       | Check: status == Open && now <= deadline
       | Check: staking.getWeight(alice, 42) > 0   // sin stake -> NoGovStaked
       | Check: amount <= target - raised          // no puede pasar el alvo
       |
       | raised += 4_000 ; sharesOf[42][alice] += 4_000
       | CREDIT.safeTransferFrom(alice, funding, 4_000)
       +-- Invested(42, alice, 4_000, 4_000)

3. Otros inversores completan el alvo (raised == target = 10_000):
       |
       | _fund(42):  status = Funded
       | CREDIT.safeTransfer(chatAppOwner, 10_000)   // capital anticipado, integro
       +-- RoundFunded(42, 10_000, chatAppOwner)

   |=> revShareBpsOf(42) pasa a retornar 800 (8%)
   |=> cada pago futuro via FeeRouterV2 descuenta 8% para los inversores

   -- o, si el plazo vence sin alcanzar el alvo --

3'. Cualquiera llama closeExpiredRound(42)  ->  status = Failed
    Alice llama refund(42)                  ->  recupera sus 4_000 CREDIT (100%)
```

**All-or-nothing**: el dueño solo recibe si el alvo se alcanza al 100%; no existe captación parcial.

## Flujo 5 — Inversor reclama receita (rev-share)

Actor: **Alice**, invirtió 4.000 de los 10.000 CREDIT de la ronda (40% de las shares). Desde el `Funded`, ChatApp procesó 50.000 CREDIT en pagos.

```
Receita acumulada del proyecto: 50_000 * 8% = 4_000 CREDIT
(acreditada pago a pago via notifyRevenue -> accRevenuePerShare)

Alice.wallet
     |
     | (opcional: preview)
     | funding.pendingRevenue(42, alice) -> 1_600 CREDIT   (40% de 4_000)
     |
     | 1. claim
     v
ProjectFunding.claim(42)
     |
     | Check: staking.getWeight(alice, 42) > 0
     |        // exige GOV AUN stakeado en el proyecto (skin in the game).
     |        // Sin stake el valor NO se pierde: queda acumulado hasta re-stake.
     |
     | 2. amount = sharesOf * accRevenuePerShare / 1e18 - rewardDebt = 1_600
     | 3. actualiza rewardDebt (patron MasterChef)
     | 4. CREDIT.safeTransfer(alice, 1_600)
     |
     +-------- RevenueClaimed(42, alice, 1_600)
```

El derecho de claim **nunca expira**. La receita es CREDIT ya transferido al contrato por el router — no hay mint.

## Flujo 6 — La DAO lista un proyecto nuevo

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
        |
        | projectId = 42 (_nextProjectId++)
        | graba proyecto como Pending
        | GOV.safeTransferFrom(chatAppOwner, registry, 10_000)

   |=> Proyecto existe como Pending, colateral lockeado

7. Segunda propuesta (puede ir en la misma batch):
   registry.activateProject(42)

8. Tras aprobacion + delay:
   |=> projectId=42 queda Active
   |=> feeRouterV2.pay(42, ...) pasa a funcionar
   |=> el dueño puede abrir su ronda de captacion (openRound)
   |=> (opcional) feeRouterV2.setAppRecipient(42, walletOperacional) — solo el owner
```

En el modelo vigente no hay `RECORDER_ROLE` que conceder: el `FeeRouterV2` no quema ni registra burn — solo exige que el proyecto esté `Active`.

## Flujo 7 — Unstake despues del lock

Actor: **Alice**, stakeo 50k GOV con lock de 365 dias, ya pasaron 366 dias.

```
Alice.wallet
     |
     | 1. unstake (o unstakeAll)
     v
Staking.unstake(projectId=42, amount=50_000)
     |
     | Check: amount > 0 y <= position.amount
     |
     | 2. verifica lock
     | projectRemoved = REGISTRY.getProject(42).status == Removed  // false
     | unlockAt = lockStartAt + lockDuration
     | si !projectRemoved && block.timestamp < unlockAt:
     |     revert LockNotExpired
     | (aqui block.timestamp = lockStartAt + 366d, ya paso)
     |
     | 3. Effects: delete position, agregados y checkpoints a 0
     |
     | 4. GOV.safeTransfer(alice, 50_000)
     v
     +-------- Unstaked event
```

**Atención**: tras el unstake, `getWeight(alice, 42) == 0` — Alice pierde el gate de `claim` en `ProjectFunding`. Su receita pendiente **no se pierde**: queda acumulada y vuelve a ser reclamable si re-stakea en el proyecto. Lo prudente es `claim` **antes** de `unstake`.

---

**Siguiente →** [Flujo de valor](03-economic-flows.md)
