# FAQ

**Audience:** anyone with a specific question.
**Prerequisites:** none.

## General

### What is web3community?

A multi-app platform governed by a DAO. Since the **2026-07-08 remodel**, it is a **payment rail + rev-share funding**: apps accept CREDIT (stable 1:1 USDC via the [CreditPSM](../08-contracts-reference/15-CreditPSM.md)) with a fee of only 2.5% on the [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), and investors fund projects in exchange for a slice of real revenue via [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). (Legacy: the burn-to-mint model with the 70/20/10 split and per-round emission was replaced.) Detail in [What is](../01-getting-started/01-what-is-web3community.md).

### What is the difference between GOV and CREDIT?

GOV is governance + investment gate (fixed supply 100M, votes, captures value via continuous buyback). CREDIT is a means of payment, **stable 1:1 with USDC** (mint/burn at the PSM, not speculative). Details in [Dual-token](../02-core-concepts/01-dual-token-economy.md) and [Mental model](../01-getting-started/02-mental-model.md).

### Where are the contracts?

18 contracts in `contracts/*.sol` — 3 from the 2026-07-08 remodel (`CreditPSM`, `FeeRouterV2`, `ProjectFunding`) + 15 earlier ones (some of them now legacy: V1 `FeeRouter`, `BurnTracker`, `RewardDistributor` V1/V2, `LiquidityGauge`). Individual reference in [08-contracts-reference](../08-contracts-reference/). On-chain addresses in [Contract addresses](../05-for-developers/02-contract-addresses.md).

### Why would an app use the FeeRouter instead of charging off-protocol?

Under the old model, it wouldn't — the ~80% effective take rate made bypassing the dominant strategy (Nash equilibrium at collapse; parecer `audit/economist/2026-07-08-feerouter-bypass.md`). That is exactly why the protocol changed. Under the current model:

- **2.5% fee** — cheaper than Stripe (~3.8%) and far below app stores (15-30%). Hard cap of 5% not even governance can exceed.
- **Upfront capital** — only projects that route revenue through FeeRouterV2 have a verifiable rev-share and can raise in `ProjectFunding` (cost of capital ~19% p.a. in the examples, comparable to revenue-based financing: Pipe/Clearco 15-25%).
- **On-chain metrics for investors** — `grossVolumeOf` is the GMV history that gives the round credibility.
- **Hub, user base and ready rail** (PSM + router, no acquirer/chargebacks).

Charging off-protocol means giving up funding and distribution — to pay more at another processor.

### Does CREDIT appreciate?

**No — by design.** CREDIT is stable: 1 CREDIT = 1 USDC, always, with 1:1 purchase and redemption at the PSM (backing 100% held, no withdrawal function — not even governance). Ecosystem appreciation is captured by **GOV**: 40% of every payment's fee (= 1% of GMV) funds continuous GOV buyback. Whoever seeks income funds projects via `ProjectFunding` (rev-share of real revenue).

### Which network is running?

See [Contract addresses](../05-for-developers/02-contract-addresses.md). Main production network will be defined after external audit.

## Usage

### Do I need to know how to program?

No. The hub has a UI for every operation. You sign transactions in your wallet.

### How much does it cost to participate?

Network gas + necessary tokens (GOV to stake, CREDIT to pay apps). On testnet (Sepolia), gas is nearly zero.

### How do I receive CREDIT?

- Buy at the `CreditPSM` with USDC, 1:1 and no fee (`buy`). Redeem the same way (`sell`).
- Receive as rev-share if you invested in the round of a project with revenue (`ProjectFunding.claim`).
- Receive via `UserSubsidy` if eligible in a campaign.
- (Legacy: burn-based emission rewards — historical claims remain withdrawable.)

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

If usage drops to near zero, GMV dries up: rev-share goes to zero, the fee goes to zero (no buyback, no opex). Investors are left with positions that yield nothing — but CREDIT remains redeemable 1:1 at the PSM (the backing does not depend on activity). The DAO can intervene (grants, subsidy via Treasury, onboard new apps). But tokenomics does not save a bad product.

### Is the GOV buyback real or "future"?

**Real and continuous.** 40% of every `FeeRouterV2.pay` fee (= 1% of GMV) goes automatically to the `buybackRecipient` — no per-event proposal needed. The more payments in the apps, the more GOV buying pressure. Detail in [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

(Legacy: the **CREDIT** buyback of the FFP model — `Treasury.executeBuyback`, USDC→CREDIT swap + burn with 20%/30% caps — belongs to the old rail; with CREDIT stable via the PSM, there is no floor to defend. Detail in [Treasury](../08-contracts-reference/04-Treasury.md).)

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

## Investor income (rev-share)

### How do I invest in a project?

1. Stake GOV on the project (`Staking.stake`) — it is the gate.
2. With the round open, `ProjectFunding.invest(projectId, amount)` in CREDIT.
3. If the round hits the target (all-or-nothing), the rev-share activates; if it expires without hitting it, `refund` returns 100%.

### When can I withdraw my revenue?

At any time, via `ProjectFunding.claim(projectId)` — revenue accrues on every payment processed by FeeRouterV2. Requires **keeping GOV staked on the project** (skin in the game).

### Do I lose revenue if I forget to claim (or if I unstake)?

**No.** Claims never expire. Without staked GOV you cannot withdraw, but the value stays accrued until you re-stake.

### Why is my claim zero?

Possible reasons:

- The project's round is not `Funded` (the rev-share only activates after the target is hit).
- The app has not processed payments since funding (`grossVolumeOf` flat).
- You already withdrew everything (`NothingToClaim`).
- You have no GOV staked on the project (`NoGovStaked` — the accrual is not lost).

Use `pendingRevenue(projectId, you)` to diagnose.

### How much will I receive?

`amount × revShareBps/10000 × (your shares / total shares)` on every payment. Illustrative yield of 14-19% p.a. in the docs' examples — it depends 100% on the app's real revenue and is not promised. See [Value accrual](../06-for-investors/02-value-accrual.md).

### What about the old emission rewards?

**Legacy.** Claims of finalized `RewardDistributor` V1/V2 rounds remain withdrawable indefinitely (`previewClaim` + `claim`), but there are no new emission rounds since the remodel. Detail in [Claiming rewards](../04-for-users/05-claiming-rewards.md).

## Projects / Apps

### How do I list my app?

- Prepare metadata off-chain (IPFS).
- Get 10,000 GOV for collateral.
- Someone with ≥ 10,000 GOV delegated proposes `registerProject` in the Governor.
- After approval and execution, `activateProject` (second proposal, can be batch).

Detail in [Submitting a project](../05-for-developers/03-submitting-a-project.md).

### How much do I receive per payment?

**97.5%** of every payment, instantly (protocol fee: 2.5%). If the project raised a round in `ProjectFunding`, the chosen rev-share (1-30%) is also deducted — e.g., with an 8% rev-share, you keep **~89.5%**. Use `feeRouterV2.previewPay(projectId, amount)` to simulate. (Legacy: under the V1 FeeRouter the app received only a 10% rebate.)

### If I stake in my own project, do I earn more?

Staking GOV on your own project lets you **invest in your own round** (and withdraw rev-share like any investor), besides signaling conviction. (Legacy: in the old model the stake captured a slice of the burn-based emission.) Detail in [Value flow](../03-protocol-overview/03-economic-flows.md).

### How do I raise capital for my app?

With the project Active, call `ProjectFunding.openRound(projectId, target, revShareBps, duration)`: target ≥ 100 CREDIT, rev-share between 1% and 30%, duration of 1 to 90 days. **One round per project** (MVP). All-or-nothing: target hit → you receive the raise instantly and the rev-share activates; expired without the target → investors get refunds and nothing changes for you. Detail in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

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
