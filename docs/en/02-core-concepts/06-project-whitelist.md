# Project whitelist

**Audience:** devs who want to list an app, stakers who want to understand what they are allocating to.
**Prerequisites:** [Governance](05-governance.md).

## Why a whitelist

The protocol shares an economic engine: usage in listed apps generates burn, which generates emission, which goes to stakers. If **anyone** could include themselves as a project and call `burnAndRecord`, the model would collapse — an attacker burns CREDIT volume that they themselves minted in another app and captures rewards.

The whitelist places an economic barrier (GOV collateral) and a political one (going through a proposal) before a new app receives `RECORDER_ROLE`. It is the first line of defense against app sybil.

## The 4 states of a project

```
      registerProject          activateProject        setProbation      reactivate
   Pending ------------>  Active ------------------>  Probation --------->  Active ...
                                                          |
                                                          | removeProject
                                                          v
                                                       Removed (terminal)
```

Valid transitions (defined in `ProjectRegistry` enum `Status`):

- `Pending` → `Active` (via `activateProject`, governance-gated)
- `Active` → `Probation` (via `setProbation`, governance-gated)
- `Active` → `Removed` (via `removeProject`, governance-gated)
- `Probation` → `Active` (via `reactivate`, governance-gated)
- `Probation` → `Removed` (via `removeProject`)
- `Removed` → **nothing** (terminal)

## Pending — project registered but not operational

After `registerProject`:

- GOV collateral was pulled from `owner` to the Registry.
- `metadataURI` was recorded.
- `activatedAt` = 0, `probationEndsAt` = 0.
- Stake and payments do **not** work (`isActive` returns false).
- Owner can update metadata.

Purpose: window between proposal approval and actual activation. Gives time for final checks.

## Active — operational project

After `activateProject`:

- `activatedAt = block.timestamp`.
- `probationEndsAt = activatedAt + probationDuration` (30 days in production).
- `isActive(projectId)` = true.
- Stake, payments, and `burnAndRecord` work.
- **During the initial probation window**, `isInProbation(projectId)` = true and reward share is divided by 4.

After `probationEndsAt`, the penalty automatically vanishes. No additional action is needed.

## Probation (punitive) — suspended project

Status distinct from initial time-based probation. Governance moves an `Active` project to `Probation` to suspend operation for misconduct (without removing the collateral).

- `isActive` returns false.
- New stake blocked (`ProjectNotActive`).
- Payments blocked (`ProjectNotActive`).
- Unstake is **NOT** bypassed — the user only exits when the lock expires normally.
- Past burn records remain — history is history.

From Probation, the DAO can:

- `reactivate(projectId)` → back to `Active`. `activatedAt` and `probationEndsAt` **do not change** (the original anchoring is preserved).
- `removeProject(projectId, slash, treasury)` → terminal.

## Removed — terminal

Only state that bypasses the lock in `Staking.unstake` (because the DAO removed the project, not the staker). Stakers can exit whenever they want.

- `isActive` returns false definitively.
- Stake, payments, every operation blocked.
- Collateral has already been drained:
  - `slash == true` → went to `treasury`.
  - `slash == false` → went to the project's `owner`.
- Pending ownership transfer is canceled.
- `metadataURI` is frozen — no more updates.

## Collateral — skin in the game

Every project must lock GOV as collateral at `registerProject` time:

- In production, `minCollateral = 10,000 GOV` (adjustable via governance).
- The collateral is custodied **inside the Registry** — not in the Treasury, not with the owner.
- It is only released via `removeProject`:
  - Without slash (project leaves on good terms): goes to the `owner`.
  - With slash (misconduct): goes to the `treasury`.
- **No topup or partial withdraw in v1**. If the minimum collateral increases, existing projects stay with the old collateral (grandfathered) — the change only affects new registrations.

The collateral serves three purposes:

1. **Entry cost**: disincentivizes listing garbage apps.
2. **Anti-sybil**: 10k GOV is ~0.01% of cap, a non-trivial amount.
3. **Slash mechanism**: if the app proves fraudulent, the DAO burns the collateral (via slash).

## Off-chain metadata

The Registry stores a `metadataURI` (IPFS/Arweave). The exact content is off-chain but conventionally contains:

- Readable project name.
- Description.
- Icon.
- App contract addresses (if applicable).
- Website, docs, contact links.

Owner updates via `updateMetadata(projectId, metadataURI)`. Does not require a proposal — it is operational. The only exception is post-`Removed`, where the URI freezes.

## Ownership transfer (2-step)

The owner of a project can transfer to another address via a 2-step process (analogous to `Ownable2Step`):

1. `transferProjectOwnership(projectId, newOwner)` — current owner proposes transfer.
2. `acceptProjectOwnership(projectId)` — `newOwner` accepts explicitly.

Until acceptance, the pendingOwner **has no power**. This protects against accidental transfer to a wrong or unreachable address.

### Checklist when receiving project ownership

Before calling `acceptProjectOwnership`, the `newOwner` should audit the project state so as not to inherit malicious configuration from the previous owner. Specifically:

1. **Audit `feeRouter.appRecipient(projectId)`.** `setAppRecipient` is **owner-gated** (not governance-gated) — the current owner can set any address **before** initiating the transfer. If the previous owner sets `appRecipient` to a malicious address before calling `transferProjectOwnership`, the new owner inherits the recipient upon acceptance and **the entire 5% rebate** will land on the malicious address until the new owner runs `setAppRecipient(projectId, <legitimate address>)` or `setAppRecipient(projectId, address(0))` (reset to dynamic lookup that follows the Registry owner).
2. **Audit `feeRouter.hasProjectSplit(projectId)` and `feeRouter.getProjectSplit(projectId)`.** The per-project split override is only adjustable via `GOVERNANCE_ROLE`, so it is not a direct owner vector — but worth confirming the split matches what was negotiated.
3. **Audit `registry.getProject(projectId).status`.** Accepting ownership of a punitive `Probation` project means accepting that stake and payments are blocked until the DAO `reactivate` or `removeProject`.
4. **Audit `registry.getProject(projectId).collateral`.** Confirm that the GOV collateral custodied by the Registry matches the expected amount — in `removeProject(slash=false)` that value goes to the `owner` (i.e., you).

Best practice: run `setAppRecipient(projectId, address(0))` immediately after `acceptProjectOwnership` — it resets to dynamic lookup (which follows `registry.getProject(...).owner`), neutralizing any inherited recipient. Then, if you want to direct to an operational multisig, set it explicitly.

## Consequences in the rest of the system

Direct dependencies on project status:

- **`Staking.stake` / `increaseStake`**: requires `Active`.
- **`Staking.unstake`**: only bypasses lock if `Removed`.
- **`BurnTracker.burnAndRecord`**: requires `Active`. If the project moves to `Probation` after a burn, the historical burn is **not reverted**.
- **`FeeRouter.pay`**: requires `Active`.
- **`RewardDistributor._calculateClaim`**: `/ 4` penalty if `isInProbation(projectId)` at claim time.

---

**Next →** [Treasury and fees](07-treasury-and-fees.md)
