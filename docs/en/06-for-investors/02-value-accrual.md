# Value accrual

**Audience:** reader evaluating the protocol's economic architecture.
**Prerequisites:** [Tokenomics](01-tokenomics.md), [Value flow](../03-protocol-overview/03-economic-flows.md).

> **Disclaimer**: this page describes **on-chain mechanisms** by which value transits in the protocol. It is not a recommendation, projection, or promise. Exposure to GOV or to rev-share positions involves risks described in [Risk and security](03-risk-and-security.md).

> **2026-07-08 remodel**: the value-accrual axis changed. **CREDIT is stable (1:1 USDC via the PSM) and does not accrue value** — what accrues is **GOV** (continuous fee-funded buyback) and the **rev-share position** (income from real revenue via ProjectFunding). CREDIT deflationary mechanisms below are marked as legacy.

## Where value enters

The only source of **external value** in the system is the end user converting USDC into CREDIT at the `CreditPSM` because they want to use the ecosystem's apps.

If **zero** users buy CREDIT to use the apps, none of the mechanisms described below produce value. The protocol's sustainability depends on the utility offered by the listed apps. That did not change with the remodel — what changed is **who captures** the generated value.

## CREDIT does not accrue value — by design

Since the remodel, CREDIT is a stable means of payment:

- **Price**: 1 CREDIT = 1 USDC, always, guaranteed by the PSM (1:1 purchase and redemption, no fee).
- **No buy/sell pressure to model**: no pool, no speculative float, no appreciation thesis.
- **CREDIT risk** ≈ backing risk (USDC) + PSM contract risk (immutable, no withdrawal function — invariant I-PSM1).

Whoever wants exposure to the ecosystem's growth **does not buy CREDIT** — they buy GOV or fund projects.

> **Legacy (pre-remodel)**: buying pressure via consumption/retention/70% burn per payment, FFP buyback with burn and the `supply_R ≈ supply_{R-1} - 0.05 × burn_R` dynamic belong to the burn-to-mint model. The 52-round simulation in `scripts/simulation/` described that dynamic.

## The investor's income: rev-share of real revenue

The income asset of the current model is the **funding position** in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md):

1. The investor stakes GOV on the project (gate) and invests CREDIT in the round (shares 1:1).
2. On every `FeeRouterV2.pay`, the project's rev-share (1-30% of gross revenue, fixed at the round) is credited pro-rata to shares.
3. `claim` withdraws at any time (requires keeping the GOV staked; the accrual never expires).

**Properties**:

- **Real income, not emission**: every CREDIT received came from a user payment. Zero inflation.
- **Full transparency**: `grossVolumeOf` (GMV), `totalRevenueDistributed` (already paid), `pendingRevenue` (claimable) — all on-chain, no indexer.
- **Illustrative yield** (not a promise): a 10,000 CREDIT round at an 8% rev-share with 2,000/month GMV → 1,920/year ≈ 19.2% p.a.; a 50,000 round at 12% with 5,000/month GMV → 14.4% p.a. Actual yield depends 100% on the app's revenue.
- **Risk**: principal is not returned (you buy the stream, not a bond); a project with no revenue = zero income; all-or-nothing protects only during the raise (full refund if the round fails).

## Paths through which GOV gains buying pressure

1. **Continuous fee-funded buyback** — a **dedicated, automatically funded** mechanism: 40% of every payment's fee (= 1% of GMV) goes to FeeRouterV2's `buybackRecipient`. Buying pressure proportional to real usage, payment by payment — no per-event proposal needed.
2. **Stakers/investors buying GOV** to stake in projects — now mandatory to **invest** in rounds and withdraw rev-share (ProjectFunding gate).
3. **New projects buying GOV** to meet `minCollateral` (10,000 GOV per listing).
4. **Additional DAO-approved programs** via Treasury transfers.

(Legacy: the FFP `Treasury.executeBuyback` bought and burned **CREDIT**, not GOV — it belongs to the old rail.)

## Paths through which GOV leaves circulation

1. **Staking**: GOV locked in `Staking` for up to 365+ days, weight multiplier based on lock.
2. **Collateral in projects**: GOV locked in `ProjectRegistry` until `removeProject`.
3. **Vesting**: GOV locked in `TeamVesting` instances until gradual release.
4. **Simple holding**: GOV idle in the wallet to vote.

GOV is **not burned**. The 100M cap is the maximum that will ever exist.

## Value capture by participant profile

### End user

Captures the **app's service**. The value is outside the protocol — it is what the app delivers in exchange for the paid CREDIT. Remodel bonus: pays with a stable currency, no slippage or price risk.

### Listed app

- **Direct revenue, instantly**: ~97.5% of each payment (2.5% fee); ~89.5% with a funded round at an 8% rev-share.
- **Upfront capital**: all-or-nothing round in ProjectFunding, cost of capital ~19% p.a. in the illustrative example — comparable to revenue-based financing (Pipe/Clearco: 15-25%) and with no equity dilution.
- **Hub + user base + ready rail** (PSM + FeeRouterV2).

(Legacy: the 10% rebate, apps-bucket push and retained-CREDIT appreciation belong to the old model.)

### Investor (GOV staker + CREDIT funder)

Captures a **% of the real gross revenue** of the funded project, on every payment:

```
my_income_per_payment = amount
       × revShareBps / 10000                  // the round's rev-share (1-30%)
       × (my_shares / total_shares)           // pro-rata of what I invested
```

Income in stable CREDIT (redeemable 1:1 at the PSM). Requires GOV staked on the project to invest and to withdraw — the 14-365+ day staking lock still applies.

Important: **the investor assumes real risk** — the return depends on the app's future revenue; the principal is not returned. See [Risks](03-risk-and-security.md).

(Legacy: the emission/burn claim formula of `RewardDistributor` V1/V2 — with the 55/25/15/5 buckets — remains documented on the contract pages, for historical claims.)

### GOV holder without stake

Captures voting right **and** the effect of the continuous buyback: 40% of every payment's fee across the ecosystem (= 1% of GMV) funds GOV repurchase. If GMV grows, buying pressure grows with it. If the protocol dies, GOV loses utility.

## Why it is not a Ponzi

Typical Ponzi: new tokens are issued to pay old holders without real counterparty. Here, since the remodel, **there is no emission as income at all**:

- Investor income is a slice of a real user payment (rev-share).
- New CREDIT is only born 1:1 against USDC deposited in the PSM.
- The GOV buyback is funded by a fee on real payments.
- There is no promised return: without app revenue, the rev-share pays zero.

If any link breaks (apps without utility, no users), income dries up **immediately and proportionally** — there is no scheme to collapse, because there is no liability backed by new entrants.

What **happens** if nobody uses:

- GMV → 0, rev-share → 0, fee → 0 (no buyback, no opex).
- Investors are left with positions that yield nothing; CREDIT remains redeemable 1:1 at the PSM.
- Protocol becomes a zombie — contracts running but no activity.

What **does not happen**:

- No promised APY, no last-resort counterparty.
- No bank run on CREDIT: backing is 100% and the PSM has no withdrawal function — 1:1 redemption does not depend on "market liquidity".
- No confiscation: accrued `claim` never expires; refund is full in a failed round.

## Safeguard mechanisms

1. **All-or-nothing** in the raise: the owner only gets paid if the target is hit; otherwise, 100% refund — nobody half-funds an unviable project.
2. **Staked-GOV gate** (invest + claim): the investor must have long-term skin in the game on the project; disarms opportunistic-capital attacks.
3. **Hard fee cap** (`FEE_BPS_CAP = 500`): not even governance can turn the rail into a confiscatory toll.
4. **Segregated PSM backing** (I-PSM1): the DAO cannot reach users' collateral — it only spends from the fee.
5. **Immutable funding bounds**: 1-30% rev-share, 1-90 day duration — protect investor and owner from degenerate terms.

(Legacy: floor decay, sanity cap and probation penalty protected the emission rail.)

## No guarantee of value

No mechanism guarantees:

- That GOV will appreciate (the buyback generates pressure proportional to usage, not a target price).
- That a rev-share position will pay itself back (depends 100% on the app's future revenue).
- That app usage will grow.

What **is** guaranteed by construction: 1:1 CREDIT redemption against the PSM backing (as long as USDC is worth 1 USD) and the immutable bounds above.

The architecture aligns incentives with real usage. If usage exists, the system operates as designed. If not, income dries up. **A bad product is not saved by tokenomics.**

## Points to observe before any exposure

- Project GMV (via `FeeRouterV2.grossVolumeOf` and `PaymentRouted` events).
- Revenue already distributed and pending (via `ProjectFunding.totalRevenueDistributed` / `pendingRevenue`).
- PSM backing (`backingNormalized()` vs `mintedOutstanding`).
- Funded/Failed ratio of fundraising rounds.
- Staking growth or decline (via `Staking.totalStaked` and `getGlobalWeight`).
- Recent proposals in the Governor (signal of political direction).
- Real GOV distribution (only the Treasury genesis post-deploy, or have there been allocations to team / public sale / liquidity?).

See [Metrics that matter](04-metrics-that-matter.md).

---

**Next →** [Risk and security](03-risk-and-security.md)
