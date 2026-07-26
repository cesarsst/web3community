# Value accrual: como o valor acumula

**Para quem é:** quem quer entender de onde vem o retorno antes de qualquer exposição.
**Pré-requisitos:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md), [Tokenomics](01-tokenomics.md).

Existem **duas** formas distintas de capturar valor no protocolo, e elas não se confundem. O CREDIT **não** é uma delas — ele é estável por construção e nunca valoriza.

| Via | Instrumento | De onde vem o valor |
|---|---|---|
| **Valorização do GOV** | segurar GOV | buyback financiado pela fee (40% da fee ≈ 1% do GMV) |
| **Renda de rev-share** | posição numa rodada financiada | % da **receita real** do app, paga a cada `pay` |

Ambas dependem de **uso real dos apps**. Não há emissão, não há reward inflacionário, não há rendimento que apareça do nada.

## Via 1 — GOV valoriza via buyback

Toda vez que alguém paga um app, o [`FeeRouterV2`](../08-contracts-reference/06-FeeRouterV2.md) cobra 2,5% e reparte a fee em 40% treasury / 40% buyback / 20% grants. A parcela de **buyback** (40% da fee) vai para o `buybackRecipient`, destinada a recomprar GOV no mercado.

Fazendo a conta com os parâmetros default:

```
fee            = 2,5% do pagamento
parcela buyback = 40% da fee = 0,40 * 2,5% = 1,0% do GMV
```

Ou seja: **~1% de todo o volume bruto processado** é pressão estrutural de compra sobre o GOV. Quanto mais os apps faturam, mais demanda por GOV — e o supply é **cap imutável de 100M**, nunca inflacionado.

> **Estado da automação.** O buyback não é executado automaticamente pelo contrato: a parcela **acumula** no `buybackRecipient` e a **execução da recompra é feita por governança** (proposta que gasta esses fundos comprando GOV). O mecanismo de captura é a fee; o timing e o método da recompra são decisão da DAO.

O GOV não paga dividendo. A tese de valor dele é: demanda estrutural crescente (buyback proporcional ao GMV) sobre supply fixo, mais a utilidade de governança e de gate de investimento.

## Via 2 — Rev-share paga receita real

Quem financia uma rodada no [`ProjectFunding`](../08-contracts-reference/07-ProjectFunding.md) compra uma **posição de rev-share**: o direito a uma fatia (`revShareBps`, 1%–30%) da **receita bruta futura** daquele app específico.

O mecanismo é 100% on-chain e automático:

1. A rodada bate o alvo → status `Funded` → `revShareBpsOf(projectId)` passa a retornar o bps prometido.
2. A cada `FeeRouterV2.pay`, o router **desconta o rev-share antes de pagar o app** e o encaminha ao `ProjectFunding`, que atualiza um acumulador pro-rata (padrão MasterChef).
3. O investidor saca sua parte acumulada com `claim(projectId)` — exige manter GOV stakeado no projeto (skin in the game); o valor **nunca expira**.

Suas shares = CREDIT investido (1:1, imutável após a rodada financiar). Sua fatia da receita distribuída é `suas shares / total captado`.

```
pagamento de 1.000 CREDIT, projeto com rev-share de 8%:
  fee (2,5%)      =  25 CREDIT  -> treasury/buyback/grants
  rev-share (8%)  =  80 CREDIT  -> investidores (pro-rata às shares)
  app             = 895 CREDIT
```

O retorno de uma posição de rev-share depende só de uma coisa: **quanto o app fatura**. Se ele processar muito volume, sua fatia rende; se ele não vender, você recebe pouco ou nada. Não há garantia de retorno — é participação em receita real, não renda fixa.

## Por que não é um Ponzi

Um Ponzi paga participantes antigos com o dinheiro de participantes novos, sem geração de valor real. O desenho aqui é o oposto em três pontos verificáveis on-chain:

1. **A renda vem de receita real, não de aporte de novos investidores.** O rev-share é uma fatia de pagamentos que usuários fazem para **usar os apps** (`FeeRouterV2.pay`). Se ninguém usar os apps, não há rev-share — o sistema desacelera em vez de exigir "mais entrantes".

2. **Nenhum token é emitido como reward.** Não há emissão inflacionária de GOV nem de CREDIT como "rendimento". O GOV tem cap imutável de 100M; o CREDIT só é mintado contra USDC depositado no PSM.

3. **O CREDIT é lastreado 1:1 e não valoriza.** Cada CREDIT em circulação mintado pelo [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md) tem 1 USDC guardado, verificável em `backing()`. Não existe função de saque do lastro — nem para governança. O CREDIT é meio de pagamento, não aposta: comprar CREDIT é carregar um cartão pré-pago, não investir.

A consequência honesta disso: **tokenomics não salva produto ruim.** Se os apps não geram utilidade real, o GMV é baixo, o buyback é pequeno e o rev-share seca. O valor do protocolo é derivado, não intrínseco.

## Onde medir tudo isso

Todas as fontes de valor são observáveis on-chain — ver [Métricas que importam](04-metrics-that-matter.md):

- `FeeRouterV2.grossVolumeOf(projectId)` — GMV por projeto (dirige buyback e rev-share).
- `ProjectFunding.totalRevenueDistributed(projectId)` — receita real já paga aos investidores.
- `ProjectFunding.pendingRevenue(investor, projectId)` — quanto você tem a sacar.
- `CreditPSM.backing()` / `mintedOutstanding` — integridade do lastro.

---

**Próximo →** [Riscos e segurança](03-risk-and-security.md)
