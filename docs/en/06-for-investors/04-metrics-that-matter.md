# Metrics that matter

**Audience:** anyone tracking the protocol's operational health.
**Prerequisites:** [Value accrual](02-value-accrual.md), [Querying on-chain state](../05-for-developers/04-querying-state.md).

Metrics you can compute directly from the contracts. All on-chain, no dependency on an external indexer.

## Usage metrics (protocol health)

### Burn per round

**What it is**: how much CREDIT was burned in each round. Direct proxy for real app usage.

**How to read**:

```solidity
burnTracker.getTotalBurnForRound(round);
```

**How to interpret**:

- Growing over rounds → protocol gaining traction.
- Flat → stable.
- Decreasing → alert; investigate cause (app down? user churn?).
- Zero for many rounds → terminal signal.

### Burn per project

**What it is**: distribution of burn across active projects.

**How to read**:

```solidity
burnTracker.getBurnForProjectInRound(round, projectId);
```

For each listed `projectId`, in each round.

**How to interpret**:

- Concentration in 1-2 projects → high dependency; risk if one disappears.
- Balanced distribution → healthy ecosystem with multiple contributors.
- New projects appearing consistently → healthy inflow.

### Projects with burn per round

**What it is**: how many distinct projects had at least 1 burn.

**How to read**:

```solidity
burnTracker.projectsWithBurnCount(round);
```

**How to interpret**: growing number = ecosystem breadth growing. Stagnation = few projects holding everything.

### Total projects in Registry

```solidity
registry.totalProjects();
```

Sum of all ever registered (includes `Removed`). For actives, iterate via `registry.isActive(id)` from 1 to `totalProjects()`.

## Staking metrics

### Total aggregate stake

```solidity
staking.totalStaked();
```

Total GOV immobilized in positions. High = holder confidence. Low = holders prefer liquidity to exposure.

### Global weight

```solidity
staking.getGlobalWeight();
```

Sum of weights across all projects. Reflects both `totalStaked` and the choice of long locks (multiplier).

### Stake per project

```solidity
staking.totalStakedByProject(projectId);
staking.getTotalWeight(projectId);
```

Indicator of which project has more supporters. Should correlate with project burn over time (apps with good stake tend to generate more usage).

### Lock distribution

There is no aggregate view for `lockDuration` distribution. Derived metric is `globalWeight / totalStaked` — if > 1 it means average lock above 14 days (multiplier > 1x). Near 4 means many stakers on max lock.

## Economic metrics

### CREDIT supply

```solidity
credit.totalSupply();
```

Compare with last value and with `supply + emission - burn` expected from the round. Divergence → investigate.

### GOV supply in circulation

```solidity
gov.totalSupply();
```

In production, starts at 0 and grows via approved `mint`. Compare with cap (`gov.cap()` = 100M) to know what can still be minted.

### Immobilized GOV

Sum of:

```solidity
staking.totalStaked();                    // in staking
// + collateral in active projects
//   (iterate registry.getProject(id).collateral for active id)
// + TeamVesting balances (not yet released)
// + Treasury
```

Ratio `immobilized_GOV / totalSupply` indicates how "active" GOV is. High = good signal. Low = many holders idle.

### Emission per round

```solidity
rd.getEmission(round);             // if finalized
rd.previewEmission(round);         // preview
```

Compare with `capMax` to see if dominated by cap (emission saturated) or by burn.

### Emission / burn ratio

```
ratio = emission_R / burn_{R-1}
```

If `alpha = 0.95`, this ratio should be ~0.95 (when burn is high, not clamped by floor or cap).

If ratio = 1 exact → emission hit `capMax` (clamped at ceiling).
If ratio > 1 → emission dominated by floor (low burn, bootstrap).
If ratio ~ 0.95 → normal operation.

### Treasury balances

```solidity
treasury.balanceOf(IERC20(gov));
treasury.balanceOf(IERC20(credit));
address(treasury).balance;              // ETH
// + other ERC-20s the DAO receives
```

Monitor large outflows. `Transferred`, `BatchTransferred`, `RebatesPaid` events indicate what the DAO approved spending.

## Governance metrics

### Vote participation

Per proposal:

```solidity
(againstVotes, forVotes, abstainVotes) = governor.proposalVotes(proposalId);
totalVotes = againstVotes + forVotes + abstainVotes;
```

Compare `totalVotes` with `getPastTotalSupply(snapshot)` for % participation. Declining trend = engagement dropping.

### Quorum reached

```solidity
quorumNeeded = governor.quorum(snapshot);
quorumReached = forVotes + abstainVotes >= quorumNeeded;
```

### Pending proposals

Monitor `ProposalCreated` events + `state(id)`.

### Active delegation

For a specific account:

```solidity
gov.delegates(account);     // to whom they delegated (0 if nobody)
gov.getVotes(account);      // current voting power
```

Aggregate: sum of `getVotes` for known addresses. Compare with `totalSupply` for % delegated. High % delegated = vibrant governance.

## Round metrics

### Current round

```solidity
burnTracker.currentRound();
burnTracker.roundStartedAt();
burnTracker.roundDuration();
burnTracker.isRoundReadyToClose();
```

### Last finalized round

```solidity
rd.lastFinalizedRound();
rd.isFirstRoundFinalized();
```

Gap between `currentRound - 1` and `lastFinalizedRound` indicates closed rounds without finalize. Large gap = someone needs to call `finalizeRound` (permissionless, anyone can).

### Emission history

```solidity
for (uint r = 0; r <= rd.lastFinalizedRound(); r++) {
    rd.roundData(r);  // { totalEmission, totalBurnAtFinalize, snapshotBlock, finalized }
}
```

Compute cumulative emission vs cumulative burn to see net supply balance over time.

## FeeRouter operational metrics

### Total paid volume

Index `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` events.

Sum(amount) = protocol gross volume.
Sum(burned) = cumulative deflationary pressure.
Sum(toApp) = total cash distributed to apps.

### Effective split per project

```solidity
feeRouter.getEffectiveSplit(projectId);
```

For projects with override vs default.

## Suggested minimal dashboard

For dev/staker/operator to track:

```
┌ Usage health ────────────────────────┐
│ Total burn (last 4 rounds)            │
│ Burn per project top-5                │
│ N projects with burn                  │
│ N Active projects in Registry         │
└───────────────────────────────────────┘
┌ Staking ─────────────────────────────┐
│ Total staked (GOV)                    │
│ Global weight                         │
│ Top-5 projects by weight              │
│ Weight / Staked ratio (avg lock)      │
└───────────────────────────────────────┘
┌ Supply ──────────────────────────────┐
│ CREDIT totalSupply                    │
│ GOV totalSupply vs cap                │
│ Delta supply last round               │
│ emission/burn ratio                   │
└───────────────────────────────────────┘
┌ Governance ──────────────────────────┐
│ Open proposals                        │
│ % participation last proposal         │
│ Current quorum (4% of supply)         │
│ Pending list in Timelock              │
└───────────────────────────────────────┘
┌ Treasury ────────────────────────────┐
│ GOV, CREDIT, other token balances     │
│ ETH                                   │
│ Recent outflows (Transferred event)   │
└───────────────────────────────────────┘
```

All these metrics are derived from `view` calls on the contracts + event indexing. No off-chain data is needed.

## Warning signals

- Burn per round falling for > 3 consecutive rounds.
- `totalStaked` falling rapidly (stakers unstaking after lock).
- Proposal participation < 50% of minimum quorum.
- Projects hitting `SanityCapExceeded` — sign of possible abuse.
- `RoundClosed.earlyClose = true` with no clear proposal context.
- Large Treasury outflows with no known corresponding proposal (investigate immediately — this would be evidence of exploit, although access control mitigates).

---

**Next →** [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md)
