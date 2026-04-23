# Voting on proposals

**Audience:** GOV holder who wants to participate in DAO decisions.
**Prerequisites:** [Holding GOV](02-holding-gov.md), [Governance (concept)](../02-core-concepts/05-governance.md).

## Absolute prerequisite: delegate

Holding GOV does **not** automatically give you voting power. You need to delegate once:

```solidity
GovernanceToken.delegate(yourAddress)
```

Without it, `getVotes(you) == 0` and the Governor does not count your votes. Once delegated, it stays active — GOV transfers auto-update.

If you want to delegate to someone else:

```solidity
GovernanceToken.delegate(delegate_address)
```

The change takes effect in the next block. Already-open proposals are unaffected (they use the earlier snapshot).

## Proposal lifecycle (voter's view)

```
  +-------------+       +-------------+       +-------------+       +-------------+
  |   Pending   | ----> |   Active    | ----> | Succeeded   | ----> |  Queued     |
  | (votingDelay|       |(votingPeriod|       | or Defeated |       | (timelock)  |
  |  ~1 day)    |       | ~7 days)    |       |             |       |             |
  +-------------+       +-------------+       +-------------+       +-------------+
                                                                           |
                                                                           | minDelay 2d
                                                                           v
                                                                    +-------------+
                                                                    |  Executed   |
                                                                    +-------------+

  Alternative states:
  - Canceled: proposer withdrew or governance canceled
  - Expired: proposal was not queued in timely fashion
```

During the `Active` state is when you vote.

## How to vote

Main function on the Governor:

```solidity
function castVote(uint256 proposalId, uint8 support) public returns (uint256);
```

Where `support`:

- `0` — Against
- `1` — For
- `2` — Abstain

Variants:

- `castVoteWithReason(proposalId, support, reason)` — attaches a string reason (indexed in event).
- `castVoteBySig(proposalId, support, v, r, s)` — vote via signature (EIP-712, enables gasless via relayer).
- `castVoteWithReasonAndParamsBySig(...)` — version with reason + params.

## Your voting power

When the proposal opens, the Governor computes a snapshot block. Your vote weight is:

```solidity
uint256 power = GovernanceToken.getPastVotes(you, snapshotBlock);
```

That is: **your GOV balance at the snapshot block, via your delegation at the snapshot block**. If you delegated to yourself, it is your own balance. If you delegated to X, X has the power; you do not vote with that token.

Buying or selling GOV **after** the snapshot does not change the power for that proposal.

## How the proposal is decided

Defined in `GovernorCountingSimple`:

**To win**, the proposal needs:

1. Reach **quorum** — `forVotes + abstainVotes >= quorum(snapshotBlock)`. In production, quorum = 4% of supply at the snapshot.
2. Have more `For` than `Against` — `forVotes > againstVotes`.

If both conditions are true when the window closes → `Succeeded`. Otherwise → `Defeated`.

## After `Succeeded`

Anyone (need not be the proposer) can call:

```solidity
CommunityGovernor.queue(proposalId);       // or
CommunityGovernor.queue(targets, values, calldatas, descriptionHash);
```

This queues the proposal in the Timelock. Now the state is `Queued`. The Timelock schedules execution for `now + minDelay` (2 days in production).

After the delay expires, anyone calls:

```solidity
CommunityGovernor.execute(proposalId);
```

Which executes the actual calls (`targets[].call(calldatas[])`) via the Timelock.

## Cancellation

- The proposer can cancel **their own** proposal while it is `Pending` (voting delay) or `Active` (period).
- Governance can cancel via a counter-proposal (meta-proposal).
- Cancellations post-queue also invalidate the operation in the Timelock (`Timelock.cancel`).

The v1 Timelock does **not** have a separate guardian — there is no unilateral panic button. That is intentional: no actor can cancel proposals alone, because that would be a capture vector.

## Production parameters

| Parameter | Value | Source |
|---|---|---|
| `votingDelay` | 7200 blocks (~1d) | `production.json` |
| `votingPeriod` | 50400 blocks (~7d) | `production.json` |
| `proposalThreshold` | 10,000 GOV | `production.json` |
| `quorumNumerator` | 4 (% of supply) | `production.json` |
| `timelockMinDelay` | 172800 sec (2d) | `production.json` |

All adjustable via proposal (onlyGovernance on the setters). More in [Parameters](../07-governance/03-parameters.md).

## Tutorial: vote step by step

1. **First time:** `GovernanceToken.delegate(you)`. Pay gas once.
2. **Find a proposal:** via hub or indexer (look for `ProposalCreated` event from the Governor).
3. **Read the proposal** — description and `(targets, calldatas)` will say exactly what it does on-chain.
4. **Vote** — `CommunityGovernor.castVote(proposalId, support)`. Or with reason: `castVoteWithReason`.
5. **Wait for it to close.** If it wins, someone calls `queue` (maybe you).
6. **After the Timelock delay** — someone calls `execute`.

## What to check before voting For

- Who proposed (do they have history in the DAO? is it a known entity?).
- What exactly the proposal does — decode `calldatas` against the contracts' ABIs.
- If the proposal changes a parameter: is it within the contracts' bounds? (see [Parameters](../07-governance/03-parameters.md)).
- If the proposal moves funds: where? how much? why?
- What is the off-chain discussion (forum, Discord, etc.)?

## Voting via UI

The frontend hub offers:

- List of open proposals.
- Human-readable decoding of `calldatas`.
- For / Against / Abstain buttons.
- Real-time feedback on voting progress + quorum.
- Buttons for `queue` / `execute` when the time comes.

Nothing stops you from calling contracts directly via your wallet, but the UI is the ergonomic path.

---

**Next →** [Claiming rewards](05-claiming-rewards.md)
