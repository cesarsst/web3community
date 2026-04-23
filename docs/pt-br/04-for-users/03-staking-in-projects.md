# Staking em projetos

**Para quem é:** quem já tem GOV e quer receber CREDIT como reward.
**Pré-requisitos:** [Directed staking (conceito)](../02-core-concepts/02-directed-staking.md), [Ter GOV](02-holding-gov.md).

## O mental model em 3 linhas

1. Você escolhe **um** projeto (`projectId`).
2. Você trava GOV por **14 a 365+ dias** — multiplier 1x a 4x.
3. Rodadas depois, você reivindica CREDIT proporcional ao burn que aquele projeto gerou × o quanto seu peso pesa dentro do projeto.

## Escolhendo um projeto

Antes de stakar, verifique no Registry:

- Status = `Active` (projetos `Pending`/`Probation`/`Removed` bloqueiam stake novo).
- Idade do projeto (se está em probation inicial por tempo, share é /4).
- Burn histórico nas últimas rodadas (sinal de tração real).

Ferramentas (via UI do hub):

```solidity
// status
registry.getProject(projectId);            // struct completa
registry.isActive(projectId);              // bool
registry.isInProbation(projectId);         // probation inicial por tempo

// burn historico
burnTracker.getBurnForProjectInRound(round, projectId);

// concorrencia
staking.getTotalWeight(projectId);         // quanto peso ja tem no projeto
```

## Escolhendo o lock

Função em `Staking._multiplier`:

- `< 14 dias`: reverte (`LockTooShort`).
- `14 dias`: multiplier = 1x.
- `365 dias`: multiplier = 4x.
- Entre 14 e 365 dias: linear.
- `> 365 dias`: aceito, multiplier satura em 4x (e o lock real é respeitado).

```
  multiplier
       ^
   4x  |-----______________________
       |          _ _ _
   3x  |     ___-
       |   _-
   2x  | _-
       |_-
   1x  |
       +-------------------------------->  lockDuration
      14d                 365d
```

**Regras de bolso:**

- Menor lock possível (14d, 1x): só vale se você tem certeza que vai sair cedo. APR efetivo baixo.
- Lock médio (90-180d, 1.6x–2.4x): flexibilidade vs peso, bom padrão.
- Lock máximo (365d, 4x): maximiza peso por GOV. Use se está confiante no projeto por um ano.
- Lock > 365d: não adiciona peso, só adiciona imobilização. Raramente vantajoso a menos que você queira sinalizar commitment extremo.

## A operação de `stake`

```solidity
// Pré-requisito: você tem GOV e já aprovou o Staking
GOV.approve(staking, amount);

// Staking
staking.stake(
    uint256 projectId,     // o projeto escolhido
    uint256 amount,        // wei de GOV
    uint64 lockDuration    // segundos, >= 14 dias
);
```

A função reverte se:

- `amount == 0` — `ZeroAmount`.
- `lockDuration < 14 days` — `LockTooShort`.
- Projeto não é `Active` — `ProjectNotActive`.
- Allowance insuficiente — `ERC20InsufficientAllowance`.
- Balance insuficiente — `ERC20InsufficientBalance`.

Em caso de sucesso:

- GOV vai para o contrato Staking.
- `positions[you][projectId]` grava `{amount, lockStartAt=now, lockDuration}`.
- Três checkpoints são escritos em `block.number`.
- Peso é calculado como `amount * multiplier(lockDuration) / 1e18`.

## Operações subsequentes

### `increaseStake(projectId, amount)`

Aumenta o amount **sem resetar o lock**. `lockStartAt` e `lockDuration` ficam iguais.

Consequência: peso aumenta proporcionalmente. Se o lock já expirou, você pode imediatamente chamar `unstake` com o novo amount — o `increaseStake` não reabre o lock.

### `extendLock(projectId, newLockDuration)`

Aumenta o `lockDuration` (sempre estritamente maior que o atual). `lockStartAt` **não** muda. Aumenta o peso.

Útil quando seu lock está perto de expirar e você quer estender a posição sem perder o peso.

### `stake` quando já há posição (consolidação)

Se você chama `stake` e já tem posição em `(user, projectId)`:

- `newAmount = old.amount + amount`.
- `newLockDuration = max(remaining, lockDuration)` — o maior entre "o que sobrava do lock antigo" e "o novo lock pedido".
- **`lockStartAt` é resetado** para `block.timestamp`.

Isso é diferente do `increaseStake` — `stake` reseta o lock. Escolha consciente:

- `stake`: quando você quer re-comprometer o tempo.
- `increaseStake`: quando você só quer aumentar o principal.

## Unstake

```solidity
staking.unstake(projectId, amount);     // parcial
staking.unstakeAll(projectId);          // total
```

Condições:

- `amount > 0` e `amount <= position.amount`.
- **Lock expirado**: `block.timestamp >= lockStartAt + lockDuration`.
- **OU projeto é `Removed`** — bypass do lock.

Se o lock ainda está vigente e o projeto não é `Removed`, reverte com `LockNotExpired`.

**Observação importante**: probation punitiva (`Status.Probation`) **NÃO** bypassa o lock. Só `Status.Removed` bypassa.

## O que você ganha

Após cada rodada R ser `finalizeRound`ada, você pode reivindicar reward:

```
amount = projectShare(round, projectId)
       × seuPeso(round)
       ÷ pesoTotal(round)

projectShare = totalEmission × burn_do_projeto_em_R-1 ÷ burn_total_R-1
             (se não houve burn: via peso global)

Se projeto em probation inicial: projectShare /= 4.
```

A fórmula completa está em [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Simulação hipotética

Alice stakou 50.000 GOV no `projectId=42` com lock de 365 dias (peso = 200k). O projeto gerou 600k de burn na rodada R-1, o total da rodada foi 950k, emissão da rodada R é 902k CREDIT. Peso total no projeto (incluindo Alice) é 400k.

```
projectShare = 902_000 × 600_000 / 950_000 = 569.684 CREDIT
aliceShare   = 569.684 × 200.000 / 400.000 = 284.842 CREDIT
```

Alice reivindica 284.842 CREDIT no round R. Se a rodada é semanal e ela mantém a posição por um ano com burn similar, captura ~14.8M CREDIT em 52 rodadas (ilustrativo — realidade depende de dinâmica do uso).

## Edge cases úteis

**Stake em mais de um projeto**: cada `projectId` é uma posição independente. Você pode stakar em 5 projetos diferentes se tiver GOV suficiente.

**Emergency exit por Remoção**: se a DAO remove o projeto via proposta, seu lock é bypassed. Emite evento `EarlyUnstakeAllowed` alem de `Unstaked` — você pode sacar imediatamente.

**Extend vs stake**: `extendLock` **não** muda o amount. `stake` numa posição existente **soma ao amount** e pode aumentar o lock. Use de acordo.

**Lock expirou e você não sacou**: sua posição ainda gera peso com multiplier original. Se quer parar de gerar peso, faça `unstake` ou `unstakeAll`. Simplesmente ignorar = peso continua acumulando.

---

**Próximo →** [Votar em propostas](04-voting.md)
