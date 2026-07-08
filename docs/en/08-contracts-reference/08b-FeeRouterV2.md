# FeeRouterV2

**Audience:** devs of apps integrating payments, investors tracking volume, auditors.
**Prerequisites:** [CreditPSM](15-CreditPSM.md), [ProjectFunding](16-ProjectFunding.md).

## Quick view

Payment rail of the 2026-07-08 remodel. Replaces the burn-to-mint model of [FeeRouter V1](08-FeeRouter.md) (70/20/10 split) with a **fee competitive with payment processors**:

```
pay(projectId, 100 CREDIT)
  |
  +--> protocol fee (default 2.5% = 250 bps; hard cap 5%)
  |       +--> 40% treasury    (1.0% of the payment)
  |       +--> 40% GOV buyback (1.0% of the payment)
  |       +--> 20% grants      (0.5% of the payment)
  |
  +--> project rev-share (ProjectFunding.revShareBpsOf; 0 if never funded)
  |       +--> transferred to ProjectFunding + notifyRevenue (investors)
  |
  +--> rest --> project's appRecipient, instantly
          (97.5% with no round; ~89.5% with an 8% rev-share)
```

**No burn, no emission**: CREDIT is a stable rail (see [CreditPSM](15-CreditPSM.md)). Investor income comes from real revenue; GOV value comes from the continuous buyback funded by the fee. For comparison: the 2.5% total fee is below Stripe (~3.8%) and orders of magnitude below the ~80% effective take rate of the V1 model (analysis in `audit/economist/2026-07-08-feerouter-bypass.md`).

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Uses `SafeERC20`.

## Parameters and storage

| Name | Type | Description |
|---|---|---|
| `FEE_BPS_CAP` | constant `uint16` | **500** (5%) — hard fee cap; not even governance can exceed it |
| `GOVERNANCE_ROLE` | constant | Role for the economic setters |
| `CREDIT` | immutable | CreditToken |
| `REGISTRY` | immutable | ProjectRegistry |
| `FUNDING` | immutable | ProjectFunding |
| `feeBps` | `uint16` | Protocol fee in bps of the payment (deploy default **250** = 2.5%) |
| `feeSplit` | `FeeSplit` | Internal fee split (default **4000/4000/2000** = 40% treasury / 40% buyback / 20% grants) |
| `treasuryRecipient` / `buybackRecipient` / `grantsRecipient` | `address` | Fee destinations |
| `appRecipientOf` | mapping | Per-project payment recipient (fallback: Registry owner) |
| `grossVolumeOf` | mapping | **Cumulative gross volume per project** — on-chain metric for investors |

### Struct `FeeSplit`

```solidity
struct FeeSplit {
    uint16 treasuryBps;
    uint16 buybackBps;
    uint16 grantsBps;
}
// bps of the fee ITSELF, must sum to 10000
```

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

Additionally, FeeRouterV2 holds `REVENUE_NOTIFIER_ROLE` **on ProjectFunding** — it is the only address authorized to call `notifyRevenue`.

## External functions

### `pay(uint256 projectId, uint256 amount)`

Pays `amount` of CREDIT to the project. Fully atomic, order: fee → rev-share → app.

- **Who calls**: anyone (the payer is `msg.sender`). Requires prior `CREDIT.approve(feeRouterV2, amount)`.
- **Reverts**: `ZeroAmount`, `ProjectNotActive` (requires an Active project in the Registry).
- **Events**: `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)`.
- **ReentrancyGuard**: yes.

Internal pipeline:

1. `CREDIT.safeTransferFrom(payer, router, amount)`.
2. `fee = amount * feeBps / 10000`; split into `toTreasury` / `toBuyback` / `toGrants` (rounding residue goes to grants).
3. `revShare = amount * FUNDING.revShareBpsOf(projectId) / 10000` (0 if the project never had a Funded round).
4. `toApp = amount - fee - revShare`.
5. Transfers each slice; the rev-share is transferred to ProjectFunding **before** `FUNDING.notifyRevenue(projectId, revShare)` (the funding contract only does accounting, it does not pull).
6. Resolves `appRecipient` (`appRecipientOf[projectId]` or, if zero, `REGISTRY.getProject(projectId).owner`) and transfers `toApp`.
7. `grossVolumeOf[projectId] += amount`.

### Governance-gated (`GOVERNANCE_ROLE`)

#### `setFeeBps(uint16 newFeeBps)`

- **Reverts**: `FeeAboveCap` if `newFeeBps > 500`.
- **Events**: `FeeUpdated(previousBps, currentBps)`.

#### `setFeeSplit(FeeSplit calldata newSplit)`

- **Reverts**: `SplitDoesNotSumTo10000`.
- **Events**: `FeeSplitUpdated(treasuryBps, buybackBps, grantsBps)`.

#### `setRecipients(address treasury_, address buyback_, address grants_)`

- **Reverts**: `ZeroAddress`.
- **Events**: `RecipientsUpdated(treasury, buyback, grants)`.

### Owner-gated

#### `setAppRecipient(uint256 projectId, address recipient)`

The project owner (Registry) rotates the payment recipient — operational, as in V1.

- **Reverts**: `NotProjectOwner`, `ZeroAddress`.
- **Events**: `AppRecipientUpdated(projectId, recipient)`.

### Views

- `previewPay(uint256 projectId, uint256 amount) → (uint256 fee, uint256 revShare, uint256 toApp)` — payment-breakdown preview for UIs, no side effects.
- `grossVolumeOf(projectId)` — cumulative gross volume (the project's on-chain GMV).

## Events

| Event | Indexed |
|---|---|
| `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)` | `projectId`, `payer` |
| `FeeUpdated(previousBps, currentBps)` | — |
| `FeeSplitUpdated(treasuryBps, buybackBps, grantsBps)` | — |
| `RecipientsUpdated(treasury, buyback, grants)` | — |
| `AppRecipientUpdated(projectId, recipient)` | `projectId` |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | Zero address in constructor/setters |
| `ZeroAmount()` | `pay` with `amount == 0` |
| `ProjectNotActive(projectId)` | Project not Active in the Registry |
| `NotProjectOwner(projectId, caller)` | `setAppRecipient` without being the owner |
| `FeeAboveCap(provided, cap)` | Fee above `FEE_BPS_CAP` (500) |
| `SplitDoesNotSumTo10000(sum)` | Fee split does not sum to 10,000 bps |

## Invariants

- **Hard fee cap**: `feeBps <= 500` (5%) — enforced in the constructor and in `setFeeBps`. Not even an approved proposal can go beyond it.
- **I4 (governance via Timelock)**: economic setters are `GOVERNANCE_ROLE`.
- **I7 (projects via Registry)**: `pay` requires an Active project.
- **Conservation**: `toApp + fee + revShare == amount` in every `pay`; within the fee, rounding residue goes to grants.
- **No custody between calls**: each `pay` distributes everything; the router ends with balance 0.
- **Accounting transparency**: events carry the per-slice breakdown even when the three recipients point to the same address (dev MVP: all three = Treasury).

## Important notes

### Differences from V1

| | FeeRouter V1 (legacy) | FeeRouterV2 |
|---|---|---|
| Cost to the app | 90% (70% burn + 20% treasury) | **2.5%** (+ rev-share if it raised) |
| CREDIT burn | 70% of each payment | None |
| Compensating emission | Yes (RewardDistributor) | Does not exist |
| Investor income | Minted CREDIT (inflation) | Rev-share of real revenue |
| Value to GOV | Indirect | Continuous buyback (40% of the fee = 1% of GMV) |
| `pay` signature | `pay(projectId, user, amount)` | `pay(projectId, amount)` — the payer is `msg.sender` |

### `grossVolumeOf` as an investment metric

Investors evaluating a [ProjectFunding](16-ProjectFunding.md) round can verify the project's historical GMV directly on-chain, no indexer needed: `grossVolumeOf[projectId]` accumulates every payment that went through the router.

---

**See also**: [CreditPSM](15-CreditPSM.md), [ProjectFunding](16-ProjectFunding.md), [FeeRouter V1 (legacy)](08-FeeRouter.md), [ProjectRegistry](03-ProjectRegistry.md).
