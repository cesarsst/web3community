# Parameters adjustable by the DAO

**Audience:** anyone who wants to know exactly what the DAO can change and which ranges are allowed.
**Prerequisites:** [Proposal lifecycle](01-proposal-lifecycle.md).

This page lists **all** parameters adjustable via governance, the production value, the on-chain bound, and which function is used to change.

## Contracts and adjustment functions

### GovernanceToken

Owner in production = `CommunityTimelock`. Proposals that call:

| Function | What it does | On-chain bound |
|---|---|---|
| `mint(to, amount, tag)` | Mints GOV to `to` up to `CAP_SUPPLY` | Reverts with `CapExceeded` if post-mint supply > 100M |

No parameter setters — `CAP_SUPPLY` is immutable.

### CreditToken

Admin in production = `CommunityTimelock`. Proposals:

| Function | What it does | On-chain bound |
|---|---|---|
| `grantRole(MINTER_ROLE, addr)` | Grants mint power | — |
| `revokeRole(MINTER_ROLE, addr)` | Revokes | — |
| `grantRole(BURNER_ROLE, addr)` | Grants role-gated burn power | — |
| `revokeRole(BURNER_ROLE, addr)` | Revokes | — |

`mintGenesis` is not callable after first execution (flag `genesisMinted`).

### ProjectRegistry

| Function | What it does | On-chain bound | Production value |
|---|---|---|---|
| `registerProject(owner, uri, collateral)` | Lists a new project | `collateral >= minCollateral` | — |
| `activateProject(id)` | Pending → Active | status must be Pending | — |
| `setProbation(id)` | Active → Probation | status must be Active | — |
| `reactivate(id)` | Probation → Active | status must be Probation | — |
| `removeProject(id, slash, treasury)` | → Removed | status != Removed | — |
| `setMinCollateral(newMin)` | Adjusts minimum collateral | `newMin > 0` | `10,000 GOV` |
| `setProbationDuration(newDuration)` | Adjusts initial probation | `newDuration > 0` | `2,592,000 sec` (30d) |

### Treasury

| Function | What it does | On-chain bound |
|---|---|---|
| `transfer(token, to, amount)` | Sends ERC-20 | `sufficient balance` |
| `batchTransfer(token, recipients[], amounts[])` | Batch of transfers | valid arrays, total balance sufficient |
| `payRebates(token, apps[], amounts[], round)` | Batch with semantic event | ditto |
| `executeBuyback(stable, amountIn, minGovOut, swapData)` | v1 stub — just emits event | `stable != 0, amountIn > 0, minGovOut > 0` |
| `sweepETH(to, amount)` | Withdraws ETH | `sufficient balance` |

### Staking

No adjustable parameters. `MIN_LOCK`, `MAX_LOCK`, `MULTIPLIER_PRECISION`, `MAX_MULTIPLIER` are `constant`.

### BurnTracker

| Function | What it does | On-chain bound | Production value |
|---|---|---|---|
| `closeRound()` | Closes current round, opens next | — | — |
| `setRoundDuration(new)` | Adjusts target round duration | `[MIN_ROUND_DURATION=1d, MAX_ROUND_DURATION=30d]` | `604,800 sec` (7d) |
| `setMaxBurnPerRoundPerProject(new)` | Sanity cap; 0 = disables | — | `10M CREDIT` |
| `grantRole(RECORDER_ROLE, app)` | Authorizes app to call `burnAndRecord` | — | — |
| `revokeRole(RECORDER_ROLE, app)` | Deauthorizes | — | — |

### RewardDistributor

| Function | What it does | On-chain bound | Production value |
|---|---|---|---|
| `finalizeRound(round)` | Records immutable emission of the round | sequential, round closed in tracker | — |
| `setAlpha(new)` | Adjusts alpha | `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` | `0.95e18` |
| `setCapMax(new)` | Adjusts per-round ceiling | `[MIN_CAPMAX=1e18, MAX_CAPMAX=100M*1e18]` | `5M CREDIT` |
| `grantRole(GOVERNANCE_ROLE, addr)` | ditto | — | — |

`floorSchedule` is **immutable** after deploy.

### FeeRouter

| Function | What it does | On-chain bound | Production value |
|---|---|---|---|
| `setDefaultSplit(split)` | Global default split | `burnBps + treasuryBps + rebateBps == 10,000` | `(9500, 0, 500)` |
| `setProjectSplit(id, split)` | Per-project override | ditto | — |
| `clearProjectSplit(id)` | Removes override | override must exist | — |

`setAppRecipient(id, recipient)` is owner-gated (not governance).

### UserSubsidy

| Function | What it does | On-chain bound |
|---|---|---|
| `createCampaign(root, amountPerUser, maxClaims, deadline)` | Opens Merkle campaign | `root != 0, amount > 0, maxClaims > 0, deadline > now` |
| `closeCampaign(id, returnTo)` | Closes and returns leftovers | campaign exists and not closed |

### TeamVesting

One instance per beneficiary. Owner = `CommunityTimelock`.

| Function | What it does | On-chain bound |
|---|---|---|
| `revoke(returnTo)` | One-shot; freezes the boundary | `!revoked, returnTo != 0` |

Schedule (`start`, `cliff`, `duration`) is immutable (set in constructor).

### CommunityTimelock

Self-administered post-handoff. Proposals:

| Function | What it does |
|---|---|
| `updateDelay(newDelay)` | Adjusts `minDelay`. New value applied to future proposals. |
| `grantRole(PROPOSER_ROLE, addr)` | Adds proposer |
| `revokeRole(PROPOSER_ROLE, addr)` | Removes |
| `grantRole(CANCELLER_ROLE, addr)` | Adds canceller |
| `revokeRole(CANCELLER_ROLE, addr)` | Removes |
| `grantRole(EXECUTOR_ROLE, addr)` | Adds executor |

### CommunityGovernor

All changes are `onlyGovernance` (must come via a proposal approved by the Governor itself). Production values in `ignition/parameters/production.json`.

| Function | What it does | On-chain bound | Production value |
|---|---|---|---|
| `setVotingDelay(new)` | Adjusts delay until voting opens | `> 0` (uint48) | `7200` (~1d) |
| `setVotingPeriod(new)` | Adjusts voting duration | `> 0` (uint32) | `50400` (~7d) |
| `setProposalThreshold(new)` | Adjusts threshold to propose | `>= 0` | `10,000 * 1e18 GOV` |
| `updateQuorumNumerator(new)` | Adjusts quorum numerator | `[0, 100]` | `4` |
| `relay(target, value, data)` | Executes arbitrary operation as if it were the governor (rare) | — | — |

## Immutable parameters

The DAO **cannot** change:

| Parameter | Where | Value |
|---|---|---|
| GOV `CAP_SUPPLY` | `GovernanceToken` | 100,000,000 * 1e18 |
| Staking `MIN_LOCK` | `Staking` | 14 days |
| Staking `MAX_LOCK` | `Staking` | 365 days |
| Staking `MAX_MULTIPLIER` | `Staking` | 4e18 |
| Staking `MULTIPLIER_PRECISION` | `Staking` | 1e18 |
| `MIN_ROUND_DURATION` | `BurnTracker` | 1 day |
| `MAX_ROUND_DURATION` | `BurnTracker` | 30 days |
| `MIN_ALPHA`, `MAX_ALPHA` | `RewardDistributor` | `0.5e18`, `0.99e18` (reduced from `1.1e18` — see `audit/economist/2026-04-22-consistency-audit.md` C2; guarantees IE1 α<1 permanent by construction) |
| `MIN_CAPMAX`, `MAX_CAPMAX` | `RewardDistributor` | `1e18`, `100M*1e18` |
| `FLOOR_SCHEDULE_LENGTH` | `RewardDistributor` | 24 |
| `PROBATION_PENALTY_DENOM` | `RewardDistributor` | 4 (25%) |
| `floorSchedule` (values) | `RewardDistributor` | written at deploy |
| `_BPS_DENOMINATOR` | `FeeRouter` | 10,000 |
| Contract addresses | deploy | fixed |
| `CommunityGovernor` `name` (EIP-712) | `CommunityGovernor` | "CommunityGovernor" |

These values are the protocol's **constitutional floor**: not even a unanimous DAO can change them.

## How to propose a parameter change

Example: reduce `alpha` from `0.95e18` to `0.90e18`.

```solidity
targets   = [address(rewardDistributor)];
values    = [0];
calldatas = [
    abi.encodeWithSelector(rewardDistributor.setAlpha.selector, 0.90e18)
];
description = "Reduce alpha to 0.90 to increase deflationary pressure";

governor.propose(targets, values, calldatas, description);
```

Prerequisites:

- The proposer has >= 10k GOV delegated.
- The new value `0.90e18` is within `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]`. If outside, execution reverts (even if vote is approved).

## Temporal effect of changes

Parameter changes take effect **at the execution block** and affect only future state:

- `setAlpha` alters the `finalizeRound` computation for **non-finalized** rounds. Rounds with `roundData[r].finalized == true` have immutable `totalEmission`.
- `setCapMax` ditto.
- `setRoundDuration` affects future rounds (already-open rounds are not truncated).
- `setMaxBurnPerRoundPerProject` affects gates on new `burnAndRecord` — past accumulations remain.
- `setDefaultSplit` / `setProjectSplit` affect future `pay`s.
- `setMinCollateral` / `setProbationDuration` affect **new** registrations; existing ones are not grandfather-altered.

## Observability

Parameter change events:

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
```

External indexers should monitor and display parameter history for transparency.

---

**Next →** [Contracts reference](../08-contracts-reference/)
