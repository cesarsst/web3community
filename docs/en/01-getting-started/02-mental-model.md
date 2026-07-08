# Mental model

**Audience:** a reader who already knows this is a multi-app DAO (see [What is](01-what-is-web3community.md)) and now wants to understand how the system **thinks**.
**Prerequisites:** [What is web3community](01-what-is-web3community.md).

This page gives the four mental models the protocol uses. If you internalize all four, the rest of the docs read fast — most details are consequences of these models.

> **2026-07-08 remodel.** The protocol stopped being "deflationary burn-to-mint" and became a **payment rail + rev-share funding**: CREDIT is stable 1:1 with USDC (via [CreditPSM](../08-contracts-reference/15-CreditPSM.md)), apps pay a 2.5% fee on [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), and investors fund projects in exchange for a slice of real revenue via [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). The models below already reflect this; the old mechanism appears marked as legacy.

## 1. Two tokens, two totally distinct roles

The first trap is treating GOV and CREDIT as "two tokens of a DAO". They are **not symmetric**. Each one serves a role the other cannot serve.

```
  GOV (Governance)                     CREDIT (Payment rail)
  -----------------                    -----------------
  FIXED supply 100M                    ELASTIC supply
  (immutable cap)                      (mint on buy, burn on sell
                                        at the CreditPSM, 1:1 USDC)

  Votes on proposals                   Does NOT vote

  Staking collateral                   Means of payment in the apps
  (locked to earn weight and           (stable: 1 CREDIT = 1 USDC,
   the right to invest)                 backing 100% held in the PSM)

  Captures appreciation via            Does NOT appreciate or drop:
  continuous buyback (40% of           redeemable at any time
  the FeeRouterV2 fee)                 at the PSM
```

GOV is **political right, investment gate and long-term economic weight**. CREDIT is **the platform's stable operational money** — think of it as "USDC with ecosystem rails", not as a bet. Ecosystem appreciation is captured by GOV (via the fee-funded buyback); CREDIT is not meant to appreciate in the current model. A common mistake is thinking "stake CREDIT" (doesn't exist — you stake GOV and **invest** CREDIT) or "sell votes with CREDIT" (doesn't exist — only GOV votes).

Reference: [Dual-token economy](../02-core-concepts/01-dual-token-economy.md). Contracts: [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md), [CreditToken](../08-contracts-reference/02-CreditToken.md).

## 2. Staking is directed, not generic

On Uniswap, Aave, Curve: you stake a token and receive a reward "from the protocol". Undefined. Here it is different.

When you stake GOV, you **choose a project**. And the stake buys two things tied to that project:

1. **The right to invest**: only those with GOV staked on the project can enter its fundraising round in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) — and must **keep** the stake to withdraw the rev-share (skin in the game).
2. **Curation with skin in the game**: your capital is tied to that project's success. If ChatApp generates revenue, your investment yields; if it disappears from the map, it doesn't — even if other projects are booming.

```
  stake(projectId=ChatApp, amount=100 GOV, lock=180 days)
                 |
                 v
  You generate weight ONLY in ChatApp. Weight = 100 * multiplier(180 days).
  The multiplier ranges from 1x (14 days) to 4x (365 days).

  With GOV staked on ChatApp, you can:
     invest(ChatApp, X CREDIT)   in the fundraising round
     claim(ChatApp)              accrued revenue at any time
```

(Legacy: in the pre-remodel model, stake weight also pro-rated CREDIT emission by burn — formula in [Rewards distribution](../02-core-concepts/04-rewards-distribution.md), contracts `RewardDistributor`/`V2`, now legacy.)

**Practical consequence**: you need to pick projects. Active selection is part of the model — it is not passive. Being a staker here is like being an "app curator": you allocate capital where you think real revenue will be generated.

Reference: [Directed staking](../02-core-concepts/02-directed-staking.md). Contracts: [Staking](../08-contracts-reference/05-Staking.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

## 3. Income comes from real revenue — not from emission

Many protocols mint rewards using new supply without backing ("dilute whoever didn't stake to pay whoever did"). That tends to create an inflationary spiral. Since the 2026-07-08 remodel, here **there is no emission as income at all**: what the investor receives is a slice of the **real gross revenue** of the project they funded.

```
  user pays 100 CREDIT in ChatApp (FeeRouterV2.pay)
       |
       +--> 2.5 CREDIT  protocol fee (40% treasury / 40% GOV buyback / 20% grants)
       +--> 8.0 CREDIT  rev-share (if ChatApp raised at an 8% rev-share)
       |                 --> pro-rata across the round's investors
       +--> 89.5 CREDIT to ChatApp's owner, instantly
```

Translating:

- The investor funded ChatApp's round in CREDIT and receives a % of **every payment** — not of emission. If the app has no revenue, there is no income. Yield verifiable on-chain (`totalRevenueDistributed`, `grossVolumeOf`).
- The rev-share is chosen by the owner when opening the round, between **1% and 30%** (100-3000 bps), with a 1-90 day deadline and an all-or-nothing rule.
- The 2.5% fee (5% hard cap) funds the protocol: 40% treasury, 40% continuous GOV buyback, 20% grants.

**Implication**: if nobody uses the apps, there is no revenue — therefore, no income for anyone. It remains a bridge between real utility and return, but now without inflating or burning supply.

(Legacy: the old formula `emission_R = min(max(alpha * burn_{R-1}, floor(R)), capMax)` with α=0.95 is documented in [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md) and [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md) — contracts kept deployed for historical compatibility.)

Reference: [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

## 4. Every political change goes through delay

No privileged function of the economic contracts accepts a direct call. All require `GOVERNANCE_ROLE`, which in production only the [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) holds. And the Timelock only executes what was previously approved by the [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) and waited the delay (in production, 172800 seconds = 2 days).

```
  Alice proposes    Delay 1d      Voting 7d       Timelock queue   Delay 2d      Execution
  (needs 10k   ->  (anti-MEV)  -> (quorum 4%,  -> (queued in   ->  (response  -> (anyone
   GOV                             For > Against)  timelock)        time)         clicks)
   delegated
   to self)
```

This ensures that **no isolated actor can drain funds, replace contracts, or change parameters unilaterally**. The cost is latency: proposals take ~10 days to execute. That is intentional — latency is the security mechanism.

Reference: [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md). Contracts: [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md), [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md).

## What the model is NOT

To avoid common confusions:

- **It's not yield farming.** Staking here locks GOV directed to a project and is the gate to invest. Investor income is a rev-share of real revenue, not emission or dilution.
- **CREDIT is not a bet.** It is stable 1:1 with USDC via the `CreditPSM` — it doesn't appreciate, doesn't drop, and redeems at any time. Whoever wants exposure to ecosystem appreciation holds GOV.
- **It's not a token launchpad.** The Registry is a whitelist of apps that accept CREDIT; `ProjectFunding` sells a slice of **revenue**, not new tokens.
- **It's not a bank.** The PSM backing is segregated with no withdrawal function — not even governance can reach it. The treasury lives off the fee (1% of GMV), never off the backing.
- **It's not the burn-to-mint model.** 70% burn, formula-driven emission, 55/25/15/5 buckets and burn rounds are pre-2026-07-08 **legacy** — contracts still deployed, but outside the current flow.

---

**Next →** [Glossary](03-glossary.md)
