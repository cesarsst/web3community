# Proposal lifecycle

**Audience:** anyone wanting to understand the states a proposal passes through.
**Prerequisites:** [Governance (concept)](../02-core-concepts/05-governance.md).

## The 8 possible states

`CommunityGovernor.state(proposalId)` returns one of the `ProposalState` enum values (defined in OZ's `Governor`):

```
0  Pending       - created, waiting for votingDelay
1  Active        - voting window open
2  Canceled      - canceled by proposer or governance cancellation
3  Defeated      - voting closed without reaching quorum or with Against > For
4  Succeeded     - quorum + For > Against; can be queued
5  Queued        - queued in the Timelock; waiting minDelay
6  Expired       - queued but not executed in reasonable time
7  Executed      - all calls executed successfully
```

## Transitions

```
                     Someone calls propose(...)
                                   |
                                   v
                           +---------------+
                           |    Pending    |   (votingDelay blocks)
                           +-------+-------+
                                   | after votingDelay
                                   v
                           +---------------+
                           |    Active     |   (votingPeriod blocks)
                           +-------+-------+
                                   |
                               end of voting
                                   |
                +------------------+------------------+
                | For > Against &  |   For <= Against |
                | quorum reached   |   OR no quorum   |
                v                  v                  v
         +-------------+    +-------------+    +------------+
         |  Succeeded  |    |  Defeated   |    |  Canceled  |
         +------+------+    +-------------+    +------------+
                |                   (someone canceled before
                | queue(...)         the period ended)
                v
         +-------------+
         |   Queued    |  (timelockMinDelay seconds)
         +------+------+
                |
                | after minDelay
                |  - if not executed in timely window: Expired
                |  - if executed: Executed
                v
         +-------------+
         |  Executed   |
         +-------------+
```

## Typical total time in production

With production parameters:

| Phase | Duration |
|---|---|
| Pending (`votingDelay`) | 7200 blocks (~1 day) |
| Active (`votingPeriod`) | 50400 blocks (~7 days) |
| Queued (`timelockMinDelay`) | 172800 seconds (2 days) |
| **Total (happy path)** | **~10 days** |

Proposing a proposal today and seeing it executed takes at least 10 days. This is the **intentional price** of security.

## How to propose

```solidity
governor.propose(
    address[] memory targets,       // target contracts
    uint256[] memory values,         // ETH to send in each call (typically zero)
    bytes[] memory calldatas,        // calls' calldatas
    string memory description        // markdown text
);
```

Returns `proposalId` (hash of the 4 parameters).

**Prerequisites**:

- `msg.sender` has voting power >= `proposalThreshold` (10,000 GOV in production, via `getVotes(msg.sender)`).
- Arrays have the same length.
- Non-empty description.

**Common errors**:

- `GovernorInsufficientProposerVotes` — insufficient voting power.
- `GovernorInvalidProposalLength` — arrays with different sizes.

## Vote

During `Active`:

```solidity
governor.castVote(proposalId, support);
// support: 0 = Against, 1 = For, 2 = Abstain
```

Variants (with reason, with off-chain signature for gasless):

- `castVoteWithReason(proposalId, support, reason)`
- `castVoteBySig(proposalId, support, v, r, s)`
- `castVoteWithReasonAndParamsBySig(...)`

Your voting power is `gov.getPastVotes(you, proposalSnapshot)`. If zero at the snapshot, you do not effectively vote (emits event but does not count).

## Queue

After `Succeeded`:

```solidity
governor.queue(proposalId);
```

Anyone can call. Schedules execution in the Timelock.

## Execute

After `Queued` and past `timelockMinDelay`:

```solidity
governor.execute(proposalId);
// or variant with targets/values/calldatas/descriptionHash
```

Anyone can call. Executes calls against the targets via Timelock.

In `CommunityTimelock`, `EXECUTOR_ROLE` is `address(0)` — any address can execute, because the delay already was the real gate.

## Cancel

### By proposer (their own)

```solidity
governor.cancel(targets, values, calldatas, descriptionHash);
```

Works during `Pending` or `Active`. After `Succeeded`, the proposer **cannot** cancel directly — would need a counter-proposal.

### By governance

A cancel via proposal can be submitted. Executes via Timelock calling `_cancel` in the Governor / `cancel` in the Timelock.

## Batch proposals

A single proposal can include **N calls**. Useful when actions are related and must be atomic. Example:

```
targets   = [registry, registry, burnTracker]
calldatas = [
    registry.registerProject.encode(ownerAddr, "ipfs://...", 10_000e18),
    registry.activateProject.encode(nextId),
    burnTracker.grantRole.encode(RECORDER_ROLE, appContract)
]
```

The 3 calls are either all executed or none (if any reverts, the whole tx reverts).

## Events

```
event ProposalCreated(
    uint256 proposalId,
    address proposer,
    address[] targets,
    uint256[] values,
    string[] signatures,
    bytes[] calldatas,
    uint256 voteStart,
    uint256 voteEnd,
    string description
);

event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason);
event ProposalQueued(uint256 proposalId, uint256 etaSeconds);
event ProposalExecuted(uint256 proposalId);
event ProposalCanceled(uint256 proposalId);
```

For UI/indexer, all these events have `proposalId` as the key field.

## Full example flow

```
1. Alice (with >= 10k GOV delegated) calls governor.propose(...)
   -> ProposalCreated event
   -> state = Pending

2. After 7200 blocks (~1 day):
   -> state = Active

3. Holders vote during 50400 blocks (~7 days):
   governor.castVote(id, 1)  // For
   governor.castVote(id, 0)  // Against
   ...
   -> VoteCast events

4. After 50400 blocks:
   If For > Against && quorum reached:
     -> state = Succeeded
   Otherwise:
     -> state = Defeated (terminal)

5. Anyone calls governor.queue(id)
   -> Timelock.schedule(...)
   -> ProposalQueued event with etaSeconds
   -> state = Queued

6. After 172800 seconds (2 days):
   Anyone calls governor.execute(id)
   -> Timelock.executeBatch(...)
   -> target calls are executed
   -> ProposalExecuted event
   -> state = Executed (terminal)
```

## Edge cases

### `Succeeded` but no one to call `queue`

The proposal **does not turn** `Expired` automatically in `Succeeded` — it expires only after `Queued`. It stays `Succeeded` waiting for queue. Any holder can call.

### Pending operation in the Timelock expires

If someone calls `queue` but nobody calls `execute` within `GRACE_PERIOD` (OZ TimelockController default), the operation is expired. The Governor reflects it with `state = Expired`.

### `queue` called twice

The second call reverts — the operation is already in the Timelock.

### Proposal with `targets = []`

Reverts with `GovernorInvalidProposalLength`. Proposals without calls make no sense.

## How to scrutinize a proposal before voting

1. Read the `description` (human text).
2. Decode each `calldatas[i]` against the ABI of `targets[i]`. Confirm that parameters are what the description says.
3. Confirm that `values[i] == 0` (almost always; if not, find out why ETH is being spent).
4. If it changes a parameter: is it within the bounds? See [Parameters](03-parameters.md).
5. If it moves funds: how much? where? is there justification?

---

**Next →** [Voting power](02-voting-power.md)
