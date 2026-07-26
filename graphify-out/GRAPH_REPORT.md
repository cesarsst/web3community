# Graph Report - /home/ubuntu/web3community  (2026-07-09)

## Corpus Check
- Large corpus: 293 files · ~1,261,159 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 972 nodes · 1721 edges · 55 communities (40 shown, 15 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 49 edges (avg confidence: 0.83)
- Token cost: 158,600 input · 54,900 output

## Community Hubs (Navigation)
- Tokenomics & Economic Model
- ProjectRegistry Contract
- Staking Contract
- CreditPSM & CreditToken
- Contract Map (Legacy vs Remodel)
- ProjectFunding Rounds
- Risk, Metrics & Governance Concepts
- Governance & Treasury Wiring
- Governor & Timelock Audits
- Dev Tooling & Lint Config
- Ecosystem Diagram (PNG)
- Ignition Deploy Modules & Roles
- Vesting/Subsidy Deploy Scripts
- package.json Manifest
- FeeRouterV2 Contract
- Ecosystem Diagram (2x/SVG)
- TeamVesting Contract
- Treasury Contract
- DevFaucet Contract
- GovernanceToken Contract
- Slither Findings Triage
- tsconfig
- Reentrant Staking Mock
- Rewards V1/V2 & CLP Legacy
- ERC20 Mock & Governor Tests
- FeeRouter Bypass Simulation
- Reentrant ERC20 Mock
- Prettier Config
- DAO Agents & Invariants
- Project Brain & Remodel Docs
- FeeRouter V1 & Burn Audits
- CLP Pivot & Peg Pareceres
- Reentrant Call Mock
- Runtime Config Export
- Slide Generator Script
- ERC20 Decimals Mock
- Reentrant ETH Receiver
- Reentrant Credit Mock
- Governor Supermajority Test
- Treasury Tests
- Finding: arbitrary transferFrom
- UserSubsidy Contract
- ProjectRegistry Tests
- Finding: Treasury.sweepETH
- boot-node script
- hardhat.config
- lint-sol script
- sync-frontend script
- GovernanceToken Tests
- ProjectRegistry Timelock Test
- Community 53
- Community 54

## God Nodes (most connected - your core abstractions)
1. `ProjectRegistry` - 82 edges
2. `ProjectFunding` - 59 edges
3. `Staking` - 59 edges
4. `Treasury` - 41 edges
5. `FeeRouterV2` - 36 edges
6. `CommunityGovernor` - 34 edges
7. `GovernanceToken` - 31 edges
8. `CreditToken` - 27 edges
9. `CreditPSM` - 25 edges
10. `TeamVesting` - 22 edges

## Surprising Connections (you probably didn't know these)
- `FFP — Floating with Floor Price` --semantically_similar_to--> `CreditPSM`  [INFERRED] [semantically similar]
  audit/economist/2026-04-24-credit-peg.md → contracts/CreditPSM.sol
- `ProjectFunding` --semantically_similar_to--> `RewardDistributorV2 (bucket-aware 55/25/15/5)`  [INFERRED] [semantically similar]
  contracts/ProjectFunding.sol → CHANGELOG.md
- `CommunityGovernor` --implements--> `Supermajority 75% for removePOL / role-management proposals`  [EXTRACTED]
  contracts/CommunityGovernor.sol → CHANGELOG.md
- `scripts/deploy-remodel.ts (PSM/FeeRouterV2/ProjectFunding deploy)` --references--> `CreditPSM`  [EXTRACTED]
  CHANGELOG.md → contracts/CreditPSM.sol
- `FeeRouter.pay` --calls--> `CreditToken`  [EXTRACTED]
  audit/slither/FeeRouter.txt → contracts/CreditToken.sol

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Remodel 2026-07-08 contract set (payment rail + rev-share)** — brain_remodel_2026_07_08, contracts_creditpsm_creditpsm, contracts_feerouterv2_feerouterv2, contracts_projectfunding_projectfunding [EXTRACTED 1.00]
- **CLP Phase 1 flywheel (FFP + POL + Gauge + Bucket Split)** — audit_economist_2026_04_24_clp_pivot_clp, contracts_treasury_treasury, contracts_liquiditygauge_liquiditygauge, contracts_rewarddistributorv2_rewarddistributorv2, contracts_creditpriceoracle_creditpriceoracle [EXTRACTED 1.00]
- **DAO agent pipeline (dev / economist / docs)** — _claude_agents_dao_dev_dao_dev, _claude_agents_dao_economist_dao_economist, _claude_agents_dao_docs_dao_docs [EXTRACTED 1.00]
- **2026-07-08 remodel: payment rail + rev-share funding stack** — contracts_creditpsm_creditpsm, contracts_feerouterv2_feerouterv2, contracts_projectfunding_projectfunding, docs_en_01_getting_started_03_glossary_remodel_2026_07_08 [EXTRACTED 1.00]
- **Legacy burn-to-mint cycle (kept deployed for historical compatibility)** — contracts_feerouter_feerouter, contracts_burntracker_burntracker, contracts_rewarddistributor_rewarddistributor, contracts_credittoken_credittoken, docs_en_01_getting_started_03_glossary_burn_to_mint [EXTRACTED 1.00]
- **RewardDistributor claim call chain (claimMany -> _claim -> _calculateClaim -> _projectShare across Staking/BurnTracker/Registry)** — contracts_rewarddistributor_claimmany, contracts_rewarddistributor__claim, contracts_rewarddistributor__calculateclaim, contracts_rewarddistributor__projectshare, contracts_staking_staking, contracts_burntracker_burntracker, contracts_projectregistry_projectregistry [EXTRACTED 1.00]
- **Current Payment Rail (2026-07-08 Remodel)** — docs_en_03_protocol_overview_01_architecture_creditpsm, docs_en_02_core_concepts_07_treasury_and_fees_feerouterv2, docs_en_03_protocol_overview_01_architecture_projectfunding, docs_en_03_protocol_overview_01_architecture_staking_contract, docs_en_02_core_concepts_06_project_whitelist_project_registry [EXTRACTED 1.00]
- **Legacy Burn-to-Mint Emission Cycle** — docs_en_02_core_concepts_03_burn_to_mint_burn_to_mint_cycle, docs_en_02_core_concepts_03_burn_to_mint_emission_formula, docs_en_02_core_concepts_03_burn_to_mint_floor_schedule, docs_en_02_core_concepts_04_rewards_distribution_bucket_split, docs_en_03_protocol_overview_01_architecture_legacy_rail [EXTRACTED 1.00]
- **DAO Governance Pipeline (delegate -> propose -> vote -> queue -> execute)** — docs_en_02_core_concepts_01_dual_token_economy_gov_token, docs_en_04_for_users_02_holding_gov_delegation, docs_en_02_core_concepts_05_governance_community_governor, docs_en_02_core_concepts_05_governance_community_timelock, docs_en_04_for_users_04_voting_proposal_lifecycle [EXTRACTED 1.00]
- **DAO Governance Execution Flow (Token -> Governor -> Timelock)** — docs_en_08_contracts_reference_01_governancetoken_governancetoken, docs_en_08_contracts_reference_10_communitygovernor_communitygovernor, docs_en_08_contracts_reference_09_communitytimelock_communitytimelock, docs_en_07_governance_01_proposal_lifecycle_proposal_lifecycle [EXTRACTED 1.00]
- **Legacy Burn-to-Mint Emission Rail (pre-remodel)** — docs_en_08_contracts_reference_02_credittoken_credittoken, docs_en_08_contracts_reference_06_burntracker_burntracker, docs_en_08_contracts_reference_07_rewarddistributor_rewarddistributor, docs_en_08_contracts_reference_07b_rewarddistributorv2_rewarddistributorv2, docs_en_08_contracts_reference_08_feerouter_feerouter, docs_en_08_contracts_reference_05_staking_staking [EXTRACTED 1.00]
- **2026-07-08 Remodel Stable Payment Rail (PSM + FeeRouterV2 + ProjectFunding)** — docs_en_08_contracts_reference_15_creditpsm_creditpsm, docs_en_08_contracts_reference_08b_feerouterv2_feerouterv2, docs_en_08_contracts_reference_16_projectfunding_projectfunding, docs_en_08_contracts_reference_02_credittoken_credittoken [EXTRACTED 1.00]
- **DAO governance pipeline (propose -> vote -> queue -> execute)** — docs_es_08_contracts_reference_10_communitygovernor_communitygovernor, docs_es_08_contracts_reference_09_communitytimelock_communitytimelock, docs_es_08_contracts_reference_10_communitygovernor_governancetoken [EXTRACTED 1.00]
- **Remodel 2026-07-08 payment rail + rev-share flow** — docs_es_08_contracts_reference_08b_feerouterv2_feerouterv2, docs_es_08_contracts_reference_16_projectfunding_projectfunding, docs_es_08_contracts_reference_15_creditpsm_creditpsm, docs_es_08_contracts_reference_15_creditpsm_credittoken, docs_governance_fase1_1_buyback_ffp_treasury [EXTRACTED 1.00]
- **Legacy burn-to-mint emission cycle (pay -> burn -> record -> finalize -> claim)** — docs_es_08_contracts_reference_08_feerouter_feerouter, docs_es_08_contracts_reference_06_burntracker_burntracker, docs_es_08_contracts_reference_07_rewarddistributor_rewarddistributor, docs_es_08_contracts_reference_07b_rewarddistributorv2_rewarddistributorv2, docs_es_08_contracts_reference_13_liquiditygauge_liquiditygauge, docs_es_08_contracts_reference_15_creditpsm_credittoken [EXTRACTED 1.00]
- **Pipeline de execucao da governanca (GOV vota, Governor propoe/conta, Timelock executa)** — docs_pt_br_08_contracts_reference_10_communitygovernor_governancetoken, docs_pt_br_08_contracts_reference_10_communitygovernor_communitygovernor, docs_pt_br_08_contracts_reference_09_communitytimelock_communitytimelock, docs_pt_br_08_contracts_reference_10_communitygovernor_supermajority_pol_gate [EXTRACTED 1.00]
- **Remodel 2026-07-08: trilho de pagamento estavel + rev-share** — docs_pt_br_08_contracts_reference_15_creditpsm_creditpsm, docs_pt_br_08_contracts_reference_16_projectfunding_feerouterv2, docs_pt_br_08_contracts_reference_16_projectfunding_projectfunding, docs_pt_br_08_contracts_reference_15_creditpsm_credittoken [EXTRACTED 1.00]
- **Stack CLP Fase 1 (legado pos-remodel): gauge + distributor V2 + oracle TWAP** — docs_pt_br_08_contracts_reference_13_liquiditygauge_liquiditygauge, docs_pt_br_08_contracts_reference_13_liquiditygauge_rewarddistributorv2, docs_pt_br_08_contracts_reference_14_creditpriceoracle_creditpriceoracle [EXTRACTED 1.00]

## Communities (55 total, 15 thin omitted)

### Community 0 - "Tokenomics & Economic Model"
Cohesion: 0.06
Nodes (76): CREDIT Token, Dual-Token Economy (GOV and CREDIT), Dual-Token Separation Principle, GOV Governance Token, Directed Staking Mechanism, Directed Staking, Staked-GOV Investment Gate, Lock Multiplier (1x-4x, 14-365 days) (+68 more)

### Community 1 - "ProjectRegistry Contract"
Cohesion: 0.07
Nodes (34): Slither Report: ProjectRegistry, Slither Report (project-only): ProjectRegistry, ProjectRegistry, EmptyMetadataURI, InsufficientAllowance, InsufficientCollateral, InvalidStatus, MetadataUpdated (+26 more)

### Community 2 - "Staking Contract"
Cohesion: 0.07
Nodes (29): Slither Report: Staking, Slither Report (project-only): Staking, Checkpoints, IERC20, ReentrancyGuard, SafeERC20, Staking, CannotShortenLock (+21 more)

### Community 3 - "CreditPSM & CreditToken"
Cohesion: 0.08
Nodes (34): Slither Report: CreditToken, Slither report — CreditToken (project-only, 0 findings), CreditPSM, Bought, DustAmount, InsufficientBacking, InvalidDecimals, Sold (+26 more)

### Community 4 - "Contract Map (Legacy vs Remodel)"
Cohesion: 0.10
Nodes (47): Burn-to-mint (modelo legado), BurnTracker, Consistency audit (2026-04-22), RewardDistributor V1, RewardDistributorV2, FeeRouter V1, Parecer economico FeeRouter bypass (2026-07-08), FeeRouterV2 (+39 more)

### Community 5 - "ProjectFunding Rounds"
Cohesion: 0.08
Nodes (32): ProjectFunding, DurationOutOfBounds, ExceedsTarget, Invested, MinTargetUpdated, NoActiveShares, NoGovStaked, NothingToClaim (+24 more)

### Community 6 - "Risk, Metrics & Governance Concepts"
Cohesion: 0.09
Nodes (45): App Revenue Risk, Flash-Loan Attack Risk (Vote and Reward), Governance Capture Risk, PSM Peg/Backing Risk, Regulatory Risk, Wash-Burn Attack Risk (Legacy), Gross Volume per Project (GMV) Metric, PSM Backing Metric (CREDIT Peg) (+37 more)

### Community 7 - "Governance & Treasury Wiring"
Cohesion: 0.08
Nodes (45): CommunityTimelock, TimelockController (OZ), CommunityGovernor, GovernanceToken, Supermaioria 75% para remocao de POL, Treasury, Ownable2Step (OZ), TeamVesting (+37 more)

### Community 8 - "Governor & Timelock Audits"
Cohesion: 0.07
Nodes (19): Slither report — CommunityGovernor (project-only, 0 findings), Slither report — CommunityGovernor (full incl. OZ deps), Slither report — CommunityTimelock (project-only, 0 findings), Slither report — CommunityTimelock (full incl. OZ deps), CommunityGovernor, ProposalType, ProposalTypeSet, TimelockController (+11 more)

### Community 9 - "Dev Tooling & Lint Config"
Cohesion: 0.06
Nodes (33): devDependencies, dotenv, eslint, eslint-config-prettier, hardhat, @nomicfoundation/hardhat-ignition-ethers, @nomicfoundation/hardhat-toolbox, prettier (+25 more)

### Community 10 - "Ecosystem Diagram (PNG)"
Cohesion: 0.15
Nodes (33): web3community Ecosystem Diagram (Dual-token DAO: Pay → Burn → Mint → Reward), Alice (staker actor: locks GOV in projectId), App (dApp team actor: Apps bucket 15% + direct 5% rebate per pay, 10k GOV collateral, 30d probation), App (dApp team actor), Apps bucket (15% + direct 5% rebate · push to ownerRecipient · 10k GOV collateral · 30d probation), Bob (LP actor: stakes V3 NFT in gauge), BurnTracker (logs burn per project per round, supply decreases), Charlie (user actor: swaps USDC->CREDIT, pays the App) (+25 more)

### Community 11 - "Ignition Deploy Modules & Roles"
Cohesion: 0.08
Nodes (19): BURNER_ROLE, CANCELLER_ROLE, CommunityDAOModule, FLOOR_SCHEDULE, GOVERNANCE_ROLE, MINTER_ROLE, PROPOSER_ROLE, RECORDER_ROLE (+11 more)

### Community 12 - "Vesting/Subsidy Deploy Scripts"
Cohesion: 0.15
Nodes (23): TeamVestingModule, UserSubsidyModule, DESCRIPTION, loadFeeRouterAddress(), main(), NEW_SPLIT, STATE_NAMES, DESCRIPTION (+15 more)

### Community 13 - "package.json Manifest"
Cohesion: 0.07
Nodes (29): dependencies, @openzeppelin/contracts, description, engines, node, license, name, private (+21 more)

### Community 14 - "FeeRouterV2 Contract"
Cohesion: 0.13
Nodes (19): FeeRouterV2, AppRecipientUpdated, FeeAboveCap, FeeSplit, FeeSplitUpdated, FeeUpdated, NotProjectOwner, PaymentRouted (+11 more)

### Community 15 - "Ecosystem Diagram (2x/SVG)"
Cohesion: 0.12
Nodes (27): web3community Ecosystem Diagram (2x), Alice (staker actor), App (dApp team actor), Apps bucket (15% + direct 5% rebate per pay), Bob (LP actor), Step 3: Burn 95% (BurnTracker logs burn per project/round), BurnTracker, Step 1: Buy CREDIT (USDC swap on Uniswap V3) (+19 more)

### Community 16 - "TeamVesting Contract"
Cohesion: 0.14
Nodes (15): Slither Report: TeamVesting, Slither Report (project-only): TeamVesting, IERC20, Ownable, Ownable2Step, SafeERC20, TeamVesting, AlreadyRevoked (+7 more)

### Community 17 - "Treasury Contract"
Cohesion: 0.17
Nodes (14): Slither Report: Treasury, Slither Report (project-only): Treasury, AccessControl, IERC20, ReentrancyGuard, SafeERC20, Treasury, EthReceived (+6 more)

### Community 18 - "DevFaucet Contract"
Cohesion: 0.17
Nodes (12): DevFaucet, Claimed, CooldownActive, DripConfigured, EthTransferFailed, FaucetEmpty, Funded, ZeroAddress (+4 more)

### Community 19 - "GovernanceToken Contract"
Cohesion: 0.15
Nodes (13): Slither Report: GovernanceToken, Slither Report (project-only): GovernanceToken, GovernanceToken, CapExceeded, Minted, ZeroAddress, ZeroAmount, ERC20 (+5 more)

### Community 20 - "Slither Findings Triage"
Cohesion: 0.12
Nodes (17): Finding: external calls inside loop in RewardDistributor claim path, Triage ACCEPTED: TeamVesting.release amount == 0 strict equality, Triage ACCEPTED: TeamVesting timestamp dependence, Triage ACCEPTED: UserSubsidy campaign deadline timestamp dependence, BurnTracker.getBurnForProjectInRound, CreditToken.mint, ProjectRegistry.isInProbation, RewardDistributor._calculateClaim (+9 more)

### Community 21 - "tsconfig"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, noImplicitAny, outDir (+8 more)

### Community 22 - "Reentrant Staking Mock"
Cohesion: 0.17
Nodes (3): IReentrantStakingTarget, ReentrantStakingERC20Mock, ERC20

### Community 23 - "Rewards V1/V2 & CLP Legacy"
Cohesion: 0.24
Nodes (11): Slither Report: RewardDistributor, Slither Report (project-only): RewardDistributor, On-chain segregation of reserved CREDIT balances, IUniswapV3Staker (pinned slim interface), LiquidityGauge (UniswapV3Staker adapter), RewardDistributor (V1, legacy claim-only), RewardDistributorV2 (bucket-aware 55/25/15/5), CLP (Credit Liquidity Protocol, legacy pivot) (+3 more)

### Community 24 - "ERC20 Mock & Governor Tests"
Cohesion: 0.20
Nodes (4): ERC20Mock, ERC20, deployFixture(), deployFixture()

### Community 25 - "FeeRouter Bypass Simulation"
Cohesion: 0.20
Nodes (7): base, BUCKETS, fr0, fr100, fr30, SPLIT, t

### Community 26 - "Reentrant ERC20 Mock"
Cohesion: 0.27
Nodes (3): IReentrancyTarget, ReentrantERC20Mock, ERC20

### Community 27 - "Prettier Config"
Cohesion: 0.20
Nodes (9): bracketSpacing, overrides, plugins, printWidth, semi, singleQuote, tabWidth, trailingComma (+1 more)

### Community 28 - "DAO Agents & Invariants"
Cohesion: 0.33
Nodes (9): Code invariants I1–I7, dao-dev agent (Solidity pipeline), Regulatory guard (Howey test wording scan), dao-docs agent (multi-locale docs curator), dao-economist agent (tokenomics auditor), Economic invariants IE1–IE10, Parecer 2026-04-22 — code↔docs consistency audit, CHANGELOG.md (Keep a Changelog) (+1 more)

### Community 29 - "Project Brain & Remodel Docs"
Cohesion: 0.31
Nodes (9): Protocol state digest (auto-generated), GitHub Actions — Deploy to Production (web3c-hardhat), FeeRouter bypass incentive (dominant strategy), Parecer 2026-07-08 — FeeRouter bypass incentive, BRAIN.md — shared project brain, REMODEL 2026-07-08 — payment rail + rev-share, CLAUDE.md — backend repo rules, Burn-to-mint economic model (legacy) (+1 more)

### Community 30 - "FeeRouter V1 & Burn Audits"
Cohesion: 0.33
Nodes (9): Slither report — BurnTracker (project-only), Slither report — BurnTracker (full incl. OZ deps), Slither Report: FeeRouter, Slither Report (project-only): FeeRouter, BurnTracker, FeeRouter (V1, legacy split 70/20/10), Glossary, Burn-to-mint cycle (legacy) (+1 more)

### Community 31 - "CLP Pivot & Peg Pareceres"
Cohesion: 0.32
Nodes (8): CLP pivot (Credit Liquidity Protocol), Parecer 2026-04-24 — CLP pivot, FFP — Floating with Floor Price, Parecer 2026-04-24 — CREDIT peg model, Parecer 2026-04-24 — POL operational parameters (Anexo C), POL — Protocol Owned Liquidity (operational params), Supermajority 75% for removePOL / role-management proposals, CreditPriceOracle (UniV3 TWAP + Chainlink sanity)

### Community 33 - "Runtime Config Export"
Cohesion: 0.25
Nodes (7): addresses, body, CHAIN_ID, deployFile, devFile, FUTURE_ID_TO_NAME, raw

### Community 34 - "Slide Generator Script"
Cohesion: 0.38
Nodes (3): accent_bar(), kicker(), txt()

### Community 39 - "Treasury Tests"
Cohesion: 0.83
Nodes (3): deployCrossFnFixture(), deployFixture(), deployReentrantFixture()

### Community 40 - "Finding: arbitrary transferFrom"
Cohesion: 0.67
Nodes (3): Finding: arbitrary from in transferFrom (FeeRouter.pay / ProjectRegistry.registerProject), FeeRouter.pay, ProjectRegistry.registerProject

### Community 41 - "UserSubsidy Contract"
Cohesion: 1.00
Nodes (3): Slither Report: UserSubsidy, Slither Report (project-only): UserSubsidy, UserSubsidy (Merkle campaigns)

## Knowledge Gaps
- **160 isolated node(s):** `semi`, `singleQuote`, `trailingComma`, `printWidth`, `tabWidth` (+155 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ProjectRegistry` connect `ProjectRegistry Contract` to `Staking Contract`, `CreditPSM & CreditToken`, `ProjectFunding Rounds`, `ProjectRegistry Tests`, `FeeRouterV2 Contract`, `Slither Findings Triage`, `ProjectRegistry Timelock Test`, `Rewards V1/V2 & CLP Legacy`, `ERC20 Mock & Governor Tests`, `Project Brain & Remodel Docs`, `FeeRouter V1 & Burn Audits`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `Treasury` connect `Treasury Contract` to `CreditPSM & CreditToken`, `Reentrant ETH Receiver`, `Governor Supermajority Test`, `Treasury Tests`, `Governor & Timelock Audits`, `UserSubsidy Contract`, `TeamVesting Contract`, `Slither Findings Triage`, `Rewards V1/V2 & CLP Legacy`, `ERC20 Mock & Governor Tests`, `Project Brain & Remodel Docs`, `FeeRouter V1 & Burn Audits`, `CLP Pivot & Peg Pareceres`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `Staking` connect `Staking Contract` to `ProjectRegistry Contract`, `CreditPSM & CreditToken`, `ProjectFunding Rounds`, `GovernanceToken Contract`, `Rewards V1/V2 & CLP Legacy`, `Project Brain & Remodel Docs`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **What connects `semi`, `singleQuote`, `trailingComma` to the rest of the system?**
  _172 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Tokenomics & Economic Model` be split into smaller, more focused modules?**
  _Cohesion score 0.05824561403508772 - nodes in this community are weakly interconnected._
- **Should `ProjectRegistry Contract` be split into smaller, more focused modules?**
  _Cohesion score 0.07071887784921099 - nodes in this community are weakly interconnected._
- **Should `Staking Contract` be split into smaller, more focused modules?**
  _Cohesion score 0.07390648567119155 - nodes in this community are weakly interconnected._