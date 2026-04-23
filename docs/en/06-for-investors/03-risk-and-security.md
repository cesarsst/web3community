# Risk and security

**Audience:** anyone who needs to evaluate risk vectors before any exposure.
**Prerequisites:** [Value accrual](02-value-accrual.md).

> **Disclaimer**: the list below describes **known** risks and implemented mitigations. No protocol is immune to bugs, unforeseen attacks, or regulatory changes. Read it and make an informed decision.

## Protocol risks

### Risk: contract bug

**Description**: a bug in any of the 12 contracts can result in loss of funds, governance failure, or broken economic invariants.

**Mitigation**:

- Code based on OpenZeppelin 5.0.2 (pinned exact).
- `ReentrancyGuard` in every state-changing function that moves value.
- SafeERC20 / SafeCast in all conversions.
- Custom errors in every revert (gas saving + clear messages).
- Slither 0.11.5 as static analysis (`audit/slither/`). No high/medium findings in project code at deploy time.
- 462+ tests with 100% stmt coverage and 99.84% lines.
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

### Risk: wash-burn to capture share

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

**Residual risk**: time between the compromise and execution of the proposal (minimum ~8 days = votingDelay + period + minDelay). During that time, users can still pay in the project. Operational mitigation: active monitoring + emergency proposals (meta-proposals with fast voting via reduced quorum not implemented in v1, but debatable in the future).

### Risk: ETH stuck in Treasury

**Description**: ETH sent to the Treasury for which there is no proposed use.

**Mitigation**: `sweepETH` is governance-gated. The DAO can always withdraw via proposal.

**Residual risk**: just time — if the DAO loses engagement, funds get stuck.

### Risk: CREDIT without DEX liquidity

**Description**: user receives CREDIT as reward but cannot convert (low liquidity on external DEX).

**Mitigation**: **outside the protocol**. The DAO can approve using the Treasury to seed liquidity on DEX. The "10% liquidity" bucket of the initial distribution is for that.

**Residual risk**: if DEXs abandon the pool, users are stuck with CREDIT. Solution depends on DAO action + external market.

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

**Description**: classification of GOV or CREDIT as security, regulated stablecoin, or another category with requirements the protocol does not meet.

**Mitigation**:

- Tokens do not promise financial return.
- No central issuer identifiable post-governance handoff.
- DAO can evolve terms or non-contractual aspects as regulatory frameworks consolidate.

**Residual risk**: significant and not eliminable at the protocol level. Users must evaluate their own jurisdictions.

### External DEX integration risk

**Description**: the protocol depends on external DEX for CREDIT liquidity (and eventually GOV). If a DEX is hacked, listing is removed, pool is drained, etc., users lose access to conversion.

**Mitigation**: diversification of DEXs via DAO actions. Not implemented in v1.

### Oracle risk (future application)

**Description**: when real `executeBuyback` DEX integration is implemented, there will be dependency on price oracle / TWAP / slippage protection.

**Mitigation**: detailed design will be audited before implementation. In v1, `executeBuyback` is a stub — only emits an event, does not execute a swap.

## Risks for stakers specifically

- **Immobilization**: lock of 14-365+ days. If you need GOV before, you only exit if the project becomes `Removed`.
- **Dependency on the chosen project**: if your project generates no burn, your reward = 0.
- **Dependency on the ecosystem**: even staking in an exemplary project, if the aggregate ecosystem does not generate usage, emission drops.
- **CREDIT volatility**: your reward is in CREDIT. If CREDIT has no liquidity or devalues, reward in real terms decreases.

## Risks for listed apps

- **Locked collateral**: 10,000 GOV in the Registry. Only returns with `removeProject` without slash.
- **Governance suspension**: punitive `Probation` blocks operation (but does not burn collateral).
- **Slash**: if misconduct is proven, `removeProject(id, slash=true)` sends collateral to Treasury.
- **Split dependency**: 95% of each payment is burned. You receive 5% direct + (optional, via stake) slice of emission.
- **Low usage**: if your app does not attract users, your project's burn is low, emission share too.

## Audit and bounty

Before mainnet:

- External audit by a recognized firm (Trail of Bits, OpenZeppelin, Certik, or similar).
- Bug bounty via Immunefi right after mainnet.
- On-chain monitoring (Forta / Tenderly) for critical events: `CapExceeded`, `SanityCapExceeded`, `RoundClosed.earlyClose=true`, large Treasury outflows.

Current status in the repository:

- Slither with no high/medium findings in project code.
- Test suite with 462+ tests and extensive coverage.
- **External audit not yet performed** at the time of this doc.

## Summary

The protocol has multiple on-chain and off-chain safeguards. None eliminates risk totally. Exposure to GOV or CREDIT implies:

- Contract risk (bug).
- Economic risk (the model may not take off).
- Governance risk (adverse changes via proposal).
- Market risk (liquidity, volatility).
- Regulatory risk (user's jurisdiction).

Evaluate before any exposure. Start small. Understand the lock before staking.

---

**Next →** [Metrics that matter](04-metrics-that-matter.md)
