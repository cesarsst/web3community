# FAQ

**Audience:** anyone with a specific question.
**Prerequisites:** none.

## General

### What is web3community?

A multi-app platform governed by a DAO. Apps accept CREDIT as payment; the deploy default split is 70% burned / 20% treasury / 10% app (CLP Phase 0, adjustable by proposal). GOV stakers in specific projects receive CREDIT emitted in the next round as a function of total burn. Detail in [What is](../01-getting-started/01-what-is-web3community.md).

### What is the difference between GOV and CREDIT?

GOV is governance (fixed supply 100M, votes). CREDIT is utility (elastic supply, burned on use). Details in [Dual-token](../02-core-concepts/01-dual-token-economy.md).

### Where are the contracts?

15 production contracts in `contracts/*.sol` (includes CLP pivot Phase 1: `LiquidityGauge`, `RewardDistributorV2` and `CreditPriceOracle`). Individual reference in [08-contracts-reference](../08-contracts-reference/). On-chain addresses in [Contract addresses](../05-for-developers/02-contract-addresses.md).

### Which network is running?

See [Contract addresses](../05-for-developers/02-contract-addresses.md). Main production network will be defined after external audit.

## Usage

### Do I need to know how to program?

No. The hub has a UI for every operation. You sign transactions in your wallet.

### How much does it cost to participate?

Network gas + necessary tokens (GOV to stake, CREDIT to pay apps). On testnet (Sepolia), gas is nearly zero.

### How do I receive CREDIT?

- Buy on external DEX (Uniswap, etc.).
- Receive as reward if you staked in a project that generated burn.
- Receive via `UserSubsidy` if eligible in a campaign.

### How do I receive GOV?

- Buy on external DEX.
- Receive via DAO-approved allocation (public sale, airdrop, vesting if team).

### How do I vote?

1. Delegate voting power to yourself: `gov.delegate(you)`.
2. Wait for a proposal to open.
3. Call `governor.castVote(proposalId, support)` via UI or directly.

Detail in [Voting on proposals](../04-for-users/04-voting.md).

### Can the DAO confiscate my staked GOV?

**No.** The staking lock protects even against governance itself. While the lock is active, an approved proposal **does not unlock** your stake. The only exception is if the project is `Removed` — in which case it is early release, pro-user (not against).

### What if the protocol dies?

If usage drops to near zero, emission collapses, APR goes to near zero, stakers leave. The DAO can intervene (adjust α, open subsidy via Treasury, onboard new apps). But tokenomics does not save a bad product.

### Is the CREDIT buyback real or "future"?

**Real.** Since CLP Phase 1.1, `Treasury.executeBuyback` does the USDC → CREDIT swap via Uniswap V3 and immediately burns the bought CREDIT, defending the floor price (FFP model). The price comes from a real oracle (`CreditPriceOracle`, Uniswap V3 CREDIT/USDC TWAP + Chainlink USDC/USD sanity), set via `setPriceOracle`. Each buyback requires an approved DAO proposal (it is `GOVERNANCE_ROLE` = Timelock) and passes per-event (20%) and monthly (30%) caps over the USDC reserves. Detail in [Treasury](../08-contracts-reference/04-Treasury.md) and [CreditPriceOracle](../08-contracts-reference/14-CreditPriceOracle.md).

## Staking

### What is the minimum lock?

14 days. Lock below that reverts with `LockTooShort`.

### What is the maximum lock?

There is no programmatic maximum. But the multiplier saturates at 4x starting at 365 days — locking more immobilizes capital without additional weight.

### Can I exit before the lock?

**No**, unless the project is `Removed`. `Probation` (punitive or initial) does not bypass lock.

### Can I stake in multiple projects?

Yes. Each `projectId` is an independent position.

### If I increase_stake, does the lock reset?

**No.** `increaseStake` preserves `lockStartAt` and `lockDuration`. Only `stake` on an existing position resets.

### Does extend lock change amount?

**No.** `extendLock` only changes `lockDuration`.

## Rewards

### When can I claim?

After the round closes (`closeRound` via governance) and is finalized (`finalizeRound` — permissionless). Detail in [Claiming rewards](../04-for-users/05-claiming-rewards.md).

### Do I lose reward if I forget?

**No.** There is no deadline. Once finalized, your claim right persists indefinitely.

### Why is my claim zero?

Possible reasons:

- Round not finalized (`RoundNotFinalized`).
- You already claimed (`AlreadyClaimed`).
- Your weight was zero at `snapshotBlock`.
- Project generated no burn and had no global weight.

Use `previewClaim(you, round, projectId)` to diagnose.

### How much will I receive?

Depends on project burn × your weight × round total. Formula in [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Projects / Apps

### How do I list my app?

- Prepare metadata off-chain (IPFS).
- Get 10,000 GOV for collateral.
- Someone with ≥ 10,000 GOV delegated proposes `registerProject` in the Governor.
- After approval and execution, `activateProject` (second proposal, can be batch).

Detail in [Submitting a project](../05-for-developers/03-submitting-a-project.md).

### How much do I receive per payment?

10% by default (rebate) in the Phase 0 deploy split (`(7000, 2000, 1000)` = 70% burn / 20% treasury / 10% app). Adjustable per project via proposal (`setProjectSplit`).

### If I stake in my own project, do I earn more?

Yes. You capture a slice of emission proportional to your stake weight. Detail in [Value flow](../03-protocol-overview/03-economic-flows.md).

### Do I lose my collateral if I leave?

No, if removal is without slash. Proposal `removeProject(id, slash=false, _)` returns collateral to the owner.

If removal is with slash (`slash=true`), collateral goes to Treasury.

## Governance

### How much GOV do I need to propose?

10,000 GOV delegated (production). Adjustable via proposal within `[0, unlimited]`.

### How long does a proposal take?

~10 days in production: 1d delay + 7d voting + 2d timelock.

### Can I cancel my proposal?

Yes, while it is `Pending` or `Active`. After `Succeeded`, a counter-proposal is needed.

### My proposal was approved but no one queued/executed?

Anyone can call `queue` and `execute`. Just someone needs to do it — typically an engaged holder or the proposer.

### Can I vote via delegation?

Yes. `gov.delegate(trustedAddress)` transfers voting power to whom you trust. Your balance remains yours.

## Technical

### Which Solidity version?

0.8.24 with `viaIR: true`.

### Which OpenZeppelin?

5.0.2 pinned exact.

### Is there an upgrade path?

**No.** Contracts are immutable. Replacement requires new deploy + migration of roles.

### Is there pause?

**On the core economic contracts (Treasury, tokens, distributor), no** — a conscious decision, any treasury pause would be a capture vector. **Exception**: the `LiquidityGauge` (CLP Phase 1.3) is `Pausable`, but the pause blocks only the ENTRY of new stakes — `unstake`/`harvest` remain operational and `emergencyUnstake` is always fail-safe (invariant IE10, "do not pause the user"). The gauge's `pause`/`unpause` is `GOVERNANCE_ROLE` (Timelock).

### Is there a guardian multisig?

**Not in v1.** Timelock is self-administered. `CANCELLER_ROLE` is only the Governor's (cancel via proposal). A guardian multisig can be added in a future DAO proposal.

### Is there a bug bounty?

Planned via Immunefi right after mainnet. Critical range: $50k-$250k.

### How do I test locally?

```bash
npm install
npx hardhat node                       # terminal 1
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost                  # terminal 2
```

Detail in [Local environment](../05-for-developers/05-local-dev.md).

---

**Next →** [Resources](02-resources.md)
