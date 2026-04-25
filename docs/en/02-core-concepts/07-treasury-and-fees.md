# Treasury and fees

**Audience:** anyone who wants to understand the protocol's cash flow.
**Prerequisites:** [Dual-token](01-dual-token-economy.md), [Governance](05-governance.md).

## The DAO's vault

`Treasury` is the central multi-asset vault. Three foundational properties:

1. **Receives passively**. There is no `deposit` function. Anyone transfers ERC-20 (or ETH via `receive`) directly to the Treasury address.
2. **Releases only via governance**. Every outflow function requires `GOVERNANCE_ROLE`.
3. **No pause**. Deliberately no function to freeze outflows. Any unilateral power to freeze the treasury would be a capture vector.

From the CLP pivot (Phase 1, April/2026) onwards, the Treasury also performs four additional economic functions:

| Function | CLP phase | Summary |
|---|---|---|
| **FFP buyback** | 1.1 | Real USDC -> CREDIT swap + immediate burn, defending the floor |
| **POL** | 1.2 | Protocol-owned liquidity in the CREDIT/USDC pool (custodied NFT, full range) |
| **Bonders bucket** | 1.4 | Receives 5% of per-round emission as the `polRefillBucket` ledger |
| **Gauge fallback** | 1.4 | Accumulates the LPs bucket in `pendingGaugeRewards` while gauge is paused |

The Treasury receives:

- **Genesis CREDIT mint** (10M in production). Sole "programmatic" initial input.
- **`treasuryBps` slice** of the FeeRouter's split (default 0; CLP recommendation: raise to `(7000, 2000, 1000)` to fund USDC for POL refill).
- **Slash collateral** of removed projects.
- **Returned subsidies** from `UserSubsidy.closeCampaign` campaigns.
- **Bonders bucket** from `RewardDistributorV2` (5% of per-round emission — `polRefillBucket` ledger).
- **LPs bucket** when gauge paused (`pendingGaugeRewards` ledger).
- **Any donation** the DAO chooses to accept.

## What the DAO does with the Treasury

Typical operations, all via proposal:

- **Pay rebates to apps** (`payRebates(token, apps[], amounts[], round)`).
- **Sponsor `UserSubsidy` campaigns** — transfer CREDIT before `createCampaign`.
- **Fund `TeamVesting`** — transfer GOV to a beneficiary's vesting.
- **Execute FFP buyback** — `executeBuyback(usdcAmount, minCreditOut)` swap USDC -> CREDIT + immediate burn (Phase 1.1).
- **Add POL** — `addPOL(creditAmount, usdcAmount, ...)` provisions liquidity in the CREDIT/USDC pair (Phase 1.2).
- **Refill POL with bonders bucket** — `addPOLFromRefill(creditAmount, usdcAmount, ...)` matches CREDIT from the ledger with USDC from the free balance.
- **Drain gauge fallback** — `flushPendingGaugeRewards(duration)` ships the accumulated ledger back to the gauge after unpause.
- **Fund off-chain operations** — `transfer` to an operational multisig.

## Fees — the FeeRouter

**Sole** payment interface between users and apps. Main function:

```solidity
function pay(uint256 projectId, address user, uint256 amount)
    external returns (uint256 burned, uint256 toTreasury, uint256 toApp);
```

The `user` must have called `approve(feeRouter, amount)` on CREDIT **before**. `msg.sender` is whoever initiates the tx — could be the user themselves, the app, a relayer, a smart wallet.

## Default split — 95 / 0 / 5

In production (`ignition/parameters/production.json`):

```
burnBps     = 9500   (95% burned via BurnTracker)
treasuryBps = 0      (nothing to Treasury by default)
rebateBps   = 500    (5% to the appRecipient)
```

Sum must be exactly 10_000 (`_BPS_DENOMINATOR`). Different splits are rejected with `InvalidSplit`.

Design decision: 0% to treasury by default **so the burn incentive is not eroded**. The Treasury earns revenue through other paths (already-minted genesis, slash, donations, managed buyback). If at some point the DAO wants to capture a direct slice, just propose `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})` — the architecture allows it.

### Structural consequence — Treasury without recurring revenue by default

With `treasuryBps = 0` in production, the Treasury **does not accumulate automatic operational revenue**. The recurring split inputs are zero — only:

- Slash of collateral from `removeProject(slash = true)` (eventual).
- Leftovers of `UserSubsidy.closeCampaign` campaigns (eventual).
- External donations and direct ETH.
- Bonders bucket and gauge fallback (Phase 1.4) — those **accumulate in separate ledgers** (`polRefillBucket` and `pendingGaugeRewards`), not in the free balance. The bonders bucket is earmarked for POL refill; only that.

**For Phase 1.4 (CLP) to operate fully — i.e., for `addPOLFromRefill` to have USDC to match the CREDIT in the bonders bucket —, the Treasury needs USDC to flow in recurrently.** The only structural source for that is to raise `treasuryBps > 0` in `FeeRouter`. The parecer's operational recommendation is `(7000, 2000, 1000)` (70% burn / 20% treasury / 10% rebate), which:

- Reduces burn from 95% to 70% — more CREDIT in circulation.
- Routes 20% to the Treasury in USDC/CREDIT (depending on payer and form).
- Keeps 10% rebate for apps.

That decision belongs to the DAO via `setDefaultSplit`. Without it, the bonders bucket keeps accumulating CREDIT in the ledger without governance being able to drain it (USDC would be missing).

## Per-project override

Some projects can negotiate different splits via proposal:

```solidity
feeRouter.setProjectSplit(projectId, Split({burnBps, treasuryBps, rebateBps}));
```

The flag `hasProjectSplit[projectId]` signals an active override. `clearProjectSplit` removes.

Typical use: a high-volume app willing to accept a higher effective fee (because it has another revenue source) can negotiate `8000/1500/500` (15% treasury), funding the vault more aggressively.

## Rebate recipient

By default, the rebate goes to `ProjectRegistry.getProject(projectId).owner`. If the owner transfers the project, the destination switches automatically — **dynamic lookup**.

The current owner can set an explicit address via:

```solidity
feeRouter.setAppRecipient(projectId, recipient);
```

Useful when the owner is a multisig and the rebate should land in a separate operational wallet. Passing `address(0)` resets to dynamic lookup.

**Not governance-gated** — owner-gated. Operational cash rotation does not need a proposal.

## Dust handling

In splits with non-exact division:

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- residue lands here
```

Instead of rounding each portion separately (losing wei), `toApp` captures the residue. Consequence: the app may receive 1-2 wei more than the nominal calculation. Acceptable and auditable.

## Full payment flow

```
user has 1000 CREDIT                FeeRouter
user calls approve(feeRouter, 1000) --- allowance OK
user calls pay(projectId, user, 1000)
                                      |
                                      v
                      Check: projectId is Active
                      Check: user != 0, amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                      FeeRouter holds 1000 CREDIT
                                      |
                                      | split = 9500/0/500
                                      v
                        burned = 950, toTreasury = 0, toApp = 50
                                      |
          +---------------------------+----------------------------+
          |                           |                            |
          v                           v                            v
   approve(tracker, 950)       (no Treasury transfer        transfer(appRecipient, 50)
   tracker.burnAndRecord       in this split)
                                                              appRecipient is
                                                              projectOwner by default
                                      |
   tracker calls                      |
   credit.burnByRole(router, 950)    |
                                      |
   CREDIT.totalSupply -= 950          |
   burnByRoundProject[R][pid] += 950  |
   totalBurnByRound[R] += 950         |
                                      v
                              Paid event emitted
```

After the tx: **FeeRouter holds 0 CREDIT**. It never custodies between calls. Each `pay` is atomic.

## ETH outflows

The Treasury accepts ETH via `receive` and can withdraw via `sweepETH(to, amount)`. Uses `call{value}` (not `transfer`/`send`) for compatibility with destinations that are contracts with heavy `receive`. If the destination rejects, reverts with `ETHTransferFailed`.

The use is **courtesy** — the protocol operates primarily in ERC-20 (CREDIT, GOV, stables). ETH is accepted not to leave donations stuck but isn't the main flow.

## Buyback — real FFP (Phase 1.1)

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
| Treasury | Multi-asset custody | `GOVERNANCE_ROLE` on outflows |
| FeeRouter | Payment interface | `GOVERNANCE_ROLE` on setters, public on `pay` |
| Default split | 95% burn / 0% treasury / 5% rebate (CLP recommendation: `(7000, 2000, 1000)`) | Adjustable by proposal |
| Per-project split | Override via `setProjectSplit` | `GOVERNANCE_ROLE` |
| Rebate recipient | Project owner (dynamic) or explicit | Project owner (setter) |
| FFP buyback | Real (Phase 1.1) — USDC->CREDIT swap + burn | `GOVERNANCE_ROLE` |
| POL | Own CREDIT/USDC liquidity, full range | `GOVERNANCE_ROLE` |
| Bonders bucket | 5% emission -> POL refill ledger | `POL_REFILL_DEPOSITOR_ROLE` (V2) |
| Gauge fallback | Paused ledger -> manual flush | `GAUGE_FALLBACK_DEPOSITOR_ROLE` (V2) + governance |

---

**Next ->** [Architecture](../03-protocol-overview/01-architecture.md)
