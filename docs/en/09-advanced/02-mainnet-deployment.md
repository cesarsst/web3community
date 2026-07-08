# Mainnet deployment

> ⚠️ **Legacy note (2026-07-08 remodel)**: this procedure covers the core module deploy and cites old-rail parameters (alpha, 70/20/10 split, BurnTracker/RewardDistributor roles) **as current** — treat them as legacy. The current rail's deploy (CreditPSM, FeeRouterV2, ProjectFunding — today via `scripts/deploy-remodel.ts`) still needs to be incorporated into the mainnet procedure. Additional pre-mainnet blockers: external audit **and the rev-share legal opinion** (see [Risks](../06-for-investors/03-risk-and-security.md)).

**Audience:** technical team doing deploy on a public network.
**Prerequisites:** familiarity with Hardhat + Ignition.

This document is **not** "how to run `ignition deploy`" — that is automated. It is the **critical procedure** before, during, and after the deploy, which ensures the DAO is born safe.

## The bootstrap paradox

Every ERC20Votes + Timelock + Governor DAO has the same dilemma:

> To change the state of the protocol, a proposal is required.
> To make the first proposal, GOV delegated above the threshold is required.
> To have GOV, someone needs to have minted.
> But minting is already a state change.

There is a window — between deploy and the Timelock's `acceptOwnership` — in which **a single address (the deployer) has sovereign power** to decide how much GOV exists and who receives it. That power is necessary for bootstrap. It is also the biggest operational risk.

Three healthy ways to close that window:

1. **Multisig as deployer** — not an EOA. Gnosis Safe 4-of-7 with public signatories.
2. **Minimum mint for bootstrap** — mint only what is needed to pass `proposalThreshold`, not 100M. Real distribution comes later via proposals.
3. **Fast handoff** — `acceptOwnership` must be the first proposal. The less time the deployer is owner, the smaller the window.

## The 4 phases

| Phase | When | Actors | Deliverable |
|---|---|---|---|
| **F0 — Pre-deploy** | T-8 to T-1 weeks | Auditors, multisig, team | Audited code, monitoring up, operational multisig |
| **F1 — Deploy** | Day D | Deployer (multisig) | 10 core contracts on-chain, verified on Etherscan (of 15 production contracts in the repo; auxiliaries and CLP Phase 1 are optional) |
| **F2 — Bootstrap** | D+1 to D+12 | Deployer → Governor | `acceptOwnership` executed; Timelock is owner |
| **F3 — Distribution** | D+12 to D+90 | DAO (multisig + holders) | GOV distributed via proposals |
| **F4 — Full handoff** | D+90+ | Community | Multisig loses voting majority |

Each phase has a gate. If the gate fails, **do not advance**.

## F0 — Pre-deploy

Mandatory checklist:

- [ ] **Full external audit.** Trail of Bits, OpenZeppelin, Certik, or Zellic. Pick one (preferably two) and close every high/medium finding. Low/informational findings documented as accepted.
- [ ] **Public audit report** before deploy.
- [ ] **Active bug bounty** on Immunefi (critical: $50k–$250k range) from day D.
- [ ] **Operational multisig.** Gnosis Safe with ≥4 geographically distributed signatories. Threshold 3/5 or 4/7. Signatories with public reputation.
- [ ] **Sepolia test for ≥ 14 days** running the same production profile — including `acceptOwnership` + 3 real proposals.
- [ ] **On-chain monitoring** configured before deploy: Forta, Tenderly, OZ Defender. Critical events: `CapExceeded`, `SanityCapExceeded`, `RoundClosed(earlyClose=true)`, `Transferred` (Treasury), `RoleGranted`, `RoleRevoked`.
- [ ] **Incident runbook** written: who puts out the fire, who cancels the proposal, who communicates with holders.

### Dependent external contracts

These are **not** in the main module and need to exist before the deploy or before the corresponding distribution proposals:

- **Vesting (team)** — uses `TeamVesting` from the repo itself (audited along with the rest). In mainnet, the recommendation is to deploy via a separate module (`ignition/modules/TeamVesting.ts`) after the DAO approves the beneficiary and schedule — the main `Dao.ts` optionally accepts `DEPLOY_TEAM_VESTING=true` for all-in-one deploy (see below), but in prod the via-proposal path is preferable.
- **UserSubsidy** — Merkle singleton in the repo (`ignition/modules/UserSubsidy.ts`). Deployed via a separate module after the DAO decides funding. Optional flag `DEPLOY_USER_SUBSIDY=true` on `Dao.ts` for dev/testnet.
- **Sale contract (public sale)** — **does not exist in the repo**. To be defined by proposal: bonding curve, fixed-price, LBP, etc. Needs to be designed, audited, and deployed before proposal #4 (mint 20M GOV to the public sale).
- **Liquidity pool / LiquidityManager** — **does not exist in the repo**. Address and configuration of the Uniswap V2/V3 or Balancer pool where the 10% liquidity bootstrap will be provisioned. Needs to be designed before proposal #6.
- **LPRewards / liquidity-mining** — **does not exist in the repo**. Required if part of the 15% community rewards is programmed as LP mining (instead of just airdrops via `UserSubsidy`).

### Optional auxiliary deploy in `Dao.ts`

`ignition/modules/Dao.ts` supports build-time env vars (all default `false`):

- `DEPLOY_TEAM_VESTING` — `TeamVesting` (1 beneficiary).
- `DEPLOY_USER_SUBSIDY` — `UserSubsidy` (Merkle singleton).
- `DEPLOY_CLP_PHASE1` — `LiquidityGauge` + `RewardDistributorV2` (CLP pivot Phase 1).
- `DEPLOY_CLP_ORACLE` — `CreditPriceOracle` (CREDIT/USDC TWAP adapter + Chainlink sanity).

The module **grants no role** to the CLP contracts and does not call `Treasury.setPriceOracle` — those are post-deploy governance acts (see "CLP post-deploy wiring" below).

```bash
# Default (recommended production path) — 10 core contracts:
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet

# All-in-one (dev/testnet) — includes TeamVesting (1 beneficiary) + UserSubsidy:
DEPLOY_TEAM_VESTING=true DEPLOY_USER_SUBSIDY=true \
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet

# With CLP Phase 1 (gauge + distributorV2 + oracle):
DEPLOY_CLP_PHASE1=true DEPLOY_CLP_ORACLE=true \
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet
```

`DEPLOY_CLP_ORACLE` should only be enabled with **real** `creditUsdcPool` and `usdcAddress` in the parameters — the `CreditPriceOracle` constructor reverts with `ZeroAddress` (or `PoolTokenMismatch`) if pool/USDC are placeholders. `usdcUsdFeed` may be `address(0)` (1 USDC = 1 USD fallback). That is why the flag is separate from `DEPLOY_CLP_PHASE1`.

In mainnet, **only enable the flags when the TeamVesting constructor placeholders (beneficiary address, cliff/duration dates) are replaced by real, audited values**. The default `ZeroAddress` for `teamVestingBeneficiary` causes the constructor to revert with `ZeroAddress` — this is intentional, avoiding a silent deploy with a visually invisible placeholder. In dev/testnet, pass the deployer's own address as a placeholder via `ignition/parameters/*.json`.

### Review of `production.json`

File at `ignition/parameters/production.json`. Default values:

- `timelockMinDelay: 172800` (2 days)
- `probationDuration: 2592000` (30 days)
- `roundDuration: 604800` (7 days)
- `votingDelay: 7200` (blocks; ~1d assuming 12s/block)
- `votingPeriod: 50400` (blocks; ~7d assuming 12s/block)
- `proposalThreshold: 10000e18` GOV
- `quorumNumerator: 4` (4%)
- `sanityCap: 10_000_000e18` CREDIT
- `capMax: 5_000_000e18` CREDIT
- `alpha: 0.95e18` (on-chain bounds: `[0.5e18, 0.99e18]` — see parecer econômico C2)

Any change must be documented in changelog and reviewed by 2 people besides whoever changed it.

> **L2 checklist — adjust `votingDelay` / `votingPeriod` according to target chain block time.** The defaults assume a block time of **12s (Ethereum L1)**. On L2s with much shorter block times, the nominal windows collapse:
>
> | Target chain | Block time | `votingDelay = 7200` equals | `votingPeriod = 50400` equals |
> |---|---|---|---|
> | Ethereum L1 | ~12s | ~1 day | ~7 days |
> | Arbitrum | ~0.25s | ~30 min | ~3.5h |
> | Optimism / Base | ~2s | ~4h | ~28h |
> | Polygon PoS | ~2s | ~4h | ~28h |
>
> **Before deploying on any L2, recompute `votingDelay` and `votingPeriod` in blocks to keep ~1d / ~7d windows** (or whatever the DAO decides) and update `production.json` accordingly. The same applies to `timelockMinDelay` (which is in seconds, so it does not change across chains, but deserves review against the DAO's human coordination time on that chain).

## F1 — Deploy

### Pre-flight

- [ ] Multisig has ≥ 0.5 ETH for gas (~0.3 ETH realistic + retry margin).
- [ ] Main RPC provider + fallback configured.
- [ ] `hardhat.config.ts` with mainnet RPC.
- [ ] Gas price monitored; ideal deploy < 20 gwei.

### Command

```bash
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet \
  --verify
```

Ignition is idempotent — if an error mid-run, resumes from the last confirmed step. **Do not erase** `ignition/deployments/chain-1/` until you are sure it completed.

### Ignition module phases

`Dao.ts` structures into 4 sub-phases:

- **A**: deploy of every contract (deployer = temporary admin).
- **B**: functional role grants (MINTER → distributor, BURNER → tracker, RECORDER → feeRouter, PROPOSER/CANCELLER → governor) + genesis mint of 10M CREDIT to Treasury.
- **C**: governance roles to the Timelock (`GOVERNANCE_ROLE` + `DEFAULT_ADMIN_ROLE` on every economic contract) + `transferOwnership(timelock)` on GovernanceToken.
- **D**: deployer renounces all its roles. Timelock `DEFAULT_ADMIN_ROLE` renounces **last** — if it renounces earlier, deployer loses power to grant the rest.

Genesis mint happens **before** `DEFAULT_ADMIN_ROLE` renunciation on CreditToken (`mintGenesis` is `onlyRole(DEFAULT_ADMIN_ROLE)`).

> **New CommunityGovernor argument**: the Governor's constructor gained the **Treasury** address (3rd position, after `token` and `timelock`) in Phase 1.2. `Dao.ts` already passes the immutable `treasury` — required for the `propose` scan that applies the 75% supermajority to `Treasury.removePOL` and to Treasury/Timelock role management (see [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md)). External deploy scripts that instantiate the Governor via constructor must propagate this argument.

### CLP post-deploy wiring (only if the Phase 1 flags are used)

`Dao.ts` deploys the CLP contracts but does **not** wire them. These acts are governance proposals (via the Timelock) after bootstrap:

1. **`Treasury.setPriceOracle(creditPriceOracle)`** — enables `recordDailyPrice` and `executeBuyback` (until then they revert with `BuybackInfraMissing`). Also `setSwapRouter` and `setChainlinkFeed`.
2. **`CreditToken.grantRole(MINTER_ROLE, rewardDistributorV2)`** — during a V1→V2 migration, both distributors may hold the role transiently.
3. **`LiquidityGauge.addPool(...)` + `grantRole(REWARD_NOTIFIER_ROLE, ...)`** and **`LiquidityGauge.setDenylist(treasury, true)`** (anti self-dealing D.9).
4. **`Treasury.setLiquidityGauge(gauge, poolId)`** — destination of the `flushPendingGaugeRewards` fallback.

### Post-deploy verification — BEFORE any other action

Each item is a mandatory assert via `cast` or hardhat console:

- [ ] **10 core contracts verified on Etherscan** (GovernanceToken, CreditToken, CommunityTimelock, ProjectRegistry, Treasury, Staking, BurnTracker, RewardDistributor, FeeRouter, CommunityGovernor). If the CLP flags are used, also verify LiquidityGauge, RewardDistributorV2 and/or CreditPriceOracle.
- [ ] **Timelock has `PROPOSER_ROLE` and `CANCELLER_ROLE`**:
  ```
  cast call $TIMELOCK 'hasRole(bytes32,address)(bool)' $(cast keccak "PROPOSER_ROLE") $GOVERNOR
  # → true
  cast call $TIMELOCK 'hasRole(bytes32,address)(bool)' $(cast keccak "CANCELLER_ROLE") $GOVERNOR
  # → true
  ```
- [ ] **Deployer does NOT have `DEFAULT_ADMIN_ROLE`** on any contract with AccessControl:
  ```
  cast call $REGISTRY 'hasRole(bytes32,address)(bool)' 0x00...0 $DEPLOYER
  # → false (everywhere)
  ```
- [ ] **Timelock HAS `DEFAULT_ADMIN_ROLE`** on the economic contracts.
- [ ] **`owner(GOV) == deployer`** (still — expected for bootstrap).
- [ ] **`pendingOwner(GOV) == timelock`**.
- [ ] **`CREDIT.balanceOf(treasury) == 10_000_000e18`** and **`CREDIT.totalSupply() == 10_000_000e18`**.
- [ ] **`GOV.totalSupply() == 0`** — nobody has received GOV yet.
- [ ] **FeeRouter split = (7000, 2000, 1000)** — 70% burn / 20% treasury / 10% rebate (CLP Phase 0, baked into `production.json`). The `defaultSplit` comes from the deploy parameters, it is not hardcoded in the contract.

If **any** fails: stop. Do not advance to F2. Investigate.

## F2 — Governance bootstrap (D+1 to D+12)

### Minimum mint to pass threshold

Deployer (multisig) does a single mint:

```solidity
gov.mint(
  multisigAddress,           // or bootstrap address
  12_000e18,                  // slightly above the 10k threshold
  "bootstrap"
);
```

**Do not** mint 100M. **Do not** mint the 30M treasury yet. Only the minimum to allow proposing.

Then the multisig delegates to itself:

```solidity
gov.delegate(multisigAddress);
```

### First proposal: `acceptOwnership()`

```solidity
targets    = [govTokenAddress]
values     = [0]
calldatas  = [gov.interface.encodeFunctionData("acceptOwnership")]
description = "Bootstrap 1: accept GOV ownership by Timelock"
```

Submit via:

```solidity
governor.propose(targets, values, calldatas, description);
```

- Wait `votingDelay` (~1d).
- Vote For (multisig).
- Wait `votingPeriod` (~7d).
- `queue` + `execute` after 2d.

### Post-F2 verification

- [ ] `gov.owner() == timelock`.
- [ ] `gov.pendingOwner() == address(0)`.
- [ ] Deployer multisig no longer has sovereign power over GOV. Any future mint requires a proposal.

## F3 — Distribution (D+12 to D+90)

Sequential proposals to execute the buckets. Recommendation:

1. **30% Permanent Treasury (30M)**: `gov.mint(treasury, 30_000_000e18, "treasury")`.
2. **25% Team via TeamVesting**: deploy N `TeamVesting` instances, each with a specific beneficiary. Transfer GOV from the Treasury to each instance.
3. **20% Public sale**: `gov.mint(saleContract, 20_000_000e18, "publicSale")` after the sale contract is audited and deployed.
4. **15% Community rewards**: `gov.mint(userSubsidy, 15_000_000e18, "community")` or to a future liquidity mining contract.
5. **10% Liquidity**: `gov.mint(liquidityManager, 10_000_000e18, "liquidity")` to a contract that provisions LP on DEX.

Each bucket is a separate proposal — independently reviewable.

### Post-F3 verification

- [ ] `gov.totalSupply() == 100_000_000e18` (reaches cap).
- [ ] `gov.mint(anyone, 1, "try")` reverts with `CapExceeded`.
- [ ] No individual holder (except Treasury and vesting contracts) has > 25% of active voting power.
- [ ] Public sale happens and completes.
- [ ] Liquidity provisioned on DEX with reasonable range.

## F4 — Full handoff (D+90+)

Health signals:

- Proposal participation rises to >10% of supply.
- Multisig loses majority of active vote (diverse holders enter).
- Emerging organic burn rate (apps start generating traffic).
- Stakers entering multiple projects, not only one.

The DAO can then:

- Approve new apps via Registry.
- Execute buybacks (once DEX integration is ready).
- Adjust `alpha`, `capMax` as per observed metrics.
- Contract additional audits.

## Emergency runbook

If an attack is detected:

1. **Communicate** immediately via official channels (Discord, Twitter, forum).
2. **Propose** corrective action via Governor with `description` explaining urgency.
3. If proposal is `Queued` and attacker has not yet executed: call `Governor.cancel` or `Timelock.cancel` (via counter-proposal).
4. If privileged contracts (tokens, routers) compromised: propose revoking `grantRole` + deploy replacement + migration.
5. **No unilateral guardian in v1** — any pause requires a proposal. The delay is intentional.

## Post-mainnet

- Active monitoring for ≥ 30 days.
- Bug bounty active permanently.
- Reassessment of parameters after 3 months of real data.
- Proposal to add a multisig guardian as `CANCELLER_ROLE` can be considered after maturity.

---

**Next →** [Security model](03-security-model.md)
