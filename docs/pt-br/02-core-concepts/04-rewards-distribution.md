# Distribuição de rewards

**Para quem é:** stakers e devs querendo entender exatamente como o pool de uma rodada vira claim do usuário.
**Pré-requisitos:** [Directed staking](02-directed-staking.md), [Burn-to-mint](03-burn-to-mint.md).

## Ciclo completo de uma rodada

```
[Rodada R-1 aberta no BurnTracker]

Usuarios pagam em apps via FeeRouter
  -> FeeRouter.burnByRole 95% do valor via BurnTracker.burnAndRecord
  -> BurnTracker incrementa:
       burnByRoundProject[R-1][projectId] += amount
       totalBurnByRound[R-1]              += amount
       projectsWithBurnCount[R-1]         += 1 (1a vez por projeto)

[Fim da janela alvo da rodada (roundDuration)]

Governanca chama closeRound()
  -> currentRound passa de R-1 para R
  -> roundStartedAt = block.timestamp (rodada R aberta)
  -> dados de R-1 continuam acessiveis via views

[Qualquer um chama finalizeRound(R-1) no RewardDistributor]
  -> le BurnTracker.getTotalBurnForRound(R-2)  (ou 0 se R-1 == 0)
  -> calcula emissao = min(max(alpha * burn_{R-2}, floor(R-1)), capMax)
  -> grava roundData[R-1] = { totalEmission, totalBurnAtFinalize, snapshotBlock, finalized: true }

[Stakers chamam claim(R-1, projectId)]
  -> se !finalized: reverte
  -> se ja claimou: reverte
  -> calcula amount e cunha CREDIT via CREDIT.mint
```

Observação importante: **a rodada R-1 só pode ser `finalizeRound`ada depois que o `BurnTracker` fechou a R-1**, mesmo que ainda não tenha fechado a R. A sequencialidade é:

- `closeRound` incrementa `currentRound`. Logo, para finalizar a rodada X, é preciso que `BURN_TRACKER.currentRound() > X`.
- `finalizeRound` exige ordem estrita: primeiro R=0, depois R=1, depois R=2... Não pode pular.

## Como calcula o share de um projeto

Em `RewardDistributor._projectShare(round, projectId)`:

**Se houve burn na rodada:**

```
projectShare = totalEmission * burnDoProjetoNaRodada / totalBurnDaRodada
```

**Se não houve burn (bootstrap):**

```
projectShare = totalEmission * weightDoProjetoNoSnapshot / weightGlobalNoSnapshot
```

**E em qualquer caso:**

```
se isInProbation(projectId):
    projectShare = projectShare / 4
```

Os 75% cortados pela probation **nunca são mintados** — não entram no `CREDIT.mint`, não são redistribuídos e `CreditToken.totalSupply()` **não é afetado**. Não é `_burn` (que reduziria supply previamente mintado); é simplesmente `projectShare` dividido por 4 antes do mint, conforme `contracts/RewardDistributor.sol:615-618`.

## Como calcula o claim de um usuário

Em `RewardDistributor._calculateClaim(user, round, projectId)`:

```
share = _projectShare(round, projectId)
userWeight   = Staking.getWeightAt(user, projectId, snapshotBlock)
projectWeight = Staking.getTotalWeightAt(projectId, snapshotBlock)

amount = share * userWeight / projectWeight
```

Se `userWeight == 0` ou `share == 0`, retorna 0 sem side effects — o usuário pode tentar de novo depois se o estado mudar (raro, mas evita "queimar" o slot de claim por erro).

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
