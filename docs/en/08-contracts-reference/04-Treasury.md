# Treasury

**Audience:** devs building integrations with the treasury, auditors.
**Prerequisites:** [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md).

## Quick overview

DAO's multi-asset custody. Passively receives any ERC-20 (and ETH via `receive`). The only outflow path is `GOVERNANCE_ROLE` — no admin can drain funds outside the governance cycle.

No `deposit` function — any payer uses `token.transfer(treasury, amount)` directly. No pause — unilateral freeze power would be a capture vector.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Uses `SafeERC20`.

## Parameters and storage

No mutable storage. The contract only custodies balances of the tokens it receives.

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## External functions

### Governance-gated

#### `transfer(IERC20 token, address to, uint256 amount)`

Transfers ERC-20 from the treasury to `to`.

- **Reverts**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`.
- **Events**: `Transferred(token, to, amount)`.
- **ReentrancyGuard**: yes.

#### `batchTransfer(IERC20 token, address[] recipients, uint256[] amounts)`

Batch of transfers in a single token.

- **Reverts**: `ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance`.
- **Events**: N × `Transferred` + 1 × `BatchTransferred(token, total, recipientCount)`.

#### `payRebates(IERC20 token, address[] apps, uint256[] amounts, uint256 round)`

Mechanically identical to `batchTransfer`, but with the semantic event `RebatesPaid` including `round`.

- **Events**: N × `Transferred` + 1 × `RebatesPaid(token, round, total, appCount)`.

#### `executeBuyback(address stable, uint256 amountIn, uint256 minGovOut, bytes swapData)`

**v1 stub** — emits `BuybackRequested` event but **does not** execute a swap. DEX integration will come in a later phase.

- **Reverts**: `ZeroAddress` (stable), `ZeroAmount` (amountIn or minGovOut).
- **Events**: `BuybackRequested(stable, amountIn, minGovOut, swapData)`.

#### `sweepETH(address payable to, uint256 amount)`

Withdraws held ETH.

- **Reverts**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `ETHTransferFailed`.
- **Events**: `ETHSwept(to, amount)`.

### `receive()`

Accepts ETH sent directly. Emits `ETHReceived(sender, amount)`. No authorization — anyone can donate ETH.

### Views

- `balanceOf(IERC20 token) → uint256` — wrapper over `token.balanceOf(this)`.

## Events

| Event | Emitted in | Indexed parameters |
|---|---|---|
| `Transferred(token, to, amount)` | `_transfer` (used by `transfer` and helpers) | `token`, `to` |
| `BatchTransferred(token, totalAmount, recipientCount)` | `batchTransfer` | `token` |
| `RebatesPaid(token, round, totalAmount, appCount)` | `payRebates` | `token`, `round` |
| `BuybackRequested(stable, amountIn, minGovOut, swapData)` | `executeBuyback` | `stable` |
| `ETHReceived(from, amount)` | `receive` | `from` |
| `ETHSwept(to, amount)` | `sweepETH` | `to` |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | Zero address in operation requiring valid |
| `ZeroAmount()` | Zero value |
| `ArrayLengthMismatch()` | Arrays with different lengths |
| `EmptyBatch()` | Empty arrays |
| `InsufficientBalance(token, requested, available)` | Insufficient balance in token |
| `ETHTransferFailed()` | `call{value}` on destination failed |

## Invariants

- **I4 (Governance-only exit)**: every value outflow requires `GOVERNANCE_ROLE`. In production, that role is exclusive to the Timelock.
- **No pause**: there is no emergency stop function. Residual risk accepted in exchange for decentralization.
- **CEI**: checks → (no storage effects, only event before) → interaction. See each function.
- **ReentrancyGuard**: all value outflows.

## Important notes

### Why there is no `deposit`

Treasury is a vault, not a bookkeeper. Whoever wants to send funds uses `transfer` directly. Simplifies mental model and eliminates attack surface (cross permissions).

### Why `executeBuyback` is a stub

DEX integration requires modeling:

- TWAP oracle for fair price.
- Explicit maximum slippage.
- Frontrunning resistance.
- Choice between Uniswap v3, Balancer weighted pools, etc.

The responsible decision is a separate phase. In v1, `executeBuyback` only records intent on-chain via event — off-chain workers or future contracts can act later. The DAO can approve buybacks via manual `transfer` in the meantime (e.g., `transfer(stable, dex_router, amount)` with another proposal to complete the swap).

### Non-standard tokens

`SafeERC20` is used in all outflows to tolerate non-standard tokens (historic USDC does not return bool on transfer, for example). `forceApprove` could be used in approve integrations, but there is no approve leaving the Treasury in v1 (it does not call external contracts that consume allowance).

### ETH receipt

`receive` has `emit ETHReceived` — not a silent payable. This provides off-chain indexing of any donation.

Constructor is **not** payable — does not accept ETH during deploy (no justification to).

---

**See also**: [FeeRouter](08-FeeRouter.md), [UserSubsidy](12-UserSubsidy.md), [TeamVesting](11-TeamVesting.md).
