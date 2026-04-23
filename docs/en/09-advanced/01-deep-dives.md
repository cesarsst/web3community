# Deep dives

**Audience:** auditors and devs needing to understand specific architectural decisions in depth.
**Prerequisites:** reading sections 01–08.

This page aggregates non-obvious design decisions that cut across multiple contracts.

## Anti-flashloan in two dimensions

Two dimensions of the protocol are protected against flash-loan manipulation:

### 1. Vote

`GovernanceToken` inherits `ERC20Votes`. Voting power is read via `getPastVotes(account, snapshotBlock)`. When a proposal is created, the Governor records `snapshotBlock = block.number + votingDelay`. Every `castVote` call queries `getPastVotes` at **that** block.

A flash loan takes and repays in the same block. So: the attacker's position at the snapshot block is zero (or prior to the loan).

### 2. Stake weight

`RewardDistributor._calculateClaim` uses `Staking.getWeightAt(user, projectId, snapshotBlock)`, where `snapshotBlock = roundData[round].snapshotBlock` (written in `finalizeRound`).

A flash-stake at the finalize block does not enter — weight is read **after** the push in `Checkpoints.Trace208`. The attacker would need to hold a position for at least one block before, which a flash loan does not allow.

Implementation detail: `Checkpoints.Trace208` uses `uint48` for `block.number` (fits for ~8920 years at 1s/block) and `uint208` for value (max theoretical weight 100M×4=4e26, well below 2^208).

## Atomic burn with `BURNER_ROLE`

### Considered alternatives

**(a) Off-chain event listener**: apps burn CREDIT directly and indexer listens to `Transfer(to=0)` to attribute burn to a project.

Rejected because:
- Depends on trusted indexer.
- No cryptographic on-chain proof of "which project consumed".
- Window between burn and record creates race conditions.

**(b) App records burn without burning**: trusts the app.

Rejected because: trivial double-spend (app would record burn without consuming CREDIT, inflating rewards without deflation).

**(c) Atomic on-chain via `BURNER_ROLE`**: app → `BurnTracker.burnAndRecord` → `CREDIT.burnByRole` without allowance. **Adopted.**

### Why no allowance

Requiring allowance would break UX:

1. User `approve(burnTracker, amount)` — tx 1.
2. App calls `burnAndRecord(projectId, from, amount)` — tx 2.

Two txs. Front-run window between approve and burn. User would sign two things in sequence.

With `burnByRole`:

1. User `approve(feeRouter, amount)` + `feeRouter.pay(projectId, user, amount)` — 2 txs but the first is a single reusable allowance.
2. `FeeRouter.pay` internally triggers `BurnTracker.burnAndRecord`, which calls `CREDIT.burnByRole` without requiring another allowance.

Risk mitigation: `BURNER_ROLE` is only granted via an approved proposal in Governor + Timelock. Revocable at any time.

## Dual probation

Two distinct notions coexist in `ProjectRegistry`:

| Dimension | Initial time-based probation | Punitive probation |
|---|---|---|
| Where it lives | `isInProbation(projectId)` view | `Project.status == Probation` |
| When it applies | Automatic post-activation for `probationDuration` | Governance moves manually |
| `isActive(projectId)` returns | `true` (project is Active) | `false` |
| `isInProbation(projectId)` returns | `true` | `false` (it is strictly "Active within the window") |
| Accepts new stake? | yes | no |
| Accepts payment? | yes | no |
| Accepts burn? | yes | no |
| Bypasses lock on unstake? | no | no (only `Removed` bypasses) |
| Reward share | 25% (penalty /4) | zero (because `isActive = false` → share = 0) |

The 25% penalty is applied in RewardDistributor using `REGISTRY.isInProbation(projectId)` at claim time. Does not apply to the punitive one (which is already blocked by `isActive = false` in stake/pay).

## 95/0/5 split — why 0 to treasury

Design decision: default does **not** capture a slice for the Treasury. Reasons:

- **Preserve burn incentive.** Each cent directed to the Treasury is one cent less burned. The deflationary model depends on maximum possible burn.
- **Treasury has other sources.** Genesis mint (10M CREDIT), slash of removed projects, future buyback, explicit slice in specific projects via `setProjectSplit`.
- **Avoid double capture.** If the default already gave 5% to the Treasury, override proposals would have to "zero" to give anything to the app — worse UX than the inverse.

If in the future the DAO wants to capture directly, it just `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})`. Does not require contract change.

## Dust handling in split

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- captures residue
```

Rounding residue goes to `toApp`. In splits with non-exact division, the app can receive 1-2 wei more than nominal. Acceptable and auditable via `Paid` event.

Alternatives:

- **Round each slice separately**: loses wei. Final sum can be `amount - 3 wei`.
- **Require split to be an exact divisor of `amount`**: generally infeasible.

The current choice preserves `burned + toTreasury + toApp == amount` always.

## Floor decay — 24 immutable entries

`floorSchedule` is `uint256[24] memory` in the `RewardDistributor` constructor. Fixed size:

- **Forces the caller to pass 24 values** (dynamic array would require an additional check).
- **Immutable post-deploy**: no write function exposes change.

In production, linear decay:

```
floor[R] = 400_000e18 - R * (400_000/24 * 1e18)
```

Adjusted for 1e18-precision values:

- `floor[0]  = 400_000.000000000000000000`
- `floor[1]  = 383_333.333333333333333334`  (+ rounding dust)
- ...
- `floor[23] = 16_666.666666666666666682`

Sum is ~5.2M CREDIT — well below the 10M genesis. Not a closed budget, a safety net.

## CEI + ReentrancyGuard — double pattern

Every contract that moves value follows:

1. **CEI** — Checks, Effects, Interactions. Effects before `safeTransfer` / `safeTransferFrom`.
2. **`ReentrancyGuard`** in every state-changing function that moves tokens.

The guard is defense-in-depth:

- If the token is a known ERC-20 (GOV, CREDIT), CEI alone would be enough (no callbacks).
- If the token is arbitrary (Treasury receives any ERC-20), it can have hooks (legacy ERC-777, or custom malicious tokens). The guard shields it.
- Even with "safe" tokens, the guard prevents future regressions introducing callbacks.

Cost: ~2k gas per call on the happy path. Acceptable in operations that cost 100k+.

## Global checkpoints in Staking

`Staking` maintains **three** parallel weight rails:

```
_userWeight[user][projectId]   — per user-project
_projectWeight[projectId]       — aggregate per project
_globalWeightCheckpoints        — global aggregate
```

Each write updates the 3 in O(1):

```solidity
uint256 newProjectWeight = oldProjectWeight - oldUserWeight + newUserWeight;
uint256 newGlobalWeight  = oldGlobalWeight  - oldUserWeight + newUserWeight;
```

Invariant: `globalWeight == SUM(projectWeight[i])` always.

Motivation: `RewardDistributor` in the bootstrap path needs `projectWeight / globalWeight`. Without an O(1) global aggregate, it would need to iterate over N projects on each finalize — infeasible in gas.

## Permissionless `finalizeRound`

Anyone can call. Sequential order: `round == lastFinalizedRound + 1` (or 0 if first).

Why permissionless:

- Unlocking claim does not need governance — it is purely mechanical.
- Gas paid by the caller (~200k gas).
- Any staker has incentive: if it does not finalize, they do not claim.

The sequentiality forces earlier rounds to be processed first. Prevents "skipping" a round with undesirable parameters (alpha/capMax) — if you want to skip, it would be via a proposal changing parameters before that specific finalize.

## Genesis one-shot

`CreditToken.mintGenesis` has a `genesisMinted` flag that prevents re-execution. Why not use `Ownable` + `renounceOwnership`?

- AccessControl is more flexible (multiple roles).
- Genesis is a **single** mint with specific rules. Separating it from operational `mint` (role-based) is clearer.
- Flag is cheap (~20k gas per check after deploy).

## MINTER vs DEFAULT_ADMIN separation in CreditToken

- `DEFAULT_ADMIN_ROLE` can call `mintGenesis` (once) and `grantRole`/`revokeRole`.
- `MINTER_ROLE` can call `mint` (operational, no one-shot flag).

If `DEFAULT_ADMIN` also had `MINTER_ROLE`, the admin could mint at any time. By separating, the admin only mints the genesis; operational inflation is isolated in the economic contract (`RewardDistributor`).

## The bootstrap path if nobody holds GOV

Canonical problem of an ERC20Votes + Timelock DAO:

1. To change state, a proposal is required.
2. To propose, GOV delegated above the threshold is required.
3. To have GOV, someone needs to have minted.
4. But minting is already a state change.

Solution: deploy assigns ownership to the deployer (temporary). Deployer calls initial `mint` and `transferOwnership(timelock)`. Timelock becomes `pendingOwner`. **The first proposal approved on mainnet must be `acceptOwnership()` by the Timelock** — consolidates the transfer.

Critical window: between deploy and acceptOwnership, the deployer can re-mint freely. Mitigation: deployer is an auditable multisig, first proposal prioritized, renunciation planned.

Documented in [Mainnet deployment](02-mainnet-deployment.md).

---

**Next →** [Mainnet deployment](02-mainnet-deployment.md)
