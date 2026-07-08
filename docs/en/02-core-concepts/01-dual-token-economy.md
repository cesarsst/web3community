# Dual-token: GOV and CREDIT

**Audience:** anyone who wants to understand the economic base before any other detail.
**Prerequisites:** [Mental model](../01-getting-started/02-mental-model.md).

> **Remodel 2026-07-08**: this page describes the current model — CREDIT stable 1:1 with USDC via [CreditPSM](../08-contracts-reference/15-CreditPSM.md); the deflationary design (burn-to-mint) is now legacy.

The protocol has two tokens because it tries to solve two problems that a single token does not solve well.

## The two problems

1. **Who decides the protocol's direction — and who captures its growth?** It needs a scarce instrument, not manipulable in the short term, with weight proportional to the investment someone has in the project. Answer: **GOV**.

2. **What is the currency used inside the apps?** It needs an instrument that is **stable and predictable** — nobody prices a service in a volatile currency. Answer: **CREDIT**, stable 1:1 with USDC via [CreditPSM](../08-contracts-reference/15-CreditPSM.md) (buy and redeem with no fee, backing 100% held in the contract).

Using the same token for both creates dissonance: either the payment currency floats with governance speculation (ruins app pricing) or you grant voting rights to someone who just spent (ruins separation of powers). The current separation is clean: **CREDIT is a stable payment rail; GOV is what captures growth** — 40% of the fee on every payment (1% of GMV) funds continuous GOV buyback via [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

## GOV — governance and long-term weight

| Property | Value | Source |
|---|---|---|
| Name in production | Web3Community Governance | `ignition/parameters/production.json` |
| Symbol | GOV | ditto |
| Supply cap | 100,000,000 (immutable) | `GovernanceToken.CAP_SUPPLY` |
| Standard | ERC-20 + ERC20Permit + ERC20Votes | inheritance in `GovernanceToken` |
| Minter | only the current `owner` (`Ownable2Step`) | `GovernanceToken.mint()` |
| Owner in production | `CommunityTimelock` | handoff on deploy |
| Burnable? | No | does not inherit `ERC20Burnable` |

**How it enters circulation**: zero at deploy. Every unit of GOV only exists because someone called `mint(to, amount, tag)` — in production this only happens via a proposal approved in the Governor, because the owner is the Timelock. The full allocation (treasury, team via `TeamVesting`, public sale, community rewards, liquidity) happens in separate, documentable, auditable proposals.

> **Warning — contracts pending design.** The "full" allocation described above is **intent**, not current state of the repo. `TeamVesting` (one instance per beneficiary) and `UserSubsidy` (singleton Merkle) exist in the repo. The contracts for **public sale (`Sale`), liquidity provisioning (`LiquidityBootstrappingPool` / `LiquidityManager`), and liquidity-mining (`LPRewards`) DO NOT exist in the current repo** — they must be designed, audited, and deployed before the corresponding proposals. Operational detail in [Tokenomics](../06-for-investors/01-tokenomics.md) and README §7.

**Usage**:

1. **Vote**: just delegate to yourself (`delegate(self)`) or to someone else via `GovernanceToken.delegate`. Voting power is read via `getPastVotes(account, snapshotBlock)` — immune to flash loans.
2. **Stake**: call `Staking.stake(projectId, amount, lockDuration)`. GOV goes to the contract and generates proportional weight.
3. **Collateral to list a project**: the owner of a new project locks GOV as collateral in `ProjectRegistry` (minimum 10,000 GOV in production, adjustable via governance).

See [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) for the full reference.

## CREDIT — operational currency of the platform

| Property | Value | Source |
|---|---|---|
| Name in production | Web3Community Credit | `ignition/parameters/production.json` |
| Symbol | CREDIT | ditto |
| Hardcoded supply cap | **Does not exist** | `CreditToken` does not enforce a cap |
| Standard | ERC-20 + ERC20Burnable + AccessControl | inheritance in `CreditToken` |
| Genesis | 10,000,000 CREDIT to `Treasury`, one-shot | `mintGenesis`, flag `genesisMinted` |
| Current mint | `MINTER_ROLE` on the **CreditPSM** — mints 1:1 against deposited USDC (`buy`) | [CreditPSM](../08-contracts-reference/15-CreditPSM.md) |
| Current burn | `BURNER_ROLE` on the **CreditPSM** — burns on redemption (`sell`, returns USDC 1:1) | ditto |
| Legacy mint/burn | `RewardDistributor` V1/V2 (historical claims) and `BurnTracker` (burn rail de facto deactivated — FeeRouterV2 does not burn) | contracts remain deployed |

**Why is there no hardcoded supply cap?**

Because CREDIT supply is **elastic by design, but always backed**. Every CREDIT minted by the PSM has 1 USDC held in the contract (invariant I-PSM1: `backing >= mintedOutstanding`, with no function to withdraw the backing — not even governance). Supply grows when there is payment demand in the apps and shrinks when users redeem. A hardcoded cap would be arbitrary: the real limit is the USDC coming in.

> **Legacy**: in the pre-remodel model, the cap was "economic" via the `RewardDistributor` emission formula `min(max(alpha × burn, floor), capMax)`, with deflationary CREDIT. That rail is deactivated as the current mechanism — see [Burn-to-mint (legacy)](03-burn-to-mint.md).

See [CreditToken](../08-contracts-reference/02-CreditToken.md).

## Important asymmetries

| Dimension | GOV | CREDIT |
|---|---|---|
| Supply | Fixed (immutable 100M cap) | Elastic, 100% USDC-backed (PSM) |
| Political function | Votes, delegates, accrues weight | Does not vote |
| Price | Floats — captures ecosystem growth | Stable: 1 CREDIT = 1 USDC, always (buy/redeem in the PSM with no fee) |
| How it captures value | **Continuous buyback**: 40% of the FeeRouterV2 fee (= 1% of GMV) funds GOV buybacks | Does not capture — it is a payment rail |
| Role of staking | Governance + curation + **investment gate** in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) | Investable in funding rounds (rev-share of real revenue) |

These differences are not decorative — they model the separation between "who decides and captures value" and "what you pay with". The DAO (via GOV) deliberates parameters that affect CREDIT, but not the other way around.

## Key contracts

| Contract | Role |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | GOV ERC20Votes |
| [CreditToken](../08-contracts-reference/02-CreditToken.md) | CREDIT ERC20Burnable with roles |
| [CreditPSM](../08-contracts-reference/15-CreditPSM.md) | CREDIT entry/exit: USDC ↔ CREDIT 1:1, no fee, full backing |
| [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) | Payment rail: 2.5% fee (40% treasury / 40% GOV buyback / 20% grants) + rev-share |
| [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) | Funding rounds with 1–30% rev-share — investor income comes from real revenue |
| [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md) / [V2](../08-contracts-reference/07b-RewardDistributorV2.md), [BurnTracker](../08-contracts-reference/06-BurnTracker.md), [FeeRouter V1](../08-contracts-reference/08-FeeRouter.md) | **Legacy** — pre-remodel burn-to-mint rail, contracts remain deployed |

---

**Next →** [Directed staking](02-directed-staking.md)
