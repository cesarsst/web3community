# Value flow

**Audience:** reader who wants to understand where real value enters, transits and exits the protocol.
**Prerequisites:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Treasury and fees](../02-core-concepts/07-treasury-and-fees.md).

## Where real value comes from

The only source of **external value** in the system is the end user paying for CREDIT. They pay because they need to use the apps. If nobody wants to use the apps, nobody buys CREDIT, and the system dies — that is the hard invariant.

Liquidity for the CREDIT/USDC pair is built by two complementary paths in the Credit Liquidity Protocol (CLP):

1. **POL** — Protocol-Owned Liquidity. The Treasury itself custodies an NFT position in the pool. Built by (a) initial seed of genesis CREDIT + Treasury USDC, (b) refill via the bonders bucket + USDC from `treasuryBps`.
2. **External LPs** — users who provide liquidity in the pool and stake the NFT in `LiquidityGauge`. Receive CREDIT incentives (V2 LPs bucket, default 25% of emission).

A typical payment path:

```
   [ User Charlie ]
        |
        |  1. Buys 1000 CREDIT on the DEX (POL + external LPs supply liquidity)
        |
        v
   [ Charlie's wallet has 1000 CREDIT ]
        |
        |  2. Uses Chat App. App charges 1000 CREDIT for the service.
        |     Charlie signs approve(feeRouter, 1000) + feeRouter.pay(...)
        |
        v
   [ FeeRouter ]
        |
        | default split 95/0/5 (CLP recommendation: 70/20/10)
        |
        +-------> burnBps burned (via BurnTracker)
        |         - CREDIT.totalSupply decreases
        |         - burn recorded in BurnTracker for the Chat App
        |
        +-------> treasuryBps -> Treasury (USDC funding for POL refill)
        |
        +-------> rebateBps -> app owner (direct rebate)
```

**Real value entered the protocol in step 1.** All subsequent steps redistribute that value.

## The 5 agents and why each is in the game

With the CLP pivot, the **LP** enters as a formal agent — previously only external, now receives a dedicated bucket.

```
   +----------+    +-------------+    +----------+    +----------+    +------------+
   |   End    |    |    App      |    |  Staker  |    |    LP    |    |   Holder   |
   |   User   |    | (ChatApp)   |    |  (Alice) |    |   (Bob)  |    | no staking |
   +----+-----+    +------+------+    +----+-----+    +----+-----+    +-----+------+
        |                 |                |               |                |
   pays in CREDIT    receives rebate   locks GOV in    LP in the         voting power
   uses the app      + apps bucket     projectId      CREDIT/USDC pool  in the Governor
                     (retrospective    earns stakers   + stakes NFT
                      direct push      bucket          in LiquidityGauge
                      via burn)        (claim)         earns LPs bucket
                                                       (14d vesting)
        |                 |                |               |                |
   extracts value    captures cash      earns freshly   earns freshly    keeps right
   from a service    + push emission    minted CREDIT   minted CREDIT    over parameter
   (outside the      (apps bucket)      on claim        on harvest       changes
   protocol)                            (stakers)       (LPs bucket)
```

Note: **there is no yield "from thin air"**. The CREDIT minted for Alice (staker), Bob (LP) and ChatApp (apps bucket) exists because Charlie burned CREDIT. No actor receives value that did not come from some upstream actor.

## The 4 revenue sources of an app

The 10% direct default split looks small. But the math closes — especially if the app also stakes on its own project — through simultaneous vectors:

### (A) Direct rebate

10% of every payment (`rebateBps = 1000`). Instant, in CREDIT. The operational cash flow.

### (B) Apps-bucket push

15% of each round's emission (`bucketBps[apps] = 1500` in `RewardDistributorV2`) is minted **directly** to each project's `ownerRecipient` in `finalizeRound`, proportional to the burn the project generated in the previous round. It requires neither stake nor claim — it is a retrospective push by burn.

### (C) Emission via stake on its own `projectId`

If the app acquired GOV (e.g., by buying on a DEX or receiving via a distribution proposal) and staked on `projectId = self`, it captures part of that project's reward share in the next round.

How?

1. When Charlie pays, 70% is burned and goes to `burnByRoundProject[R][projectId=app]`.
2. In round R+1, emission is proportional to that burn — and the **stakers bucket (55% of emission)** is split across projects by burn.
3. If the app has staking weight inside its own `projectId`, it receives part of that share.

**Numerical example** (hypothetical round):

- ChatApp moves 600,000 CREDIT in payments in round R-1.
- (A) Direct rebate: 10% × 600k = **60,000 CREDIT** instant.
- ChatApp's burn: 70% × 600k = 420,000 CREDIT in `burnByRoundProject[R-1][42]`. Suppose the round's total burn = 950,000 (other apps sum the rest) → emission of round R = 0.95 × 950k = 902,500 CREDIT.
- (B) Apps bucket: 15% × 902,500 = 135,375; ChatApp's push = `135,375 × 420k/950k` = **59,850 CREDIT** (directly in `finalizeRound`, no stake).
- (C) Stakers bucket: 55% × 902,500 = 496,375; `projectShare_ChatApp = 496,375 × 420k/950k = 219,450 CREDIT`. If ChatApp staked 50k GOV with a 365d lock (4x multiplier, 200k weight), and total weight in the project is 400k, it captures 50% × 219,450 = **109,725 CREDIT**.
- Sum (A) + (B) + (C) = **229,575 CREDIT** out of a gross volume of 600k = **~38.3%** effective.

The **nominal** split tells a misleading story. The **economic effective** split for an app that also stakes depends on how much it stakes and on the competition from other stakers in the same `projectId`.

### (D) Appreciation of retained CREDIT

Since `alpha < 1`, CREDIT supply falls if usage stays constant. The CREDIT the app received (rebate + rewards) and has not yet sold tends to appreciate in real terms — provided demand for CREDIT (generated by app usage) is sustained.

**Trap**: if the app sells all CREDIT immediately, it gives up (C). If it retains, it is exposed to volatility. App's choice.

## When (C) does not close the math

Apps without capital to acquire GOV cannot capture (C) — they are left with (A) and (B). For those cases:

- If the 10% rebate + apps-bucket push still do not close the math, the DAO can approve `setProjectSplit(projectId, custom)` via proposal. For example: `8000/0/2000` (20% rebate) for strategic apps that cannot stake.
- Alternatively, an initial GOV acquisition can be funded via `Treasury` (direct transfer proposal).

The architecture allows per-project tuning precisely for this kind of accommodation.

## Per-round flow

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

CREDIT enters supply via **two** paths only:

1. `CreditToken.mintGenesis` — one-shot, 10M to Treasury, on deploy.
2. `CreditToken.mint` — by `RewardDistributor`, on claims.

And exits via **one** path:

- `CreditToken.burn` / `burnFrom` / `burnByRole` — main path is via `FeeRouter.pay` -> `BurnTracker.burnAndRecord` -> `CreditToken.burnByRole`.

This closed flow allows simple analysis:

```
   totalSupply_R = totalSupply_{R-1} + (new emissions in R) - (burns in R)
```

If `new emissions <= burns`, supply falls. With `alpha = 0.95` and stable usage, that is the expected dynamic.

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

## The Treasury's role in this flow (post-CLP)

The Treasury is the **buffer** of the system. It:

- Receives the genesis CREDIT (10M).
- May receive `treasuryBps` of payments (CLP recommendation: raise from 0% to 20%).
- Receives slash collateral from removed projects.
- **Receives the bonders bucket** from `RewardDistributorV2` (5% of per-round emission — `polRefillBucket` ledger).
- **May receive the LPs bucket** when gauge paused (`pendingGaugeRewards` ledger).

And distributes, via proposals:

- **Executes FFP buyback** — USDC -> CREDIT swap + immediate burn, defending the floor.
- **Provisions POL** — `addPOL` / `addPOLFromRefill`.
- Subsidies for new users (`UserSubsidy`).
- Vesting for the team (`TeamVesting`).
- Batch rebate payments to apps.
- Funding for off-chain operations.

The Treasury is **not** distributed automatically — everything leaves via proposal. But from CLP onwards, the Treasury runs three economic loops (in addition to mere custody):

1. **FFP loop**: `recordDailyPrice` (keeper) -> MA90 grows -> spot < floor for 24h -> governance proposes `executeBuyback` -> USDC->CREDIT swap -> burn -> `totalSupply` falls -> price pressed up.
2. **POL refill loop**: `treasuryBps` brings USDC -> bonders bucket brings CREDIT -> governance proposes `addPOLFromRefill` -> liquidity in the pool grows -> lower slippage for holders.
3. **Gauge fallback loop**: `RewardDistributorV2` detects gauge paused -> mint to Treasury -> governance unpauses gauge -> `flushPendingGaugeRewards` ships accumulated CREDIT back as incentive.

## Health invariant

A simple protocol-health signal: **cumulative burn must grow faster than cumulative emission** over rounds. Since `alpha < 1` guarantees `emission_R ≈ 0.95 × burn_{R-1}`, this inequality is automatically satisfied while:

```
burn_R >= burn_{R-1}
```

That is: the protocol is healthy as long as real usage holds or grows. If burn drops, emission drops alongside, but the `emission/burn` ratio stays at `alpha`. The terminal symptom is absolute burn going to zero across many consecutive rounds.

Post-CLP, two additional signals:

- **Rising CREDIT MA90** — indicates healthy pricing; the relative floor (`0.5 × MA90`) follows. If spot drops below the floor for 24h, FFP buyback is proposed.
- **Rising POL TVL** — Treasury accumulates own liquidity. Larger POL = lower slippage for holders and less dependence on external LPs to exit.

Full metrics in [Metrics that matter](../06-for-investors/04-metrics-that-matter.md).

---

**Next ->** [How to participate](../04-for-users/01-participate.md)
