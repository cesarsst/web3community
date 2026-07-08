# Treasury e fees

**Para quem é:** quem quer entender o fluxo de caixa do protocolo.
**Pré-requisitos:** [Dual-token](01-dual-token-economy.md), [Governança](05-governance.md).

> **Remodel 2026-07-08**: a interface de pagamento vigente é o [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) — fee de **2,5%** (250 bps; teto duro 500) repartida **40% treasury / 40% buyback GOV / 20% grants**. O FeeRouter V1 (split 70/20/10 com burn) e os loops CLP do Treasury (FFP buyback, POL, buckets) são **legado**. E atenção: o lastro USDC do [CreditPSM](../08-contracts-reference/15-CreditPSM.md) é **segregado** — não é caixa do Treasury.

## O cofre da DAO

O `Treasury` é o cofre multi-ativo central. Três propriedades fundamentais:

1. **Recebe passivamente**. Não há função `deposit`. Qualquer um transfere ERC-20 (ou ETH via `receive`) direto para o endereço do Treasury.
2. **Só libera via governança**. Todas as funções de saída exigem `GOVERNANCE_ROLE`.
3. **Sem pause**. Deliberadamente não há função para congelar saídas. Qualquer poder unilateral de congelar a tesouraria seria vetor de captura.

O Treasury recebe (modelo vigente):

- **40% da fee do FeeRouterV2** (= 1,0% do GMV) a cada pagamento — receita recorrente em CREDIT, proporcional ao uso real. É a principal fonte operacional.
- **Genesis mint de CREDIT** (10M em produção — parâmetro `genesisAmount` do deploy). Única entrada "programática" inicial.
- **Colateral de slash** de projetos removidos com `slash == true`.
- **Subsídios devolvidos** de campanhas `UserSubsidy.closeCampaign`.
- **Qualquer doação** que a DAO decidir aceitar.

### O que o Treasury NÃO tem: o lastro do PSM

O USDC que lastreia CREDIT fica **retido no [CreditPSM](../08-contracts-reference/15-CreditPSM.md)**, segregado do Treasury. Não existe função para movê-lo — nem via proposta de governança. A DAO gasta da fee (2,5% do fluxo), nunca do lastro (invariante I-PSM1). Isso é deliberado: o direito de resgate 1:1 do usuário não pode depender de disciplina orçamentária da DAO.

> **Legado — funções CLP do Treasury.** A partir do pivot CLP (Fase 1, abril/2026), o Treasury passou a executar FFP buyback (swap USDC → CREDIT + queima, defesa de floor), POL (liquidez própria CREDIT/USDC), bucket bonders (`polRefillBucket`, 5% da emissão) e fallback do gauge (`pendingGaugeRewards`). Com CREDIT estável via PSM, defesa de floor e liquidez de pool deixam de ser necessárias — essas funções seguem no código, descritas ao final desta página como legado.

## O que a DAO faz com o Treasury

Operações típicas, todas via proposta:

- **Pagar rebates a apps** (`payRebates(token, apps[], amounts[], round)`).
- **Patrocinar campanhas de `UserSubsidy`** — transferir CREDIT antes de `createCampaign`.
- **Fundar `TeamVesting`** — transferir GOV para vesting do beneficiário.
- **Financiar operações off-chain** — `transfer` para um multisig operacional.
- **(Legado CLP)** FFP buyback, POL, refill do POL e flush do gauge — ver seção de legado ao final.

## Fees — o FeeRouterV2

Interface **única** de pagamento entre usuários e apps no modelo vigente. Função principal:

```solidity
function pay(uint256 projectId, uint256 amount) external;
```

O pagador é `msg.sender` e precisa ter dado `approve(feeRouterV2, amount)` em CREDIT **antes**. Exige projeto Active no Registry. Tudo atômico, ordem: fee → rev-share → app.

## Fee — 2,5%, split 40 / 40 / 20

Default de deploy: `feeBps = 250` (2,5% do pagamento), com **teto duro `FEE_BPS_CAP = 500`** (5%) — nem governança ultrapassa. A fee é repartida internamente (`feeSplit`, soma obrigatória 10.000 bps):

```
fee = amount * 250 / 10000        (2,5% do pagamento)
  40% -> treasuryRecipient   (= 1,0% do GMV)
  40% -> buybackRecipient    (= 1,0% do GMV, recompra contínua de GOV)
  20% -> grantsRecipient     (= 0,5% do GMV, grants pro ecossistema)
```

Depois da fee, desconta-se o **rev-share do projeto** (`ProjectFunding.revShareBpsOf`; 0 se o projeto nunca captou rodada) e o resto vai **na hora** pro `appRecipient`: **97,5%** sem rodada, **~89,5%** com rev-share de 8%. Compare: Stripe ~3,8%, app stores 15-30% — e o modelo antigo entregava ao app só 10% nominal.

No MVP dev os três recipients apontam pro Treasury; os eventos `PaymentRouted` carregam o detalhamento por parcela mesmo assim — `grossVolumeOf` e `PaymentRouted` são as métricas on-chain de volume.

## Recipient do app

Por default, `toApp` vai para `ProjectRegistry.getProject(projectId).owner` — **lookup dinâmico**. O owner atual pode setar um endereço explícito via:

```solidity
feeRouterV2.setAppRecipient(projectId, recipient);
```

**Não é governance-gated** — é owner-gated. Rotação operacional de caixa não precisa de proposta.

## Dust handling

Dentro da fee, o resíduo de arredondamento do split vai para grants. Na conservação global, `toApp + fee + revShare == amount` em toda `pay` — nada evapora, nada é queimado.

## Fluxo completo de um pagamento

```
user tem 1000 CREDIT                    FeeRouterV2
user chama approve(feeRouterV2, 1000) --- allowance OK
user chama pay(42, 1000)
                                      |
                                      v
                      Check: projeto 42 esta Active
                      Check: amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                                      |
                                      | fee 2,5% + rev-share 8% (rodada Funded)
                                      v
                 fee = 25, revShare = 80, toApp = 895
                                      |
          +----------+----------+-----+--------------+
          |          |          |                    |
          v          v          v                    v
    treasury 10  buyback 10  grants 5      ProjectFunding 80        appRecipient 895
    (40% fee)    (40% fee)   (20% fee)     + notifyRevenue          (na hora, ~89,5%;
                                           (pro-rata investidores)   97,5% sem rodada)
                                      |
                       grossVolumeOf[42] += 1000
                       PaymentRouted event emitted
```

Após a tx: **FeeRouterV2 tem 0 CREDIT**. Ele nunca custodia entre chamadas. Cada `pay` é atômico.

> **Legado — FeeRouter V1 (split 70/20/10)**: no modelo pré-remodel, `FeeRouter.pay(projectId, user, amount)` queimava 70% via BurnTracker, mandava 20% pro Treasury e 10% de rebate pro app, com overrides por projeto (`setProjectSplit`). O contrato segue deployado, mas o trilho vigente é o V2. Ver [FeeRouter V1](../08-contracts-reference/08-FeeRouter.md).

## Saídas de ETH

O Treasury aceita ETH via `receive` e pode sacar via `sweepETH(to, amount)`. Usa `call{value}` (não `transfer`/`send`) para compatibilidade com destinos que são contratos com `receive` pesado. Se o destino rejeitar, reverte com `ETHTransferFailed`.

O uso é de **cortesia** — o protocolo opera primariamente em ERC-20 (CREDIT, GOV, stables). ETH é aceito para não deixar doações travadas mas não é o fluxo principal.

> ⚠️ **LEGADO daqui até "Segregação on-chain"** — as quatro seções a seguir (FFP buyback, POL, bucket bonders, fallback gauge) pertencem ao pivot CLP pré-remodel. Com CREDIT estável 1:1 via PSM, defesa de floor e liquidez de pool deixam de ser necessárias. O código segue deployado.

## Buyback — FFP real (Fase 1.1, legado)

A partir do pivot CLP, `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)` **executa swap real** de USDC → CREDIT via Uniswap V3 + queima imediata. Defesa do **floor price** segundo o modelo Floating-com-Floor-Price (FFP). Detalhes em [Treasury](../08-contracts-reference/04-Treasury.md).

O `priceOracle` tem implementação de produção real: o **`CreditPriceOracle`** (`contracts/CreditPriceOracle.sol`), adapter do `ICreditPriceOracle` que deriva o TWAP do CREDIT em USD (18 decimais) da pool Uniswap V3 CREDIT/USDC e converte USDC → USD via feed Chainlink USDC/USD (staleness máxima de 6h + banda de sanidade fixa `[9900, 10100]` bps, espelhando os defaults do Treasury). Todos os endereços do oracle são `immutable`.

Pré-condições verificadas on-chain (todas obrigatórias):

1. **Infra setada** — `priceOracle`, `swapRouter` e `chainlinkUsdcFeed` configurados via governance. Sem isso, `BuybackInfraMissing`.
2. **Spot < floor** — TWAP do CREDIT (lido do `priceOracle`) abaixo de `currentFloorPrice()`.
3. **Breach durou >= 24h** — `block.timestamp - lastFloorBreachTimestamp >= triggerDurationSecs`. Atualizado por `recordDailyPrice` (permissionless, cooldown 22h).
4. **USDC não está despegado** — Chainlink USDC/USD entre `[0.99, 1.01]` (banda configurável em bps).
5. **Cap por evento** — `usdcAmount <= 20%` das reservas USDC do Treasury (snapshot momentâneo).
6. **Cap mensal** — gasto cumulativo do mês `<= 30%` do snapshot tirado no primeiro buyback do mês.

O CREDIT comprado é **sempre queimado** (`CreditToken.burnByRole(self, creditOut, "treasury:buyback")`). Nunca acumulado. Razão: acumular criaria agente endógeno de captura no protocolo.

`recordDailyPrice` é a função keeper que alimenta o ring buffer de 90 amostras (`dailyPrices[90]`) e atualiza o checkpoint de breach. Bootstrap do MA90 exige 90 invocações consecutivas (≈ 90 dias). Antes disso, `currentFloorPrice` retorna apenas `floorAbsoluteUsd` (default $0.10) — design deliberado para não bloquear bootstrap.

## POL (Protocol-Owned Liquidity, Fase 1.2)

O Treasury custodia uma posição NFT no pool CREDIT/USDC 0.3%. Range full ticks (`-887220, 887220`). Decisão (ver `audit/economist/2026-04-24-pol-params.md`):

- Sem rebalance ativo (concentrado exigiria gerenciamento off-chain).
- Capital eficiente o suficiente para mercados early-stage.
- Auditável trivialmente (ticks fixos).

API:

- `addPOL(creditAmount, usdcAmount, amount0Min, amount1Min, deadline)` — primeira vez `mint`, depois `increaseLiquidity` no mesmo `polTokenId`.
- `removePOL(liquidityAmount, ...)` — `decreaseLiquidity` + `collect`. NÃO queima o NFT (posição fica disponível para reuso).
- `collectPOLFees(amount0Max, amount1Max)` — coleta fees acumulados, sem auto-compound.
- `polTokensOrdered()` view — devolve ordem real `(token0, token1)` no pool, útil para o proponente DAO calcular `amount{0,1}Min`.

A supermaioria de 75% para remoção de POL é responsabilidade do `CommunityGovernor` (proposal type), não deste contrato — e agora está **on-chain**: toda proposta contendo `Treasury.removePOL` (qualquer fração, não só > 25%) é marcada `Supermajority` no `propose` e só vence com `forVotes >= 3 × againstVotes`. Ver [Governança](05-governance.md).

## Bucket bonders e refill POL (Fase 1.4)

Em cada `RewardDistributorV2.finalizeRound`, 5% (default) da emissão é cunhada direto para o Treasury e contabilizada em `polRefillBucket`:

```
RewardDistributorV2.finalizeRound(R)
  -> CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
  -> Treasury.depositPolRefill(bondersAmount)
     - polRefillBucket += bondersAmount
```

Quando governance decide refilar o POL, propõe `addPOLFromRefill(creditAmount, usdcAmount, ...)`:

```
Treasury.addPOLFromRefill (Timelock executa proposta)
  -> debita polRefillBucket (CEI: antes do call externo)
  -> _orderTokens + _approveNPM + _provisionLiquidity
  -> NPM.increaseLiquidity (ou mint se primeira)
```

USDC vem do balance livre do Treasury — e como a fatia `treasuryBps` do `FeeRouter` chega em CREDIT, as fontes reais de USDC são bootstrap externo e `collectPOLFees` (ver seção "Receita recorrente do split").

A Fase 3 do roadmap CLP recicla esse bucket para um `BondDepository` — usuários trocam ETH/CREDIT por CREDIT vested, e o protocolo acumula POL via bonds. Por enquanto, o ledger sustenta o POL diretamente.

## Fallback gauge paused (Fase 1.4)

Se o `LiquidityGauge` está paused no momento de `finalizeRound`, o V2 não pode chamar `notifyRewardAmount`. Para não travar a finalização da rodada inteira, V2 faz fallback:

```
RewardDistributorV2.finalizeRound(R) com gauge.paused() == true
  -> CREDIT.mint(treasury, lpsAmount, "rewardRound:lps:fallback")
  -> Treasury.depositPendingGaugeRewards(lpsAmount)
     - pendingGaugeRewards += lpsAmount
  -> emit GaugePauseFallback(R, lpsAmount)
```

Após despausar o gauge, governance chama `Treasury.flushPendingGaugeRewards(amount, poolId, duration)`:

```
Treasury.flushPendingGaugeRewards (Timelock executa)
  -> requer gauge não-paused, ledger > 0
  -> amount = 0 e sentinela: drena o ledger inteiro; amount parcial permitido
     (amount > ledger reverte com PendingGaugeRewardsInsufficient)
  -> poolId = 0 e sentinela: usa o poolId default configurado
     (os poolIds do gauge sao 1-based)
  -> approve(gauge, amount), gauge.notifyRewardAmount(poolId, amount, duration)
  -> reset approve
```

O flush parcial + poolId explícito existem para evitar freeze: se uma incentive equivalente já estiver ativa no gauge (`IncentiveOverlap`), governance consegue drenar por partes ou para outro pool.

## Segregação on-chain dos ledgers (invariante virou código)

Os dois ledgers contábeis (`polRefillBucket` e `pendingGaugeRewards`) são **enforced on-chain nos dois sentidos**:

- **Saídas genéricas não invadem reservas**: `transfer`, `batchTransfer`, `payRebates` e `addPOL` em CREDIT são limitadas a `unreservedCreditBalance()` (= `balanceOf(CREDIT) − polRefillBucket − pendingGaugeRewards`). Tentativa de invadir reverte com `TransferExceedsUnreservedCredit`. As únicas saídas que tocam as reservas são as dedicadas (`addPOLFromRefill` e `flushPendingGaugeRewards`), que decrementam o ledger correspondente.
- **Depósitos exigem lastro**: `depositPolRefill` e `depositPendingGaugeRewards` revertem com `DepositExceedsCreditBalance` se a reserva agregada pós-depósito exceder o `balanceOf(CREDIT)` — impossível inflar o ledger sem o CREDIT correspondente (o V2 minta antes de depositar, na mesma tx).
- **Válvulas de escape auditáveis**: `writeDownPolRefillBucket` / `writeDownPendingGaugeRewards` (governance, eventos `PolRefillWrittenDown` / `PendingGaugeWrittenDown`) reduzem explicitamente um ledger, liberando o CREDIT para o balance livre — escape de freeze e reciclagem do bucket bonders.

## Resumo

| Componente | Função | Gatekeeping |
|---|---|---|
| Treasury | Custódia multi-ativo; recebe 40% da fee (1% do GMV) | `GOVERNANCE_ROLE` nas saídas |
| FeeRouterV2 | Interface de pagamento vigente (`pay(projectId, amount)`) | `GOVERNANCE_ROLE` nos setters, público no `pay` |
| Fee | 2,5% (250 bps; teto duro 500) | `setFeeBps` por proposta, até o cap |
| Split da fee | 40% treasury / 40% buyback GOV / 20% grants (`4000/4000/2000`) | `setFeeSplit` por proposta (soma = 10.000) |
| Recipients da fee | `treasuryRecipient` / `buybackRecipient` / `grantsRecipient` | `setRecipients` por proposta |
| Recipient do app | Owner do projeto (dinâmico) ou explícito | Owner do projeto (setter) |
| Lastro do PSM | USDC segregado no CreditPSM — **fora do alcance do Treasury** | Nenhum saque possível (imutável) |
| FeeRouter V1, Buyback FFP, POL, buckets | **Legado CLP** — código deployado, trilho desativado | `GOVERNANCE_ROLE` |

---

**Próximo →** [Arquitetura](../03-protocol-overview/01-architecture.md)
