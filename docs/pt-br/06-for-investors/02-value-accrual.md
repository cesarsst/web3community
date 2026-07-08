# Value accrual

**Para quem é:** leitor avaliando a arquitetura econômica do protocolo.
**Pré-requisitos:** [Tokenomics](01-tokenomics.md), [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

> **Aviso**: esta página descreve **mecanismos on-chain** pelos quais valor transita no protocolo. Não é recomendação, projeção nem promessa. Exposição a GOV ou CREDIT envolve riscos descritos em [Riscos e segurança](03-risk-and-security.md).

## Onde o valor entra

A única fonte de **valor externo** no sistema é o usuário final que compra CREDIT (em DEX externa, com stable, ETH, etc.) porque quer usar os apps do ecossistema.

Se **zero** usuários comprarem CREDIT para usar os apps, nenhum mecanismo descrito abaixo produz valor. A sustentação do protocolo depende da utilidade oferecida pelos apps listados.

## Caminhos pelos quais CREDIT adquire pressão de compra

1. **Consumo nos apps**: usuário precisa de CREDIT para pagar serviços. Compra em DEX, gera pressão de compra.
2. **Retenção pelos apps**: apps recebem rebate em CREDIT (10% default) e emissão via stake (se stakaram). Enquanto não vendem, retiram CREDIT de circulação em DEX.
3. **Retenção pelos stakers**: stakers recebem CREDIT como reward. Quem segura (em vez de vender imediatamente) retira CREDIT de circulação.
4. **Subsídios pela DAO**: `UserSubsidy` distribui CREDIT pré-financiado do Treasury para primeiros usuários. Isso **não cria demanda**, mas cria usuários iniciais que podem gerar demanda recorrente após o subsídio.
5. **Buyback de CREDIT (FFP)**: `Treasury.executeBuyback(usdcAmount, minCreditOut)` é **real** — compra CREDIT com USDC do Treasury (swap Uniswap V3) e **queima imediatamente** o CREDIT comprado (`burnByRole`). O preço vem do `CreditPriceOracle` (TWAP Uniswap V3 CREDIT/USDC + sanidade Chainlink USDC/USD). Só executa via proposta DAO e sob condições on-chain: spot TWAP abaixo do floor FFP por pelo menos `triggerDurationSecs` (default 24h), USDC sem depeg, cap por evento (default 20% das reservas) e cap mensal (default 30% do snapshot). Pressão de compra + redução de supply no mesmo ato.

## Caminhos pelos quais CREDIT sai de circulação

1. **Burn em pagamentos**: principal. 70% default de cada pagamento é queimado via `BurnTracker.burnAndRecord` → `CreditToken.burnByRole` (split Fase 0: 70% burn / 20% treasury / 10% rebate).
2. **Burn por buyback**: cada `executeBuyback` queima 100% do CREDIT comprado — não recicla para o Treasury.
3. **Burn por retenção** (indireto): mesmo sem queimar, CREDIT retido por apps/stakers/DAO está "fora" do float em circulação. Os 20% do split que vão ao Treasury também saem do float enquanto não são gastos via proposta.

## Dinâmica de supply

Com `alpha = 0.95`:

```
supply_R = supply_{R-1} + emissao_R - burn_R
         = supply_{R-1} + 0.95 * burn_{R-1} - burn_R
```

Se `burn_R ≈ burn_{R-1}` (uso estável):

```
supply_R ≈ supply_{R-1} - 0.05 * burn_R
```

Ou seja, supply cai em ~5% do burn de cada rodada.

Se o uso está crescendo (`burn_R > burn_{R-1}`), o supply ainda pode cair mas menos rápido. Se está encolhendo, pode cair mais rápido (emissão baseada em burn antigo, menor, enquanto burn novo é maior — improvável mas possível).

> **Sobre números da simulação.** A simulação de 52 rodadas em `scripts/simulation/` reporta supply caindo **~3.8%** no cenário base. Esse valor absoluto vem de um cenário hipotético com supply inflado (70.4M CREDIT inicial, via `Charlie_seed = 60M` em `scripts/simulation/economicSim.ts:72`) e 1M burn/round constante — **não promete comportamento de mainnet**, onde o supply operacional começa em 10M (genesis real). A dinâmica qualitativa (deflação sustentada se burn se mantém constante, com `alpha < 1`) é o resultado relevante.

## Caminhos pelos quais GOV adquire pressão de compra

1. **Stakers comprando GOV em DEX externa** para stakar em projetos (quanto mais otimistas sobre o protocolo, mais GOV stakado).
2. **Apps comprando GOV** para stakar no próprio projeto e capturar emissão — a via (B) descrita em [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).
3. **Novos projetos comprando GOV** para cumprir `minCollateral` (10.000 GOV por listagem).
4. **Programas de recompra de GOV aprovados pela DAO** — atenção: **não há mecanismo dedicado on-chain para GOV**. O `Treasury.executeBuyback` compra e queima **CREDIT**, não GOV. Recompra de GOV exigiria propostas usando as transferências genéricas do Treasury.

## Caminhos pelos quais GOV sai de circulação

1. **Staking**: GOV trancado em `Staking` por até 365+ dias, multiplicador de peso em função do lock.
2. **Colateral em projetos**: GOV trancado em `ProjectRegistry` até `removeProject`.
3. **Vesting**: GOV trancado em instâncias de `TeamVesting` até liberação gradual.
4. **Holding simples**: GOV parado na wallet para votar.

GOV **não é queimado**. O cap de 100M é a quantidade máxima que existirá.

## Captura de valor por perfil de participante

### Usuário final

Captura o **serviço do app**. O valor está fora do protocolo — é o que o app entrega em troca do CREDIT pago.

### App listado

Três vetores combinados:

- **(A) Rebate direto**: 10% (default) de cada pagamento. Fluxo de caixa operacional imediato.
- **(B) Stake no próprio projeto**: se o app também stakou GOV no próprio `projectId`, captura fatia da emissão proporcional ao peso. Pode ser significativa — ver exemplo numérico em [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).
- **(C) Apreciação do CREDIT retido**: se supply cai, o CREDIT não-vendido vale mais em termos reais.

### Staker

Captura emissão do RewardDistributor, proporcional ao peso do seu stake dentro do projeto × share do projeto no burn total da rodada.

Fórmula (matemática do `RewardDistributor` V1, onde 100% da emissão vai para stakers):

```
amount = total_emission
       × (burn_do_projeto / burn_total)       // share do projeto
       × (meu_peso / peso_total_do_projeto)   // minha fatia no projeto
       × (1 ou 1/4 se probation)              // penalidade
```

Sob o `RewardDistributorV2` (Fase 1.4 do pivot CLP, ativado por migração de governança), a emissão é dividida em 4 buckets antes dessa conta — default `[5500, 2500, 1500, 500]` bps = **55% stakers** / 25% LPs / 15% apps / 5% bonders. Ou seja, substitua `total_emission` por `0.55 × total_emission` na fórmula acima.

Reward é em CREDIT. Staker pode vender (pressão de venda) ou reter.

Importante: **o staker também assume risco** — lock de 14 a 365+ dias em GOV, possibilidade de o projeto escolhido não gerar burn, etc. Ver [Riscos](03-risk-and-security.md).

### Holder de GOV sem stake

Captura direito de voto. Exposição indireta à dinâmica agregada — se o protocolo cresce e GOV passa a ser demandado (stakers novos, apps novos, buybacks), GOV pode valorizar. Se o protocolo morre, GOV perde utilidade.

## Mecanismo deflacionário — por que não é Ponzi

Ponzi característico: emite-se token novo para pagar holders antigos sem contrapartida real. Aqui:

- Emissão depende de burn real.
- Burn vem de pagamentos reais dos usuários.
- Pagamentos acontecem porque usuários compram CREDIT para usar apps.
- Usuários compram CREDIT porque querem os serviços dos apps.

Se qualquer elo da cadeia quebra (apps sem utilidade, usuários não existem, CREDIT sem demanda), a emissão colapsa junto com o burn. O protocolo desacelera — **mas não implode** simplesmente porque alguém saiu.

O que **acontece** se ninguém usa:

- Burn → 0.
- Emissão pela fórmula principal → 0 (depois do floor se esgotar no round 24).
- Stakers param de entrar (sem reward).
- Protocolo fica zumbi — contratos rodando mas sem atividade.

O que **não acontece**:

- O protocolo não promete reward fixo. Não há obrigação contratual de pagar stakers X% ao ano.
- Não há contraparte "de último recurso" que paga reward se burn for zero.
- Não há saída caótica ("banco quebrou") — cada staker pode unstake quando o lock expirar.

## Mecanismos de salvaguarda

Três salvaguardas impedem patologias:

1. **Floor decay** (rodadas 0-23): emissão mínima durante bootstrap. Dá tempo para atrair usuários. Depois some — forçando o ecossistema a andar com as próprias pernas.

2. **Sanity cap por (rodada, projeto)**: impede wash-burn por projeto malicioso.

3. **Probation penalty** (25% share): projetos novos capturam 25% da sua share por 30 dias. Desincentiva fraudes de listagem rápida.

## Não há garantia de valor

Nenhum mecanismo garante:

- Que GOV vai valorizar.
- Que CREDIT vai manter poder de compra.
- Que o uso dos apps vai crescer.
- Que um staker vai "lucrar".

A arquitetura alinha incentivos com uso real. Se o uso existir, o sistema opera conforme projetado. Se não existir, a emissão (e portanto o incentivo econômico) colapsa. **Produto ruim não é salvo por tokenomics.**

## Pontos a observar antes de qualquer exposição

- Saúde do uso dos apps (via `BurnTracker.getTotalBurnForRound`).
- Crescimento ou decréscimo de staking (via `Staking.totalStaked` e `getGlobalWeight`).
- Propostas recentes no Governor (sinal de direção política).
- Distribuição real do GOV (apenas a genesis do Treasury pós-deploy, ou já houve alocações para time / venda pública / liquidez?).
- Liquidez do CREDIT em DEX externa (pode sair quando quiser?).

Ver [Métricas que importam](04-metrics-that-matter.md).

---

**Próximo →** [Riscos e segurança](03-risk-and-security.md)
