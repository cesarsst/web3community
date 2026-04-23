# TeamVesting

**Audience:** auditors, beneficiaries, protocol operations team.
**Prerequisites:** [Tokenomics](../06-for-investors/01-tokenomics.md).

## Quick overview

Linear vesting vault with cliff to distribute GOV to **a single beneficiary**. Pattern: one instance per team member (or group custodied by a multisig). Simplifies off-chain accounting and isolates revocation — if someone leaves, the DAO revokes only that instance.

Standard OZ formula: `vested(t) = total * (t - start) / duration`, zero before cliff, "hockey stick" at cliff (releases `cliff/duration` at once).

## Inheritance

```
Ownable2Step (OZ)
```

Uses `SafeERC20`.

## Parameters (via constructor, immutable)

| Name | Type | Description |
|---|---|---|
| `token` | IERC20 | Token being vested (production: GOV) |
| `beneficiary` | address | Receives the releases |
| `start` | uint64 | Start timestamp of the schedule |
| `cliff` | uint64 | Offset in seconds from `start`. Before cliff, releasable = 0 |
| `duration` | uint64 | TOTAL duration in seconds (includes cliff) |

### Mutable storage

| Name | Type | Description |
|---|---|---|
| `released` | uint256 | Total already withdrawn |
| `revoked` | bool | true after the first `revoke` call |
| `revokedAt` | uint64 | revoke timestamp |
| `totalAllocatedAtRevoke` | uint256 | Frozen boundary post-revoke |

### Parameter example (typical proposal)

```
start    = TGE timestamp
cliff    = 365 days
duration = 4 * 365 days  (12m cliff + 36m linear = 48m total)
```

At `start + 12m`, releases 25% at once. Then trickles linearly until `start + 48m`.

## Roles and permissions

- `owner` — in production: `CommunityTimelock`. Sole who can `revoke`.
- `beneficiary` — immutable. Always receives the tokens on `release`.

## External functions

### `release()`

Withdraws everything `releasable` to the `beneficiary`.

- **Who calls**: anyone (the payment goes to `beneficiary` regardless).
- **Reverts**: `NothingToRelease` if `releasable() == 0`.
- **Events**: `Released(beneficiary, amount)`.

### `revoke(address returnTo)`

Revokes the vesting. **One-shot** — second call reverts.

- **Who calls**: `owner` (Timelock via proposal in production).
- **Reverts**: `AlreadyRevoked`, `ZeroAddress` (returnTo).
- **Events**: `Revoked(returnTo, unvestedReturned, frozenVested)`.

Effects:

1. `revoked = true`, `revokedAt = now`, `totalAllocatedAtRevoke = vestedAmount(now)`.
2. Transfers `unvested` to `returnTo` (typically Treasury).
3. Future `vestedAmount` always returns `totalAllocatedAtRevoke`.

Beneficiary can still call `release` to withdraw existing vested-but-unreleased.

### Views

- `vestedAmount(uint64 timestamp) → uint256` — total vested at `timestamp`. Post-revoke returns `totalAllocatedAtRevoke`.
- `releasable() → uint256` — `vestedAmount(now) - released`.
- `totalAllocation() → uint256` — total recognized allocation. Before revoke: `balanceOf(this) + released`. After revoke: `totalAllocatedAtRevoke`.

### Inherited (Ownable2Step)

- `transferOwnership(newOwner)`.
- `acceptOwnership()`.
- `owner() → address`.
- `pendingOwner() → address`.

## Events

| Event | Indexed |
|---|---|
| `Released(beneficiary, amount)` | `beneficiary` |
| `Revoked(returnTo, unvestedReturned, frozenVested)` | `returnTo` |
| `OwnershipTransferStarted(previousOwner, newOwner)` | `previousOwner`, `newOwner` |
| `OwnershipTransferred(previousOwner, newOwner)` | `previousOwner`, `newOwner` |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | `token`, `beneficiary` or `returnTo` zero |
| `ZeroDuration()` | `duration == 0` (division by zero) |
| `CliffExceedsDuration()` | `cliff > duration` |
| `NothingToRelease()` | `releasable() == 0` |
| `AlreadyRevoked()` | Second call to `revoke` |

## Invariants

- **Allocation captured dynamically**: `totalAllocation() = balanceOf(this) + released` (pre-revoke). Additional transfers post-deploy increase the allocation.
- **Revoke freezes boundary**: after revoke, `vestedAmount` always returns `totalAllocatedAtRevoke`. Transfers post-revoke do **not** increase vested.
- **Pull-based release**: anyone calls, tokens always go to `beneficiary`.
- **CEI on `release`**: `released += amount` before `safeTransfer`.
- **Revoke one-shot**: `revoked` flag blocks re-execution.

## Important notes

### Why Ownable2Step instead of AccessControl

Authority over revocation is inherently singular (DAO via Timelock) and 2-step protects against ownership transfer to the wrong address during migration. AccessControl would be overkill.

### Why `start` can be in the past

The DAO can deliberately start the schedule in the past — e.g., recognition of service prior to TGE. If beneficiary calls `release` right after deploy and the past is sufficient, first withdraw is immediate. Intentional behavior.

### No auto-compound / auto-transfer of vested on revoke

`revoke` does **not** transfer vested-but-unreleased to the beneficiary automatically. Beneficiary must call `release` to collect. This separation:

- Preserves "pull" UX.
- Avoids surprise transfer to `beneficiary` (who may be an offline multisig at proposal time).

### One instance per member

Deploy pattern: one `TeamVesting` **per** team member. Reasons:

- **Isolation**: revoking one does not affect the others.
- **Accounting**: 1 instance = 1 schedule, easy to audit.
- **Individual parameters**: cliff/duration can vary per person.

### No pause

Same rationale as Treasury. If a "pause" is needed, the DAO approves `revoke` — semantically more honest.

### Detailed formula

```
vested(t) = 0                                 if t < start + cliff
vested(t) = total                             if t >= start + duration
vested(t) = total * (t - start) / duration    otherwise
```

`total = balanceOf(this) + released` (pre-revoke) or `totalAllocatedAtRevoke` (post-revoke).

### Beware of additional transfers

If the DAO (via Treasury) transfers more GOV to the instance after start, `totalAllocation` rises automatically. That is rarely desirable — avoid sending later transfers to the funded instance.

---

**See also**: [GovernanceToken](01-GovernanceToken.md), [Treasury](04-Treasury.md).
