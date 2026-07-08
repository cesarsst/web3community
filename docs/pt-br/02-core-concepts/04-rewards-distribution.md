# Distribuição de rewards

> ⚠️ **LEGADO — página inteira.** A distribuição por emissão (buckets 55/25/15/5 do `RewardDistributorV2`) foi **substituída no remodel 2026-07-08**. Os contratos seguem deployados para claims históricos, mas não há mais emissão nova: sem burn no trilho de pagamento (o [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) não queima), a fórmula α·burn não produz emissão.
>
> **A ponte para o modelo vigente**: a renda do investidor deixou de ser CREDIT emitido (inflação) e passou a ser **rev-share de receita real** — quem tem GOV stakeado num projeto pode investir CREDIT na rodada dele no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) (rev-share 1–30% da receita bruta, prazo 1–90 dias, all-or-nothing) e recebe pro-rata a cada pagamento roteado pelo FeeRouterV2. Claims nunca expiram. Comece por [Fluxo de valor](../03-protocol-overview/03-economic-flows.md) e [Sacando rev-share](../04-for-users/05-claiming-rewards.md).

**Para quem é:** stakers, LPs, owners de apps e devs querendo entender exatamente como o pool de uma rodada virava claim/incentive no modelo antigo.
**Pré-requisitos:** [Directed staking](02-directed-staking.md), [Burn-to-mint](03-burn-to-mint.md).

## Onde estávamos: V1 → V2 (bucket-aware split)

Esta página descreve o modelo **V2** (Fase 1.4 do pivot CLP), que esteve em produção a partir de abril/2026 até o remodel de 2026-07-08. O modelo V1 (pré-pivot) continua funcionando em modo claim-only durante uma janela de migração de 4 rounds — para detalhes ver [RewardDistributor (V1)](../08-contracts-reference/07-RewardDistributor.md). O pré-requisito da Fase 1.4 no lado dos fees estava satisfeito: o split default do `FeeRouter` V1 em produção era **`70/20/10`** (`burnBps=7000, treasuryBps=2000, rebateBps=1000` em `ignition/parameters/production.json`), dando ao Treasury receita recorrente em CREDIT.

O V2 reescreve a finalização de rodada para **dividir a emissão em 4 buckets** simultâneos:

| Bucket | Default | Destino | Mecanismo |
|---|---|---|---|
| **Stakers** | 55% | quem fez stake direcionado em algum projeto | pull (`claim`) |
| **LPs** | 25% | quem fez LP no par CREDIT/USDC e stakou no [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md) | push para o gauge (`notifyRewardAmount`) |
| **Apps** | 15% | `ownerRecipient` de cada projeto, proporcional ao burn da rodada anterior | push (mint direto) |
| **Bonders** | 5% | refill earmarkado do POL no Treasury (Fase 3 vira `BondDepository`) | push (`Treasury.depositPolRefill`) |

A fórmula da emissão TOTAL é a mesma do V1: `min(max(alpha × burn_{R-1}, floor(R)), capMax)`. O split em buckets é aplicado **depois** do cap (IE3 fortalecida — nenhum bucket excede `bucketBps[i] × capMax`).

Bounds individuais por bucket (E.8 do parecer 2026-04-24-clp-pivot.md):

- `stakers >= 30%`
- `LPs >= 5%`
- `apps <= 25%` (IE4b — anti auto-extração via wash burn)
- `bonders <= 20%` (Olympus mostrou que > 20% destrava ponzi)
- soma exata 10000 bps.

## Ciclo completo de uma rodada (V2)

```
[Rodada R-1 aberta no BurnTracker]

Usuarios pagam em apps via FeeRouter
  -> FeeRouter.burnByRole burnBps% do valor via BurnTracker.burnAndRecord
  -> BurnTracker incrementa:
       burnByRoundProject[R-1][projectId] += amount
       totalBurnByRound[R-1]              += amount

[Fim da janela alvo da rodada (roundDuration)]

Governanca chama closeRound()
  -> currentRound passa de R-1 para R

[Qualquer um chama RewardDistributorV2.finalizeRound(R-1)]
  -> totalEmission = min(max(alpha * burn_{R-2}, floor(R-1)), capMax)
  -> SPLIT em 4 buckets (proporcao bucketBps), bonders absorve residuo:
       stakersAmount = totalEmission * 5500 / 10000
       lpsAmount     = totalEmission * 2500 / 10000
       appsAmount    = totalEmission * 1500 / 10000
       bondersAmount = totalEmission - stakers - lps - apps

  Push para 3 buckets (na mesma tx):
    APPS:  loop em projetos com burn > 0:
             share = appsAmount * burn_p / totalBurnPrev
             CREDIT.mint(REGISTRY.ownerRecipient(p), share, "rewardRound:apps")
    LPS:   se gauge nao paused:
             CREDIT.mint(self, lpsAmount)
             gauge.notifyRewardAmount(poolId, lpsAmount, duration)
           se paused:
             CREDIT.mint(treasury, lpsAmount)
             treasury.depositPendingGaugeRewards(lpsAmount)
    BONDERS: CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
             treasury.depositPolRefill(bondersAmount)

  Stakers: NAO mint aqui (lazy via claim)

  -> grava roundData[R-1] + bucketEmissionByRound[R-1][i]
  -> assert IE12: soma dos 4 buckets == totalEmission (tolerancia 3 wei)

[Stakers chamam claim(R-1, projectId)]
  -> base do calculo: bucketEmissionByRound[R-1][BUCKET_STAKERS]
  -> projectShare = base * burnProjeto / totalBurn  (ou via globalWeight no bootstrap)
  -> userAmount = projectShare * userWeight / projectWeight
  -> CREDIT.mint(user, userAmount, "rewardRoundV2:stakers")

[LPs sacam via LiquidityGauge.harvest(user, maxAmount)]
  -> staker oficial Uniswap distribui in-range proporcionalmente
  -> unstake() cria VestingPosition de 14 dias linear
  -> harvest puxa fracao ja vestida

[Owners de apps recebem automaticamente em ownerRecipient]
  -> nada a fazer — o mint acontece em finalizeRound

[Bonders nao existem na Fase 1 — bucket vira refill POL]
  -> Treasury.polRefillBucket acumula
  -> governance dreina via addPOLFromRefill (proposta DAO)
```

Observação importante: **a rodada R-1 só pode ser `finalizeRound`ada depois que o `BurnTracker` fechou a R-1**, mesmo que ainda não tenha fechado a R. A sequencialidade é:

- `closeRound` incrementa `currentRound`. Logo, para finalizar a rodada X, é preciso que `BURN_TRACKER.currentRound() > X`.
- `finalizeRound` exige ordem estrita: primeiro R=0, depois R=1, depois R=2... Não pode pular.

## Como calcula o share de um projeto no bucket stakers (V2)

Em `RewardDistributorV2._projectStakerShare(round, projectId)`:

**Base do cálculo**: `stakersBase = bucketEmissionByRound[round][BUCKET_STAKERS]` — não é mais `totalEmission`.

**Se houve burn na rodada:**

```
projectShare = stakersBase * burnDoProjetoNaRodada / totalBurnDaRodada
```

**Se não houve burn (bootstrap):**

```
projectShare = stakersBase * weightDoProjetoNoSnapshot / weightGlobalNoSnapshot
```

**E em qualquer caso:**

```
se isInProbation(projectId):
    projectShare = projectShare / 4
```

Os 75% cortados pela probation **nunca são mintados** — não são redistribuídos e `CreditToken.totalSupply()` **não é afetado**. É simplesmente `projectShare` dividido por 4 antes do mint.

## Como calcula o claim de um usuário (bucket stakers)

Em `RewardDistributorV2._calculateClaim(user, round, projectId)`:

```
share = _projectStakerShare(round, projectId)
userWeight    = Staking.getWeightAt(user, projectId, snapshotBlock)
projectWeight = Staking.getTotalWeightAt(projectId, snapshotBlock)

amount = share * userWeight / projectWeight
```

Se `userWeight == 0` ou `share == 0`, retorna 0 sem side effects — o usuário pode tentar de novo depois se o estado mudar.

## Como o bucket apps distribui

Em `finalizeRound`, o V2 itera `pid in 1..totalProjects`:

```
para cada projeto p:
    burnP = BURN_TRACKER.getBurnForProjectInRound(round - 1, p)
    se burnP == 0: pula
    appShare = appsAmount * burnP / totalBurnPrev
    se appShare == 0: pula
    recipient = REGISTRY.ownerRecipient(p)
    se recipient == address(0): pula  (projeto Removed/inexistente — share evapora)
    CREDIT.mint(recipient, appShare, "rewardRound:apps")
```

**Bootstrap** (`totalBurnPrev == 0`): bucket apps NÃO emite — bonders absorve. Sem burn, não há sinal econômico para distribuir entre apps.

**Recipient com timelock 48h**: `ownerRecipient(p)` retorna o explícito setado via `proposeOwnerRecipient` + `applyOwnerRecipient` (timelock 48h), ou cai para `project.owner` como fallback. Ver [ProjectRegistry](../08-contracts-reference/03-ProjectRegistry.md).

## Como o bucket LPs distribui

Em `finalizeRound`, V2 detecta o estado do gauge:

- **Gauge ativo**: `CREDIT.mint(self, lpsAmount)` + `forceApprove(gauge, lpsAmount)` + `gauge.notifyRewardAmount(poolId, lpsAmount, duration)`. Cria uma incentive nova de `gaugeIncentiveDuration` segundos (default 7 dias).
- **Gauge paused**: fallback para `Treasury.depositPendingGaugeRewards(lpsAmount)` + emite `GaugePauseFallback`. Sem fallback, pause do gauge travaria a finalização da rodada inteira.

LPs sacam via `LiquidityGauge.harvest(user, maxAmount)` — o staker oficial Uniswap distribui proporcionalmente ao tempo in-range (`secondsInsideX128`). Após `unstake`, rewards entram em vesting linear de 14 dias.

## Como o bucket bonders alimenta o POL

Em `finalizeRound`, V2 mint `bondersAmount` direto para o Treasury e chama `Treasury.depositPolRefill(bondersAmount)`. Isso só **acumula no ledger interno** `polRefillBucket` — não move tokens para o pool ainda.

Quando governance decide refilar o POL, propõe `addPOLFromRefill(creditAmount, usdcAmount, ...)` no Treasury. O contrato:

1. Debita `creditAmount` do `polRefillBucket` (CEI).
2. Casa com `usdcAmount` do balance livre do Treasury. Atenção à denominação: a fatia `treasuryBps` do FeeRouter (20% no split default `70/20/10` de produção) chega em **CREDIT**, não em USDC — as fontes reais de USDC são bootstrap externo e `collectPOLFees`.
3. Chama `NPM.increaseLiquidity` (ou `mint` na primeira vez).

A Fase 3 do roadmap CLP recicla esse bucket para um `BondDepository` — usuários vendem ETH/CREDIT em troca de CREDIT vested, e o protocolo acumula POL através de bonds. Por enquanto, o bucket sustenta o POL diretamente.

## Pull-based — você puxa seus rewards

Não há push automático. Se você stakou e rodadas fecharam, **nada acontece até você chamar `claim`**. Isso é intencional:

- Evita gas explosion em rodadas com milhares de stakers.
- Delega o custo de gas a quem se beneficia (o staker).
- Permite claim em batch via `claimMany(rounds[], projectIds[])` — você paga uma tx e coleta N rodadas × N projetos.

Consequência: se você esquecer de claim por várias rodadas, **o direito persiste**. Não há deadline. O único "custo" é que o CREDIT está sendo cunhado só quando você solicitar, não imediatamente.

## O snapshotBlock e por que importa

Quando alguém chama `finalizeRound(R)`, o contrato grava `snapshotBlock = block.number`. Toda consulta de peso subsequente no claim usa **esse** bloco, não o atual. Resultado: mesmo que você stakou depois da finalize, seu peso naquela rodada é zero.

Isso é o análogo do `getPastVotes` da governança ERC20Votes — uma proteção anti-flashloan aplicada à dimensão de staking.

## Probation — o que você precisa saber como staker

Se você stakou em um projeto que está em probation inicial:

- Sua share de emissão é dividida por 4 durante a janela.
- A janela é medida em timestamp, não em rodadas.
- Após `probationEndsAt`, a penalidade some automaticamente (não precisa de ação de ninguém).

Se o projeto vira **Probation punitiva** (status `Probation` no Registry), a penalidade não se aplica diretamente pelo RewardDistributor, mas:

- Novos stakes são bloqueados (`Staking.stake` reverte com `ProjectNotActive`).
- Novos pagamentos são bloqueados (`FeeRouter.pay` reverte).
- Você ainda pode **unstake** — o lock **não** é bypassed, mas você não fica impedido de sair quando ele expirar.

> **Cenário cumulativo — Probation punitiva de longo prazo.** Stakers em projeto `Probation` punitiva ficam presos até o lock expirar **mesmo sem receber emissões** (se não há burn do projeto, `share = 0`; a penalidade `/ 4` não se aplica aqui porque o projeto não está em `isInProbation` inicial — mas também não há share porque não há burn e o projeto não pode receber pagamentos). Para mitigar, a DAO pode propor `removeProject` terminal, que bypassa o lock. **Boa prática da DAO: evitar Probation punitiva de longo prazo.** Preferir `removeProject(slash=true)` terminal (com bypass de lock para stakers) ou `reactivate` rápido quando a causa puder ser resolvida. Deixar o projeto congelado em Probation é penalizar o staker por falha do app/governança.

Se o projeto vira **Removed** (terminal):

- O lock é bypassed — você pode unstake imediatamente.
- Emissões futuras para aquele projeto são zero (status `Removed` nunca é `isInProbation` nem conta em `globalWeight` depois de todos os stakes saírem).

## Edge cases

**Rodada sem burn e sem staking global**: emissão acontece (via floor), mas nenhum claim funciona — `globalWeight == 0` e `_projectShare` retorna 0 no caminho bootstrap. CREDIT não é cunhado; o "pool" simplesmente não é alocado.

**Rodada com burn total > 0 mas sem burn no seu projeto**: seu projeto recebe share 0, seu claim é 0. Se você queria captura, precisava ter stakado em um projeto que gerou burn.

**Você stakou entre close e finalize**: seu peso só é contado a partir do bloco da próxima `finalizeRound`. Para a rodada atual, `getWeightAt(você, projeto, snapshotBlock)` retorna o peso que você tinha no bloco da finalize anterior (ou 0 se não tinha).

**Claim duplicado**: `claimed[round][projectId][user]` é marcado `true` após o primeiro claim com `amount > 0`. Tentativa de reclaim reverte com `AlreadyClaimed`. Claim com `amount == 0` **não** marca claimed — você pode tentar de novo.

---

**Próximo →** [Governança](05-governance.md)
