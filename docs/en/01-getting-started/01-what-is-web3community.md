# What is web3community

**Audience:** anyone new to the project — dev, user, or curious.
**Prerequisites:** basic familiarity with EVM wallets (MetaMask, Rabby, Coinbase Wallet). Solidity is **not** required for this page.

## In one sentence

web3community is **a multi-app platform governed by a DAO**, in which every app in the ecosystem shares the same usage currency (CREDIT), the same political layer (governance via GOV), and the same economic engine that converts real usage into emission distributed to supporters.

## The problem it solves

In the traditional web2 model, every app is a silo: its own token, its own governance, its own user base, its own monetization. The result is fragmentation — users switch wallets for every app, developers struggle to bootstrap liquidity, and neither side benefits from aggregation.

web3community shares three things across every listed app:

1. **Common economic identity.** Every app accepts CREDIT as payment. Anyone who buys CREDIT can use any app.
2. **Common governance.** A single Governor + Timelock decides additions, parameter tweaks, and blocks of malicious apps.
3. **Common rewards engine.** Whoever locks GOV directed to a project (directed staking) receives CREDIT emitted as a function of that project's real usage.

The result: individual apps can be small, but the aggregate network has network effects. Users move from app to app without switching currency. Ecosystem supporters capture value proportional to total growth, not to a specific app.

## The DAO in 3 layers

To understand the architecture, think of three overlapping layers.

```
    Political layer          Governor + Timelock
           |                 (decides what changes)
           v
    State layer              Registry + Treasury + Staking + BurnTracker
           |                 (holds who and what)
           v
    Economic layer           RewardDistributor + FeeRouter + GOV + CREDIT
                             (moves value)
```

- **Political layer** is formed by [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) and [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Every decision goes through proposal + vote + 2-day delay.
- **State layer** stores the facts: who owns which project ([`ProjectRegistry`](../08-contracts-reference/03-ProjectRegistry.md)), how much of each token is in the treasury ([`Treasury`](../08-contracts-reference/04-Treasury.md)), who staked how much in which project ([`Staking`](../08-contracts-reference/05-Staking.md)), how much was burned in each round ([`BurnTracker`](../08-contracts-reference/06-BurnTracker.md)).
- **Economic layer** moves value. Users pay in CREDIT through the [`FeeRouter`](../08-contracts-reference/08-FeeRouter.md) — 95% is burned, 5% goes to the app. Stakers receive newly minted CREDIT via the [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md), whose formula ties future emission to past burn.

## The two tokens in one line each

- **GOV** — governance token and staking collateral. Immutable supply cap of 100M. Votes on proposals. Locked in projects to generate reward weight.
- **CREDIT** — utility token. Elastic supply controlled by governance. Burned when you use an app. Minted as reward for stakers as a function of how much was burned in the previous round.

More detail in [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## The cycle that keeps the system alive

In one sentence: **real usage → CREDIT burn → CREDIT emission to stakers → more incentive to support apps → more apps → more usage**.

If usage drops, burn drops, emission drops, staking incentive drops, the system slows down. If usage grows, the whole cycle accelerates. **Tokenomics does not save a bad product** — the protocol's sustainability depends on apps generating real utility.

Full breakdown in [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

## Who does what

| Role | What they do | How they benefit |
|---|---|---|
| **End user** | Buys CREDIT, uses the apps | Gets the service from the apps |
| **App developer** | Builds app, integrates with FeeRouter | Receives rebate per usage + rewards if they stake on their own project |
| **Staker** | Locks GOV in a project they support | Receives CREDIT emitted proportional to that project's burn |
| **GOV holder without stake** | Participates in governance | Keeps voting rights over economic parameters |

## Where the code lives

- Contracts: `contracts/*.sol` in the public repo.
- Deploy: `ignition/modules/Dao.ts` + `ignition/parameters/*.json`.
- Tests: `test/`.

All verifiable, auditable, and immutable post-deploy except for parameters adjustable via governance (listed in [Parameters](../07-governance/03-parameters.md)).

---

**Next →** [Mental model](02-mental-model.md)
