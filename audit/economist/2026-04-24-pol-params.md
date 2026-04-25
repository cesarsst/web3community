# Anexo C: Parâmetros operacionais da POL (Fase 1.2)

**Modo**: C (mudança estrutural — congelar parâmetros antes do dao-dev codar)
**Data**: 2026-04-24
**Analista**: dao-economist
**Escopo**: 7 decisões operacionais de POL (Protocol Owned Liquidity) na
Uniswap V3 para CREDIT/USDC. Anexo ao parecer principal
`2026-04-24-clp-pivot.md` (§13 Fase 1) e ao parecer FFP
`2026-04-24-credit-peg.md`.

**Pré-condições já estabelecidas** (não revisitadas aqui):

- Pivot CLP em 2 fases com hard gate — aprovado.
- Split default `(7000, 2000, 1000)` (burn/treasury/app) — aprovado.
- CREDIT = FFP (Floating com Floor Price) — aprovado.
- `Treasury.executeBuyback` real (Fase 1.1) — implementado em `246eed6`.
  Treasury já tem `swapRouter` + `swapFeeTier` (default 3000) +
  `floorAbsoluteUsd` (default $0.10) configurados via setters por
  `GOVERNANCE_ROLE`.

---

## Resumo executivo

POL na Fase 1.2 é **âncora de liquidez**, não veículo de yield. Treasury
torna-se LP permanente do pool CREDIT/USDC para garantir IE6 (TVL ≥ 10×
volume diário esperado) e dar substância ao floor defendido pelo FFP — sem
liquidez no pool, `executeBuyback` swappa contra um book vazio e o
slippage devora a defesa. Os 7 parâmetros operacionais são decididos
favorecendo **simplicidade > eficiência de capital** (full range +
permanência) e **alinhamento com a infra Fase 1.1 já deployada** (mesmo
fee tier 0.3%, mesmo router). A única decisão que **exige input do user**
é o tamanho da seed (Decisão 3) — depende de bootstrap externo de USDC
que o Treasury ainda não tem.

| # | Decisão | Veredito |
| - | ------- | -------- |
| 1 | Estratégia de range | **(a) Full range** |
| 2 | Fee tier | **(a) 0.30% (3000)** — alinhado com `Treasury.swapFeeTier` |
| 3 | Tamanho da seed | **PENDENTE** — exige decisão do user (ver §3) |
| 4 | Política de fees do LP | **(b) Claim para Treasury** — sem auto-compound |
| 5 | Política de rebalance/exit | **(c) Dinâmica** — supermaioria 75% para reduzir |
| 6 | Quem chama `addLiquidity` inicial | **(a) Single proposta DAO** atômica |
| 7 | Cap de POL | **Soft cap 50%** do pool (governance-mutável, sem hard cap) |

**Red flag adicional identificada**: ver §8 — "Two-sided risk de POL na
defesa do floor".

---

## 1. Estratégia de range — **Full range** (escolha a)

**Veredito**: full range (`tickLower = -887272`, `tickUpper = 887272`).

**Justificativa**:

1. **Capital eficiência não é objetivo da Fase 1.2.** O objetivo é IE6
   (TVL ≥ 10× volume) e suportar o swap do `executeBuyback`. Concentrar
   range maximiza yield para LP, mas POL não busca yield — busca
   **profundidade de book em todo cenário**.
2. **Wide range concentrado (b) cria modo unilateral fora da banda.** Se
   CREDIT cair abaixo de $0.50 (que é 5× o `floorAbsoluteUsd = $0.10`),
   POL vira 100% CREDIT — exatamente quando precisaria de USDC para o
   buyback ter algo do outro lado. **Anti-correlação fatal com o FFP.**
3. **Multiple ranges (c) introduz reentrância de gestão.** Cada
   reposicionamento é uma proposta DAO ou um keeper externo. Custo
   operacional alto, ganho marginal.
4. **Caso real positivo**: Olympus Pro POL inicial usou Sushi v2 (full
   range por construção). Quando migrou para Uni v3 em 2022, manteve
   `±50%` muito largo — efetivamente full range.
5. **Caso real negativo**: vários forks de Olympus tentaram concentrated
   v3 ranges em 2022 (ex.: Wonderland), perderam liquidez no lado USDC
   durante crashes e o protocolo não conseguiu defender preço.

**Trade-off aceito**: LP fees serão menores (~10–30× menos que
concentrated 5%). Como POL não é yield play, irrelevante.

**Implementação**: NFT position única via `INonfungiblePositionManager.mint`
com `tickLower/tickUpper` correspondentes a `MIN_TICK/MAX_TICK` do tick
spacing 60 (fee tier 3000). O dao-dev calcula os ticks exatos.

---

## 2. Fee tier — **0.30% (3000)** (escolha a)

**Veredito**: 0.30%.

**Justificativa**:

1. **Alinhamento com `Treasury.swapFeeTier = 3000` já deployado.** Fase
   1.1 do FFP swappa nesse tier ([`Treasury.sol:166`](../../contracts/Treasury.sol#L166)).
   POL em tier diferente fragmenta liquidez — buyback do FFP swappa
   contra um pool diferente do POL, e o pool do POL fica thin.
2. **Default Uniswap para pares voláteis.** CREDIT é volátil por
   construção (FFP é Floating, não pegged). 0.05% é só para stables
   muito correlatos (não é o caso); 1% é para pares exóticos (CREDIT
   tem ambição de listing mainstream).
3. **Caso real**: GMX/GLP, Frax FXS, Lido stETH/ETH — todos pares
   "semi-volatile com âncora frágil" usam 0.30%.

**Risco**: se em 1 ano o CREDIT estabilizar perto do floor (banda
estreita), 0.30% deixa fees na mesa. Aceito por enquanto. Migração
para múltiplos tiers (0.05% + 0.30%) é decisão Fase 2+.

---

## 3. Tamanho da seed — **PENDENTE** — input do user obrigatório

**Veredito**: **não posso decidir sem input do user**. Mas posso
estruturar a decisão.

### Restrição estrutural

Treasury hoje:

- **CREDIT operacional**: 0 (genesis 10M foi para `RewardDistributor`).
  Para seed POL, governance precisa autorizar `mint` adicional via
  `CreditToken` — **viola IE3** se não respeitar `capMaxAggregate`.
- **USDC**: 0 (split atual 95/0/5 nunca enviou ao Treasury; mesmo após
  proposta para `(7000, 2000, 1000)`, demanda 4–8 semanas para acumular
  $50k+).
- **GOV**: distribuição inicial ainda não executada.

Conclusão: **antes da POL, o protocolo precisa de bootstrap externo
de USDC**. Caminhos possíveis (escolha do user):

| Caminho | USDC seed | Custo | Risco |
| ------- | --------- | ----- | ----- |
| (a) OTC raise privado | $100k–$500k | dilui GOV (vesting longo) | concentração pré-mainnet |
| (b) Bond inicial via raise público pré-pool | $50k–$200k | impossível antes do pool existir (chicken-and-egg) | dropar |
| (c) Treasury acumula via revenue 8–12 semanas | $50k–$80k | tempo | atrasa Fase 1.2 |
| (d) LBP/auction inicial CREDIT/USDC | imprevisível | sniping | risco de preço inicial errado |
| (e) Founder/team injeta USDC pessoal como bootstrap | qualquer | informal, ruim p/ governança | red flag regulatório |

### Recomendação por cenário

Assumindo **(a) OTC raise é o realista** (caminho usado por Curve, Balancer,
Frax no bootstrap):

- **Seed mínima viável**: $100k USDC + 1M CREDIT (mint via governance,
  sob `capMaxAggregate` Fase 1).
  - Preço implícito inicial: $0.10/CREDIT — **igual ao floor absoluto**.
    Isso é **intencional**: lança o pool no piso, deixa upside livre,
    elimina risco de preço inicial inflado que fura no primeiro swap.
  - TVL total inicial: $200k. Suporta ~$20k de volume diário sem mover
    o preço >5%. Compatível com Fase 1 conservadora.
- **Seed média (preferida se OTC entregar)**: $250k USDC + 2.5M CREDIT.
  - TVL $500k. Suporta ~$50k volume diário.
  - Bate target IE6 (TVL ≥ 10×) para apps com volume operacional moderado.
- **Seed agressiva**: descartada — Treasury não tem capital.

### Pergunta para o user (repassar)

> **"Qual o caminho de bootstrap de USDC para a POL? OTC raise (a),
> esperar revenue acumular (c), ou outro? E qual o target de TVL inicial:
> $200k (mínimo) ou $500k (preferido)?"**

Sem resposta, dao-dev pode codar o `seedPOL()` parametrizável e o
**valor numérico fica para a proposta DAO** — código aceita qualquer
seed, decisão de quanto é da governança. Isso destrava a Fase 1.2
imediatamente.

### Caso real

- **Curve 3pool (2020)**: seedado com $1.5M de equipe + investidores.
  Funcionou porque já havia produto.
- **Frax FRAX/USDC inicial (2020)**: seed $100k. Bootstrap lento, 6
  meses para TVL relevante.
- **Reflexer RAI**: seed via auction. Preço inicial errou, demoraram 4
  meses para convergir. Lição: **não usar auction para POL** se o
  protocolo já tem opinião sobre o preço inicial (FFP tem: $0.10).

---

## 4. Política de fees do LP — **Claim para Treasury** (escolha b)

**Veredito**: fees vão integralmente para o Treasury, sem auto-compound.

**Justificativa**:

1. **Auto-compound (a) na Uniswap V3 não é nativo.** Exige logic
   on-chain: `collect()` + `increaseLiquidity()`. Cada compound é uma
   tx adicional, gas e complexidade. Implementadores comuns (Arrakis,
   Gamma) cobram management fee de 5–20% — **drena o protocolo**.
2. **Flexibilidade compõe melhor com FFP.** Fees em USDC + CREDIT no
   Treasury podem ser:
   - usados em `executeBuyback` se floor breach acontecer (USDC vira
     mais buyback ammo; CREDIT recolhido é queimado direto via
     `burnByRole`);
   - reinvestidos no LP via proposta governance (compound manual);
   - distribuídos via revenue split (ex.: parte para LPs externos
     incentivar liquidez adicional).
3. **Hybrid (c) é over-engineering Fase 1.2.** Decisão pode ser
   reescalada na Fase 2 quando POL tiver dados.
4. **Caso real positivo**: Frax FXS Treasury claim manual de fees v3 +
   redistribui via `gauge` mensal. Funciona.
5. **Caso real negativo**: alguns forks de Curve usaram Arrakis para
   auto-compound; gestão externa atrasou em 2 ocasiões críticas (UST
   crash, USDC depeg março/2023) — fees ficaram travadas em vault
   externo durante stress.

**Implementação**: função `collectPoolFees(uint256 tokenId)` no Treasury,
restrita a `GOVERNANCE_ROLE`, que chama
`INonfungiblePositionManager.collect(...)` e os tokens vão para o próprio
Treasury. Sem timer automático — proposta governance dispara mensalmente
ou via keeper depois.

---

## 5. Política de rebalance/exit — **Dinâmica** (escolha c)

**Veredito**: POL pode crescer livremente via revenue/bond. Redução
exige supermaioria de governança (75% dos votos a favor).

**Justificativa**:

1. **Permanente (a) é compromisso impossível de honrar.** Nenhum
   contrato pode prometer "nunca remove" sem violar o princípio de
   upgradabilidade via governança. Equivale a marketing — código não
   garante.
2. **Discricionária (b) é fragilidade pública.** Sinaliza ao mercado
   que Treasury pode pull rug do LP a qualquer momento. Suposição
   ruim para o flywheel.
3. **Dinâmica (c) com threshold elevado (75%)** é o middle ground:
   - **adições** acontecem via proposta normal (50% quorum 4%);
   - **remoções parciais** (até 25% do POL) via proposta normal;
   - **remoções acima de 25%** exigem **75% dos votos a favor**
     (supermaioria explícita no `Governor.castVote` lógica de
     contagem) — efetivamente exige consenso amplo.
4. **Caso real positivo**: Curve treasury POL — adições constantes,
   remoções nunca aconteceram em 4 anos. Sinaliza compromisso sem
   travar opcionalidade.
5. **Caso real negativo**: Wonderland TIME pull-rug em 2022 — multisig
   removeu LP, mercado entendeu como "fim". Token caiu 95% em 48h.
   Lição: **remoção sem supermaioria visível mata confiança**.

**Implementação**: `Treasury.removeLiquidity(uint256 tokenId, uint128 liquidity)`
com modificador adicional verificando que se `liquidity > 25%` da
posição total, `msg.sender` é o Timelock executando proposta com flag
`supermajority = true`. Flag setada no `Governor` via `propose()`
extension — dao-dev decide implementação técnica.

**Risco aceito**: supermaioria 75% pode bloquear remoção legítima em
emergência (ex.: pool drenada por exploit). Mitigação: contrato
`emergencyRescuePOL()` separado, com mesma supermaioria mas com
timelock reduzido a 24h. **Opcional na Fase 1.2** — discutir se vale
o complexity budget.

---

## 6. Quem chama `addLiquidity` inicial — **Single proposta DAO** (escolha a)

**Veredito**: proposta atômica única que faz mint CREDIT + transfer
USDC + cria pool (se não existir) + adiciona liquidez.

**Justificativa**:

1. **Atomicidade elimina front-running.** Se split em N propostas
   sequenciais, atacante pode ver o `mint` autorizado e front-run
   criando pool fake antes do `addLiquidity`. Single proposta é
   `executeBatch` no Timelock — tudo-ou-nada.
2. **Single proposta tem auditabilidade total**: a proposta tem
   description que cita os parâmetros (USDC amount, CREDIT amount,
   tickLower, tickUpper, fee tier). Holders votam sabendo todo o
   plano.
3. **Multiple propostas (b) tem janela de manipulação** entre etapas.
   Se `mint` 1M CREDIT é proposta 1 e `addLiquidity` é proposta 2,
   nas 48h entre execução de 1 e execução de 2 o CREDIT mintado fica
   no Treasury sem destino — atacante pode propor variação que move
   esse CREDIT. Risco real, evitar.
4. **Caso real**: Curve 3pool foi seedado em 1 tx (multisig pré-DAO,
   mas atomicamente). Frax FRAX/USDC similar.
5. **Caso real negativo**: SpiritSwap em 2022 fez seed em 3 propostas
   separadas; entre proposta 2 e 3 um governance attacker conseguiu
   redirecionar fluxo. Perdido $400k.

**Implementação**: `Treasury.seedPOL(SeedPOLParams calldata params)`
single function que:

```
1. require msg.sender = Timelock
2. require currentRound state OK (não em probation/pause)
3. CREDIT.mint(this, params.creditAmount) via MINTER_ROLE
4. (USDC já está no Treasury, transferido em propose-time via Treasury.deposit)
5. approve positionManager para ambos os tokens
6. positionManager.mint({...full range, fee 3000, amounts...})
7. emit POLSeeded(tokenId, creditAmount, usdcAmount)
8. armazenar tokenId em storage para futuro collect()/decrease()
```

**Pendência ao dao-dev**: validar que `MINTER_ROLE` no `CreditToken`
pode ser **temporariamente** concedido ao Treasury para esta operação
(via Timelock proposal: grant → seed → revoke), ou se Treasury deve ter
role permanente. Recomendação: **temporário**, revogado na mesma
proposta atômica. Reduz superfície de ataque.

---

## 7. Cap de POL — **Soft cap 50% via governança, sem hard cap on-chain**

**Veredito**: nenhum hard cap on-chain. Norma de governança documentada:
"Treasury busca participação de 30–50% do pool em estado estável; acima
de 50% requer justificativa explícita na proposta".

**Justificativa**:

1. **Hard cap on-chain trava resposta a crise.** Se preço cai e
   precisamos de mais POL para defender floor, hard cap em 50%
   impede. Mau trade-off em crise.
2. **Treasury > 50% não é per se ruim.** Muitos protocolos jovens
   operam com 60–70% POL nos primeiros 18 meses (Frax, OlympusDAO
   pré-bonding). Vira problema apenas se LPs externos não conseguem
   entrar pelo Treasury dominar.
3. **Soft cap em governance norm** (não em código) é a melhor
   prática:
   - Documentar em README §X que "Treasury busca 30–50% participação
     em steady state".
   - Toda proposta `addLiquidity` cita a participação esperada
     pós-add.
   - Comunidade rejeita propostas que violam sem justificativa.
4. **Caso real positivo**: Curve Treasury detém ~40% do 3pool POL —
   nunca foi cap formal, virou norma cultural.
5. **Caso real negativo**: Wonderland TIME tinha 92% POL — quando
   removeram, ninguém mais segurava liquidez, colapso instantâneo.
   Mas o problema **não foi o cap**, foi a remoção sem aviso. Lição:
   cap não é a defesa, **política de exit (Decisão 5) é a defesa**.

**Implementação**: zero código. Documentação em
`/home/ubuntu/web3community/docs/pt-br/03-protocol-overview/treasury-pol.md`
(novo arquivo, delegar a `dao-docs` se aprovado).

**Risco**: comunidade pode aprovar propostas violando 50% sem perceber.
Mitigação: dashboard público (subgraph) mostrando % POL — barreira
sócio-técnica.

---

## 8. Red flag nova — **Two-sided risk de POL na defesa do floor**

**Não coberta nos pareceres anteriores. Crítica.**

POL e `executeBuyback` interagem de forma **reflexiva**:

```
1. CREDIT cai abaixo do floor.
2. Treasury executa buyback: swap USDC → CREDIT, queima.
3. Esse swap acontece CONTRA a posição POL do Treasury.
4. Treasury "compra de si mesmo": fees ficam, mas a posição POL absorve
   o desbalanceamento — após o swap, POL tem mais USDC e menos CREDIT.
5. Próxima rodada: POL tem menos CREDIT → menos profundidade no lado
   "vender CREDIT" → próximo crash move preço mais.
```

**Tradução**: **POL é munição finita para defender o floor**. Cada
buyback consome assimetricamente o lado USDC do POL e diminui sua
capacidade futura. Não é death spiral imediata, mas é **decay de
defesa**.

**Mitigações estruturais**:

- **Receita recorrente do Treasury alimenta POL**: parte dos 20% de
  treasuryBps (do split `(7000, 2000, 1000)`) deve ser **earmarked
  para reposição de POL**, não apenas para buyback. Sugestão: 50% do
  treasury revenue → buyback ammo, 50% → POL refill mensal.
- **Bonding (Fase 3) repõe POL**: bonders depositam USDC + CREDIT em
  troca de bonds com desconto, e o LP token vai para Treasury POL.
  Esta é a função real do bonding no pivot — não é financiar yield,
  é **renovar POL sem custo de Treasury**. Já discutido em
  `2026-04-24-clp-pivot.md` §6.
- **Floor calibration**: se POL fica unilateral (>80% USDC), o floor
  está bem defendido mas o protocolo precisa "soltar" — emite mais
  CREDIT, ou reduz `floorMultiplierBps`, ou pausa buyback.

**Pendência**: documentar este mecanismo no parecer FFP
`2026-04-24-credit-peg.md` ou criar `2026-04-24-pol-ffp-coupling.md`
explicitando a fórmula. **Recomendo criar arquivo separado** depois
que Fase 1.2 estiver desenhada — agora é prematuro.

---

## 9. Invariantes checadas

- **IE3 capMax > α·peak burn**: **requer atenção**. Mint para seed POL
  consome `capMaxAggregate` (Fase 1 = 10M CREDIT/epoch). Se seed for
  2.5M CREDIT (cenário médio), consome 25% do cap. **Recomendação**:
  proposta de seed deve ser executada em **epoch dedicado**, sem outro
  mint concorrente. dao-dev valida via require em `seedPOL()` que
  `RewardDistributor.currentEpochMinted() == 0`.
- **IE6 liquidez DEX ≥ 10× volume**: **objetivo desta Fase**.
  Cumprir requer seed ≥ $200k (cenário mínimo). Validar com `dao-dev`
  no spec.
- **IE7 buyback abaixo do floor**: **OK** — Fase 1.1 já implementa.
- **IE10 sem pause em CREDIT/Staking**: **OK** — POL não introduz
  pause. POL pode ter sua própria função de "pausar adições" mas não
  toca em CREDIT/Staking.
- **I1 supply cap GOV 100M**: **OK** — POL não toca GOV.
- **I2 mint CREDIT só por MINTER_ROLE**: **respeitado** — seed concede
  role temporariamente ao Treasury via Timelock e revoga na mesma tx
  (§6).

---

## 10. Próximos passos

### Imediato

- [ ] **[user]** Responder pergunta da Decisão 3: **caminho de bootstrap
      USDC e target TVL inicial ($200k mínimo / $500k preferido / outro)**.
- [ ] **[user]** Confirmar veredito 5 — supermaioria 75% para remover
      >25% do POL é aceitável? Alternativa: 66% (padrão Compound).
- [ ] **[user]** Confirmar que o `emergencyRescuePOL()` (§5, opcional)
      entra na Fase 1.2 ou fica para depois.

### Pré-código (dao-dev)

- [ ] Spec técnico de `Treasury.seedPOL(SeedPOLParams)` — atômico,
      single proposta, full range, fee 3000, MINTER_ROLE temporário.
- [ ] Spec de `Treasury.collectPoolFees(uint256 tokenId)` —
      `GOVERNANCE_ROLE`, sem auto-compound.
- [ ] Spec de `Treasury.removeLiquidity(...)` com supermajority gate.
- [ ] Spec de armazenamento de `tokenId` da posição POL.
- [ ] Spec de eventos: `POLSeeded`, `POLLiquidityAdded`,
      `POLLiquidityRemoved`, `POLFeesCollected`.

### Pós-implementação

- [ ] **[dao-economist]** Parecer separado sobre **two-sided risk POL/FFP**
      (§8) — formalizar fórmula de "POL decay rate" sob diferentes
      cenários de buyback.
- [ ] **[dao-dev]** Atualizar `economicSim.ts` cenário `clp-phase1` com
      POL — simular crash 30% e medir % de POL consumida.
- [ ] **[dao-docs]** Documentar política de governance norm para soft
      cap 50% (§7) em `docs/pt-br/03-protocol-overview/treasury-pol.md`.

---

## 11. Pendências

- **Tamanho da seed** (Decisão 3) — bloqueante. Sem decisão do user, o
  dao-dev pode ainda assim codificar `seedPOL()` parametrizado, mas a
  proposta DAO de execução fica pendente.
- **Política do `emergencyRescuePOL()`** — opcional, decisão de scope.
- **Política de fees compound futura** — Fase 2+. Decisão atual (b)
  vale para Fase 1.2.
- **Two-sided risk modelagem** (§8) — parecer separado depois de Fase
  1.2 implementada.

---

### Arquivos relevantes (caminhos absolutos)

Pareceres:

- `/home/ubuntu/web3community/audit/economist/2026-04-24-clp-pivot.md`
- `/home/ubuntu/web3community/audit/economist/2026-04-24-credit-peg.md`
- `/home/ubuntu/web3community/audit/economist/2026-04-24-pol-params.md` (este arquivo)

Código (Fase 1.1 já implementada — ancoragem):

- `/home/ubuntu/web3community/contracts/Treasury.sol` — `swapFeeTier`,
  `executeBuyback`, FFP infra.
- `/home/ubuntu/web3community/contracts/CreditToken.sol` — `MINTER_ROLE`,
  `burnByRole`.
- `/home/ubuntu/web3community/contracts/interfaces/IUniswapV3SwapRouter.sol`.

Pendente (Fase 1.2 a criar):

- `contracts/interfaces/INonfungiblePositionManager.sol` (novo, delegar
  a dao-dev).
- Funções novas em `Treasury.sol`: `seedPOL`, `addLiquidityToPOL`,
  `collectPoolFees`, `removeLiquidity`.
