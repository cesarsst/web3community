# Parâmetros ajustáveis pela DAO

**Para quem é:** quem quer saber exatamente o que a DAO pode mudar e quais são as faixas permitidas.
**Pré-requisitos:** [Ciclo de uma proposta](01-proposal-lifecycle.md).

Esta página lista **todos** os parâmetros ajustáveis via governança nos 15 contratos de produção, o valor em produção, o bound on-chain, e qual função é usada para alterar.

## Contratos e funções de ajuste

### GovernanceToken

Owner em produção = `CommunityTimelock`. Propostas que chamem:

| Função | O que faz | Bound on-chain |
|---|---|---|
| `mint(to, amount, tag)` | Cunha GOV para `to` até atingir `CAP_SUPPLY` | Reverte com `CapExceeded` se supply pós-mint > 100M |

Sem setters de parâmetro — `CAP_SUPPLY` é imutável.

### CreditToken

Admin em produção = `CommunityTimelock`. Propostas:

| Função | O que faz | Bound on-chain |
|---|---|---|
| `grantRole(MINTER_ROLE, addr)` | Concede poder de mint | — |
| `revokeRole(MINTER_ROLE, addr)` | Revoga | — |
| `grantRole(BURNER_ROLE, addr)` | Concede poder de burn role-gated | — |
| `revokeRole(BURNER_ROLE, addr)` | Revoga | — |

`mintGenesis` não é chamável após a primeira execução (flag `genesisMinted`).

### ProjectRegistry

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `registerProject(owner, uri, collateral)` | Lista novo projeto | `collateral >= minCollateral` | — |
| `activateProject(id)` | Pending → Active | status deve ser Pending | — |
| `setProbation(id)` | Active → Probation | status deve ser Active | — |
| `reactivate(id)` | Probation → Active | status deve ser Probation | — |
| `removeProject(id, slash, treasury)` | → Removed | status != Removed | — |
| `setMinCollateral(newMin)` | Ajusta colateral mínimo | `newMin > 0` | `10.000 GOV` |
| `setProbationDuration(newDuration)` | Ajusta probation inicial | `newDuration > 0` | `2.592.000 seg` (30d) |

### Treasury

Movimentação de fundos (todas `GOVERNANCE_ROLE` = Timelock):

| Função | O que faz | Bound on-chain |
|---|---|---|
| `transfer(token, to, amount)` | Envia ERC-20 | saldo suficiente; para CREDIT, não pode invadir reservas `polRefillBucket + pendingGaugeRewards` (`TransferExceedsUnreservedCredit`) |
| `batchTransfer(token, recipients[], amounts[])` | Batch de transfers | arrays válidos, saldo total suficiente, mesma regra de reservas para CREDIT |
| `payRebates(token, apps[], amounts[], round)` | Batch com evento semântico | idem |
| `executeBuyback(usdcAmount, minCreditOut)` | **Buyback real (FFP, Fase 1.1)**: swap USDC → CREDIT via Uniswap V3 + burn imediato do CREDIT comprado | infra setada (oracle/router/feed); spot TWAP < floor por >= `triggerDurationSecs`; sanidade Chainlink USDC/USD; `usdcAmount` <= cap por evento e cap mensal; `minCreditOut > 0` |
| `sweepETH(to, amount)` | Saca ETH | `balance suficiente` |

Parâmetros FFP (buyback/floor) — setters `GOVERNANCE_ROLE`, bounds via `_checkBounds` (`ParamOutOfBounds` se fora):

| Função | Bound on-chain | Default |
|---|---|---|
| `setFloorMultiplierBps(bps)` | `[3000, 8000]` | `5000` (floor relativo = 50% da MA90) |
| `setFloorAbsoluteUsd(value)` | `[1e16 ($0.01), 1e19 ($10.00)]` | `1e17` ($0.10) |
| `setTriggerDurationSecs(secs)` | `[1 hour, 7 days]` | `24 hours` |
| `setTwapWindowSecs(secs)` | `[5 minutes, 2 hours]` | `30 minutes` |
| `setChainlinkSanityLowBps(bps)` | `[9000, 9999]` | `9900` (0.99) |
| `setChainlinkSanityHighBps(bps)` | `[10001, 11000]` | `10100` (1.01) |
| `setCapPerEventBps(bps)` | `[100, 5000]` | `2000` (20% das reservas USDC) |
| `setCapMonthlyBps(bps)` | `[100, 7000]` | `3000` (30% do snapshot mensal) |
| `setSlippageMaxBps(bps)` | `[10, 500]` | `100` (1%) |
| `setSwapFeeTier(fee)` | `!= 0` (fail-fast no swap se pool não existir) | `3000` (0.3%) |
| `setPriceOracle(oracle)` / `setSwapRouter(router)` / `setChainlinkFeed(feed)` | sem bound; `address(0)` desabilita/pausa o buyback | `address(0)` até proposta setar |

POL e saldos reservados (Fases 1.2/1.3):

| Função | O que faz | Observação |
|---|---|---|
| `addPOL(...)` / `addPOLFromRefill(creditAmount, usdcAmount, ...)` | Provisiona liquidez CREDIT/USDC (posição NFT custodiada no Treasury) | `GOVERNANCE_ROLE` |
| `removePOL(liquidityAmount, amount0Min, amount1Min, deadline)` | Remove liquidez POL | `GOVERNANCE_ROLE` **+ supermaioria 75% no Governor** (scan de `propose`) |
| `collectPOLFees(amount0Max, amount1Max)` | Coleta fees da posição POL | `GOVERNANCE_ROLE` |
| `depositPolRefill(amount)` / `depositPendingGaugeRewards(amount)` | Creditam os ledgers reservados | roles dedicadas; reserva agregada pós-depósito não pode exceder `balanceOf(CREDIT)` (`DepositExceedsCreditBalance`) |
| `flushPendingGaugeRewards(amount, poolId, duration)` | Drena ledger para incentive no gauge (`0` = tudo / pool default) | `GOVERNANCE_ROLE` |
| `writeDownPolRefillBucket(amount)` / `writeDownPendingGaugeRewards(amount)` | Válvulas de write-down dos ledgers (escape/reciclagem) | `GOVERNANCE_ROLE`, eventos auditáveis |

### Staking

Sem parâmetros ajustáveis. `MIN_LOCK`, `MAX_LOCK`, `MULTIPLIER_PRECISION`, `MAX_MULTIPLIER` são `constant`.

### BurnTracker

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `closeRound()` | Fecha rodada atual, abre próxima | — | — |
| `setRoundDuration(new)` | Ajusta duração alvo da rodada | `[MIN_ROUND_DURATION=1d, MAX_ROUND_DURATION=30d]` | `604.800 seg` (7d) |
| `setMaxBurnPerRoundPerProject(new)` | Sanity cap; 0 = desabilita | — | `10M CREDIT` |
| `grantRole(RECORDER_ROLE, app)` | Autoriza app a chamar `burnAndRecord` | — | — |
| `revokeRole(RECORDER_ROLE, app)` | Desautoriza | — | — |

### RewardDistributor

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `finalizeRound(round)` | Grava emissão imutável da rodada | sequencial, rodada fechada no tracker | — |
| `setAlpha(new)` | Ajusta alpha | `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` | `0.95e18` |
| `setCapMax(new)` | Ajusta teto por rodada | `[MIN_CAPMAX=1e18, MAX_CAPMAX=100M*1e18]` | `5M CREDIT` |
| `grantRole(GOVERNANCE_ROLE, addr)` | idem | — | — |

`floorSchedule` é **imutável** após deploy.

### RewardDistributorV2 (deploy opcional — Fase F / pivot CLP)

Herda `setAlpha`/`setCapMax`/`finalizeRound` com os mesmos bounds do V1, e adiciona o split de emissão em 4 buckets:

| Função | O que faz | Bound on-chain | Valor default |
|---|---|---|---|
| `setBucketBps([stakers, lps, apps, bonders])` | Split da emissão por rodada | soma `== 10.000`; `stakers >= 3000`; `lps >= 500`; `apps <= 2500`; `bonders <= 2000` | `[5500, 2500, 1500, 500]` (55/25/15/5) |

### LiquidityGauge (deploy opcional — Fase F / pivot CLP)

| Função | O que faz | Bound on-chain |
|---|---|---|
| `addPool(pool)` / `setPoolEnabled(poolId, enabled)` | Whitelist de pools Uniswap V3 | — |
| `setVestingDuration(newDuration)` | Vesting dos rewards de LP | `[VESTING_DURATION_MIN=1d, VESTING_DURATION_MAX=90d]` |
| `setDenylist(account, denied)` / `pause()` / `unpause()` | Controles operacionais | — |
| `endIncentive(poolId)` | Encerra incentive e recupera refund | — |
| `governanceRescueRewards(to, amount)` | Resgata CREDIT **não-reservado** | limitado por `getUnreservedBalance()` — `totalVestingLocked` (vesting de usuários) é intocável (`RescueExceedsUnreserved`) |

### CreditPriceOracle

**Sem parâmetros ajustáveis** — adapter imutável por design (sem owner, sem setters, sem storage mutável): pool, tokens, feed Chainlink, staleness (6h) e banda de sanidade (`[9900, 10100]` bps) são fixados no constructor. Para mudar qualquer coisa, deploya-se outro adapter e a governança aponta via `Treasury.setPriceOracle(oracle)`.

### FeeRouter

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `setDefaultSplit(split)` | Split global default | `burnBps + treasuryBps + rebateBps == 10.000` | `(7000, 2000, 1000)` — 70% burn / 20% treasury / 10% rebate (Fase 0) |
| `setProjectSplit(id, split)` | Override por projeto | idem | — |
| `clearProjectSplit(id)` | Remove override | override precisa existir | — |

`setAppRecipient(id, recipient)` é owner-gated (não governance).

### UserSubsidy

| Função | O que faz | Bound on-chain |
|---|---|---|
| `createCampaign(root, amountPerUser, maxClaims, deadline)` | Abre campanha Merkle | `root != 0, amount > 0, maxClaims > 0, deadline > now` |
| `closeCampaign(id, returnTo)` | Fecha e devolve sobras | campanha existe e não fechada |

### TeamVesting

Uma instância por beneficiário. Owner = `CommunityTimelock`.

| Função | O que faz | Bound on-chain |
|---|---|---|
| `revoke(returnTo)` | One-shot; congela fronteira | `!revoked, returnTo != 0` |

Cronograma (`start`, `cliff`, `duration`) é imutável (setado no constructor).

### CommunityTimelock

Self-administered pós-handoff. Propostas:

| Função | O que faz |
|---|---|
| `updateDelay(newDelay)` | Ajusta `minDelay`. Novo valor aplicado a propostas futuras. |
| `grantRole(PROPOSER_ROLE, addr)` | Adiciona proposer |
| `revokeRole(PROPOSER_ROLE, addr)` | Remove |
| `grantRole(CANCELLER_ROLE, addr)` | Adiciona canceller |
| `revokeRole(CANCELLER_ROLE, addr)` | Remove |
| `grantRole(EXECUTOR_ROLE, addr)` | Adiciona executor |

### CommunityGovernor

Todas as mudanças são `onlyGovernance` (precisam vir via proposta aprovada pelo próprio Governor). Valores em produção em `ignition/parameters/production.json`.

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `setVotingDelay(new)` | Ajusta delay até abrir votação | `> 0` (uint48) | `7200` (~1d) |
| `setVotingPeriod(new)` | Ajusta duração da votação | `> 0` (uint32) | `50400` (~7d) |
| `setProposalThreshold(new)` | Ajusta threshold para propor | `>= 0` | `10.000 * 1e18 GOV` |
| `updateQuorumNumerator(new)` | Ajusta numerador do quorum | `[0, 100]` | `4` |
| `relay(target, value, data)` | Executa operação arbitrária como se fosse o governor (rara) | — | — |

**Supermaioria 75% (enforced on-chain, não ajustável).** O `propose` escaneia o batch: se qualquer call tem target no `TREASURY` (immutable, setado no constructor) com selector de `Treasury.removePOL` (`0x6a71d4b3`) ou de gestão de roles (`grantRole`/`revokeRole`/`renounceRole`), ou target no próprio Timelock com selector de gestão de roles, a proposta inteira é marcada `ProposalType.Supermajority` (evento `ProposalTypeSet`) e só passa com `forVotes >= 3 × againstVotes` e `forVotes > 0` (For >= 75% dos votos decisivos; Abstain fora da razão). Batch misto contamina a proposta inteira — por design.

## Parâmetros imutáveis

A DAO **não pode** alterar:

| Parâmetro | Onde | Valor |
|---|---|---|
| `CAP_SUPPLY` do GOV | `GovernanceToken` | 100.000.000 * 1e18 |
| `MIN_LOCK` do Staking | `Staking` | 14 dias |
| `MAX_LOCK` do Staking | `Staking` | 365 dias |
| `MAX_MULTIPLIER` do Staking | `Staking` | 4e18 |
| `MULTIPLIER_PRECISION` do Staking | `Staking` | 1e18 |
| `MIN_ROUND_DURATION` | `BurnTracker` | 1 dia |
| `MAX_ROUND_DURATION` | `BurnTracker` | 30 dias |
| `MIN_ALPHA`, `MAX_ALPHA` | `RewardDistributor` | `0.5e18`, `0.99e18` (reduzido de `1.1e18` — ver `audit/economist/2026-04-22-consistency-audit.md` C2; garante IE1 α<1 permanente por construção) |
| `MIN_CAPMAX`, `MAX_CAPMAX` | `RewardDistributor` | `1e18`, `100M*1e18` |
| `FLOOR_SCHEDULE_LENGTH` | `RewardDistributor` | 24 |
| `PROBATION_PENALTY_DENOM` | `RewardDistributor` | 4 (25%) |
| `floorSchedule` (valores) | `RewardDistributor` | gravados no deploy |
| `_BPS_DENOMINATOR` | `FeeRouter` | 10.000 |
| Regra de supermaioria 75% (`removePOL` / gestão de roles no Treasury/Timelock) | `CommunityGovernor` | `forVotes >= 3 × againstVotes`; `TREASURY` é `immutable` |
| Bounds dos buckets do V2 | `RewardDistributorV2` | `MIN_BUCKET_STAKERS_BPS=3000`, `MIN_BUCKET_LPS_BPS=500`, `MAX_BUCKET_APPS_BPS=2500`, `MAX_BUCKET_BONDERS_BPS=2000` |
| Configuração inteira do oracle | `CreditPriceOracle` | pool/tokens/feed/staleness 6h/banda `[9900, 10100]` — tudo no constructor |
| Endereços dos contratos | deploy | fixos |
| `CommunityGovernor` `name` (EIP-712) | `CommunityGovernor` | "CommunityGovernor" |

Esses valores são o **piso constitucional** do protocolo: nem a DAO unânime pode alterar.

## Como propor uma mudança de parâmetro

Exemplo: reduzir `alpha` de `0.95e18` para `0.90e18`.

```solidity
targets   = [address(rewardDistributor)];
values    = [0];
calldatas = [
    abi.encodeWithSelector(rewardDistributor.setAlpha.selector, 0.90e18)
];
description = "Reduce alpha to 0.90 to increase deflationary pressure";

governor.propose(targets, values, calldatas, description);
```

Pré-requisitos:

- O proposer tem >= 10k GOV delegados.
- O valor novo `0.90e18` está dentro de `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]`. Se fora, a execução reverte (mesmo com voto aprovado).

## Efeito temporal das mudanças

Mudanças de parâmetro entram em vigor **no bloco da execução** e afetam apenas estado futuro:

- `setAlpha` altera o cálculo de `finalizeRound` para rodadas **não-finalizadas**. Rodadas com `roundData[r].finalized == true` têm `totalEmission` imutável.
- `setCapMax` idem.
- `setRoundDuration` afeta rodadas futuras (rodadas já abertas não são truncadas).
- `setMaxBurnPerRoundPerProject` afeta gatings em novos `burnAndRecord` — acumulados passados permanecem.
- `setDefaultSplit` / `setProjectSplit` afetam `pay`s futuros.
- `setMinCollateral` / `setProbationDuration` afetam **novos** registros; existentes não são grandfather-alterados.

## Observabilidade

Eventos de mudança de parâmetro:

```
# RewardDistributor
event AlphaUpdated(uint256 oldAlpha, uint256 newAlpha);
event CapMaxUpdated(uint256 oldCap, uint256 newCap);

# BurnTracker
event RoundDurationUpdated(uint64 oldDuration, uint64 newDuration);
event MaxBurnPerRoundPerProjectUpdated(uint256 oldMax, uint256 newMax);

# FeeRouter
event DefaultSplitUpdated(Split oldSplit, Split newSplit);
event ProjectSplitUpdated(uint256 indexed projectId, Split newSplit);
event ProjectSplitCleared(uint256 indexed projectId);

# ProjectRegistry
event MinCollateralUpdated(uint256 oldMin, uint256 newMin);
event ProbationDurationUpdated(uint64 oldDuration, uint64 newDuration);

# Treasury (FFP)
event BuybackParamsUpdated(bytes32 indexed paramKey, uint256 newValue);
event BuybackInfraUpdated(bytes32 indexed paramKey, address indexed addrOrZero, uint256 numericOrZero);

# RewardDistributorV2
event BucketBpsUpdated(uint16[4] oldBps, uint16[4] newBps);

# CommunityGovernor
event ProposalTypeSet(uint256 indexed proposalId, ProposalType proposalType);
```

Indexadores externos devem monitorar e mostrar histórico de parâmetros para transparência.

---

**Próximo →** [Referência de contratos](../08-contracts-reference/)
