# Security model

**Audience:** auditors, offensive security, researchers.
**Prerequisites:** general knowledge of the architecture.

This document consolidates invariants, identified attack surfaces, and mitigations implemented in the 12 contracts.

## Global invariants

### I1 — GOV cap

**Statement**: `GovernanceToken.totalSupply() <= CAP_SUPPLY = 100_000_000 * 1e18` at all times.

**Where it is enforced**: `GovernanceToken._update`. For mint (from == 0), checks `totalSupply + value <= CAP_SUPPLY`, otherwise reverts `CapExceeded`.

**Related**: `_maxSupply()` overridden to return CAP_SUPPLY, ensuring internal ERC20Votes checks (uint208) also respect it.

### I2 — Burn on consumption

**Statement**: every CREDIT consumed in payments is burned via native `_burn`, decrementing `totalSupply`. No path of `FeeRouter.pay` with `burnBps > 0` diverts to dead-address, treasury, or remint.

**Where it is enforced**:

- `FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole`.
- `CreditToken.burnByRole` uses native `_burn` from ERC-20.

**Validation**: integration test validates exact decrement in `totalSupply` for each `burned`.

### I3 — Per-round cap

**Statement**: CREDIT emission per round never exceeds `capMax`. Burn per project per round never exceeds `maxBurnPerRoundPerProject` (if > 0).

**Where it is enforced**:

- `RewardDistributor.finalizeRound`: `totalEmission = min(rawEmission, capMax)`.
- `BurnTracker.burnAndRecord`: reverts `SanityCapExceeded` if accumulated + amount > cap.

### I4 — Governance-only exit

**Statement**: every state-changing function that moves funds (Treasury, Staking, etc.) or changes economic parameters requires `GOVERNANCE_ROLE` (or Ownable2Step on GOV). No EOA retains unilateral power post-handoff.

**Where it is enforced**:

- Setters in economic contracts have `onlyRole(GOVERNANCE_ROLE)`.
- `GovernanceToken.mint` is `onlyOwner` (Ownable2Step).
- `TeamVesting.revoke` is `onlyOwner`.
- `DEFAULT_ADMIN_ROLE` was transferred to Timelock at deploy.

### I5 — Anti-flashloan on vote

**Statement**: flash-loan of GOV at the voting block confers no voting power. Flash-stake at the `finalizeRound` block does not enter the share computation.

**Where it is enforced**:

- `Governor.castVote` reads `GovernanceToken.getPastVotes(account, proposalSnapshot)`.
- `RewardDistributor._calculateClaim` reads `Staking.getWeightAt(user, projectId, snapshotBlock)`.
- `snapshotBlock` is written in a block prior to the one queried.

### I6 — Minimum lock

**Statement**: stake with lock below 14 days reverts. Unstake before the lock in a non-Removed project reverts.

**Where it is enforced**:

- `Staking.stake` / `increaseStake` (indirectly) reverts with `LockTooShort`.
- `Staking.unstake` reverts with `LockNotExpired` if `block.timestamp < unlockAt` and project non-Removed.

### I7 — Projects via governance

**Statement**: no project enters `Active` without going through `GOVERNANCE_ROLE` (Timelock). Project-dependent operations (`FeeRouter.pay`, `BurnTracker.burnAndRecord`, `Staking.stake`) verify `isActive` beforehand.

**Where it is enforced**:

- `ProjectRegistry.registerProject` and `activateProject` are `onlyRole(GOVERNANCE_ROLE)`.
- Callers check `isActive` and revert with `ProjectNotActive`.

## Attack surfaces and mitigations

### Reentrancy

**Vector**: custom ERC-20 with callbacks (legacy ERC-777, malicious tokens) able to re-enter `transfer` / `approve`.

**Mitigation**: `ReentrancyGuard` in every function that moves value. Plus strict CEI — effects before interactions.

**Guarded contracts**:

- `Treasury.transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH`.
- `Staking.stake`, `increaseStake`, `extendLock`, `unstake`, `unstakeAll`.
- `BurnTracker.burnAndRecord`.
- `RewardDistributor.claim`, `claimMany`.
- `FeeRouter.pay`.
- `UserSubsidy.claim`, `closeCampaign`.

### Integer overflow / underflow

**Vector**: floating-point precisions in weight, share, emission computations.

**Mitigation**:

- Solidity 0.8.24 — checked arithmetic by default.
- Explicit `SafeCast` in conversions that may lose bits.
- Operation order: multiply before divide (preserve precision).
- Analytic bounds documented in the contracts (e.g., max weight in `Staking` fits uint208 with margin).

### Denial of Service via loops

**Vector**: functions with loops over caller-controlled arrays.

**Mitigation**:

- `Treasury.batchTransfer` / `payRebates`: external arrays, but issuer is governance (Timelock) — no practical attack.
- `RewardDistributor.claimMany`: external arrays, but caller pays the gas.
- No iteration over "all projects" or "all stakers" on-chain path.

### Front-running

**Vector**: attacker observes mempool, submits tx with higher gas to capture value.

**Mitigation**:

- Governance with `votingDelay` of ~1d — direct FR of vote does not work (vote via past snapshot).
- `finalizeRound` is permissionless but idempotent — FR brings no advantage (anyone can finalize, result is the same).
- `FeeRouter.pay` is not FR-attackable — `user` and `amount` are fixed, split is deterministic.

### Sanity cap / economic cap attacks

**Vector**: malicious project inflates burn to capture share.

**Mitigation**:

- Sanity cap per `(round, project)` — `SanityCapExceeded` if exceeded.
- `capMax` global on emission — clamps even with absurd burn.
- Probation penalty of 25% on new projects (first 30 days).

### Attacks via reusable collateral

**Vector**: project owner tries to reuse collateral for multiple listings.

**Mitigation**: each `registerProject` requires separate collateral pulled via `transferFrom`. Balances are custodied per project in the Registry.

### Attacks via ownership transfer

**Vector**: accidental or malicious ownership transfer (GOV, project, vesting).

**Mitigation**: `Ownable2Step` on GovernanceToken and TeamVesting; own 2-step in ProjectRegistry.transferProjectOwnership. `newOwner` must explicitly accept.

### Attacks via lost token recovery

**Vector**: tokens sent to wrong contracts (e.g., ERC-20 to `Staking` instead of `stake`).

**Mitigation**: **none in v1**. Conscious decision — adding `rescueTokens` would create a governance-accessible backdoor. Lost tokens stay lost (and the cost educates users). In case of significant loss, the DAO can vote migration.

### Attacks via upgrade

**Vector**: upgradeable contract with proxy can be maliciously swapped.

**Mitigation**: **contracts are not upgradeable**. No proxy. Any replacement requires new deploy + proposal to migrate roles/ownership.

### Attacks via time / timestamp

**Vector**: miners/sequencers manipulate `block.timestamp`.

**Mitigation**:

- Lock, probation, and vesting depend on timestamps — ±15s manipulation is irrelevant for day/week windows.
- Governance uses `block.number` (clock), not timestamp — more resistant.

### Attacks via signature replay

**Vector**: EIP-712 signatures replayed in another contract / chain.

**Mitigation**:

- Domain separator includes `chainId` via OZ `EIP712` base.
- `nonces` in `ERC20Permit` and `ERC20Votes` invalidate reuse.
- Governor `castVoteBySig` uses its own nonce.

## Threat model

### External attacker without GOV

- Cannot propose (threshold = 10k GOV delegated).
- Can call `FeeRouter.pay` (if holds CREDIT and approve) — expected behavior.
- Can call `finalizeRound` — expected behavior.
- Can call `claim` — only receives if has weight in `(user, projectId)` at snapshot.
- Can send ETH to Treasury — donation.

**Practical attack**: none direct.

### Attacker with GOV but below threshold

- Can vote on proposals (if delegated).
- Can stake in projects.
- Can `delegate` to someone else.

**Practical attack**: coordination with other holders — normal governance behavior.

### Attacker with GOV above threshold (~10k)

- Can propose parameter changes within bounds.
- Can propose project registrations (if they have approved collateral).
- Proposal still needs quorum (4% of supply) + For > Against.

**Practical attack**: proposal spam — costs submission gas + social/political pressure.

### Attacker with > 4% of supply

- Can reach quorum alone if 100% of the rest vote against or abstain.
- Still needs For > Against — other holders can block.

**Mitigation**: broad GOV distribution at bootstrap (no single holder > 25%).

### Attacker with > 50% of supply (governance capture)

- Can approve any proposal within on-chain bounds.
- **Cannot** break immutable invariants (cap, MIN_LOCK, parameter bounds).
- **Cannot** drain funds from stakers with active lock.

**Residual mitigation**: Timelock delay gives 2 days for non-attacker holders to respond (exit position, coordinate counter-proposal, yell publicly).

## Static audit

Slither 0.11.5 run on all contracts. Results saved in `audit/slither/`:

- `<Contract>.txt` — full version (includes warnings in OZ libs).
- `<Contract>-projectonly.txt` — filtered to project code only.

Status at the time of this doc: **zero high/medium findings** in project code. Low/informational findings documented and accepted.

## Test suite

- Total: 462+ tests.
- Coverage: 100% statements, 99.84% lines.
- End-to-end integration tests in `test/ignition/Dao.test.ts`.
- Economic simulation in `scripts/simulation/` — 52 rounds × 3 scenarios (base, growth, death spiral).

## Incident runbook

If a bug is discovered post-mainnet:

1. **Critical severity (funds at risk)**:
   - Inform multisig signatories.
   - Prepare emergency proposal (even though delays are painful — there is no pause button).
   - Communicate publicly via official channels.
   - If dependent contracts allow mitigation (e.g., revoke role of compromised contract), fast proposal.
   - Critical bug bounty payable post-confirmation.

2. **Medium severity**:
   - Proposal via regular governance (~10 days).
   - Public documentation + changelog.

3. **Low severity**:
   - Tracking issue in repo.
   - Fix in next deploy (if any) or documented as accepted.

---

See [Risk and security (investor view)](../06-for-investors/03-risk-and-security.md) for a less technical approach to the same topics.
