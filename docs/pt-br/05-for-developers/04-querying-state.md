# Consultar estado on-chain

**Para quem é:** dev construindo UI, indexer ou contrato que lê estado da web3community.
**Pré-requisitos:** [Endereços dos contratos](02-contract-addresses.md).

## Estado útil por contrato

### GovernanceToken

```solidity
gov.totalSupply();              // supply atual, max 100M * 1e18
gov.cap();                      // 100M * 1e18 (imutavel)
gov.balanceOf(account);
gov.allowance(owner, spender);

gov.getVotes(account);                      // voting power atual do delegate
gov.getPastVotes(account, blockNumber);     // historico — usado pelo Governor
gov.getPastTotalSupply(blockNumber);        // usado pelo quorum

gov.delegates(account);                     // para quem voce delegou
gov.nonces(account);                        // para permit / delegateBySig

gov.owner();                                // em producao: address do Timelock
gov.pendingOwner();                         // se Ownable2Step transferencia em andamento
```

### CreditToken

```solidity
credit.totalSupply();
credit.balanceOf(account);
credit.allowance(owner, spender);

credit.genesisMinted();                     // true apos mintGenesis
credit.hasRole(credit.MINTER_ROLE(), account);  // em producao: RewardDistributor
credit.hasRole(credit.BURNER_ROLE(), account);  // em producao: BurnTracker
credit.hasRole(credit.DEFAULT_ADMIN_ROLE(), account);  // em producao: Timelock
```

### ProjectRegistry

```solidity
registry.totalProjects();                   // quantos projetos ja foram criados
registry.govToken();                        // endereco do GOV
registry.minCollateral();                   // colateral minimo atual
registry.probationDuration();               // duracao da probation inicial

registry.getProject(projectId);             // struct { owner, collateral, status, activatedAt, probationEndsAt, metadataURI }
registry.isActive(projectId);               // bool — false para qualquer status != Active
registry.isInProbation(projectId);          // bool — apenas probation INICIAL por tempo
registry.pendingOwner(projectId);           // endereco pendente em transferencia 2-step

registry.hasRole(registry.GOVERNANCE_ROLE(), account);  // em producao: Timelock
```

Status enum: `0=Pending`, `1=Active`, `2=Probation`, `3=Removed`.

### Treasury

```solidity
treasury.balanceOf(IERC20 token);          // saldo do token no treasury
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
staking.getWeight(user, projectId);         // peso atual
staking.getWeightAt(user, projectId, block); // snapshot historico

staking.totalStakedByProject(projectId);    // amount agregado
staking.totalStaked();                      // global
staking.getTotalWeight(projectId);          // peso agregado do projeto
staking.getTotalWeightAt(projectId, block);
staking.getGlobalWeight();
staking.getGlobalWeightAt(block);

staking.getLockEnd(user, projectId);        // timestamp de expiracao
staking.isUnlocked(user, projectId);        // bool

staking.multiplier(lockDuration);           // pure — calcular multiplier para lock X
```

### BurnTracker

```solidity
burnTracker.currentRound();                 // round em curso
burnTracker.roundStartedAt();               // timestamp do start
burnTracker.roundDuration();                // duracao alvo

burnTracker.MIN_ROUND_DURATION();           // 1 day
burnTracker.MAX_ROUND_DURATION();           // 30 days

burnTracker.maxBurnPerRoundPerProject();    // sanity cap

burnTracker.totalBurnByRound(round);
burnTracker.burnByRoundProject(round, projectId);
burnTracker.projectsWithBurnCount(round);

burnTracker.getBurnForProjectInRound(round, projectId);  // view nomeado
burnTracker.getTotalBurnForRound(round);                 // view nomeado
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

rd.previewClaim(user, round, projectId);    // quanto o user receberia
rd.previewEmission(round);                  // emissao estimada
rd.getEmission(round);                      // emissao (0 se nao finalizado)
rd.getProjectEmission(round, projectId);    // share do projeto
```

### FeeRouter

```solidity
feeRouter.defaultSplit();                   // struct Split
feeRouter.projectSplit(projectId);          // struct Split (lido sempre, mesmo se sem override)
feeRouter.hasProjectSplit(projectId);       // bool

feeRouter.appRecipient(projectId);          // endereco explicito ou 0 (= lookup dinamico)
feeRouter.getEffectiveSplit(projectId);     // override ou default
feeRouter.getEffectiveRecipient(projectId); // override ou owner do Registry

feeRouter.quote(projectId, amount);         // (burned, toTreasury, toApp)
```

### CommunityGovernor

```solidity
governor.token();                           // GOV
governor.timelock();                        // CommunityTimelock
governor.votingDelay();                     // blocos
governor.votingPeriod();                    // blocos
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
governor.quorum(timepoint);                 // minimo para quorum neste bloco
```

### CommunityTimelock

```solidity
timelock.getMinDelay();                     // 2 days em producao

timelock.isOperation(id);
timelock.isOperationPending(id);
timelock.isOperationReady(id);              // atingiu delay
timelock.isOperationDone(id);
timelock.getTimestamp(id);                  // quando vira ready

timelock.hasRole(PROPOSER_ROLE, account);   // em producao: Governor
timelock.hasRole(EXECUTOR_ROLE, account);   // em producao: address(0) — todos executam
timelock.hasRole(CANCELLER_ROLE, account);  // em producao: Governor
```

## Eventos úteis para indexar

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

## Padrões de leitura

### Preview antes de tx

Todas as funções mutating têm um "preview" via view:

- `FeeRouter.quote(projectId, amount)` — preview de split.
- `RewardDistributor.previewClaim(user, round, projectId)` — preview de reward.
- `RewardDistributor.previewEmission(round)` — preview da emissão de uma rodada.

Use em UI para mostrar valores antes do user assinar.

### Batch reads

Multicall (ou similar) é útil para ler estado agregado. Exemplo — montar dashboard do usuário:

```
user.balanceOf(GOV)
user.delegates(GOV)
positions[user][projectId] para cada projectId stakado
staking.getWeight(user, projectId) para cada
rd.previewClaim(user, round, projectId) para cada (round, projectId) finalizado
```

## Snapshots históricos

Para peso de staking (`getWeightAt`, `getTotalWeightAt`, `getGlobalWeightAt`), **só é confiável para `blockNumber < block.number`**. No bloco corrente, o checkpoint pode ainda estar sendo escrito.

## Quando usar eventos vs views

- **Eventos** — fluxo histórico, indexação, timelines, caches. São imutáveis e ordenados.
- **Views** — estado atual, derivações. Barato, mas só dá snapshot do "agora".

Combine os dois: events para histórico, views para validação em tempo real.

---

**Próximo →** [Ambiente local](05-local-dev.md)
