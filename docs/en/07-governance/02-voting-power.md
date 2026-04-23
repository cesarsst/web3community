# Voting power

**Audience:** GOV holder and anyone wanting to understand how voting power is computed.
**Prerequisites:** [Governance (concept)](../02-core-concepts/05-governance.md).

## Voting power ≠ balance

A common mistake: assuming that `balanceOf(you)` is your voting power. It is not.

In ERC20Votes, you need to **delegate** to activate voting power. Without delegation, your voting power is **zero**, even holding GOV.

```solidity
// Your current balance
uint256 bal = gov.balanceOf(you);          // could be 10,000 GOV

// Your current voting power (ledger)
uint256 vp = gov.getVotes(you);             // could be 0 if you did not delegate
```

## Delegation

Two forms:

### Self-delegation (you vote your own GOV)

```solidity
gov.delegate(you);
```

After that, `getVotes(you) == balanceOf(you)`.

### Delegation to a third party

```solidity
gov.delegate(trustedDelegate);
```

After that, `getVotes(trustedDelegate) += balanceOf(you)` and your voting power is zero (you yielded).

No cost (only gas). Can be changed at any time.

## How `getVotes` reacts to transfers

The value of `getVotes(delegate)` is automatically updated when:

- You receive GOV: `getVotes(yourDelegate) += amount`.
- You send GOV: `getVotes(yourDelegate) -= amount`.
- You change delegation: `getVotes(oldDelegate) -= yourBalance`, `getVotes(newDelegate) += yourBalance`.

Implemented in OpenZeppelin's `ERC20Votes._update`.

## Historic snapshot

What matters for voting is not current `getVotes` — it is `getPastVotes` at the proposal's snapshot.

```solidity
uint256 snapshotBlock = governor.proposalSnapshot(proposalId);
uint256 vpAtSnapshot  = gov.getPastVotes(you, snapshotBlock);
```

That is the function the Governor calls when you vote. Immune to flash loans — the snapshot is a past block.

## DelegateBySig (off-chain signature)

You can delegate via EIP-712 signature without paying gas — someone relays the tx:

```solidity
gov.delegateBySig(delegatee, nonce, expiry, v, r, s);
```

Useful for UX that wants to "activate voting with one signature" without direct on-chain interaction from the user.

## Changing delegation

```solidity
gov.delegate(newDelegatee);
```

Takes effect in the next block. Proposals that already had a snapshot **before** the change block use the old delegation (that was in effect at the snapshot).

## Total voting power

To know the system's total voting power in a block:

```solidity
uint256 total = gov.getPastTotalSupply(blockNumber);
```

Used by Governor's `quorum(timepoint)` to compute minimum quorum.

## Who ignores delegation?

**No one** on the on-chain path. If you did not delegate, your GOV literally does not vote — neither for you nor anyone else.

## Why delegation is mandatory

ERC20Votes enforces delegation to preserve the invariant that **the sum of `getVotes(all delegates)` equals `totalSupply`** at least from an accounting standpoint. Without explicit delegation, voting power "stays in limbo" — and the holder's `getVotes` is 0 by design.

This avoids the "vote stealing" pattern of older implementations and forces the conscious decision of "do I vote myself or delegate?".

## Balance propagation

If you hold 10k GOV and delegated to yourself:

```
you.balance  = 10,000
you.delegates = you
you.getVotes  = 10,000
```

You receive 5k more GOV:

```
you.balance  = 15,000
you.delegates = you (did not change)
you.getVotes  = 15,000 (automatically updated)
```

You send 3k to Bob (who delegated to Charlie):

```
you.balance   = 12,000
you.getVotes  = 12,000
Bob.balance    = 3,000
Bob.getVotes   = 0 (Bob has no delegation)
Charlie.getVotes += 3,000 (Bob's delegatee)
```

Note that if Bob did not delegate beforehand, his GOV still votes for nobody. Bob needs to call `gov.delegate(...)` to activate.

## Proposal at a specific snapshot

When `governor.propose(...)` is called at block `X`:

- `proposalSnapshot(id) = X + votingDelay`.
- The snapshot is exactly `votingDelay` blocks ahead of the proposal block.

Therefore, if you want to guarantee your vote counts:

- **Delegate before** the snapshot block.
- If your delegation changed at the snapshot block, it is not clear which prevails — to be safe, change 1 block earlier.

## Aggregating delegations from many holders

Common DAO pattern: forming "delegation pools" where a delegate acts for many holders. In web3community there are no specific on-chain tools for that in v1 — each delegation is 1-to-1 via `delegate(target)`. Pools can be built off-chain or by ecosystem contracts, but v1 does not provide them.

## Edge case: delegation to dead address

```solidity
gov.delegate(address(0));
```

Works. Removes your delegation — your voting power becomes zero (no one receives). Can be useful if you want to "stop voting" without transferring GOV.

## Event history

Useful events for indexing:

```
event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);
```

The first is emitted when you change delegation. The second is emitted each time a delegate has `getVotes` changed (because of you or anyone else delegating to them).

---

**Next →** [Parameters](03-parameters.md)
