# Ciclo de uma proposta

**Para quem é:** qualquer pessoa querendo entender os estados pelos quais uma proposta passa.
**Pré-requisitos:** [Governance (conceito)](../02-core-concepts/05-governance.md).

## Os 8 estados possíveis

`CommunityGovernor.state(proposalId)` retorna um dos valores da enum `ProposalState` (definida em `Governor` da OZ):

```
0  Pending       - criada, aguardando votingDelay
1  Active        - janela de votacao aberta
2  Canceled      - cancelada pelo proposer ou cancellation governance
3  Defeated      - votacao fechou sem atingir quorum ou com Against > For
4  Succeeded     - quorum + For > Against; pode ser queued
5  Queued        - enfileirada no Timelock; aguardando minDelay
6  Expired       - queued mas nao foi executada em tempo razoavel
7  Executed      - todas as chamadas foram executadas com sucesso
```

> **Nota — propostas `Supermajority` (75%).** No `propose`, o `CommunityGovernor` escaneia o batch: se qualquer call tem target no `Treasury` com selector de `removePOL` ou de gestão de roles (`grantRole`/`revokeRole`/`renounceRole`), ou target no Timelock com selector de gestão de roles, a proposta inteira é marcada `ProposalType.Supermajority` (evento `ProposalTypeSet`). Para essas, a transição a `Succeeded` exige `forVotes >= 3 × againstVotes` e `forVotes > 0` (For >= 75% dos votos decisivos; Abstain só conta para quorum) — não apenas `For > Against`.

## Transições

```
                     Alguem chama propose(...)
                                   |
                                   v
                           +---------------+
                           |    Pending    |   (votingDelay blocos)
                           +-------+-------+
                                   | apos votingDelay
                                   v
                           +---------------+
                           |    Active     |   (votingPeriod blocos)
                           +-------+-------+
                                   |
                               fim da votacao
                                   |
                +------------------+------------------+
                | For > Against E  |   For <= Against |
                | quorum atingido  |   OU sem quorum  |
                v                  v                  v
         +-------------+    +-------------+    +------------+
         |  Succeeded  |    |  Defeated   |    |  Canceled  |
         +------+------+    +-------------+    +------------+
                |                   (alguem cancelou antes
                | queue(...)         do periodo fechar)
                v
         +-------------+
         |   Queued    |  (timelockMinDelay segundos)
         +------+------+
                |
                | apos minDelay
                |  - se nao executada em timely window: Expired
                |  - se executada: Executed
                v
         +-------------+
         |  Executed   |
         +-------------+
```

## Tempo total típico em produção

Com os parâmetros de produção:

| Fase | Duração |
|---|---|
| Pending (`votingDelay`) | 7200 blocos (~1 dia) |
| Active (`votingPeriod`) | 50400 blocos (~7 dias) |
| Queued (`timelockMinDelay`) | 172800 segundos (2 dias) |
| **Total (felicidade)** | **~10 dias** |

Propor uma proposta hoje e vê-la executada demora pelo menos 10 dias. Este é o **preço intencional** da segurança.

## Como propor

```solidity
governor.propose(
    address[] memory targets,       // contratos alvo
    uint256[] memory values,         // ETH a enviar em cada chamada (tipicamente zero)
    bytes[] memory calldatas,        // calldatas das chamadas
    string memory description        // texto em markdown
);
```

Retorna `proposalId` (hash dos 4 parâmetros).

**Pré-requisitos**:

- `msg.sender` tem voting power >= `proposalThreshold` (10.000 GOV em produção, via `getVotes(msg.sender)`).
- Arrays têm mesmo tamanho.
- Descrição não vazia.

**Erros comuns**:

- `GovernorInsufficientProposerVotes` — voting power insuficiente.
- `GovernorInvalidProposalLength` — arrays com tamanhos diferentes.

## Votar

Durante `Active`:

```solidity
governor.castVote(proposalId, support);
// support: 0 = Against, 1 = For, 2 = Abstain
```

Variantes (com razão, com assinatura off-chain para gasless):

- `castVoteWithReason(proposalId, support, reason)`
- `castVoteBySig(proposalId, support, v, r, s)`
- `castVoteWithReasonAndParamsBySig(...)`

Seu voting power é `gov.getPastVotes(you, proposalSnapshot)`. Se zero no snapshot, você não vota efetivamente (emite evento mas não conta).

## Queue

Após `Succeeded`:

```solidity
governor.queue(proposalId);
```

Qualquer um pode chamar. Agenda a execução no Timelock.

## Execute

Após `Queued` e passado `timelockMinDelay`:

```solidity
governor.execute(proposalId);
// ou variante com targets/values/calldatas/descriptionHash
```

Qualquer um pode chamar. Executa as chamadas contra os targets via Timelock.

No `CommunityTimelock`, `EXECUTOR_ROLE` é `address(0)` — qualquer address pode executar, porque o delay já foi o gate real.

## Cancelar

### Pelo proposer (sua própria)

```solidity
governor.cancel(targets, values, calldatas, descriptionHash);
```

Funciona durante `Pending` ou `Active`. Após `Succeeded`, o proposer **não** pode cancelar diretamente — precisaria proposta contrária.

### Pela governança

Um cancel via proposta pode ser submetido. Executa via Timelock chamando `_cancel` no Governor / `cancel` no Timelock.

## Propostas batch

Uma única proposta pode incluir **N chamadas**. Útil quando ações são relacionadas e devem ser atômicas. Exemplo:

```
targets   = [registry, registry, burnTracker]
calldatas = [
    registry.registerProject.encode(ownerAddr, "ipfs://...", 10_000e18),
    registry.activateProject.encode(nextId),
    burnTracker.grantRole.encode(RECORDER_ROLE, appContract)
]
```

As 3 chamadas ou são todas executadas ou nenhuma (se qualquer uma reverter, a tx inteira reverte).

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

Para UI/indexer, todos esses eventos têm `proposalId` como campo chave.

## Fluxo completo de exemplo

```
1. Alice (com >= 10k GOV delegados) chama governor.propose(...)
   -> evento ProposalCreated
   -> state = Pending

2. Apos 7200 blocos (~1 dia):
   -> state = Active

3. Holders votam durante 50400 blocos (~7 dias):
   governor.castVote(id, 1)  // For
   governor.castVote(id, 0)  // Against
   ...
   -> eventos VoteCast

4. Apos 50400 blocos:
   Se For > Against && quorum atingido:
     -> state = Succeeded
   Senao:
     -> state = Defeated (terminal)

5. Qualquer um chama governor.queue(id)
   -> Timelock.schedule(...)
   -> evento ProposalQueued com etaSeconds
   -> state = Queued

6. Apos 172800 segundos (2 dias):
   Qualquer um chama governor.execute(id)
   -> Timelock.executeBatch(...)
   -> chamadas alvo sao executadas
   -> evento ProposalExecuted
   -> state = Executed (terminal)
```

## Edge cases

### `Succeeded` mas sem alguém para chamar `queue`

A proposta **não vira** `Expired` automaticamente no estado `Succeeded` — expira só depois de `Queued`. Permanece `Succeeded` esperando queue. Qualquer holder pode chamar.

### Operação pendente no Timelock expira

Se alguém chama `queue` mas ninguém chama `execute` dentro de `GRACE_PERIOD` (default do TimelockController OZ), a operação fica expirada. O Governor reflete com `state = Expired`.

### `queue` chamado duas vezes

A segunda chamada reverte — a operação já está no Timelock.

### Proposta com `targets = []`

Reverte com `GovernorInvalidProposalLength`. Propostas sem chamadas não fazem sentido.

## Como fiscalizar uma proposta antes de votar

1. Leia o `description` (texto humano).
2. Decodifique cada `calldatas[i]` contra a ABI do `targets[i]`. Confirme que os parâmetros são o que a descrição diz.
3. Confirme que `values[i] == 0` (quase sempre; se não for, descubra por que gastar ETH).
4. Se altera parâmetro: está dentro dos bounds? Ver [Parâmetros](03-parameters.md).
5. Se move fundos: quanto? para onde? há justificativa?

---

**Próximo →** [Voting power](02-voting-power.md)
