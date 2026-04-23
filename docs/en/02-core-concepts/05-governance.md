# Governance

**Audience:** anyone who wants to understand **how** the DAO makes decisions.
**Prerequisites:** [Mental model](../01-getting-started/02-mental-model.md).

## Separation of powers

web3community governance has **three** components with distinct roles:

```
  GOV holders           CommunityGovernor       CommunityTimelock
  (with delegation)     (electronic ballot)     (executor with delay)

  - hold voting     ->  - receives proposal  -> - holds for 2 days
    power               - opens window          - executes against
  - delegate to self    - counts votes            target contracts
    or to others        - decides outcome
```

None of the three can act alone:

- **Governor** does not execute anything — it only schedules on the Timelock.
- **Timelock** does not decide anything — it only executes what has been scheduled after the delay.
- **GOV holders** vote but cannot directly call functions of the economic contracts.

## Why three steps

### Threshold (entry)

To create a proposal, the proposer needs at least `proposalThreshold` of delegated voting power. In production: `10,000 GOV` (0.01% of the cap). Prevents proposal spam from accounts with no skin in the game.

### Quorum (minimum participation)

A proposal only wins if it reaches quorum **and** has more `For` than `Against`. Quorum in production: **4%** of total supply at the snapshot block. Avoids an active minority passing something radical while the majority is asleep.

### Total delay (response window)

From propose to execute, approximately the following elapses:

- `votingDelay` — 7200 blocks (~1 day at 12s/block)
- `votingPeriod` — 50400 blocks (~7 days)
- `timelockMinDelay` — 172800 seconds (2 days)

Total ~10 days. During that time, any holder can:

- Examine the proposal on-chain.
- Delegate votes to reject it.
- Organize a response off-chain.
- Exit the position if they disagree.

If a malicious proposal passes, there are still 2 days after approval for action (withdraw funds, cancel via a blocking minority in a counter-proposal, etc.).

## What the DAO controls

**Everything** that economically affects the protocol goes through a proposal. Full listing in [Parameters](../07-governance/03-parameters.md). Summary:

| Contract | Controlled parameters |
|---|---|
| `ProjectRegistry` | `registerProject`, `activateProject`, `setProbation`, `reactivate`, `removeProject`, `setMinCollateral`, `setProbationDuration` |
| `Treasury` | `transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH` |
| `BurnTracker` | `closeRound`, `setRoundDuration`, `setMaxBurnPerRoundPerProject` |
| `RewardDistributor` | `setAlpha`, `setCapMax` |
| `FeeRouter` | `setDefaultSplit`, `setProjectSplit`, `clearProjectSplit` |
| `UserSubsidy` | `createCampaign`, `closeCampaign` |
| `GovernanceToken` | `mint` (via `Ownable2Step`, owner = Timelock) |
| `TeamVesting` | `revoke` (owner = Timelock) |

## What the DAO **does not** control

Decisions the DAO **cannot make** even with 100% of the votes:

- **Increasing the GOV cap**. The cap (100M) is `immutable` in `GovernanceToken.CAP_SUPPLY`.
- **Removing Staking's `MIN_LOCK`** (14 days). It is `constant` and protects stakers from governance itself.
- **Changing the window `[MIN_ROUND_DURATION, MAX_ROUND_DURATION]`** (1 day to 30 days).
- **Changing `[MIN_ALPHA, MAX_ALPHA]`** (0.5 to 0.99 — reduced from 1.1 to guarantee IE1 α<1 permanent by construction; see `audit/economist/2026-04-22-consistency-audit.md` C2) or `[MIN_CAPMAX, MAX_CAPMAX]` (1 to 100M CREDIT).
- **Altering `floorSchedule`**. Written to `RewardDistributor` storage at deploy, with no write function.
- **Changing the address of any economic contract**. If the DAO needs to "replace" a contract, it must deploy a new one and migrate roles — the architecture does not foresee in-place upgrade.

The immutability of these rules is a commitment: **not even the unanimous DAO can break the rights the user saw at deploy**. It is the trust base that allows stakers to immobilize capital.

## Who owns what

Post-deploy, after all handoffs:

| Resource | Owner/Admin |
|---|---|
| `GOVERNANCE_ROLE` on every economic contract | `CommunityTimelock` |
| `DEFAULT_ADMIN_ROLE` on every contract with AccessControl | `CommunityTimelock` |
| `owner` of `GovernanceToken` | `CommunityTimelock` (after `acceptOwnership`) |
| `owner` of each `TeamVesting` | `CommunityTimelock` |
| `PROPOSER_ROLE` + `CANCELLER_ROLE` on `CommunityTimelock` | `CommunityGovernor` |
| `EXECUTOR_ROLE` on `CommunityTimelock` | `address(0)` — anyone executes after the delay |
| `DEFAULT_ADMIN_ROLE` on `CommunityTimelock` | **Self** (the Timelock itself) |
| `MINTER_ROLE` on `CreditToken` | `RewardDistributor` |
| `BURNER_ROLE` on `CreditToken` | `BurnTracker` |
| `RECORDER_ROLE` on `BurnTracker` | `FeeRouter` (and every newly listed app gets it via proposal) |

The deployer **renounces all roles** at the end of deploy. After that, they have no more power than any GOV holder.

## Role of ERC20Votes

`GovernanceToken` inherits `ERC20Votes`. That adds two critical functions for governance:

- `delegate(delegatee)` — every holder must **delegate** voting power, even to themselves. If nobody delegates, `getVotes` returns zero and the Governor does not count them.
- `getPastVotes(account, blockNumber)` — returns voting power at a past block. **This** is the function the Governor uses to count votes — immune to flash loans.

**Mitigated flash-loan attack**: an attacker flash-loaning GOV at the block of voting opening cannot vote, because `getPastVotes` queries block `snapshot = proposalSnapshot(proposalId)`, which lies in the past (`votingDelay` behind).

## Key contracts

| Contract | Role |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | Voting power source |
| [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md) | Ballot |
| [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md) | Executor with delay |

---

**Next →** [Project whitelist](06-project-whitelist.md)
