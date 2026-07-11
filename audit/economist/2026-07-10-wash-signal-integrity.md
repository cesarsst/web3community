# Parecer econômico: integridade de sinal do FeeRouterV2 (wash-payment)

**Modo**: B (falha de incentivo em mecanismo existente)
**Data**: 2026-07-10
**Analista**: dao-economist (análise assistida, simulação numérica reproduzível)
**Escopo**: o modelo pós-remodel (2026-07-08) é **conservativo e à prova de
roubo** — nenhuma invariante permite extrair mais CREDIT do que se injeta. Mas
os **três sinais econômicos derivados** que o protocolo publica — GMV
(`grossVolumeOf`), pressão de buyback de GOV e rev-share acumulado
(`accRevenuePerShare`) — são lidos de `FeeRouterV2.pay` como se **todo volume
fosse orgânico**. Um atacante que controla app + pagador (+ stake) fecha o loop
e falsifica os três por um custo de **2,5% do volume washeado por ciclo**.
Nenhuma invariante cobre isso, porque não é ataque de *valor* (bloqueado por
CEI/conservação) e sim ataque de *sinal/reputação*, que não é on-chain
verificável. Gap identificado em 2026-07-10; não coberto pelo parecer
2026-07-08 (bypass do FeeRouter), que trata do incentivo **inverso** — o app
evitar o roteamento — não do incentivo de **abusar** do roteamento.

---

## 1. Resumo executivo

**O gap é real e é estrutural.** O remodel resolveu o problema de valor
(burn-to-mint, emissão inflacionária, saque de lastro — tudo removido). O que
resta é um problema de **integridade de sinal**: o protocolo derivou toda a sua
narrativa de "utilidade real" de um único número somado cegamente
(`grossVolumeOf[projectId] += amount`), e esse número é o mais falsificável do
sistema.

Com `pay()` circular (o atacante paga o próprio app), a simulação mostra
(§3): custo líquido de **25 CREDIT por 1.000 washeados** (2,5%), caindo a
**15/1.000** (1,5%) se o atacante detém 100% do GOV que financia o buyback.
Um orçamento de fee de **1.000 CREDIT compra 40.000 CREDIT de GMV falso** e
400 de pressão de buyback fabricada. O rev-share circular retorna **100%** ao
atacante que detém as shares — o `revShareBps` da rodada é irrelevante para o
custo dele.

**Veredito**: o modelo é seguro para *custódia de valor* e inseguro para
*curadoria por sinal*. Enquanto GMV e rev-share forem tratados como prova de
tração — em UI, em decisão de investimento de terceiros, em qualquer futura
recompra automatizada ou distribuição indexada a volume — eles superestimam a
utilidade real por um fator arbitrário, limitado apenas pelo apetite do
atacante em queimar 2,5%/ciclo. **É uma pendência de segurança do modelo a
resolver antes do mainnet**, ao lado dos dois bloqueadores já declarados
(auditoria externa e parecer jurídico do rev-share).

---

## 2. Mecânica relevante (verificada no código)

Caminho do valor em `FeeRouterV2.pay(projectId, amount)`
([contracts/FeeRouterV2.sol:170](../../contracts/FeeRouterV2.sol)):

```
pay(projectId, amount)   // msg.sender NUNCA e checado contra owner/appRecipient
  1. CREDIT.safeTransferFrom(msg.sender -> router, amount)
  2. fee      = amount * 250 / 10000                 (2,5%; cap FEE_BPS_CAP=500)
       toTreasury = 40% da fee  -> treasuryRecipient
       toBuyback  = 40% da fee  -> buybackRecipient   [pressao GOV]
       toGrants   = 20% da fee  -> grantsRecipient
  3. revShare = amount * FUNDING.revShareBpsOf(projectId) / 10000
       if revShare>0: transfer -> ProjectFunding; FUNDING.notifyRevenue(id, revShare)
                        -> accRevenuePerShare[id] += revShare*1e18/raised   [sinal rev-share]
  4. toApp    = amount - fee - revShare -> appRecipientOf[id] (ou owner)     [volta ao atacante]
  5. grossVolumeOf[projectId] += amount               [sinal GMV, soma cega]
     emit PaymentRouted(...)
```

Fatos que habilitam o abuso (todos confirmados no código):

- **Sem gate de origem no `pay`.** Não há checagem de `msg.sender` contra
  `owner` nem `appRecipient`. Pagar o próprio app é permitido. Sem rate-limit,
  sem contagem de pagadores únicos, sem anti-sybil.
  [FeeRouterV2.sol:170](../../contracts/FeeRouterV2.sol).
- **GMV é soma bruta.** `grossVolumeOf[projectId] += amount`
  ([L206](../../contracts/FeeRouterV2.sol)). Não pondera origem, não separa
  self-payment, não conta endereços distintos.
- **Rev-share não distingue receita real de circular.**
  `ProjectFunding.notifyRevenue` ([contracts/ProjectFunding.sol:301](../../contracts/ProjectFunding.sol))
  acumula qualquer CREDIT que o router encaminhar. É gated por
  `REVENUE_NOTIFIER_ROLE` (só o FeeRouterV2) — o que impede *inflar sem pagar*,
  mas não impede *pagar a si mesmo*.
- **Gate de GOV é auto-satisfazível.** `invest`/`claim` exigem
  `Staking.getWeight(msg.sender, projectId) > 0`
  ([ProjectFunding.sol](../../contracts/ProjectFunding.sol)). Nada impede
  self-stake: o atacante staka o próprio GOV no próprio projeto e passa no gate.
- **Rev-share circular retorna integral.** Se o atacante detém 100% das shares
  (financiou a própria rodada), `claim` devolve 100% do rev-share que ele mesmo
  gerou. `_fund` também devolve o `raised` ao owner quando `raised==target`
  ([ProjectFunding.sol:237](../../contracts/ProjectFunding.sol)).

## 3. Simulação numérica

Referência: 1 CREDIT = 1 USDC. Parâmetros conferidos em 2026-07-10:
`feeBps=250`, split `40/40/20`, `revShareBps ∈ [100,3000]`. Script reproduzível:
`sim/wash-signal-integrity-sim.js`.

### 3.1 Custo líquido por ciclo (por 1.000 CREDIT washeados)

Atacante = pagador **e** appRecipient. `govShare` = fração do buyback que
retorna a ele como holder de GOV; `sharesSelf=1` (detém todas as shares).

| revShareBps | govShare 0% | govShare 30% | govShare 100% |
| ----------- | ----------- | ------------ | ------------- |
| 0% | **25 (2,50%)** | 22 (2,20%) | 15 (1,50%) |
| 8% | **25 (2,50%)** | 22 (2,20%) | 15 (1,50%) |
| 30% | **25 (2,50%)** | 22 (2,20%) | 15 (1,50%) |

O `revShareBps` **não muda o custo** quando o atacante detém as shares: o
rev-share sai por uma porta e volta pela outra (`claim`). O único custo real é
a fee que escapa para mãos de terceiros (treasury + grants + a parte do buyback
que não é do próprio atacante). Piso teórico do custo: **1,5%** do volume
(atacante que detém 100% do GOV recupera 40% da fee via buyback próprio).

### 3.2 Sinal comprado por orçamento de fee (pior caso p/ o defensor, govShare=0)

| Orçamento de fee | GMV falso gerado | Pressão de buyback fabricada |
| ---------------- | ---------------- | ---------------------------- |
| 100 CREDIT | 4.000 CREDIT | 40 CREDIT |
| 1.000 CREDIT | 40.000 CREDIT | 400 CREDIT |
| 10.000 CREDIT | 400.000 CREDIT | 4.000 CREDIT |

Cada 1 CREDIT de fee gasto imprime **40 CREDIT de GMV falso**. O GMV é o número
que a UI e investidores usam como proxy de tração — e ele custa 2,5% para
fabricar à vontade.

### 3.3 Auto-rodada (financiar a própria rodada e sacar o próprio rev-share)

Sequência 100% autoinfligida, gate de GOV satisfeito por self-stake:

```
1. stake(id, GOV, lock>=14d)              -> getWeight>0
2. openRound(id, target=100, revShareBps=3000, dur)
3. invest(id, 100)                        -> raised==target -> _fund devolve 100 ao owner
4. wash pay(id, X) repetido               -> revShare -> notifyRevenue -> accRevenuePerShare sobe
5. claim(id)                              -> saca 100% do rev-share (unica share)
```

Resultado on-chain: um projeto com status `Funded`, `revShareBpsOf`>0,
`totalRevenueDistributed` crescente e GMV alto — **todos os selos de "app com
tração e investidores"** — sem um único usuário real. Custo: a fee dos ciclos.

## 4. Superfície de dano (quem lê o sinal falso)

O wash não rouba CREDIT. Ele corrompe **decisões que dependem do sinal**:

1. **Investidor de rev-share de terceiros.** Vê GMV e `totalRevenueDistributed`
   altos, entra numa rodada (ou compra shares num app com "tração"), e é
   ruggado quando o volume orgânico se revela zero. É a versão on-chain de
   volume falso de exchange. **Este é o dano mais direto e provável.**
2. **Curadoria por stake.** O peso agregado (`getTotalWeight`) é sinal público
   de respaldo; combinado com GMV falso, um app conluiado parece
   comunidade-validado. Sybil de stake amplifica.
3. **Qualquer automação futura indexada a volume.** A recompra automatizada de
   GOV (hoje pendente — ver [Value accrual](../../docs/pt-br/06-for-investors/02-value-accrual.md))
   e qualquer distribuição de grants proporcional a GMV herdariam a
   falsificação diretamente: wash vira uma bomba de extração de treasury/grants
   se o gasto for indexado ao volume que o próprio atacante fabrica. **Projetar
   a automação sobre o GMV atual, sem sanitização, transforma esta pendência de
   sinal numa pendência de valor.**
4. **Narrativa de tese do GOV.** "buyback proporcional ao GMV" perde significado
   se o GMV é fabricável a 2,5%.

## 5. Por que os mitigadores atuais não bastam

- **Conservação/CEI/ReentrancyGuard**: protegem valor, não sinal. Corretos e
  irrelevantes para este vetor.
- **`REVENUE_NOTIFIER_ROLE` só no FeeRouterV2**: impede inflar o acumulador
  *sem pagar*; não impede *pagar a si mesmo*.
- **Gate de GOV stakeado**: exige skin-in-the-game, mas o skin pode ser o
  próprio GOV do atacante (self-stake). Não é anti-sybil.
- **All-or-nothing no funding**: protege contra financiar pela metade; não tem
  relação com wash pós-funding.
- **Fee 2,5%**: é o **único** freio econômico — e é fraco. 2,5%/ciclo é barato
  para comprar reputação que destrava capital de terceiros muito maior.

## 6. Alavancas de correção (recomendação)

Em ordem de custo de implementação:

1. **Sinais honestos por construção — separar GMV bruto de GMV qualificado**
   (mudança de view, baixo custo). Manter `grossVolumeOf` (auditoria), mas
   expor também um contador de **pagadores únicos** por projeto
   (`uniquePayersOf`) e/ou **volume excluindo self-payment**
   (`if (msg.sender != owner && msg.sender != appRecipient)`). A UI e qualquer
   automação passam a ler o número qualificado. Não impede o wash, mas remove o
   sinal barato — o atacante precisaria de N endereços com CREDIT real (sybil
   custoso), não um loop de dois endereços.
2. **Anti-self-payment explícito** (guarda no `pay`, baixo custo). Reverter (ou
   não creditar GMV/rev-share) quando `msg.sender == owner || msg.sender ==
   appRecipientOf[id]`. Fecha o caso trivial (dois endereços) por construção;
   força o atacante a sybil real. Custo: um app com fluxo legítimo próprio (raro)
   precisa de recipient separado.
3. **Decaimento/janela no GMV** (mudança de desenho). GMV com meia-vida (média
   móvel por janela) em vez de soma monotônica eterna. Um app precisa de volume
   *contínuo* para manter o sinal alto — wash em rajada decai. Interage com o
   desenho de qualquer recompra automatizada (recompra sobre volume-de-janela,
   não acumulado).
4. **Gate anti-sybil no rev-share** (custo alto, caso a caso). Peso mínimo de
   stake por investidor, ou custo de entrada na rodada proporcional ao peso, de
   forma que fabricar N investidores fake tenha custo de capital real travado.
   Não elimina o wash, mas encarece a auto-rodada.
5. **Enforcement de governança** (política, sem código). Processo formal de
   remoção/`Probation` punitiva de projetos com padrão de wash detectado
   off-chain (self-payment on-chain é visível: pagamentos cujo `msg.sender`
   coincide com o `owner`/`appRecipient`). Transforma a detecção em custo
   esperado. Limite: exige vigilância ativa.

**Recomendação executiva**: aplicar **(1) + (2)** antes de expor qualquer
número de volume/receita a decisão de terceiros (UI de investimento incluída) —
são baixo custo e removem o vetor trivial. Tratar **(3)** como pré-requisito
**duro** de qualquer recompra automatizada ou distribuição indexada a GMV: sem
decaimento/qualificação, a automação vira dreno de treasury. **(4)/(5)**
conforme o produto amadurece. Registrar como **pendência de segurança de
modelo pré-mainnet** no BRAIN, ao lado da auditoria externa e do parecer
jurídico do rev-share.

## 7. Limitações da simulação

- Preço CREDIT/USDC fixo em 1:1 (não altera a ordem das estratégias).
- Modela o pior caso para o defensor (atacante controla app+pagador+stake, dois
  endereços). Um wash mais furtivo (N endereços) tem custo maior de setup mas o
  mesmo custo marginal de 2,5%/ciclo.
- Ignora custo de gas (desprezível vs. o sinal comprado em qualquer L2).
- Não modela o valor exato do sinal falso para a vítima (depende do produto);
  o parecer argumenta a *existência* e o *baixo custo* do vetor, não um lucro
  fechado — que é, por natureza, função da credulidade de terceiros.
- Script: `sim/wash-signal-integrity-sim.js`
  (`node audit/economist/sim/wash-signal-integrity-sim.js`; parâmetros
  conferidos no código em 2026-07-10).
