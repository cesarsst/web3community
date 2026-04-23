# Treasury and fees

**Audience:** anyone who wants to understand the protocol's cash flow.
**Prerequisites:** [Dual-token](01-dual-token-economy.md), [Governance](05-governance.md).

## The DAO's vault

The `Treasury` is the central multi-asset vault. Three fundamental properties:

1. **Receives passively**. There is no `deposit` function. Anyone transfers ERC-20 (or ETH via `receive`) directly to the Treasury's address.
2. **Only releases via governance**. All outflow functions (`transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH`) require `GOVERNANCE_ROLE`.
3. **No pause**. Deliberately, there is no function to freeze outflows. Any unilateral power to freeze the treasury would be a capture vector.

The Treasury receives:

- **CREDIT genesis mint** (10M in production). That is the only "programmatic" inflow; subsequent ones are via explicit transfer.
- **`treasuryBps` slice** of `FeeRouter`'s split (default 0 in production, but adjustable via governance).
- **Slash collateral** from projects removed with `slash == true`.
- **Returned subsidies** when a `UserSubsidy` campaign is closed with leftovers.
- **Any donation / buyback / app fee** the DAO decides to accept.

## What the DAO does with the Treasury

Typical operations, all via proposal:

- **Pay rebates to apps** (`payRebates(token, apps[], amounts[], round)`) — batch transfer with `RebatesPaid` event for traceability.
- **Sponsor `UserSubsidy` campaigns** — transfer CREDIT to the subsidy contract before `createCampaign`.
- **Fund `TeamVesting`** — transfer GOV to a vesting instance that later releases to the beneficiary.
- **Buyback GOV with stable** — `executeBuyback` (v1 stub — only emits event; DEX integration will come in a later phase).
- **Fund off-chain operations** (marketing, audits, etc.) — `transfer` to an operational multisig.

## Fees — the FeeRouter

**Single** payment interface between users and apps. Main function:

```solidity
function pay(uint256 projectId, address user, uint256 amount)
    external returns (uint256 burned, uint256 toTreasury, uint256 toApp);
```

The `user` must have given `approve(feeRouter, amount)` on CREDIT **beforehand**. `msg.sender` is whoever initiated the tx — it can be the user themselves, the app, a relayer, a smart wallet.

## Default split — 95 / 0 / 5

In production (`ignition/parameters/production.json`):

```
burnBps     = 9500   (95% burned via BurnTracker)
treasuryBps = 0      (nothing to Treasury in the default)
rebateBps   = 500    (5% to appRecipient)
```

The sum must be exactly 10_000 (`_BPS_DENOMINATOR`). Different splits are rejected with `InvalidSplit`.

Design decision: 0% to treasury in the default **to not erode the burn incentive**. The Treasury receives revenue via other paths (already minted genesis, slash, donations, managed buyback). If in the future the DAO wants to capture a direct cut, it simply proposes `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})` — the architecture allows it.

### Structural consequence — Treasury without recurring revenue under the default

With `treasuryBps = 0` in production, the Treasury **does not accumulate automatic operational revenue**. The recurring inflows are only:

- Slash of collateral from projects removed with `slash == true` (eventual, depends on misconduct).
- Leftovers from `UserSubsidy.closeCampaign` campaigns (eventual, depends on campaigns existing).
- External donations and ETH sent directly to the address.

All of these are **eventual**, not recurring. Consequences:

1. `executeBuyback` is a **v1 stub** (does not execute a swap — see "Buyback — v1 stub" below) and, even after being integrated with a DEX, will need stables/CREDIT in the Treasury to be backed. Without a recurring source, any operational buyback depends on external donations or on an active split change.
2. Recurring payments (retroactive rebates, emergency fund, audit/operations payment) depend on the genesis (10M CREDIT) or on new proposals minting GOV for sale.

**To activate a treasury with recurring cash flow before enabling real buyback on mainnet, the DAO must approve a `setDefaultSplit` proposal that raises `treasuryBps > 0`.** Concrete value to be decided by the DAO; `(9000, 500, 500)` (90% burn / 5% treasury / 5% rebate, all in bps/10000) is a reasonable calibration that preserves the deflationary incentive and the app incentive, but only the DAO decides. This proposal is a **prerequisite** for any sustainable buyback program and is listed as a pre-mainnet dependency in README §7.

## Per-project override

Some projects can negotiate different splits via proposal:

```solidity
feeRouter.setProjectSplit(projectId, Split({burnBps, treasuryBps, rebateBps}));
```

The flag `hasProjectSplit[projectId]` signals that an override exists. `clearProjectSplit` removes it.

Typical use: a high-volume app that would accept a higher effective fee (because it has another revenue source) can negotiate `8000/1500/500` (15% treasury), more aggressively funding the vault.

## Rebate recipient

By default, the rebate goes to `ProjectRegistry.getProject(projectId).owner`. If the owner transfers the project, the destination changes automatically — **dynamic lookup**.

The current owner can set an explicit address via:

```solidity
feeRouter.setAppRecipient(projectId, recipient);
```

Useful when the owner is a multisig and the rebate should land on a separate operational wallet. Passing `address(0)` resets to dynamic lookup.

**Not governance-gated** — it is owner-gated. Operational cash rotation does not need a proposal.

## Dust handling

In splits with non-exact division:

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- residue lands here
```

Instead of rounding each slice separately (loses wei), `toApp` captures the residue. Consequence: the app may receive 1-2 wei more than the nominal. Acceptable and auditable.

## Full flow of a payment

```
user has 1000 CREDIT                 FeeRouter
user calls approve(feeRouter, 1000) --- allowance OK
user calls pay(projectId, user, 1000)
                                      |
                                      v
                      Check: projectId is Active
                      Check: user != 0, amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                      FeeRouter has 1000 CREDIT
                                      |
                                      | split = 9500/0/500
                                      v
                        burned = 950, toTreasury = 0, toApp = 50
                                      |
          +---------------------------+----------------------------+
          |                           |                            |
          v                           v                            v
   approve(tracker, 950)       (no transfer to                transfer(appRecipient, 50)
   tracker.burnAndRecord        Treasury in this split)
                                                              appRecipient is
                                                              projectOwner by default
                                      |
   tracker calls                      |
   credit.burnByRole(router, 950)     |
                                      |
   CREDIT.totalSupply -= 950          |
   burnByRoundProject[R][pid] += 950  |
   totalBurnByRound[R] += 950         |
                                      v
                              Paid event emitted
```

After the tx: **FeeRouter has 0 CREDIT**. It never custodies between calls. Every `pay` is atomic.

## ETH outflows

The Treasury accepts ETH via `receive` and can withdraw via `sweepETH(to, amount)`. Uses `call{value}` (not `transfer`/`send`) for compatibility with destinations that are contracts with heavy `receive`. If the destination rejects, it reverts with `ETHTransferFailed`.

The use is **courtesy** — the protocol operates primarily in ERC-20 (CREDIT, GOV, stables). ETH is accepted so donations are not stuck but is not the main flow.

## Buyback — v1 stub

`executeBuyback(stable, amountIn, minGovOut, swapData)` in v1 **does not execute a swap**. It only emits `BuybackRequested`. Reason: proper modeling of slippage, TWAP, and frontrunning resistance requires a careful choice between DEX (Uniswap v3 vs Balancer) and goes in a separate phase.

In the meantime, the DAO can approve the intent on-chain. Off-chain workers watch the event and process manually (or via a future integration contract).

## Summary

| Component | Function | Gatekeeping |
|---|---|---|
| Treasury | Multi-asset custody | `GOVERNANCE_ROLE` on outflows |
| FeeRouter | Payment interface | `GOVERNANCE_ROLE` on setters, public on `pay` |
| Default split | 95% burn / 0% treasury / 5% rebate | Adjustable by proposal |
| Per-project split | Override via `setProjectSplit` | `GOVERNANCE_ROLE` |
| Rebate recipient | Project owner (dynamic) or explicit | Project owner (setter) |
| Buyback | Stub — event-only in v1 | `GOVERNANCE_ROLE` |

---

**Next →** [Architecture](../03-protocol-overview/01-architecture.md)
