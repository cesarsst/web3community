# Value accrual

**Para quem é:** leitor avaliando a arquitetura econômica do protocolo.
**Pré-requisitos:** [Tokenomics](01-tokenomics.md), [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).

> **Aviso**: esta página descreve **mecanismos on-chain** pelos quais valor transita no protocolo. Não é recomendação, projeção nem promessa. Exposição a GOV ou a posições de rev-share envolve riscos descritos em [Riscos e segurança](03-risk-and-security.md).

> **Remodel 2026-07-08**: o eixo de acúmulo de valor mudou. **CREDIT é estável (1:1 USDC via PSM) e não acumula valor** — quem acumula é o **GOV** (buyback contínuo financiado pela fee) e a **posição de rev-share** (renda de receita real via ProjectFunding). Mecanismos deflacionários de CREDIT abaixo estão marcados como legado.

## Onde o valor entra

A única fonte de **valor externo** no sistema é o usuário final que converte USDC em CREDIT no `CreditPSM` porque quer usar os apps do ecossistema.

Se **zero** usuários comprarem CREDIT para usar os apps, nenhum mecanismo descrito abaixo produz valor. A sustentação do protocolo depende da utilidade oferecida pelos apps listados. Isso não mudou com o remodel — mudou apenas **quem captura** o valor gerado.

## CREDIT não acumula valor — por desenho

Desde o remodel, CREDIT é meio de pagamento estável:

- **Preço**: 1 CREDIT = 1 USDC, sempre, garantido pelo PSM (compra e resgate 1:1, sem taxa).
- **Sem pressão de compra/venda a modelar**: não há pool, não há float especulativo, não há tese de apreciação.
- **Risco de CREDIT** ≈ risco do lastro (USDC) + risco de contrato do PSM (imutável, sem função de saque — invariante I-PSM1).

Quem quer exposição ao crescimento do ecossistema **não compra CREDIT** — compra GOV ou financia projetos.

> **Legado (pré-remodel)**: pressão de compra via consumo/retenção/burn de 70% por pagamento, FFP buyback com queima e dinâmica `supply_R ≈ supply_{R-1} - 0.05 × burn_R` pertencem ao modelo burn-to-mint. A simulação de 52 rodadas em `scripts/simulation/` descrevia essa dinâmica.

## A renda do investidor: rev-share de receita real

O ativo de renda do modelo vigente é a **posição de funding** no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md):

1. O investidor staka GOV no projeto (gate) e investe CREDIT na rodada (shares 1:1).
2. A cada `FeeRouterV2.pay`, o rev-share do projeto (1-30% da receita bruta, fixado na rodada) é creditado pro-rata às shares.
3. `claim` saca a qualquer momento (exige manter o GOV stakeado; o acumulado nunca expira).

**Propriedades**:

- **Renda real, não emissão**: cada CREDIT recebido veio de um pagamento de usuário. Zero inflação.
- **Transparência total**: `grossVolumeOf` (GMV), `totalRevenueDistributed` (já pago), `pendingRevenue` (a sacar) — tudo on-chain, sem indexador.
- **Yield ilustrativo** (não é promessa): rodada de 10.000 CREDIT a 8% de rev-share com GMV de 2.000/mês → 1.920/ano ≈ 19,2% a.a.; rodada de 50.000 a 12% com GMV de 5.000/mês → 14,4% a.a. O yield real depende 100% da receita do app.
- **Risco**: capital não é devolvido (compra-se o fluxo, não um bond); projeto sem receita = renda zero; all-or-nothing protege só na fase de captação (refund integral se a rodada falha).

## Caminhos pelos quais GOV adquire pressão de compra

1. **Buyback contínuo financiado pela fee** — mecanismo **dedicado e automático de funding**: 40% da fee de cada pagamento (= 1% do GMV) vai para o `buybackRecipient` do FeeRouterV2. Pressão de compra proporcional ao uso real, pagamento a pagamento — não depende de proposta por evento.
2. **Stakers/investidores comprando GOV** para stakar em projetos — agora obrigatório para **investir** em rodadas e sacar rev-share (gate do ProjectFunding).
3. **Novos projetos comprando GOV** para cumprir `minCollateral` (10.000 GOV por listagem).
4. **Programas adicionais aprovados pela DAO** via transferências do Treasury.

(Legado: o `Treasury.executeBuyback` do FFP comprava e queimava **CREDIT**, não GOV — pertence ao trilho antigo.)

## Caminhos pelos quais GOV sai de circulação

1. **Staking**: GOV trancado em `Staking` por até 365+ dias, multiplicador de peso em função do lock.
2. **Colateral em projetos**: GOV trancado em `ProjectRegistry` até `removeProject`.
3. **Vesting**: GOV trancado em instâncias de `TeamVesting` até liberação gradual.
4. **Holding simples**: GOV parado na wallet para votar.

GOV **não é queimado**. O cap de 100M é a quantidade máxima que existirá.

## Captura de valor por perfil de participante

### Usuário final

Captura o **serviço do app**. O valor está fora do protocolo — é o que o app entrega em troca do CREDIT pago. Bônus do remodel: paga com moeda estável, sem slippage nem risco de preço.

### App listado

- **Receita direta na hora**: ~97,5% de cada pagamento (fee 2,5%); ~89,5% se tiver rodada financiada com rev-share de 8%.
- **Capital antecipado**: rodada all-or-nothing no ProjectFunding, custo de capital ~19% a.a. no exemplo ilustrativo — comparável a revenue-based financing (Pipe/Clearco: 15-25%) e sem diluição de equity.
- **Hub + base de usuários + trilho pronto** (PSM + FeeRouterV2).

(Legado: rebate de 10%, push de bucket apps e apreciação de CREDIT retido pertencem ao modelo antigo.)

### Investidor (staker de GOV + funder de CREDIT)

Captura **% da receita bruta real** do projeto financiado, a cada pagamento:

```
minha_renda_por_pagamento = amount
       × revShareBps / 10000                  // rev-share da rodada (1-30%)
       × (minhas_shares / total_shares)       // pro-rata do que investi
```

Renda em CREDIT estável (resgatável 1:1 no PSM). Requer GOV stakeado no projeto para investir e para sacar — o lock de 14-365+ dias do staking continua valendo.

Importante: **o investidor assume risco real** — o retorno depende da receita futura do app; o principal não é devolvido. Ver [Riscos](03-risk-and-security.md).

(Legado: a fórmula de claim por emissão/burn do `RewardDistributor` V1/V2 — com buckets 55/25/15/5 — segue documentada nas páginas dos contratos, para claims históricos.)

### Holder de GOV sem stake

Captura direito de voto **e** o efeito do buyback contínuo: 40% da fee de todo pagamento do ecossistema (= 1% do GMV) financia recompra de GOV. Se o GMV cresce, a pressão de compra cresce junto. Se o protocolo morre, GOV perde utilidade.

## Por que não é Ponzi

Ponzi característico: emite-se token novo para pagar holders antigos sem contrapartida real. Aqui, desde o remodel, **não existe emissão nenhuma como renda**:

- A renda do investidor é fatia de pagamento real de usuário (rev-share).
- CREDIT novo só nasce 1:1 contra USDC depositado no PSM.
- O buyback de GOV é financiado por fee sobre pagamentos reais.
- Não há promessa de retorno: sem receita do app, o rev-share paga zero.

Se qualquer elo quebra (apps sem utilidade, usuários não existem), a renda seca **imediatamente e proporcionalmente** — não há esquema para desabar, porque não há passivo lastreado em entrada de novos participantes.

O que **acontece** se ninguém usa:

- GMV → 0, rev-share → 0, fee → 0 (sem buyback, sem opex).
- Investidores ficam com posições que não rendem; CREDIT continua resgatável 1:1 no PSM.
- Protocolo fica zumbi — contratos rodando mas sem atividade.

O que **não acontece**:

- Não há APY prometido nem contraparte de último recurso.
- Não há corrida bancária no CREDIT: o lastro é 100% e o PSM não tem função de saque — o resgate 1:1 independe de "liquidez de mercado".
- Não há confisco: `claim` acumulado nunca expira; refund é integral em rodada falha.

## Mecanismos de salvaguarda

1. **All-or-nothing** na captação: o dono só recebe se bater o alvo; caso contrário, refund de 100% — ninguém financia pela metade um projeto inviável.
2. **Gate de GOV stakeado** (invest + claim): investidor precisa ter pele em jogo de longo prazo no projeto; desalinha ataques de capital oportunista.
3. **Teto duro da fee** (`FEE_BPS_CAP = 500`): nem governança consegue transformar o trilho em pedágio confiscatório.
4. **Lastro segregado do PSM** (I-PSM1): a DAO não alcança o colateral dos usuários — gasta apenas da fee.
5. **Bounds imutáveis do funding**: rev-share 1-30%, prazo 1-90 dias — protegem investidor e dono de termos degenerados.

(Legado: floor decay, sanity cap e probation penalty protegiam o trilho de emissão.)

## Não há garantia de valor

Nenhum mecanismo garante:

- Que GOV vai valorizar (buyback gera pressão proporcional ao uso, não preço-alvo).
- Que uma posição de rev-share vai se pagar (depende 100% da receita futura do app).
- Que o uso dos apps vai crescer.

O que **é** garantido por construção: o resgate 1:1 do CREDIT contra o lastro do PSM (enquanto USDC valer 1 USD) e os bounds imutáveis acima.

A arquitetura alinha incentivos com uso real. Se o uso existir, o sistema opera conforme projetado. Se não existir, a renda seca. **Produto ruim não é salvo por tokenomics.**

## Pontos a observar antes de qualquer exposição

- GMV dos projetos (via `FeeRouterV2.grossVolumeOf` e eventos `PaymentRouted`).
- Receita já distribuída e pendente (via `ProjectFunding.totalRevenueDistributed` / `pendingRevenue`).
- Lastro do PSM (`backingNormalized()` vs `mintedOutstanding`).
- Razão Funded/Failed das rodadas de captação.
- Crescimento ou decréscimo de staking (via `Staking.totalStaked` e `getGlobalWeight`).
- Propostas recentes no Governor (sinal de direção política).
- Distribuição real do GOV (apenas a genesis do Treasury pós-deploy, ou já houve alocações para time / venda pública / liquidez?).

Ver [Métricas que importam](04-metrics-that-matter.md).

---

**Próximo →** [Riscos e segurança](03-risk-and-security.md)
