# Integration overview

**Audience:** dev who wants to list an app in the ecosystem and accept CREDIT as payment.
**Prerequisites:** [Architecture](../03-protocol-overview/01-architecture.md), [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md).

> **Remodel 2026-07-08**: the current payment integration is via [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) — **new** signature: `pay(projectId, amount)` (the payer is `msg.sender`; the `user` parameter no longer exists). Payment validation is via the `PaymentRouted` event. FeeRouter V1 is legacy.

## The contract you need to know

To accept payments in CREDIT, you will interact with **one** main contract:

- [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) — function `pay(projectId, amount)`.

Everything else (fee, rev-share, project status, volume metrics) is handled automatically inside it.

## The full integration cycle

```
1. Develop your app (outside the protocol — any stack)
   The app's logic knows: "service X costs N CREDIT"

2. Register the project via proposal (requires 10,000 GOV as collateral)
   Result: projectId assigned (e.g., 42)

3. After activation, the user pays by calling FeeRouterV2.pay(projectId, amount)
   (with the user's own prior approve — the payer is msg.sender)

4. Your backend validates the payment via the PaymentRouted event

5. (Optional) Open a funding round in ProjectFunding
   (upfront capital in exchange for 1-30% rev-share of gross revenue)

6. Monitor events and metrics (grossVolumeOf = on-chain GMV)
```

## What the app calls

From your app's frontend point of view, the flow is:

```solidity
// Step 1 (off-chain): your app's UI shows the price to the user
// Step 2: UI asks for approve (signed by the user)
IERC20(creditToken).approve(feeRouterV2, amount);

// Step 3: the user calls pay — the payer is msg.sender
feeRouterV2.pay(projectId, amount);

// Step 4: backend validates via the PaymentRouted event (see below)
// Step 5: app delivers the service to the user
```

**Key difference from V1**: the signature is `pay(projectId, amount)` — the payer is always `msg.sender`. There is no `user` parameter anymore, so **whoever signs the tx is who pays**. Gas sponsorship/meta-tx flows require the user's smart wallet to be the `msg.sender` (e.g., ERC-4337), not an arbitrary relayer with someone else's allowance.

For a breakdown preview in the UI (no side effects):

```solidity
(uint256 fee, uint256 revShare, uint256 toApp) =
    feeRouterV2.previewPay(projectId, amount);
```

## Validating the payment — `PaymentRouted` event

The canonical way for the backend to confirm a payment is watching the event:

```solidity
event PaymentRouted(
    uint256 indexed projectId,
    address indexed payer,
    uint256 amount,
    uint256 feeToTreasury,
    uint256 feeToBuyback,
    uint256 feeToGrants,
    uint256 revShare,
    uint256 toApp
);
```

Recommended pattern: the backend receives the `txHash` from the frontend, fetches the receipt, decodes the `PaymentRouted`, and checks `projectId`, `payer` (the wallet linked to the user), and `amount` (≥ service price). The `@cesarsst/web3community-sdk` SDK implements this flow (`payActivation`/`verifyActivationPayment`).

## How much the app receives

With the default fee of **2.5%** (250 bps; hard cap 500):

- **Without a funding round**: **97.5%** of every payment, in the `appRecipient` wallet, in the same block.
- **With a funded round** (e.g., 8% rev-share): **~89.5%** — fee and rev-share are deducted atomically in `pay`.

No burn, no waiting for rounds: revenue is immediate. Additional upfront capital can come from a round in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) (target ≥ `minTarget`, rev-share 1-30%, 1-90 day duration, all-or-nothing). Breakdown in [Value flow](../03-protocol-overview/03-economic-flows.md).

## Events you want to monitor

From `FeeRouterV2`:

- `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)` — every payment of your project (validation + analytics).
- `AppRecipientUpdated(projectId, recipient)` — recipient rotation.

From `ProjectFunding` (if you opened a round):

- `RoundOpened` / `Invested` / `RoundFunded` / `RoundFailed` — funding lifecycle.
- `RevenueNotified(projectId, amount)` — rev-share accounted on each payment.

> **Legacy**: the `Paid` (FeeRouter V1), `BurnRecorded`/`RoundClosed` (BurnTracker) and `RoundFinalized`/`Claimed` (RewardDistributor) events belong to the old rail — only relevant for historical data.

## Configuring the payment destination

By default, `toApp` goes to `ProjectRegistry.getProject(projectId).owner`. If you want to direct it to another address (e.g., an app-internal distribution contract, an operational multisig, etc.):

```solidity
// Callable by the current owner of the project
feeRouterV2.setAppRecipient(projectId, newRecipient);
```

This function is **owner-gated**, not governance-gated — operational rotation does not require a proposal.

## Quotas and limits

- **Project must be `Active`**. If it becomes (punitive) `Probation` or `Removed`, `pay` reverts with `ProjectNotActive`.
- **No volume sanity cap** in V2 — `grossVolumeOf` just accumulates. (The per-round burn cap was part of the legacy rail.)

## Testing

Local development via Hardhat + Ignition (see [Local environment](05-local-dev.md)).

For Sepolia testnet, the protocol team provides addresses after deploy. Your UI points to those addresses using the appropriate config.

## What the app does **not** need to do

- **Do not** call `ProjectFunding.notifyRevenue` — only FeeRouterV2 holds `REVENUE_NOTIFIER_ROLE`; the rev-share is routed automatically on each `pay`.
- **No need** to worry about the splitting (fee/rev-share/app). It is done by `FeeRouterV2` automatically and is auditable in the event.
- **No need** to integrate a DEX for the user to obtain CREDIT — point them to the PSM (`CreditPSM.buy`, 1:1 with USDC, no fee).

## Security

Your app should:

- Validate the payment via the `PaymentRouted` event (checking `projectId`, `payer` and `amount`) before releasing the service — do not trust only a frontend callback.
- Treat `ProjectNotActive` as an unrecoverable error signal in that tx.
- Remember the payer is `msg.sender` — design the user's wallet flow accordingly.

Your app **does not need to**:

- Hold intermediate CREDIT — `pay` is atomic and the router ends every tx with balance 0.
- Manage infinite allowance — the cleanest UX is approve by amount, not infinite, but it depends on your UX.

---

**Next →** [Contract addresses](02-contract-addresses.md)
