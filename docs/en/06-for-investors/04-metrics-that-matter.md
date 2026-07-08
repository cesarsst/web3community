# Metrics that matter

**Audience:** anyone tracking the protocol's operational health.
**Prerequisites:** [Value accrual](02-value-accrual.md), [Querying on-chain state](../05-for-developers/04-querying-state.md).

Metrics you can compute directly from the contracts. All on-chain, no dependency on an external indexer.

## 2026-07-08 remodel metrics (protocol health)

Investor income is now **real revenue, not emission** — the primary metrics moved from burn/emission to GMV/distributed revenue.

### Gross volume per project (GMV)

**What it is**: every payment that went through `FeeRouterV2` for the project. The direct proxy for real usage — replaces burn as the primary metric.

```solidity
feeRouterV2.grossVolumeOf(projectId);
```

**How to interpret**: growing → app gaining traction (and investors' rev-share growing with it). Zero for a long time → terminal signal. For a time series, index `PaymentRouted` events (they carry the fee/rev-share/app breakdown per payment).

### Revenue distributed to investors

```solidity
funding.totalRevenueDistributed(projectId);   // cumulative paid via rev-share
funding.pendingRevenue(projectId, investor);  // investor's pending claim
```

### Realized yield per project

```
round = funding.rounds(projectId);
cumulative_yield = totalRevenueDistributed / round.raised
annualized_yield ~= cumulative_yield * (365 days / round_age)
```

**How to interpret**: compare against the opportunity cost (an 8% rev-share over a monthly GMV of 20% of the raise ≈ 19% p.a.). Actual yield depends 100% on the app's GMV — it is not promised.

### Active rev-share and round status

```solidity
funding.revShareBpsOf(projectId);   // 0 = no Funded round; 100-3000 bps
funding.rounds(projectId);          // { target, raised, deadline, revShareBps, status }
```

The Funded/Failed ratio across projects indicates investor confidence in the project pipeline.

### PSM backing (CREDIT peg)

```solidity
psm.backingNormalized();     // USDC backing in 18 dec
psm.mintedOutstanding();     // CREDIT in circulation minted by the PSM
```

**Invariant I-PSM1**: `backingNormalized() >= mintedOutstanding`. Anyone can verify at any time. A violation = critical bug (there is no backing-withdrawal function).

### Cumulative protocol fee

Index `PaymentRouted` and sum `feeToTreasury` / `feeToBuyback` / `feeToGrants`: protocol revenue (1% of GMV to the treasury), GOV buyback pressure (1% of GMV) and grants (0.5% of GMV).

## Legacy rail usage metrics (burn-to-mint)

> ⚠️ **LEGACY** — the burn/emission metrics below only move for historical claims; FeeRouterV2 neither burns nor emits. Useful for auditing the past, not for tracking the present.

### Burn per round

**What it is**: how much CREDIT was burned in each round. Was the real-usage proxy in the old model.

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

In the current model, it should track `psm.mintedOutstanding()` (+ legacy residue from genesis/old emissions). Growing supply = growing rail demand; shrinking = users redeeming USDC. It is no longer a deflation metric.

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

### Emission per round (legacy)

```solidity
rd.getEmission(round);             // if finalized
rd.previewEmission(round);         // preview
```

Compare with `capMax` to see if dominated by cap (emission saturated) or by burn.

### Emission / burn ratio (legacy)

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

## Burn round metrics (legacy)

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

## FeeRouterV2 operational metrics

### Total paid volume

Index `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)` events.

Sum(amount) = protocol GMV (matches Σ `grossVolumeOf`).
Sum(revShare) = total income forwarded to investors.
Sum(toApp) = total cash distributed to apps (~89.5-97.5% of GMV).
Sum(fee*) = protocol revenue (2.5% of GMV: 40/40/20).

### Payment preview

```solidity
feeRouterV2.previewPay(projectId, amount);  // (fee, revShare, toApp)
```

(Legacy: the V1 `feeRouter.getEffectiveSplit` and `Paid` events remain queryable for history.)

## Suggested minimal dashboard

For dev/investor/operator to track:

```
┌ Usage health (GMV) ──────────────────┐
│ Total GMV (PaymentRouted, 30d)        │
│ grossVolumeOf top-5 projects          │
│ N projects with payments in period    │
│ N Active projects in Registry         │
└───────────────────────────────────────┘
┌ Funding / rev-share ─────────────────┐
│ Rounds Open / Funded / Failed         │
│ totalRevenueDistributed top-5         │
│ Annualized yield per project          │
│ Average rev-share (bps) of Funded     │
└───────────────────────────────────────┘
┌ Staking ─────────────────────────────┐
│ Total staked (GOV)                    │
│ Global weight                         │
│ Top-5 projects by weight              │
│ Weight / Staked ratio (avg lock)      │
└───────────────────────────────────────┘
┌ Peg / Supply ────────────────────────┐
│ psm.backingNormalized vs              │
│   psm.mintedOutstanding (I-PSM1)      │
│ CREDIT totalSupply                    │
│ GOV totalSupply vs cap                │
└───────────────────────────────────────┘
┌ Governance ──────────────────────────┐
│ Open proposals                        │
│ % participation last proposal         │
│ Current quorum (4% of supply)         │
│ Pending list in Timelock              │
└───────────────────────────────────────┘
┌ Treasury / fee ──────────────────────┐
│ Cumulative fee (treasury/buyback/     │
│   grants)                             │
│ GOV, CREDIT, other token balances     │
│ Recent outflows (Transferred event)   │
└───────────────────────────────────────┘
```

All these metrics are derived from `view` calls on the contracts + event indexing. No off-chain data is needed.

## Warning signals

- GMV (`PaymentRouted`) falling for > 4 consecutive weeks.
- `backingNormalized() < mintedOutstanding` — I-PSM1 violation; critical bug, investigate immediately.
- Funding rounds consistently `Failed` — investors do not trust the project pipeline.
- `totalRevenueDistributed` stagnant in Funded projects with positive GMV — rev-share not flowing (investigate roles).
- `FeeUpdated` pushing `feeBps` toward the 500 cap without clear justification.
- `totalStaked` falling rapidly (stakers unstaking after lock — weakens the investment gate).
- Proposal participation < 50% of minimum quorum.
- Large Treasury outflows with no known corresponding proposal (investigate immediately — this would be evidence of exploit, although access control mitigates).
- (Legacy) anomalous historical claims in the RewardDistributors.

---

**Next →** [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md)
