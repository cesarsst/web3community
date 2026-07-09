# Voting power

**Para quem é:** quem quer saber exatamente como o poder de voto é calculado e por que ele é imune a manipulação.
**Pré-requisitos:** [Ciclo de uma proposta](01-proposal-lifecycle.md).

Voting power vem **exclusivamente do GOV**, e só conta se você **delegar**. O CREDIT não vota (ver [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)). Esta página explica o mecanismo `ERC20Votes` e por que ele fecha o vetor de flash loan.

## GOV é ERC20Votes

O [`GovernanceToken`](../08-contracts-reference/01-GovernanceToken.md) é um ERC-20 com a extensão `ERC20Votes` (ERC-5805) da OpenZeppelin. Isso significa que o token mantém, além do saldo, um **histórico de voting units por bloco** (checkpoints). O Governor lê esse histórico, nunca o saldo atual.

Características:

- Supply cap **imutável de 100M** (`CAP_SUPPLY`), enforced em `_update`. Não há inflação de GOV.
- Voting units são movidas em todo transfer/mint/burn via o hook `_update` → `ERC20Votes._update`.
- Clock em **número de blocos** (o token não sobrescreve `clock()`, então o Governor opera em blocos — toda a aritmética de delay/period é em blocos).

## Delegação: sem ela, você não vota

Ter GOV **não** dá voting power automaticamente. O `ERC20Votes` só contabiliza poder de voto para endereços que foram **delegados**. Você precisa chamar `delegate`:

```ts
// delegar a si mesmo (auto-delegação) — o caso mais comum
await gov.delegate(minhaCarteira)

// ou delegar a outro endereço, que passa a votar com o seu peso
await gov.delegate(representante)
```

Consequência prática: **GOV parado numa carteira que nunca delegou tem 0 de voting power.** Se você quer participar da governança (ou que suas moedas contem para quorum), delegue — inclusive a si mesmo.

> Delegar **não** transfere os tokens nem os trava. Você continua dono do GOV; só o direito de voto vai para o delegado. É reversível a qualquer momento com outra chamada `delegate`.

## Snapshot: por que flash loans não funcionam

O Governor calcula o poder de voto de cada conta com `getPastVotes(account, proposalSnapshot)` — o voting power **no bloco de abertura da votação**, não no momento do voto.

```
propose ──▶ votingDelay ──▶ [bloco de snapshot] ──▶ votação abre
                                     ↑
                    getPastVotes lê o poder AQUI
```

Isso torna a votação **imune a flash loans** (invariante I5): tomar emprestado um monte de GOV, votar e devolver no mesmo bloco não funciona, porque o snapshot é de um bloco **anterior** ao voto. O poder de voto foi congelado antes de o atacante sequer poder agir.

O mesmo vale para o quorum: `quorum(timepoint)` usa `getPastTotalSupply` — o supply no snapshot, não o atual. Isso evita ataques que diluam o supply após a proposta para atingir quorum artificialmente.

## Threshold de proposta

Para **criar** uma proposta, o proposer precisa ter delegado a si ao menos o `proposalThreshold` — produção: **10.000 GOV** (0,01% do cap de 100M). É baixo o suficiente para não calcificar a governança (não exige uma baleia para propor), mas > 0 para bloquear spam de propostas de contas sem skin in the game.

## Resumo

| Pergunta | Resposta |
|---|---|
| O que dá voto? | GOV, via `ERC20Votes` |
| Preciso delegar? | Sim — sem `delegate`, seu poder é 0 |
| CREDIT vota? | Não |
| Qual bloco conta? | O snapshot (abertura da votação), via `getPastVotes` |
| Flash loan funciona? | Não — snapshot é de bloco anterior ao voto |
| Quanto para propor? | `proposalThreshold` (10.000 GOV em produção) |

---

**Próximo →** [Parâmetros](03-parameters.md)
