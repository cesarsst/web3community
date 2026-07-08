# Value accrual

**Audience:** reader evaluating the protocol's economic architecture.
**Prerequisites:** [Tokenomics](01-tokenomics.md), [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

> **Disclaimer**: this page describes **on-chain mechanisms** by which value transits in the protocol. It is not a recommendation, projection, or promise. Exposure to GOV or CREDIT involves risks described in [Risk and security](03-risk-and-security.md).

## Where value enters

The only source of **external value** in the system is the end user buying CREDIT (on external DEX, with stable, ETH, etc.) because they want to use the ecosystem's apps.

If **zero** users buy CREDIT to use the apps, none of the mechanisms described below produce value. The protocol's sustainability depends on the utility offered by the listed apps.

## Paths through which CREDIT gains buying pressure

1. **Consumption in the apps**: user needs CREDIT to pay for services. Buys on DEX, generates buying pressure.
2. **Retention by apps**: apps receive rebate in CREDIT (10% default) and emission via stake (if they staked). While they do not sell, they remove CREDIT from DEX circulation.
3. **Retention by stakers**: stakers receive CREDIT as reward. Those who hold (instead of selling immediately) remove CREDIT from circulation.
4. **DAO-run subsidies**: `UserSubsidy` distributes pre-funded CREDIT from the Treasury to first users. This **does not create demand**, but creates initial users who may generate recurring demand after the subsidy.
5. **CREDIT buyback (FFP)**: `Treasury.executeBuyback(usdcAmount, minCreditOut)` is **real** — it buys CREDIT with the Treasury's USDC (Uniswap V3 swap) and **immediately burns** the bought CREDIT (`burnByRole`). The price comes from `CreditPriceOracle` (Uniswap V3 CREDIT/USDC TWAP + Chainlink USDC/USD sanity). It only executes via a DAO proposal and under on-chain conditions: spot TWAP below the FFP floor for at least `triggerDurationSecs` (default 24h), USDC not depegged, per-event cap (default 20% of reserves) and monthly cap (default 30% of the snapshot). Buying pressure + supply reduction in the same act.

## Paths through which CREDIT leaves circulation

1. **Burn on payments**: main path. 70% default of each payment is burned via `BurnTracker.burnAndRecord` → `CreditToken.burnByRole` (Phase 0 split: 70% burn / 20% treasury / 10% rebate).
2. **Burn by buyback**: every `executeBuyback` burns 100% of the bought CREDIT — it does not recycle it back to the Treasury.
3. **Burn by retention** (indirect): even without burning, CREDIT held by apps/stakers/DAO is "out" of the circulating float. The 20% of the split that goes to the Treasury also leaves the float while it is not spent via proposal.

## Supply dynamics

With `alpha = 0.95`:

```
supply_R = supply_{R-1} + emission_R - burn_R
         = supply_{R-1} + 0.95 * burn_{R-1} - burn_R
```

If `burn_R ≈ burn_{R-1}` (stable usage):

```
supply_R ≈ supply_{R-1} - 0.05 * burn_R
```

That is, supply drops by ~5% of the burn of each round.

If usage is growing (`burn_R > burn_{R-1}`), supply can still drop but more slowly. If shrinking, it can drop faster (emission based on older, smaller burn, while new burn is larger — unlikely but possible).

> **About the simulation numbers.** The 52-round simulation in `scripts/simulation/` reports supply falling **~3.8%** in the base scenario. That absolute value comes from a hypothetical scenario with inflated supply (70.4M CREDIT initial, via `Charlie_seed = 60M` in `scripts/simulation/economicSim.ts:72`) and 1M burn/round constant — **does not promise mainnet behavior**, where operational supply starts at 10M (real genesis). The qualitative dynamic (sustained deflation if burn stays constant, with `alpha < 1`) is the relevant result.

## Paths through which GOV gains buying pressure

1. **Stakers buying GOV on external DEX** to stake in projects (the more optimistic about the protocol, the more staked GOV).
2. **Apps buying GOV** to stake in their own project and capture emission — path (B) described in [Value flow](../03-protocol-overview/03-economic-flows.md).
3. **New projects buying GOV** to meet `minCollateral` (10,000 GOV per listing).
4. **DAO-approved GOV buybacks** — note: **there is no dedicated on-chain mechanism for GOV**. `Treasury.executeBuyback` buys and burns **CREDIT**, not GOV. A GOV buyback would require proposals using the Treasury's generic transfers.

## Paths through which GOV leaves circulation

1. **Staking**: GOV locked in `Staking` for up to 365+ days, weight multiplier based on lock.
2. **Collateral in projects**: GOV locked in `ProjectRegistry` until `removeProject`.
3. **Vesting**: GOV locked in `TeamVesting` instances until gradual release.
4. **Simple holding**: GOV idle in the wallet to vote.

GOV is **not burned**. The 100M cap is the maximum that will ever exist.

## Value capture by participant profile

### End user

Captures the **app's service**. The value is outside the protocol — it is what the app delivers in exchange for the paid CREDIT.

### Listed app

Three combined vectors:

- **(A) Direct rebate**: 10% (default) of each payment. Immediate operational cash flow.
- **(B) Stake in own project**: if the app also staked GOV in its own `projectId`, it captures a slice of emission proportional to weight. Can be significant — see numeric example in [Value flow](../03-protocol-overview/03-economic-flows.md).
- **(C) Retained CREDIT appreciation**: if supply falls, unsold CREDIT is worth more in real terms.

### Staker

Captures RewardDistributor emission, proportional to their stake weight within the project × the project's share of total burn in the round.

Formula (V1 `RewardDistributor` math, where 100% of emission goes to stakers):

```
amount = total_emission
       × (project_burn / total_burn)         // project share
       × (my_weight / project_total_weight)  // my slice in the project
       × (1 or 1/4 if probation)             // penalty
```

Under `RewardDistributorV2` (CLP pivot Phase 1.4, activated by a governance migration), emission is split into 4 buckets before this math — default `[5500, 2500, 1500, 500]` bps = **55% stakers** / 25% LPs / 15% apps / 5% bonders. That is, replace `total_emission` with `0.55 × total_emission` in the formula above.

Reward is in CREDIT. Staker can sell (selling pressure) or retain.

Important: **the staker also assumes risk** — 14 to 365+ days GOV lock, possibility that the chosen project generates no burn, etc. See [Risks](03-risk-and-security.md).

### GOV holder without stake

Captures voting right. Indirect exposure to aggregate dynamics — if the protocol grows and GOV becomes demanded (new stakers, new apps, buybacks), GOV can appreciate. If the protocol dies, GOV loses utility.

## Deflationary mechanism — why it is not a Ponzi

Typical Ponzi: new tokens are issued to pay old holders without real counterparty. Here:

- Emission depends on real burn.
- Burn comes from real payments by users.
- Payments happen because users buy CREDIT to use apps.
- Users buy CREDIT because they want app services.

If any link in the chain breaks (apps without utility, no users, CREDIT without demand), emission collapses together with burn. The protocol slows — **but does not implode** just because someone left.

What **happens** if nobody uses:

- Burn → 0.
- Emission by the main formula → 0 (after the floor runs out at round 24).
- Stakers stop entering (no reward).
- Protocol becomes a zombie — contracts running but no activity.

What **does not happen**:

- The protocol does not promise fixed reward. There is no contractual obligation to pay stakers X% per year.
- There is no "last resort" counterparty that pays reward if burn is zero.
- There is no chaotic exit ("bank run") — each staker can unstake when the lock expires.

## Safeguard mechanisms

Three safeguards prevent pathologies:

1. **Floor decay** (rounds 0-23): minimum emission during bootstrap. Gives time to attract users. Then it vanishes — forcing the ecosystem to stand on its own.

2. **Sanity cap per (round, project)**: prevents wash-burn by malicious project.

3. **Probation penalty** (25% share): new projects capture 25% of their share for 30 days. Disincentivizes fast-listing fraud.

## No guarantee of value

No mechanism guarantees:

- That GOV will appreciate.
- That CREDIT will keep purchasing power.
- That app usage will grow.
- That a staker will "profit".

The architecture aligns incentives with real usage. If usage exists, the system operates as designed. If not, emission (and thus the economic incentive) collapses. **A bad product is not saved by tokenomics.**

## Points to observe before any exposure

- App usage health (via `BurnTracker.getTotalBurnForRound`).
- Staking growth or decline (via `Staking.totalStaked` and `getGlobalWeight`).
- Recent proposals in the Governor (signal of political direction).
- Real GOV distribution (only the Treasury genesis post-deploy, or have there been allocations to team / public sale / liquidity?).
- CREDIT liquidity in external DEX (can you exit when you want?).

See [Metrics that matter](04-metrics-that-matter.md).

---

**Next →** [Risk and security](03-risk-and-security.md)
