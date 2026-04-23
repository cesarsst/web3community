# GovernanceToken

**Audience:** devs integrating with the governance token or auditors.
**Prerequisites:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## Quick overview

ERC-20 token with `ERC20Votes` (ERC-5805) extension and immutable 100M supply cap. It is the governance token and staking collateral of the protocol. Owner in production is `CommunityTimelock` (after `acceptOwnership`) — every mint requires a proposal approved by the DAO.

**No pre-mint in the constructor**: supply starts at zero. Every distribution (30% treasury / 25% team / 20% sale / 15% community / 10% liquidity, or any approved variation) happens via proposals that call `mint`.

## Inheritance

```
ERC20 (OZ)
ERC20Permit (OZ, EIP-2612)
ERC20Votes (OZ, ERC-5805 snapshotting via Checkpoints)
Ownable2Step (OZ, 2-step owner transfer)
```

## Parameters and storage

| Name | Type | Value | Description |
|---|---|---|---|
| `CAP_SUPPLY` | `uint256` immutable | 100_000_000 * 1e18 | Absolute maximum supply. Enforced in `_update`. |
| `name` | ERC-20 | "Web3Community Governance" (production) | Used in EIP-712 of `permit` and `delegateBySig`. **Not changeable** without breaking past signatures. |
| `symbol` | ERC-20 | "GOV" (production) | — |

## Roles and permissions

No AccessControl. Uses `Ownable2Step`:

- `owner` — the only one allowed to call `mint`. In production: `CommunityTimelock`.
- `pendingOwner` — set in `transferOwnership(newOwner)`; consolidation only with `acceptOwnership` by the `pendingOwner`.

## External functions

### `mint(address to, uint256 amount, string calldata tag)`

Mints `amount` to `to`, applying the immutable cap.

- **Who calls**: only the `owner`.
- **Reverts**:
  - `ZeroAddress` if `to == address(0)`.
  - `ZeroAmount` if `amount == 0`.
  - `CapExceeded(attempted, cap)` if `totalSupply + amount > CAP_SUPPLY`.
- **Events**: `Minted(to, amount, tag)` + `Transfer(0, to, amount)`.
- **Usage**: DAO proposal → Timelock.execute → `mint`.

### `cap() → uint256`

Returns `CAP_SUPPLY`. View.

### `nonces(address owner) → uint256`

Returns current nonce. Used by `permit` and `delegateBySig`. Inherited from `ERC20Permit` + `Nonces`.

### Relevant inherited functions

- **ERC-20**: `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`.
- **ERC20Permit**: `permit(owner, spender, value, deadline, v, r, s)` — gasless approve.
- **ERC20Votes**: `delegate(delegatee)`, `delegateBySig(...)`, `getVotes(account)`, `getPastVotes(account, timepoint)`, `getPastTotalSupply(timepoint)`, `delegates(account)`, `checkpoints(account, pos)`, `numCheckpoints(account)`.
- **Ownable2Step**: `transferOwnership(newOwner)`, `acceptOwnership()`, `owner()`, `pendingOwner()`.

## Events

| Event | Emitted in | Indexed parameters |
|---|---|---|
| `Minted(to, amount, tag)` | `mint` | `to` |
| `Transfer(from, to, value)` | inherited ERC-20 | `from`, `to` |
| `Approval(owner, spender, value)` | inherited ERC-20 | `owner`, `spender` |
| `DelegateChanged(delegator, fromDelegate, toDelegate)` | `delegate` / `delegateBySig` | `delegator`, `fromDelegate`, `toDelegate` |
| `DelegateVotesChanged(delegate, previousBalance, newBalance)` | any change that affects a delegate | `delegate` |
| `OwnershipTransferStarted(previousOwner, newOwner)` | `transferOwnership` | `previousOwner`, `newOwner` |
| `OwnershipTransferred(previousOwner, newOwner)` | `acceptOwnership` | `previousOwner`, `newOwner` |

## Custom errors

| Error | When it occurs |
|---|---|
| `CapExceeded(attemptedSupply, cap)` | `_update` receives a mint that would exceed `CAP_SUPPLY` |
| `ZeroAddress()` | `mint` with `to == 0` |
| `ZeroAmount()` | `mint` with `amount == 0` |
| inherited OZ | `ERC20InsufficientBalance`, `ERC20InvalidSender`, `ERC20InvalidReceiver`, `ERC20InsufficientAllowance`, `ERC20InvalidApprover`, `ERC20InvalidSpender`, `ERC2612ExpiredSignature`, `ERC2612InvalidSigner`, `VotesExpiredSignature`, `InvalidAccountNonce`, `CheckpointUnorderedInsertion`, `OwnableInvalidOwner`, `OwnableUnauthorizedAccount` |

## Invariants

- **I1 (Cap)**: `totalSupply() <= CAP_SUPPLY` at every instant. Enforced in `_update` with `CapExceeded` revert.
- **I5 (Anti-flashloan)**: voting via `getPastVotes` (snapshot). Flash loan in the current block does not affect a past snapshot.
- **Ownership**: only the `owner` mints. In production, `owner` is the Timelock.
- **Domain separator**: `name` used in EIP-712 is fixed in constructor — do not change without a migration strategy.

## Important notes

### Relationship with ERC20Votes `_maxSupply`

`GovernanceToken` overrides `_maxSupply` to return `CAP_SUPPLY`, ensuring that the internal `ERC20Votes` check (which prevents uint208 overflow) also respects the project cap. Since `100M * 1e18 = 1e26` fits comfortably in `uint208 (~4.11e62)`, there is no practical conflict.

### Deploy strategy

The `Dao.ts` deploy:

1. Deploys with `initialOwner = deployer`.
2. Deployer grants `MINTER_ROLE` on CreditToken, etc.
3. Deployer calls `transferOwnership(timelock)`.
4. Timelock becomes `pendingOwner`.
5. **Mandatory first proposal on mainnet**: call `acceptOwnership()` by the Timelock, consolidating the transfer.

Until step 5 happens, the deployer is still `owner` — it is the critical window documented in [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

### Usage with `TeamVesting`

Vesting proposals transfer GOV from the Treasury (or mint directly) to a `TeamVesting` instance. The vesting releases gradually to the beneficiary.

### Absence of `burn`

GOV is **not** burnable. Does not inherit `ERC20Burnable`. The 100M cap is the absolute maximum — supply can only grow up to the cap or stay the same.

---

**See also**: [CommunityGovernor](10-CommunityGovernor.md), [Staking](05-Staking.md).
