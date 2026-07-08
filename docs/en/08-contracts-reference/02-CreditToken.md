# CreditToken

**Audience:** devs integrating with the utility token or auditors.
**Prerequisites:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## Quick overview

Utility ERC-20 token, burned on consumption inside the apps. Elastic supply with no hardcoded cap — inflation is economically controlled by whoever holds `MINTER_ROLE` (the V1 `RewardDistributor` and/or the CLP's `RewardDistributorV2`), which applies the formula `min(max(alpha*burn, floor), capMax)` per round.

Burns on three paths: `burn` (self), `burnFrom` (with allowance), `burnByRole` (no allowance, role-gated). The `burnByRole` path exists to enable atomic burn by `BurnTracker` (app consumption) and by the `Treasury` (FFP buyback — bought CREDIT is burned immediately), without requiring a prior approve.

## Inheritance

```
ERC20 (OZ)
ERC20Burnable (OZ)
AccessControl (OZ)
```

## Parameters and storage

| Name | Type | Value | Description |
|---|---|---|---|
| `MINTER_ROLE` | `bytes32` constant | `keccak256("MINTER_ROLE")` | Role to mint |
| `BURNER_ROLE` | `bytes32` constant | `keccak256("BURNER_ROLE")` | Role to burn without allowance |
| `genesisMinted` | `bool` | `false` at deploy | One-shot flag; prevents re-execution of `mintGenesis` |
| `name` | ERC-20 | "Web3Community Credit" (production) | — |
| `symbol` | ERC-20 | "CREDIT" (production) | — |

No hardcoded cap.

## Roles and permissions

`MINTER_ROLE` and `BURNER_ROLE` are **plural** by design — the role can be granted to more than one address as the protocol evolves (CLP V1 → V2, migrations).

| Role | In production granted to |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` (after handoff) |
| `MINTER_ROLE` | `RewardDistributor` (V1) and/or `RewardDistributorV2` (Phase 1.4); during a V1→V2 migration, both may hold the role transiently |
| `BURNER_ROLE` | `BurnTracker` (app consumption via `burnAndRecord`) **and** `Treasury` (FFP buyback — `burnByRole(this, creditOut, "treasury:buyback")`) |

## External functions

### `mintGenesis(address to, uint256 amount)`

One-time "genesis" minting. The `amount` is a **parameter** (not hardcoded in the contract) — the deploy script picks the exact number; in production it comes from `genesisAmount` in `ignition/parameters/production.json` (`10_000_000e18` = 10M CREDIT to the Treasury). The `to` is also a parameter (recipient not hardcoded). The `genesisMinted` flag (one-shot) prevents re-execution even by the admin.

- **Who calls**: `DEFAULT_ADMIN_ROLE`. Does NOT consume `MINTER_ROLE` — the genesis path is separate from the operational one.
- **Reverts**:
  - `GenesisAlreadyMinted` if already called.
  - `ZeroAddress` / `ZeroAmount`.
- **Events**: `GenesisMinted(to, amount)` + `Transfer(0, to, amount)`.

### `mint(address to, uint256 amount, string calldata tag)`

Mints `amount` to `to`. Does not apply a cap (caller's responsibility — invariant I3 lives in the distributor).

- **Who calls**: `MINTER_ROLE` (in production, `RewardDistributor` V1 and/or `RewardDistributorV2`).
- **Reverts**: `ZeroAddress`, `ZeroAmount`.
- **Events**: `Minted(to, amount, tag)` + `Transfer(0, to, amount)`.

### `burnByRole(address from, uint256 amount, string calldata tag)`

Burns `amount` from `from`'s balance **without** consuming allowance. Used by `BurnTracker` to burn atomically in `burnAndRecord`, and by the `Treasury` in the FFP buyback (`burnByRole(treasury, creditOut, "treasury:buyback")`).

- **Who calls**: `BURNER_ROLE` (in production, `BurnTracker` and `Treasury`).
- **Reverts**: `ZeroAddress`, `ZeroAmount`, `ERC20InsufficientBalance`.
- **Events**: `BurnedByRole(operator, from, amount, tag)` + `Transfer(from, 0, amount)`.

### Relevant inherited functions

- **ERC-20**: `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`.
- **ERC20Burnable**: `burn(uint256)` (self-burn), `burnFrom(address, uint256)` (via allowance).
- **AccessControl**: `grantRole`, `revokeRole`, `renounceRole`, `hasRole`, `getRoleAdmin`, `supportsInterface`.

## Events

| Event | Emitted in | Indexed parameters |
|---|---|---|
| `GenesisMinted(to, amount)` | `mintGenesis` | `to` |
| `Minted(to, amount, tag)` | `mint` | `to` |
| `BurnedByRole(operator, from, amount, tag)` | `burnByRole` | `operator`, `from` |
| `Transfer(from, to, value)` | inherited | `from`, `to` |
| `RoleGranted/RoleRevoked/RoleAdminChanged` | AccessControl | — |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | `to` or `from` is zero in operations requiring valid |
| `ZeroAmount()` | `amount == 0` |
| `GenesisAlreadyMinted()` | `mintGenesis` second attempt |
| OZ | `ERC20InsufficientBalance`, `ERC20InsufficientAllowance`, `AccessControlUnauthorizedAccount`, etc. |

## Invariants

- **Genesis one-shot**: `mintGenesis` runs only once per contract lifetime. `amount` and `to` are parameters — no hardcode.
- **`MINTER_ROLE` gate**: `mint` requires the role; in production, `RewardDistributor` V1 and/or `RewardDistributorV2` (plural role, V1→V2 migration possible).
- **`BURNER_ROLE` gate**: `burnByRole` requires the role; in production, `BurnTracker` (app consumption) and `Treasury` (buyback). Plural role, revocable by the admin.
- **Elastic supply**: grows with `mint`/`mintGenesis`; drops with `burn`/`burnFrom`/`burnByRole`. No hardcoded cap.
- **CEI applied**: `burnByRole` is checks → effect (native `_burn`) → no external interaction. No callback in `_burn`.

## Important notes

### Why `burnByRole` instead of `burnFrom` with allowance?

`FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole` is a **1-tx** path from the user. If it were via `burnFrom`, the user would need:

1. `approve(burnTracker, amount)` — tx 1.
2. Call some function that triggers `burnTracker.burnFrom(user, ...)` — tx 2.

Would break UX and open a front-run window between approve and burn. The role path is safe because the role is only granted to specific contracts via proposal + Timelock.

The allowance path (`burnFrom`) remains available for whoever wants explicit consent control.

### Does not inherit `ERC20Permit` or `ERC20Votes`

Conscious decision for v1:

- CREDIT does not vote. If it did, it would mix governance with operational use.
- Permit can be useful but is not required in the current flow (allowance on the app tx).

If permit becomes necessary in v2, just add `ERC20Permit` as an extension preserving storage layout.

### Role management

`DEFAULT_ADMIN_ROLE` has power to grant/revoke `MINTER_ROLE` and `BURNER_ROLE`. In production, that power belongs to the Timelock — any minter/burner change goes through a proposal.

---

**See also**: [RewardDistributor](07-RewardDistributor.md), [RewardDistributorV2](07b-RewardDistributorV2.md), [BurnTracker](06-BurnTracker.md), [Treasury](04-Treasury.md).
