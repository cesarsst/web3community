# Holding GOV

**Audience:** user who wants to understand what the GOV token represents and how to use it.
**Prerequisites:** [Dual-token](../02-core-concepts/01-dual-token-economy.md).

## What GOV does for you

Holding GOV in your wallet gives you three capabilities:

1. **Vote on proposals** (if you delegate voting power to yourself).
2. **Stake in projects** (locks GOV and generates CREDIT reward weight).
3. **Register a project** as owner (if you have `minCollateral` available and get governance approval).

Without GOV, you can still be a user (spend CREDIT in apps), but you do not participate in decisions or staking.

## Activating voting power with `delegate`

GOV is an ERC-20 with the ERC20Votes extension. To vote, you need to **delegate voting power**. Holding balance is not enough.

```
GovernanceToken.delegate(yourAddress)
```

If you want to vote yourself, delegate to yourself. If you want someone else to vote on your behalf (a delegate you trust), delegate to their address.

Delegation:

- Is **free** (only gas).
- Can be **transferred** at any time (`delegate(newDelegatee)`).
- Follows your balance automatically — if you receive more GOV, your delegate gains more weight.
- If you sell GOV, your delegate loses weight in the same proportion.

**Important**: a delegation change takes effect in the next block. Proposals that already had an earlier snapshot use the delegation in force **at the snapshot block**.

## Snapshot and anti-flashloan

When a proposal opens, the Governor records the snapshot block. The vote function queries:

```solidity
uint256 votingPower = GovernanceToken.getPastVotes(account, snapshotBlock);
```

`getPastVotes` is historical — immune to flash loans. Whoever takes a flash loan of GOV **after** the snapshot has no voting power on the proposal.

## How to acquire GOV

GOV in circulation comes from:

- Initial allocations approved by the DAO (genesis distribution: treasury, team, public sale, community rewards, liquidity).
- Staking rewards (out of scope for v1 — the CREDIT reward emission does not mint GOV).
- Purchase on external DEX.

Distribution details in [Tokenomics](../06-for-investors/01-tokenomics.md).

## Using GOV as collateral to list a project

If you own an app and want to list it in the Registry:

1. Wait for the DAO to accept the listing proposal.
2. Do `GovernanceToken.approve(registry, collateralAmount)` (minimum 10,000 GOV in production).
3. When the `registerProject` proposal executes, `registerProject` will pull the GOV via `transferFrom`.

The GOV stays **locked in the Registry** until the project is `Removed`:

- If removal is without slash: returns to you.
- If removal is with slash: goes to the treasury.

More detail in [Submitting a project](../05-for-developers/03-submitting-a-project.md).

## Transferring GOV

GOV is standard ERC-20. Transfers follow the normal flow:

```
gov.transfer(recipient, amount)
gov.approve(spender, amount)
gov.transferFrom(owner, recipient, amount)
```

**Watch the delegation when you transfer**: if you delegate to X and then transfer all your GOV to Y, X's voting power drops to zero. Y does **not** automatically receive voting power — it must delegate explicitly.

## Permit (EIP-2612)

GOV inherits `ERC20Permit`. You can sign a "tx-less approve" via `permit(owner, spender, value, deadline, v, r, s)`. Useful for UX where you want to approve and use in a single tx (gasless approve).

## Supply cap

100M GOV is the absolute, immutable ceiling. When `totalSupply() == 100M`, `mint` calls revert with `CapExceeded`. That means **GOV emission is predictable** — everything that exists or will exist of GOV comes out of the DAO's approval process until the cap is reached.

Check current supply: `GovernanceToken.totalSupply()` / `GovernanceToken.cap()`.

## About (not) guaranteed yield

Holding GOV **does not pay yield on its own**. You earn CREDIT reward **only if you stake in a project that generates burn**. Keeping GOV idle in your wallet only gives you voting rights — it does not distribute CREDIT.

If you want to participate in the economic incentive, you need to go to [Staking in projects](03-staking-in-projects.md).

---

**Next →** [Staking in projects](03-staking-in-projects.md)
