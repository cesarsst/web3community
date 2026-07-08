# Reading paths

**Audience:** reader who has already read [What is](01-what-is-web3community.md) and wants an optimal sequence for their own case.
**Prerequisites:** [What is web3community](01-what-is-web3community.md), [Mental model](02-mental-model.md).

> **Remodel 2026-07-08**: the tracks below already point to the current model (CREDIT stable via the PSM, payments via FeeRouterV2, investing via ProjectFunding). The burn-to-mint/rewards pages are marked legacy.

## Dev track — I want to integrate an app

**Goal:** take an app from zero and accept CREDIT in it.

1. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md) — understand what you are asking the user to spend (CREDIT stable 1:1 USDC).
2. [Value flow](../03-protocol-overview/03-economic-flows.md) — how a payment splits (2.5% fee, rev-share, ~89.5-97.5% to the app).
3. [Integration overview](../05-for-developers/01-integration-overview.md) — technical flow step by step (`pay(projectId, amount)` + `PaymentRouted` event).
4. [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) — the `pay` function the user will call; [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) if you want to raise.
5. [Submitting a project](../05-for-developers/03-submitting-a-project.md) — listing process via governance.
6. [Local environment](../05-for-developers/05-local-dev.md) — run everything on localhost.

## Dev track — I want to audit the contracts

**Goal:** understand what the protocol promises on-chain.

1. [Mental model](02-mental-model.md) — the 4 models.
2. [Architecture](../03-protocol-overview/01-architecture.md) — dependency map.
3. [Security model](../09-advanced/03-security-model.md) — invariants, mitigated vectors.
4. [Contracts reference](../08-contracts-reference/) — read in numeric order (tokens → state → economy → governance → vesting/subsidy).

## User track — I want to use an app

**Goal:** start spending CREDIT inside a listed app.

1. [How to participate](../04-for-users/01-participate.md) — onboarding: buy CREDIT in the PSM (1:1, no fee) and pay in apps.
2. [CreditPSM](../08-contracts-reference/15-CreditPSM.md) — CREDIT entry and exit (buy and redeem).
3. [Holding GOV](../04-for-users/02-holding-gov.md) — if you also want to vote/invest.

## Investor track — I want to stake GOV and invest in projects

**Goal:** lock GOV in project(s), invest CREDIT in their rounds, and receive rev-share of real revenue.

1. [Directed staking](../02-core-concepts/02-directed-staking.md) — staking as curation + investment gate.
2. [Staking in projects](../04-for-users/03-staking-in-projects.md) — step-by-step flow (stake → invest → claim).
3. [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) — all-or-nothing rounds, 1-30% rev-share, 1-90 day duration.
4. [Claiming rev-share](../04-for-users/05-claiming-rewards.md) — how to withdraw in the Invest tab (never expires).
5. [Staking (contract)](../08-contracts-reference/05-Staking.md) — if you want to query on-chain.

## Governance track — I want to participate in the DAO

**Goal:** vote, propose, understand the Governor's power.

1. [Governance (concept)](../02-core-concepts/05-governance.md) — separation of powers.
2. [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md) — Pending → Executed.
3. [Voting power](../07-governance/02-voting-power.md) — delegation and snapshot.
4. [Parameters](../07-governance/03-parameters.md) — which parameters the DAO tweaks and in which ranges.
5. [Voting on proposals](../04-for-users/04-voting.md) — operational step-by-step.

## Economic track — I want to understand protocol health

**Goal:** form an informed judgment about tokenomics and sustainability.

1. [Value flow](../03-protocol-overview/03-economic-flows.md) — where real value enters, transits, and exits (PSM, 2.5% fee 40/40/20, rev-share).
2. [CreditPSM](../08-contracts-reference/15-CreditPSM.md) + [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) + [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) — the three contracts of the current rail.
3. [Value accrual](../06-for-investors/02-value-accrual.md) — where real value comes from (GOV captures via buyback of 1% of GMV).
4. [Risk and security](../06-for-investors/03-risk-and-security.md) — app revenue, peg/backing, regulatory.
5. [Metrics that matter](../06-for-investors/04-metrics-that-matter.md) — GMV, distributed revenue, PSM backing.
6. (Historical context) [Burn-to-mint (legacy)](../02-core-concepts/03-burn-to-mint.md) and [Rewards distribution (legacy)](../02-core-concepts/04-rewards-distribution.md) — the old model and why it was replaced.

## Curious track — I just want a general understanding

**Goal:** linear narrative without deep-diving into contracts.

1. [What is](01-what-is-web3community.md)
2. [Mental model](02-mental-model.md)
3. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
4. [Value flow](../03-protocol-overview/03-economic-flows.md)
5. [FAQ](../10-reference/01-faq.md)

---

**Next →** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
