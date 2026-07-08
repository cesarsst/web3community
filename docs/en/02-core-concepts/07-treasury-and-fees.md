# Treasury and fees

**Audience:** anyone who wants to understand the protocol's cash flow.
**Prerequisites:** [Dual-token](01-dual-token-economy.md), [Governance](05-governance.md).

> **Remodel 2026-07-08**: the current payment interface is [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) — a **2.5%** fee (250 bps; hard cap 500) split **40% treasury / 40% GOV buyback / 20% grants**. FeeRouter V1 (burn split) and the Treasury's CLP loops (FFP buyback, POL, buckets) are **legacy**. And note: the USDC backing of the [CreditPSM](../08-contracts-reference/15-CreditPSM.md) is **segregated** — it is not Treasury cash.

## The DAO's vault

`Treasury` is the central multi-asset vault. Three foundational properties:

1. **Receives passively**. There is no `deposit` function. Anyone transfers ERC-20 (or ETH via `receive`) directly to the Treasury address.
2. **Releases only via governance**. Every outflow function requires `GOVERNANCE_ROLE`.
3. **No pause**. Deliberately no function to freeze outflows. Any unilateral power to freeze the treasury would be a capture vector.

The Treasury receives (current model):

- **40% of the FeeRouterV2 fee** (= 1.0% of GMV) on every payment — recurring revenue in CREDIT, proportional to real usage. This is the main operational source.
- **Genesis CREDIT mint** (10M in production — deploy parameter `genesisAmount`). Sole "programmatic" initial input.
- **Slash collateral** of projects removed with `slash == true`.
- **Returned subsidies** from `UserSubsidy.closeCampaign` campaigns.
- **Any donation** the DAO chooses to accept.

### What the Treasury does NOT have: the PSM backing

The USDC backing CREDIT is **held in the [CreditPSM](../08-contracts-reference/15-CreditPSM.md)**, segregated from the Treasury. There is no function to move it — not even via governance proposal. The DAO spends from the fee (2.5% of flow), never from the backing (invariant I-PSM1). This is deliberate: the user's 1:1 redemption right cannot depend on the DAO's budget discipline.

> **Legacy — the Treasury's CLP functions.** From the CLP pivot (Phase 1, April/2026), the Treasury also performed FFP buyback (USDC -> CREDIT swap + burn, floor defence), POL (own CREDIT/USDC liquidity), the bonders bucket (`polRefillBucket`, 5% of emission), and the gauge fallback (`pendingGaugeRewards`). With CREDIT stable via the PSM, floor defence and pool liquidity are no longer needed — those functions remain in the code, described at the end of this page as legacy.

## What the DAO does with the Treasury

Typical operations, all via proposal:

- **Pay rebates to apps** (`payRebates(token, apps[], amounts[], round)`).
- **Sponsor `UserSubsidy` campaigns** — transfer CREDIT before `createCampaign`.
- **Fund `TeamVesting`** — transfer GOV to a beneficiary's vesting.
- **Fund off-chain operations** — `transfer` to an operational multisig.
- **(CLP legacy)** FFP buyback, POL, POL refill and gauge flush — see the legacy section at the end.

## Fees — the FeeRouterV2

**Sole** payment interface between users and apps in the current model. Main function:

```solidity
function pay(uint256 projectId, uint256 amount) external;
```

The payer is `msg.sender` and must have called `approve(feeRouterV2, amount)` on CREDIT **before**. Requires an Active project in the Registry. Fully atomic, order: fee → rev-share → app.

## Fee — 2.5%, split 40 / 40 / 20

Deploy default: `feeBps = 250` (2.5% of the payment), with a **hard cap `FEE_BPS_CAP = 500`** (5%) — not even governance can exceed it. The fee is split internally (`feeSplit`, must sum to 10,000 bps):

```
fee = amount * 250 / 10000        (2.5% of the payment)
  40% -> treasuryRecipient   (= 1.0% of GMV)
  40% -> buybackRecipient    (= 1.0% of GMV, continuous GOV buyback)
  20% -> grantsRecipient     (= 0.5% of GMV, ecosystem grants)
```

After the fee, the project's **rev-share** is deducted (`ProjectFunding.revShareBpsOf`; 0 if the project never raised a round) and the rest goes **immediately** to the `appRecipient`: **97.5%** without a round, **~89.5%** with an 8% rev-share. Compare: Stripe ~3.8%, app stores 15-30% — while the old model gave the app only a nominal 10%.

In the dev MVP the three recipients all point to the Treasury; the `PaymentRouted` events carry the per-portion breakdown regardless — `grossVolumeOf` and `PaymentRouted` are the on-chain volume metrics.

## App recipient

By default, `toApp` goes to `ProjectRegistry.getProject(projectId).owner` — **dynamic lookup**. The current owner can set an explicit address via:

```solidity
feeRouterV2.setAppRecipient(projectId, recipient);
```

**Not governance-gated** — owner-gated. Operational cash rotation does not need a proposal.

## Dust handling

Inside the fee, the rounding residue of the split goes to grants. Globally, conservation holds: `toApp + fee + revShare == amount` on every `pay` — nothing evaporates, nothing is burned.

## Full payment flow

```
user has 1000 CREDIT                    FeeRouterV2
user calls approve(feeRouterV2, 1000) --- allowance OK
user calls pay(42, 1000)
                                      |
                                      v
                      Check: project 42 is Active
                      Check: amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                                      |
                                      | fee 2.5% + rev-share 8% (Funded round)
                                      v
                 fee = 25, revShare = 80, toApp = 895
                                      |
          +----------+----------+-----+--------------+
          |          |          |                    |
          v          v          v                    v
    treasury 10  buyback 10  grants 5      ProjectFunding 80        appRecipient 895
    (40% fee)    (40% fee)   (20% fee)     + notifyRevenue          (immediate, ~89.5%;
                                           (pro-rata investors)      97.5% without round)
                                      |
                       grossVolumeOf[42] += 1000
                       PaymentRouted event emitted
```

After the tx: **FeeRouterV2 holds 0 CREDIT**. It never custodies between calls. Each `pay` is atomic.

> **Legacy — FeeRouter V1 (70/20/10 split)**: in the pre-remodel model, `FeeRouter.pay(projectId, user, amount)` burned 70% via BurnTracker, sent 20% to the Treasury and a 10% rebate to the app, with per-project overrides (`setProjectSplit`). The contract remains deployed, but the current rail is V2. See [FeeRouter V1](../08-contracts-reference/08-FeeRouter.md).

## ETH outflows

The Treasury accepts ETH via `receive` and can withdraw via `sweepETH(to, amount)`. Uses `call{value}` (not `transfer`/`send`) for compatibility with destinations that are contracts with heavy `receive`. If the destination rejects, reverts with `ETHTransferFailed`.

The use is **courtesy** — the protocol operates primarily in ERC-20 (CREDIT, GOV, stables). ETH is accepted not to leave donations stuck but isn't the main flow.

> ⚠️ **LEGACY from here to "Summary"** — the following sections (FFP buyback, POL, bonders bucket, gauge fallback) belong to the pre-remodel CLP pivot. With CREDIT stable 1:1 via the PSM, floor defence and pool liquidity are no longer needed. The code remains deployed.

## Buyback — real FFP (Phase 1.1, legacy)

From the CLP pivot onwards, `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)` **executes a real swap** USDC -> CREDIT via Uniswap V3 + immediate burn. Floor price defence under the Floating-with-Floor-Price (FFP) model. Details in [Treasury](../08-contracts-reference/04-Treasury.md).

Pre-conditions verified on-chain (all required):

1. **Infra set** — `priceOracle`, `swapRouter` and `chainlinkUsdcFeed` configured via governance. Without that, `BuybackInfraMissing`.
2. **Spot < floor** — CREDIT TWAP (read from `priceOracle`) below `currentFloorPrice()`.
3. **Breach lasted >= 24h** — `block.timestamp - lastFloorBreachTimestamp >= triggerDurationSecs`. Updated by `recordDailyPrice` (permissionless, 22h cooldown).
4. **USDC not depegged** — Chainlink USDC/USD between `[0.99, 1.01]` (band configurable in bps).
5. **Per-event cap** — `usdcAmount <= 20%` of Treasury USDC reserves (instantaneous snapshot).
6. **Monthly cap** — month's cumulative spend `<= 30%` of the snapshot taken on the first buyback of the month.

The bought CREDIT is **always burned** (`CreditToken.burnByRole(self, creditOut, "treasury:buyback")`). Never accumulated. Reason: accumulation would create an endogenous capture agent inside the protocol.

`recordDailyPrice` is the keeper function that feeds the 90-sample ring buffer (`dailyPrices[90]`) and updates the breach checkpoint. MA90 bootstrap requires 90 consecutive invocations (~90 days). Before that, `currentFloorPrice` returns only `floorAbsoluteUsd` (default $0.10) — deliberate design so bootstrap isn't blocked.

## POL (Protocol-Owned Liquidity, Phase 1.2)

The Treasury custodies an NFT position in the CREDIT/USDC 0.3% pool. Full-tick range (`-887220, 887220`). Decision (see `audit/economist/2026-04-24-pol-params.md`):

- No active rebalancing (concentrated would require off-chain management).
- Capital-efficient enough for early-stage markets.
- Trivially auditable (fixed ticks).

API:

- `addPOL(creditAmount, usdcAmount, amount0Min, amount1Min, deadline)` — first time `mint`, then `increaseLiquidity` on the same `polTokenId`.
- `removePOL(liquidityAmount, ...)` — `decreaseLiquidity` + `collect`. Does NOT burn the NFT (position remains available for reuse).
- `collectPOLFees(amount0Max, amount1Max)` — collects accrued fees, no auto-compound.
- `polTokensOrdered()` view — returns the actual `(token0, token1)` order in the pool, useful for the DAO proposer to compute `amount{0,1}Min`.

The "supermajority 75% for removals > 25%" policy is the responsibility of `CommunityGovernor` (proposal type), not this contract.

## Bonders bucket and POL refill (Phase 1.4)

In each `RewardDistributorV2.finalizeRound`, 5% (default) of the emission is minted directly to the Treasury and accounted for in `polRefillBucket`:

```
RewardDistributorV2.finalizeRound(R)
  -> CREDIT.mint(treasury, bondersAmount, "rewardRound:bonders")
  -> Treasury.depositPolRefill(bondersAmount)
     - polRefillBucket += bondersAmount
```

When governance decides to refill the POL, it proposes `addPOLFromRefill(creditAmount, usdcAmount, ...)`:

```
Treasury.addPOLFromRefill (Timelock executes the proposal)
  -> debit polRefillBucket (CEI: before the external call)
  -> _orderTokens + _approveNPM + _provisionLiquidity
  -> NPM.increaseLiquidity (or mint on first run)
```

USDC comes from the Treasury's free balance — depends on `treasuryBps > 0` in `FeeRouter` (see previous section).

Phase 3 of the CLP roadmap recycles this bucket into a `BondDepository` — users swap ETH/CREDIT for vested CREDIT and the protocol accumulates POL via bonds. For now, the ledger sustains POL directly.

## Gauge paused fallback (Phase 1.4)

If the `LiquidityGauge` is paused at the time of `finalizeRound`, V2 cannot call `notifyRewardAmount`. To avoid freezing the entire round finalisation, V2 falls back:

```
RewardDistributorV2.finalizeRound(R) with gauge.paused() == true
  -> CREDIT.mint(treasury, lpsAmount, "rewardRound:lps:fallback")
  -> Treasury.depositPendingGaugeRewards(lpsAmount)
     - pendingGaugeRewards += lpsAmount
  -> emit GaugePauseFallback(R, lpsAmount)
```

After unpausing the gauge, governance calls `Treasury.flushPendingGaugeRewards(duration)`:

```
Treasury.flushPendingGaugeRewards (Timelock executes)
  -> requires gauge unpaused, ledger > 0
  -> approve(gauge, amount), gauge.notifyRewardAmount(poolId, amount, duration)
  -> reset approve
```

## Summary

| Component | Function | Gatekeeping |
|---|---|---|
| Treasury | Multi-asset custody; receives 40% of the fee (1% of GMV) | `GOVERNANCE_ROLE` on outflows |
| FeeRouterV2 | Current payment interface (`pay(projectId, amount)`) | `GOVERNANCE_ROLE` on setters, public on `pay` |
| Fee | 2.5% (250 bps; hard cap 500) | `setFeeBps` by proposal, up to the cap |
| Fee split | 40% treasury / 40% GOV buyback / 20% grants (`4000/4000/2000`) | `setFeeSplit` by proposal (sum = 10,000) |
| Fee recipients | `treasuryRecipient` / `buybackRecipient` / `grantsRecipient` | `setRecipients` by proposal |
| App recipient | Project owner (dynamic) or explicit | Project owner (setter) |
| PSM backing | USDC segregated in the CreditPSM — **out of the Treasury's reach** | No withdrawal possible (immutable) |
| FeeRouter V1, FFP buyback, POL, buckets | **CLP legacy** — code deployed, rail deactivated | `GOVERNANCE_ROLE` |

---

**Next ->** [Architecture](../03-protocol-overview/01-architecture.md)
