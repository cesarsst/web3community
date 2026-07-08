# Tokenomics

**Audience:** anyone who wants to understand the distribution, emission, and supply dynamics of both tokens.
**Prerequisites:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

This page describes the tokens' economic architecture. **It is not a recommendation or a promise of appreciation.** All governance-adjustable parameters can change; ranges for adjustable parameters are hardcoded on-chain.

> **2026-07-08 remodel**: CREDIT stopped being deflationary/speculative and became **stable 1:1 with USDC** via [CreditPSM](../08-contracts-reference/15-CreditPSM.md). Investor income comes from a **rev-share of real revenue** ([ProjectFunding](../08-contracts-reference/16-ProjectFunding.md)), not from emission. The burn-to-mint mechanics below are marked as legacy.

## GOV — fixed supply

| Aspect | Value | Source |
|---|---|---|
| Supply cap | 100,000,000 GOV | `GovernanceToken.CAP_SUPPLY` (immutable) |
| Supply at deploy | 0 | `GovernanceToken` constructor |
| Emission | Exclusively via `mint(to, amount, tag)` by the owner | `GovernanceToken.mint` |
| Owner in production | `CommunityTimelock` | handoff via `transferOwnership` + `acceptOwnership` |

Each GOV in circulation can only exist if the Timelock (via approved proposal) called `mint`. The 100M cap can never be exceeded — the function reverts with `CapExceeded` if attempted.

### Planned distribution

Distribution is not done at deploy. GOV genesis is 0. The DAO decides via sequential proposals. The repository documents the typical initial proposal:

```
30%  Permanent Treasury            (30M)   - stays in Treasury, released via future proposals
25%  Team + early contributors      (25M)   - via TeamVesting contracts, 12m cliff + linear 36m
20%  Public sale / community        (20M)   - via sale contract (to be defined in proposal)
15%  Community rewards              (15M)   - liquidity mining / airdrops via UserSubsidy
10%  Liquidity                      (10M)   - LP provision in external DEX
----
100% (100M — reaches cap)
```

**These numbers are proposal intent, not automatic programming.** Each allocation is a separate proposal, voted individually. The DAO can adjust the proportions before executing each bucket.

> **Contracts pending design/deploy.** The distribution above describes **intent**, not current state of the repository. The `Sale` contract (public sale of the 20%), `LiquidityBootstrappingPool` / `LiquidityManager` (LP provisioning of the 10% on DEX), and `LPRewards` / liquidity-mining (for part of the 15% community bucket) **do not exist in the current repo** and must be designed, audited, and deployed before the corresponding proposals. `TeamVesting` exists (one instance per beneficiary) and `UserSubsidy` exists (singleton for Merkle campaigns), but they also depend on a proposal to be funded via a Treasury transfer. Until distribution proposal #2 executes, **0 GOV is in circulation** — 100% of the cap remains mintable by the Timelock. Proposed sequence of bootstrap proposals (after `acceptOwnership` by the Timelock):
>
> 1. Mint 30M GOV to the Treasury.
> 2. Deploy `TeamVesting` × N + mint 25M GOV distributed across instances via Treasury transfer.
> 3. Deploy `Sale` + mint 20M GOV to the sale contract.
> 4. Fund `UserSubsidy` (CREDIT from Treasury) + mint 15M GOV to the community bucket (LP mining / airdrops).
> 5. Deploy `LiquidityManager` + mint 10M GOV + initial DEX pool provisioning.
>
> Each proposal is independently reviewable. See `docs/en/09-advanced/02-mainnet-deployment.md` for the full operational procedure.

### TeamVesting

Each team member receives a separate `TeamVesting` instance. Typical parameters:

- `start` = TGE timestamp.
- `cliff` = 365 days.
- `duration` = 4 × 365 days (includes cliff; 12m cliff + 36m linear).

After cliff, releases `cliff/duration = 25%` at once ("hockey stick") and then linearly up to 100%. `release()` is pull — anyone can call, but tokens always go to `beneficiary`.

Revocation: `owner` (Timelock, via proposal) can revoke at any point. Freezes the boundary at `totalAllocatedAtRevoke = vestedAmount(now)` and returns the unvested to `returnTo`.

### There is no yield on GOV per se

Holding GOV idle in the wallet does **not** pay a reward. GOV only participates in the economy via:

- Staking in projects (generates weight — which since the remodel is the **investment gate** in `ProjectFunding`).
- Project listing collateral (locks GOV without generating reward).
- Voting on proposals (free).

GOV value capture is indirect and continuous: **40% of every payment's fee (= 1% of GMV) funds GOV buyback** via FeeRouterV2's `buybackRecipient`. The more real usage, the more buying pressure.

## CREDIT — stable 1:1 USDC (2026-07-08 remodel)

| Aspect | Value | Source |
|---|---|---|
| Peg | 1 CREDIT = 1 USDC, no fee, both directions | `CreditPSM.buy` / `sell` |
| Backing | 100% in USDC, held in the PSM, **no withdrawal function** (not even governance) | invariant I-PSM1 |
| Hardcoded supply cap | **Does not exist** — supply follows demand (mint on `buy`, burn on `sell`) | `CreditToken` has no cap |
| Minter in production | `CreditPSM` (`MINTER_ROLE`) | remodel deploy grant |
| Burner in production | `CreditPSM` (`BURNER_ROLE`, own balance only) | `sell` |
| Role | Means of payment (rail), **not** a speculative store of value | [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) |
| Genesis (legacy) | 10,000,000 CREDIT one-shot to the Treasury | `mintGenesis` with `genesisMinted` flag |
| Legacy minters | `RewardDistributor` V1/V2 (historical claims) | pre-remodel grants |

**Consequence for anyone evaluating exposure**: CREDIT is not an investment asset — it doesn't appreciate, doesn't drop, doesn't dilute. Investing in the protocol means (a) GOV (governance + buyback) and (b) rev-share positions in projects via `ProjectFunding` (income from real revenue). See [Value accrual](02-value-accrual.md).

### Emission formula (legacy)

> ⚠️ **LEGACY** — formula-driven emission belongs to the pre-remodel burn-to-mint model. There are no new emission rounds; the contracts stay deployed for historical claims.

In `RewardDistributor.finalizeRound`:

```
emission_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

With production parameters:

- `alpha = 0.95` (adjustable in `[0.5, 0.99]`). The range was reduced from `[0.5, 1.1]` to guarantee economic invariant IE1 (α < 1 permanent) by construction — governance can no longer vote an inflationary value. See `audit/economist/2026-04-22-consistency-audit.md` (C2) and `contracts/RewardDistributor.sol:117`.
- `capMax = 5,000,000 CREDIT` per round (adjustable in `[1, 100M] CREDIT`).
- `floorSchedule`: immutable, 24 decreasing values:

```
floor[0]  = 400,000 CREDIT
floor[1]  = 383,333 CREDIT
floor[2]  = 366,666 CREDIT
...
floor[23] = 16,666 CREDIT
floor[24+] = 0 (no entry)
```

Linear decay from 400k to ~16,666 over 24 rounds. In production (`roundDuration = 7 days`), this covers **~168 days ≈ 5.5 months** of bootstrap.

### Expected supply dynamics

**Current**: CREDIT supply = rail demand. It grows when users buy at the PSM to pay apps, shrinks when they redeem. Always covered by the backing (`backingNormalized() >= mintedOutstanding`). There is no deflationary or inflationary dynamic to model.

**Legacy (burn-to-mint)**: if usage was constant (burn = constant), `alpha < 1` implied emission < burn, and supply fell gradually.

> **Note about the simulation.** The repository has a 52-round, 3-scenario simulation in `scripts/simulation/`. In the base scenario, supply falls **~3.8%** and nominal staker APR stabilizes at ~34% in CREDIT. These values are **illustrative of the qualitative behavior** (sustained deflation with constant usage) in a hypothetical scenario with inflated supply (70.4M CREDIT initial, via `Charlie_seed = 60M` minted by a test shortcut at `scripts/simulation/economicSim.ts:72`) and 1M burn/round. In mainnet, operational supply **starts at 10M** (real genesis), and organic burn must be built from real app usage — absolute numbers do not promise mainnet behavior, only the qualitative dynamic.

If usage grows, absolute burn grows, absolute emission grows (until it saturates at `capMax`). In the first 24 rounds, the floor can keep emission even if burn collapses — after that, it cannot.

If usage dies, burn ~ 0, `floor(R)` dominates for 24 rounds, then zeroes.

## Subsidies — UserSubsidy

The `UserSubsidy` contract distributes pre-funded CREDIT to first users of the apps via Merkle drops.

Per-campaign parameters (proposed by the DAO):

- `merkleRoot` — root of the tree of eligible users.
- `amountPerUser` — CREDIT per claim.
- `maxClaims` — total cap of exercisable claims.
- `deadline` — until when they can claim.

The DAO funds the contract transferring `maxClaims × amountPerUser` of CREDIT from the Treasury before creating the campaign. Leftovers after `closeCampaign` go back to `returnTo` (typically Treasury).

## Rev-share funding — ProjectFunding (remodel)

The investment layer of the current model:

| Parameter | Value | Source |
|---|---|---|
| Rounds per project | 1 (MVP) | `RoundAlreadyExists` |
| Rev-share | 1% to 30% (100-3000 bps), chosen by the owner | `MIN_REV_SHARE_BPS` / `MAX_REV_SHARE_BPS` |
| Duration | 1 to 90 days | `MIN_ROUND_DURATION` / `MAX_ROUND_DURATION` |
| Minimum target | 100 CREDIT (default; governance-adjustable) | `minTarget` |
| Rule | All-or-nothing: target hit → owner is paid; expired without target → 100% refund | `invest` / `refund` |
| Gate | `invest` and `claim` require GOV staked on the project | `NoGovStaked` |
| Distribution | Pro-rata to shares (= invested CREDIT), MasterChef accumulator, claims never expire | `accRevenuePerShare` |

The rev-share is deducted from gross revenue on every `FeeRouterV2.pay` — after the 2.5% fee (250 bps; 40/40/20 split across treasury/buyback/grants; 500 bps hard cap), a project with a Funded round forwards its `revShareBps` to investors and keeps the rest (~89.5% with an 8% rev-share; 97.5% without a round).

## Floor decay — why 24 rounds (legacy)

The floor exists for **bootstrap** — to ensure positive emission while apps do not yet generate organic burn. 24 rounds × 7 days = **~168 days ≈ 5.5 months**. After that, the protocol needs to stand on its own.

Linear decay: `floor[R] = 400_000e18 - R * (400_000 / 24 * 1e18)`, rounded. The total summed is exactly **5M CREDIT** (analytical sum: `24 * 400_000 - (400_000/24) * 276 = 9.6M - 4.6M = 5M`, per `ignition/modules/Dao.ts:86-94`) — well below the genesis (10M). Designed as a safety net, not a closed budget.

## Per-round cap (capMax) (legacy)

Hard ceiling on total emission in any round. In production, 5M CREDIT. Adjustable within `[MIN_CAPMAX=1, MAX_CAPMAX=100M] CREDIT`.

Reason: even if burn is absurdly high (attack or one-off event), emission is clamped. This preserves predictability of the maximum supply.

## Sanity cap per (round, project) (legacy)

Parallel, more local, cap, enforced by `BurnTracker`:

- Production default: `10,000,000 CREDIT` per project per round.
- If `accumulated + amount > sanityCap`, `burnAndRecord` reverts with `SanityCapExceeded`.
- Governance can set it to 0 (disable) or adjust via proposal.

Reason: prevent a malicious project from burning absurd volume to capture disproportionate share.

## Probation penalty (25%) (legacy — only affects the emission rail)

Projects in initial (time-based) probation receive `projectShare / 4` in emission. The other 75% **are never minted** — they are not redistributed, `CREDIT.mint` is never called for that value, and `CreditToken.totalSupply()` is not affected (it is not `_burn`, it is simply a share division before the mint). Preserves the deflationary intent by subtracting emission, not by incineration.

In production, initial probation lasts 30 days. During that period, stakers in new projects capture 25% of what would be full.

## Summary of governance-adjustable parameters

Current rail (2026-07-08 remodel):

| Parameter | Contract | Allowed range | Production value |
|---|---|---|---|
| `feeBps` | FeeRouterV2 | `[0, 500]` (5% hard cap) | `250` (2.5%) |
| `feeSplit` | FeeRouterV2 | sum = 10,000 bps | `(4000, 4000, 2000)` — 40% treasury / 40% buyback / 20% grants |
| fee recipients | FeeRouterV2 | ≠ address(0) | Treasury (MVP: all three) |
| `minTarget` | ProjectFunding | `>= 0` | `100e18` (100 CREDIT) |

Legacy rail (burn-to-mint):

| Parameter | Contract | Allowed range | Production value |
|---|---|---|---|
| `alpha` | RewardDistributor | `[0.5e18, 0.99e18]` | `0.95e18` |
| `capMax` | RewardDistributor | `[1e18, 100M * 1e18]` | `5M * 1e18` |
| `roundDuration` | BurnTracker | `[1 day, 30 days]` | `7 days` |
| `maxBurnPerRoundPerProject` | BurnTracker | `[0, unlimited]` (0 = disables) | `10M * 1e18` |
| `minCollateral` | ProjectRegistry | `> 0` | `10,000 GOV` |
| `probationDuration` | ProjectRegistry | `> 0` | `30 days` |
| `defaultSplit` | FeeRouter | sum = 10,000 bps | `(7000, 2000, 1000)` — 70% burn / 20% treasury / 10% rebate (Phase 0) |
| `votingDelay` | Governor | `> 0` blocks | `7200` (~1d) |
| `votingPeriod` | Governor | `> 0` blocks | `50400` (~7d) |
| `proposalThreshold` | Governor | `>= 0` GOV | `10,000 GOV` |
| `quorumNumerator` | Governor | `[0, 100]` | `4` |
| `timelockMinDelay` | Timelock | `>= 0` sec | `172800` (2d) |

**Non-adjustable** parameters:

- GOV cap (`CAP_SUPPLY = 100M`, immutable).
- The 1:1 peg and the absence of backing withdrawal in the `CreditPSM` (no owner, no roles, no setters).
- `FEE_BPS_CAP = 500` (5%) in FeeRouterV2 — hard cap not even governance can exceed.
- `MIN_REV_SHARE_BPS = 100`, `MAX_REV_SHARE_BPS = 3000`, `MIN_ROUND_DURATION = 1 day`, `MAX_ROUND_DURATION = 90 days` in ProjectFunding.
- `MIN_LOCK = 14 days`, `MAX_LOCK = 365 days`, `MAX_MULTIPLIER = 4x` in Staking.
- `MIN_ROUND_DURATION`, `MAX_ROUND_DURATION` in BurnTracker (bounds).
- `MIN_ALPHA`, `MAX_ALPHA`, `MIN_CAPMAX`, `MAX_CAPMAX`, `FLOOR_SCHEDULE_LENGTH`, `PROBATION_PENALTY_DENOM` in RewardDistributor.
- `floorSchedule` (written in the constructor).
- Address of any contract (no upgrade path).

---

**Next →** [Value accrual](02-value-accrual.md)
