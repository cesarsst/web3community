# Arquitectura

**Para quién es:** dev que busca un mapa completo de dependencias entre contratos.
**Prerrequisitos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Gobernanza](../02-core-concepts/05-governance.md).

## Mapa completo (post-pivote CLP, Fase 1)

```
                               +-----------------------------+
                               |     CommunityGovernor       |    (capa politica)
                               |     - colecta votos         |
                               |     - crea propuestas       |
                               +-------------+---------------+
                                             | schedule()
                                             v
                               +-----------------------------+
                               |     CommunityTimelock       |    (ejecutor)
                               |     tiene GOVERNANCE_ROLE   |
                               |     en todos los de abajo   |
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
      | split en 4 buckets: stakers (lazy) | LPs (push gauge) | apps (push)       |
      |                     | bonders (push Treasury polRefill)                   |
      +---------------------------------------------------------------------------+
                                             ^
                             grants MINTER_ROLE (V1 + V2, durante migration window)
                             tras cutoff: V1 pierde MINTER_ROLE
                                             |
                               +-----------------------------+
                               |        CreditToken          |
                               |        ERC-20 burnable      |
                               +-----------------------------+
                                             ^
                                             | burnByRole
                               +-----------------------------+
                               |        BurnTracker          | (vuelve aqui porque llama
                               +-----------------------------+  burnByRole en CREDIT)

   GovernanceToken (GOV) ---- stakeado en Staking
                         ---- colateral en ProjectRegistry
                         ---- vested en TeamVesting
                         ---- vota en CommunityGovernor

   Pool externo Uniswap V3: CREDIT/USDC 0.3%
       ^                                ^
       | (POL custodiado por Treasury)  | (LP externo + UniswapV3Staker
       |                                |  controlado por LiquidityGauge)
       |                                |
   Treasury.polTokenId          LiquidityGauge.stake(tokenId, poolId)

   Contratos auxiliares:
   +----------------+   +------------------+
   |  TeamVesting   |   |   UserSubsidy    |
   |  vesting GOV   |   | subsidio CREDIT  |
   |  por miembro   |   | via Merkle drops |
   +----------------+   +------------------+
   (fondeados por el Timelock con GOV/CREDIT transferido del Treasury)
```

## Quién llama a quién

| Llamador | Llama | Cuando |
|---|---|---|
| `FeeRouter.pay` | `CREDIT.transferFrom(user, this, amount)` | jala el monto total |
| `FeeRouter.pay` | `CREDIT.transfer(recipient, toApp)` | paga rebate a la app |
| `FeeRouter.pay` | `CREDIT.transfer(treasury, toTreasury)` | si `treasuryBps > 0` |
| `FeeRouter.pay` | `CREDIT.forceApprove(burnTracker, burned)` + `BurnTracker.burnAndRecord` | quema la porción de burn |
| `BurnTracker.burnAndRecord` | `CREDIT.burnByRole(from, amount, tag)` | `_burn` nativo |
| `RewardDistributorV2.finalizeRound` | `BurnTracker.getTotalBurnForRound(round-1)` | lee burn anterior |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(ownerRecipient(p), share, "rewardRound:apps")` | bucket apps |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(self, lpsAmount)` + `gauge.notifyRewardAmount(...)` | bucket LPs (gauge activo) |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(treasury, lpsAmount)` + `treasury.depositPendingGaugeRewards(...)` | bucket LPs (gauge paused) |
| `RewardDistributorV2.finalizeRound` | `CREDIT.mint(treasury, bondersAmount)` + `treasury.depositPolRefill(...)` | bucket bonders |
| `RewardDistributorV2._calculateClaim` | `Staking.getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` | snapshot de peso |
| `RewardDistributorV2._calculateClaim` | `ProjectRegistry.isInProbation(projectId)` | penalty |
| `RewardDistributorV2._claim` | `CREDIT.mint(user, amount, "rewardRoundV2:stakers")` | bucket stakers (lazy) |
| `Treasury.executeBuyback` | `swapRouter.exactInputSingle(USDC->CREDIT)` + `CREDIT.burnByRole(self, ...)` | FFP buyback |
| `Treasury.recordDailyPrice` | `priceOracle.peekTwapPrice(twapWindowSecs)` | actualiza MA90 + breach |
| `Treasury.addPOL` / `addPOLFromRefill` | `NPM.mint` o `NPM.increaseLiquidity` | provisiona POL |
| `Treasury.flushPendingGaugeRewards` | `gauge.notifyRewardAmount(poolId, amount, duration)` | drena fallback |
| `LiquidityGauge.stake` | `NPM.safeTransferFrom(user->staker, tokenId, IncentiveKey)` | auto-stake en staker oficial |
| `LiquidityGauge.unstake` | `STAKER.unstakeToken/claimReward/withdrawToken` | salida + crea VestingPosition |
| `LiquidityGauge.harvest` | `CREDIT.safeTransfer(user, claimed)` | retira vested |
| `Staking.stake` / `increaseStake` | `ProjectRegistry.isActive(projectId)` | gate |
| `Staking.stake` | `GOV.safeTransferFrom(user, this, amount)` | jala colateral |
| `Staking.unstake` | `ProjectRegistry.getProject(projectId)` | bypass si Removed |
| `Staking.unstake` | `GOV.safeTransfer(user, amount)` | devuelve |
| `ProjectRegistry.registerProject` | `GOV.safeTransferFrom(owner, this, collateral)` | jala colateral |
| `ProjectRegistry.removeProject` | `GOV.safeTransfer(destination, collateral)` | devuelve o slashea |
| `FeeRouter.pay` | `ProjectRegistry.isActive(projectId)` | gate |
| `FeeRouter._effectiveRecipient` | `ProjectRegistry.getProject(projectId)` | lookup dinámico del owner |
| `RewardDistributorV2._emitAppsBucket` | `ProjectRegistry.ownerRecipient(p)` | recipient apps (timelock 48h) |
| `Treasury.payRebates` | `TOKEN.safeTransfer(app, amount)` | batch para apps |
| `CommunityGovernor._queueOperations` | `CommunityTimelock.schedule(...)` | encola ejecución |
| `CommunityTimelock.execute*` | `CALLS.execute(...)` | llama función objetivo (Registry, Treasury, etc) |

## Post-deploy: el grafo de roles (Fase 1.4 CLP)

```
   CommunityTimelock (auto-administrado tras handoff)
       |
       |  tiene GOVERNANCE_ROLE en:
       |  - Treasury (incl. FFP, POL, ledgers Fase 1.4)
       |  - ProjectRegistry (incl. cancelOwnerRecipient escape hatch)
       |  - BurnTracker
       |  - RewardDistributor (V1 — claim-only)
       |  - RewardDistributorV2
       |  - FeeRouter
       |  - LiquidityGauge
       |  - UserSubsidy
       |
       |  tiene DEFAULT_ADMIN_ROLE en todos los de arriba
       |
       |  es owner de:
       |  - GovernanceToken (tras acceptOwnership)
       |  - cada TeamVesting

   CommunityGovernor
       |
       |  tiene PROPOSER_ROLE + CANCELLER_ROLE en el Timelock

   address(0)
       |
       |  cuenta como ejecutor autorizado en el Timelock
       |  (cualquiera puede llamar execute tras el delay)

   RewardDistributor (V1)
       |
       |  tiene MINTER_ROLE en CreditToken (durante migration window de 4 rondas)
       |  tras cutoff: gobernanza revoca MINTER_ROLE — V1 vuelve read-only

   RewardDistributorV2
       |
       |  tiene MINTER_ROLE en CreditToken (permanente)
       |  tiene POL_REFILL_DEPOSITOR_ROLE en Treasury
       |  tiene GAUGE_FALLBACK_DEPOSITOR_ROLE en Treasury
       |  tiene REWARD_NOTIFIER_ROLE en LiquidityGauge

   BurnTracker
       |
       |  tiene BURNER_ROLE en CreditToken

   FeeRouter
       |
       |  tiene RECORDER_ROLE en BurnTracker (v1 bootstrap)
       |  apps recién listadas también reciben RECORDER_ROLE
       |  (vía propuesta aprobada + ejecución del Timelock)

   LiquidityGauge
       |
       |  REWARD_NOTIFIER_ROLE plural:
       |  - concedida al Treasury (camino manual: flushPendingGaugeRewards)
       |  - concedida al RewardDistributorV2 (camino automatico en finalizeRound)
       |
       |  denylist anti self-dealing:
       |  - Treasury, Staking, RewardDistributor*, FeeRouter denylisted
       |    en bootstrap (D.9 — el protocolo no se paga rewards a si mismo)
```

## Dependencias de imports Solidity

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
CommunityGovernor     -> OZ: Governor + 5 extensiones
TeamVesting           -> OZ: IERC20, SafeERC20, Ownable, Ownable2Step
UserSubsidy           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard, MerkleProof
```

## Anti-flashloan — dos rieles paralelos

El sistema protege dos dimensiones simultáneas contra manipulación por flash-loan:

1. **Voto** — `Governor` usa `ERC20Votes.getPastVotes(account, proposalSnapshot)`. Quien toma flash-loan en el bloque de la votación no logra votar, porque el snapshot está en el pasado (`votingDelay` bloques atrás del bloque actual).

2. **Peso de reward** — `RewardDistributor` usa `Staking.getWeightAt(user, projectId, snapshotBlock)`. Flash-stake en el bloque del finalize no entra en el reward porque el snapshot se escribe **en el momento del finalize** y se consulta a partir de ahí.

En ambos casos, el atacante necesitaría mantener la posición por **al menos un bloque** antes de la ventana de referencia, y un flash-loan exige devolución dentro del mismo bloque — incompatible.

## Puntos de confianza

**Confiables por construcción** (código inmutable y auditado):

- Todas las libs OZ 5.0.2 pinned.
- Cap del GOV.
- Forma del burn (`_burn` nativo ERC-20, decrementa `totalSupply`).
- Fórmula de emisión (`min(max(alpha*burn, floor), capMax)`) — invariante IE1 (`MAX_ALPHA = 0.99e18`).
- Snapshots anti-flashloan.
- Bounds individuales de los buckets V2 (`MIN_BUCKET_STAKERS_BPS = 3000`, etc.).
- IE12 (suma de buckets == totalEmission) — assert defensivo en `finalizeRound`.
- Floor + caps del FFP buyback — bounds hardcoded en `_checkBounds`.

**Confiables por gobernanza** (mutables vía propuesta, pero la mudanza pasa por todos los delays):

- Valores de `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration`.
- Splits del FeeRouter.
- `bucketBps` del V2 (dentro de los bounds individuales).
- Parámetros del FFP (`floorMultiplierBps`, `triggerDurationSecs`, caps, slippage).
- Parámetros del Governor (voting delay, period, threshold, quorum).
- Vesting duration del gauge (`[1d, 90d]`).

**Confiables fuera del sistema** (depende de integración externa):

- Uniswap V3 — pool CREDIT/USDC, swap router, NPM, UniswapV3Staker. Direcciones canónicas de Uniswap Foundation.
- Chainlink USDC/USD — feed para sanity check antes del buyback.
- TWAP oracle del CREDIT — `priceOracle` seteado vía gobernanza.
- Integridad de datos off-chain en la `metadataURI` de los proyectos (el Registry guarda sólo el CID).

---

**Siguiente ->** [Flujos de usuario](02-user-flows.md)
