# Voting power

**Audiencia:** holder de GOV y cualquier persona que quiera entender cómo se calcula el voting power.
**Requisitos previos:** [Governance (concepto)](../02-core-concepts/05-governance.md).

## Voting power ≠ balance

Un error común: asumir que `balanceOf(you)` es tu voting power. No lo es.

En ERC20Votes, necesitas **delegar** para activar voting power. Sin delegación, tu voting power es **cero**, incluso teniendo GOV.

```solidity
// Tu balance actual
uint256 bal = gov.balanceOf(you);          // podria ser 10.000 GOV

// Tu voting power actual (libro de conteo)
uint256 vp = gov.getVotes(you);             // podria ser 0 si no delegaste
```

## Delegación

Dos formas:

### Self-delegation (votas tu propio GOV)

```solidity
gov.delegate(you);
```

Tras esto, `getVotes(you) == balanceOf(you)`.

### Delegación a tercero

```solidity
gov.delegate(trustedDelegate);
```

Tras esto, `getVotes(trustedDelegate) += balanceOf(you)` y tu voting power es cero (lo cediste).

Sin costo (solo gas). Puede cambiar en cualquier momento.

## Cómo reacciona `getVotes` a transferencias

El valor de `getVotes(delegate)` se actualiza automáticamente cuando:

- Recibes GOV: `getVotes(yourDelegate) += amount`.
- Envías GOV: `getVotes(yourDelegate) -= amount`.
- Cambias delegación: `getVotes(oldDelegate) -= yourBalance`, `getVotes(newDelegate) += yourBalance`.

Implementado en `ERC20Votes._update` de OpenZeppelin.

## Snapshot histórico

Lo que importa para votar no es `getVotes` actual — es `getPastVotes` en el snapshot de la propuesta.

```solidity
uint256 snapshotBlock = governor.proposalSnapshot(proposalId);
uint256 vpNoSnapshot  = gov.getPastVotes(you, snapshotBlock);
```

Esa es la función que el Governor llama cuando votas. Inmune a flash-loan — el snapshot es un bloque en el pasado.

## DelegateBySig (off-chain signature)

Puedes delegar vía firma EIP-712 sin pagar gas — alguien releva la tx:

```solidity
gov.delegateBySig(delegatee, nonce, expiry, v, r, s);
```

Útil para UX que quiere "activar voto con una firma" sin interacción on-chain directa del usuario.

## Cambiar de delegación

```solidity
gov.delegate(newDelegatee);
```

Entra en vigor en el bloque siguiente. Propuestas que ya tenían snapshot **antes** del bloque del cambio usan la delegación antigua (que era vigente en el snapshot).

## Voting power total

Para saber el voting power total del sistema en un bloque:

```solidity
uint256 total = gov.getPastTotalSupply(blockNumber);
```

Usado por el `quorum(timepoint)` del Governor para calcular quorum mínimo.

## ¿Quién ignora la delegación?

**Nadie** en el camino on-chain. Si no delegaste, tu GOV literalmente no vota — ni para ti, ni para nadie.

## Por qué la delegación es obligatoria

ERC20Votes impone delegación para preservar la invariante de que **la suma de `getVotes(all delegates)` sea igual al `totalSupply`** al menos desde el punto de vista contable. Sin delegación explícita, el voting power "queda en el limbo" — y el `getVotes` del holder es 0 por diseño.

Eso evita el patrón de "vote stealing" de implementaciones antiguas y fuerza la decisión consciente de "¿soy yo quien vota o delego?".

## Propagación de balance

Si tienes 10k GOV y delegaste a ti mismo:

```
tu.balance   = 10.000
tu.delegates = tu
tu.getVotes  = 10.000
```

Recibes 5k más de GOV:

```
tu.balance   = 15.000
tu.delegates = tu (no cambio)
tu.getVotes  = 15.000 (actualizado automaticamente)
```

Mandas 3k a Bob (que delegó a Charlie):

```
tu.balance    = 12.000
tu.getVotes   = 12.000
Bob.balance   = 3.000
Bob.getVotes  = 0 (Bob no tiene delegacion)
Charlie.getVotes += 3.000 (delegatee de Bob)
```

Nota que si Bob no delegó antes, su GOV aún no vota para nadie. Bob necesita llamar a `gov.delegate(...)` para activar.

## Propuesta en un snapshot específico

Cuando `governor.propose(...)` se llama en el bloque `X`:

- `proposalSnapshot(id) = X + votingDelay`.
- El snapshot queda exactamente `votingDelay` bloques por delante del bloque de la propuesta.

Por lo tanto, si quieres garantizar que tu voto cuente:

- **Haz la delegación antes** del bloque del snapshot.
- Si tu delegación cambió en el bloque del snapshot, no está claro cuál prevalece — en la duda, cambia 1 bloque antes.

## Agregar delegaciones de muchos holders

Patrón común en DAOs: formar "delegation pools" donde un delegate actúa por muchos holders. En web3community no hay herramientas on-chain específicas para eso en v1 — cada delegación es 1-a-1 vía `delegate(target)`. Pools pueden construirse off-chain o por contratos del ecosistema, pero v1 no ofrece.

## Edge case: delegación a dirección muerta

```solidity
gov.delegate(address(0));
```

Funciona. Remueve tu delegación — tu voting power se vuelve cero (nadie recibe). Puede ser útil si quieres "dejar de votar" sin transferir GOV.

## Histórico de eventos

Eventos útiles para indexación:

```
event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);
```

El primero se emite cuando cambias delegación. El segundo se emite cada vez que un delegate tiene `getVotes` alterado (por cambio tuyo o de cualquier otra persona que delegue a él).

---

**Siguiente →** [Parámetros](03-parameters.md)
