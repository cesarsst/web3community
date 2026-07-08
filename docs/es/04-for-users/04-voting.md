# Votar en propuestas

**Audiencia:** holder de GOV que quiere participar en las decisiones de la DAO.
**Requisitos previos:** [Tener GOV](02-holding-gov.md), [Governance (concepto)](../02-core-concepts/05-governance.md).

## Prerrequisito absoluto: delegar

Tener GOV **no** te da voting power automático. Tienes que delegar una vez:

```solidity
GovernanceToken.delegate(yourAddress)
```

Sin eso, `getVotes(you) == 0` y el Governor no contabiliza tus votos. Una vez delegado, queda siempre activo — las transferencias de GOV actualizan automáticamente.

Si quieres delegar a otro:

```solidity
GovernanceToken.delegate(delegate_address)
```

El cambio entra en vigor en el bloque siguiente. Las propuestas ya abiertas no se ven afectadas (usan snapshot anterior).

## Ciclo de una propuesta (visión del votante)

```
  +-------------+       +-------------+       +-------------+       +-------------+
  |   Pending   | ----> |   Active    | ----> | Succeeded   | ----> |  Queued     |
  | (votingDelay|       |(votingPeriod|       | ou Defeated |       | (timelock)  |
  |  ~1 dia)    |       | ~7 dias)    |       |             |       |             |
  +-------------+       +-------------+       +-------------+       +-------------+
                                                                           |
                                                                           | minDelay 2d
                                                                           v
                                                                    +-------------+
                                                                    |  Executed   |
                                                                    +-------------+

  Estados alternativos:
  - Canceled: el proposer desistio o la gobernanza cancelo
  - Expired: la propuesta no fue queued a tiempo
```

Durante el estado `Active` es cuando votas.

## Cómo votar

Función principal en el Governor:

```solidity
function castVote(uint256 proposalId, uint8 support) public returns (uint256);
```

Donde `support`:

- `0` — Against
- `1` — For
- `2` — Abstain

Variantes:

- `castVoteWithReason(proposalId, support, reason)` — anexa razón en string (indexada en evento).
- `castVoteBySig(proposalId, support, v, r, s)` — voto vía firma (EIP-712, permite gasless vía relayer).
- `castVoteWithReasonAndParamsBySig(...)` — versión con razón + params.

## Tu voting power

Cuando la propuesta abre, el Governor calcula un snapshot block. Tu peso de voto es:

```solidity
uint256 power = GovernanceToken.getPastVotes(you, snapshotBlock);
```

Es decir: **tu balance de GOV en el bloque del snapshot, vía tu delegación en el bloque del snapshot**. Si delegaste a ti mismo, es tu propio balance. Si delegaste a X, X tiene el poder; tú no votas con ese token.

Comprar o vender GOV **después** del snapshot no cambia el poder de esa propuesta.

## Cómo se decide la propuesta

Definido en `GovernorCountingSimple`:

**Para vencer**, la propuesta necesita:

1. Alcanzar **quorum** — `forVotes + abstainVotes >= quorum(snapshotBlock)`. En producción, quorum = 4% del supply en el snapshot.
2. Tener más `For` que `Against` — `forVotes > againstVotes`.

Si ambas condiciones son verdaderas cuando cierra la ventana → `Succeeded`. En caso contrario → `Defeated`.

### Excepción: supermayoría de 75% (`removePOL`)

Las propuestas que contengan **cualquier** call de `Treasury.removePOL` — o de gestión de roles (`grantRole`/`revokeRole`/`renounceRole`) con target en el Treasury o en el propio Timelock, que sería el vector de bypass — se marcan como `Supermajority` en el momento del `propose` (evento `ProposalTypeSet`). Para esas, la condición 2 cambia:

- `forVotes >= 3 × againstVotes` **y** `forVotes > 0` — es decir, For ≥ 75% de los votos decisivos (Abstain cuenta sólo para el quorum, queda fuera de la razón).

Un batch mixto (una call sensible en medio de varias inofensivas) contamina la propuesta entera: 75% para todo. El quorum de la condición 1 sigue siendo el mismo.

## Tras `Succeeded`

Cualquiera (no necesita ser el proposer) puede llamar:

```solidity
CommunityGovernor.queue(proposalId);       // ou
CommunityGovernor.queue(targets, values, calldatas, descriptionHash);
```

Eso encola la propuesta en el Timelock. Ahora el estado es `Queued`. El Timelock programa la ejecución para `now + minDelay` (2 días en producción).

Tras expirar el delay, cualquiera llama:

```solidity
CommunityGovernor.execute(proposalId);
```

Que ejecuta las llamadas efectivas (`targets[].call(calldatas[])`) vía Timelock.

## Cancelamiento

- El proposer puede cancelar **su propia** propuesta mientras está `Pending` (voting delay) o `Active` (period).
- La gobernanza puede cancelar vía propuesta contraria (meta-propuesta).
- Cancelaciones post-queue también invalidan la operación en el Timelock (`Timelock.cancel`).

El Timelock v1 **no** tiene guardian separado — no hay botón de pánico unilateral. Es intencional: ningún actor puede cancelar propuestas solo, porque eso sería vector de captura.

## Parámetros en producción

| Parámetro | Valor | Fuente |
|---|---|---|
| `votingDelay` | 7200 bloques (~1d) | `production.json` |
| `votingPeriod` | 50400 bloques (~7d) | `production.json` |
| `proposalThreshold` | 10.000 GOV | `production.json` |
| `quorumNumerator` | 4 (% del supply) | `production.json` |
| `timelockMinDelay` | 172800 seg (2d) | `production.json` |

Todos ajustables vía propuesta (onlyGovernance en los setters). Más en [Parámetros](../07-governance/03-parameters.md).

## Tutorial: votar paso a paso

1. **Primer uso:** `GovernanceToken.delegate(you)`. Pagas gas una vez.
2. **Encontrar propuesta:** vía hub o indexador (busca por evento `ProposalCreated` del Governor).
3. **Leer la propuesta** — la descripción y `(targets, calldatas)` te dirán exactamente qué hace on-chain.
4. **Votar** — `CommunityGovernor.castVote(proposalId, support)`. O con razón: `castVoteWithReason`.
5. **Esperar a que cierre.** Si vence, alguien llama a `queue` (tal vez tú).
6. **Tras el delay del Timelock** — alguien llama a `execute`.

## Qué revisar antes de votar For

- Quién propuso (¿tiene historial en la DAO? ¿es una entidad conocida?).
- Qué hace exactamente la propuesta — decodifica los `calldatas` contra los ABIs de los contratos.
- Si la propuesta altera parámetro: ¿está dentro de los bounds de los contratos? (ver [Parámetros](../07-governance/03-parameters.md)).
- Si la propuesta mueve fondos: ¿adónde? ¿cuánto? ¿por qué?
- ¿Cuál es la discusión off-chain (forum, Discord, etc.)?

## Votar vía UI

El hub frontend ofrece:

- Lista de propuestas abiertas.
- Decodificación legible de los `calldatas`.
- Botones para For / Against / Abstain.
- Feedback en tiempo real del progreso de votación + quorum.
- Botones para `queue` / `execute` cuando llega la hora.

Nada te impide llamar directo a los contratos vía tu wallet, pero la UI es el camino ergonómico.

---

**Siguiente →** [Reclamar rewards](05-claiming-rewards.md)
