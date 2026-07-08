# Treasury

**Para quem é:** devs construindo integrações com a tesouraria, auditores, governance proposers.
**Pré-requisitos:** [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md), [Distribuição de rewards](../02-core-concepts/04-rewards-distribution.md).

## Visão rápida

Custódia multi-ativo da DAO. Recebe passivamente qualquer ERC-20 (e ETH via `receive`). Única via de saída é `GOVERNANCE_ROLE` — nenhum admin pode drenar fundos fora do ciclo de governança (invariante I4).

A partir do pivot Credit Liquidity Protocol (CLP, abril/2026), o Treasury também:

1. **Executa FFP buyback** (Fase 1.1) — swap real USDC → CREDIT via Uniswap V3 + queima imediata, defendendo o **floor price** quando o spot quebra abaixo do MA90 por 24h. O preço vem de um oracle **real** (`CreditPriceOracle`, adapter TWAP Uniswap V3 + sanity Chainlink), setado via `setPriceOracle`.
2. **Provisiona POL** (Fase 1.2) — Protocol-Owned Liquidity no pool CREDIT/USDC 0.3%, NFT custodiado pelo Treasury, range full ticks.
3. **Recebe bucket bonders** (Fase 1.4) — `RewardDistributorV2` deposita 5% da emissão por rodada num ledger interno (`polRefillBucket`) que governance dreina via `addPOLFromRefill`.
4. **Fallback gauge paused** (Fase 1.4) — se `LiquidityGauge.paused()` no momento de `finalizeRound`, V2 deposita o bucket LPs num segundo ledger (`pendingGaugeRewards`) drenado depois via `flushPendingGaugeRewards`.

Sem função `deposit` para tokens passivos — qualquer pagador usa `token.transfer(treasury, amount)` direto. **Sem pause** — poder unilateral de congelar seria vetor de captura.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parâmetros e storage

### Constants

| Nome | Valor |
|---|---|
| `BPS_DENOMINATOR` | `10_000` |
| `MA_WINDOW_DAYS` | `90` |
| `RECORD_COOLDOWN` | `22 hours` |
| `CHAINLINK_MAX_STALENESS` | `6 hours` |
| `POL_TICK_LOWER` | `-887220` (full range, tickSpacing 60) |
| `POL_TICK_UPPER` | `887220` |

### Immutables (constructor)

- `CREDIT_TOKEN` — endereço do CREDIT defendido.
- `USDC_TOKEN` — stablecoin de origem dos buybacks. `address(0)` aceito em dev (buyback fica desabilitado até re-deploy com endereço oficial).

### Storage — FFP (Fase 1.1)

| Nome | Tipo | Default | Bounds |
|---|---|---|---|
| `priceOracle` | `ICreditPriceOracle` | `address(0)` | governance setter (`CreditPriceOracle` real em produção) |
| `swapRouter` | `IUniswapV3SwapRouter` | `address(0)` | governance setter |
| `swapFeeTier` | `uint24` | `3000` (0.3%) | qualquer não-zero |
| `chainlinkUsdcFeed` | `IChainlinkAggregator` | `address(0)` | governance setter |
| `floorMultiplierBps` | `uint16` | `5000` (0.50 × MA90) | `[3000, 8000]` |
| `floorAbsoluteUsd` | `uint256` | `1e17` ($0.10) | `[1e16, 1e19]` |
| `triggerDurationSecs` | `uint32` | `24 hours` | `[1h, 7d]` |
| `twapWindowSecs` | `uint32` | `30 minutes` | `[5min, 2h]` |
| `chainlinkSanityLowBps` | `uint16` | `9900` (0.99) | `[9000, 9999]` |
| `chainlinkSanityHighBps` | `uint16` | `10100` (1.01) | `[10001, 11000]` |
| `capPerEventBps` | `uint16` | `2000` (20%) | `[100, 5000]` |
| `capMonthlyBps` | `uint16` | `3000` (30%) | `[100, 7000]` |
| `slippageMaxBps` | `uint16` | `100` (1%) | `[10, 500]` |
| `lastFloorBreachTimestamp` | `uint256` | `0` | — |
| `dailyPrices[90]` | `uint256[90]` | ring buffer | — |
| `dailyPriceCount` | `uint16` | cresce até 90, depois para | — |
| `dailyPriceCursor` | `uint16` | próxima posição a escrever | — |
| `dailyPriceSum` | `uint256` | soma corrente (O(1) MA) | — |
| `monthlySpent[monthIdx]` | mapping | USDC gasto no mês | — |
| `monthlyReservesSnapshot[monthIdx]` | mapping | denominador do cap mensal | — |

### Storage — POL (Fase 1.2)

| Nome | Tipo | Descrição |
|---|---|---|
| `positionManager` | `INonfungiblePositionManager` | NPM Uniswap V3 |
| `polTokenId` | `uint256` | NFT id da posição POL (`0` = não seedada) |

### Storage — Fase 1.4 (bucket bonders + gauge fallback)

| Nome | Tipo | Descrição |
|---|---|---|
| `polRefillBucket` | `uint256` | Ledger interno do bucket bonders |
| `pendingGaugeRewards` | `uint256` | Ledger fallback gauge paused |
| `liquidityGauge` | `ILiquidityGaugeRewards` | Destino do flush |
| `liquidityGaugePoolId` | `uint256` | Pool default no gauge |

## Roles e permissões

| Role | Em produção | Concedida a |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | Conceder/revogar roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | Toda saída de fundos, buyback, POL, setters |
| `POL_REFILL_DEPOSITOR_ROLE` | `RewardDistributorV2` | `depositPolRefill` |
| `GAUGE_FALLBACK_DEPOSITOR_ROLE` | `RewardDistributorV2` | `depositPendingGaugeRewards` |

## Funções externas

### Saídas básicas (`GOVERNANCE_ROLE`)

#### `transfer(IERC20 token, address to, uint256 amount)`

Transfere ERC-20 do treasury. Quando `token == CREDIT_TOKEN`, `amount` é limitado a `unreservedCreditBalance()` — reverte se invadir os ledgers `polRefillBucket`/`pendingGaugeRewards` (segregação on-chain, Fase 1.4).

- **Reverte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `TransferExceedsUnreservedCredit(available, requested)` (só CREDIT).
- **Eventos**: `Transferred(token, to, amount)`.

#### `batchTransfer(IERC20 token, address[] recipients, uint256[] amounts)`

Batch. Quando `token == CREDIT_TOKEN`, a **soma** das parcelas (não cada parcela isolada) é validada contra `unreservedCreditBalance()`.

- **Reverte**: `ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance`, `TransferExceedsUnreservedCredit` (só CREDIT).
- **Eventos**: N × `Transferred` + 1 × `BatchTransferred(token, total, recipientCount)`.

#### `payRebates(IERC20 token, address[] apps, uint256[] amounts, uint256 round)`

Idêntico em mecânica a `batchTransfer` (mesma segregação de CREDIT), com evento semântico `RebatesPaid(token, round, total, appCount)`.

#### `sweepETH(address payable to, uint256 amount)`

Saca ETH custodiado.

- **Reverte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `ETHTransferFailed`.
- **Eventos**: `ETHSwept(to, amount)`.

#### `receive() external payable`

Aceita ETH. Emite `ETHReceived(sender, amount)`.

### FFP — recordDailyPrice (permissionless)

#### `recordDailyPrice()`

Grava preço TWAP atual no ring buffer e atualiza checkpoint de breach. Permissionless, protegido por cooldown `RECORD_COOLDOWN` (22h).

- **Atualização do breach**:
  - Spot >= floor → reseta `lastFloorBreachTimestamp = 0`.
  - Spot < floor e timestamp == 0 → marca timestamp atual.
  - Spot < floor e timestamp > 0 → preserva (não reseta).
- **Bootstrap**: enquanto `dailyPriceCount < 90`, `ma90Price()` retorna 0 e o floor cai para `floorAbsoluteUsd` apenas. Bootstrap exige 90 invocações consecutivas (≈ 90 dias com keeper diário).
- **Reverte**: `BuybackInfraMissing` (oracle não setado), `RecordCooldownActive(nextAllowedAt)`, `InvalidOraclePrice`.
- **Eventos**: `DailyPriceRecorded(caller, priceUsd18, ma90Usd18, sampleCount)`.

### FFP — executeBuyback (`GOVERNANCE_ROLE`)

#### `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)`

Executa buyback de CREDIT pago em USDC e queima imediata. Defesa do floor price.

**Pré-condições (todas on-chain):**

1. Infra setada (oracle, router, feed) — caso contrário `BuybackInfraMissing`.
2. Spot TWAP < `currentFloorPrice()` — `SpotAboveFloor` se acima.
3. `block.timestamp - lastFloorBreachTimestamp >= triggerDurationSecs` — `BreachDurationInsufficient`.
4. Chainlink USDC/USD entre `[chainlinkSanityLowBps, chainlinkSanityHighBps]` e fresco — `UsdcDepegDetected`/`ChainlinkStale`/`InvalidChainlinkAnswer`.
5. `usdcAmount <= cap por evento` (20% das reservas correntes) — `CapPerEventExceeded`.
6. `monthlySpent + usdcAmount <= cap mensal` (30% do snapshot do mês) — `CapMonthlyExceeded`.
7. `usdcAmount > 0`, `minCreditOut > 0` — `ZeroAmount`.

**Ação:**

1. Approve `usdcAmount` ao router.
2. `exactInputSingle(USDC → CREDIT, recipient = treasury, amountOutMinimum = minCreditOut)`.
3. `CreditToken.burnByRole(treasury, creditOut, "treasury:buyback")` — CREDIT comprado é SEMPRE queimado (nunca acumulado).
4. Reset approve para 0.

- **Eventos**: `BuybackExecuted(usdcSpent, creditBurned, floorUsd, spotUsd, monthIndex)`.
- **ReentrancyGuard**: sim.

### POL — addPOL / removePOL / collectPOLFees (`GOVERNANCE_ROLE`)

#### `addPOL(uint256 creditAmount, uint256 usdcAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)`

Provisiona liquidez no pool CREDIT/USDC. Range FULL (`POL_TICK_LOWER`, `POL_TICK_UPPER`). NFT custodiado pelo Treasury.

- Primeira chamada (`polTokenId == 0`): `mint`. Armazena tokenId.
- Subsequente: `increaseLiquidity` no mesmo tokenId.

`amount0Min`/`amount1Min` na ordem do POOL (`token0 < token1` por endereço). Use `polTokensOrdered()` view para descobrir a ordem antes de submeter a proposta.

O `creditAmount` também é limitado a `unreservedCreditBalance()` — a parcela de CREDIT injetada no POL não pode invadir os ledgers reservados.

- **Reverte**: `ZeroAmount`, `BuybackInfraMissing` (USDC ou positionManager não setados), `TransferExceedsUnreservedCredit(available, requested)`.
- **Eventos**: `POLAdded(tokenId, liquidityAdded, creditAmount, usdcAmount)`.

#### `removePOL(uint128 liquidityAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)`

`decreaseLiquidity` + `collect`. NÃO queima o NFT (posição com 0 liquidez fica disponível para reuso via `addPOL`).

Política de exit: o gate "supermaioria 75% para remoções > 25%" é responsabilidade do `CommunityGovernor` (proposal type), não deste contrato.

- **Reverte**: `ZeroAmount`, `POLNotInitialized`, `BuybackInfraMissing`.
- **Eventos**: `POLRemoved(tokenId, liquidityRemoved, amount0Out, amount1Out)`.

#### `collectPOLFees(uint128 amount0Max, uint128 amount1Max)`

Coleta fees acumulados pela posição POL. Sem auto-compound — para reinvestir, governance chama `collectPOLFees` → `addPOL` em propostas separadas (ou batch via `executeBatch` do Timelock).

- **Reverte**: `POLNotInitialized`, `BuybackInfraMissing`.
- **Eventos**: `POLFeesCollected(tokenId, amount0, amount1)`.

### Fase 1.4 — Bucket bonders + gauge fallback

#### `depositPolRefill(uint256 amount)` — `POL_REFILL_DEPOSITOR_ROLE`

Acumula `amount` em `polRefillBucket`. Chamado pelo `RewardDistributorV2` após cunhar CREDIT diretamente para este Treasury. A invariante de segregação é enforced **também no lado das entradas**: se a reserva total pós-depósito (`polRefillBucket + pendingGaugeRewards`) exceder o saldo real de CREDIT, reverte — um depositor bugado/comprometido não consegue inflar o ledger além do lastro (o que congelaria toda saída genérica de CREDIT). O V2 minta o CREDIT ANTES de registrar, na mesma tx, então o fluxo legítimo passa.

- **Reverte**: `ZeroAmount`, `DepositExceedsCreditBalance(reservedAfter, creditBalance)`.
- **Eventos**: `PolRefillDeposited(amount, newBucketTotal)`.

#### `addPOLFromRefill(uint256 creditAmount, uint256 usdcAmount, ...)` — `GOVERNANCE_ROLE`

Drena `creditAmount` do `polRefillBucket` casado com `usdcAmount` do balance livre do Treasury para injeção em `polTokenId`. Reusa `_orderTokens` + `_provisionLiquidity`.

USDC vem do saldo LIVRE do Treasury. Atenção ao racional econômico: `treasuryBps` do FeeRouter é denominado em **CREDIT** (`FeeRouter.pay` transfere CREDIT ao Treasury), então NÃO alimenta o lado USDC desta função. As fontes reais de USDC são off-protocol: bootstrap externo (seed da DAO) e os fees da posição POL coletados via `collectPOLFees`. Sem USDC para casar, o bucket bonders cresce sem consumo — governance recicla via `writeDownPolRefillBucket`.

CEI: debita ledger ANTES da chamada externa (idempotência em revert).

- **Reverte**: `ZeroAmount`, `BuybackInfraMissing`, `PolRefillBucketInsufficient(requested, available)`.
- **Eventos**: `POLAdded` + `PolRefillUsed(creditUsed, usdcUsed, newBucketTotal)`.

#### `depositPendingGaugeRewards(uint256 amount)` — `GAUGE_FALLBACK_DEPOSITOR_ROLE`

Fallback contábil quando `gauge.paused() == true` no `finalizeRound`. Sem este caminho, pause do gauge travaria a finalização da rodada inteira (red flag E.3 #2). Mesma enforcement do lado das entradas de `depositPolRefill`.

- **Reverte**: `ZeroAmount`, `DepositExceedsCreditBalance(reservedAfter, creditBalance)`.
- **Eventos**: `PendingGaugeDeposited(amount, newPendingTotal)`.

#### `flushPendingGaugeRewards(uint256 amount, uint256 poolId, uint32 duration)` — `GOVERNANCE_ROLE`

Drena `amount` de `pendingGaugeRewards` para o gauge via `notifyRewardAmount(poolId, amount, duration)`. Aprova CREDIT, drena, reset approve. Aceita **flush parcial** e `poolId` explícito. Sentinelas:

- `amount == 0`: drena o ledger **inteiro** (comportamento original).
- `poolId == 0`: usa o `liquidityGaugePoolId` default de `setLiquidityGauge` (poolIds do gauge são 1-based; 0 nunca é pool válida).

Flush parcial + poolId explícito são a defesa contra o freeze por `IncentiveOverlap` do gauge: governance pode drenar para OUTRA pool whitelistada sem re-apontar `setLiquidityGauge`.

- **Reverte**: `LiquidityGaugeNotSet`, `LiquidityGaugePaused`, `NoPendingGaugeRewards`, `PendingGaugeRewardsInsufficient(requested, available)`.
- **Eventos**: `PendingGaugeFlushed(amount, poolId, duration)`.

#### `writeDownPolRefillBucket(uint256 amount)` — `GOVERNANCE_ROLE`

Reduz `polRefillBucket` em `amount` **sem mover tokens** — a parcela baixada volta ao saldo LIVRE de CREDIT (deixa de ser reservada). Válvula de reciclagem do bucket bonders: como `treasuryBps` do FeeRouter é denominado em CREDIT (não USDC), o bucket cresce a cada rodada sem contrapartida on-chain de USDC para casar em `addPOLFromRefill` — sem esta válvula a reserva cresceria monotonicamente até dominar o balanço de CREDIT.

- **Reverte**: `ZeroAmount`, `PolRefillBucketInsufficient(requested, available)`.
- **Eventos**: `PolRefillWrittenDown(amount, newBucketTotal)`.

#### `writeDownPendingGaugeRewards(uint256 amount)` — `GOVERNANCE_ROLE`

Reduz `pendingGaugeRewards` em `amount` sem mover tokens. Válvula de escape para o cenário em que `flushPendingGaugeRewards` fica inviável indefinidamente (ex.: `IncentiveOverlap` permanente em todas as pools) — sem ela o CREDIT do ledger ficaria congelado para sempre.

- **Reverte**: `ZeroAmount`, `PendingGaugeRewardsInsufficient(requested, available)`.
- **Eventos**: `PendingGaugeWrittenDown(amount, newPendingTotal)`.

#### `setLiquidityGauge(ILiquidityGaugeRewards gauge, uint256 poolId)` — `GOVERNANCE_ROLE`

Configura destino do flush.

- **Eventos**: `LiquidityGaugeSet(gauge, poolId)`.

### Setters FFP / POL (`GOVERNANCE_ROLE`)

`setPriceOracle`, `setSwapRouter`, `setSwapFeeTier`, `setChainlinkFeed`, `setFloorMultiplierBps`, `setFloorAbsoluteUsd`, `setTriggerDurationSecs`, `setTwapWindowSecs`, `setChainlinkSanityLowBps`, `setChainlinkSanityHighBps`, `setCapPerEventBps`, `setCapMonthlyBps`, `setSlippageMaxBps`, `setPositionManager`. Cada um com bounds documentados na tabela de storage.

- **Eventos**: `BuybackInfraUpdated(paramKey, addr, numeric)` para infra; `BuybackParamsUpdated(paramKey, newValue)` para params numéricos.

### Views

- `balanceOf(IERC20 token) → uint256`.
- `unreservedCreditBalance() → uint256` — `max(balanceOf(CREDIT) - polRefillBucket - pendingGaugeRewards, 0)`. Teto de toda saída genérica de CREDIT (`transfer`, `batchTransfer`, `payRebates`, `addPOL`).
- `currentMonthIndex() → uint256` — `block.timestamp / 30 days`.
- `ma90Price() → uint256` — média em USD 18 dec (0 se não bootstrapped).
- `currentFloorPrice() → uint256` — `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)`.
- `polPosition() → (tokenId, liquidity, tickLower, tickUpper, tokensOwed0, tokensOwed1)` — reverte `POLNotInitialized`.
- `polTokensOrdered() → (token0, token1, creditIsToken0)` — ordem real do par no pool.

## Eventos

| Evento | Quando | Indexados |
|---|---|---|
| `Transferred(token, to, amount)` | Toda saída | `token`, `to` |
| `BatchTransferred(token, total, count)` | `batchTransfer` | `token` |
| `RebatesPaid(token, round, total, count)` | `payRebates` | `token`, `round` |
| `ETHReceived(from, amount)` | `receive` | `from` |
| `ETHSwept(to, amount)` | `sweepETH` | `to` |
| `BuybackExecuted(...)` | `executeBuyback` | `monthIndex` |
| `DailyPriceRecorded(caller, price, ma90, count)` | `recordDailyPrice` | `caller` |
| `BuybackParamsUpdated(paramKey, newValue)` | Setters numéricos FFP | `paramKey` |
| `BuybackInfraUpdated(paramKey, addr, numeric)` | Setters de infra | `paramKey`, `addr` |
| `POLAdded(tokenId, liquidity, creditAmount, usdcAmount)` | `addPOL` / `addPOLFromRefill` | `tokenId` |
| `POLRemoved(tokenId, liquidity, amount0, amount1)` | `removePOL` | `tokenId` |
| `POLFeesCollected(tokenId, amount0, amount1)` | `collectPOLFees` | `tokenId` |
| `PolRefillDeposited(amount, newTotal)` | `depositPolRefill` | — |
| `PolRefillUsed(creditUsed, usdcUsed, newTotal)` | `addPOLFromRefill` | — |
| `PendingGaugeDeposited(amount, newTotal)` | `depositPendingGaugeRewards` | — |
| `PendingGaugeFlushed(amount, poolId, duration)` | `flushPendingGaugeRewards` | `poolId` |
| `PolRefillWrittenDown(amount, newTotal)` | `writeDownPolRefillBucket` | — |
| `PendingGaugeWrittenDown(amount, newTotal)` | `writeDownPendingGaugeRewards` | — |
| `LiquidityGaugeSet(gauge, poolId)` | `setLiquidityGauge` | `gauge` |

## Erros customizados

### Originais

`ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance(token, requested, available)`, `ETHTransferFailed`.

### Segregação de CREDIT (Fase 1.4)

| Erro | Quando |
|---|---|
| `TransferExceedsUnreservedCredit(available, requested)` | Saída genérica de CREDIT (`transfer`/`batchTransfer`/`payRebates`/`addPOL`) invadiria os ledgers reservados |
| `DepositExceedsCreditBalance(reservedAfter, creditBalance)` | Depósito em ledger (`depositPolRefill`/`depositPendingGaugeRewards`) elevaria a reserva total acima do saldo real de CREDIT |

### FFP

| Erro | Quando |
|---|---|
| `BuybackInfraMissing()` | Oracle/router/feed não setados |
| `SpotAboveFloor(spot, floor)` | Spot ≥ floor |
| `BreachDurationInsufficient(elapsed, required)` | Breach < trigger duration |
| `UsdcDepegDetected(answer, low, high)` | Chainlink fora da banda |
| `ChainlinkStale(updatedAt, maxStaleness)` | Feed congelado |
| `InvalidChainlinkAnswer(answer)` | answer ≤ 0 |
| `CapPerEventExceeded(requested, cap)` | Excede cap evento |
| `CapMonthlyExceeded(requested, alreadySpent, cap)` | Excede cap mensal |
| `RecordCooldownActive(nextAllowedAt)` | Cooldown 22h ativo |
| `ParamOutOfBounds(provided, min, max)` | Setter fora dos bounds |
| `InvalidOraclePrice()` | Oracle retornou 0 |

### POL / Fase 1.4

| Erro | Quando |
|---|---|
| `POLNotInitialized()` | `polTokenId == 0` em remove/collect |
| `PolRefillBucketInsufficient(requested, available)` | `addPOLFromRefill` / `writeDownPolRefillBucket` excede ledger |
| `LiquidityGaugeNotSet()` | `flushPendingGaugeRewards` sem gauge |
| `LiquidityGaugePaused()` | Flush com gauge paused |
| `NoPendingGaugeRewards()` | Flush com ledger zerado |
| `PendingGaugeRewardsInsufficient(requested, available)` | `flushPendingGaugeRewards` / `writeDownPendingGaugeRewards` com `amount` acima do ledger |

## Invariantes

- **I4 (Governance-only exit)**: toda saída de valor exige `GOVERNANCE_ROLE`. Em produção, exclusivo do Timelock.
- **IE7 (FFP)**: buyback executado abaixo do floor com TWAP 30min + slippage máximo 1% + cap por evento e mensal sobre reservas USDC.
- **CREDIT comprado é sempre queimado** — nunca acumulado em treasury. Reforça narrativa deflacionária e impede captura via whaledom interno de CREDIT.
- **Sem pause**: nenhum poder unilateral de congelar a tesouraria. Risco residual aceito em troca de descentralização.
- **Segregação on-chain de CREDIT (Fase 1.4)**: `polRefillBucket + pendingGaugeRewards <= balanceOf(CREDIT)` enforced nos **dois lados**. Saídas genéricas (`transfer`/`batchTransfer`/`payRebates`/`addPOL`) revertem se invadirem os ledgers (`TransferExceedsUnreservedCredit`); depósitos revertem se inflarem a reserva além do lastro (`DepositExceedsCreditBalance`). Os ledgers só são consumidos pelos caminhos dedicados (`addPOLFromRefill`, `flushPendingGaugeRewards`) e pelas válvulas `writeDown*`.
- **CEI**: ledgers debitados antes de chamadas externas (`addPOLFromRefill`, `flushPendingGaugeRewards`).
- **ReentrancyGuard**: todas as saídas de valor + `recordDailyPrice` (oracle externo).

## Observações importantes

### Por que CREDIT comprado é sempre queimado

Acumular CREDIT no Treasury via buyback criaria um agente endógeno de captura: o protocolo segurando seu próprio token. Isso:

1. Concentraria poder econômico no caixa.
2. Distorceria sinais de demanda (Treasury seria comprador residual permanente).
3. Convidaria propostas oportunistas para usar esse CREDIT em fluxos não-deflacionários.

Queimar imediatamente alinha o buyback à narrativa "demand-driven deflation" do FFP.

### Bootstrap do MA90

O MA90 só é considerado válido após 90 amostras consecutivas. Antes disso, `currentFloorPrice` retorna `floorAbsoluteUsd` apenas (default $0.10). Consequência: o protocolo pode rodar 90 dias com defesa **mínima** antes do floor relativo ativar — design deliberado para não bloquear bootstrap por falta de oracle.

### Cap mensal usa snapshot, não saldo corrente

Snapshot é tirado no primeiro buyback do mês. Razão: impede atacante manipular cap aumentando reservas USDC durante o mês (ex.: doação grande no dia 28 que dobraria o teto restante).

### POL range full vs concentrado

Decisão (ver `audit/economist/2026-04-24-pol-params.md`): range full (`-887220`, `887220`). Razões:

- Sem rebalance ativo (concentrado exigiria gerenciamento off-chain).
- Capital eficiente o suficiente em mercados early-stage.
- Auditável trivialmente (ticks fixos, sem decisão dinâmica).

Migration para concentrado pode acontecer na Fase 2 quando a DAO tiver dados de TVL/volume.

### Refill POL — fluxo completo

```
RewardDistributorV2.finalizeRound(R)
  -> CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
  -> Treasury.depositPolRefill(bondersAmount)
     - polRefillBucket += bondersAmount

(quando governance decide)

Proposta DAO: addPOLFromRefill(creditAmount, usdcAmount, ...)
  -> Treasury (Timelock executa)
  -> debita polRefillBucket
  -> _orderTokens + _approveNPM + _provisionLiquidity
  -> NPM.increaseLiquidity (ou mint se primeira)
  -> approve reset 0
```

### USDC do refill NÃO vem do FeeRouter

Erro comum: o `treasuryBps` do `FeeRouter` é denominado em **CREDIT**, não USDC (`FeeRouter.pay` transfere CREDIT ao Treasury). Portanto o split `(7000, 2000, 1000)` — 70% burn / 20% treasury / 10% rebate — alimenta o **lado CREDIT** do Treasury, não o lado USDC de `addPOLFromRefill`.

As fontes reais de USDC para casar com o CREDIT do bucket são off-protocol:

- **Bootstrap externo** — seed de USDC pela DAO.
- **`collectPOLFees`** — fees da posição POL, parte em USDC.

Se não houver USDC para casar, o bucket bonders (5% da emissão por rodada) cresce monotonicamente. A válvula `writeDownPolRefillBucket` recicla o excesso de volta ao saldo livre de CREDIT.

### Recebimento de ETH

`receive` emite `ETHReceived` — não é payable silencioso. Construtor não é payable.

### Tokens não-standard

`SafeERC20` em todas as saídas. `forceApprove` em todos os approves (USDT mainnet exige reset para 0 antes de novo set).

---

**Ver também**: [CreditPriceOracle](14-CreditPriceOracle.md), [FeeRouter](08-FeeRouter.md), [LiquidityGauge](13-LiquidityGauge.md), [RewardDistributorV2](07b-RewardDistributorV2.md), [UserSubsidy](12-UserSubsidy.md), [TeamVesting](11-TeamVesting.md).
