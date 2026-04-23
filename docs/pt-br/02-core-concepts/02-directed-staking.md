# Staking direcionado

**Para quem é:** dev ou staker querendo entender como o peso de rewards é calculado.
**Pré-requisitos:** [Dual-token](01-dual-token-economy.md).

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

O `RewardDistributor` **sempre** consulta `...At(block)` no `snapshotBlock` da rodada, nunca o valor atual. Isso é a proteção anti-flashloan análoga à do `ERC20Votes`.

## Unstake

Chamando `unstake(projectId, amount)` ou `unstakeAll(projectId)`:

- **Se o lock ainda não expirou e o projeto está `Active` ou `Pending` ou `Probation`**: reverte com `LockNotExpired`.
- **Se o lock expirou**: libera `amount` de volta ao usuário, atualiza peso.
- **Exceção — projeto está `Removed`**: o lock é **bypassado**. A DAO removeu o projeto; punir o staker com lock seria injusto. Emite `EarlyUnstakeAllowed` + `Unstaked`.

Probation inicial por tempo **não** bypassa lock. Probation punitiva **não** bypassa lock. Só `Status.Removed` bypassa.

## Por que direcionado e não genérico

Um staking genérico ("ganho reward geral") cria incentivo passivo: você staka, espera, colhe. A DAO precisa que alguém **selecione ativamente** quais projetos merecem suporte — esse alguém é o staker. É quase uma curadoria descentralizada:

```
   Staker escolhe projetos que acredita
   que vao gerar burn (= uso)
                |
                v
   Peso fica amarrado ao sucesso daquele projeto
                |
                v
   Se projeto gera burn, staker ganha reward
   Se nao gera, reward = zero pra ele

   => staker so ganha se escolheu bem
```

O modelo punisce má alocação. Apoiar todo mundo "por igual" exige stakar em cada um individualmente, o que custa gas e imobiliza capital em proporção.

## Como o peso vira reward

Ver [Rewards distribution](04-rewards-distribution.md). Em resumo: dentro de um `projectId`, a fatia de emissão do projeto é dividida proporcionalmente ao peso de cada staker no `snapshotBlock` da rodada.

---

**Próximo →** [Burn-to-mint](03-burn-to-mint.md)
