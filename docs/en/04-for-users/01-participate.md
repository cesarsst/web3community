# How to participate

**Audience:** regular user, little DAO experience, little patience for theory.
**Prerequisites:** have an EVM wallet (MetaMask, Rabby, Coinbase Wallet, etc.).

## The three ways to be in the system

You can participate in three ways, in increasing order of engagement:

1. **App user** — buys CREDIT on external DEX, spends in apps. Simplest flow.
2. **Staker** — locks GOV in projects they support, receives emitted CREDIT.
3. **Voter** — delegates voting power and votes on Governor proposals.

You can combine all three. Many stakers are also users and voters.

## As an app user — step by step

**What you need:**

- An EVM wallet connected to the protocol's network.
- ETH (gas).
- CREDIT — acquired on external DEX (Uniswap, PancakeSwap, etc., as integrations appear).

**What you do:**

1. In the app's UI, find the service's price in CREDIT.
2. Click "pay" — the app prompts you to sign:
   - `CREDIT.approve(feeRouter, amount)` (once — approves the spend).
   - `FeeRouter.pay(projectId, you, amount)` (executes the payment).
3. You receive the app's service. 95% of the paid value was burned, 5% went to the app.

**What is not required:**

- You do **not** need to own GOV.
- You do **not** need to vote.
- You do **not** need to stake.

Some apps may offer a flow where they submit the tx themselves (you only sign a meta-transaction). In that case, `approve` is enough.

## As a staker — step by step

**What you need:**

- GOV — acquired on external DEX or received via some allocation.
- A conscious decision about which `projectId` to support.
- A lock decision (14 to 365+ days).

**What you do:**

1. Pick the project. Query the Registry (`projects[projectId]`) to confirm `status == Active` and read `metadataURI`.
2. Pick the lock. Linear multiplier: 14d = 1x, 365d = 4x. Locks greater than 365d are accepted but multiplier saturates at 4x.
3. `GOV.approve(staking, amount)`.
4. `Staking.stake(projectId, amount, lockDuration)`.
5. Wait for rounds to close and be finalized.
6. `RewardDistributor.claim(round, projectId)` or `claimMany([rounds], [projectIds])` to withdraw CREDIT.

**Exit:**

- After the lock expires: `Staking.unstake(projectId, amount)` or `unstakeAll(projectId)`.
- If the project becomes `Removed` before: immediate unstake (lock bypass).
- During the lock (and non-Removed project): **you cannot exit**. Plan accordingly.

More detail in [Staking in projects](03-staking-in-projects.md) and [Claiming rewards](05-claiming-rewards.md).

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
| `FeeRouter.pay` (default split) | ~180-220k gas |
| `Staking.stake` | ~250-300k gas |
| `Staking.unstake` | ~150-200k gas |
| `RewardDistributor.claim` (one round/project) | ~180-220k gas |
| `RewardDistributor.claimMany` (N pairs) | ~180k + ~140k × N |
| `CommunityGovernor.castVote` | ~90k gas |

Approximate gas values — the ETH cost depends on the network and the gas price at the moment.

## What not to do

- **Do not send GOV directly to the economic contracts.** `Staking.stake` pulls via `transferFrom`. Direct transfer gets stuck.
- **Do not try to `unstake` before the lock** if the project is `Active` or `Probation`. Reverts with `LockNotExpired`.
- **Do not pay in apps without `approve`.** The `pay` function needs allowance.
- **Do not forget to `delegate`** if you want to vote — holding GOV without delegating = voting power 0.
- **Do not believe in "guaranteed yield"**. Reward varies with app usage. If usage drops, reward drops with it.

## Quick FAQ

**Do I need to know how to program?** No. The protocol's hub has a UI for all operations. You sign transactions in your wallet.

**How much does it cost to participate?** The base cost is network gas. On Sepolia (testnet) it is almost zero. To stake you need to own GOV. To use apps, CREDIT.

**Can the DAO confiscate my staked GOV?** No. The lock protects even against governance itself. While the lock is active, not even an approved proposal unlocks your stake (unless the project is removed — in which case the unlock is pro-you, not against).

**And if the protocol dies?** If usage drops to near zero, emission collapses, APR goes to near zero, stakers tend to leave. The DAO can intervene (adjust α, open subsidy via Treasury, onboard new apps). But tokenomics does not save a bad product.

---

**Next →** [Holding GOV](02-holding-gov.md)
