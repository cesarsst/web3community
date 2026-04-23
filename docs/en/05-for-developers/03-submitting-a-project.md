# Submitting a project

**Audience:** dev/team that wants to list a new app in the `ProjectRegistry`.
**Prerequisites:** [Project whitelist](../02-core-concepts/06-project-whitelist.md), [Integration overview](01-integration-overview.md).

## What "listing" means

Listing a project in the web3community Registry is:

1. Registering the pair `(owner, metadataURI)` and locking GOV collateral.
2. Activating the project (transitioning from `Pending` to `Active`).
3. Ensuring that the `FeeRouter` (or the app's future contract) can call `burnAndRecord` — that is, that the app holds `RECORDER_ROLE` where needed.

The result: your app appears in the Registry, accepts payments via `FeeRouter.pay`, and produces traceable burn for the `RewardDistributor`.

## What you need beforehand

- **Defined ownership**: an address (EOA or multisig) that will be the project's `owner`.
- **GOV collateral**: in production, at least `10,000 GOV` (`minCollateral`, adjustable). Read the current value from the Registry.
- **Off-chain metadata**: structured JSON, hosted on IPFS/Arweave. The Registry stores only the URI.
- **Political support**: someone with ≥ 10,000 GOV delegated to submit the proposal.

## Metadata format

Metadata is off-chain. Recommended convention (not enforced on-chain):

```json
{
  "name": "ChatApp",
  "description": "End-to-end encrypted messaging with pay-per-message",
  "icon": "ipfs://Qm...",
  "website": "https://chatapp.example",
  "contracts": {
    "main": "0x...",
    "frontend": "https://app.chatapp.example"
  },
  "contact": {
    "email": "team@chatapp.example",
    "discord": "..."
  },
  "pricing": [
    { "service": "send msg", "costCREDIT": "0.01" }
  ]
}
```

Your UI and explorers can read it. The Registry stores only the `metadataURI` (e.g., `ipfs://Qm...`).

## Full step-by-step

### 1. Prepare metadata

- Upload the JSON to IPFS or Arweave.
- Note the CID / URI.

### 2. Obtain political support

- Find a GOV holder (or aggregate several via delegation) with ≥ `proposalThreshold` (10,000 GOV in production).
- The supporter will be the `proposer` in the Governor.

### 3. Build the proposal

The proposal should include (at minimum):

```solidity
targets   = [address(registry), address(registry)]
values    = [0, 0]
calldatas = [
    abi.encode(registry.registerProject.selector, ownerAddress, metadataURI, collateralAmount),
    abi.encode(registry.activateProject.selector, /* projectId will be assigned dynamically */)
]
```

Problem: the proposal **does not yet know the `projectId`** (it is assigned during `registerProject`). Two strategies:

**Strategy A (two proposals)**:

1. First proposal: `registerProject(owner, metadataURI, collateral)`. After executed, read the assigned `projectId` (via `ProjectRegistered` event).
2. Second proposal: `activateProject(projectId)`.

**Strategy B (single proposal with pre-approve)**:

1. The proposal includes `activateProject` assuming the `projectId` that **will** be assigned (see the current `_nextProjectId` in the Registry). Requires that no other `registerProject` proposal intercalates between proposing and executing — hard to guarantee in theory, but acceptable in practice if registration volume is low.

In both, the proposal should probably also include:

- `burnTracker.grantRole(RECORDER_ROLE, <contract_that_will_call_burnAndRecord>)` — if the app will call it directly. In the v1 bootstrap, `FeeRouter` already holds this role, and apps call `FeeRouter.pay` — so this grant may not be needed.

### 4. Collateral approve

The project's `owner` must have called `GovernanceToken.approve(registry, collateralAmount)` **before** the proposal executes. It can be done at any time during the proposal cycle, but better before to avoid execution failure.

### 5. Voting + execution

- Wait `votingDelay` (~1d in production).
- Voting `votingPeriod` (~7d).
- If it wins: `queue` in the Timelock.
- Wait `minDelay` (2d).
- `execute` — the DAO calls `registerProject` (via Timelock), which pulls the GOV collateral and assigns `projectId`.
- Second similar proposal for `activateProject`.

### 6. Post-activation

After `activateProject`:

- `activatedAt = now`, `probationEndsAt = now + probationDuration` (30d in production).
- `projectId` is `Active`.
- `FeeRouter.pay` works for it.
- Stake is allowed.
- **For 30 days**, rewards share is divided by 4 (initial time-based probation).

After 30 days, initial probation expires automatically.

## Owner operations after listing

Without governance:

- `registry.updateMetadata(projectId, newURI)` — update metadata.
- `registry.transferProjectOwnership(projectId, newOwner)` — start 2-step transfer.
- `registry.acceptProjectOwnership(projectId)` — accept (called by the new owner).
- `feeRouter.setAppRecipient(projectId, recipient)` — set the rebate destination.

Requires governance (proposal + execution):

- Any status change (`setProbation`, `reactivate`, `removeProject`).
- Any split override (`setProjectSplit`, `clearProjectSplit`).
- `burnTracker.revokeRole(RECORDER_ROLE, ...)` — revoke role if needed.

## Total costs

- **GOV collateral**: 10,000 GOV locked until `removeProject`.
- **Proposal gas**: paid by the proposer.
- **Execution gas**: paid by whoever calls `execute` (anyone, 2 days after queue).

Total gas cost: ~300-500k gas per typical proposal.

## Common problems

### Proposal reverts with `InsufficientAllowance`

The project's owner did not approve the Registry, or the allowance is less than `collateralAmount`. Fix: call `GOV.approve(registry, collateralAmount)` before execution.

### Proposal reverts with `InsufficientCollateral`

You passed `collateralAmount < minCollateral`. Query `registry.minCollateral()` for the current value.

### Proposal reverts with `EmptyMetadataURI`

The `metadataURI` string cannot be empty. Pass at least a placeholder CID.

### Proposal does not reach quorum

- Increase engagement off-chain (forum, Discord).
- Increase campaign time — propose again if the first failed.
- Consider delegating voting power to increase total supporting weight.

---

**Next →** [Querying on-chain state](04-querying-state.md)
