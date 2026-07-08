# How to participate

**Audience:** regular user, little DAO experience, little patience for theory.
**Prerequisites:** have an EVM wallet (MetaMask, Rabby, Coinbase Wallet, etc.).

## The three ways to be in the system

You can participate in three ways, in increasing order of engagement:

1. **App user** — buys CREDIT in the PSM (1:1 with USDC, no fee), spends in apps. Simplest flow.
2. **Investor** — locks GOV in projects they support (curation) and invests CREDIT in their funding rounds; receives a share of real revenue (rev-share).
3. **Voter** — delegates voting power and votes on Governor proposals.

You can combine all three. Many investors are also users and voters.

## As an app user — step by step

**What you need:**

- An EVM wallet connected to the protocol's network.
- ETH (gas).
- USDC — to buy CREDIT in the [CreditPSM](../08-contracts-reference/15-CreditPSM.md).

**What you do:**

1. Buy CREDIT (hub's **Swap** tab): `USDC.approve(psm, amount)` + `CreditPSM.buy(amount)` — you receive 1:1, no fee or slippage. You can redeem back at any time with `sell` (also 1:1).
2. In the app's UI, find the service's price in CREDIT.
3. Click "pay" — the app prompts you to sign:
   - `CREDIT.approve(feeRouterV2, amount)` (approves the spend).
   - `FeeRouterV2.pay(projectId, amount)` (executes the payment — the payer is you, `msg.sender`).
4. You receive the app's service. Of the amount paid: a 2.5% protocol fee (40% treasury / 40% GOV buyback / 20% grants), the project's rev-share if it has a funded round, and the rest (~89.5-97.5%) goes to the app immediately. Nothing is burned.

**What is not required:**

- You do **not** need to own GOV.
- You do **not** need to vote.
- You do **not** need to stake.

## As an investor — step by step

**What you need:**

- GOV — acquired on external DEX or received via some allocation.
- CREDIT — bought in the PSM.
- A conscious decision about which `projectId` to support.

**What you do:**

1. Pick the project. Query the Registry (`projects[projectId]`) to confirm `status == Active`, read `metadataURI`, and check the on-chain GMV (`FeeRouterV2.grossVolumeOf(projectId)`).
2. Stake GOV in the project: `GOV.approve(staking, amount)` + `Staking.stake(projectId, amount, lockDuration)` (14-365+ day lock; 1x-4x multiplier). **The stake is the gate**: without GOV staked in the project you cannot invest nor claim rev-share.
3. In the hub's **Invest** tab, check the project's round: target, rev-share (1-30%), duration (1-90 days). All-or-nothing: if the target is not hit, full refund.
4. `CREDIT.approve(projectFunding, amount)` + `ProjectFunding.invest(projectId, amount)`.
5. If the round hits the target (Funded), you start accruing rev-share on every payment routed to the app.
6. Withdraw whenever you want with `ProjectFunding.claim(projectId)` — in the Invest tab. It never expires.

**Exit:**

- Failed round (deadline passed without hitting the target): `refund(projectId)` returns 100% of what you invested.
- Funded round: the invested capital does not come back — what you bought is the rev-share stream.
- Staked GOV: after the lock expires, `Staking.unstake` / `unstakeAll`. If the project becomes `Removed`, immediate unstake (lock bypass). Without stake, accrued rev-share is held (not lost) until you re-stake.

More detail in [Staking in projects](03-staking-in-projects.md) and [Claiming rev-share](05-claiming-rewards.md).

## As a voter — step by step

**What you need:**

- GOV (any amount).
- Delegate voting power to yourself (no delegation = no vote, even with GOV).

**What you do:**

1. `GovernanceToken.delegate(yourAddress)` — once. That activates your voting power.
2. When a proposal opens, go to the Governor UI (hub).
3. `CommunityGovernor.castVote(proposalId, support)` — `support` = 0 (Against), 1 (For), 2 (Abstain).
4. Wait for voting to close. If the proposal wins, it goes to the Timelock.
5. After the Timelock delay (2d), anyone can call `execute` — your action is not required, just a good signal.

You do **not** need to stake to vote. Voting power comes from the GOV you hold (via `getPastVotes`), not from the stake.

More detail in [Voting on proposals](04-voting.md).

## Operational costs

| Action | Cost |
|---|---|
| `approve` (once per allowance) | ~46k gas |
| `CreditPSM.buy` / `sell` | ~90-120k gas |
| `FeeRouterV2.pay` | ~150-250k gas (varies with active rev-share) |
| `Staking.stake` | ~250-300k gas |
| `Staking.unstake` | ~150-200k gas |
| `ProjectFunding.invest` | ~150-200k gas |
| `ProjectFunding.claim` | ~100-150k gas |
| `CommunityGovernor.castVote` | ~90k gas |

Approximate gas values — the ETH cost depends on the network and the gas price at the moment.

## What not to do

- **Do not send GOV directly to the economic contracts.** `Staking.stake` pulls via `transferFrom`. Direct transfer gets stuck.
- **Do not try to `unstake` before the lock** if the project is `Active` or `Probation`. Reverts with `LockNotExpired`.
- **Do not pay in apps without `approve`.** The `pay` function needs allowance.
- **Do not unstake all your GOV while you still have rev-share to claim** — the ProjectFunding `claim` requires GOV staked in the project. The value does not expire, but it is held until you re-stake.
- **Do not forget to `delegate`** if you want to vote — holding GOV without delegating = voting power 0.
- **Do not believe in "guaranteed yield"**. Rev-share comes from the app's real revenue. If the app does not sell, rev-share = zero.

## Quick FAQ

**Do I need to know how to program?** No. The protocol's hub has a UI for all operations. You sign transactions in your wallet.

**How much does it cost to participate?** The base cost is network gas. On Sepolia (testnet) it is almost zero. To invest you need GOV (stake) and CREDIT (round). To use apps, only CREDIT — bought 1:1 in the PSM.

**Can my CREDIT lose value?** CREDIT is redeemable 1:1 for USDC in the PSM at any time, with full backing held in the contract. The residual risk is USDC's own risk and contract bugs — see [Risks](../06-for-investors/03-risk-and-security.md).

**Can the DAO confiscate my staked GOV?** No. The lock protects even against governance itself. While the lock is active, not even an approved proposal unlocks your stake (unless the project is removed — in which case the unlock is pro-you, not against).

**And if the protocol dies?** If usage drops to near zero, there is no revenue for anyone: apps do not earn, rev-share dries up, GOV buyback stops. Your CREDIT remains redeemable 1:1 in the PSM. But tokenomics does not save a bad product.

**What about the old rewards claiming?** The emission rail (RewardDistributor V1/V2) is **legacy** — historical claims remain withdrawable, but there is no new emission. See [Claiming rev-share](05-claiming-rewards.md).

---

**Next →** [Holding GOV](02-holding-gov.md)
