# Sacar rev-share

**Para quem é:** investidores que financiaram uma rodada e querem colher a fatia da receita real.
**Pré-requisitos:** [Staking em projetos](03-staking-in-projects.md) e [Funding por rev-share](../02-core-concepts/04-project-funding.md).

Se você investiu numa rodada `Funded` de um projeto, cada pagamento que o app recebe te rende uma fatia pro-rata. Esta página é o passo a passo para sacar — na prática, a aba **Investir** do hub.

## O que você precisa ter

Para sacar (`claim`), duas condições:

1. **Shares na rodada** — você investiu CREDIT numa rodada que foi `Funded` (bateu o alvo). `shares = CREDIT investido`.
2. **GOV ainda stakeado no projeto** — `Staking.getWeight(você, projectId) > 0`. Skin in the game: sem stake vivo, o saque não libera.

## Consultar antes de sacar

Veja quanto você tem a receber, sem gastar gas:

```solidity
ProjectFunding.pendingRevenue(projectId, você);   // CREDIT pendente
```

Outras views úteis:

| View | Retorna |
|---|---|
| `sharesOf[projectId][você]` | suas shares (= CREDIT investido) |
| `totalRevenueDistributed[projectId]` | receita total já distribuída no projeto |
| `revShareBpsOf(projectId)` | o rev-share ativo (0 se não `Funded`) |

## Sacar

```solidity
ProjectFunding.claim(projectId);
```

O `claim`:

- verifica que você tem GOV stakeado no projeto (senão reverte com `NoGovStaked`);
- calcula o pendente pelo acumulador (padrão MasterChef);
- atualiza seu `rewardDebt` e transfere o CREDIT para você;
- reverte com `NothingToClaim` se não há nada pendente.

O que você recebe é **CREDIT** — que você pode usar em qualquer app ou resgatar 1:1 em USDC no [PSM](../08-contracts-reference/03-CreditPSM.md).

## Duas garantias importantes

### Claims nunca expiram

Se você não sacar por semanas ou meses, **nada é perdido**. A receita fica acruada nas suas shares até você chamar `claim`. Não há prazo de validade.

### Sem stake, o valor fica retido (não some)

Se você retirou o GOV do projeto (`unstake`), o `claim` vai reverter enquanto seu peso for zero — mas o rev-share **continua acruado**. Basta re-stakear GOV no projeto para reabrir o gate e sacar tudo o que acumulou. O valor está seguro; o gate é só sobre *quando* você pode sacar.

```
   investiu -> rev-share acumula -> unstake (gate fecha, valor RETIDO)
                                         |
                                         v
                                    re-stake -> claim libera tudo
```

## Quando NÃO há o que sacar

- **Rodada não é `Funded`** — se a rodada falhou (`Failed`), não há rev-share; você recupera o principal com `refund(projectId)`, não `claim`.
- **App não faturou** — sem pagamentos no app, `pendingRevenue` é zero. A renda é estritamente função da receita real.
- **Você não investiu** — sem shares, não há fatia.

## Exemplo

```
Bob investiu 2000 CREDIT na rodada do ChatApp (alvo 10.000, agora Funded).
Bob tem 20% das shares e mantém 1000 GOV stakeados no ChatApp.

Usuarios ja pagaram bastante -> ProjectFunding.pendingRevenue(ChatApp, Bob) = 160 CREDIT

Bob saca:  ProjectFunding.claim(ChatApp)  -> recebe 160 CREDIT
Bob pode:  usar no app  OU  CreditPSM.sell(160e18) -> 160 USDC
```

---

**Voltar →** [Como participar](01-participate.md) · **Conceito →** [Funding por rev-share](../02-core-concepts/04-project-funding.md)
