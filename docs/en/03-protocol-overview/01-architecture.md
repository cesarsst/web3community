# Architecture

**Audience:** dev wanting a complete map of dependencies between contracts.
**Prerequisites:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Governance](../02-core-concepts/05-governance.md).

## Full map

```
                               +-----------------------------+
                               |     CommunityGovernor       |    (political layer)
                               |     - collects votes        |
                               |     - creates proposals     |
                               +-------------+---------------+
                                             | schedule()
                                             v
                               +-----------------------------+
                               |     CommunityTimelock       |    (executor)
                               |     holds GOVERNANCE_ROLE   |
                               |     on every contract below |
                               +----+-------------------+----+
                                    |                   |
          +-------------------------+-------------------+-------------------+
          |               |                 |                   |           |
          v               v                 v                   v           v
  +---------------+  +----------+  +--------------+  +----------------+  +-----------+
  |ProjectRegistry|  | Treasury |  |   Staking    |  |  BurnTracker   |  |  FeeRouter|
  |  whitelist    |  | custody  |  | stake+weights|  | burn per round |  | split     |
  +-------+-------+  +----+-----+  +-------+------+  +--------+-------+  +-----+-----+
          |               ^                |                  |                |
          | isActive/     |                |                  |                | approve
          | isInProbation |                |                  |                | +burn
          v               | spend          v                  v                v
         +----------------+-------------------------------------+-----------+
         |                 RewardDistributor                                |
         |  emission_R = min(max(alpha*burn, floor), capMax)                |
         |  pull-based claim / mint CREDIT                                  |
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
                               |        BurnTracker          | (loops back here because
                               +-----------------------------+  it calls burnByRole on CREDIT)

   GovernanceToken (GOV) ---- staked in Staking
                         ---- collateral in ProjectRegistry
                         ---- vested in TeamVesting
                         ---- votes in CommunityGovernor

   Auxiliary contracts:
   +----------------+   +------------------+
   |  TeamVesting   |   |   UserSubsidy    |
   |  GOV vesting   |   | CREDIT subsidy   |
   |  per-member    |   | via Merkle drops |
   +----------------+   +------------------+
   (funded by the Timelock with GOV/CREDIT transferred from the Treasury)
```

## Who calls whom

| Caller | Calls | When |
|---|---|---|
| `FeeRouter.pay` | `CREDIT.transferFrom(user, this, amount)` | pulls the full value |
| `FeeRouter.pay` | `CREDIT.transfer(recipient, toApp)` | pays rebate to the app |
| `FeeRouter.pay` | `CREDIT.transfer(treasury, toTreasury)` | if `treasuryBps > 0` |
| `FeeRouter.pay` | `CREDIT.forceApprove(burnTracker, burned)` + `BurnTracker.burnAndRecord` | burns the burn slice |
| `BurnTracker.burnAndRecord` | `CREDIT.burnByRole(from, amount, tag)` | native `_burn` |
| `RewardDistributor.finalizeRound` | `BurnTracker.getTotalBurnForRound(round-1)` | reads previous burn |
| `RewardDistributor._calculateClaim` | `Staking.getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` | weight snapshot |
| `RewardDistributor._calculateClaim` | `ProjectRegistry.isInProbation(projectId)` | penalty |
| `RewardDistributor._calculateClaim` | `BurnTracker.getBurnForProjectInRound(round-1, projectId)` | project share |
| `RewardDistributor._claim` | `CREDIT.mint(user, amount, "rewardRound")` | mints reward |
| `Staking.stake` / `increaseStake` | `ProjectRegistry.isActive(projectId)` | gate |
| `Staking.stake` | `GOV.safeTransferFrom(user, this, amount)` | pull collateral |
| `Staking.unstake` | `ProjectRegistry.getProject(projectId)` | bypass if Removed |
| `Staking.unstake` | `GOV.safeTransfer(user, amount)` | returns |
| `ProjectRegistry.registerProject` | `GOV.safeTransferFrom(owner, this, collateral)` | pull collateral |
| `ProjectRegistry.removeProject` | `GOV.safeTransfer(destination, collateral)` | returns or slashes |
| `FeeRouter.pay` | `ProjectRegistry.isActive(projectId)` | gate |
| `FeeRouter._effectiveRecipient` | `ProjectRegistry.getProject(projectId)` | dynamic owner lookup |
| `Treasury.payRebates` | `TOKEN.safeTransfer(app, amount)` | batch to apps |
| `CommunityGovernor._queueOperations` | `CommunityTimelock.schedule(...)` | queues execution |
| `CommunityTimelock.execute*` | `CALLS.execute(...)` | calls target function (Registry, Treasury, etc) |

## Post-deploy: the role graph

```
   CommunityTimelock (self-administered after handoff)
       |
       |  holds GOVERNANCE_ROLE on:
       |  - Treasury
       |  - ProjectRegistry
       |  - BurnTracker
       |  - RewardDistributor
       |  - FeeRouter
       |  - UserSubsidy
       |
       |  holds DEFAULT_ADMIN_ROLE on all of the above
       |
       |  is owner of:
       |  - GovernanceToken (after acceptOwnership)
       |  - each TeamVesting

   CommunityGovernor
       |
       |  holds PROPOSER_ROLE + CANCELLER_ROLE on Timelock

   address(0)
       |
       |  counts as authorized executor on the Timelock
       |  (anyone can call execute after the delay)

   RewardDistributor
       |
       |  holds MINTER_ROLE on CreditToken

   BurnTracker
       |
       |  holds BURNER_ROLE on CreditToken

   FeeRouter
       |
       |  holds RECORDER_ROLE on BurnTracker (v1 bootstrap)
       |  newly listed apps also receive RECORDER_ROLE
       |  (via approved proposal + Timelock execution)
```

## Solidity import dependencies

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
CommunityGovernor     -> OZ: Governor + 5 extensions
TeamVesting           -> OZ: IERC20, SafeERC20, Ownable, Ownable2Step
UserSubsidy           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard, MerkleProof
```

## Anti-flashloan — two parallel rails

The system protects two dimensions simultaneously against flash-loan manipulation:

1. **Vote** — `Governor` uses `ERC20Votes.getPastVotes(account, proposalSnapshot)`. Whoever takes a flash loan at the voting block cannot vote, because the snapshot is in the past (`votingDelay` blocks behind the current block).

2. **Reward weight** — `RewardDistributor` uses `Staking.getWeightAt(user, projectId, snapshotBlock)`. A flash-stake at the finalize block does not enter the reward because the snapshot is written **at the moment of finalize** and queried from there on.

In both cases, the attacker would need to hold the position for **at least one block** before the reference window, and a flash loan requires repayment in the same block — incompatible.

## Trust points

**Trusted by construction** (immutable, audited code):

- All OZ 5.0.2 libs pinned.
- GOV cap.
- Burn format (native ERC-20 `_burn`, decrements `totalSupply`).
- Emission formula (`min(max(alpha*burn, floor), capMax)`).
- Anti-flashloan snapshots.

**Trusted via governance** (can be changed via proposal, but the change goes through all delays):

- Values of `alpha`, `capMax`, `roundDuration`, `sanityCap`, `minCollateral`, `probationDuration`.
- FeeRouter splits.
- Governor parameters (voting delay, period, threshold, quorum).

**Trusted from outside the system**:

- Future DEX integrations in `executeBuyback`.
- Integrity of off-chain data at the projects' `metadataURI` (the Registry stores only the CID).

---

**Next →** [User flows](02-user-flows.md)
