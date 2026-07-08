# Mental model

**Audience:** a reader who already knows this is a multi-app DAO (see [What is](01-what-is-web3community.md)) and now wants to understand how the system **thinks**.
**Prerequisites:** [What is web3community](01-what-is-web3community.md).

This page gives the four mental models the protocol uses. If you internalize all four, the rest of the docs read fast — most details are consequences of these models.

## 1. Two tokens, two totally distinct roles

The first trap is treating GOV and CREDIT as "two tokens of a DAO". They are **not symmetric**. Each one serves a role the other cannot serve.

```
  GOV (Governance)                     CREDIT (Utility)
  -----------------                    -----------------
  FIXED supply 100M                    ELASTIC supply
  (immutable cap)                      (mint/burn via roles)

  Votes on proposals                   Does NOT vote

  Staking collateral                   Burned when a user
  (locked to earn weight)              pays in an app

  NOT burned on usage                  Minted as reward

  Appreciates (if) via                 Disinflates via
  ecosystem appreciation               formula burn > mint
```

GOV is **political right and long-term economic weight**. CREDIT is **the platform's operational money**. Never mix the two in your reasoning — a common mistake is thinking "stake more CREDIT" (doesn't exist — you stake GOV) or "sell votes with CREDIT" (doesn't exist — only GOV votes).

Reference: [Dual-token economy](../02-core-concepts/01-dual-token-economy.md). Contracts: [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md), [CreditToken](../08-contracts-reference/02-CreditToken.md).

## 2. Staking is directed, not generic

On Uniswap, Aave, Curve: you stake a token and receive a reward "from the protocol". Undefined. Here it is different.

When you stake GOV, you **choose a project**. Your weight in rewards is tied to that project's success. If ChatApp is the chosen project and ChatApp generates a lot of burn, you capture a lot of reward. If ChatApp disappears from the map, your weight earns zero reward — even if other projects are booming.

```
  stake(projectId=ChatApp, amount=100 GOV, lock=180 days)
                 |
                 v
  You generate weight ONLY in ChatApp. Weight = 100 * multiplier(180 days).
  The multiplier ranges from 1x (14 days) to 4x (365 days).

  When the round closes:
     your_reward = round_emission
                * (ChatApp_burn / total_burn)
                * (your_weight / total_weight_in_ChatApp)
```

**Practical consequence**: you need to pick projects. Active selection is part of the model — it is not passive. Being a staker here is like being an "app curator": you allocate capital where you think it will generate usage.

Reference: [Directed staking](../02-core-concepts/02-directed-staking.md). Contract: [Staking](../08-contracts-reference/05-Staking.md).

## 3. Rewards come from burn — not from thin air

Many protocols mint rewards using new supply without backing ("dilute whoever didn't stake to pay whoever did"). That tends to create an inflationary spiral.

Here the formula is explicitly **post-paid**:

```
  emission of round R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Translating:

- `burn_{R-1}` — how much CREDIT was burned in the previous round. Verifiable on-chain source in [`BurnTracker`](../08-contracts-reference/06-BurnTracker.md).
- `alpha` — multiplier. In production 0.95 (`950000000000000000` wei from `ignition/parameters/production.json`), i.e., it emits **slightly less** than was burned. The system is **slightly deflationary if usage is constant**.
- `floor(R)` — emission floor of round R. Decreasing table with 24 entries (~6 months if `roundDuration = 7 days`). It exists only for the bootstrap — it guarantees some reward while usage does not yet exist.
- `capMax` — hard ceiling. Default 5M CREDIT per round in production (`capMax: 5000000000000000000000000`).

**Implication**: if nobody uses the apps, there is no burn, and after round 24 there is no floor — therefore, no emission. Stakers only earn if the ecosystem generates real usage. It is a bridge between on-chain utility and reward, not a bottomless pit.

Reference: [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md). Contract: [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md).

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

- **It's not yield farming.** Staking here locks GOV directed to a project. Rewards are in CREDIT and come from real usage, not from dilution.
- **It's not an AMM.** There is no internal liquidity pool. Swapping CREDIT for a stable happens outside web3community (external DEX).
- **It's not a launchpad.** The Registry is a whitelist of apps that accept CREDIT, not a distributor of new tokens.
- **It's not a CREDIT ICO.** The 10M CREDIT genesis is minted only once to the treasury (`mintGenesis`, one-shot). Subsequent emission comes only from `RewardDistributor`, tied to burn.

---

**Next →** [Glossary](03-glossary.md)
