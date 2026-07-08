# Querying on-chain state

**Audience:** dev building UI, indexer, or contract that reads web3community state.
**Prerequisites:** [Contract addresses](02-contract-addresses.md).

## Useful state per contract

### GovernanceToken

```solidity
gov.totalSupply();              // current supply, max 100M * 1e18
gov.cap();                      // 100M * 1e18 (immutable)
gov.balanceOf(account);
gov.allowance(owner, spender);

gov.getVotes(account);                      // delegate's current voting power
gov.getPastVotes(account, blockNumber);     // historic — used by Governor
gov.getPastTotalSupply(blockNumber);        // used by quorum

gov.delegates(account);                     // whom you delegated to
gov.nonces(account);                        // for permit / delegateBySig

gov.owner();                                // in production: Timelock address
gov.pendingOwner();                         // if Ownable2Step transfer in progress
```

### CreditToken

```solidity
credit.totalSupply();
credit.balanceOf(account);
credit.allowance(owner, spender);

credit.genesisMinted();                     // true after mintGenesis
credit.hasRole(credit.MINTER_ROLE(), account);  // current: CreditPSM (legacy: RewardDistributor)
credit.hasRole(credit.BURNER_ROLE(), account);  // current: CreditPSM (legacy: BurnTracker)
credit.hasRole(credit.DEFAULT_ADMIN_ROLE(), account);  // in production: Timelock
```

### CreditPSM

```solidity
psm.backing();                              // current USDC backing (6 decimals)
psm.backingNormalized();                    // backing in 18 decimals
psm.mintedOutstanding();                    // circulating CREDIT minted by this PSM
// verifiable invariant I-PSM1: backingNormalized() >= mintedOutstanding
```

### FeeRouterV2

```solidity
feeRouterV2.feeBps();                       // fee in bps (default 250 = 2.5%)
feeRouterV2.FEE_BPS_CAP();                  // 500 — hard cap
feeRouterV2.feeSplit();                     // struct { treasuryBps, buybackBps, grantsBps } = 4000/4000/2000
feeRouterV2.treasuryRecipient();            // fee destinations
feeRouterV2.buybackRecipient();
feeRouterV2.grantsRecipient();

feeRouterV2.appRecipientOf(projectId);      // explicit recipient or 0 (= Registry owner)
feeRouterV2.grossVolumeOf(projectId);       // project's accumulated GMV — on-chain metric

feeRouterV2.previewPay(projectId, amount);  // (fee, revShare, toApp) — preview, no side effects
```

### ProjectFunding

```solidity
funding.minTarget();                        // minimum round target (default 100e18)
funding.MIN_REV_SHARE_BPS();                // 100 (1%)
funding.MAX_REV_SHARE_BPS();                // 3000 (30%)
funding.MIN_ROUND_DURATION();               // 1 day
funding.MAX_ROUND_DURATION();               // 90 days

funding.rounds(projectId);                  // struct { target, raised, deadline, revShareBps, status }
funding.revShareBpsOf(projectId);           // active rev-share (0 if round not Funded)
funding.sharesOf(projectId, investor);      // shares (== CREDIT invested)
funding.pendingRevenue(projectId, investor);// revenue pending claim
funding.totalRevenueDistributed(projectId); // total revenue already distributed (audit/UI)
funding.accRevenuePerShare(projectId);      // MasterChef accumulator (1e18)
```

Round status enum: `0=None`, `1=Open`, `2=Funded`, `3=Failed`.

### ProjectRegistry

```solidity
registry.totalProjects();                   // how many projects have been created
registry.govToken();                        // GOV address
registry.minCollateral();                   // current minimum collateral
registry.probationDuration();               // initial probation duration

registry.getProject(projectId);             // struct { owner, collateral, status, activatedAt, probationEndsAt, metadataURI }
registry.isActive(projectId);               // bool — false for any status != Active
registry.isInProbation(projectId);          // bool — only INITIAL time-based probation
registry.pendingOwner(projectId);           // pending address in 2-step transfer

registry.hasRole(registry.GOVERNANCE_ROLE(), account);  // in production: Timelock
```

Status enum: `0=Pending`, `1=Active`, `2=Probation`, `3=Removed`.

### Treasury

```solidity
treasury.balanceOf(IERC20 token);          // token balance in treasury
address(treasury).balance;                  // ETH
treasury.hasRole(treasury.GOVERNANCE_ROLE(), account);  // Timelock
```

### Staking

```solidity
staking.MIN_LOCK();                         // 14 days
staking.MAX_LOCK();                         // 365 days
staking.MAX_MULTIPLIER();                   // 4e18
staking.MULTIPLIER_PRECISION();             // 1e18

staking.positions(user, projectId);         // struct StakePosition
staking.getPosition(user, projectId);       // ditto, via view
staking.getWeight(user, projectId);         // current weight
staking.getWeightAt(user, projectId, block); // historic snapshot

staking.totalStakedByProject(projectId);    // aggregate amount
staking.totalStaked();                      // global
staking.getTotalWeight(projectId);          // project's aggregate weight
staking.getTotalWeightAt(projectId, block);
staking.getGlobalWeight();
staking.getGlobalWeightAt(block);

staking.getLockEnd(user, projectId);        // expiration timestamp
staking.isUnlocked(user, projectId);        // bool

staking.multiplier(lockDuration);           // pure — compute multiplier for lock X
```

### BurnTracker (legacy)

```solidity
burnTracker.currentRound();                 // ongoing round
burnTracker.roundStartedAt();               // start timestamp
burnTracker.roundDuration();                // target duration

burnTracker.MIN_ROUND_DURATION();           // 1 day
burnTracker.MAX_ROUND_DURATION();           // 30 days

burnTracker.maxBurnPerRoundPerProject();    // sanity cap

burnTracker.totalBurnByRound(round);
burnTracker.burnByRoundProject(round, projectId);
burnTracker.projectsWithBurnCount(round);

burnTracker.getBurnForProjectInRound(round, projectId);  // named view
burnTracker.getTotalBurnForRound(round);                 // named view
burnTracker.getRoundEndsAt();                            // roundStartedAt + roundDuration
burnTracker.isRoundReadyToClose();                       // now >= endsAt

burnTracker.hasRole(burnTracker.RECORDER_ROLE(), account);  // listed apps
burnTracker.hasRole(burnTracker.GOVERNANCE_ROLE(), account); // Timelock
```

### RewardDistributor (legacy)

```solidity
rd.alpha();                                 // FP 1e18
rd.capMax();
rd.MIN_ALPHA(); rd.MAX_ALPHA();
rd.MIN_CAPMAX(); rd.MAX_CAPMAX();
rd.FLOOR_SCHEDULE_LENGTH();                 // 24
rd.PROBATION_PENALTY_DENOM();               // 4
rd.floorSchedule(index);                    // floor[index], 0-23

rd.lastFinalizedRound();
rd.isFirstRoundFinalized();

rd.roundData(round);                        // { totalEmission, totalBurnAtFinalize, snapshotBlock, finalized }
rd.isFinalized(round);                      // bool

rd.claimed(round, projectId, user);         // bool

rd.previewClaim(user, round, projectId);    // how much the user would receive
rd.previewEmission(round);                  // estimated emission
rd.getEmission(round);                      // emission (0 if not finalized)
rd.getProjectEmission(round, projectId);    // project's share
```

### FeeRouter V1 (legacy)

```solidity
feeRouter.defaultSplit();                   // struct Split
feeRouter.projectSplit(projectId);          // struct Split (always readable, even if no override)
feeRouter.hasProjectSplit(projectId);       // bool

feeRouter.appRecipient(projectId);          // explicit address or 0 (= dynamic lookup)
feeRouter.getEffectiveSplit(projectId);     // override or default
feeRouter.getEffectiveRecipient(projectId); // override or Registry owner

feeRouter.quote(projectId, amount);         // (burned, toTreasury, toApp)
```

### CommunityGovernor

```solidity
governor.token();                           // GOV
governor.timelock();                        // CommunityTimelock
governor.votingDelay();                     // blocks
governor.votingPeriod();                    // blocks
governor.proposalThreshold();
governor.quorumNumerator();

governor.state(proposalId);                 // ProposalState enum
governor.proposalSnapshot(proposalId);
governor.proposalDeadline(proposalId);
governor.proposalProposer(proposalId);
governor.proposalNeedsQueuing(proposalId);
governor.proposalEta(proposalId);           // estimated execution timestamp

governor.hasVoted(proposalId, account);
governor.proposalVotes(proposalId);         // (againstVotes, forVotes, abstainVotes)
governor.quorum(timepoint);                 // minimum quorum at this block
```

### CommunityTimelock

```solidity
timelock.getMinDelay();                     // 2 days in production

timelock.isOperation(id);
timelock.isOperationPending(id);
timelock.isOperationReady(id);              // reached delay
timelock.isOperationDone(id);
timelock.getTimestamp(id);                  // when it becomes ready

timelock.hasRole(PROPOSER_ROLE, account);   // in production: Governor
timelock.hasRole(EXECUTOR_ROLE, account);   // in production: address(0) — everyone executes
timelock.hasRole(CANCELLER_ROLE, account);  // in production: Governor
```

## Useful events to index

```
# GovernanceToken
event Minted(address indexed to, uint256 amount, string tag);
event Transfer(...);  # standard ERC-20
event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);

# CreditToken
event GenesisMinted(address indexed to, uint256 amount);
event Minted(address indexed to, uint256 amount, string tag);
event BurnedByRole(address indexed operator, address indexed from, uint256 amount, string tag);

# ProjectRegistry
event ProjectRegistered(uint256 indexed projectId, address indexed owner, uint256 collateral, string metadataURI);
event ProjectActivated(uint256 indexed projectId, uint64 activatedAt, uint64 probationEndsAt);
event ProjectProbation(uint256 indexed projectId);
event ProjectReactivated(uint256 indexed projectId);
event ProjectRemoved(uint256 indexed projectId, bool slashed, uint256 collateralReturned);

# Staking
event Staked(address indexed user, uint256 indexed projectId, uint256 amount, uint64 lockDuration, uint64 lockStartAt, uint256 weight);
event Unstaked(address indexed user, uint256 indexed projectId, uint256 amount, uint256 remaining, uint256 newWeight);

# BurnTracker
event BurnRecorded(uint256 indexed round, uint256 indexed projectId, address indexed from, uint256 amount, uint256 newTotalForProject);
event RoundClosed(uint256 indexed round, uint256 totalBurn, uint256 projectsCount, uint64 closedAt, bool earlyClose);

# RewardDistributor
event RoundFinalized(uint256 indexed round, uint256 totalEmission, uint256 totalBurnAtFinalize, uint64 snapshotBlock);
event Claimed(address indexed user, uint256 indexed round, uint256 indexed projectId, uint256 amount);

# CreditPSM
event Bought(address indexed user, uint256 usdcIn, uint256 creditOut);
event Sold(address indexed user, uint256 creditIn, uint256 usdcOut);

# FeeRouterV2
event PaymentRouted(uint256 indexed projectId, address indexed payer, uint256 amount, uint256 feeToTreasury, uint256 feeToBuyback, uint256 feeToGrants, uint256 revShare, uint256 toApp);

# ProjectFunding
event RoundOpened(uint256 indexed projectId, uint256 target, uint16 revShareBps, uint64 deadline);
event Invested(uint256 indexed projectId, address indexed investor, uint256 amount, uint256 totalRaised);
event RoundFunded(uint256 indexed projectId, uint256 raised, address indexed paidTo);
event RevenueNotified(uint256 indexed projectId, uint256 amount);
event RevenueClaimed(uint256 indexed projectId, address indexed investor, uint256 amount);

# FeeRouter V1 (legacy)
event Paid(uint256 indexed projectId, address indexed user, address indexed payer, uint256 amount, uint256 burned, uint256 toTreasury, uint256 toApp, address recipient);

# CommunityGovernor (includes OZ default)
event ProposalCreated(...);
event VoteCast(...);
event ProposalExecuted(proposalId);
```

## Read patterns

### Preview before tx

Every mutating function has a "preview" via view:

- `FeeRouterV2.previewPay(projectId, amount)` — fee/rev-share/toApp preview.
- `ProjectFunding.pendingRevenue(projectId, investor)` — how much `claim` would withdraw now.
- `FeeRouter.quote(projectId, amount)` — split preview (legacy).
- `RewardDistributor.previewClaim(user, round, projectId)` — reward preview (legacy).

Use in UI to show values before the user signs.

### Batch reads

Multicall (or similar) is useful to read aggregate state. Example — build investor dashboard:

```
user.balanceOf(GOV) / user.balanceOf(CREDIT)
staking.getWeight(user, projectId) for each staked projectId
funding.rounds(projectId) + sharesOf(projectId, user) for each
funding.pendingRevenue(projectId, user) for each
feeRouterV2.grossVolumeOf(projectId) for each (GMV)
psm.backingNormalized() vs psm.mintedOutstanding() (peg health)
```

## Historic snapshots

For staking weight (`getWeightAt`, `getTotalWeightAt`, `getGlobalWeightAt`), **only reliable for `blockNumber < block.number`**. At the current block, the checkpoint may still be being written.

## When to use events vs views

- **Events** — historical flow, indexing, timelines, caches. Immutable and ordered.
- **Views** — current state, derivations. Cheap, but only gives a snapshot of "now".

Combine both: events for history, views for real-time validation.

---

**Next →** [Local environment](05-local-dev.md)
