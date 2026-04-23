# Arquitetura

**Para quem é:** dev querendo mapa completo de dependências entre contratos.
**Pré-requisitos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Governança](../02-core-concepts/05-governance.md).

## Mapa completo

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
                               |        BurnTracker          | (volta aqui pq chama
                               +-----------------------------+  burnByRole no CREDIT)

   GovernanceToken (GOV) ---- stakado em Staking
                         ---- colateral em ProjectRegistry
                         ---- vestido em TeamVesting
                         ---- vota em CommunityGovernor

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
| `RewardDistributor.finalizeRound` | `BurnTracker.getTotalBurnForRound(round-1)` | lê burn anterior |
| `RewardDistributor._calculateClaim` | `Staking.getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` | snapshot de peso |
| `RewardDistributor._calculateClaim` | `ProjectRegistry.isInProbation(projectId)` | penalty |
| `RewardDistributor._calculateClaim` | `BurnTracker.getBurnForProjectInRound(round-1, projectId)` | share do projeto |
| `RewardDistributor._claim` | `CREDIT.mint(user, amount, "rewardRound")` | cunha reward |
| `Staking.stake` / `increaseStake` | `ProjectRegistry.isActive(projectId)` | gate |
| `Staking.stake` | `GOV.safeTransferFrom(user, this, amount)` | pull colateral |
| `Staking.unstake` | `ProjectRegistry.getProject(projectId)` | bypass se Removed |
| `Staking.unstake` | `GOV.safeTransfer(user, amount)` | devolve |
| `ProjectRegistry.registerProject` | `GOV.safeTransferFrom(owner, this, collateral)` | pull colateral |
| `ProjectRegistry.removeProject` | `GOV.safeTransfer(destination, collateral)` | devolve ou slash |
| `FeeRouter.pay` | `ProjectRegistry.isActive(projectId)` | gate |
| `FeeRouter._effectiveRecipient` | `ProjectRegistry.getProject(projectId)` | lookup dinâmico do owner |
| `Treasury.payRebates` | `TOKEN.safeTransfer(app, amount)` | batch para apps |
| `CommunityGovernor._queueOperations` | `CommunityTimelock.schedule(...)` | enfileira execução |
| `CommunityTimelock.execute*` | `CALLS.execute(...)` | chama função alvo (Registry, Treasury, etc) |

## Pós-deploy: o grafo de roles

```
   CommunityTimelock (self-administered apos handoff)
       |
       |  detem GOVERNANCE_ROLE em:
       |  - Treasury
       |  - ProjectRegistry
       |  - BurnTracker
       |  - RewardDistributor
       |  - FeeRouter
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

   RewardDistributor
       |
       |  detem MINTER_ROLE no CreditToken

   BurnTracker
       |
       |  detem BURNER_ROLE no CreditToken

   FeeRouter
       |
       |  detem RECORDER_ROLE no BurnTracker (v1 bootstrap)
       |  novos apps listados tambem recebem RECORDER_ROLE
       |  (via proposta aprovada + execucao do Timelock)
```

## Dependências de imports Solidity

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
- Fórmula de emissão (`min(max(alpha*burn, floor), capMax)`).
- Snapshots anti-flashloan.

**Confiáveis por governança** (podem ser mudados via proposta, mas a mudança passa por todos os delays):

- Valores de `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration`.
- Splits do FeeRouter.
- Parâmetros do Governor (voting delay, period, threshold, quorum).

**Confiáveis por fora do sistema**:

- Integrações futuras com DEX no `executeBuyback`.
- Integridade de dados off-chain na `metadataURI` dos projetos (o Registry guarda só o CID).

---

**Próximo →** [Fluxos de usuário](02-user-flows.md)
