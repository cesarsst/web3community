# Dual-token: GOV and CREDIT

**Audience:** anyone who wants to understand the economic base before any other detail.
**Prerequisites:** [Mental model](../01-getting-started/02-mental-model.md).

The protocol has two tokens because it tries to solve two problems that a single token does not solve well.

## The two problems

1. **Who decides the protocol's direction?** It needs a scarce instrument, not manipulable in the short term, with weight proportional to the investment someone has in the project. Answer: **GOV**.

2. **What is the currency used inside the apps?** It needs an instrument that burns when used (to create deflationary pressure that rewards retention) and that can be minted as a reward when usage generates value. Answer: **CREDIT**.

Using the same token for both creates dissonance: either you burn the voting token (ruins governance) or you grant voting rights to someone who just spent (ruins separation of powers).

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
| Subsequent mint | only `MINTER_ROLE` | granted to `RewardDistributor` at deploy |
| Burn | via `burn`, `burnFrom` (ERC20Burnable) **or** `burnByRole` | `burnByRole` without allowance, requires `BURNER_ROLE` |

**Why is there no hardcoded supply cap?**

Because the effective cap is **economic**, not syntactic. Whoever holds `MINTER_ROLE` is `RewardDistributor`, and its `mint` function is gated by the formula:

```
emission_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

with `alpha <= 0.99` (ceiling reduced from `1.1` to guarantee IE1 by construction — see `audit/economist/2026-04-22-consistency-audit.md` C2), `capMax <= 100M CREDIT` per round, and a decreasing `floor` that zeroes after round 23. Thus: emission is **limited by past consumption** and by a hard ceiling adjustable via governance, and **strictly deflationary in stable regime** because `alpha < 1` is a permanent invariant by code. A hardcoded cap on the token would be redundant and inflexible for future economic adjustments.

See [CreditToken](../08-contracts-reference/02-CreditToken.md).

## Important asymmetries

| Dimension | GOV | CREDIT |
|---|---|---|
| Supply | Fixed (immutable cap) | Elastic (governance adjusts formula) |
| Political function | Votes, delegates, accrues weight | Does not vote |
| Burnable on use? | No | Yes, via `FeeRouter.pay` |
| Stake reward in | — (GOV is not emitted as reward) | Yes (minted by `RewardDistributor`) |
| Value direction | Tends to appreciate with aggregate growth | Tends to disinflate with constant usage |

These differences are not decorative — they model the separation between "who decides" and "who uses". The DAO (via GOV) deliberates parameters that affect CREDIT, but not the other way around.

## Key contracts

| Contract | Role |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | GOV ERC20Votes |
| [CreditToken](../08-contracts-reference/02-CreditToken.md) | CREDIT ERC20Burnable with roles |
| [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md) | Only `MINTER_ROLE` on CREDIT |
| [BurnTracker](../08-contracts-reference/06-BurnTracker.md) | Only native `BURNER_ROLE` on CREDIT |
| [FeeRouter](../08-contracts-reference/08-FeeRouter.md) | Payment entrypoint that triggers the burn |

---

**Next →** [Directed staking](02-directed-staking.md)
