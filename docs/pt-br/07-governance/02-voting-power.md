# Voting power

**Para quem é:** holder de GOV e qualquer pessoa querendo entender como voting power é calculado.
**Pré-requisitos:** [Governance (conceito)](../02-core-concepts/05-governance.md).

## Voting power ≠ balance

Um erro comum: assumir que `balanceOf(you)` é seu voting power. Não é.

Em ERC20Votes, você precisa **delegar** para ativar voting power. Sem delegação, seu voting power é **zero**, mesmo tendo GOV.

```solidity
// Seu balance atual
uint256 bal = gov.balanceOf(you);          // pode ser 10.000 GOV

// Seu voting power atual (livro de contagem)
uint256 vp = gov.getVotes(you);             // pode ser 0 se voce nao delegou
```

## Delegação

Duas formas:

### Self-delegation (você vota seu próprio GOV)

```solidity
gov.delegate(you);
```

Após isso, `getVotes(you) == balanceOf(you)`.

### Delegação a terceiro

```solidity
gov.delegate(trustedDelegate);
```

Após isso, `getVotes(trustedDelegate) += balanceOf(you)` e seu voting power é zero (você cedeu).

Sem custo (só gas). Pode mudar a qualquer momento.

## Como `getVotes` reage a transferências

O valor de `getVotes(delegate)` é atualizado automaticamente quando:

- Você recebe GOV: `getVotes(yourDelegate) += amount`.
- Você envia GOV: `getVotes(yourDelegate) -= amount`.
- Você muda delegação: `getVotes(oldDelegate) -= yourBalance`, `getVotes(newDelegate) += yourBalance`.

Implementado em `ERC20Votes._update` da OpenZeppelin.

## Snapshot histórico

O que importa para votar não é `getVotes` atual — é `getPastVotes` no snapshot da proposta.

```solidity
uint256 snapshotBlock = governor.proposalSnapshot(proposalId);
uint256 vpNoSnapshot  = gov.getPastVotes(you, snapshotBlock);
```

Essa é a função que o Governor chama quando você vota. Imune a flash-loan — o snapshot é um bloco no passado.

## DelegateBySig (off-chain signature)

Você pode delegar via assinatura EIP-712 sem pagar gas — alguém relaya a tx:

```solidity
gov.delegateBySig(delegatee, nonce, expiry, v, r, s);
```

Útil para UX que quer "ativar voto com uma assinatura" sem on-chain interaction direta do usuário.

## Mudar de delegação

```solidity
gov.delegate(newDelegatee);
```

Entra em vigor no bloco seguinte. Propostas que já tinham snapshot **antes** do bloco da mudança usam a delegação antiga (que era vigente no snapshot).

## Voting power total

Para saber o voting power total do sistema em um bloco:

```solidity
uint256 total = gov.getPastTotalSupply(blockNumber);
```

Usado pelo `quorum(timepoint)` do Governor para calcular quorum mínimo.

## Quem ignora a delegação?

**Ninguém** no caminho on-chain. Se você não delegou, seu GOV literalmente não vota — nem para você, nem para ninguém.

## Por que delegação é obrigatória

ERC20Votes impõe delegação para preservar a invariante de que **a soma de `getVotes(all delegates)` seja igual ao `totalSupply`** pelo menos no ponto de vista contábil. Sem delegação explícita, o voting power "fica no limbo" — e o `getVotes` do holder é 0 por design.

Isso evita o padrão de "vote stealing" de implementações antigas e força a decisão consciente de "sou eu que voto ou delego?".

## Propagação de balance

Se você tem 10k GOV e delegou a si:

```
você.balance  = 10.000
você.delegates = você
você.getVotes  = 10.000
```

Você recebe 5k a mais de GOV:

```
você.balance  = 15.000
você.delegates = você (não mudou)
você.getVotes  = 15.000 (atualizado automaticamente)
```

Você manda 3k para Bob (que delegou a Charlie):

```
você.balance   = 12.000
você.getVotes  = 12.000
Bob.balance    = 3.000
Bob.getVotes   = 0 (Bob nao tem delegacao)
Charlie.getVotes += 3.000 (delegatee de Bob)
```

Note que se Bob não delegou antes, seu GOV ainda vota ninguém. Bob precisa chamar `gov.delegate(...)` para ativar.

## Proposta em um snapshot específico

Quando `governor.propose(...)` é chamado no bloco `X`:

- `proposalSnapshot(id) = X + votingDelay`.
- O snapshot fica exatamente `votingDelay` blocos à frente do bloco da proposta.

Portanto, se você quer garantir que seu voto conte:

- **Faça delegação antes** do bloco do snapshot.
- Se seu delegação mudou no bloco do snapshot, não é claro qual prevalece — na dúvida, mude 1 bloco antes.

## Agregar delegações de muitos holders

Padrão comum em DAOs: formar "delegation pools" onde um delegate atua por muitos holders. Em web3community não há ferramentas on-chain específicas para isso no v1 — cada delegação é 1-para-1 via `delegate(target)`. Pools podem ser construídos off-chain ou por contratos do ecossistema, mas o v1 não oferece.

## Edge case: delegação para endereço morto

```solidity
gov.delegate(address(0));
```

Funciona. Remove sua delegação — seu voting power vira zero (ninguém recebe). Pode ser útil se você quer "parar de votar" sem transferir GOV.

## Histórico de eventos

Eventos úteis para indexação:

```
event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);
```

Primeiro é emitido quando você muda delegação. Segundo é emitido cada vez que um delegate tem `getVotes` alterado (por mudança sua ou de qualquer outra pessoa que delega a ele).

---

**Próximo →** [Parâmetros](03-parameters.md)
