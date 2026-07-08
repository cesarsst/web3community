# Treasury e fees

**Para quem é:** quem quer entender o fluxo de caixa do protocolo.
**Pré-requisitos:** [Dual-token](01-dual-token-economy.md), [Governança](05-governance.md).

## O cofre da DAO

O `Treasury` é o cofre multi-ativo central. Três propriedades fundamentais:

1. **Recebe passivamente**. Não há função `deposit`. Qualquer um transfere ERC-20 (ou ETH via `receive`) direto para o endereço do Treasury.
2. **Só libera via governança**. Todas as funções de saída exigem `GOVERNANCE_ROLE`.
3. **Sem pause**. Deliberadamente não há função para congelar saídas. Qualquer poder unilateral de congelar a tesouraria seria vetor de captura.

A partir do pivot CLP (Fase 1, abril/2026), o Treasury também executa quatro funções econômicas adicionais:

| Função | Fase CLP | Resumo |
|---|---|---|
| **FFP buyback** | 1.1 | Swap real USDC → CREDIT + queima imediata, defendendo o floor |
| **POL** | 1.2 | Liquidez própria no pool CREDIT/USDC (NFT custodiado, range full) |
| **Bucket bonders** | 1.4 | Recebe 5% da emissão por rodada como ledger `polRefillBucket` |
| **Fallback gauge** | 1.4 | Acumula bucket LPs em `pendingGaugeRewards` quando gauge paused |

O Treasury recebe:

- **Genesis mint de CREDIT** (10M em produção — parâmetro `genesisAmount` do deploy). Única entrada "programática" inicial.
- **Fatia de `treasuryBps`** do split do `FeeRouter` (default de produção: `2000` = 20%, split `(7000, 2000, 1000)`). Chega em **CREDIT** — quem paga via `FeeRouter.pay` paga em CREDIT.
- **Colateral de slash** de projetos removidos com `slash == true`.
- **Subsídios devolvidos** de campanhas `UserSubsidy.closeCampaign`.
- **Bucket bonders** do `RewardDistributorV2` (5% da emissão por rodada — ledger `polRefillBucket`).
- **Bucket LPs** quando gauge paused (ledger `pendingGaugeRewards`).
- **Qualquer doação** que a DAO decidir aceitar.

## O que a DAO faz com o Treasury

Operações típicas, todas via proposta:

- **Pagar rebates a apps** (`payRebates(token, apps[], amounts[], round)`).
- **Patrocinar campanhas de `UserSubsidy`** — transferir CREDIT antes de `createCampaign`.
- **Fundar `TeamVesting`** — transferir GOV para vesting do beneficiário.
- **Executar FFP buyback** — `executeBuyback(usdcAmount, minCreditOut)` swap USDC → CREDIT + queima imediata (Fase 1.1).
- **Adicionar POL** — `addPOL(creditAmount, usdcAmount, ...)` provisiona liquidez no par CREDIT/USDC (Fase 1.2).
- **Refilar POL com bucket bonders** — `addPOLFromRefill(creditAmount, usdcAmount, ...)` casa CREDIT do ledger com USDC do balance livre.
- **Drenar fallback gauge** — `flushPendingGaugeRewards(amount, poolId, duration)` envia o ledger acumulado (total ou parcial) de volta para o gauge após despausar.
- **Financiar operações off-chain** — `transfer` para um multisig operacional.

## Fees — o FeeRouter

Interface **única** de pagamento entre usuários e apps. Função principal:

```solidity
function pay(uint256 projectId, address user, uint256 amount)
    external returns (uint256 burned, uint256 toTreasury, uint256 toApp);
```

O `user` precisa ter dado `approve(feeRouter, amount)` em CREDIT **antes**. `msg.sender` é quem iniciou a tx — pode ser o próprio user, o app, um relayer, uma smart wallet.

## Split padrão — 70 / 20 / 10

Em produção (`ignition/parameters/production.json`):

```
burnBps     = 7000   (70% queimado via BurnTracker)
treasuryBps = 2000   (20% para o Treasury)
rebateBps   = 1000   (10% para o appRecipient)
```

A soma tem que ser exatamente 10_000 (`_BPS_DENOMINATOR`). Splits diferentes são rejeitados com `InvalidSplit`.

Decisão de design: este é o split "Fase 0" recomendado no parecer CLP, assado nos parâmetros de deploy — o pré-requisito da Fase 1.4 (Treasury com receita recorrente) é satisfeito num deploy fresh, sem depender de proposta posterior. O trade-off é explícito: queima 70% (em vez dos 95% do desenho pré-CLP), captura 20% para o cofre e sobe o rebate para 10%. Se a DAO quiser rebalancear, basta propor `setDefaultSplit` — a arquitetura permite.

### Receita recorrente do split — e a denominação importa

Com `treasuryBps = 2000`, o Treasury acumula **receita operacional recorrente em CREDIT** (pagamentos via `FeeRouter.pay` são em CREDIT). Além dela, entram:

- Slash de colateral de projetos removidos com `slash == true` (eventual).
- Sobras de campanhas `UserSubsidy.closeCampaign` (eventual).
- Doações externas e ETH enviados direto.
- Bucket bonders e fallback gauge (Fase 1.4) — esses **acumulam em ledgers separados** (`polRefillBucket` e `pendingGaugeRewards`), não no balance livre. O bucket bonders é earmarkado para refill POL; só serve para esse fim.

**Atenção à denominação no refill do POL**: `addPOLFromRefill` casa CREDIT do `polRefillBucket` com **USDC** do balance livre — e a fatia `treasuryBps` chega em CREDIT, não em USDC. As fontes reais de USDC do Treasury são **bootstrap externo** (doação/venda aprovada pela DAO) e **`collectPOLFees`** (fees da própria posição POL acumulam em ambos os tokens do par). Se faltar USDC, o CREDIT do bucket não fica preso para sempre: governança pode reciclá-lo via `writeDownPolRefillBucket` (ver "Segregação on-chain" abaixo).

## Override por projeto

Alguns projetos podem negociar splits diferentes via proposta:

```solidity
feeRouter.setProjectSplit(projectId, Split({burnBps, treasuryBps, rebateBps}));
```

A flag `hasProjectSplit[projectId]` sinaliza que existe override. `clearProjectSplit` remove.

Uso típico: um app de alto volume que aceitaria taxa efetiva maior (porque tem outra fonte de receita) pode negociar `6000/3000/1000` (30% treasury), financiando mais agressivamente o cofre do que o default de 20%.

## Recipient do rebate

Por default, o rebate vai para `ProjectRegistry.getProject(projectId).owner`. Se o owner transfere o projeto, o destino muda automaticamente — **lookup dinâmico**.

O owner atual pode setar um endereço explícito via:

```solidity
feeRouter.setAppRecipient(projectId, recipient);
```

Útil quando o owner é um multisig e o rebate deve cair numa wallet operacional separada. Passar `address(0)` reseta para lookup dinâmico.

**Não é governance-gated** — é owner-gated. Rotação operacional de caixa não precisa de proposta.

## Dust handling

Em splits com divisão não-exata:

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- residuo vai aqui
```

Em vez de arredondar separadamente cada parcela (perde wei), o `toApp` captura o residuo. Consequência: o app pode receber 1-2 wei a mais que o calculado nominal. Aceitável e auditável.

## Fluxo completo de um pagamento

```
user tem 1000 CREDIT                FeeRouter
user chama approve(feeRouter, 1000) --- allowance OK
user chama pay(projectId, user, 1000)
                                      |
                                      v
                      Check: projectId esta Active
                      Check: user != 0, amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                      FeeRouter tem 1000 CREDIT
                                      |
                                      | split = 7000/2000/1000
                                      v
                        burned = 700, toTreasury = 200, toApp = 100
                                      |
          +---------------------------+----------------------------+
          |                           |                            |
          v                           v                            v
   approve(tracker, 700)       transfer(treasury, 200)      transfer(appRecipient, 100)
   tracker.burnAndRecord
                                                              appRecipient eh
                                                              projectOwner por default
                                      |
   tracker chama                      |
   credit.burnByRole(router, 700)     |
                                      |
   CREDIT.totalSupply -= 700          |
   burnByRoundProject[R][pid] += 700  |
   totalBurnByRound[R] += 700         |
                                      v
                              Paid event emitted
```

Após a tx: **FeeRouter tem 0 CREDIT**. Ele nunca custodia entre chamadas. Cada `pay` é atômico.

## Saídas de ETH

O Treasury aceita ETH via `receive` e pode sacar via `sweepETH(to, amount)`. Usa `call{value}` (não `transfer`/`send`) para compatibilidade com destinos que são contratos com `receive` pesado. Se o destino rejeitar, reverte com `ETHTransferFailed`.

O uso é de **cortesia** — o protocolo opera primariamente em ERC-20 (CREDIT, GOV, stables). ETH é aceito para não deixar doações travadas mas não é o fluxo principal.

## Buyback — FFP real (Fase 1.1)

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
| Treasury | Custódia multi-ativo | `GOVERNANCE_ROLE` nas saídas |
| FeeRouter | Interface de pagamento | `GOVERNANCE_ROLE` nos setters, público no `pay` |
| Split default | 70% burn / 20% treasury / 10% rebate (`(7000, 2000, 1000)` em produção) | Ajustável por proposta |
| Split por projeto | Override via `setProjectSplit` | `GOVERNANCE_ROLE` |
| Recipient do rebate | Owner do projeto (dinâmico) ou explícito | Owner do projeto (setter) |
| Buyback FFP | Real (Fase 1.1) — swap USDC→CREDIT + queima | `GOVERNANCE_ROLE` |
| POL | Liquidez própria CREDIT/USDC range full | `GOVERNANCE_ROLE` |
| Bucket bonders | 5% emissão → ledger refill POL | `POL_REFILL_DEPOSITOR_ROLE` (V2) |
| Fallback gauge | Ledger paused → flush manual | `GAUGE_FALLBACK_DEPOSITOR_ROLE` (V2) + governance |

---

**Próximo →** [Arquitetura](../03-protocol-overview/01-architecture.md)
