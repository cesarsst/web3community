# Burn-to-mint

**Audience:** anyone who wants to understand how the protocol sustains emission without becoming a Ponzi.
**Prerequisites:** [Dual-token](01-dual-token-economy.md).

## The formula

```
emission_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Defined in `RewardDistributor.finalizeRound`. Three layers:

1. **`alpha * burn_{R-1}`** — economic base. In production `alpha = 0.95`, i.e., 95% of what was burned in the previous round is emitted. If nobody burned anything, that term is zero.
2. **`max(..., floor(R))`** — guarantees a minimum floor during bootstrap. `floorSchedule` has 24 entries. Rounds >= 24 have no floor. In production, the floor decays linearly from 400k CREDIT (round 0) to ~16,666 CREDIT (round 23).
3. **`min(..., capMax)`** — hard ceiling. In production `capMax = 5,000,000 CREDIT`. Adjustable via governance within `[1, 100M] CREDIT`.

## Why `alpha < 1` (slightly deflationary)

The system is designed so that **total emission < total burn** if usage stays constant. Intuition:

- Round R-1: users burned 1,000,000 CREDIT.
- Round R: we emit 950,000 CREDIT.
- Net supply balance: -50,000 CREDIT.

Over many rounds, supply drops slowly. If CREDIT demand holds, that drop in supply translates to unit appreciation — which is the premium for holders.

**Simulation**: the repository has a simulation of 52 rounds across 3 scenarios in `scripts/simulation/`. In the "base" scenario (constant usage), supply falls ~3.8% over the 52 rounds.

> **Note — scope of the simulation.** This ~3.8% comes from a **hypothetical** scenario with inflated supply (70.4M CREDIT initial, via `Charlie_seed = 60M` in `scripts/simulation/economicSim.ts:72`) and 1M burn/round constant. In mainnet the operational supply **starts at 10M** (real `mintGenesis`). The absolute values (−3.8%, APR ~34%) are **illustrative of the qualitative behavior** (sustained deflation with constant usage), not a promise about mainnet. The qualitative behavior holds: if `burn_R ≈ constant` and `alpha < 1`, `supply` falls linearly by `(1 - alpha) * burn_R` per round.

## The role of the floor

In round 0, `burn_{-1}` does not exist (treated as 0). Without a floor, emission would be 0 — stakers would have no incentive to come in. The floor exists only for bootstrap: **"until the ecosystem starts generating organic burn, the DAO underwrites a minimum emission"**.

After 24 rounds (in production, 24 × 7 days = **~168 days ≈ 5.5 months**), the floor zeroes. From then on, **emission only exists if burn existed**. If the protocol did not take off in that window, natural emission falls to zero — which is the correct signal for the DAO to intervene or for supporters to reassess.

### Operational limitation — round without any global staker

If the protocol **starts with no stakers** (i.e., `globalWeight == 0`) and also no burn, the formula computes emission correctly (via floor), but **no claim works** — each project's share in the bootstrap path is `emission * projectWeight / globalWeight`, which with `globalWeight == 0` returns 0. Result: CREDIT is **never minted** for that round. It is not a bug, it is a safe no-op — the pool is simply not allocated. **The DAO must coordinate initial stakers before round 0** so the bootstrap floor is actually used.

### Operational limitation — `closeRound` depends on the DAO

`BurnTracker.closeRound` is governance-gated (`GOVERNANCE_ROLE`, currently held only by the Timelock). If the DAO goes inactive, **the round does not close and emission freezes** — stakers expect "1 round = 7 days" but it is actually "1 round = whenever the DAO decides". `isRoundReadyToClose` is advisory only. Recommendation: the DAO should configure an external keeper (Gelato / Chainlink Automation / operational multisig with limited `CANCELLER_ROLE`) to call `closeRound` via periodic proposal — planned as a v2 improvement.

## The role of the cap

`capMax` exists as a safeguard against a burn explosion (genuine or artificial). Even if someone burned 10 billion CREDIT in a round, emission would be clamped at `capMax` (5M in production).

## Multi-layered protection against burn attacks

Besides the `capMax` on total emission, there is a **sanity cap per `(round, projectId)`** in `BurnTracker` (default 10M CREDIT in production):

```
if project's cumulative burn in the round + new burn > maxBurnPerRoundPerProject:
    revert SanityCapExceeded
```

This prevents **a malicious project from burning absurd volume to capture a disproportionate share** within a round. Even if the attacker burned under the sanity cap but above their real usage share, the `capMax` on total emission limits the impact on global supply.

## The role of probation

Every newly activated project enters initial time-based probation (`probationDuration`, 30 days in production). While `block.timestamp < probationEndsAt`:

```
if RewardDistributor detects isInProbation(projectId):
    projectShare = projectShare / PROBATION_PENALTY_DENOM   // = /4
```

That is, **the project receives only 25% of its emission share**. The other 75% **are never minted** — they are not redistributed and there is no `_burn` of the token involved. "Burning" in tokenomics usually means `_burn` over already-existing `totalSupply`; here `projectShare` is simply divided by 4 before `CREDIT.mint` is called, so `CreditToken.totalSupply()` is **not affected** by this path. This preserves the deflationary spirit by subtracting emission, not by incineration.

Intuition: a new project carries a fraud risk. For 30 days, the DAO and stakers observe. If legitimate, probation expires and the share normalizes. If fraud, governance can move the project to punitive `Status.Probation` (blocks stake and payments) or `Status.Removed` (terminates and potentially slashes collateral).

## Bootstrap: what when there is no burn?

If `burn_{R-1} == 0`, emission still happens (via floor, while R < 24). But **how is emission split among projects if nobody burned?**

`RewardDistributor._projectShare` has an alternate path:

```
if totalBurnPrev == 0:
    projectShare = emission * projectWeight / globalWeight
```

That is: when there is no burn, share is proportional to the project's **staking weight** over global weight. This keeps the incentive for stakers to enter early even without real usage yet — they capture the floor in proportion to their directed stake.

For that to work, `Staking` keeps a global checkpoint (`_globalWeightCheckpoints`) updated in O(1) on every position change.

## The sustainability equation

The protocol survives in the long term **if and only if** aggregate organic burn covers at least the cost for stakers. As a narrative equation:

```
value perceived by stakers > opportunity cost of holding GOV elsewhere
        |
        v
  stakers keep entering (or at least do not leave)
        |
        v
  apps keep backed (stakers are trust distributors)
        |
        v
  users keep using
        |
        v
  burn continues
        |
        v
  closed loop
```

If any of these links breaks, the loop slows down. **No formula saves a bad product**; math's role is just to not be an additional point of failure.

## What the DAO can adjust (and what it cannot)

Adjustable via `GOVERNANCE_ROLE` (Timelock, which only executes after an approved proposal):

- `alpha` within `[0.5, 0.99]` — `RewardDistributor.setAlpha`. The range was reduced (previously `[0.5, 1.1]`) to guarantee economic invariant IE1 (α < 1 permanent) by construction — governance can no longer vote an inflationary value. See `audit/economist/2026-04-22-consistency-audit.md` (C2).
- `capMax` within `[1, 100M] CREDIT` — `RewardDistributor.setCapMax`
- `roundDuration` within `[1 day, 30 days]` — `BurnTracker.setRoundDuration`
- `maxBurnPerRoundPerProject` (0 = disabled) — `BurnTracker.setMaxBurnPerRoundPerProject`
- Default split and overrides — `FeeRouter.setDefaultSplit` / `setProjectSplit` / `clearProjectSplit`
- Registry `minCollateral` and `probationDuration`

**Not adjustable**:

- `floorSchedule` — immutable from the `RewardDistributor` constructor.
- `MIN_LOCK`, `MAX_LOCK`, `MAX_MULTIPLIER` of `Staking`.
- `MIN_ROUND_DURATION`, `MAX_ROUND_DURATION` of `BurnTracker`.
- `MIN_ALPHA`, `MAX_ALPHA`, `MIN_CAPMAX`, `MAX_CAPMAX` of `RewardDistributor`.
- GOV supply cap (100M).

---

**Next →** [Rewards distribution](04-rewards-distribution.md)
