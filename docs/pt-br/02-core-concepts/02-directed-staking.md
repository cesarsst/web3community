# Staking direcionado

**Para quem é:** dev ou staker querendo entender o que o stake de GOV faz e como o peso é calculado.
**Pré-requisitos:** [Dual-token](01-dual-token-economy.md).

> **Remodel 2026-07-08**: o stake de GOV **não rende mais emissão de CREDIT**. No modelo vigente ele cumpre três papéis: (1) **curadoria** — sinaliza publicamente em quais projetos você tem convicção; (2) **gate de investimento** — `invest` e `claim` no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) exigem GOV stakeado no projeto; (3) **governança** (peso de longo prazo). A renda do investidor vem do **rev-share de receita real**, não de emissão.

## O que "direcionado" significa

Quando você chama `Staking.stake(projectId, amount, lockDuration)`:

1. Você escolhe **um** `projectId` válido no `ProjectRegistry` (projeto precisa estar `Active`).
2. Você transfere `amount` de GOV para o contrato `Staking`.
3. Você assume um lock (mínimo 14 dias) durante o qual não pode sacar.

Seu peso vira:

```
weight = amount * multiplier(lockDuration) / 1e18
```

onde `multiplier` é linear entre 1x (14 dias) e 4x (365 dias), saturando em 4x acima. Ver `Staking._multiplier`.

**O peso só conta para aquele `projectId`.** Stake em outro projeto = outra posição, outro peso, contabilidade independente.

## Parâmetros de lock

| Constante | Valor | Semântica | Fonte |
|---|---|---|---|
| `MIN_LOCK` | 14 dias | Lock mínimo aceito. Abaixo disso `stake` reverte com `LockTooShort`. | `Staking.MIN_LOCK` |
| `MAX_LOCK` | 365 dias | **Ponto de saturação do multiplier** (não é lock máximo aceito — ver nota abaixo). | `Staking.MAX_LOCK` |
| `MULTIPLIER_PRECISION` | 1e18 | Base da aritmética de peso. | `Staking.MULTIPLIER_PRECISION` |
| `MAX_MULTIPLIER` | 4e18 | Multiplier máximo (aplicado quando `lockDuration >= MAX_LOCK`). | `Staking.MAX_MULTIPLIER` |

> **Importante — `MAX_LOCK` é saturação, não teto aceito.** Locks acima de 365 dias **são aceitos literalmente**: o multiplier satura em 4x, mas o tempo real de lock é respeitado no `unstake`. O comment interno de `Staking.stake` (linha 427) documenta: "Locks acima de `{MAX_LOCK}` são aceitos literalmente: o multiplier satura em 4x, mas o tempo real é respeitado na hora do unstake." Isso permite perfis "veCRV-like" (ex.: lock de 4 anos para sinalização pública) sem introduzir um cap arbitrário. Locks abaixo de 14 dias revertem com `LockTooShort`.

## Consolidação de posição

Uma posição é identificada por `(user, projectId)`. Só pode haver **uma** por par. Se você chama `stake` em um par que já tem posição:

- `newAmount = old.amount + amount`
- `newLockDuration = max(remaining, lockDuration)` (o maior entre o que sobrava do lock antigo e o novo lock pedido)
- `lockStartAt = block.timestamp` (**reset**)

O reset do `lockStartAt` é intencional. Sem ele, um usuário poderia ir alongando o peso indefinidamente com micro-stakes sem re-comprometer o amount antigo.

Se você quer **aumentar** o amount sem resetar o lock, use `increaseStake(projectId, amount)` — preserva `lockStartAt` e `lockDuration` atuais.

Se você quer **estender** o lock sem mexer no amount, use `extendLock(projectId, newLockDuration)` — sempre estritamente maior que o atual.

## Peso como snapshot

O peso é historizado em `Checkpoints.Trace208` (OpenZeppelin) com chave = `block.number` e valor = `uint208`. Três trilhos paralelos:

- **Por usuário-projeto** (`_userWeight[user][projectId]`)
- **Por projeto** (`_projectWeight[projectId]`) — soma de todos os usuários
- **Global** (`_globalWeightCheckpoints`) — soma de todos os projetos

Consultas:

- `getWeight(user, projectId)` — peso atual.
- `getWeightAt(user, projectId, blockNumber)` — peso histórico no bloco X.
- `getTotalWeight(projectId)` — peso agregado atual do projeto.
- `getTotalWeightAt(projectId, blockNumber)` — histórico.
- `getGlobalWeight()`, `getGlobalWeightAt(blockNumber)` — peso global.

O consumidor vigente do peso é o **[ProjectFunding](../08-contracts-reference/16-ProjectFunding.md)**: `invest` e `claim` exigem `getWeight(investor, projectId) > 0` (skin in the game). O `RewardDistributor` (legado) consultava `...At(block)` no `snapshotBlock` da rodada, nunca o valor atual — proteção anti-flashloan análoga à do `ERC20Votes`, que os checkpoints continuam oferecendo.

## Unstake

Chamando `unstake(projectId, amount)` ou `unstakeAll(projectId)`:

- **Se o lock ainda não expirou e o projeto está `Active` ou `Pending` ou `Probation`**: reverte com `LockNotExpired`.
- **Se o lock expirou**: libera `amount` de volta ao usuário, atualiza peso.
- **Exceção — projeto está `Removed`**: o lock é **bypassado**. A DAO removeu o projeto; punir o staker com lock seria injusto. Emite `EarlyUnstakeAllowed` + `Unstaked`.

Probation inicial por tempo **não** bypassa lock. Probation punitiva **não** bypassa lock. Só `Status.Removed` bypassa.

## Por que direcionado e não genérico

Um staking genérico ("ganho reward geral") cria incentivo passivo: você staka, espera, colhe. A DAO precisa que alguém **selecione ativamente** quais projetos merecem suporte — esse alguém é o staker. É uma curadoria descentralizada com skin in the game:

```
   Staker escolhe projetos em que acredita
   e tranca GOV neles (lock 14-365 dias)
                |
                v
   O stake abre a porta do funding: so quem tem
   GOV stakeado NO projeto pode investir CREDIT
   na rodada e sacar rev-share (ProjectFunding)
                |
                v
   Se o app vende, o investidor recebe % da
   receita REAL a cada pagamento
   Se nao vende, rev-share = zero

   => quem financia e quem ja sinalizou conviccao
```

O modelo pune má alocação: capital (GOV lockado + CREDIT investido) fica amarrado ao sucesso do projeto. Apoiar todo mundo "por igual" exige stakar em cada um individualmente, o que custa gas e imobiliza capital em proporção.

## Como o peso vira renda

No modelo vigente, o peso **não gera emissão** — ele é o **gate**: com `getWeight(você, projectId) > 0` você pode investir CREDIT na rodada do projeto e sacar rev-share da receita bruta (1–30%, definido na rodada). A distribuição é pro-rata às shares de investimento (CREDIT investido, 1:1), não ao peso de stake. Ver [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). Importante: **retirar o stake não perde o rev-share acruado** — o `claim` apenas fica retido até você voltar a stakear (nunca expira).

> **Legado**: no modelo pré-remodel, a fatia de emissão do projeto era dividida proporcionalmente ao peso de cada staker no `snapshotBlock` da rodada — ver [Rewards distribution (legado)](04-rewards-distribution.md).

---

**Próximo →** [Burn-to-mint (legado)](03-burn-to-mint.md)
