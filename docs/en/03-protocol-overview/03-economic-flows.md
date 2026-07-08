# Value flow

**Audience:** reader who wants to understand where real value enters, transits and exits the protocol.
**Prerequisites:** [CreditPSM](../08-contracts-reference/15-CreditPSM.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

> **2026-07-08 remodel**: this page describes the current flow (payment rail + rev-share). The old burn-to-mint flow appears at the end, marked as legacy.

## Where real value comes from

The only source of **external value** in the system is the end user paying for app services. They convert USDC into CREDIT because they need to use the apps. If nobody wants to use the apps, nobody buys CREDIT, and the system dies — that is the hard invariant, same as in the old model.

The post-remodel difference: **there is no pool, slippage or price risk at the entrance anymore**. The `CreditPSM` converts USDC ↔ CREDIT at 1:1, no fee, in both directions, with the backing 100% held in the contract.

A typical payment path:

```
   [ User Charlie ]
        |
        |  1. CreditPSM.buy(1000 USDC) -> 1000 CREDIT (1:1, no fee)
        |     (backing stays held in the PSM; redeemable at any time)
        v
   [ Charlie's wallet has 1000 CREDIT ]
        |
        |  2. Uses Chat App. App charges 1000 CREDIT for the service.
        |     Charlie signs approve(feeRouterV2, 1000) + pay(42, 1000)
        |
        v
   [ FeeRouterV2 ]
        |
        | 2.5% fee (250 bps; 5% hard cap) + project rev-share
        |
        +-------> fee 25 CREDIT:
        |            10 -> Treasury      (40% of the fee = 1.0% of GMV)
        |            10 -> GOV buyback   (40% of the fee = 1.0% of GMV)
        |             5 -> grants        (20% of the fee = 0.5% of GMV)
        |
        +-------> rev-share 80 CREDIT (if a Funded round at 8%)
        |            -> ProjectFunding, pro-rata to investors
        |
        +-------> toApp 895 CREDIT (~89.5%) -> app owner, INSTANTLY
                     (97.5% if the project never raised a round)
```

**Real value entered the protocol in step 1** (USDC into the PSM backing). All subsequent steps redistribute fully backed CREDIT — nothing is burned, nothing is minted out of thin air.

## The 5 agents and why each is in the game

With the remodel, the **investor** (GOV staker + CREDIT funder) replaces the LP as the formal capital agent.

```
   +----------+    +-------------+    +--------------+    +------------+    +-----------+
   |   End    |    |    App      |    |  Investor    |    | GOV holder |    | Treasury/ |
   |   User   |    | (ChatApp)   |    |  (Alice:     |    |            |    | DAO       |
   |          |    |             |    |  GOV+CREDIT) |    |            |    |           |
   +----+-----+    +------+------+    +------+-------+    +-----+------+    +-----+-----+
        |                 |                  |                  |                 |
   pays in CREDIT    receives ~89.5-     stakes GOV on      voting power     receives 40%
   (stable 1:1;      97.5% of revenue    the project        in Governor;     of the fee
   buys/redeems      INSTANTLY +         (gate) + invests   GOV captures     (1% of GMV)
   at the PSM, no    upfront capital     CREDIT in the      value via        for opex;
   slippage)         from the funding    round; earns %     continuous       PSM backing
        |            round               of REAL revenue    buyback (40%     is SEGREGATED
   extracts value         |              on every payment   of fee = 1%      (not the
   from a service    grows with              |              of GMV)          treasury's)
   (outside the      capital that does       |                  |                |
   protocol)         not dilute equity       |                  |                |
```

Note: **there is no yield "from thin air"**. The CREDIT Alice receives exists because Charlie paid for the service — it is a slice of real revenue, not emission. No actor receives value that did not come from some upstream actor.

## What the app earns (and what it costs)

### Direct revenue, instantly

- **Without a funding round**: 97.5% of every payment (2.5% fee).
- **With a funded round** (e.g., 8% rev-share): ~89.5% of every payment, straight to the wallet, same block.

Compare: Stripe charges ~3.8%, app stores 15-30%. The old (legacy) model handed the app only 10% nominal of each payment (~38% effective with staking) — the `audit/economist/2026-07-08-feerouter-bypass.md` analysis showed that under that design bypassing was the dominant strategy.

### Upfront capital without diluting equity

The owner opens a round in `ProjectFunding`: target in CREDIT, 1-30% rev-share, 1-90 day deadline, all-or-nothing. If the target is hit, they receive the raise immediately and start "paying" via rev-share on future revenue.

**Illustrative cost of capital**: a 10,000 CREDIT round at an 8% rev-share, with 2,000 CREDIT/month GMV → 160 CREDIT/month to investors = 1,920/year ≈ **19% p.a.** on the raise. Comparable to revenue-based financing (Pipe, Clearco: 15-25%) — and the "interest" only exists if there is revenue: no GMV, no transfer (and no debt piling up).

### Hub and user base

Listing in the Registry grants access to the hub's user base, discovery and ready payment infrastructure (PSM + FeeRouterV2) — no acquirer integration, no chargebacks.

## What the investor earns

1. **Stakes GOV on the project** (gate + curation; the lock multiplier still applies to weight).
2. **Invests CREDIT in the round** (shares 1:1 with the invested amount).
3. **Receives % of gross revenue on every payment** — accrued on-chain, `claim` at any time (requires keeping the GOV staked; never expires).

**Illustrative yield** (not a promise): a 10,000 round at 8% with 2,000/month GMV → 19.2% p.a.; a 50,000 round at 12% with 5,000/month GMV → 600/month = 14.4% p.a. All verifiable on-chain: `grossVolumeOf` (GMV), `totalRevenueDistributed` (revenue already paid), `pendingRevenue` (claimable). The received CREDIT is stable — redeemable 1:1 at the PSM at any time.

**Risk**: if the round misses its target, full refund (all-or-nothing). Once Funded, the return depends 100% on the app's real revenue — a project that dies pays nothing. The invested principal is not returned — what you buy is the rev-share stream.

## Per-round flow (legacy)

> ⚠️ **LEGACY** — the burn/emission round cycle below belongs to the pre-remodel model.

```
   Round R-1 (the past one)                                  Round R (now)
   +------------------------------------+                   +------------------------------------+
   | Charlie + 10k other users            |                  | Alice can claim R-1 rewards based  |
   | paid in CREDIT inside the apps       |                  | on:                                |
   |                                     |                  |   - R-1 total burn                 |
   | BurnTracker recorded:               |  closeRound()    |   - her project's R-1 burn         |
   |   totalBurnByRound[R-1] = 950_000   |  --------->      |   - her stake weight               |
   |   burnByRoundProject[R-1][42] = 600_000                |                                    |
   +------------------------------------+                   +------------------------------------+
                                                                     |
                                                               finalizeRound(R-1)
                                                                     |
                                                                     v
                                                            emission = min(
                                                                max(0.95 * 950_000, floor(R-1)),
                                                                capMax
                                                            ) = 902_500 CREDIT (in the example)

                                                            roundData[R-1].totalEmission = 902_500
                                                            roundData[R-1].snapshotBlock = block.number
                                                            bucketEmissionByRound[R-1][stakers] = 55% * 902_500 = 496_375

                                                            Stakers can claim (base = stakers bucket, NOT total emission):
                                                              project_share(42) = 496_375 * 600k/950k = 313_500
                                                              alice_claim = 313_500 * aliceW/projectW
```

## CREDIT rotation

In the current model, CREDIT enters and exits supply through the **PSM**:

1. **Enters**: `CreditPSM.buy` — mints 1:1 against deposited USDC (backing held).
2. **Exits**: `CreditPSM.sell` — burns 1:1 and returns USDC.

CREDIT supply is therefore **elastic but always backed**: it grows when there is payment demand in the apps, shrinks when users redeem. There is no discretionary emission and no value burn.

```
   totalSupply ~= mintedOutstanding <= PSM's USDC backing (normalized)
```

Legacy paths (pre-remodel, still present in the code): `mintGenesis` (historical one-shot of 10M to the Treasury), `mint` by the RewardDistributors (historical claims) and `burnByRole` via BurnTracker (burn rail de facto inactive — FeeRouterV2 burns nothing).

## GOV rotation

GOV permanently enters supply until it reaches the cap:

1. Genesis: 0 on deploy.
2. `mint`: only by the owner (Timelock in production) until reaching `CAP_SUPPLY = 100M`.
3. After hitting the cap, `mint` reverts with `CapExceeded`.

There is no GOV burn in the code.

Circulation:

- **Free holder** -> buy/sell on DEX.
- **Holder -> Staking**: `stake` locks GOV in the contract; `unstake` releases.
- **Holder -> Registry**: `registerProject` locks GOV as collateral; `removeProject` releases (to owner or treasury).
- **Holder -> TeamVesting (via Timelock)**: vesting contracts releasing gradually.
- **Holder -> Governor**: `delegate` does not move GOV, only confers voting power.
- **Continuous buyback (remodel)**: 40% of every payment's fee (= 1% of GMV) goes to FeeRouterV2's `buybackRecipient`, funding GOV repurchase — buying pressure proportional to real usage.

## The Treasury's role in this flow (post-remodel)

The Treasury is the DAO's **operating cash box**. It:

- Receives **40% of the FeeRouterV2 fee** (= 1% of GMV) on every payment — recurring revenue, proportional to usage.
- Receives slash collateral from removed projects.
- Keeps the legacy (historical CREDIT genesis, CLP ledgers).

**Important**: the PSM's USDC backing is **segregated** — it is not the Treasury's and there is no function to move it. The DAO spends from the fee, never from the backing.

And distributes, via proposals:

- Subsidies for new users (`UserSubsidy`).
- Vesting for the team (`TeamVesting`).
- Funding for off-chain operations (opex).

Besides the Treasury, the fee feeds two more configurable destinations in the router: `buybackRecipient` (40% — continuous GOV repurchase) and `grantsRecipient` (20% — ecosystem grants). In the dev MVP all three recipients point to the Treasury; the `PaymentRouted` events carry the per-slice breakdown regardless.

> **Legacy (post-CLP, pre-remodel)**: the Treasury's three old loops — FFP CREDIT buyback, POL refill and gauge fallback — belong to the burn-to-mint rail and are described in the [Treasury](../08-contracts-reference/04-Treasury.md) and [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md) pages. With CREDIT stable via the PSM, floor defense and pool liquidity are no longer needed.

## Health invariant

Protocol-health signals in the current model:

1. **Rising GMV**: `grossVolumeOf` summed across projects (or indexing `PaymentRouted`) growing over calendar periods. It is the single source of everything: app revenue, investor income, protocol fee.
2. **Rising distributed revenue**: `totalRevenueDistributed` per project — rev-share actually paid to investors.
3. **PSM backing intact**: `backingNormalized() >= mintedOutstanding` — invariant I-PSM1, verifiable by anyone at any time.
4. **Funding rounds closing successfully**: a high Funded/Failed ratio indicates investors trust the listed projects.

The terminal symptom is the same as in the old model: **GMV at zero for a long time** — without real usage, there is no revenue for anyone.

Full metrics in [Metrics that matter](../06-for-investors/04-metrics-that-matter.md).

---

**Next ->** [How to participate](../04-for-users/01-participate.md)
