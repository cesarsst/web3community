# Reclamar rewards

> ⚠️ **LEGADO — sustituido por el remodel 2026-07-08.** Esta página aplica **solo a rewards de rondas pre-remodel** (RewardDistributor V1/V2), que siguen retirables sin plazo. En el modelo vigente no hay emisión de rewards: el retorno del inversor es el rev-share de [`ProjectFunding.claim`](../08-contracts-reference/16-ProjectFunding.md) — ver [Flujos de usuario](../03-protocol-overview/02-user-flows.md), Flujo 5.

**Audiencia:** staker esperando retirar el CREDIT que generó en rondas pre-remodel.
**Requisitos previos:** [Staking en proyectos](03-staking-in-projects.md), [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Lo que tiene que haber pasado antes

Precondiciones para que puedas claim de la ronda R-1:

1. Tenías posición stakeada en `(user, projectId)` en el bloque del snapshot (seteado en `finalizeRound(R-1)`).
2. La gobernanza llamó a `BurnTracker.closeRound()` cerrando la ronda R-1 (currentRound se volvió R).
3. Alguien — puedes ser tú — llamó a `RewardDistributor.finalizeRound(R-1)`.
4. Aún **no** reclamaste esa combinación `(R-1, projectId)`.

## Descubriendo qué puedes claim

### Preview

```solidity
uint256 amount = rewardDistributor.previewClaim(you, round, projectId);
```

Retorna el valor que sería acuñado **si llamaras `claim` ahora**. Cero si:

- Round no finalizado.
- Ya reclamado.
- Tu peso era cero en el snapshot.
- El proyecto no generó burn y el peso global es cero (bootstrap edge case).

Sin side effects — úsalo libremente en la UI.

### Ver status de reclamación

```solidity
bool alreadyClaimed = rewardDistributor.claimed(round, projectId, you);
```

## Reclamando una ronda

```solidity
uint256 amount = rewardDistributor.claim(round, projectId);
```

Pasos internos:

1. Verifica `roundData[round].finalized` — revierte `RoundNotFinalized` si false.
2. Verifica `claimed[round][projectId][you]` — revierte `AlreadyClaimed` si true.
3. Calcula `amount`.
4. Si `amount > 0`:
   - Marca `claimed[...][you] = true`.
   - Emite `Claimed`.
   - Llama a `CREDIT.mint(you, amount, "rewardRoundV2:stakers")` (en el V1 legacy, tag `"rewardRound"`).
5. Si `amount == 0`: no marca claimed, no acuña, retorna 0 (no-op silencioso).

Lo que reclamas es tu porción del **bucket stakers** — 55% de la emisión de la ronda en el split default del V2. Los otros buckets (LPs 25%, apps 15%, bonders 5%) son push en el `finalizeRound` y no pasan por el `claim`.

Esa semántica de `amount == 0` siendo no-op es intencional — si por algún motivo el cálculo retornó 0 pero puede cambiar, no "quemas" el slot de claim.

## Reclamando en batch

Más eficiente si tienes múltiples rondas o múltiples proyectos:

```solidity
uint256[] memory rounds     = [5, 5, 6, 6, 7];
uint256[] memory projectIds = [42, 17, 42, 17, 42];

uint256 total = rewardDistributor.claimMany(rounds, projectIds);
```

Arrays **paralelos** — `rounds[i]` se combina con `projectIds[i]`. Deben tener el mismo tamaño (si no `ArrayLengthMismatch`) y no pueden estar vacíos (si no `EmptyBatch`).

Efecto: una única tx acuña `total` CREDIT, ejecutando N claims individuales.

## Cuándo pierdes el claim

**No** pierdes claim por tiempo — no hay deadline. La única forma de perder es:

- **No stakear antes del snapshot de la ronda**. Stake después no genera peso retroactivo.
- **Unstakear antes del snapshot**. Después del snapshot puedes unstakear que no afecta el claim de esa ronda.
- **El proyecto no generar burn ni tener peso suficiente** durante las rondas en que stakeaste.

Pero una vez que tu peso fue grabado en el snapshot y la ronda fue finalizada, tienes derecho permanente a reclamar.

## UI workflow típico

1. Conectar wallet en el hub.
2. Ir a "My Rewards".
3. La app carga todas las rondas finalizadas desde tu primer stake.
4. Para cada ronda × proyecto en que stakeaste y no reclamaste, muestra preview.
5. Seleccionas cuáles quieres reclamar.
6. La app monta una única tx `claimMany` con los pares seleccionados.
7. Firmas, pagas gas, recibes CREDIT.

## Gas

- `claim` único: ~180-220k gas (mint + evento).
- `claimMany` con N pares: ~180k + ~140k × N.

El batch es significativamente más eficiente que N txs individuales. Úsalo cuando sea posible.

## Lo que recibes

CREDIT. Fungible, ERC-20 estándar. Puedes:

- Gastarlo en apps del ecosistema.
- Venderlo en DEX externa (si hay liquidez).
- Mantenerlo (exposición a la apreciación si el supply sigue cayendo).
- Re-usarlo (comprar más GOV en DEX para stakear más — el "re-stake" no es automático en v1).

No hay **auto-compound**. No hay **auto-claim**. Si olvidas, el CREDIT no se acuña — solo existe cuando lo solicitas.

## Edge cases

### Round 0 — no hay burn anterior

En la ronda 0, `burn_{-1}` se considera 0. La emisión viene del floor (`floorSchedule[0]`). Shares por proyecto se computan vía **peso global** (`staking.getGlobalWeightAt`).

Por lo tanto, si stakeaste desde el inicio y el peso global es solo el tuyo, capturas una porción grande. Es el incentivo de ser early.

### Bootstrap sin stake

Si una ronda finaliza y `globalWeight == 0` en el snapshot, ningún claim funciona — `_projectStakerShare` retorna 0 en todos los casos en el camino bootstrap. El bucket stakers se calcula pero **no se acuña** (nadie para distribuir). Los buckets LPs y bonders siguen siendo acuñados (push en el `finalizeRound`); apps no emite sin burn.

### Probation inicial durante el claim

`RewardDistributor._calculateClaim` lee `REGISTRY.isInProbation(projectId)` **en el momento del claim**, no del finalize. Si la probation inicial terminó entre finalize y claim, recibes el share completo (la probation es por tiempo; `probationEndsAt` se setea en la activación y no cambia).

### El proyecto pasa a `Removed` entre finalize y claim

Tu derecho de claim persiste — `roundData` es inmutable tras finalize. Puedes reclamar incluso con el proyecto removido. Además, puedes unstakear inmediatamente (bypass del lock) si aún tienes posición.

---

**Siguiente →** [Visión general de integración (devs)](../05-for-developers/01-integration-overview.md)
