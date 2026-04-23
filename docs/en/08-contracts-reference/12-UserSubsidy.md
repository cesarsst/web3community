# UserSubsidy

**Audience:** apps creating subsidy campaigns, auditors, eligible users.
**Prerequisites:** [Tokenomics](../06-for-investors/01-tokenomics.md).

## Quick overview

Distributes pre-funded CREDIT to first users of the apps via Merkle drops with a claims cap. Subsidizes **demand** (not supply) during bootstrap (~6 months), until organic burn sustains emission via `RewardDistributor`.

Multiple simultaneous campaigns with monotonic IDs, one per app/round. The DAO approves root + budget via proposal; eligible users claim via Merkle proof.

## Inheritance

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Uses `SafeERC20`, `MerkleProof`.

## Parameters and storage

| Name | Type | Description |
|---|---|---|
| `credit` | `IERC20` immutable | CreditToken |
| `nextCampaignId` | uint256 | Monotonic counter |
| `campaigns` | mapping | `id → Campaign` |
| `hasClaimed` | mapping | `id → user → bool` |

### Struct `Campaign`

```solidity
struct Campaign {
    bytes32 merkleRoot;
    uint128 amountPerUser;
    uint64 deadline;
    uint64 createdAt;
    uint32 maxClaims;
    uint32 claimed;
    bool closed;
}
```

Packed into 3 slots.

## Roles and permissions

| Role | In production |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## External functions

### Governance-gated

#### `createCampaign(bytes32 merkleRoot, uint128 amountPerUser, uint32 maxClaims, uint64 deadline) → uint256 campaignId`

Opens a new campaign. Does **not** move funds — the DAO must transfer `maxClaims × amountPerUser` of CREDIT to this contract in a separate call of the same proposal.

- **Reverts**: `ZeroRoot`, `ZeroAmount`, `ZeroMaxClaims`, `DeadlineInPast`.
- **Events**: `CampaignCreated(campaignId, merkleRoot, amountPerUser, maxClaims, deadline)`.

#### `closeCampaign(uint256 campaignId, address returnTo)`

Closes the campaign and returns leftovers to `returnTo` (typically Treasury).

- **Reverts**: `ZeroAddress`, `CampaignNotFound`, `CampaignAlreadyClosed`.
- **Events**: `CampaignClosed(campaignId, returnedTo, unclaimedReturned)`.

Computes `remainingBudget = (maxClaims - claimed) * amountPerUser`.

### User-facing

#### `claim(uint256 campaignId, bytes32[] calldata proof)`

Exercises the claim. `msg.sender` is always the recipient.

- **Reverts**: `CampaignNotFound`, `CampaignAlreadyClosed`, `CampaignExpired`, `AlreadyClaimed`, `CapReached`, `InvalidProof`.
- **Events**: `Claimed(campaignId, user, amount)`.

Expected leaf:

```solidity
leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))
```

Standard OZ double-hash against second-preimage in intermediate nodes.

### Views

- `campaigns(uint256 id) → Campaign`.
- `hasClaimed(uint256 id, address user) → bool`.
- `isEligible(uint256 campaignId, address user, bytes32[] proof) → bool` — without consuming the claim.

## Events

| Event | Indexed |
|---|---|
| `CampaignCreated(campaignId, merkleRoot, amountPerUser, maxClaims, deadline)` | `campaignId` |
| `Claimed(campaignId, user, amount)` | `campaignId`, `user` |
| `CampaignClosed(campaignId, returnedTo, unclaimedReturned)` | `campaignId`, `returnedTo` |

## Custom errors

| Error | When it occurs |
|---|---|
| `ZeroAddress()` | `credit`, `admin` or `returnTo` zero |
| `ZeroAmount()` | `amountPerUser == 0` |
| `ZeroRoot()` | `merkleRoot == 0` |
| `ZeroMaxClaims()` | `maxClaims == 0` |
| `DeadlineInPast()` | `deadline <= block.timestamp` |
| `CampaignNotFound()` | ID does not exist |
| `CampaignAlreadyClosed()` | Campaign closed |
| `CampaignExpired()` | `now > deadline` |
| `AlreadyClaimed()` | User already claimed |
| `CapReached()` | `claimed >= maxClaims` |
| `InvalidProof()` | Proof does not validate against root |

## Invariants

- **Merkle root gate**: only addresses in the Merkle tree can claim.
- **Per-campaign cap**: `claimed <= maxClaims` always.
- **One-claim-per-user**: `hasClaimed[id][user]` blocks re-claim.
- **msg.sender = recipient**: claim always goes to whoever signed.
- **CEI**: checks → effect (`hasClaimed = true`, `claimed++`) → interaction (`safeTransfer`).
- **ReentrancyGuard**: `claim` and `closeCampaign`.

## Important notes

### Merkle (not per-app signature)

Keeps the app off-chain — any "who is a real user" selector (wallets with interactions > X, time > Y) is computed off-chain, and only the compacted root goes on-chain via proposal. The DAO approves the root, not the selection logic.

### Double-hash leaf

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(user))))
```

OZ standard to prevent second-preimage in intermediate nodes (an internal 64-byte node could coincide with a single-hash of `abi.encode(address)`).

### Implicit budget

Contract does **not** reserve balance per campaign separately. The DAO must transfer `maxClaims × amountPerUser` before creating. If balance runs out (e.g., multiple campaigns sharing a pool), `claim` reverts at `safeTransfer` — the DAO needs to refund.

Why? Tokens are fungible, the overhead of "reserving" does not bring a real guarantee against mis-funding.

### `closeCampaign` before deadline

Allowed — emergency scenarios (compromised merkle, sybil list discovered). Governance-gated + timelock-gated (2d), so users have 2 days of warning before the close takes effect.

### `msg.sender` = mandatory recipient

No `to` parameter. Prevents "claim on behalf of someone else", which combined with large lists would become a tool for a sybil operator to claim from inattentive users.

Relayer/AA wanting gasless claim uses `msg.sender` of the user's account — recipient is always the same account that signed.

### `isEligible` — useful view for UI

Checks eligibility without consuming the claim. Returns `true` if (exists) + (not closed) + (within deadline) + (not claimed yet) + (cap not reached) + (proof valid).

### `credit` immutability

Set in the constructor. Simplifies mental model (one UserSubsidy = one token) and removes the swap-token-on-the-fly vector.

---

**See also**: [Treasury](04-Treasury.md), [CreditToken](02-CreditToken.md).
