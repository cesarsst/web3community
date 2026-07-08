# Staking em projetos

**Para quem é:** quem já tem GOV e quer apoiar projetos — e destravar o direito de investir nas rodadas deles.
**Pré-requisitos:** [Directed staking (conceito)](../02-core-concepts/02-directed-staking.md), [Ter GOV](02-holding-gov.md).

> **Remodel 2026-07-08**: stakar GOV **não rende mais emissão de CREDIT**. O stake é curadoria + **gate de investimento**: só quem tem GOV stakeado no projeto pode investir CREDIT na rodada dele no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) e sacar rev-share da receita real.

## O mental model em 3 linhas

1. Você escolhe **um** projeto (`projectId`).
2. Você trava GOV por **14 a 365+ dias** — multiplier 1x a 4x.
3. Com o stake ativo, você pode **investir CREDIT na rodada do projeto** e receber % da receita bruta dele a cada pagamento (rev-share, pro-rata ao investido).

## Escolhendo um projeto

Antes de stakar, verifique no Registry:

- Status = `Active` (projetos `Pending`/`Probation`/`Removed` bloqueiam stake novo).
- GMV histórico on-chain (`FeeRouterV2.grossVolumeOf`) — sinal de tração real.
- A rodada de funding, se houver: alvo, rev-share (1-30%), prazo, quanto já captou.

Ferramentas (via UI do hub):

```solidity
// status
registry.getProject(projectId);            // struct completa
registry.isActive(projectId);              // bool

// tracao real
feeRouterV2.grossVolumeOf(projectId);      // GMV acumulado
funding.totalRevenueDistributed(projectId);// receita ja paga a investidores

// rodada de funding
funding.rounds(projectId);                 // alvo, captado, prazo, revShareBps, status

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

- Para o **gate de investimento** do ProjectFunding, qualquer peso > 0 basta — inclusive o lock mínimo (14d, 1x).
- Lock médio (90-180d, 1.6x–2.4x): flexibilidade vs peso de curadoria/sinalização, bom padrão.
- Lock máximo (365d, 4x): maximiza peso por GOV. Use se está confiante no projeto por um ano.
- Lock > 365d: não adiciona peso, só adiciona imobilização. Raramente vantajoso a menos que você queira sinalizar commitment extremo.
- Lembre: você precisa **manter** GOV stakeado no projeto para sacar rev-share (`claim`) — dimensione o lock junto com o horizonte do investimento.

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

O stake em si **não gera renda** — ele destrava o investimento. A renda vem do [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md):

```
1. Com GOV stakeado no projeto, invista CREDIT na rodada aberta:
   funding.invest(projectId, amount)      [shares = CREDIT investido, 1:1]

2. Rodada bate o alvo (Funded) -> rev-share ativa

3. A cada pagamento no app (FeeRouterV2.pay), sua fatia acumula:
   sua_fatia = revShare_do_pagamento × suas_shares / total_captado

4. Saque quando quiser: funding.claim(projectId)
   (exige GOV ainda stakeado; nunca expira)
```

O retorno é **fatia de receita real** — verificável on-chain via `pendingRevenue(projectId, você)` e `totalRevenueDistributed(projectId)`.

## Simulação hipotética

Alice staka 50.000 GOV no `projectId=42` com lock de 365 dias (gate ativo). O projeto abriu rodada de 10.000 CREDIT com rev-share de 8%; Alice investe 2.500 CREDIT (25% das shares) e a rodada fecha Funded. O app fatura 2.000 CREDIT/mês de GMV:

```
revShare mensal do projeto = 2.000 × 8% = 160 CREDIT
fatia da Alice             = 160 × 2.500 / 10.000 = 40 CREDIT/mes
ao ano                     = 480 CREDIT  (~19,2% a.a. sobre os 2.500 investidos)
```

Ilustrativo — realidade depende 100% da receita do app. Sem GMV, não há repasse. O CREDIT recebido é estável: resgatável 1:1 em USDC no PSM.

> **Legado**: no modelo pré-remodel, o staker reivindicava CREDIT emitido proporcional ao burn do projeto (bucket stakers 55%). A fórmula antiga está em [Rewards distribution (legado)](../02-core-concepts/04-rewards-distribution.md); claims históricos continuam sacáveis.

## Edge cases úteis

**Stake em mais de um projeto**: cada `projectId` é uma posição independente. Você pode stakar em 5 projetos diferentes se tiver GOV suficiente.

**Emergency exit por Remoção**: se a DAO remove o projeto via proposta, seu lock é bypassed. Emite evento `EarlyUnstakeAllowed` alem de `Unstaked` — você pode sacar imediatamente.

**Extend vs stake**: `extendLock` **não** muda o amount. `stake` numa posição existente **soma ao amount** e pode aumentar o lock. Use de acordo.

**Lock expirou e você não sacou**: sua posição ainda gera peso com multiplier original. Se quer parar de gerar peso, faça `unstake` ou `unstakeAll`. Simplesmente ignorar = peso continua acumulando.

---

**Próximo →** [Votar em propostas](04-voting.md)
