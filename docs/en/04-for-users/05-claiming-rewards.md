# Claiming rev-share (and legacy claims)

**Audience:** investor waiting to withdraw the revenue they accrued — and old stakers with pending emission claims.
**Prerequisites:** [Staking in projects](03-staking-in-projects.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

> **Remodel 2026-07-08**: the current income is the **rev-share** from [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md), withdrawn in the hub's **Invest** tab. Emission claiming (`RewardDistributor` V1/V2) is **legacy** — historical claims remain withdrawable, but there is no new emission. Both journeys are on this page.

## Claiming rev-share (current model)

### What must have happened before

1. You invested CREDIT in a round that hit its target (`Funded`) — with GOV staked in the project.
2. The app received payments via `FeeRouterV2.pay` — each one accrues your slice automatically.
3. You **keep** GOV staked in the project (the `claim` gate).

### Finding what you can withdraw

```solidity
uint256 pending = funding.pendingRevenue(projectId, you);
```

No side effects — use freely in the UI (Invest tab).

### Withdrawing

```solidity
uint256 amount = funding.claim(projectId);
```

- Reverts `NoGovStaked` if you no longer have GOV staked in the project — the value is **not lost**, it is held until you re-stake.
- Reverts `NothingToClaim` if there is no pending revenue.
- **Never expires.** No deadline, no window.

What you receive is **stable** CREDIT (redeemable 1:1 for USDC in the PSM) that came from the app's real revenue — not from emission.

### Failed round — refund

If the round expired without hitting the target, the path is different: `funding.refund(projectId)` returns 100% of what you invested.

---

## Emission claims (LEGACY)

> ⚠️ **LEGACY** — the rest of this page describes claiming on the pre-remodel emission rail (`RewardDistributor` V1/V2). Historical rights persist (no deadline), but new rounds generate no emission.

## What must have happened before

Preconditions for you to be able to claim from round R-1:

1. You had a staked position in `(user, projectId)` at the snapshot block (set in `finalizeRound(R-1)`).
2. Governance called `BurnTracker.closeRound()` closing round R-1 (currentRound became R).
3. Someone — could be you — called `RewardDistributor.finalizeRound(R-1)`.
4. You have **not** yet claimed that `(R-1, projectId)` combination.

## Finding what you can claim

### Preview

```solidity
uint256 amount = rewardDistributor.previewClaim(you, round, projectId);
```

Returns the amount that would be minted **if you called `claim` now**. Zero if:

- Round not finalized.
- Already claimed.
- Your weight was zero at the snapshot.
- Project generated no burn and global weight is zero (bootstrap edge case).

No side effects — use freely in the UI.

### Check claim status

```solidity
bool alreadyClaimed = rewardDistributor.claimed(round, projectId, you);
```

## Claiming a round

```solidity
uint256 amount = rewardDistributor.claim(round, projectId);
```

Internal steps:

1. Checks `roundData[round].finalized` — reverts `RoundNotFinalized` if false.
2. Checks `claimed[round][projectId][you]` — reverts `AlreadyClaimed` if true.
3. Computes `amount`.
4. If `amount > 0`:
   - Marks `claimed[...][you] = true`.
   - Emits `Claimed`.
   - Calls `CREDIT.mint(you, amount, "rewardRound")`.
5. If `amount == 0`: does not mark claimed, does not mint, returns 0 (silent no-op).

This `amount == 0` no-op semantics is intentional — if for some reason the computation returned 0 but can change, you do not "burn" the claim slot.

## Claiming in batch

More efficient if you have multiple rounds or multiple projects:

```solidity
uint256[] memory rounds     = [5, 5, 6, 6, 7];
uint256[] memory projectIds = [42, 17, 42, 17, 42];

uint256 total = rewardDistributor.claimMany(rounds, projectIds);
```

**Parallel** arrays — `rounds[i]` pairs with `projectIds[i]`. Must have the same length (otherwise `ArrayLengthMismatch`) and cannot be empty (otherwise `EmptyBatch`).

Effect: a single tx mints `total` CREDIT, executing N individual claims.

## When you lose a claim

You do **not** lose claim by time — there is no deadline. The only ways to lose are:

- **Not staking before the round's snapshot**. Staking afterwards does not generate retroactive weight.
- **Unstaking before the snapshot**. After the snapshot you can unstake without affecting that round's claim.
- **The project not generating burn nor having enough weight** during the rounds in which you staked.

But once your weight was recorded at the snapshot and the round was finalized, you have a permanent right to claim.

## Typical UI workflow

1. Connect wallet at the hub.
2. Go to "My Rewards".
3. The app loads all finalized rounds since your first stake.
4. For each round × project where you staked and have not claimed, it shows the preview.
5. You select which to claim.
6. The app builds a single `claimMany` tx with the selected pairs.
7. You sign, pay gas, receive CREDIT.

## Gas

- Single `claim`: ~180-220k gas (mint + event).
- `claimMany` with N pairs: ~180k + ~140k × N.

Batch is significantly more efficient than N individual txs. Use it when possible.

## What you receive

CREDIT. Fungible, standard ERC-20. You can:

- Spend in ecosystem apps.
- Sell on external DEX (if there is liquidity).
- Hold (exposure to appreciation if supply keeps dropping).
- Reuse (buy more GOV on DEX to stake more — "re-stake" is not automatic in v1).

There is no **auto-compound**. There is no **auto-claim**. If you forget, CREDIT is not minted — it only exists when you request it.

## Edge cases

### Round 0 — no prior burn

In round 0, `burn_{-1}` is treated as 0. Emission comes from the floor (`floorSchedule[0]`). Per-project shares are computed via **global weight** (`staking.getGlobalWeightAt`).

Therefore, if you staked right at the start and global weight is only yours, you capture a large slice. That is the incentive for being early.

### Bootstrap without stake

If a round finalizes and `globalWeight == 0` at the snapshot, no claim works — `_projectShare` returns 0 in every case on the bootstrap path. Emission is computed but **not minted** (nobody to distribute to). CREDIT supply does not change in that round.

### Initial probation during claim

`RewardDistributor._calculateClaim` reads `REGISTRY.isInProbation(projectId)` **at claim time**, not at finalize time. If initial probation ended between finalize and claim, you receive the full share (probation is time-based; `probationEndsAt` is set at activation and does not change).

### Project becomes `Removed` between finalize and claim

Your right to claim persists — `roundData` is immutable after finalize. You can claim even with the project removed. Plus, you can unstake immediately (lock bypass) if you still have a position.

---

**Next →** [Integration overview (devs)](../05-for-developers/01-integration-overview.md)
