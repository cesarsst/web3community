# Consultar estado on-chain

**Audiencia:** dev construyendo UI, indexer o contrato que lee estado de web3community.
**Requisitos previos:** [Direcciones de los contratos](02-contract-addresses.md).

## Estado útil por contrato

### GovernanceToken

```solidity
gov.totalSupply();              // supply actual, max 100M * 1e18
gov.cap();                      // 100M * 1e18 (inmutable)
gov.balanceOf(account);
gov.allowance(owner, spender);

gov.getVotes(account);                      // voting power actual del delegate
gov.getPastVotes(account, blockNumber);     // historico — usado por el Governor
gov.getPastTotalSupply(blockNumber);        // usado por el quorum

gov.delegates(account);                     // a quien delegaste
gov.nonces(account);                        // para permit / delegateBySig

gov.owner();                                // en produccion: address del Timelock
gov.pendingOwner();                         // si Ownable2Step transferencia en curso
```

### CreditToken

```solidity
credit.totalSupply();
credit.balanceOf(account);
credit.allowance(owner, spender);

credit.genesisMinted();                     // true tras mintGenesis
credit.hasRole(credit.MINTER_ROLE(), account);  // en produccion: RewardDistributor
credit.hasRole(credit.BURNER_ROLE(), account);  // en produccion: BurnTracker
credit.hasRole(credit.DEFAULT_ADMIN_ROLE(), account);  // en produccion: Timelock
```

### ProjectRegistry

```solidity
registry.totalProjects();                   // cuantos proyectos se crearon
registry.govToken();                        // direccion del GOV
registry.minCollateral();                   // colateral minimo actual
registry.probationDuration();               // duracion de la probation inicial

registry.getProject(projectId);             // struct { owner, collateral, status, activatedAt, probationEndsAt, metadataURI }
registry.isActive(projectId);               // bool — false para cualquier status != Active
registry.isInProbation(projectId);          // bool — solo probation INICIAL por tiempo
registry.pendingOwner(projectId);           // direccion pendiente en transferencia 2-step

registry.hasRole(registry.GOVERNANCE_ROLE(), account);  // en produccion: Timelock
```

Enum Status: `0=Pending`, `1=Active`, `2=Probation`, `3=Removed`.

### Treasury

```solidity
treasury.balanceOf(IERC20 token);          // saldo del token en treasury
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
staking.getPosition(user, projectId);       // idem, via view
staking.getWeight(user, projectId);         // peso actual
staking.getWeightAt(user, projectId, block); // snapshot historico

staking.totalStakedByProject(projectId);    // amount agregado
staking.totalStaked();                      // global
staking.getTotalWeight(projectId);          // peso agregado del proyecto
staking.getTotalWeightAt(projectId, block);
staking.getGlobalWeight();
staking.getGlobalWeightAt(block);

staking.getLockEnd(user, projectId);        // timestamp de expiracion
staking.isUnlocked(user, projectId);        // bool

staking.multiplier(lockDuration);           // pure — calcular multiplier para lock X
```

### BurnTracker

```solidity
burnTracker.currentRound();                 // round en curso
burnTracker.roundStartedAt();               // timestamp del start
burnTracker.roundDuration();                // duracion objetivo

burnTracker.MIN_ROUND_DURATION();           // 1 day
burnTracker.MAX_ROUND_DURATION();           // 30 days

burnTracker.maxBurnPerRoundPerProject();    // sanity cap

burnTracker.totalBurnByRound(round);
burnTracker.burnByRoundProject(round, projectId);
burnTracker.projectsWithBurnCount(round);

burnTracker.getBurnForProjectInRound(round, projectId);  // view nombrado
burnTracker.getTotalBurnForRound(round);                 // view nombrado
burnTracker.getRoundEndsAt();                            // roundStartedAt + roundDuration
burnTracker.isRoundReadyToClose();                       // now >= endsAt

burnTracker.hasRole(burnTracker.RECORDER_ROLE(), account);  // apps listados
burnTracker.hasRole(burnTracker.GOVERNANCE_ROLE(), account); // Timelock
```

### RewardDistributor

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

rd.previewClaim(user, round, projectId);    // cuanto recibiria el user
rd.previewEmission(round);                  // emision estimada
rd.getEmission(round);                      // emision (0 si no finalizado)
rd.getProjectEmission(round, projectId);    // share del proyecto
```

### FeeRouter

```solidity
feeRouter.defaultSplit();                   // struct Split
feeRouter.projectSplit(projectId);          // struct Split (legible siempre, incluso sin override)
feeRouter.hasProjectSplit(projectId);       // bool

feeRouter.appRecipient(projectId);          // direccion explicita o 0 (= lookup dinamico)
feeRouter.getEffectiveSplit(projectId);     // override o default
feeRouter.getEffectiveRecipient(projectId); // override o owner del Registry

feeRouter.quote(projectId, amount);         // (burned, toTreasury, toApp)
```

### CommunityGovernor

```solidity
governor.token();                           // GOV
governor.timelock();                        // CommunityTimelock
governor.votingDelay();                     // bloques
governor.votingPeriod();                    // bloques
governor.proposalThreshold();
governor.quorumNumerator();

governor.state(proposalId);                 // ProposalState enum
governor.proposalSnapshot(proposalId);
governor.proposalDeadline(proposalId);
governor.proposalProposer(proposalId);
governor.proposalNeedsQueuing(proposalId);
governor.proposalEta(proposalId);           // timestamp estimado para execucao

governor.hasVoted(proposalId, account);
governor.proposalVotes(proposalId);         // (againstVotes, forVotes, abstainVotes)
governor.quorum(timepoint);                 // minimo para quorum en este bloque
```

### CommunityTimelock

```solidity
timelock.getMinDelay();                     // 2 days en produccion

timelock.isOperation(id);
timelock.isOperationPending(id);
timelock.isOperationReady(id);              // alcanzo el delay
timelock.isOperationDone(id);
timelock.getTimestamp(id);                  // cuando se vuelve ready

timelock.hasRole(PROPOSER_ROLE, account);   // en produccion: Governor
timelock.hasRole(EXECUTOR_ROLE, account);   // en produccion: address(0) — todos ejecutan
timelock.hasRole(CANCELLER_ROLE, account);  // en produccion: Governor
```

## Eventos útiles para indexar

```
# GovernanceToken
event Minted(address indexed to, uint256 amount, string tag);
event Transfer(...);  # ERC-20 padrao
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

# FeeRouter
event Paid(uint256 indexed projectId, address indexed user, address indexed payer, uint256 amount, uint256 burned, uint256 toTreasury, uint256 toApp, address recipient);

# CommunityGovernor (inclui OZ padrao)
event ProposalCreated(...);
event VoteCast(...);
event ProposalExecuted(proposalId);
```

## Patrones de lectura

### Preview antes de tx

Todas las funciones mutating tienen un "preview" vía view:

- `FeeRouter.quote(projectId, amount)` — preview de split.
- `RewardDistributor.previewClaim(user, round, projectId)` — preview de reward.
- `RewardDistributor.previewEmission(round)` — preview de la emisión de una ronda.

Úsalo en la UI para mostrar valores antes de que el user firme.

### Batch reads

Multicall (o similar) es útil para leer estado agregado. Ejemplo — montar dashboard del usuario:

```
user.balanceOf(GOV)
user.delegates(GOV)
positions[user][projectId] para cada projectId stakado
staking.getWeight(user, projectId) para cada
rd.previewClaim(user, round, projectId) para cada (round, projectId) finalizado
```

## Snapshots históricos

Para peso de staking (`getWeightAt`, `getTotalWeightAt`, `getGlobalWeightAt`), **solo es confiable para `blockNumber < block.number`**. En el bloque corriente, el checkpoint puede todavía estar siendo escrito.

## Cuándo usar eventos vs views

- **Eventos** — flujo histórico, indexación, timelines, caches. Son inmutables y ordenados.
- **Views** — estado actual, derivaciones. Barato, pero solo da snapshot del "ahora".

Combina los dos: events para histórico, views para validación en tiempo real.

---

**Siguiente →** [Entorno local](05-local-dev.md)
