# Fluxo de valor

**Para quem é:** leitor querendo entender por onde o valor real entra, transita e sai do protocolo.
**Pré-requisitos:** [CreditPSM](../08-contracts-reference/15-CreditPSM.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

> **Remodel 2026-07-08**: esta página descreve o fluxo vigente (trilho de pagamento + rev-share). O fluxo antigo burn-to-mint aparece ao final, marcado como legado.

## De onde vem o valor real

A única fonte de **valor externo** no sistema é o usuário final que paga pelos serviços dos apps. Ele converte USDC em CREDIT porque precisa usar os apps. Se ninguém quer usar os apps, ninguém compra CREDIT, e o sistema morre — essa é a invariante dura, igual à do modelo antigo.

A diferença pós-remodel: **não há mais pool, slippage nem risco de preço na entrada**. O `CreditPSM` converte USDC ↔ CREDIT a 1:1, sem taxa, nos dois sentidos, com lastro 100% retido no contrato.

O caminho típico de um pagamento:

```
   [ Usuario Charlie ]
        |
        |  1. CreditPSM.buy(1000 USDC) -> 1000 CREDIT (1:1, sem taxa)
        |     (lastro fica retido no PSM; resgatavel a qualquer momento)
        v
   [ Carteira Charlie tem 1000 CREDIT ]
        |
        |  2. Usa o Chat App. App cobra 1000 CREDIT pelo servico.
        |     Charlie assina approve(feeRouterV2, 1000) + pay(42, 1000)
        |
        v
   [ FeeRouterV2 ]
        |
        | fee 2,5% (250 bps; teto duro 5%) + rev-share do projeto
        |
        +-------> fee 25 CREDIT:
        |            10 -> Treasury        (40% da fee = 1,0% do GMV)
        |            10 -> buyback de GOV  (40% da fee = 1,0% do GMV)
        |             5 -> grants          (20% da fee = 0,5% do GMV)
        |
        +-------> rev-share 80 CREDIT (se rodada Funded com 8%)
        |            -> ProjectFunding, pro-rata aos investidores
        |
        +-------> toApp 895 CREDIT (~89,5%) -> dono do app, NA HORA
                     (97,5% se o projeto nunca captou rodada)
```

**O valor real entrou no protocolo na etapa 1** (USDC no lastro do PSM). Todas as etapas subsequentes redistribuem CREDIT plenamente lastreado — nada é queimado, nada é emitido do ar.

## Os 5 agentes e por que cada um está no jogo

Com o remodel, o **investidor** (staker de GOV + funder de CREDIT) substitui o LP como agente formal de capital.

```
   +----------+    +-------------+    +--------------+    +------------+    +-----------+
   | Usuario  |    |    App      |    | Investidor   |    |   Holder   |    | Treasury/ |
   | final    |    | (ChatApp)   |    | (Alice:      |    |   de GOV   |    | DAO       |
   |          |    |             |    |  GOV+CREDIT) |    |            |    |           |
   +----+-----+    +------+------+    +------+-------+    +-----+------+    +-----+-----+
        |                 |                  |                  |                 |
   paga em CREDIT    recebe ~89,5-97,5%  staka GOV no      poder de voto     recebe 40%
   (estavel 1:1;     da receita NA HORA  projeto (gate)    no Governor;      da fee (1%
   compra/resgata    + capital           + investe CREDIT  GOV captura      do GMV) pra
   no PSM sem        antecipado na       na rodada;        valor via        opex; lastro
   slippage)         rodada de funding   recebe % da       buyback continuo do PSM e
        |                 |              receita REAL      (40% da fee =    SEGREGADO
   extrai valor      cresce com          de cada           1% do GMV)       (nao e do
   de servico        capital que nao     pagamento              |           treasury)
   (fora do          dilui equity            |                  |                |
   protocolo)             |                  |                  |                |
```

Perceba: **não há yield "do ar"**. O CREDIT que Alice recebe existe porque Charlie pagou pelo serviço — é fatia de receita real, não emissão. Nenhum ator recebe valor que não veio de algum ator a montante.

## O que o app ganha (e quanto custa)

### Receita direta, na hora

- **Sem rodada de funding**: 97,5% de cada pagamento (fee de 2,5%).
- **Com rodada financiada** (ex.: rev-share de 8%): ~89,5% de cada pagamento, direto na carteira, no mesmo bloco.

Compare: Stripe cobra ~3,8%, app stores 15-30%. O modelo antigo (legado) entregava ao app apenas 10% nominal do pagamento (~38% efetivo com stake) — a análise `audit/economist/2026-07-08-feerouter-bypass.md` mostrou que nesse desenho o bypass era estratégia dominante.

### Capital antecipado sem diluir equity

O dono abre uma rodada no `ProjectFunding`: alvo em CREDIT, rev-share de 1-30%, prazo de 1-90 dias, all-or-nothing. Se bater o alvo, recebe o captado imediatamente e passa a "pagar" via rev-share sobre a receita futura.

**Custo de capital ilustrativo**: rodada de 10.000 CREDIT a 8% de rev-share, com GMV de 2.000 CREDIT/mês → 160 CREDIT/mês para investidores = 1.920/ano ≈ **19% a.a.** sobre o captado. Comparável a revenue-based financing (Pipe, Clearco: 15-25%) — e o "juro" só existe se houver receita: sem GMV, não há repasse (nem dívida acumulando).

### Hub e base de usuários

Listagem no Registry dá acesso à base de usuários do hub, descoberta e infraestrutura de pagamento pronta (PSM + FeeRouterV2) — sem integração com adquirente, sem chargeback.

## O que o investidor ganha

1. **Stake GOV no projeto** (gate + curadoria; multiplier de lock continua valendo para peso).
2. **Investe CREDIT na rodada** (shares 1:1 com o investido).
3. **Recebe % da receita bruta a cada pagamento** — acumulada on-chain, `claim` a qualquer momento (exige manter o GOV stakeado; nunca expira).

**Yield ilustrativo** (não é promessa): rodada de 10.000 a 8% com GMV de 2.000/mês → 19,2% a.a.; rodada de 50.000 a 12% com GMV de 5.000/mês → 600/mês = 14,4% a.a. Tudo verificável on-chain: `grossVolumeOf` (GMV), `totalRevenueDistributed` (receita já paga), `pendingRevenue` (a sacar). O CREDIT recebido é estável — resgatável 1:1 no PSM a qualquer momento.

**Risco**: se a rodada não bater o alvo, refund integral (all-or-nothing). Depois de Funded, o retorno depende 100% da receita real do app — projeto que morre não paga nada. O capital investido não é devolvido — o que se compra é o fluxo de rev-share.

## Fluxo por ciclo de rodada (legado)

> ⚠️ **LEGADO** — o ciclo de rodadas de burn/emissão abaixo pertence ao modelo pré-remodel.

```
   Rodada R-1 (a que passou)                                 Rodada R (agora)
   +------------------------------------+                   +------------------------------------+
   | Charlie + 10k outros usuarios       |                  | Alice pode claim rewards de R-1 em |
   | pagaram em CREDIT nos apps          |                  | funcao de:                         |
   |                                     |                  |   - burn total de R-1              |
   | BurnTracker registrou:              |  closeRound()    |   - burn do projeto dela em R-1    |
   |   totalBurnByRound[R-1] = 950_000   |  --------->      |   - peso do stake dela             |
   |   burnByRoundProject[R-1][42] = 600_000                |                                    |
   +------------------------------------+                   +------------------------------------+
                                                                     |
                                                               finalizeRound(R-1)
                                                                     |
                                                                     v
                                                            emissao = min(
                                                                max(0.95 * 950_000, floor(R-1)),
                                                                capMax
                                                            ) = 902_500 CREDIT (no exemplo)

                                                            roundData[R-1].totalEmission = 902_500
                                                            roundData[R-1].snapshotBlock = block.number
                                                            bucketEmissionByRound[R-1][stakers] = 55% * 902_500 = 496_375

                                                            Stakers podem claim (base = bucket stakers, NAO emissao total):
                                                              project_share(42) = 496_375 * 600k/950k = 313_500
                                                              alice_claim = 313_500 * aliceW/projectW
```

## Rotação de CREDIT

No modelo vigente, CREDIT entra e sai do supply pelo **PSM**:

1. **Entra**: `CreditPSM.buy` — minta 1:1 contra USDC depositado (lastro retido).
2. **Sai**: `CreditPSM.sell` — queima 1:1 e devolve USDC.

O supply de CREDIT é, portanto, **elástico mas sempre lastreado**: cresce quando há demanda por pagamento nos apps, encolhe quando usuários resgatam. Não há emissão discricionária nem queima de valor.

```
   totalSupply ~= mintedOutstanding <= lastro USDC do PSM (normalizado)
```

Vias legadas (pré-remodel, ainda existentes no código): `mintGenesis` (one-shot histórico de 10M pro Treasury), `mint` pelos RewardDistributors (claims históricos) e `burnByRole` via BurnTracker (trilho de burn desativado de fato — o FeeRouterV2 não queima).

## Rotação de GOV

GOV entra no supply de forma permanente até atingir o cap:

1. Genesis: 0 no deploy.
2. `mint`: apenas pelo owner (Timelock em produção) até atingir `CAP_SUPPLY = 100M`.
3. Após atingir o cap, `mint` reverte com `CapExceeded`.

Não há burn de GOV no código.

Circulação:

- **Holder livre** → compra/venda em DEX.
- **Holder → Staking**: `stake` trava GOV no contrato; `unstake` libera.
- **Holder → Registry**: `registerProject` trava GOV como colateral; `removeProject` libera (para owner ou treasury).
- **Holder → TeamVesting (via Timelock)**: vesting contracts que liberam gradualmente.
- **Holder → Governor**: `delegate` não move GOV, só confere poder de voto.
- **Buyback contínuo (remodel)**: 40% da fee de cada pagamento (= 1% do GMV) vai para `buybackRecipient` do FeeRouterV2, financiando recompra de GOV — pressão de compra proporcional ao uso real.

## O papel do Treasury nesse fluxo (pós-remodel)

O Treasury é o **caixa operacional** da DAO. Ele:

- Recebe **40% da fee do FeeRouterV2** (= 1% do GMV) a cada pagamento — receita recorrente, proporcional ao uso.
- Recebe colateral de projetos removidos com slash.
- Mantém o legado (genesis histórico de CREDIT, ledgers do CLP).

**Importante**: o lastro USDC do PSM é **segregado** — não é do Treasury e não existe função para movê-lo. A DAO gasta da fee, nunca do lastro.

E distribui, via propostas:

- Subsídios para usuários novos (`UserSubsidy`).
- Vesting para o time (`TeamVesting`).
- Financiamento de operações off-chain (opex).

Além do Treasury, a fee alimenta mais dois destinos configuráveis no router: `buybackRecipient` (40% — recompra contínua de GOV) e `grantsRecipient` (20% — grants pro ecossistema). No MVP dev os três recipients apontam pro Treasury; os eventos `PaymentRouted` carregam o detalhamento por parcela mesmo assim.

> **Legado (pós-CLP, pré-remodel)**: os três loops antigos do Treasury — FFP buyback de CREDIT, POL refill e fallback do gauge — pertencem ao trilho burn-to-mint e estão descritos nas páginas [Treasury](../08-contracts-reference/04-Treasury.md) e [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md). Com CREDIT estável via PSM, defesa de floor e liquidez de pool deixam de ser necessárias.

## Invariante econômica de saúde

Sinais de saúde do protocolo no modelo vigente:

1. **GMV crescente**: `grossVolumeOf` somado entre projetos (ou indexação de `PaymentRouted`) crescendo rodada a rodada de calendário. É a única fonte de tudo: receita dos apps, renda dos investidores, fee do protocolo.
2. **Receita distribuída crescente**: `totalRevenueDistributed` por projeto — rev-share de fato pago aos investidores.
3. **Lastro do PSM íntegro**: `backingNormalized() >= mintedOutstanding` — invariante I-PSM1, verificável por qualquer um a qualquer momento.
4. **Rodadas de funding fechando com sucesso**: razão Funded/Failed alta indica que investidores confiam nos projetos listados.

O sintoma terminal continua o mesmo do modelo antigo: **GMV indo a zero por muito tempo** — sem uso real, não há receita para ninguém.

Métricas completas em [Métricas que importam](../06-for-investors/04-metrics-that-matter.md).

---

**Próximo →** [Como participar](../04-for-users/01-participate.md)
