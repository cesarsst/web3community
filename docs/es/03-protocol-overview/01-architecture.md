# Arquitectura

**Audiencia:** dev que quiere un mapa completo de dependencias entre contratos.
**Requisitos previos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Gobernanza](../02-core-concepts/05-governance.md).

## Mapa completo

```
                               +-----------------------------+
                               |     CommunityGovernor       |    (capa politica)
                               |     - recoge votos          |
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
          +-------------------------+-------------------+-------------------+
          |               |                 |                   |           |
          v               v                 v                   v           v
  +---------------+  +----------+  +--------------+  +----------------+  +-----------+
  |ProjectRegistry|  | Treasury |  |   Staking    |  |  BurnTracker   |  |  FeeRouter|
  |  whitelist    |  | custodia |  | stake+weights|  | burn por round |  | split     |
  +-------+-------+  +----+-----+  +-------+------+  +--------+-------+  +-----+-----+
          |               ^                |                  |                |
          | isActive/     |                |                  |                | approve
          | isInProbation |                |                  |                | +burn
          v               | spend          v                  v                v
         +----------------+-------------------------------------+-----------+
         |                 RewardDistributor                                |
         |  emission_R = min(max(alpha*burn, floor), capMax)                |
         |  pull-based claim / mint CREDIT                                   |
         +-------------------------------------------------------------------+
                                             ^
                             grants MINTER_ROLE (one-time, deploy)
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

   Contratos auxiliares:
   +----------------+   +------------------+
   |  TeamVesting   |   |   UserSubsidy    |
   |  vesting GOV   |   | subsidio CREDIT  |
   |  por-miembro   |   | via Merkle drops |
   +----------------+   +------------------+
   (fundeados por el Timelock con GOV/CREDIT transferido del Treasury)
```

## Quién llama a quién

| Llamador | Llama | Cuándo |
|---|---|---|
| `FeeRouter.pay` | `CREDIT.transferFrom(user, this, amount)` | empuja el valor total |
| `FeeRouter.pay` | `CREDIT.transfer(recipient, toApp)` | paga rebate a la app |
| `FeeRouter.pay` | `CREDIT.transfer(treasury, toTreasury)` | si `treasuryBps > 0` |
| `FeeRouter.pay` | `CREDIT.forceApprove(burnTracker, burned)` + `BurnTracker.burnAndRecord` | quema la porción de burn |
| `BurnTracker.burnAndRecord` | `CREDIT.burnByRole(from, amount, tag)` | `_burn` nativo |
| `RewardDistributor.finalizeRound` | `BurnTracker.getTotalBurnForRound(round-1)` | lee burn anterior |
| `RewardDistributor._calculateClaim` | `Staking.getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` | snapshot de peso |
| `RewardDistributor._calculateClaim` | `ProjectRegistry.isInProbation(projectId)` | penalty |
| `RewardDistributor._calculateClaim` | `BurnTracker.getBurnForProjectInRound(round-1, projectId)` | share del proyecto |
| `RewardDistributor._claim` | `CREDIT.mint(user, amount, "rewardRound")` | acuña reward |
| `Staking.stake` / `increaseStake` | `ProjectRegistry.isActive(projectId)` | gate |
| `Staking.stake` | `GOV.safeTransferFrom(user, this, amount)` | pull colateral |
| `Staking.unstake` | `ProjectRegistry.getProject(projectId)` | bypass si Removed |
| `Staking.unstake` | `GOV.safeTransfer(user, amount)` | devuelve |
| `ProjectRegistry.registerProject` | `GOV.safeTransferFrom(owner, this, collateral)` | pull colateral |
| `ProjectRegistry.removeProject` | `GOV.safeTransfer(destination, collateral)` | devuelve o slash |
| `FeeRouter.pay` | `ProjectRegistry.isActive(projectId)` | gate |
| `FeeRouter._effectiveRecipient` | `ProjectRegistry.getProject(projectId)` | lookup dinámico del owner |
| `Treasury.payRebates` | `TOKEN.safeTransfer(app, amount)` | batch a apps |
| `CommunityGovernor._queueOperations` | `CommunityTimelock.schedule(...)` | encola ejecución |
| `CommunityTimelock.execute*` | `CALLS.execute(...)` | llama función objetivo (Registry, Treasury, etc) |

## Post-deploy: el grafo de roles

```
   CommunityTimelock (self-administered tras handoff)
       |
       |  tiene GOVERNANCE_ROLE en:
       |  - Treasury
       |  - ProjectRegistry
       |  - BurnTracker
       |  - RewardDistributor
       |  - FeeRouter
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

   RewardDistributor
       |
       |  tiene MINTER_ROLE en el CreditToken

   BurnTracker
       |
       |  tiene BURNER_ROLE en el CreditToken

   FeeRouter
       |
       |  tiene RECORDER_ROLE en el BurnTracker (v1 bootstrap)
       |  nuevos apps listados tambien reciben RECORDER_ROLE
       |  (via propuesta aprobada + ejecucion del Timelock)
```

## Dependencias de imports Solidity

```
GovernanceToken       -> OZ: ERC20, ERC20Permit, ERC20Votes, Ownable2Step
CreditToken           -> OZ: ERC20, ERC20Burnable, AccessControl
ProjectRegistry       -> OZ: IERC20, SafeERC20, AccessControl
Treasury              -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
Staking               -> OZ: IERC20, SafeERC20, ReentrancyGuard, Checkpoints, SafeCast
                          + ProjectRegistry
BurnTracker           -> OZ: AccessControl, ReentrancyGuard
                          + CreditToken, ProjectRegistry
RewardDistributor     -> OZ: AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Staking
FeeRouter             -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + CreditToken, BurnTracker, ProjectRegistry, Treasury
CommunityTimelock     -> OZ: TimelockController
CommunityGovernor     -> OZ: Governor + 5 extensiones
TeamVesting           -> OZ: IERC20, SafeERC20, Ownable, Ownable2Step
UserSubsidy           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard, MerkleProof
```

## Anti-flashloan — dos rieles paralelos

El sistema protege dos dimensiones simultáneamente contra manipulación por préstamo relámpago:

1. **Voto** — `Governor` usa `ERC20Votes.getPastVotes(account, proposalSnapshot)`. Quien toma flash-loan en el bloque de la votación no consigue votar, porque el snapshot está en el pasado (`votingDelay` bloques atrás del bloque actual).

2. **Peso de reward** — `RewardDistributor` usa `Staking.getWeightAt(user, projectId, snapshotBlock)`. Flash-stake en el bloque del finalize no entra en el reward porque el snapshot es escrito **en el momento del finalize** y consultado a partir de ahí.

En ambos casos, el atacante necesitaría mantener la posición por **al menos un bloque** antes de la ventana de referencia, y un flash-loan exige devolución en el mismo bloque — incompatible.

## Puntos de confianza

**Confiables por construcción** (código inmutable y auditado):

- Todas las libs OZ 5.0.2 pinadas.
- Cap de GOV.
- Formato del burn (`_burn` nativo ERC-20, decrementa `totalSupply`).
- Fórmula de emisión (`min(max(alpha*burn, floor), capMax)`).
- Snapshots anti-flashloan.

**Confiables por gobernanza** (pueden cambiarse vía propuesta, pero el cambio pasa por todos los delays):

- Valores de `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration`.
- Splits del FeeRouter.
- Parámetros del Governor (voting delay, period, threshold, quorum).

**Confiables por fuera del sistema**:

- Integraciones futuras con DEX en el `executeBuyback`.
- Integridad de datos off-chain en la `metadataURI` de los proyectos (el Registry guarda solo el CID).

---

**Siguiente →** [Flujos de usuario](02-user-flows.md)
