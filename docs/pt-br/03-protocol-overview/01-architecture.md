# Arquitetura

**Para quem é:** dev querendo mapa completo de dependências entre contratos.
**Pré-requisitos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Governança](../02-core-concepts/05-governance.md).

## O trilho vigente (remodel 2026-07-08) — 3 contratos novos

Desde o remodel, o fluxo econômico ativo passa por **CreditPSM → FeeRouterV2 → ProjectFunding**. O ciclo burn-to-mint (FeeRouter V1, BurnTracker, RewardDistributor V1/V2, LiquidityGauge) fica deployado como legado, fora do fluxo vigente.

```
   [ USDC do usuario ]
        |
        | buy() 1:1 (6 -> 18 dec)                    sell() 1:1 (queima CREDIT,
        v                                            devolve USDC)
   +-----------------------------+  <---------------------------------+
   |         CreditPSM           |                                    |
   |  lastro USDC 100% retido    |   MINTER_ROLE + BURNER_ROLE        |
   |  sem funcao de saque        |   no CreditToken                   |
   +-------------+---------------+                                    |
                 | CREDIT estavel (1:1 USDC)                          |
                 v                                                    |
   +-----------------------------+       +--------------------------+ |
   |        FeeRouterV2          |       |      ProjectFunding      | |
   |  pay(projectId, amount)     |       |  openRound (dono, 1x)    | |
   |  fee 2,5% (teto duro 5%)    |       |  invest (exige GOV       | |
   |    40% treasury             |       |    stakeado no projeto)  | |
   |    40% buyback GOV          | rev-  |  all-or-nothing          | |
   |    20% grants               | share |  claim (rev-share,       | |
   |  grossVolumeOf[projectId]   |------>|    nunca expira)         | |
   +------+---------------+-----+notify |  totalRevenueDistributed | |
          |               |     Revenue +------------+-------------+ |
          | isActive      |                          | getWeight     |
          v               | toApp (~89,5-97,5%)      v               |
   +--------------+       |                  +--------------+        |
   | Project-     |       +----------------> | Staking      |        |
   | Registry     |         appRecipient     | (GOV, gate   |        |
   | (whitelist)  |         na hora          |  de invest)  |        |
   +--------------+                          +--------------+        |
                                                                     |
   [ investidor / app / treasury ] --- CREDIT resgatavel a qualquer momento
```

Quem chama quem (trilho vigente):

| Chamador | Chama | Quando |
|---|---|---|
| `CreditPSM.buy` | `USDC.safeTransferFrom` + `CREDIT.mint(user, ..., "psm:buy")` | compra 1:1 |
| `CreditPSM.sell` | `CREDIT.safeTransferFrom` + `CREDIT.burnByRole(psm, ..., "psm:sell")` + `USDC.safeTransfer` | resgate 1:1 |
| `FeeRouterV2.pay` | `REGISTRY.isActive(projectId)` | gate |
| `FeeRouterV2.pay` | `CREDIT.safeTransferFrom(payer, router, amount)` | puxa o pagamento |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer` para treasury/buyback/grants | split 40/40/20 da fee |
| `FeeRouterV2.pay` | `FUNDING.revShareBpsOf(projectId)` | lê rev-share ativo |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer(funding, revShare)` + `FUNDING.notifyRevenue` | credita investidores |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer(appRecipient, toApp)` | paga o app na hora |
| `ProjectFunding.openRound` | `REGISTRY.isActive` + `getProject(...).owner` | só dono, projeto Active |
| `ProjectFunding.invest` / `claim` | `STAKING.getWeight(investor, projectId)` | gate de GOV stakeado |
| `ProjectFunding.invest` (alvo batido) | `CREDIT.safeTransfer(owner, raised)` | all-or-nothing paga o dono |

Roles do trilho vigente:

```
   CreditPSM
       |  detem MINTER_ROLE + BURNER_ROLE no CreditToken
       |  (sem AccessControl proprio — zero superficie administrativa)

   FeeRouterV2
       |  GOVERNANCE_ROLE (Timelock): setFeeBps (teto 500), setFeeSplit, setRecipients
       |  detem REVENUE_NOTIFIER_ROLE no ProjectFunding

   ProjectFunding
       |  GOVERNANCE_ROLE (Timelock): setMinTarget
       |  REVENUE_NOTIFIER_ROLE concedida ao FeeRouterV2
```

Referência por contrato: [CreditPSM](../08-contracts-reference/15-CreditPSM.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

## Mapa do trilho legado burn-to-mint (pré-remodel) — demais contratos

> ⚠️ **LEGADO** — o mapa abaixo descreve o ciclo burn-to-mint substituído pelo remodel 2026-07-08. Os contratos continuam deployados por compatibilidade histórica (claims antigos, dados on-chain), mas o fluxo econômico vigente é o da seção acima. Registry, Staking, Treasury, tokens e governança (Governor/Timelock) seguem ativos nos dois trilhos.

```
                               +-----------------------------+
                               |     CommunityGovernor       |    (camada politica)
                               |     - coleta votos          |
                               |     - cria propostas        |
                               +-------------+---------------+
                                             | schedule()
                                             v
                               +-----------------------------+
                               |     CommunityTimelock       |    (executor)
                               |     detem GOVERNANCE_ROLE   |
                               |     em todos abaixo         |
                               +----+-------------------+----+
                                    |                   |
          +---------+----------+----+----+--------+--------+----------+----------+
          |         |          |         |        |        |          |          |
          v         v          v         v        v        v          v          v
  +---------+  +----------+  +-------+  +------+  +-----+  +-------+  +-------+  +-----+
  |Project- |  | Treasury |  |Staking|  |Burn- |  |Fee- |  |Liquid-|  |Reward-|  |Reward
  |Registry |  | + FFP    |  |stake+ |  |Tracke|  |Route|  |ity-   |  |Distri-|  |Distri-
  | whtlst  |  | + POL    |  |weights|  |burn  |  |split|  |Gauge  |  |butor  |  |buto-
  | + ownerR|  | + buckets|  |       |  |      |  |     |  |LP rwd |  |  V1   |  |rV2
  +----+----+  +----+-----+  +---+---+  +--+---+  +--+--+  +---+---+  +---+---+  +---+--+
       |            ^            |         |        |        ^           ^         |
       | isActive/  |            |         |        |        |           |         |
       | isInProb./ | spend +    |         |        | apprv  | notify    | claim   | finaliz
       | ownerRecip.| addPOL     |         |        | +burn  | (LP rwd)  | (V1)    | + push
       v            | +buckets   v         v        v        |           |         | apps/lps/bond
      +-------------+----------------------+--------+--------+-----------+---------+
      |                          RewardDistributorV2                              |
      | totalEmission = min(max(alpha*burn, floor), capMax)                       |
      | split em 4 buckets: stakers (lazy) | LPs (push gauge) | apps (push)       |
      |                     | bonders (push Treasury polRefill)                   |
      +---------------------------------------------------------------------------+
                                             ^
                             grants MINTER_ROLE (V1 + V2, durante migration window)
                             apos cutoff: V1 perde MINTER_ROLE
                                             |
                               +-----------------------------+
                               |        CreditToken          |
                               |        ERC-20 burnable      |
                               +-----------------------------+
                                             ^
                                             | burnByRole
                               +-----------------------------+
                               |        BurnTracker          | (volta aqui pq chama
                               +-----------------------------+  burnByRole no CREDIT)

   GovernanceToken (GOV) ---- stakado em Staking
                         ---- colateral em ProjectRegistry
                         ---- vestido em TeamVesting
                         ---- vota em CommunityGovernor

   Pool externo Uniswap V3: CREDIT/USDC 0.3%
       ^                                ^
       | (POL custodiado pelo Treasury) | (LP externo + UniswapV3Staker
       |                                |  controlado pelo LiquidityGauge)
       |                                |
   Treasury.polTokenId          LiquidityGauge.stake(tokenId, poolId)

   +---------------------------+
   |    CreditPriceOracle      |   adapter ICreditPriceOracle (tudo immutable)
   | TWAP Uniswap V3           |   <- Treasury.priceOracle (setado via
   |   CREDIT/USDC (observe)   |      setPriceOracle pelo governance)
   | x Chainlink USDC/USD      |   recordDailyPrice / executeBuyback leem
   |   (staleness 6h + banda   |      peekTwapPrice(twapWindowSecs)
   |    [0.99, 1.01])          |
   +---------------------------+

   Contratos auxiliares:
   +----------------+   +------------------+
   |  TeamVesting   |   |   UserSubsidy    |
   |  vesting GOV   |   | subsidio CREDIT  |
   |  per-membro    |   | via Merkle drops |
   +----------------+   +------------------+
   (fundados pelo Timelock com GOV/CREDIT transferido do Treasury)
```

## Quem chama quem (trilho legado)

| Chamador | Chama | Quando |
|---|---|---|
| `FeeRouter.pay` | `CREDIT.transferFrom(user, this, amount)` | puxa o valor total |
| `FeeRouter.pay` | `CREDIT.transfer(recipient, toApp)` | paga rebate ao app |
| `FeeRouter.pay` | `CREDIT.transfer(treasury, toTreasury)` | se `treasuryBps > 0` |
| `FeeRouter.pay` | `CREDIT.forceApprove(burnTracker, burned)` + `BurnTracker.burnAndRecord` | queima a fatia de burn |
| `BurnTracker.burnAndRecord` | `CREDIT.burnByRole(from, amount, tag)` | `_burn` nativo |
| `RewardDistributorV2.finalizeRound` | `BurnTracker.getTotalBurnForRound(round-1)` | lê burn anterior |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(ownerRecipient(p), share, "rewardRound:apps")` | bucket apps |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(self, lpsAmount)` + `gauge.notifyRewardAmount(...)` | bucket LPs (gauge ativo) |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(treasury, lpsAmount)` + `treasury.depositPendingGaugeRewards(...)` | bucket LPs (gauge paused) |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(treasury, bondersAmount)` + `treasury.depositPolRefill(...)` | bucket bonders |
| `RewardDistributorV2._calculateClaim` | `Staking.getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` | snapshot de peso |
| `RewardDistributorV2._calculateClaim` | `ProjectRegistry.isInProbation(projectId)` | penalty |
| `RewardDistributorV2._claim` | `CREDIT.mint(user, amount, "rewardRoundV2:stakers")` | bucket stakers (lazy) |
| `Treasury.executeBuyback` | `swapRouter.exactInputSingle(USDC→CREDIT)` + `CREDIT.burnByRole(self, ...)` | FFP buyback |
| `Treasury.recordDailyPrice` | `priceOracle.peekTwapPrice(twapWindowSecs)` | atualiza MA90 + breach (`CreditPriceOracle` em produção) |
| `CreditPriceOracle.peekTwapPrice` | `POOL.observe([window, 0])` | tick médio → preço TWAP CREDIT/USDC em 18 dec |
| `CreditPriceOracle.peekTwapPrice` | `CHAINLINK_USDC_FEED.latestRoundData()` | converte USDC→USD (staleness 6h + banda 0.99–1.01) |
| `Treasury.addPOL` / `addPOLFromRefill` | `NPM.mint` ou `NPM.increaseLiquidity` | provisiona POL |
| `Treasury.flushPendingGaugeRewards` | `gauge.notifyRewardAmount(poolId, amount, duration)` | drena fallback |
| `LiquidityGauge.stake` | `NPM.safeTransferFrom(user→staker, tokenId, IncentiveKey)` | auto-stake no staker oficial |
| `LiquidityGauge.unstake` | `STAKER.unstakeToken/claimReward/withdrawToken` | saída + cria VestingPosition |
| `LiquidityGauge.harvest` | `CREDIT.safeTransfer(user, claimed)` | saca vested |
| `Staking.stake` / `increaseStake` | `ProjectRegistry.isActive(projectId)` | gate |
| `Staking.stake` | `GOV.safeTransferFrom(user, this, amount)` | pull colateral |
| `Staking.unstake` | `ProjectRegistry.getProject(projectId)` | bypass se Removed |
| `Staking.unstake` | `GOV.safeTransfer(user, amount)` | devolve |
| `ProjectRegistry.registerProject` | `GOV.safeTransferFrom(owner, this, collateral)` | pull colateral |
| `ProjectRegistry.removeProject` | `GOV.safeTransfer(destination, collateral)` | devolve ou slash |
| `FeeRouter.pay` | `ProjectRegistry.isActive(projectId)` | gate |
| `FeeRouter._effectiveRecipient` | `ProjectRegistry.getProject(projectId)` | lookup dinâmico do owner |
| `RewardDistributorV2._emitAppsBucket` | `ProjectRegistry.ownerRecipient(p)` | recipient apps (timelock 48h) |
| `Treasury.payRebates` | `TOKEN.safeTransfer(app, amount)` | batch para apps |
| `CommunityGovernor._queueOperations` | `CommunityTimelock.schedule(...)` | enfileira execução |
| `CommunityTimelock.execute*` | `CALLS.execute(...)` | chama função alvo (Registry, Treasury, etc) |

## Pós-deploy: o grafo de roles

```
   CommunityTimelock (self-administered apos handoff)
       |
       |  detem GOVERNANCE_ROLE em:
       |  - FeeRouterV2 (fee, split da fee, recipients)     [vigente]
       |  - ProjectFunding (minTarget)                      [vigente]
       |  - Treasury (incl. FFP, POL, ledgers Fase 1.4)
       |  - ProjectRegistry (incl. cancelOwnerRecipient escape hatch)
       |  - BurnTracker                                     [legado]
       |  - RewardDistributor (V1 — claim-only)             [legado]
       |  - RewardDistributorV2                             [legado]
       |  - FeeRouter                                       [legado]
       |  - LiquidityGauge                                  [legado]
       |  - UserSubsidy
       |
       |  detem DEFAULT_ADMIN_ROLE em todos os acima
       |
       |  eh owner de:
       |  - GovernanceToken (apos acceptOwnership)
       |  - cada TeamVesting

   CommunityGovernor
       |
       |  detem PROPOSER_ROLE + CANCELLER_ROLE no Timelock

   address(0)
       |
       |  conta como executor autorizado no Timelock
       |  (qualquer um pode chamar execute apos delay)

   RewardDistributor (V1)
       |
       |  detem MINTER_ROLE no CreditToken (durante migration window de 4 rounds)
       |  apos cutoff: governance revoga MINTER_ROLE — V1 vira read-only

   RewardDistributorV2
       |
       |  detem MINTER_ROLE no CreditToken (permanente)
       |  detem POL_REFILL_DEPOSITOR_ROLE no Treasury
       |  detem GAUGE_FALLBACK_DEPOSITOR_ROLE no Treasury
       |  detem REWARD_NOTIFIER_ROLE no LiquidityGauge

   CreditPSM
       |
       |  detem MINTER_ROLE + BURNER_ROLE no CreditToken (trilho vigente;
       |  burn sempre sobre saldo proprio, mint 1:1 lastreado)

   FeeRouterV2
       |
       |  detem REVENUE_NOTIFIER_ROLE no ProjectFunding
       |  (unico autorizado a notifyRevenue)

   BurnTracker
       |
       |  detem BURNER_ROLE no CreditToken

   FeeRouter
       |
       |  detem RECORDER_ROLE no BurnTracker (v1 bootstrap)
       |  novos apps listados tambem recebem RECORDER_ROLE
       |  (via proposta aprovada + execucao do Timelock)

   LiquidityGauge
       |
       |  REWARD_NOTIFIER_ROLE plural:
       |  - concedida ao Treasury (caminho manual: flushPendingGaugeRewards)
       |  - concedida ao RewardDistributorV2 (caminho automatico em finalizeRound)
       |
       |  denylist anti self-dealing:
       |  - Treasury, Staking, RewardDistributor*, FeeRouter denylisted
       |    no bootstrap (D.9 — protocolo nao paga rewards a si mesmo)
```

## Dependências de imports Solidity

```
GovernanceToken       -> OZ: ERC20, ERC20Permit, ERC20Votes, Ownable2Step
CreditToken           -> OZ: ERC20, ERC20Burnable, AccessControl
ProjectRegistry       -> OZ: IERC20, SafeERC20, AccessControl
Treasury              -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + interfaces: IUniswapV3SwapRouter, INonfungiblePositionManager,
                                        IChainlinkAggregator, ICreditPriceOracle,
                                        ICreditTokenBurnable, ILiquidityGaugeRewards
Staking               -> OZ: IERC20, SafeERC20, ReentrancyGuard, Checkpoints, SafeCast
                          + ProjectRegistry
BurnTracker           -> OZ: AccessControl, ReentrancyGuard
                          + CreditToken, ProjectRegistry
RewardDistributor     -> OZ: AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Staking
RewardDistributorV2   -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Staking
                          + interfaces: ILiquidityGaugeRewards, ITreasuryRewards
LiquidityGauge        -> OZ: IERC20, SafeERC20, IERC721, IERC721Receiver,
                              AccessControl, ReentrancyGuard, Pausable
                          + interfaces: IUniswapV3Staker, IUniswapV3Pool
CreditPriceOracle     -> OZ: IERC20Metadata, Math
                          + interfaces: ICreditPriceOracle, IUniswapV3Pool,
                                        IChainlinkAggregator
FeeRouter             -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Treasury
CreditPSM             -> OZ: IERC20, IERC20Metadata, SafeERC20, ReentrancyGuard
                          + CreditToken
FeeRouterV2           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + ProjectRegistry, ProjectFunding
ProjectFunding        -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + ProjectRegistry, Staking
CommunityTimelock     -> OZ: TimelockController
CommunityGovernor     -> OZ: Governor + 5 extensoes
TeamVesting           -> OZ: IERC20, SafeERC20, Ownable, Ownable2Step
UserSubsidy           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard, MerkleProof
```

## Anti-flashloan — dois trilhos paralelos

O sistema protege duas dimensões simultaneamente contra manipulação por empréstimo relâmpago:

1. **Voto** — `Governor` usa `ERC20Votes.getPastVotes(account, proposalSnapshot)`. Quem pega flash-loan no bloco da votação não consegue votar, porque o snapshot fica no passado (`votingDelay` blocos atrás do bloco atual).

2. **Peso de reward** — `RewardDistributor` usa `Staking.getWeightAt(user, projectId, snapshotBlock)`. Flash-stake no bloco da finalize não entra no reward porque o snapshot é escrito **no momento da finalize** e consultado a partir daí.

Em ambos os casos, o atacante precisaria manter a posição por **pelo menos um bloco** antes da janela de referência, e um flash-loan exige devolução no mesmo bloco — incompatível.

## Pontos de confiança

**Confiáveis por construção** (código imutável e auditado):

- Todas as libs OZ 5.0.2 pinado.
- Cap do GOV.
- **Lastro do PSM** (I-PSM1): não existe função de saque do USDC no `CreditPSM` — nem para governança. Conversão exata 1:1 (I-PSM2).
- **Teto duro da fee**: `FEE_BPS_CAP = 500` (5%) no FeeRouterV2 — nem proposta aprovada passa disso.
- **Bounds do funding**: rev-share `[100, 3000]` bps e prazo `[1, 90]` dias são constants no ProjectFunding; all-or-nothing enforçado on-chain.
- Snapshots anti-flashloan.
- Legado: formato do burn (`_burn` nativo), fórmula de emissão (invariante IE1, `MAX_ALPHA = 0.99e18`), bounds dos buckets V2, IE12, floor + caps do FFP.

**Confiáveis por governança** (podem ser mudados via proposta, mas a mudança passa por todos os delays):

- `feeBps` do FeeRouterV2 (até o teto de 500), `feeSplit` (soma 10.000) e recipients da fee.
- `minTarget` do ProjectFunding.
- Valores de `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration` (legado).
- Splits do FeeRouter (legado).
- `bucketBps` do V2 (dentro dos bounds individuais).
- Parâmetros do FFP (`floorMultiplierBps`, `triggerDurationSecs`, caps, slippage).
- Parâmetros do Governor (voting delay, period, threshold, quorum).
- Vesting duration do gauge (`[1d, 90d]`).

**Confiáveis por fora do sistema** (depende de integração externa):

- Uniswap V3 — pool CREDIT/USDC, swap router, NPM, UniswapV3Staker. Endereços canônicos da Uniswap Foundation.
- Chainlink USDC/USD — feed para sanity check antes do buyback.
- TWAP oracle do CREDIT — `CreditPriceOracle` (adapter de produção, contrato próprio com tudo immutable), setado no Treasury via `setPriceOracle`. A confiança externa fica nos dados que ele lê: observações da pool Uniswap V3 (cardinality suficiente para a janela TWAP) e feed Chainlink USDC/USD.
- Integridade de dados off-chain na `metadataURI` dos projetos (o Registry guarda só o CID).

---

**Próximo →** [Fluxos de usuário](02-user-flows.md)
