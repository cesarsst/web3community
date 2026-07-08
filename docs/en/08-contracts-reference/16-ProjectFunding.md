# ProjectFunding

**Audience:** project owners raising capital, investors (GOV stakers), auditors.
**Prerequisites:** [FeeRouterV2](08b-FeeRouterV2.md), [Staking](05-Staking.md), [ProjectRegistry](03-ProjectRegistry.md).

## Quick view

Per-project fundraising + revenue redistribution (2026-07-08 remodel). Replaces inflationary CREDIT emission as the investor's income source: whoever funds a project buys the right to a slice (`revShareBps`) of its **future gross revenue**, paid automatically by [FeeRouterV2](08b-FeeRouterV2.md) on every payment.

Cycle:

```
1. The Active project's owner opens ONE round:
   openRound(projectId, target in CREDIT, revShareBps 1-30%, duration 1-90 days)
        |
2. Investors with GOV staked ON the project deposit CREDIT
   invest(projectId, amount)          [shares = invested CREDIT, 1:1]
        |
        +-- target hit    --> finalizes automatically: owner receives
        |                     the raise, rev-share activates   (Funded)
        +-- deadline past --> closeExpiredRound (permissionless)
                              refund returns 100%              (Failed)
3. On every FeeRouterV2 payment:
   notifyRevenue(projectId, revShare) --> per-share accumulator
        |
4. Investor withdraws with claim(projectId)
   (requires keeping GOV staked on the project; claims never expire)
```

**All-or-nothing**: the round only pays the owner if the target is hit — protects the investor from half-funding an unviable project. **Skin in the game**: both `invest` and `claim` require `Staking.getWeight(investor, projectId) > 0`.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Uses `SafeERC20`.

## Parameters and storage

| Name | Type | Description |
|---|---|---|
| `MIN_REV_SHARE_BPS` | constant | **100** (1%) |
| `MAX_REV_SHARE_BPS` | constant | **3000** (30%) |
| `MIN_ROUND_DURATION` | constant | **1 day** |
| `MAX_ROUND_DURATION` | constant | **90 days** |
| `ACC_PRECISION` | constant | `1e18` (accumulator precision) |
| `CREDIT` | immutable | CreditToken |
| `REGISTRY` | immutable | ProjectRegistry |
| `STAKING` | immutable | Staking |
| `minTarget` | `uint256` | Minimum round target (anti-spam), default `100e18`; governance-adjustable |
| `rounds` | mapping | Each project's (single) round |
| `sharesOf` | mapping | Investor shares (== invested CREDIT) per project |
| `accRevenuePerShare` | mapping | Revenue-per-share accumulator (MasterChef pattern) |
| `rewardDebt` | mapping | Investor checkpoint against the accumulator |
| `totalRevenueDistributed` | mapping | Total revenue already distributed per project (audit/UI) |

### Enum `RoundStatus` and struct `Round`

```solidity
enum RoundStatus { None, Open, Funded, Failed }

struct Round {
    uint256 target;      // target in CREDIT (18d)
    uint256 raised;      // raised so far
    uint64 deadline;     // limit timestamp
    uint16 revShareBps;  // offered slice of gross revenue
    RoundStatus status;
}
```

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` (adjusts `minTarget`) |
| `REVENUE_NOTIFIER_ROLE` | `FeeRouterV2` — only address authorized to `notifyRevenue` |

## External functions

### `openRound(uint256 projectId, uint256 target, uint16 revShareBps, uint64 duration)`

Opens the project's fundraising round. Owner only (Registry), Active project, **one round per project** (MVP).

- **Reverts**: `ProjectNotActive`, `NotProjectOwner`, `RoundAlreadyExists`, `RevShareOutOfBounds` (outside 100-3000 bps), `TargetOutOfBounds` (below `minTarget`), `DurationOutOfBounds` (outside 1-90 days).
- **Events**: `RoundOpened(projectId, target, revShareBps, deadline)`.

### `invest(uint256 projectId, uint256 amount)`

Invests CREDIT in the open round. **Requires GOV staked on the project.** No overshoot: `amount` cannot exceed what remains to the target. If the target is hit, the round finalizes automatically (pays the owner, activates the rev-share).

- **Reverts**: `RoundNotOpen` (includes expired deadline), `ZeroAmount`, `NoGovStaked`, `ExceedsTarget`.
- **Events**: `Invested(projectId, investor, amount, totalRaised)`; if the target was hit, also `RoundFunded(projectId, raised, paidTo)`.

### `closeExpiredRound(uint256 projectId)`

Closes a round whose deadline passed without hitting the target (→ `Failed`). **Permissionless** — anyone can "stamp" the failure.

- **Reverts**: `RoundNotOpen`, `RoundStillOpen` (deadline not yet past).
- **Events**: `RoundFailed(projectId, raised)`.

### `refund(uint256 projectId)`

Returns 100% of the investment in a `Failed` round.

- **Reverts**: `RoundNotFailed`, `NothingToRefund`.
- **Events**: `Refunded(projectId, investor, amount)`.

### `notifyRevenue(uint256 projectId, uint256 amount)`

Receives the rev-share slice of a payment. **FeeRouterV2 only** (`REVENUE_NOTIFIER_ROLE`). The router already transferred the CREDIT beforehand; here only the accumulator is updated: `accRevenuePerShare += amount * 1e18 / raised` and `totalRevenueDistributed += amount`.

- **Reverts**: `ZeroAmount`, `NoActiveShares` (round not Funded).
- **Events**: `RevenueNotified(projectId, amount)`.

### `claim(uint256 projectId) → uint256 amount`

Withdraws the investor's accumulated revenue in the project. **Requires GOV still staked on the project** (skin in the game). The value **never expires** — without stake it simply stays accrued until the investor re-stakes.

- **Reverts**: `NoGovStaked`, `NothingToClaim`.
- **Events**: `RevenueClaimed(projectId, investor, amount)`.

### Governance-gated

#### `setMinTarget(uint256 newMin)`

- **Events**: `MinTargetUpdated(previous, current)`.

### Views

- `revShareBpsOf(uint256 projectId) → uint16` — active rev-share (0 if not `Funded`); consumed by FeeRouterV2 on every `pay`.
- `pendingRevenue(uint256 projectId, address investor) → uint256` — revenue pending claim.
- `rounds(projectId)`, `sharesOf(projectId, investor)`, `accRevenuePerShare(projectId)`, `rewardDebt(projectId, investor)`, `totalRevenueDistributed(projectId)` — public getters.

## Events

| Event | Indexed |
|---|---|
| `RoundOpened(projectId, target, revShareBps, deadline)` | `projectId` |
| `Invested(projectId, investor, amount, totalRaised)` | `projectId`, `investor` |
| `RoundFunded(projectId, raised, paidTo)` | `projectId`, `paidTo` |
| `RoundFailed(projectId, raised)` | `projectId` |
| `Refunded(projectId, investor, amount)` | `projectId`, `investor` |
| `RevenueNotified(projectId, amount)` | `projectId` |
| `RevenueClaimed(projectId, investor, amount)` | `projectId`, `investor` |
| `MinTargetUpdated(previous, current)` | — |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAmount()` / `ZeroAddress()` | Zero value/address |
| `ProjectNotActive(projectId)` | `openRound` with a non-Active project |
| `NotProjectOwner(projectId, caller)` | `openRound` without being the owner |
| `RoundAlreadyExists(projectId)` | Second round for the same project |
| `RoundNotFound(projectId)` | Nonexistent round |
| `RoundNotOpen(projectId)` | `invest`/`closeExpiredRound` outside the Open state |
| `RoundStillOpen(projectId)` | `closeExpiredRound` before the deadline |
| `RoundNotFailed(projectId)` | `refund` without a Failed round |
| `RevShareOutOfBounds(provided, min, max)` | Outside `[100, 3000]` bps |
| `TargetOutOfBounds(provided, min)` | Target below `minTarget` |
| `DurationOutOfBounds(provided, min, max)` | Outside `[1 day, 90 days]` |
| `NoGovStaked(projectId, investor)` | `invest`/`claim` without GOV staked on the project |
| `ExceedsTarget(requested, remaining)` | `invest` above what remains to the target |
| `NothingToRefund(projectId, investor)` | `refund` with no shares |
| `NothingToClaim(projectId, investor)` | `claim` with no pending revenue |
| `NoActiveShares(projectId)` | `notifyRevenue` without a Funded round |

## Invariants

- **One successful round per project** (MVP). Subsequent rounds would require stacking share pools with distinct bps — documented for V2.
- **Shares = invested CREDIT** (1:1, immutable after finalize).
- **All-or-nothing**: the owner only gets paid if `raised == target`; an expired round without the target → full refund.
- **O(1) distribution**: `accRevenuePerShare` accumulator (MasterChef pattern, 1e18 precision) — O(1) per payment, O(1) per claim.
- **GOV gate**: `invest` and `claim` require `STAKING.getWeight(msg.sender, projectId) > 0`. Without stake, the value is **not lost** — it stays accrued until re-stake.
- **Immutable bounds**: rev-share `[1%, 30%]` and duration `[1, 90] days` are constants.

## Important notes

### Why require staked GOV

The gate materializes the requirement "whoever has GOV at stake receives the redistribution": the CREDIT investor must also hold long-term exposure to the project (GOV locked via [Staking](05-Staking.md)). This aligns funding with curation — those who fund are those who already signaled conviction.

### Transparent yield

The investor's return is computable on-chain: `totalRevenueDistributed[projectId] / rounds[projectId].raised` gives the cumulative return per invested unit; annualize by the round's age. Combine with FeeRouterV2's `grossVolumeOf[projectId]` to estimate future revenue. See [Metrics that matter](../06-for-investors/04-metrics-that-matter.md).

---

**See also**: [FeeRouterV2](08b-FeeRouterV2.md), [CreditPSM](15-CreditPSM.md), [Staking](05-Staking.md), [ProjectRegistry](03-ProjectRegistry.md).
