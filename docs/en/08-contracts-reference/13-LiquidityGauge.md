# LiquidityGauge

**Audience:** LPs of the CREDIT/USDC pair, devs integrating LP-stake UI, auditors.
**Prerequisites:** [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md), [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Quick view

Adapter on top of the canonical `UniswapV3Staker` (Uniswap Foundation, mainnet `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`) that distributes the **LPs bucket** (default 25%) of CREDIT emission per round to external LPs of the CREDIT/USDC pair. Implements Phase 1.3 of the Credit Liquidity Protocol (CLP) pivot.

User flow:

1. User holds a V3 NFT (concentrated position in a whitelisted pool).
2. Calls `stake(tokenId, poolId)` — NFT goes to the staker and starts accruing in-range rewards.
3. To exit, calls `unstake(tokenId)` — NFT returns, rewards enter a **14-day linear vesting**.
4. `harvest(user, maxAmount)` withdraws the already-vested fraction.
5. `emergencyUnstake(tokenId)` (always allowed, even paused) returns the NFT but **discards rewards from the current cycle** — fail-safe.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
Pausable (OZ)
IERC721Receiver
```

Uses `SafeERC20`.

## Parameters and storage

### Constants

| Name | Value |
|---|---|
| `VESTING_DURATION_MIN` | `1 days` |
| `VESTING_DURATION_MAX` | `90 days` |
| `INCENTIVE_DURATION_MIN` | `1 hours` |

### Immutables (constructor)

- `CREDIT_TOKEN` — CREDIT address (rewardToken).
- `UNISWAP_V3_STAKER` — canonical Uniswap V3 staker.
- `POSITION_MANAGER` — canonical Uniswap V3 NPM (`0xC36442b4a4522E871399CD717aBDD847Ab11FE88` on mainnet).

### Storage

| Name | Type | Description |
|---|---|---|
| `vestingDuration` | `uint32` | Default `14 days`. Mutable within `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]` |
| `poolCount` | `uint256` | Number of whitelisted pools (1-based) |
| `pools[poolId]` | `PoolConfig` | Per-pool config |
| `poolIdByAddress[pool]` | `uint256` | Reverse lookup (`0` = not whitelisted) |
| `stakes[tokenId]` | `Stake` | Staked NFT state |
| `totalVestingLocked` | `uint256` | Total CREDIT reserved for not-yet-claimed `VestingPosition`s. Segregates the balance: this portion belongs to users and CANNOT be drained via `governanceRescueRewards` |
| `denylisted[account]` | `bool` | Anti self-dealing (D.9) |

### Struct `PoolConfig`

```solidity
struct PoolConfig {
    address pool;                  // IUniswapV3Pool
    bool enabled;                  // false disables new stakes
    bytes32 currentIncentiveHash;  // bytes32(0) = no active incentive
}
```

### Struct `Stake`

```solidity
struct Stake {
    address owner;          // real NFT owner
    uint256 poolId;         // whitelisted pool
    bytes32 incentiveHash;  // incentive in which the NFT is staked
    uint64 stakedAt;        // UNIX timestamp (s)
}
```

### Struct `VestingPosition`

```solidity
struct VestingPosition {
    uint256 totalAmount;
    uint256 claimedAmount;
    uint64 startedAt;
    uint64 endsAt;
}
```

## Roles and permissions

| Role | In production | Power |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | grant/revoke roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | whitelist, denylist, pause, vesting params, rescue |
| `REWARD_NOTIFIER_ROLE` | `Treasury` + `RewardDistributorV2` | create incentives via `notifyRewardAmount` (plural by design — D.7) |

## External functions

### Governance (`GOVERNANCE_ROLE`)

#### `addPool(address pool) -> uint256 poolId`

Adds a pool to the whitelist. The pool starts `enabled = true` but with NO active incentive (needs `notifyRewardAmount` before the first stake).

- **Reverts**: `ZeroAddress`, `InvalidPool(0)` (already whitelisted).
- **Events**: `PoolAdded(poolId, pool)`.

#### `setPoolEnabled(uint256 poolId, bool enabled)`

Enables/disables a pool. Does NOT affect existing stakes — they keep vesting in the incentive they were staked in. Only new `stake` is blocked.

- **Reverts**: `InvalidPool(poolId)`.
- **Events**: `PoolEnabledSet(poolId, enabled)`.

#### `setVestingDuration(uint32 newDuration)`

Updates the linear vesting applied to NEW `VestingPosition`s. Not retroactive.

- **Reverts**: `InvalidVestingDuration(requested)` if outside `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]`.
- **Events**: `VestingDurationSet(oldDuration, newDuration)`.

#### `setDenylist(address account, bool denied)`

Marks/unmarks an address as denylisted. Denylisted addresses cannot call `stake` — bootstrap must denylist Treasury, Staking, RewardDistributor, FeeRouter (anti self-dealing — D.9).

- **Reverts**: `ZeroAddress`.
- **Events**: `DenylistSet(account, denied)`.

#### `pause()` / `unpause()`

Pauses entry of new stakes. `unstake`/`harvest` keep operational; `emergencyUnstake` always operational. IE10-friendly.

#### `endIncentive(uint256 poolId) -> uint256 refund`

Closes the pool's CURRENT incentive (must be expired) and recovers the refund to the gauge.

- **Reverts**: `InvalidPool`, `NoActiveIncentive`, `IncentiveNotExpired`.
- **Events**: `IncentiveEnded(poolId, incentiveHash, refund)`.

#### `governanceRescueRewards(address to, uint256 amount)`

Rescues orphan CREDIT in the gauge (refunds from closed incentives, forfeits from `emergencyUnstake`). **On-chain segregation**: the rescue can NEVER consume CREDIT that backs not-yet-claimed `VestingPosition`s (`totalVestingLocked`) — only the surplus (`getUnreservedBalance()`). `amount == type(uint256).max` transfers the entire **unreserved** balance.

- **Reverts**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance(requested, available)`, `RescueExceedsUnreserved(available, requested)`.
- **Events**: `RewardsRescued(to, amount)`.

### Reward notification (`REWARD_NOTIFIER_ROLE`)

#### `notifyRewardAmount(uint256 poolId, uint256 amount, uint32 duration) -> bytes32 incentiveHash`

Creates a new incentive in the canonical staker. The caller transfers `amount` CREDIT (via prior allowance) — the gauge forwards to the staker. Incentive starts NOW, ends at `block.timestamp + duration`.

Simplified model: 1 active incentive per pool at a time. Reverts with `IncentiveOverlap` if there is already a non-expired incentive.

- **Reverts**: `ZeroAmount`, `InvalidIncentiveDuration` (`< INCENTIVE_DURATION_MIN`), `InvalidPool`, `IncentiveOverlap`.
- **Events**: `RewardNotified(poolId, incentiveHash, amount, startTime, endTime)`.

### User (public)

#### `stake(uint256 tokenId, uint256 poolId)`

Deposits the NFT in the gauge and auto-stakes it on the active incentive. NFT must be `approve`-d to the gauge.

- **Reverts**: `Denylisted`, `InvalidPool`, `PoolDisabled`, `NoActiveIncentive`.
- **Events**: `Staked(user, tokenId, poolId, incentiveHash)`.
- **`whenNotPaused`**: yes. **`nonReentrant`**: yes.

#### `unstake(uint256 tokenId)`

Undoes the stake, returns the NFT to the owner, creates a `VestingPosition` with linear vesting. If there were no rewards (in-range time = 0), it just returns the NFT.

- **Reverts**: `StakeNotFound`, `NotStakeOwner`.
- **Events**: `Unstaked(user, tokenId, rewardAmount)`.
- **NOT `whenNotPaused`** — the user can always exit (IE10).

#### `emergencyUnstake(uint256 tokenId)`

Emergency exit — returns the NFT to the owner. Pending rewards in the staker (from the current cycle) are DISCARDED. In-flight vesting (previous positions) is NOT affected.

Works EVEN PAUSED (fail-safe IE10).

- **Reverts**: `StakeNotFound`, `NotStakeOwner`.
- **Events**: `EmergencyUnstaked(user, tokenId, forfeitedRewards)`.

#### `harvest(address user, uint256 maxAmount) -> uint256 claimed`

Withdraws already-vested CREDIT. Compacts fully-claimed positions (anti-bloat). `maxAmount = type(uint256).max` withdraws everything.

- **Reverts**: `ZeroAddress`.
- **Events**: `Harvested(user, amount)`.
- The caller can harvest on behalf of someone else.

### Views

- `vestedAmount(address user) -> (uint256 vested, uint256 claimable)` — sum across all positions.
- `vestingCountOf(address user) -> uint256`.
- `vestingAt(address user, uint256 index) -> VestingPosition`.
- `getUnreservedBalance() -> uint256` — `max(balanceOf(gauge) - totalVestingLocked, 0)`. The only portion eligible for `governanceRescueRewards`.
- `incentiveByHash(bytes32) -> IUniswapV3Staker.IncentiveKey` — useful off-chain.
- `pendingRewardsAtStaker() -> uint256` — gauge's aggregate balance at the staker.

## Events

| Event | Indexed |
|---|---|
| `PoolAdded(poolId, pool)` | `poolId`, `pool` |
| `PoolEnabledSet(poolId, enabled)` | `poolId` |
| `RewardNotified(poolId, incentiveHash, amount, startTime, endTime)` | `poolId`, `incentiveHash` |
| `IncentiveEnded(poolId, incentiveHash, refund)` | `poolId`, `incentiveHash` |
| `Staked(user, tokenId, poolId, incentiveHash)` | `user`, `tokenId`, `poolId` |
| `Unstaked(user, tokenId, rewardAmount)` | `user`, `tokenId` |
| `EmergencyUnstaked(user, tokenId, forfeitedRewards)` | `user`, `tokenId` |
| `Harvested(user, amount)` | `user` |
| `VestingDurationSet(old, new)` | — |
| `DenylistSet(account, denied)` | `account` |
| `RewardsRescued(to, amount)` | `to` |

## Custom errors

| Error | When |
|---|---|
| `ZeroAddress()` | Zero address |
| `ZeroAmount()` | Zero value |
| `InvalidPool(poolId)` | Pool not whitelisted or already registered |
| `PoolDisabled(poolId)` | Pool whitelisted but `enabled == false` |
| `NoActiveIncentive(poolId)` | `currentIncentiveHash == bytes32(0)` |
| `Denylisted(account)` | Caller in denylist |
| `StakeNotFound(tokenId)` | NFT not managed |
| `NotStakeOwner(tokenId, expected, actual)` | Caller is not the owner |
| `InvalidVestingDuration(requested)` | Outside the range |
| `InvalidIncentiveDuration(requested)` | `< INCENTIVE_DURATION_MIN` |
| `IncentiveNotExpired(hash, endsAt)` | `endIncentive` before `endTime` |
| `IncentiveOverlap(poolId, currentHash)` | `notifyRewardAmount` with active incentive |
| `InsufficientBalance(requested, available)` | Rescue exceeds the gauge's total balance |
| `RescueExceedsUnreserved(available, requested)` | Rescue exceeds the **unreserved** balance (`balance - totalVestingLocked`) — protects vesting on-chain |

## Invariants

- **IE6 (DEX liquidity)**: gauge strengthens IE6 by incentivising incremental liquidity beyond POL.
- **IE10 (do not pause user)**: `pause` blocks ENTRY, not EXIT. `emergencyUnstake` is fail-safe always operational.
- **D.4 14d linear vesting**: `harvest` partial. Exit before the end of vesting does NOT penalise already-created positions — vesting accumulates independently of whether the NFT is staked.
- **D.9 anti self-dealing**: Treasury cannot stake (denylisted at bootstrap).
- **On-chain vesting segregation**: `totalVestingLocked` (sum of `totalAmount - claimedAmount` across live positions) is untouchable by `governanceRescueRewards` — the rescue only reaches `getUnreservedBalance()`. `unstake` increments the reserve (via `_createVestingPosition`), `harvest` decrements it by the amount claimed; `emergencyUnstake` does NOT touch it (the forfeit becomes unreserved balance, previous positions preserved).

## Important notes

### Vesting accumulates independently of stake

After `unstake`, the user does NOT need to keep the NFT staked to keep vesting. Reason: rewards have already been "earned" at the official staker; holding them in the position would defer value with no economic purpose.

### Multiple positions per user

Each `unstake` creates a new `VestingPosition`. Users may have many simultaneously. `harvest` iterates all and compacts the exhausted ones via swap-and-pop.

### Official Uniswap staker, not own custody

The gauge is an **adapter** on top of the canonical `UniswapV3Staker` — does not reinvent NFT custody, does not duplicate `secondsInsideX128` logic. All in-range accounting belongs to the official staker. The gauge merely:

1. Keeps the internal real-owner ledger.
2. Forwards the NFT via `safeTransferFrom` with `IncentiveKey` in the calldata (staker auto-stakes on receive).
3. Applies 14d linear vesting to the withdrawn reward.
4. Maintains local whitelist/denylist and pause.

### Integration with RewardDistributorV2

Each `RewardDistributorV2.finalizeRound` mints `lpsAmount` (default 25% of emission), approves the gauge and calls `notifyRewardAmount(gaugePoolId, lpsAmount, gaugeIncentiveDuration)`. Creates a new incentive of `gaugeIncentiveDuration` seconds (default 7 days).

When the gauge is paused, `RewardDistributorV2` falls back to `Treasury.depositPendingGaugeRewards` — without that fallback, pausing the gauge would freeze `finalizeRound` for the entire round.

### Canonical Uniswap V3 addresses

- **Mainnet staker**: `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`.
- **Mainnet NPM**: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`.
- **Seed CREDIT/USDC pool**: 0.3% fee tier (`3000`) — D.1.

---

**See also**: [Treasury](04-Treasury.md), [RewardDistributorV2](07b-RewardDistributorV2.md), [CreditToken](02-CreditToken.md).
