# What is web3community

**Audience:** anyone new to the project — dev, user, or curious.
**Prerequisites:** basic familiarity with EVM wallets (MetaMask, Rabby, Coinbase Wallet). Solidity is **not** required for this page.

## In one sentence

web3community is **a multi-app platform governed by a DAO**, in which every app in the ecosystem shares the same usage currency (CREDIT, stable 1:1 with USDC), the same political layer (governance via GOV), and the same economic engine that converts real usage into revenue for the apps and rev-share income for those who fund them (2026-07-08 remodel).

## The problem it solves

In the traditional web2 model, every app is a silo: its own token, its own governance, its own user base, its own monetization. The result is fragmentation — users switch wallets for every app, developers struggle to bootstrap liquidity, and neither side benefits from aggregation.

web3community shares three things across every listed app:

1. **Common economic identity.** Every app accepts CREDIT as payment. Anyone who buys CREDIT can use any app.
2. **Common governance.** A single Governor + Timelock decides additions, parameter tweaks, and blocks of malicious apps.
3. **Common funding engine.** Whoever locks GOV directed to a project (directed staking) can fund its fundraising round and receives a slice of real revenue (rev-share) on every payment. (Legacy: in the pre-2026-07-08 model, the stake captured CREDIT emitted as a function of burn.)

The result: individual apps can be small, but the aggregate network has network effects. Users move from app to app without switching currency. Ecosystem supporters capture value proportional to total growth, not to a specific app.

## The DAO in 3 layers

To understand the architecture, think of three overlapping layers.

```
    Political layer          Governor + Timelock
           |                 (decides what changes)
           v
    State layer              Registry + Treasury + Staking + ProjectFunding
           |                 (holds who and what)
           v
    Economic layer           CreditPSM + FeeRouterV2 + GOV + CREDIT
                             (moves value)
```

- **Political layer** is formed by [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) and [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Every decision goes through proposal + vote + 2-day delay.
- **State layer** stores the facts: who owns which project ([`ProjectRegistry`](../08-contracts-reference/03-ProjectRegistry.md)), how much of each token is in the treasury ([`Treasury`](../08-contracts-reference/04-Treasury.md)), who staked how much in which project ([`Staking`](../08-contracts-reference/05-Staking.md)), who raised and who invested in each round ([`ProjectFunding`](../08-contracts-reference/16-ProjectFunding.md)).
- **Economic layer** moves value. Users buy CREDIT 1:1 with USDC at the [`CreditPSM`](../08-contracts-reference/15-CreditPSM.md) and pay through the [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) — 2.5% fee (40% treasury / 40% GOV buyback / 20% grants), rev-share to funding (if any) and the rest (~89.5-97.5%) straight to the app. (Legacy: the burn-to-mint rail with the V1 FeeRouter + RewardDistributor is described on the contract pages.)

## The two tokens in one line each

- **GOV** — governance token and staking collateral. Immutable supply cap of 100M. Votes on proposals. Locked in projects to generate weight — which grants the right to invest in fundraising rounds. Captures appreciation via the fee-funded continuous buyback.
- **CREDIT** — means of payment, **stable 1:1 with USDC** (purchase and redemption at the PSM, no fee, backing 100% held). Neither deflationary nor speculative.

More detail in [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## The cycle that keeps the system alive

In one sentence: **real usage → revenue to the apps (97.5%) + rev-share to investors + fee to the protocol (2.5%) → more upfront capital for apps → more apps → more usage**.

If usage drops, revenue drops, the rev-share dries up, the GOV buyback stops, the system slows down. If usage grows, the whole cycle accelerates. **Tokenomics does not save a bad product** — the protocol's sustainability depends on apps generating real utility.

Full breakdown in [Value flow](../03-protocol-overview/03-economic-flows.md).

## Who does what

| Role | What they do | How they benefit |
|---|---|---|
| **End user** | Buys CREDIT at the PSM (1:1 USDC), uses the apps | Gets the service from the apps; redeems the CREDIT whenever they want |
| **App developer** | Builds app, integrates with FeeRouterV2 | Keeps ~89.5-97.5% of revenue instantly + upfront capital via a funding round |
| **Investor** | Locks GOV on the project and invests CREDIT in the round | Receives a % of real revenue (rev-share) on every payment |
| **GOV holder without stake** | Participates in governance | Voting rights over parameters + continuous buyback (1% of GMV) |

## Where the code lives

- Contracts: `contracts/*.sol` in the public repo.
- Deploy: `ignition/modules/Dao.ts` + `ignition/parameters/*.json`.
- Tests: `test/`.

All verifiable, auditable, and immutable post-deploy except for parameters adjustable via governance (listed in [Parameters](../07-governance/03-parameters.md)).

---

**Next →** [Mental model](02-mental-model.md)
