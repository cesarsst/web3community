# Dual-token economy: GOV e CREDIT

**Para quem é:** qualquer leitor querendo entender por que existem dois tokens e o que cada um faz.
**Pré-requisitos:** [Modelo mental](../01-getting-started/02-mental-model.md).

## Por que dois tokens

Um único token não consegue ser, ao mesmo tempo, **moeda de pagamento estável** e **reserva de valor política**. Se o token de pagamento valoriza, ninguém gasta (por que pagar 10 hoje se amanhã vale 12?). Se o token político é gasto no dia a dia, o voto vira mercadoria de curto prazo.

A web3community separa os papéis:

| | GOV | CREDIT |
|---|---|---|
| **Função** | Governança + gate de investimento | Meio de pagamento nos apps |
| **Supply** | Cap imutável de 100M | Elástico, 1:1 com o lastro USDC |
| **Preço** | Flutua (captura valor do ecossistema) | Estável: 1 CREDIT = 1 USDC |
| **Como obter** | Mercado / distribuição da DAO | `CreditPSM.buy()` com USDC |
| **Como sair** | Mercado | `CreditPSM.sell()` — resgate 1:1 |
| **Vota?** | Sim (ERC20Votes) | Não |
| **Staka?** | Sim (direcionado por projeto) | Não (investe-se em rodadas) |
| **Contrato** | [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | [CreditToken](../08-contracts-reference/02-CreditToken.md) |

## CREDIT: dinheiro operacional, não aposta

CREDIT existe para uma coisa: **pagar dentro dos apps**. Ele é estável por construção:

- **Entrada**: `CreditPSM.buy(usdcAmount)` — deposita USDC, recebe CREDIT 1:1 (sem taxa). O USDC fica retido no PSM.
- **Saída**: `CreditPSM.sell(creditAmount)` — devolve CREDIT (que é queimado pelo próprio PSM), recebe USDC 1:1 (sem taxa).
- **Lastro**: verificável a qualquer momento via `backing()`. Não existe função de saque do lastro — nem para governança.

O supply de CREDIT cresce quando entra USDC e encolhe quando sai. Ele nunca "infla" nem "deflaciona" em relação ao dólar: cada unidade em circulação mintada pelo PSM tem 1 USDC guardado.

**Consequência de UX**: o usuário não precisa pensar em preço. 10 CREDIT hoje valem 10 USDC hoje, amanhã e daqui a um ano. Comprar CREDIT não é investimento — é carregar o cartão pré-pago do ecossistema.

## GOV: a camada política e de captura de valor

GOV faz três coisas que CREDIT não faz:

1. **Vota.** GOV é `ERC20Votes` — delega, snapshota e decide propostas no [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md).
2. **Destrava investimento.** Para investir CREDIT numa rodada do [ProjectFunding](../08-contracts-reference/07-ProjectFunding.md), você precisa ter GOV stakeado **naquele projeto** ([Staking](../08-contracts-reference/05-Staking.md)) — e manter o stake para sacar o rev-share.
3. **Captura valor.** 40% da fee do protocolo (1% do GMV com os parâmetros default) é destinada a buyback de GOV. Quanto mais volume os apps processam, mais demanda estrutural por GOV.

O cap de 100M é **imutável** — enforced no `_update` do token. Não há inflação de GOV além do cap, nunca.

## Como os dois tokens se encontram

```
                     USDC
                       |
                  CreditPSM (1:1, sem taxa)
                       |
                     CREDIT
                       |
        +--------------+---------------+
        |                              |
   FeeRouterV2.pay                ProjectFunding.invest
   (pagar apps)                   (financiar rodada)
        |                              ^
        |  fee 2,5%                    |
        |   +--> 40% treasury          | exige GOV stakeado
        |   +--> 40% buyback ----> demanda por GOV
        |   +--> 20% grants            |
        |                              |
        +--> rev-share --> investidores (stakers de GOV)
        +--> ~89,5-97,5% --> app
```

- O **usuário** só toca CREDIT (e USDC na borda).
- O **investidor** usa os dois: GOV para stakar (curadoria + gate) e CREDIT para investir na rodada.
- O **app** recebe CREDIT e pode resgatar USDC no PSM quando quiser.
- A **DAO** vive da fee — e devolve valor ao GOV via buyback.

## Anti-padrões que o desenho evita

- **"Governance token que também é moeda"**: pagamento estável e voto estão em contratos separados; não há como comprar voto barato num dip da moeda de uso.
- **"Moeda de uso especulativa"**: o PSM elimina a volatilidade do meio de pagamento — o app pode precificar em dólar.
- **"Renda por inflação"**: nenhum token é emitido como reward. A renda do investidor é rev-share de receita real ([ProjectFunding](04-project-funding.md)).
- **"Tesouraria que toca o lastro"**: o USDC do PSM é segregado por construção. O Treasury vive apenas da fee.

---

**Próximo →** [Directed staking](02-directed-staking.md)
