# Fluxo de valor

**Para quem é:** leitor querendo entender por onde o valor real entra, transita e sai do protocolo.
**Pré-requisitos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md).

## De onde vem o valor real

A única fonte de **valor externo** no sistema é o usuário final que paga por CREDIT. Ele paga porque precisa usar os apps. Se ninguém quer usar os apps, ninguém compra CREDIT, e o sistema morre — essa é a invariante dura.

A liquidez do par CREDIT/USDC é construída por duas vias complementares no Credit Liquidity Protocol (CLP):

1. **POL** — Protocol-Owned Liquidity. O próprio Treasury custodia uma posição NFT no pool. Construída por (a) seed inicial do genesis CREDIT + USDC do Treasury, (b) refill via bucket bonders (CREDIT) casado com USDC de bootstrap externo ou de fees da posição POL (`collectPOLFees`) — a fatia `treasuryBps` é denominada em **CREDIT**, não USDC.
2. **LPs externos** — usuários que provisionam liquidez no pool e stakeiam o NFT no `LiquidityGauge`. Recebem incentives em CREDIT (bucket LPs do V2, default 25% da emissão).

O caminho típico de um pagamento:

```
   [ Usuario Charlie ]
        |
        |  1. Compra 1000 CREDIT na DEX (POL + LPs externos fornecem liquidez)
        |
        v
   [ Carteira Charlie tem 1000 CREDIT ]
        |
        |  2. Usa o Chat App. App cobra 1000 CREDIT pelo servico.
        |     Charlie assina approve(feeRouter, 1000) + feeRouter.pay(...)
        |
        v
   [ FeeRouter ]
        |
        | split default 70/20/10 (Fase 0, assado nos parametros de deploy)
        |
        +-------> burnBps (70%) queimados (via BurnTracker)
        |         - CREDIT.totalSupply diminui
        |         - burn registrado no BurnTracker para o Chat App
        |
        +-------> treasuryBps (20%) -> Treasury (em CREDIT; engorda o saldo livre)
        |
        +-------> rebateBps (10%) -> app owner (rebate direto)
```

**O valor real entrou no protocolo na etapa 1.** Todas as etapas subsequentes redistribuem esse valor.

## Os 5 agentes e por que cada um está no jogo

Com o pivot CLP, o **LP** entra como agente formal — antes era apenas externo, agora recebe bucket dedicado.

```
   +----------+    +-------------+    +----------+    +----------+    +------------+
   | Usuario  |    |    App      |    |  Staker  |    |    LP    |    |   Holder   |
   | final    |    | (ChatApp)   |    |  (Alice) |    |   (Bob)  |    |  sem stake |
   +----+-----+    +------+------+    +----+-----+    +----+-----+    +-----+------+
        |                 |                |               |                |
   paga em CREDIT    recebe rebate    trava GOV em    LP no pool       poder de voto
   usa o app         + bucket apps    projectId       CREDIT/USDC      no Governor
                     (push direto     ganha bucket    + stake NFT
                      retrospectivo   stakers         em LiquidityGauge
                      por burn)       (claim)         ganha bucket LPs
                                                      (vesting 14d)
        |                 |                |               |                |
   extrai valor      captura caixa    ganha CREDIT    ganha CREDIT     mantem direito
   de servico        operacional +    recem-emitido   recem-emitido    sobre mudancas
   (fora do          emissao push     em claim        em harvest       de parametros
   protocolo)        (apps bucket)    (stakers)       (LPs bucket)
```

Perceba: **não há yield "do ar"**. O CREDIT emitido para Alice (staker), Bob (LP) e ChatApp (apps bucket) existe porque Charlie queimou CREDIT. Nenhum ator recebe valor que não veio de algum ator a montante.

## As 4 fontes de receita de um app

O split default de 10% direto parece pouco. Mas a conta fecha — especialmente se o app também stakar no próprio projeto — por vetores simultâneos:

### (A) Rebate direto

10% de cada pagamento (`rebateBps = 1000`). Instantâneo, em CREDIT. É o fluxo de caixa operacional.

### (B) Push do bucket apps

15% da emissão de cada rodada (`bucketBps[apps] = 1500` no `RewardDistributorV2`) é mintado **direto** para o `ownerRecipient` de cada projeto no `finalizeRound`, proporcional ao burn que o projeto gerou na rodada anterior. Não exige stake nem claim — é push retrospectivo por burn.

### (C) Emissão via stake no próprio `projectId`

Se o app adquiriu GOV (por exemplo, comprando em DEX ou recebendo via proposta de distribuição) e stakou em `projectId = próprio`, ele captura parte da share de rewards daquele projeto na rodada seguinte.

Como?

1. Quando Charlie paga, 70% é queimado e vai para `burnByRoundProject[R][projectId=app]`.
2. Na rodada R+1, a emissão é proporcional a esse burn — e o **bucket stakers (55% da emissão)** é rateado entre projetos pelo burn.
3. Se o app tem peso de staking dentro do próprio `projectId`, ele recebe parte dessa fatia.

**Exemplo numérico** (rodada hipotética):

- ChatApp movimenta 600.000 CREDIT em pagamentos na rodada R-1.
- (A) Rebate direto: 10% × 600k = **60.000 CREDIT** imediato.
- Burn do ChatApp: 70% × 600k = 420.000 CREDIT em `burnByRoundProject[R-1][42]`. Suponha burn total da rodada = 950.000 (outros apps somam o resto) → emissão da rodada R = 0,95 × 950k = 902.500 CREDIT.
- (B) Bucket apps: 15% × 902.500 = 135.375; push do ChatApp = `135.375 × 420k/950k` = **59.850 CREDIT** (direto no `finalizeRound`, sem stake).
- (C) Bucket stakers: 55% × 902.500 = 496.375; `projectShare_ChatApp = 496.375 × 420k/950k = 219.450 CREDIT`. Se o ChatApp stakou 50k GOV com lock de 365d (multiplier 4x, peso 200k), e o peso total no projeto é 400k, ele captura 50% × 219.450 = **109.725 CREDIT**.
- Soma (A) + (B) + (C) = **229.575 CREDIT** de um volume bruto de 600k = **~38,3%** efetivo.

O split **nominal** conta história enganosa. O split **econômico efetivo** para um app que também stake depende de quanto ele stake e da concorrência de outros stakers no mesmo `projectId`.

### (D) Apreciação do CREDIT retido

Como `alpha < 1`, o supply de CREDIT cai se o uso se mantiver constante. O CREDIT que o app recebeu (rebate + rewards) e ainda não vendeu tende a apreciar em termos reais — desde que a demanda por CREDIT (gerada pelo uso dos apps) se sustente.

**Armadilha**: se o app vende todo o CREDIT imediatamente, ele abre mão de (D). Se retém, expõe-se a volatilidade. É decisão do app.

## Quando (C) não fecha a conta

Apps sem capital para adquirir GOV não capturam (C) — sobram (A) e (B). Para esses casos:

- Se rebate de 10% + push do bucket apps ainda não fecham a conta, a DAO pode aprovar `setProjectSplit(projectId, custom)` via proposta. Por exemplo: `8000/0/2000` (20% rebate) para apps estratégicos que não conseguem stakar.
- Alternativamente, pode-se financiar aquisição inicial de GOV via `Treasury` (proposta de transferência direta).

A arquitetura permite ajuste por projeto exatamente para esse tipo de acomodação.

## Fluxo por ciclo de rodada

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

CREDIT entra no supply por **duas** vias apenas:

1. `CreditToken.mintGenesis` — one-shot, 10M para o Treasury, no deploy.
2. `CreditToken.mint` — pelos distribuidores com `MINTER_ROLE`: V1 nos claims (janela de migração) e `RewardDistributorV2` nos claims lazy do bucket stakers + nos pushes do `finalizeRound` (apps, LPs/gauge, bonders/Treasury).

E sai por **uma** via:

- `CreditToken.burn` / `burnFrom` / `burnByRole` — principal caminho é via `FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole`.

Esse fluxo fechado permite análise simples:

```
   totalSupply_R = totalSupply_{R-1} + (novas emissoes em R) - (burns em R)
```

Se `novas emissoes <= burns`, o supply cai. Com `alpha = 0.95` e uso estável, essa é a dinâmica esperada.

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

## O papel do Treasury nesse fluxo (pós-CLP)

O Treasury é o **amortecedor** do sistema. Ele:

- Recebe o genesis de CREDIT (10M).
- Recebe `treasuryBps` dos pagamentos (20% no split default de deploy — em CREDIT, engordando o saldo livre).
- Recebe colateral de projetos removidos com slash.
- **Recebe bucket bonders** do `RewardDistributorV2` (5% da emissão por rodada — ledger `polRefillBucket`).
- **Pode receber bucket LPs** quando gauge paused (ledger `pendingGaugeRewards`).

E distribui, via propostas:

- **Executa FFP buyback** — swap USDC → CREDIT + queima imediata, defendendo o floor.
- **Provisiona POL** — `addPOL` / `addPOLFromRefill`.
- Subsídios para usuários novos (`UserSubsidy`).
- Vesting para o time (`TeamVesting`).
- Pagamento de rebates batch para apps.
- Financiamento de operações off-chain.

O Treasury **não** é distribuído automaticamente — tudo sai por proposta. Mas a partir do CLP, o Treasury executa três loops econômicos (em vez de só custodiar):

1. **Loop FFP**: `recordDailyPrice` (keeper) → MA90 cresce → spot < floor por 24h → governance propõe `executeBuyback` → swap USDC→CREDIT → queima → `totalSupply` cai → preço pressionado pra cima.
2. **Loop POL refill**: bucket bonders traz CREDIT (ledger `polRefillBucket`) → USDC vem de bootstrap externo ou de `collectPOLFees` (o `treasuryBps` é em CREDIT e não fornece esse lado) → governance propõe `addPOLFromRefill` → liquidez no pool aumenta → slippage menor para holders.
3. **Loop fallback gauge**: `RewardDistributorV2` detecta gauge paused → mint para Treasury → governance despausa gauge → `flushPendingGaugeRewards` envia CREDIT acumulado de volta como incentive.

## Invariante econômica de saúde

Um sinal simples de saúde do protocolo: **burn acumulado precisa crescer mais rápido do que emissão acumulada**, ao longo de rodadas. Como `alpha < 1` garante `emissão_R ≈ 0.95 × burn_{R-1}`, essa inequação se satisfaz automaticamente enquanto:

```
burn_R >= burn_{R-1}
```

Ou seja: o protocolo está saudável enquanto o uso real está se mantendo ou crescendo. Se burn cai, emissão cai junto, mas a razão `emissão/burn` permanece constante em `alpha`. O sintoma terminal é burn absoluto indo a zero por muitas rodadas consecutivas.

Pós-CLP, dois sinais adicionais:

- **MA90 do CREDIT crescente** — indica precificação saudável; floor relativo (`0.5 × MA90`) acompanha. Se spot cai abaixo do floor por 24h, FFP buyback é proposto.
- **POL TVL crescente** — Treasury acumula liquidez própria. Maior POL = menor slippage para holders e menor dependência de LPs externos para sair.

Métricas completas em [Métricas que importam](../06-for-investors/04-metrics-that-matter.md).

---

**Próximo →** [Como participar](../04-for-users/01-participate.md)
