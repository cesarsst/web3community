# Burn-to-mint

> ⚠️ **LEGADO — sustituido por el remodel 2026-07-08.** El protocolo ya no quema CREDIT en pagos ni emite rewards: CREDIT es estable 1:1 con USDC ([CreditPSM](../08-contracts-reference/15-CreditPSM.md)) y el retorno del inversor viene de rev-share sobre receita real ([ProjectFunding](../08-contracts-reference/16-ProjectFunding.md)). Motivo del cambio: la tasa efectiva de ~80% sobre la app hacía del bypass la estrategia dominante (`audit/economist/2026-07-08-feerouter-bypass.md`). Esta página se mantiene como referencia histórica.

**Audiencia:** quien quiera entender cómo el protocolo sostenía emisión en el modelo anterior.
**Requisitos previos:** [Dual-token](01-dual-token-economy.md).

## La fórmula

```
emissao_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Definida en `RewardDistributor.finalizeRound`. Tres capas:

1. **`alpha * burn_{R-1}`** — base económica. En producción `alpha = 0.95` (**parámetro de deploy**: `alpha = 950000000000000000` en `ignition/parameters/production.json`; los bounds `[MIN_ALPHA=0.5, MAX_ALPHA=0.99]` son `constant` en el código), es decir, se emite 95% de lo que fue quemado en la ronda anterior. Si nadie quemó nada, ese término es cero.
2. **`max(..., floor(R))`** — garantiza piso mínimo durante el bootstrap. El `floorSchedule` tiene 24 entradas. Rondas >= 24 no tienen floor. En producción, el floor cae linealmente de 400k CREDIT (ronda 0) a ~16.666 CREDIT (ronda 23).
3. **`min(..., capMax)`** — techo duro. En producción `capMax = 5.000.000 CREDIT`. Ajustable vía gobernanza dentro de `[1, 100M] CREDIT`.

## Por qué `alpha < 1` (levemente deflacionario)

El sistema está diseñado para que **emisión total < burn total** si el uso se mantiene constante. Intuición:

- Ronda R-1: los usuarios quemaron 1.000.000 CREDIT.
- Ronda R: emitimos 950.000 CREDIT.
- Saldo neto de supply: -50.000 CREDIT.

A lo largo de muchas rondas, el supply cae lentamente. Si la demanda por CREDIT se mantiene, esa caída de oferta se traduce en apreciación unitaria — que es el premio para quien retiene.

**Simulación**: el repositorio tiene en `scripts/simulation/` una simulación de 52 rondas en 3 escenarios. En el escenario "base" (uso constante), el supply cae ~3.8% en las 52 rondas.

## El papel del floor

En la ronda 0, `burn_{-1}` no existe (se considera 0). Sin floor, la emisión sería 0 — los stakers no tendrían incentivo para entrar. El floor existe solo para el bootstrap: **"hasta que el ecosistema empiece a generar burn orgánico, la DAO banca una emisión mínima"**.

Después de 24 rondas (en producción, 24 × 7 días = ~168 días = ~6 meses), el floor se pone a cero. De ahí en adelante, **solo hay emisión si hubo burn**. Si el protocolo no despegó en 6 meses, la emisión natural cae a cero — que es la señal correcta para que la DAO intervenga o para que los apoyadores reevalúen.

## El papel del cap

El `capMax` existe como salvaguarda contra una explosión de burn (sea genuina o artificial). Incluso si alguien quemara 10 mil millones de CREDIT en una ronda, la emisión quedaría clampeada en `capMax` (5M en producción).

## La protección multicapa contra ataques de burn

Además del `capMax` de la emisión total, está el **sanity cap por `(ronda, projectId)`** en el `BurnTracker` (default 10M CREDIT en producción):

```
si burn acumulado del proyecto en la ronda + nuevo burn > maxBurnPerRoundPerProject:
    revert SanityCapExceeded
```

Esto impide que **un proyecto malicioso queme volumen absurdo para capturar share desproporcionado** dentro de una ronda. Incluso si el atacante quemara por debajo del sanity cap pero por encima de su proporción de uso real, el `capMax` de la emisión total limita el impacto sobre el supply global.

## El papel de la probation

Todo proyecto recién activado entra en probation inicial por tiempo (`probationDuration`, 30 días en producción). Mientras `block.timestamp < probationEndsAt`:

```
si RewardDistributor detecta isInProbation(projectId):
    projectShare = projectShare / PROBATION_PENALTY_DENOM   // = /4
```

Es decir, **el proyecto recibe solo el 25% de su share de emisión**. El otro 75% **nunca se mintea** — no se redistribuye y no hay `_burn` del token involucrado. "Quemar" en tokenomics usualmente significa `_burn` sobre `totalSupply` ya existente; aquí la `projectShare` simplemente se divide por 4 antes de que se llame a `CREDIT.mint`, de modo que `CreditToken.totalSupply()` **no se ve afectado** por este camino. Esto preserva el espíritu deflacionario por sustracción de emisión, no por incineración.

Intuición: un proyecto nuevo tiene riesgo de ser fraude. Durante 30 días, la DAO y los stakers observan. Si es legítimo, la probation expira y la share se normaliza. Si es fraude, la gobernanza puede mover el proyecto a `Status.Probation` punitiva (bloquea stake y pagos) o `Status.Removed` (encierra y potencialmente hace slashing del colateral).

## Bootstrap: ¿y cuando no hay burn?

Si `burn_{R-1} == 0`, la emisión igualmente ocurre (vía floor, mientras R < 24). Pero **¿cómo se divide la emisión entre proyectos si nadie quemó?**

`RewardDistributor._projectShare` tiene un camino alternativo:

```
si totalBurnPrev == 0:
    projectShare = emision * projectWeight / globalWeight
```

Es decir: cuando no hay burn, el share es proporcional al **peso de staking** del proyecto sobre el peso global. Esto mantiene el incentivo para que los stakers entren pronto incluso sin uso real aún — ellos capturan el floor en proporción a su stake dirigido.

Para que eso funcione, `Staking` mantiene un checkpoint global (`_globalWeightCheckpoints`) actualizado en O(1) en cada cambio de posición.

## La ecuación de sustentación

El protocolo sobrevive a largo plazo **si y solo si** el burn orgánico agregado cubre al menos el costo para los stakers. En ecuación narrativa:

```
valor percibido por los stakers > costo de oportunidad de tener GOV en otro lugar
        |
        v
  stakers siguen entrando (o al menos no salen)
        |
        v
  apps siguen con backing (stakers son distribuidores de confianza)
        |
        v
  usuarios siguen usando
        |
        v
  burn continua
        |
        v
  loop fechado
```

Si cualquiera de esos eslabones se rompe, el loop se desacelera. **Ninguna fórmula salva un producto malo**; el papel de las matemáticas es solo no ser el punto de falla adicional.

## Lo que la DAO puede ajustar (y lo que no)

Ajustable vía `GOVERNANCE_ROLE` (Timelock, que solo ejecuta tras propuesta aprobada):

- `alpha` dentro de `[0.5, 0.99]` — `RewardDistributor.setAlpha`. El default 0.95 es parámetro de deploy; los bounds son constantes inmutables (`MIN_ALPHA`/`MAX_ALPHA`). El rango se redujo (antes `[0.5, 1.1]`) para garantizar la invariante económica IE1 (α < 1 permanente) por construcción — la gobernanza ya no puede votar un valor inflacionario. Ver dictamen en `audit/economist/2026-04-22-consistency-audit.md` (C2).
- `capMax` dentro de `[1, 100M] CREDIT` — `RewardDistributor.setCapMax`
- `roundDuration` dentro de `[1 dia, 30 dias]` — `BurnTracker.setRoundDuration`
- `maxBurnPerRoundPerProject` (0 = deshabilita) — `BurnTracker.setMaxBurnPerRoundPerProject`
- Split por defecto y overrides — `FeeRouter.setDefaultSplit` / `setProjectSplit` / `clearProjectSplit`
- `minCollateral` y `probationDuration` del Registry

**No ajustable**:

- `floorSchedule` — inmutable desde el constructor del `RewardDistributor`.
- `MIN_LOCK`, `MAX_LOCK`, `MAX_MULTIPLIER` del `Staking`.
- `MIN_ROUND_DURATION`, `MAX_ROUND_DURATION` del `BurnTracker`.
- `MIN_ALPHA`, `MAX_ALPHA`, `MIN_CAPMAX`, `MAX_CAPMAX` del `RewardDistributor`.
- Cap de supply de GOV (100M).

---

**Siguiente →** [Rewards distribution](04-rewards-distribution.md)
