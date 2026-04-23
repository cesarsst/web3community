# Reading paths

**Audience:** reader who has already read [What is](01-what-is-web3community.md) and wants an optimal sequence for their own case.
**Prerequisites:** [What is web3community](01-what-is-web3community.md), [Mental model](02-mental-model.md).

## Dev track — I want to integrate an app

**Goal:** take an app from zero and accept CREDIT in it.

1. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md) — understand what you are asking the user to spend.
2. [Architecture](../03-protocol-overview/01-architecture.md) — see how the FeeRouter talks to the rest.
3. [Integration overview](../05-for-developers/01-integration-overview.md) — technical flow step by step.
4. [FeeRouter](../08-contracts-reference/08-FeeRouter.md) — the `pay` function you will call.
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

1. [How to participate](../04-for-users/01-participate.md) — onboarding steps.
2. [Holding GOV](../04-for-users/02-holding-gov.md) — if you also want to vote/stake.
3. [Claiming rewards](../04-for-users/05-claiming-rewards.md) — if you already staked.

## User track — I want to stake GOV

**Goal:** lock GOV in project(s) to receive CREDIT.

1. [Directed staking](../02-core-concepts/02-directed-staking.md) — how weight + multiplier work.
2. [Staking in projects](../04-for-users/03-staking-in-projects.md) — step-by-step flow.
3. [Claiming rewards](../04-for-users/05-claiming-rewards.md) — how to withdraw the CREDIT generated.
4. [Staking (contract)](../08-contracts-reference/05-Staking.md) — if you want to query on-chain.

## Governance track — I want to participate in the DAO

**Goal:** vote, propose, understand the Governor's power.

1. [Governance (concept)](../02-core-concepts/05-governance.md) — separation of powers.
2. [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md) — Pending → Executed.
3. [Voting power](../07-governance/02-voting-power.md) — delegation and snapshot.
4. [Parameters](../07-governance/03-parameters.md) — which parameters the DAO tweaks and in which ranges.
5. [Voting on proposals](../04-for-users/04-voting.md) — operational step-by-step.

## Economic track — I want to understand protocol health

**Goal:** form an informed judgment about tokenomics and sustainability.

1. [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md) — the formula and the deflationary invariant.
2. [Rewards distribution](../02-core-concepts/04-rewards-distribution.md) — how the pool becomes a user claim.
3. [Tokenomics](../06-for-investors/01-tokenomics.md) — buckets, vesting, floor schedule.
4. [Value accrual](../06-for-investors/02-value-accrual.md) — where real value comes from.
5. [Risk and security](../06-for-investors/03-risk-and-security.md) — vectors that can kill the system.
6. [Metrics that matter](../06-for-investors/04-metrics-that-matter.md) — what to watch every week.

## Curious track — I just want a general understanding

**Goal:** linear narrative without deep-diving into contracts.

1. [What is](01-what-is-web3community.md)
2. [Mental model](02-mental-model.md)
3. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
4. [Value flow](../03-protocol-overview/03-economic-flows.md)
5. [FAQ](../10-reference/01-faq.md)

---

**Next →** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
