# Risk and security

**Audience:** anyone who needs to evaluate risk vectors before any exposure.
**Prerequisites:** [Value accrual](02-value-accrual.md).

> **Disclaimer**: the list below describes **known** risks and implemented mitigations. No protocol is immune to bugs, unforeseen attacks, or regulatory changes. Read it and make an informed decision.

> **Remodel 2026-07-08**: the risk profile changed with the new model. Core risks now: **app revenue** (rev-share stops if the app does not sell), **PSM peg/backing**, and **regulatory** (rev-share approaches a security). Old-rail risks (wash-burn, emission, floor/FFP) are marked legacy.

## Risks of the current model (remodel)

### Risk: app revenue (the investor's main risk)

**Description**: the investor's return in [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) is 100% dependent on the **app's real revenue**. If the app does not sell, the rev-share simply **stops** — there is no floor, no compensatory emission, no debt accruing in your favor. Capital invested in a Funded round is not returned: what you buy is the future rev-share stream.

**Mitigation**:

- All-or-nothing: a round that misses the target refunds 100% (`refund`).
- On-chain metrics for due diligence **before** investing: `grossVolumeOf` (historical GMV), `totalRevenueDistributed` (revenue already paid), `PaymentRouted` events.
- Staked-GOV gate: whoever invests already has long-term exposure to the project (curation with skin in the game).
- Hard bounds: rev-share 1-30% (100-3000 bps), duration 1-90 days, minimum target `minTarget`.

**Residual risk**: high by nature — it is business risk, not contract risk. A project that dies pays nothing. Size your exposure as you would in revenue-based financing.

### Risk: PSM peg/backing

**Description**: CREDIT is worth 1 USDC because the [CreditPSM](../08-contracts-reference/15-CreditPSM.md) guarantees 1:1 redemption against the retained backing. Vectors: (a) a PSM bug that allows draining the backing; (b) a depeg of USDC itself; (c) a `sell` larger than the available backing.

**Mitigation**:

- Backing 100% held in the contract, **no withdrawal function** — not even governance can move it (invariant I-PSM1: `backingNormalized() >= mintedOutstanding`, verifiable by anyone at any time).
- PSM has no owner, no roles of its own, no adjustable parameters — zero admin surface.
- Exact 1:1 conversion both ways, no fee; a `sell` beyond the backing reverts with `InsufficientBacking` instead of paying partially.

**Residual risk**: a USDC depeg (CREDIT inherits the backing stable's risk) and contract bugs not covered by tests/audit. `mintedOutstanding` is a conservative estimate — the verifiable backing is always `backing()`.

## Protocol risks

### Risk: contract bug

**Description**: a bug in any of the 15 production contracts can result in loss of funds, governance failure, or broken economic invariants.

**Mitigation**:

- Code based on OpenZeppelin 5.0.2 (pinned exact).
- `ReentrancyGuard` in every state-changing function that moves value.
- SafeERC20 / SafeCast in all conversions.
- Custom errors in every revert (gas saving + clear messages).
- Slither 0.11.5 as static analysis (`audit/slither/`). No high/medium findings in project code at deploy time.
- 858 tests (full suite green) with extensive coverage.
- **External audit mandatory before mainnet** (Trail of Bits, OpenZeppelin, or similar).

**Residual risk**: subtle bugs that tests + static analysis do not catch. External audit reduces but does not eliminate.

### Risk: governance capture

**Description**: an actor accumulates enough GOV to approve malicious proposals (drain Treasury, change splits for own benefit, etc.).

**Mitigations**:

- `proposalThreshold = 10,000 GOV` (0.01% of cap) prevents spam, not direct capture.
- `quorum = 4%` of supply requires real minimum participation.
- `timelockMinDelay = 2 days` gives a response window for holders to see a malicious proposal and act.
- `votingPeriod = 7 days` allows off-chain discussion.
- Execution is permissionless after the delay — any holder can block via counter-proposal before execution.
- **On-chain 75% supermajority** (`ProposalType.Supermajority` in `CommunityGovernor`): any proposal containing `Treasury.removePOL` — or role management (`grantRole`/`revokeRole`/`renounceRole`) targeting the Treasury or the Timelock itself — only passes with `forVotes >= 3 × againstVotes`. Closes the vector of draining protocol-owned liquidity (POL) by simple majority, including the bypass of re-authorizing roles.
- **On-chain segregation of reserved balances in the Treasury**: CREDIT `transfer`/`batchTransfer`/`payRebates` cannot eat into `polRefillBucket + pendingGaugeRewards` (they revert with `TransferExceedsUnreservedCredit`), and deposits into those ledgers require real CREDIT backing (`DepositExceedsCreditBalance`). In `LiquidityGauge`, `governanceRescueRewards` is limited to the unreserved balance (`totalVestingLocked` protects users' vesting).

**Residual risk**: if an actor accumulated a lot of GOV (via badly distributed public sale or aggressive buying on DEX), they can force proposals even with quorum. The mitigation is **well-designed initial distribution** (via DAO proposals picking buckets properly — see [Tokenomics](01-tokenomics.md)).

### Risk: flash-loan attack on the vote

**Description**: attacker takes a huge GOV loan, votes on a proposal favorable to them, returns the loan in the same block.

**Mitigation**:

- `GovernanceToken` inherits `ERC20Votes`. Voting power is read via `getPastVotes(account, snapshotBlock)` — past block. A flash loan repays in the same block it was taken, so it **does not affect** a prior block.
- `votingDelay = 1 day` pushes the snapshot away from the current block.

**Residual risk**: very low. The mechanism is standard in OZ and widely tested.

### Risk: flash-loan attack on reward

**Description**: attacker big-stakes right before `finalizeRound` to capture share.

**Mitigation**:

- `Staking` keeps historic checkpoints (`Checkpoints.Trace208`).
- `RewardDistributor._calculateClaim` uses `Staking.getWeightAt(user, projectId, snapshotBlock)` — weight **before** `finalizeRound`.
- A flash loan cannot hold a position in a prior block.

**Residual risk**: very low. Direct analog of governance protection, validated in tests.

### Risk: wash-burn to capture share (legacy)

> ⚠️ **LEGACY** — this vector belongs to the pre-remodel burn-to-mint rail. With no new emission, wash-burn lost its target. (In the current model the analog would be GMV wash-trading to inflate a funding round's metrics — mitigated by real cost: every `pay` pays the 2.5% fee + rev-share.)

**Description**: a malicious project burns a lot of CREDIT it itself minted (via some external path) to capture disproportionate share of emission.

**Mitigation**:

- Sanity cap per `(round, project)` in `BurnTracker`. Production default: 10M CREDIT per project per round. Attempt above reverts with `SanityCapExceeded`.
- Total cap per round (`capMax` in `RewardDistributor`): 5M CREDIT in production. Even if the attacker burns under the sanity cap, total emission is clamped.
- Probation penalty (25% share) for new projects.

**Residual risk**: an actor with **access to a lot of real CREDIT** (not self-minted — e.g., bought on DEX) can spend that CREDIT to inflate burn of a coopted project. But that **is not an attack** — it is legitimate protocol use (someone paid dearly for it).

### Risk: project coopted after listing

**Description**: legitimately approved project is hacked / owner compromised / team disappears with collateral.

**Mitigations**:

- GOV collateral (10k) stays in the Registry until `removeProject`. If compromised, the DAO approves `removeProject(id, slash=true, treasury)` — collateral goes to Treasury.
- Apps lose `RECORDER_ROLE` (if they had it) via `revokeRole` when the project becomes `Probation` or `Removed` — via proposal.
- `isActive(projectId)` in `FeeRouter.pay` and `BurnTracker.burnAndRecord` blocks new payments as soon as status changes.

**Residual risk**: time between the compromise and execution of the proposal (minimum ~10 days = votingDelay ~1d + votingPeriod ~7d + timelockMinDelay 2d). During that time, users can still pay in the project. Operational mitigation: active monitoring + emergency proposals (meta-proposals with fast voting via reduced quorum not implemented in v1, but debatable in the future).

### Risk: ETH stuck in Treasury

**Description**: ETH sent to the Treasury for which there is no proposed use.

**Mitigation**: `sweepETH` is governance-gated. The DAO can always withdraw via proposal.

**Residual risk**: just time — if the DAO loses engagement, funds get stuck.

### Risk: CREDIT without DEX liquidity (legacy)

> ⚠️ **LEGACY** — with the PSM, the primary CREDIT exit is 1:1 redemption in the contract itself, with no dependency on DEX liquidity. The conversion risk migrated to "PSM peg/backing" (above). POL and the CREDIT/USDC pool remain as CLP-pivot legacy.

**Description**: user receives CREDIT as reward but cannot convert (low liquidity on external DEX).

**Mitigation**: the Treasury has an on-chain **POL (Protocol Owned Liquidity, Phase 1.2)** mechanism: `addPOL`/`addPOLFromRefill` provision CREDIT/USDC liquidity (Uniswap V3, full range) with the NFT position custodied by the Treasury itself; every outflow (`removePOL`) requires a proposal with a **75% supermajority** in the Governor.

## Operational risks

### Risk: deployer compromised before handoff

**Description**: during initial deploy, the deployer has temporary control of all contracts. If compromised before transferring roles to the Timelock, they can drain funds.

**Mitigation**:

- Deploy via Ignition in a batched transaction.
- Handoff automated in the `Dao.ts` module — transfers roles and renounces admin in the same sequence.
- Rigorous documentation in [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

**Residual risk**: short window during script execution. Operational mitigation: deploy from a secure hardware with review of the tx batch before submission.

### Risk: first `acceptOwnership` does not happen

**Description**: after deploy, the Timelock is `pendingOwner` of the GovernanceToken but has not yet accepted. Who can mint GOV is the deployer. If the deployer disappears without minting initial distribution via proposal accepted by the Timelock, the DAO is born dead.

**Mitigation**:

- Bootstrap procedure documented in [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).
- Mandatory first proposal should be `GovernanceToken.acceptOwnership()` by the Timelock.

**Residual risk**: human error. Mitigation: checklist procedure + multisig review + prior end-to-end test on testnet.

### Risk: bad parameter configuration

**Description**: DAO approves a parameter change (α, capMax, etc.) that causes economic pathology.

**Mitigation**:

- Bounds hardcoded in every setter. E.g.: `alpha` only accepts `[0.5, 0.99]` (reduced from `[0.5, 1.1]` — see `audit/economist/2026-04-22-consistency-audit.md` C2, to guarantee IE1 α<1 permanent by construction); values outside revert with `InvalidAlpha`.
- Changes go through 7 days of voting + 2 days of delay — time for discussion and reversal.

**Residual risk**: within bounds, the DAO can make controversial changes. That is a characteristic of DAO, not a bug.

## External risks

### Regulatory risk

**Description**: three distinct fronts in the current model:

1. **Rev-share ≈ security**: the right to a slice of a project's future revenue, bought with an expectation of profit from the effort of others, **approaches the definition of a security** (Howey test and analogs). It is the remodel's most serious regulatory risk.
2. **CREDIT as a stablecoin**: a stable token backed 1:1 by USDC may fall under regulated-stablecoin regimes (MiCA, US legislation), with issuer/reserve requirements that an immutable protocol does not meet in the traditional way.
3. **GOV**: classification as a security via the classic route of a governance token with buyback.

**Mitigation**:

- **A formal legal opinion is PENDING and is a pre-mainnet blocker** — no mainnet deploy before that per-jurisdiction analysis.
- Rev-share is bounded (1-30%), tied to real revenue (not a promise of appreciation), and investing requires active participation (staked GOV = curation).
- PSM backing is 100% on-chain and verifiable — transparency above the standard of centralized issuers.
- No central issuer identifiable post-governance handoff.

**Residual risk**: significant and not eliminable at the protocol level. Classification may vary by jurisdiction and change over time. Users must evaluate their own jurisdictions.

### External DEX integration risk

**Description**: GOV depends on external DEX for liquidity. If a DEX is hacked, listing is removed, pool is drained, etc., holders lose access to conversion. (For CREDIT this risk is legacy — the primary conversion is 1:1 redemption in the PSM.)

**Mitigation**: diversification of DEXs via DAO actions. Not implemented in v1.

### Oracle risk (FFP buyback) (legacy)

> ⚠️ **LEGACY** — the CREDIT FFP buyback and floor defence belong to the pre-remodel CLP pivot. With CREDIT stable via the PSM, there is no floor to defend. The current buyback is for **GOV** (40% of the FeeRouterV2 fee), which does not depend on an oracle.

**Description**: `executeBuyback` is **real** (CLP pivot Phase 1.1): USDC → CREDIT swap via Uniswap V3 + immediate burn of the bought CREDIT. It depends on `CreditPriceOracle` (immutable adapter: TWAP of the Uniswap V3 CREDIT/USDC pool + Chainlink USDC/USD sanity). A manipulated oracle or a shallow pool could induce a buyback at a bad price.

**Mitigation** (all on-chain, in the `Treasury` and the adapter):

- The price is a TWAP (default 30 min window, bounds [5min, 2h]) — manipulating the instantaneous spot is not enough.
- Chainlink USDC/USD sanity: max 6h staleness + band [0.99, 1.01] — a USDC depeg blocks the buyback (`UsdcDepegDetected`).
- A buyback is only eligible with spot below the floor for >= `triggerDurationSecs` (default 24h) and is capped: 20% of reserves per event, 30% of the monthly snapshot (defaults; adjustable within bounds).
- `minCreditOut` (slippage) is mandatory; each execution requires a DAO proposal (GOVERNANCE_ROLE = Timelock).
- The adapter has no owner/setters — changing oracle parameters requires a new deploy + `setPriceOracle` via proposal.

## Risks for investors specifically

- **GOV immobilization**: lock of 14-365+ days. If you need GOV before, you only exit if the project becomes `Removed`.
- **Round capital does not return**: in a Funded round, what you bought is the rev-share stream — there is no principal redemption.
- **Dependency on the chosen project**: if your app does not sell, rev-share = 0. No floor, no compensation.
- **Claim gate**: withdrawing rev-share requires keeping GOV staked in the project. Without stake, the value is held (it does not expire) until you re-stake.
- **Dependency on the ecosystem**: even investing in an exemplary project, if the aggregate hub does not attract users, GMV shrinks for everyone.

## Risks for listed apps

- **Locked collateral**: 10,000 GOV in the Registry. Only returns with `removeProject` without slash.
- **Governance suspension**: punitive `Probation` blocks operation (but does not burn collateral).
- **Slash**: if misconduct is proven, `removeProject(id, slash=true)` sends collateral to Treasury.
- **Rail cost**: a 2.5% fee (250 bps; hard cap 500) + the round's rev-share, if you raised (1-30%). You receive ~89.5-97.5% of every payment, immediately.
- **Rev-share is perpetual in the MVP**: a Funded round has no rev-share end date — the slice applies to all future revenue routed through FeeRouterV2.
- **Low usage**: if your app does not attract users, there is no revenue — and an open funding round tends to fail (refund to investors).

## Audit and bounty

Before mainnet:

- External audit by a recognized firm (Trail of Bits, OpenZeppelin, Certik, or similar).
- Bug bounty via Immunefi right after mainnet.
- On-chain monitoring (Forta / Tenderly) for critical events: `CapExceeded`, `SanityCapExceeded`, `RoundClosed.earlyClose=true`, large Treasury outflows.

Current status in the repository:

- Slither with no high/medium findings in project code.
- Test suite with 858 tests passing (0 failures).
- **External audit not yet performed** at the time of this doc.

## Summary

The protocol has multiple on-chain and off-chain safeguards. None eliminates risk totally. Exposure to GOV, CREDIT, or funding rounds implies:

- Contract risk (bug).
- Revenue risk (rev-share depends 100% on the app's sales).
- Peg/backing risk (the PSM inherits USDC's risk).
- Governance risk (adverse changes via proposal).
- Market risk (GOV liquidity).
- Regulatory risk (rev-share ≈ security; legal opinion pending pre-mainnet).

Evaluate before any exposure. Start small. Understand the lock and the all-or-nothing before investing.

---

**Next →** [Metrics that matter](04-metrics-that-matter.md)
