# Staking em projetos

**Para quem é:** quem quer investir em apps e receber rev-share da receita real.
**Pré-requisitos:** [Ter GOV](02-holding-gov.md) e [Directed staking](../02-core-concepts/02-directed-staking.md).

O staking aqui é **direcionado**: você trava GOV num projeto específico. No modelo vigente, o stake **não rende emissão** — ele é o **pré-requisito para investir** na rodada de captação do projeto e para **sacar** o rev-share depois.

```
   1. stake GOV no projeto  ->  2. invest CREDIT na rodada  ->  3. claim rev-share
   (Staking.stake)              (ProjectFunding.invest)         (ProjectFunding.claim)
        |                            exige peso > 0                 exige peso > 0
        +-- gera peso no projeto ----------+------------------------+
```

## Passo 1: Stakar GOV no projeto

Escolha um projeto `Active` no [Registry](../08-contracts-reference/04-ProjectRegistry.md) e trave GOV nele:

```solidity
GovernanceToken.approve(staking, amount);
Staking.stake(projectId, amount, lockDuration);   // lockDuration em segundos
```

O **lock** determina o multiplier do seu peso:

| Lock | Multiplier |
|---|---|
| 14 dias (`MIN_LOCK`) | 1x |
| entre 14 e 365 dias | linear |
| 365 dias (`MAX_LOCK`) ou mais | 4x (satura) |

`peso = amount * multiplier / 1e18`. Lock abaixo de 14 dias reverte. O peso é o que habilita `invest` e `claim` — qualquer peso `> 0` já abre o gate, mas mais peso = mais sinal de confiança no projeto.

Operações relacionadas:

- **`increaseStake(projectId, amount)`** — adiciona GOV mantendo o lock atual.
- **`extendLock(projectId, novoLock)`** — aumenta a duração (nunca encurta) → aumenta o multiplier.
- **`stake` de novo no mesmo projeto** — consolida: soma o amount e **reseta** o início do lock para agora (re-compromisso temporal sobre toda a posição).

## Passo 2: Investir na rodada

Com peso `> 0` no projeto, você pode entrar na rodada de captação dele no [`ProjectFunding`](../08-contracts-reference/07-ProjectFunding.md), enquanto ela estiver `Open` e dentro do prazo:

```solidity
CreditToken.approve(projectFunding, amount);
ProjectFunding.invest(projectId, amount);   // amount em CREDIT
```

- Você investe **CREDIT** (não GOV — o GOV está stakeado, é só o gate).
- Suas **shares = CREDIT investido** (1:1). Elas definem sua fatia pro-rata do rev-share.
- **All-or-nothing**: se a rodada bate o alvo (`Funded`), o dono recebe o captado e o rev-share ativa. Se o prazo vence sem bater o alvo (`Failed`), você recupera 100% com `refund(projectId)`.
- Sem GOV stakeado, `invest` reverte com `NoGovStaked`.

## Passo 3: Sacar o rev-share

Depois que a rodada é `Funded`, cada pagamento no app desconta o rev-share e o distribui pro-rata às shares. Você saca com:

```solidity
ProjectFunding.claim(projectId);
```

- **Exige GOV ainda stakeado** no projeto (skin in the game). Se você retirou o stake, `claim` reverte — mas o valor **não é perdido**: fica acruado até você voltar a stakear.
- Consulte o pendente a qualquer momento: `ProjectFunding.pendingRevenue(projectId, você)`.
- **Claims nunca expiram.**

Detalhe completo em [Sacar rev-share](05-claiming-revenue.md).

## Retirar o stake (unstake)

Quando o lock expira:

```solidity
Staking.unstake(projectId, amount);     // ou unstakeAll(projectId)
```

Antes do lock expirar, o unstake reverte com `LockNotExpired` — **exceto** se o projeto foi `Removed` pela governança, caso em que o lock é ignorado e você recupera o GOV imediatamente.

> **Cuidado com o timing.** Se você fizer unstake e ainda tiver rev-share pendente, o `claim` vai reverter até você re-stakear. O valor não some, mas você precisa de stake vivo no momento do saque.

## Fluxo completo em um exemplo

```
Alice quer financiar o ChatApp (projectId 7), rev-share 8%:

1. GOV.approve(staking, 1000e18); Staking.stake(7, 1000e18, 180 dias)
      -> peso no ChatApp (multiplier ~2,5x para 180d)

2. Rodada do ChatApp esta Open (alvo 10.000 CREDIT):
   CREDIT.approve(funding, 2000e18); ProjectFunding.invest(7, 2000e18)
      -> shares = 2000; se a rodada bate 10.000, ChatApp recebe e rev-share ativa

3. Usuarios pagam no ChatApp. Alice tem 20% das shares (2000/10000):
   ProjectFunding.claim(7)  -> saca 20% do rev-share acumulado
      (enquanto mantiver os 1000 GOV stakeados no projeto 7)
```

---

**Próximo →** [Votar em propostas](04-voting.md)
