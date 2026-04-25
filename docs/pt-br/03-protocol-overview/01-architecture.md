# Arquitetura

**Para quem é:** dev querendo mapa completo de dependências entre contratos.
**Pré-requisitos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Governança](../02-core-concepts/05-governance.md).

## Mapa completo (pós-pivot CLP, Fase 1)

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

   Contratos auxiliares:
   +----------------+   +------------------+
   |  TeamVesting   |   |   UserSubsidy    |
   |  vesting GOV   |   | subsidio CREDIT  |
   |  per-membro    |   | via Merkle drops |
   +----------------+   +------------------+
   (fundados pelo Timelock com GOV/CREDIT transferido do Treasury)
```

## Quem chama quem

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
| `Treasury.recordDailyPrice` | `priceOracle.peekTwapPrice(twapWindowSecs)` | atualiza MA90 + breach |
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

## Pós-deploy: o grafo de roles (Fase 1.4 CLP)

```
   CommunityTimelock (self-administered apos handoff)
       |
       |  detem GOVERNANCE_ROLE em:
       |  - Treasury (incl. FFP, POL, ledgers Fase 1.4)
       |  - ProjectRegistry (incl. cancelOwnerRecipient escape hatch)
       |  - BurnTracker
       |  - RewardDistributor (V1 — claim-only)
       |  - RewardDistributorV2
       |  - FeeRouter
       |  - LiquidityGauge
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
FeeRouter             -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Treasury
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
- Formato do burn (`_burn` nativo ERC-20, decrementa `totalSupply`).
- Fórmula de emissão (`min(max(alpha*burn, floor), capMax)`) — invariante IE1 (`MAX_ALPHA = 0.99e18`).
- Snapshots anti-flashloan.
- Bounds individuais dos buckets V2 (`MIN_BUCKET_STAKERS_BPS = 3000`, etc.).
- IE12 (soma dos buckets == totalEmission) — assert defensivo em `finalizeRound`.
- Floor + caps do FFP buyback — bounds hardcoded em `_checkBounds`.

**Confiáveis por governança** (podem ser mudados via proposta, mas a mudança passa por todos os delays):

- Valores de `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration`.
- Splits do FeeRouter.
- `bucketBps` do V2 (dentro dos bounds individuais).
- Parâmetros do FFP (`floorMultiplierBps`, `triggerDurationSecs`, caps, slippage).
- Parâmetros do Governor (voting delay, period, threshold, quorum).
- Vesting duration do gauge (`[1d, 90d]`).

**Confiáveis por fora do sistema** (depende de integração externa):

- Uniswap V3 — pool CREDIT/USDC, swap router, NPM, UniswapV3Staker. Endereços canônicos da Uniswap Foundation.
- Chainlink USDC/USD — feed para sanity check antes do buyback.
- TWAP oracle do CREDIT — `priceOracle` setado via governance.
- Integridade de dados off-chain na `metadataURI` dos projetos (o Registry guarda só o CID).

---

**Próximo →** [Fluxos de usuário](02-user-flows.md)
