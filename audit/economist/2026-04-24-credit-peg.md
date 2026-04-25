# Parecer econômico: modelo de peg do CREDIT

**Modo**: C (mudança estrutural — define semântica de `Treasury.executeBuyback` Fase 1 e `BondDepository` Fase 3)
**Data**: 2026-04-24
**Analista**: dao-economist
**Escopo**: decisão bloqueante para Fase 0 do pivot CLP. Avaliar
hard peg vs soft peg vs floating vs alternativas híbridas. Definir UM
modelo recomendado com parâmetros numéricos.
**Parecer relacionado**: `/home/ubuntu/web3community/audit/economist/2026-04-24-clp-pivot.md`
(este parecer **complementa** e **resolve a pendência** declarada na §17 daquele documento).

---

## 1. Resumo executivo

**Veredito**: **Floating com Floor Price defendido (FFP)** — modelo híbrido,
nem hard peg, nem floating puro. CREDIT flutua livremente para cima sem
intervenção; Treasury defende um **piso operacional** via buyback-and-burn
quando o preço cai abaixo de 50% da média móvel de 90 dias.

**Por que não as três alternativas óbvias**:

- **Hard peg ($1)**: morte regulatória anunciada (MiCA EMT/ART na UE, GENIUS
  Act nos EUA classificando como stablecoin de pagamento). Exigiria reservas
  1:1 auditadas, KYC operacional, licença de emissor — incompatível com DAO
  permissionless. Além disso, exigiria PSM (Peg Stability Module) com colateral
  externo que o Treasury hoje não tem capacidade de financiar. **Rejeitado**.
- **Soft peg com banda ($0.95–$1.05)**: ainda cai sob escopo regulatório de
  "stablecoin" em jurisdições rigorosas (MiCA art. 3(1)(6) trata
  qualquer "token referenciado a moeda fiduciária com objetivo de estabilidade
  de preço" como ART). Operacionalmente: exige rebalance constante via PSM ou
  algoritmo; FRAX v1 sobreviveu, RAI sobreviveu, mas ambos têm equipes
  dedicadas a defender peg 24/7. Para protocolo jovem, é overhead que mata
  iteração. **Rejeitado**.
- **Floating puro (estilo CRV/UNI)**: solução de menor risco regulatório, mas
  abandona qualquer compromisso com previsibilidade — apps que precificam em
  CREDIT veriam custo nominal oscilar 50%+ semanalmente, repassando ao
  usuário final. Quebra a narrativa "unidade operacional" do CLP. **Rejeitado
  como solução pura, aproveitado parcialmente como base do FFP**.

**Modelo recomendado — FFP**:

```
floor_price(t) = max(0.50 × MA90(price), $0.10)
ceiling: livre (sem intervenção)
trigger: spot_price < floor_price por 24h consecutivas (TWAP 30min)
ação: Treasury.executeBuyback compra CREDIT no mercado, burn imediato
orçamento: max(20% reservas USDC do Treasury, 5% supply circulante CREDIT)
            por evento, hard cap mensal de 30% reservas
oracle: TWAP Uniswap v3 30min + Chainlink USDC/USD sanity
```

**Por que FFP funciona aqui**:

1. **Não é peg legalmente** — CREDIT pode subir indefinidamente; só há defesa
   contra colapso. Análogo a "share buyback discricionário" de empresa, não
   a "promessa de redemption" de stablecoin.
2. **Dimensiona-se naturalmente** — floor caminha com a média móvel; se
   CREDIT consolidar em $5, floor sobe para $2.50. Não há defesa de número
   absoluto.
3. **Compatível com bonding** — bond discount de 10% sobre preço *spot*
   (não sobre peg fictício); BondDepository não precisa de oracle de peg.
4. **Death spiral só ocorre se reservas zerarem** — Iron/Terra morreram
   porque colateral interno (TITAN/LUNA) caía junto com a stable. Aqui
   colateral é USDC externo, não correlacionado com CREDIT. Eliminamos
   o vetor reflexivo.

**Mudanças vs parecer anterior (`2026-04-24-clp-pivot.md`)**:

- **Ponto 4 (bonding)**: ajustado — discount calcula sobre preço spot, não
  sobre peg. Curva de discount permanece (10%→3% em 90d) mas referenciada
  a spot. **Sem alteração de parâmetros numéricos**, apenas semântica
  esclarecida.
- **Ponto 9 (flywheel pessimista)**: **piorado**. Cenário pessimista do
  parecer anterior assumia `executeBuyback` discricionário sem regra
  numérica. Com FFP, buyback é **regrado** e mais ágil — bom no curto
  prazo, mas se reservas USDC do Treasury esgotarem (cap mensal 30% chega a
  zero em ~3 meses de ataque sustentado), floor colapsa. Adicionar mitigação:
  **floor mínimo absoluto $0.10** que permanece mesmo sem reservas — apenas
  via "queima do split FeeRouter" (95% queima atual). Se reservas zeram,
  buyback pausa, mas burn-by-use continua.
- **Pendência §17 "Preço operacional justo do CREDIT"**: **resolvida** por
  este parecer.

Demais 9 pontos do parecer anterior **permanecem inalterados**.

---

## 2. Avaliação detalhada das alternativas

### 2.1. Hard peg ($1 fixo via PSM)

**Descrição**: CREDIT vale exatamente $1, com mecanismo de mint/redeem
permissionless contra USDC. Análogo a USDC (centralizado), DAI (sobre-
colateralizado via CDP), MakerDAO PSM (1:1 com USDC).

**Requisitos**:

- Reservas 1:1 USDC para todo CREDIT em circulação (ou 150%+ de
  sobre-colateralização se via CDPs).
- PSM contract com `mint(USDC) → CREDIT 1:1` e `redeem(CREDIT) → USDC 1:1`.
- Auditoria contínua de reservas (Chainlink Proof of Reserves ou similar).

**Riscos**:

| Risco | Severidade |
| ----- | ---------- |
| Regulatório (MiCA EMT, GENIUS Act, NY BitLicense) | **Crítico** |
| Operacional (manter peg requer monitoramento contínuo) | Alto |
| Death spiral (não — colateral é USDC externo) | Baixo |
| Captura de Treasury (reservas viram alvo de ataque) | Alto |
| Complexidade técnica (PSM + oracle + circuit breaker) | Médio |

**Cases comparáveis**:

- **USDC (Circle)**: hard peg funciona porque há entidade legal que detém
  reservas e responde por eles. Não replicável em DAO permissionless.
- **DAI (MakerDAO)**: funcionou por 4 anos sem PSM, mas em 2020
  MakerDAO **abandonou peg algorítmico puro** e adicionou PSM com USDC.
  Hoje DAI é ~50% USDC-backed — efetivamente um wrapper de USDC. Se você
  vai depender de USDC para peg, **use USDC direto** e não reinvente.
- **TerraUSD (UST)**: hard peg via reflexividade com LUNA. Morte em 3 dias.
  Lição: peg sem colateral externo é suicídio; peg com colateral externo é
  redundância.

**Veredito**: **Rejeitado**. Risco regulatório isolado já mataria. Soma com
custo operacional e ausência de benefício real (apps podem precificar em
USDC se quiserem estabilidade) torna alternativa absurda.

### 2.2. Soft peg com banda ($0.95–$1.05 com tolerância)

**Descrição**: alvo $1, banda de tolerância ±5%, intervenção via PSM ou
algoritmo quando preço sai da banda.

**Requisitos**:

- Mecanismo de defesa simétrico (compra abaixo, vende acima).
- Reservas suficientes para defender banda inferior em pior caso.
- Governança ativa para ajustar banda em condições de mercado extremas.

**Riscos**:

| Risco | Severidade |
| ----- | ---------- |
| Regulatório (ainda enquadrado como ART/EMT em jurisdições estritas) | **Alto** |
| Operacional (defesa simétrica é cara — vender CREDIT acima do peg requer mint extra) | Alto |
| Reflexividade (se reservas baixam e mercado percebe, ataque coordenado quebra peg) | **Alto** |
| Captura de Treasury (mesmo de hard peg) | Médio |

**Cases comparáveis**:

- **FRAX v1**: peg algorítmico-fracional. Sobreviveu 2022 mas com cicatrizes
  — em maio/2022 (UST collapse) FRAX caiu para $0.96 e exigiu intervenção
  manual da equipe via FXS buy-and-burn. Frax Finance tem **15 pessoas em
  tempo integral** defendendo peg. Não replicável em DAO sem operações.
- **RAI (Reflexer)**: "non-pegged stablecoin" — alvo é dinâmico via PID
  controller. Funcionou tecnicamente mas **não conseguiu adoção** —
  complexidade conceitual matou. Lição: usuários querem ou estabilidade
  total ou floating claro; meio-termo confuso é rejeitado.
- **Iron Finance (TITAN)**: soft peg parcialmente colateralizado. Morte em
  72h. Lição definitiva: **se parte do colateral é o próprio token de
  governança, banda quebra na primeira corrida**.

**Veredito**: **Rejeitado**. Pior dos mundos: custo regulatório de
stablecoin + custo operacional de defesa + risco de reflexividade. Sem
equipe dedicada e sem reservas externas robustas, banda colapsa no primeiro
estresse.

### 2.3. Floating livre (sem alvo, estilo CRV/UNI)

**Descrição**: CREDIT é apenas um ERC-20 com supply elástico. Preço é o que
o mercado pagar. Treasury não defende preço.

**Requisitos**: nenhum específico de peg.

**Riscos**:

| Risco | Severidade |
| ----- | ---------- |
| Regulatório | **Baixo** (não é stablecoin) |
| Volatilidade alta — apps repassam ao usuário | **Médio** |
| Death spiral (sem floor algum, queda pode ser ilimitada) | Médio |
| Apps preferem precificar em USDC por previsibilidade | Médio |

**Cases comparáveis**:

- **CRV (Curve)**: floating puro. Volatilidade alta (60%+ anual) mas
  ecossistema funciona porque CRV é *recompensa*, não *unidade operacional*.
  Curve cobra fees em USDC/stables, não em CRV.
- **UNI (Uniswap)**: governance token puro, floating. Mesma lógica — Uni não
  é unidade operacional de pagamento.
- **GMX/GLP**: GMX flutua, GLP (índice multi-asset) tem preço derivado de
  reservas. Nenhum tenta peg explícito.

**Problema específico para o CLP**: o pivot CLP descreve CREDIT como
"unidade de liquidez" e apps "podem pagar em CREDIT ou em ETH/stables". Se
CREDIT é livre, **apps racionais precificam em USDC** porque querem
previsibilidade — relegando CREDIT a token de recompensa puro, indistinguível
de GOV. Isso **mata a tese do CLP** (CREDIT como unidade operacional
distinta).

**Veredito**: **Rejeitado como solução pura**. Aproveitado parcialmente como
base do FFP — floating é o regime padrão; defesa só na cauda inferior.

### 2.4. FFP — Floating com Floor Price defendido (recomendado)

**Descrição**: CREDIT flutua livremente; Treasury defende **piso dinâmico**
via buyback-and-burn quando preço cai abaixo de threshold relativo a média
móvel longa.

**Requisitos**:

- Treasury com receita recorrente de stables (depende de C4 resolvido —
  split `(7000, 2000, 1000)` já aprovado pelo user).
- Oracle TWAP Uniswap v3 (30min) + Chainlink USDC/USD para sanity.
- Mecanismo de execução de buyback no `Treasury.executeBuyback` real.

**Não-requisitos**:

- ~~Reservas 1:1~~ (floor é dinâmico, não absoluto).
- ~~Auditoria de reservas estilo Circle~~ (não há promessa de redemption).
- ~~PSM~~ (não há mint/redeem 1:1).
- ~~Licença de emissor~~ (não é stablecoin).

**Riscos**:

| Risco | Severidade | Mitigação |
| ----- | ---------- | --------- |
| Regulatório | **Baixo** | Sem promessa de peg; comunicação enfatiza "buyback discricionário" |
| Esgotamento de reservas em ataque sustentado | Médio | Cap mensal 30% reservas; floor mínimo absoluto $0.10 sem reservas |
| Manipulação de oracle para forçar buyback | Médio | TWAP 30min + Chainlink sanity bloqueiam manipulação curta |
| Floor price baixo demais para utilidade real | Baixo | MA90 é longa o suficiente para refletir consenso de mercado |

**Cases comparáveis**:

- **OHM (Olympus DAO) — backing price**: OHM tinha "backing per OHM"
  publicado e Treasury defendia preço acima do backing. Quando demanda
  caiu (post-2022), backing virou floor real. Funcionou parcialmente —
  OHM hoje trade próximo ao backing ($11–$12). **Lição positiva**:
  floor explícito atrai capital pacientes. **Lição negativa**: bonds OHM
  inflavam supply mais rápido que backing crescia — Treasury ficou
  comprometido. Nosso FFP evita isso porque cap mensal limita gasto.
- **GMX buyback**: GMX usa parte do fee revenue para buyback-and-burn de
  GMX/GLP em condições específicas. Floating com defesa contracíclica.
  **Funciona** sem ser stablecoin — exatamente o template aqui.
- **Yearn YFI buyback**: tesouraria YFI compra YFI no mercado em preços
  baixos. Discricionário, funciona. Parecido com FFP mas sem regra
  numérica explícita — preferimos regra para previsibilidade.
- **Empresas tradicionais — share buybacks**: Apple, Microsoft executam
  buybacks discricionários para sustentar preço. Modelo legalmente claro,
  mecanismo conhecido por reguladores. **Análogo direto**.

**Por que MA90 (média móvel 90 dias)**:

- 30 dias é curto demais — captura ruído semanal.
- 365 dias é longo demais — em 6 meses de bear, floor permanece artificialmente
  alto e Treasury exausta defendendo nível irreal.
- 90 dias = 13 epochs de 7 dias = **3 trimestres** = horizonte de
  decisão razoável em DAOs e condizente com volatilidade típica de tokens
  em fase intermediária.

**Por que 50% como floor multiplier**:

- 80%: Treasury intervém constantemente em qualquer drawdown moderado —
  caro, vira PSM efetivo.
- 70%: ainda acima de drawdowns típicos de bull market (40–50%) — gasta
  reservas em correção saudável.
- 50%: dispara apenas em **bear severo** (drawdown 50%+ vs MA90) — situação
  onde defesa é mais útil. Análogo a "circuit breaker SEC" em ações
  (suspensão automática em queda 7%/13%/20% em um dia).
- 30%: floor ativa apenas em extinção iminente — útil mas tarde demais.

**Por que floor mínimo absoluto $0.10**:

- Genesis CREDIT = 10M, distribuído ao Treasury. Se preço cair a $0.10,
  market cap implícito = $1M; Treasury com $500k–$1M USDC consegue defender.
- Abaixo de $0.10, apps tornam-se inviáveis (fee mínimo $0.01 em CREDIT
  vira poeira). Preservar nível mínimo de utilidade.
- $0.10 é também o "preço de referência psicológico" para listagem em
  exchanges menores — abaixo disso, deslistagem.

**Veredito**: **Aprovado e recomendado**. Custo regulatório baixo, mecanismo
defensável, parametrização clara, não exige equipe dedicada.

---

## 3. Especificação operacional do FFP

### 3.1. Comportamento de `Treasury.executeBuyback` real

```
function executeBuyback(stable, amountIn, minCreditOut, swapData) {
    // 1. Validate trigger (off-chain monitor + on-chain replay)
    require(spot_TWAP_30min < floor_price(now), "PEG_OK");
    require(spot_TWAP_30min < MA90 * 0.5, "ABOVE_FLOOR");
    require(chainlink_USDC_USD > 0.99 && chainlink_USDC_USD < 1.01, "ORACLE_SANITY");

    // 2. Validate budget caps
    require(amountIn <= treasuryUSDC.balance * 0.20, "PER_EVENT_CAP_20PCT");
    require(monthlyBuybackVolume + amountIn <= treasuryUSDC.initial * 0.30, "MONTHLY_CAP_30PCT");

    // 3. Execute swap via Uniswap v3 router
    USDC.approve(uniRouter, amountIn);
    uint256 creditOut = uniRouter.exactInputSingle({...});
    require(creditOut >= minCreditOut, "SLIPPAGE");

    // 4. Burn CREDIT immediately
    CREDIT.burn(creditOut);

    emit BuybackExecuted(stable, amountIn, creditOut);
    monthlyBuybackVolume += amountIn;
}
```

**Notas técnicas**:

- `floor_price(now)` é view function que computa MA90 on-chain via histórico
  do `BurnTracker` (preço derivado de pool TWAP, não preço externo).
- `monthlyBuybackVolume` resetado por governance via Timelock no início de
  cada mês (manual no v1; automático em v2 via timestamp check).
- CREDIT comprado é **sempre** queimado, nunca acumulado em Treasury. Isso
  reforça narrativa deflacionária e impede que Treasury vire whale de
  CREDIT (vetor de captura interna).

### 3.2. Trigger e quem dispara

**Modelo proposto — duplo trigger**:

1. **Manual via governance proposal** (Fase 1 — primeiro ano).
   - Qualquer holder com >10k GOV propõe `executeBuyback` quando observa
     `spot < floor`.
   - Timelock 2 dias adiciona delay — atacante não consegue forçar buyback
     instantâneo via manipulação curta.
   - **Risco**: atraso de 48h+ entre detecção e execução. Em queda aguda,
     reservas chegam tarde demais.

2. **Automated via keeper (Chainlink Automation / Gelato)** (Fase 2+).
   - Keeper monitora oracle continuamente.
   - Quando condição é satisfeita por 24h consecutivas, executa
     `executeBuyback` com parâmetros pré-aprovados pela governança (cap
     20%/evento, max gas, etc.).
   - Governança pode pausar keeper via `Timelock.cancel()` se necessário.

**Recomendação Fase 1**: **manual**. Aceitar atraso de 48h em troca de
segurança. Em Fase 2 (após 60+ epochs de dados reais), avaliar transição
para keeper.

### 3.3. Parâmetros numéricos consolidados

| Parâmetro | Valor recomendado | Faixa razoável | Justificativa |
| --------- | ----------------- | -------------- | ------------- |
| Floor multiplier | 0.50 | 0.40–0.60 | Defesa só em bear severo |
| Floor MA window | 90 dias | 60–120 | Trimestre de mercado |
| Floor mínimo absoluto | $0.10 | $0.05–$0.20 | Preserva utilidade mínima |
| Trigger duration | 24h consecutivas | 12h–48h | Filtro anti-flash crash |
| TWAP window | 30 min | 15–60 min | Anti-manipulação de oracle |
| Cap por evento | 20% reservas USDC | 10–30% | Evita drenagem em uma tx |
| Cap mensal | 30% reservas USDC | 20–50% | 3–5 meses de reserva mínima em ataque |
| Slippage máximo no swap | 1% | 0.5–2% | Padrão setor |
| Chainlink USDC sanity | 0.99–1.01 | tight | Detecta despeg de USDC |
| Source de reservas | `treasuryBps = 10%` (split 70/20/10) | já aprovado | C4 resolvido |

### 3.4. Interação com BondDepository (Fase 3)

**Bond discount referencia preço spot, não floor**:

```
bond_price = spot_TWAP_30min × (1 - discount_current)
```

- Discount começa em 10%, converge para 3% em 90 dias (parecer anterior).
- **Não** referencia peg fictício — bonder paga $0.95 × spot, recebe CREDIT
  vesting 14d.
- Se spot cair abaixo de floor durante vesting, bonder absorve perda. Risco
  do bonder, não do protocolo.

**Bond não dispara durante buyback ativo**:

- Circuit breaker: se `executeBuyback` foi chamado nas últimas 72h,
  `BondDepository.deposit()` reverte com `BUYBACK_ACTIVE`.
- Razão: bonding emite CREDIT, buyback queima. Operar simultaneamente é
  contraditório e amplifica volatilidade.

**Sem alteração nos parâmetros de bond do parecer anterior** (discount
10%→3%, vesting 14d, debtRatio_max 25%).

### 3.5. Comunicação pública (regulatório)

**Termos a usar**:

- "CREDIT é unidade operacional flutuante."
- "Treasury executa buyback discricionário em condições adversas."
- "Floor price é referência indicativa, não compromisso de redemption."

**Termos a EVITAR**:

- "CREDIT é estável."
- "CREDIT é pegged a $1 / a USDC."
- "Garantimos preço mínimo."
- "Reservas 1:1."

Documentação multi-idioma (delegar a `dao-docs`) deve refletir essa
linguagem. Qualquer slip semântico vira evidência regulatória de que CREDIT
é stablecoin.

---

## 4. Cenários de estresse (FFP)

### 4.1. Bear gradual (drawdown 60% em 6 meses)

- MA90 cai linearmente, floor acompanha.
- Buyback dispara em poucos eventos isolados quando spot fura -50% vs MA90.
- Treasury gasta ~10% reservas/mês.
- **Resultado**: protocolo sobrevive, floor cai com mercado, Treasury preserva
  capital.

### 4.2. Flash crash (-70% em 24h)

- Spot fura floor instantaneamente.
- TWAP 30min suaviza — buyback só dispara após 24h consecutivas.
- Se queda persiste 24h, governance proposta + Timelock 2d = 72h até execução.
- Em 72h, ou mercado recupera (não precisava de buyback) ou consolidou em
  novo nível baixo (buyback executa, queima CREDIT, alívio temporário).
- **Resultado**: latência de 72h pode parecer ruim, mas é defesa contra
  manipulação de oracle. Alternativa keeper (Fase 2) reduz para 24h.

### 4.3. Ataque coordenado de venda (whale dumping)

- Whale com 10% supply vende em mercado thin, força preço para -60% vs MA90.
- TWAP 30min captura.
- Buyback dispara, queima CREDIT. Whale sai com losses (vendeu barato), 
  protocolo absorve dano via reserva.
- Se whale tenta novamente: `monthlyCap` impede. Após esgotamento, floor
  cai para $0.10 absoluto. Whale ganha pouco; protocolo sobrevive.
- **Resultado**: ataque é financeiramente irracional para whale (vende
  barato sem capturar valor). Vetor não é sustentável.

### 4.4. Manipulação de oracle TWAP

- Atacante swap grande na pool CREDIT/USDC, força TWAP para baixo.
- Chainlink USDC/USD sanity ainda OK ($1).
- Se atacante mantém preço baixo por 30min+24h = 24.5h, dispara buyback.
- Custo de manter preço baixo por 24h em pool com TVL adequado (>$500k) é
  proibitivo (~$200k+ em fees + IL).
- **Resultado**: oracle manipulation é tecnicamente possível mas
  economicamente irracional se TVL pool ≥ $500k (IE6). Validar TVL antes
  de ativar buyback automático.

### 4.5. Treasury insolvente (reservas esgotam)

- Cenário: bear de 12+ meses, monthlyCap esgotado por 6 meses consecutivos.
- Reservas USDC do Treasury caem para zero.
- Buyback pausa automaticamente (cap = 0% × 0 = 0).
- Floor "cai" para $0.10 absoluto via burn-by-use orgânico (95% do
  FeeRouter ainda queima CREDIT pago aos apps).
- **Resultado**: protocolo entra em modo de hibernação. Não morre, mas não
  defende. Espera receita orgânica recuperar reservas.

---

## 5. Veredito final

### Recomendação

**Implementar FFP (Floating com Floor Price defendido)** com os parâmetros
da §3.3. Modelo único, sem ambiguidade, defensável regulatoriamente, e
compatível com toda a arquitetura do pivot CLP aprovada.

### Por que UM modelo (não híbrido com fallback para soft peg)

Tentação natural: "começar com FFP, e se mercado quiser estabilidade,
adicionar PSM em Fase 4". **Rejeito**. Razões:

1. Adicionar PSM depois é mudança regulatória — DAO que migra de
   "discricionário" para "promessa de peg" cruza fronteira de stablecoin.
   Atrai escrutínio retroativo.
2. Comunicação fica inconsistente — apps que precificaram em CREDIT durante
   fase floating teriam que reescrever lógica quando peg ativa.
3. Complexidade técnica dobra — FFP + PSM coexistindo gera estados
   inconsistentes (qual oracle prevalece?).

**Ou floating-com-buyback, ou stablecoin. Não meio-termo evolutivo.**

### Mudanças no parecer anterior

| Ponto do parecer anterior | Mudança |
| ------------------------- | ------- |
| 1 (cap agregado de emissão) | Sem mudança |
| 2 (parâmetros VotingEscrow) | Sem mudança |
| 3 (gauge-based reward split) | Sem mudança |
| 4 (bonding discount + dívida) | **Esclarecimento**: discount sobre spot, não peg. Adicionar circuit breaker `bond pausa durante 72h pós-buyback`. Parâmetros numéricos (10%→3%, vesting 14d, debt 25%) inalterados. |
| 5 (alocação 4-buckets) | Sem mudança |
| 6 (defesas anti-fake-volume) | Sem mudança |
| 7 (mercenary capital / lock) | Sem mudança |
| 8 (captura por baleia) | Sem mudança |
| 9 (flywheel sanity check) | **Cenário pessimista atualizado**: floor mínimo $0.10 + cap mensal 30% reservas evita morte aguda; ainda morre em bear de 12+ meses se reservas esgotarem (modo hibernação). Ainda sobrevive 40+ rounds com APR>2%. |
| 10 (cap GOV vs voting power) | Sem mudança |

### Próximos passos

- [ ] **[user]** Confirmar veredito FFP com parâmetros da §3.3 (default
      "sim" aceito).
- [ ] **[user]** Decidir trigger Fase 1: manual via governance (recomendado)
      vs keeper desde início.
- [ ] **[dao-dev]** Quando spec de Fase 1 for produzido, incluir
      `Treasury.executeBuyback` real conforme §3.1 (substituir stub atual).
- [ ] **[dao-dev]** Implementar oracle TWAP view function on-chain
      (`floorPrice()`) lendo Uniswap v3 pool CREDIT/USDC.
- [ ] **[dao-docs]** Atualizar README + docs multi-idioma com linguagem
      §3.5 (sem termos de "stablecoin"/"peg"/"redemption").
- [ ] **[dao-economist]** Em parecer #4 (após 45+ epochs Fase 1), validar
      empiricamente se floor multiplier 0.50 está calibrado ou precisa
      ajuste.

### Pendências não resolvidas neste parecer

- **Pool inicial CREDIT/USDC TVL alvo**: §3.4 do parecer anterior já
  recomenda $500k–$1M; FFP não muda essa recomendação mas reforça que
  TVL < $500k torna oracle TWAP manipulável e FFP perigoso.
- **Posicionamento jurisdicional**: se DAO formaliza-se em jurisdição
  específica (Cayman, Suíça, Wyoming), revisar §2.1/§2.2 — pode haver
  abertura para soft peg em jurisdição friendly. Por default (DAO
  permissionless sem entidade legal), FFP é única opção segura.
- **Backing ratio publicado**: discutir se Treasury publica dashboard de
  "reservas USDC / CREDIT em circulação" (estilo OHM backing). Útil para
  transparência, mas pode ser confundido com promessa de peg. Decisão
  para `dao-docs` + parecer regulatório dedicado.

---

## 6. Arquivos relevantes (caminhos absolutos)

Parecer anterior:

- `/home/ubuntu/web3community/audit/economist/2026-04-24-clp-pivot.md`

Código relevante para implementação:

- `/home/ubuntu/web3community/contracts/Treasury.sol` (linhas 266–279 — stub
  `executeBuyback` a ser substituído)
- `/home/ubuntu/web3community/contracts/CreditToken.sol` (função `burn` a ser
  invocada após swap)
- `/home/ubuntu/web3community/contracts/FeeRouter.sol` (split atual 95/0/5;
  resolver C4 para 70/20/10 antes de FFP virar útil)

Configuração:

- `/home/ubuntu/web3community/ignition/parameters/production.json`
- `/home/ubuntu/web3community/ignition/parameters/dev.json`

Este parecer:

- `/home/ubuntu/web3community/audit/economist/2026-04-24-credit-peg.md`
