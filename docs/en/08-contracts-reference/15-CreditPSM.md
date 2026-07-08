# CreditPSM

**Audience:** users and devs converting USDC ↔ CREDIT, auditors.
**Prerequisites:** [CreditToken](02-CreditToken.md), [FeeRouterV2](08b-FeeRouterV2.md).

## Quick view

Peg Stability Module of the 2026-07-08 remodel. Converts USDC ↔ CREDIT at **1:1, no fee**, in both directions:

- `buy(usdcAmount)` — deposits USDC, mints CREDIT 1:1 (6 → 18 decimals conversion).
- `sell(creditAmount)` — burns CREDIT, returns USDC 1:1 (18 → 6 decimals).

With the PSM, **CREDIT stops being a speculative/deflationary asset and becomes a stable payment rail**: every CREDIT minted here is 100% backed by the USDC held in this very contract. There is **no** function to withdraw the backing — not even for governance. If the DAO wants to spend, it spends from the [FeeRouterV2](08b-FeeRouterV2.md) fee, never from here.

The contract has no owner, no roles of its own and no adjustable parameters — it is immutable with zero admin surface.

## Inheritance

```
ReentrancyGuard (OZ)
```

Uses `SafeERC20`.

## Parameters and storage

| Name | Type | Description |
|---|---|---|
| `CREDIT` | immutable | CreditToken (18 decimals) |
| `USDC` | immutable | Backing stablecoin (6 decimals in production) |
| `SCALE` | immutable | Decimals conversion factor: `10^(18 - decimals(USDC))` = `1e12` for USDC |
| `mintedOutstanding` | `uint256` | CREDIT in circulation minted by this PSM (18 decimals) |

The constructor reverts with `InvalidDecimals` if the stable has more than 18 decimals.

## Roles and permissions

The PSM **has no AccessControl**. It does, however, need roles **on the CreditToken**:

| Role (on CreditToken) | Why |
|---|---|
| `MINTER_ROLE` | `buy` mints CREDIT to the buyer |
| `BURNER_ROLE` | `sell` burns the returned CREDIT |

The burn is always over the **PSM's own balance** (after `transferFrom` from the seller) — the burn role never touches third-party balances.

## External functions

### `buy(uint256 usdcAmount) → uint256 creditOut`

Buys CREDIT with USDC at 1:1.

- **Who calls**: anyone. Requires prior `USDC.approve(psm, usdcAmount)`.
- **Effects**: `USDC.safeTransferFrom(caller, psm)`, `mintedOutstanding += creditOut`, `CREDIT.mint(caller, creditOut, "psm:buy")`.
- **Returns**: `creditOut = usdcAmount * SCALE` (18 decimals).
- **Reverts**: `ZeroAmount`.
- **Events**: `Bought(user, usdcIn, creditOut)`.
- **ReentrancyGuard**: yes.

### `sell(uint256 creditAmount) → uint256 usdcOut`

Redeems USDC by returning CREDIT at 1:1. The returned CREDIT is **burned**.

- **Who calls**: anyone. Requires prior `CREDIT.approve(psm, creditAmount)`.
- **Effects**: pulls the CREDIT into the PSM, `CREDIT.burnByRole(psm, creditAmount, "psm:sell")`, decrements `mintedOutstanding` (clamped at zero), `USDC.safeTransfer(caller, usdcOut)`.
- **Returns**: `usdcOut = creditAmount / SCALE` (6 decimals).
- **Reverts**: `ZeroAmount`; `DustAmount` if `creditAmount` is not a multiple of `SCALE` (dust below 1e-6 USDC reverts instead of being confiscated); `InsufficientBacking` if the available USDC backing is insufficient.
- **Events**: `Sold(user, creditIn, usdcOut)`.
- **ReentrancyGuard**: yes.

### Views

- `backing() → uint256` — current USDC backing (6 decimals).
- `backingNormalized() → uint256` — backing in 18 decimals, comparable to `mintedOutstanding`.

## Events

| Event | Indexed |
|---|---|
| `Bought(user, usdcIn, creditOut)` | `user` |
| `Sold(user, creditIn, usdcOut)` | `user` |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAmount()` | `amount == 0` in `buy`/`sell` |
| `DustAmount(amount, granularity)` | `sell` with a value that is not a multiple of `SCALE` |
| `InsufficientBacking(requested, available)` | `sell` larger than the available USDC backing |
| `InvalidDecimals(decimals)` | Constructor with a stable > 18 decimals |

## Invariants

- **I-PSM1 (full backing)**: `USDC.balanceOf(psm) >= mintedOutstanding` (in normalized units). There is no backing-withdrawal function — not even governance can drain it.
- **I-PSM2 (exact conversion)**: `buy` converts `usdc * 1e12`; `sell` requires a multiple of `1e12`. No dust is ever confiscated — it reverts.
- **No fee**: exact 1:1 in both directions, always.
- **Burn only from own balance**: `burnByRole` is always over `address(this)`.

## Important notes

### `mintedOutstanding` is a conservative estimate

If someone sells CREDIT that came from another origin (genesis/legacy), `mintedOutstanding` may undershoot the burned amount — the counter clamps at zero instead of reverting the redemption. The verifiable real backing is always `backing()`.

### Relation to the old model

In the pre-remodel model, CREDIT was acquired on an external DEX (CREDIT/USDC pool) and the price floated with floor defense via FFP buyback. The PSM replaces that rail as the primary entry/exit path: **1 CREDIT = 1 USDC, always, on-chain**. The DEX pool and FFP remain as legacy — ecosystem appreciation is now captured by GOV (via the buyback funded by the FeeRouterV2 fee).

---

**See also**: [FeeRouterV2](08b-FeeRouterV2.md), [ProjectFunding](16-ProjectFunding.md), [CreditToken](02-CreditToken.md).
