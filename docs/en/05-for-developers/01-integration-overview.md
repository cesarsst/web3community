# Integration overview

**Audience:** dev who wants to list an app in the ecosystem and accept CREDIT as payment.
**Prerequisites:** [Architecture](../03-protocol-overview/01-architecture.md), [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md).

## The contract you need to know

To accept payments in CREDIT, you will interact with **one** main contract:

- [`FeeRouter`](../08-contracts-reference/08-FeeRouter.md) — function `pay(projectId, user, amount)`.

Everything else (burn, treasury, rebate, project status) is handled automatically inside it.

## The full integration cycle

```
1. Develop your app (outside the protocol — any stack)
   The app's logic knows: "service X costs N CREDIT"

2. Register the project via proposal (requires 10,000 GOV as collateral)
   Result: projectId assigned (e.g., 42)

3. After activation, your app can call FeeRouter.pay on behalf of the user
   (with the user's prior approve)

4. (Optional) Stake on your own projectId to capture emission via (B)

5. Monitor events and metrics
```

## What the app calls

From your app's backend/contract point of view, the flow is:

```solidity
// Step 1 (off-chain): your app's UI shows the price to the user
// Step 2: UI asks for approve
IERC20(creditToken).approve(feeRouter, amount);

// Step 3: UI/app calls pay (or the user calls directly)
(uint256 burned, uint256 toTreasury, uint256 toApp) =
    feeRouter.pay(projectId, user, amount);

// Step 4: app checks success (via Paid event or return values)
// Step 5: app delivers the service to the user
```

`pay` is **public** — anyone can call it, as long as `user` has `allowance`. That allows:

- **The user themselves** calling `pay` (paying gas themselves).
- **The app** calling `pay` on behalf of the user (gas sponsorship — app pays gas, user only approved beforehand).
- **A relayer / smart wallet** calling `pay` on behalf of the user (meta-tx-like).

The "economic payer" is always `user` (paid via `transferFrom`).

## How much the app receives

Given the default split in production (70% burn, 20% treasury, 10% rebate — `burnBps/treasuryBps/rebateBps = 7000/2000/1000` in `ignition/parameters/production.json`):

- Immediate: **10%** goes to the `appRecipient` (default is the project's `owner` in the Registry).
- Indirectly, via `RewardDistributor` of the next round: **emission share proportional to the project's burn**, which the app can capture if it stakes.

Breakdown of the 3 revenue sources (rebate + stake + retained CREDIT appreciation) in [Value flow](../03-protocol-overview/03-economic-flows.md).

## Warning for claim UIs — always check `previewClaim` first

`RewardDistributor.claim` with `amount == 0` is a **silent no-op in the contract** (does not mark `claimed[round][projectId][user]`), but **spends caller gas** and does not emit `Claimed`. Worse: `claimMany` accepts large arrays with all-zero entries, wasting gas without effect.

If you integrate a claim UI (staker dashboard, consumer app that also shows rewards, etc.), **always call `previewClaim(user, round, projectId)` beforehand** and only allow the tx if the return is `> 0`. This avoids:

- Users paying gas on transactions that do nothing.
- Useless retry loops when users do not understand why nothing changes.
- Light DoS vector where someone submits `claimMany` with 1000 entries all with `amount = 0` — contract accepts, spends caller gas, marks nothing.

```solidity
// UI-recommended pattern:
uint256 preview = distributor.previewClaim(user, round, projectId);
if (preview == 0) return; // do not enable button
// otherwise, enable claim
```

For `claimMany`, filter `(round, projectId)` pairs with `previewClaim > 0` before assembling the arrays.

## Events you want to monitor

From `FeeRouter`:

- `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` — every payment of your project.

From `BurnTracker`:

- `BurnRecorded(round, projectId, from, amount, newTotalForProject)` — your project's burn each round.
- `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)` — to know when a round closes.

From `RewardDistributor`:

- `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)` — when you can start claiming.
- `Claimed(user, round, projectId, amount)` — each claim made by stakers of your project.

## Configuring the rebate destination

By default, the rebate goes to `ProjectRegistry.getProject(projectId).owner`. If you want to direct it to another address (e.g., an app-internal distribution contract, an operational multisig, etc.):

```solidity
// Callable by the current owner of the project
feeRouter.setAppRecipient(projectId, newRecipient);
```

Passing `address(0)` resets to dynamic lookup (goes back to following the Registry owner).

This function is **owner-gated**, not governance-gated — operational rotation does not require a proposal.

## Quotas and limits

- **Sanity cap per round**: in production 10M CREDIT of burn per project per round. If your app explodes in volume in a round, a tx that exceeds the cap reverts with `SanityCapExceeded`. Use off-chain batch scheduling if you expect absurd volume (split across multiple rounds).
- **Project must be `Active`**. If it becomes (punitive) `Probation` or `Removed`, `pay` reverts with `ProjectNotActive`.

## Testing

Local development via Hardhat + Ignition (see [Local environment](05-local-dev.md)).

For Sepolia testnet, the protocol team provides addresses after deploy. Your UI points to those addresses using the appropriate config.

## What the app does **not** need to do

- **Do not** call `BurnTracker.burnAndRecord` directly from your app. `FeeRouter.pay` does it for you. Only `FeeRouter` holds `RECORDER_ROLE` at bootstrap.
- **Do not** call `CreditToken.burnByRole` directly. The official burn path is via `FeeRouter`.
- **No need** to worry about the splitting. It is done by `FeeRouter` automatically.

## Security

Your app should:

- Verify that `user` in the `pay` call is who you expect (do not pass `user = msg.sender` blindly if the flow is meta-tx).
- Trust the return of `pay` — if the tx did not revert, the payment was processed successfully.
- Treat `ProjectNotActive` and `SanityCapExceeded` as unrecoverable error signals in that tx.

Your app **does not need to**:

- Hold intermediate CREDIT — `pay` is atomic.
- Manage infinite allowance — the cleanest UX is approve by amount, not infinite, but it depends on your UX.

---

**Next →** [Contract addresses](02-contract-addresses.md)
