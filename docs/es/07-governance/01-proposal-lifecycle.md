# Ciclo de una propuesta

**Audiencia:** cualquier persona que quiera entender los estados por los que pasa una propuesta.
**Requisitos previos:** [Governance (concepto)](../02-core-concepts/05-governance.md).

## Los 8 estados posibles

`CommunityGovernor.state(proposalId)` retorna uno de los valores del enum `ProposalState` (definido en `Governor` de OZ):

```
0  Pending       - creada, esperando votingDelay
1  Active        - ventana de votacion abierta
2  Canceled      - cancelada por el proposer o por cancelacion de gobernanza
3  Defeated      - la votacion cerro sin alcanzar quorum o con Against > For
4  Succeeded     - quorum + For > Against; puede ser queued
5  Queued        - encolada en el Timelock; esperando minDelay
6  Expired       - queued pero no ejecutada en tiempo razonable
7  Executed      - todas las llamadas se ejecutaron con exito
```

## Transiciones

```
                     Alguien llama propose(...)
                                   |
                                   v
                           +---------------+
                           |    Pending    |   (votingDelay bloques)
                           +-------+-------+
                                   | tras votingDelay
                                   v
                           +---------------+
                           |    Active     |   (votingPeriod bloques)
                           +-------+-------+
                                   |
                               fin de la votacion
                                   |
                +------------------+------------------+
                | For > Against Y  |   For <= Against |
                | quorum alcanzado |   O sin quorum   |
                v                  v                  v
         +-------------+    +-------------+    +------------+
         |  Succeeded  |    |  Defeated   |    |  Canceled  |
         +------+------+    +-------------+    +------------+
                |                   (alguien cancelo antes
                | queue(...)         de que cerrara el period)
                v
         +-------------+
         |   Queued    |  (timelockMinDelay segundos)
         +------+------+
                |
                | tras minDelay
                |  - si no se ejecuta en ventana timely: Expired
                |  - si se ejecuta: Executed
                v
         +-------------+
         |  Executed   |
         +-------------+
```

## Tiempo total típico en producción

Con los parámetros de producción:

| Fase | Duración |
|---|---|
| Pending (`votingDelay`) | 7200 bloques (~1 día) |
| Active (`votingPeriod`) | 50400 bloques (~7 días) |
| Queued (`timelockMinDelay`) | 172800 segundos (2 días) |
| **Total (happy path)** | **~10 días** |

Proponer una propuesta hoy y verla ejecutada tarda al menos 10 días. Ese es el **precio intencional** de la seguridad.

## Cómo proponer

```solidity
governor.propose(
    address[] memory targets,       // contratos objetivo
    uint256[] memory values,         // ETH a enviar en cada llamada (típicamente cero)
    bytes[] memory calldatas,        // calldatas de las llamadas
    string memory description        // texto en markdown
);
```

Retorna `proposalId` (hash de los 4 parámetros).

**Prerrequisitos**:

- `msg.sender` tiene voting power >= `proposalThreshold` (10.000 GOV en producción, vía `getVotes(msg.sender)`).
- Los arrays tienen el mismo tamaño.
- Descripción no vacía.

**Errores comunes**:

- `GovernorInsufficientProposerVotes` — voting power insuficiente.
- `GovernorInvalidProposalLength` — arrays con tamaños diferentes.

## Votar

Durante `Active`:

```solidity
governor.castVote(proposalId, support);
// support: 0 = Against, 1 = For, 2 = Abstain
```

Variantes (con razón, con firma off-chain para gasless):

- `castVoteWithReason(proposalId, support, reason)`
- `castVoteBySig(proposalId, support, v, r, s)`
- `castVoteWithReasonAndParamsBySig(...)`

Tu voting power es `gov.getPastVotes(you, proposalSnapshot)`. Si es cero en el snapshot, no votas efectivamente (se emite evento pero no cuenta).

## Queue

Tras `Succeeded`:

```solidity
governor.queue(proposalId);
```

Cualquiera puede llamar. Programa la ejecución en el Timelock.

## Execute

Tras `Queued` y pasado `timelockMinDelay`:

```solidity
governor.execute(proposalId);
// o variante con targets/values/calldatas/descriptionHash
```

Cualquiera puede llamar. Ejecuta las llamadas contra los targets vía Timelock.

En el `CommunityTimelock`, `EXECUTOR_ROLE` es `address(0)` — cualquier address puede ejecutar, porque el delay ya fue el gate real.

## Cancelar

### Por el proposer (su propia)

```solidity
governor.cancel(targets, values, calldatas, descriptionHash);
```

Funciona durante `Pending` o `Active`. Tras `Succeeded`, el proposer **no** puede cancelar directamente — necesitaría propuesta contraria.

### Por la gobernanza

Un cancel vía propuesta puede someterse. Se ejecuta vía Timelock llamando a `_cancel` en el Governor / `cancel` en el Timelock.

## Propuestas batch

Una única propuesta puede incluir **N llamadas**. Útil cuando las acciones están relacionadas y deben ser atómicas. Ejemplo:

```
targets   = [registry, registry, burnTracker]
calldatas = [
    registry.registerProject.encode(ownerAddr, "ipfs://...", 10_000e18),
    registry.activateProject.encode(nextId),
    burnTracker.grantRole.encode(RECORDER_ROLE, appContract)
]
```

Las 3 llamadas o son todas ejecutadas o ninguna (si cualquiera revierte, la tx entera revierte).

## Eventos

```
event ProposalCreated(
    uint256 proposalId,
    address proposer,
    address[] targets,
    uint256[] values,
    string[] signatures,
    bytes[] calldatas,
    uint256 voteStart,
    uint256 voteEnd,
    string description
);

event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason);
event ProposalQueued(uint256 proposalId, uint256 etaSeconds);
event ProposalExecuted(uint256 proposalId);
event ProposalCanceled(uint256 proposalId);
```

Para UI/indexer, todos esos eventos tienen `proposalId` como campo clave.

## Flujo completo de ejemplo

```
1. Alice (con >= 10k GOV delegados) llama governor.propose(...)
   -> evento ProposalCreated
   -> state = Pending

2. Tras 7200 bloques (~1 dia):
   -> state = Active

3. Holders votan durante 50400 bloques (~7 dias):
   governor.castVote(id, 1)  // For
   governor.castVote(id, 0)  // Against
   ...
   -> eventos VoteCast

4. Tras 50400 bloques:
   Si For > Against && quorum alcanzado:
     -> state = Succeeded
   Sino:
     -> state = Defeated (terminal)

5. Cualquiera llama governor.queue(id)
   -> Timelock.schedule(...)
   -> evento ProposalQueued con etaSeconds
   -> state = Queued

6. Tras 172800 segundos (2 dias):
   Cualquiera llama governor.execute(id)
   -> Timelock.executeBatch(...)
   -> se ejecutan las llamadas objetivo
   -> evento ProposalExecuted
   -> state = Executed (terminal)
```

## Edge cases

### `Succeeded` pero sin alguien que llame a `queue`

La propuesta **no pasa** a `Expired` automáticamente en el estado `Succeeded` — expira solo después de `Queued`. Permanece `Succeeded` esperando queue. Cualquier holder puede llamar.

### Operación pendiente en el Timelock expira

Si alguien llama a `queue` pero nadie llama a `execute` dentro de `GRACE_PERIOD` (default del TimelockController OZ), la operación queda expirada. El Governor lo refleja con `state = Expired`.

### `queue` llamado dos veces

La segunda llamada revierte — la operación ya está en el Timelock.

### Propuesta con `targets = []`

Revierte con `GovernorInvalidProposalLength`. Propuestas sin llamadas no tienen sentido.

## Cómo fiscalizar una propuesta antes de votar

1. Lee el `description` (texto humano).
2. Decodifica cada `calldatas[i]` contra la ABI del `targets[i]`. Confirma que los parámetros son lo que dice la descripción.
3. Confirma que `values[i] == 0` (casi siempre; si no, descubre por qué gastar ETH).
4. Si altera parámetro: ¿está dentro de los bounds? Ver [Parámetros](03-parameters.md).
5. Si mueve fondos: ¿cuánto? ¿adónde? ¿hay justificación?

---

**Siguiente →** [Voting power](02-voting-power.md)
