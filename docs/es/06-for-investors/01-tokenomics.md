# Tokenomics

**Audiencia:** quien quiera entender la distribución, emisión y dinámica de supply de los dos tokens.
**Requisitos previos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

Esta página describe la arquitectura económica de los tokens. **No es recomendación ni promesa de valorización.** Todos los parámetros ajustables vía gobernanza pueden cambiar; los rangos de parámetros ajustables están codificados on-chain.

## GOV — supply fijo

| Aspecto | Valor | Fuente |
|---|---|---|
| Supply cap | 100.000.000 GOV | `GovernanceToken.CAP_SUPPLY` (inmutable) |
| Supply en el deploy | 0 | constructor del `GovernanceToken` |
| Emisión | Exclusivamente vía `mint(to, amount, tag)` por el owner | `GovernanceToken.mint` |
| Owner en producción | `CommunityTimelock` | handoff vía `transferOwnership` + `acceptOwnership` |

Cada GOV en circulación solo puede existir si el Timelock (vía propuesta aprobada) llamó a `mint`. El cap de 100M nunca puede excederse — la función revierte con `CapExceeded` si se intenta.

### Distribución planeada

La distribución no se hace en el deploy. El genesis de GOV es 0. La DAO decide vía propuestas secuenciales. El repositorio documenta la propuesta inicial típica:

```
30%  Treasury permanente         (30M)   - queda en Treasury, sale via propuestas futuras
25%  Team + early contributors    (25M)   - via TeamVesting contracts, cliff 12m + linear 36m
20%  Public sale / community      (20M)   - via sale contract (a definir en propuesta)
15%  Community rewards            (15M)   - liquidity mining / airdrops via UserSubsidy
10%  Liquidity                    (10M)   - provision de LP en DEX externa
----
100% (100M — atinge cap)
```

**Esos valores son intención de propuesta, no programación automática.** Cada asignación es una propuesta separada, votada individualmente. La DAO puede ajustar las proporciones antes de ejecutar cada bucket.

### TeamVesting

Cada miembro del equipo recibe una instancia separada de `TeamVesting`. Parámetros típicos:

- `start` = timestamp del TGE.
- `cliff` = 365 días.
- `duration` = 4 × 365 días (incluye cliff; 12m cliff + 36m linear).

Tras el cliff, libera `cliff/duration = 25%` de una sola vez ("hockey stick") y después linealmente hasta 100%. `release()` es pull — cualquiera puede llamar, pero los tokens siempre van al `beneficiary`.

Revocación: el `owner` (Timelock, vía propuesta) puede revocar en cualquier punto. Congela la frontera en `totalAllocatedAtRevoke = vestedAmount(now)` y devuelve el unvested al `returnTo`.

### No hay yield en GOV per se

Tener GOV parado en la wallet **no** paga reward. GOV solo participa en la economía vía:

- Staking en proyectos (genera peso + reward en CREDIT).
- Colateral de listado de proyecto (bloquea GOV sin generar reward).
- Voto en propuestas (gratuito).

## CREDIT — supply elástico

| Aspecto | Valor | Fuente |
|---|---|---|
| Supply cap hardcodeado | **No existe** | `CreditToken` no tiene cap |
| Genesis | 10.000.000 CREDIT (one-shot) | `mintGenesis` con flag `genesisMinted` |
| Destinatario del genesis | `Treasury` | `ignition/modules/Dao.ts` |
| Mint posterior | Solo por el `MINTER_ROLE` | `CreditToken.mint` |
| Minter en producción | `RewardDistributor` | grant del deploy |
| Burn | `burn`, `burnFrom` (ERC20Burnable), `burnByRole` (role-gated) | `CreditToken` hereda `ERC20Burnable` |

### Fórmula de emisión

En `RewardDistributor.finalizeRound`:

```
emissao_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Con parámetros en producción:

- `alpha = 0.95` (ajustable entre `[0.5, 1.1]`).
- `capMax = 5.000.000 CREDIT` por ronda (ajustable entre `[1, 100M] CREDIT`).
- `floorSchedule`: inmutable, 24 valores decrecientes:

```
floor[0]  = 400.000 CREDIT
floor[1]  = 383.333 CREDIT
floor[2]  = 366.666 CREDIT
...
floor[23] = 16.666 CREDIT
floor[24+] = 0 (sin entrada)
```

Decaimiento lineal de 400k a ~16.666 en 24 rondas. En producción (`roundDuration = 7 dias`), eso cubre ~168 días = ~6 meses de bootstrap.

### Dinámica esperada de supply

Si el uso es constante (burn = constante), `alpha < 1` implica emisión < burn, y el supply cae gradualmente. Simulación de 52 rondas escenario base: el supply cae ~3.8%.

Si el uso crece, el burn absoluto crece, la emisión absoluta crece (hasta saturar en `capMax`). En las primeras 24 rondas, el floor puede mantener emisión incluso si el burn colapsa — después, no.

Si el uso muere, burn ~ 0, `floor(R)` domina por 24 rondas, después se pone a cero.

## Subsidios — UserSubsidy

El contrato `UserSubsidy` distribuye CREDIT pre-financiado a primeros usuarios de las apps vía Merkle drops.

Parámetros por campaña (propuestos por la DAO):

- `merkleRoot` — raíz del árbol de usuarios elegibles.
- `amountPerUser` — CREDIT por claim.
- `maxClaims` — cap total de claims ejecutables.
- `deadline` — hasta cuándo pueden reclamar.

La DAO funda el contrato transfiriendo `maxClaims × amountPerUser` de CREDIT del Treasury antes de crear la campaña. Los sobrantes tras `closeCampaign` vuelven al `returnTo` (típicamente Treasury).

## Floor decay — por qué 24 rondas

El floor existe para el **bootstrap** — garantizar emisión positiva mientras los apps aún no generan burn orgánico. 24 rondas × 7 días = ~168 días = ~6 meses. Después de eso, el protocolo necesita caminar con sus propias piernas.

Decaimiento lineal: `floor[R] = 400_000e18 - R * (400_000 / 24 * 1e18)`, redondeado. El total sumado da ~5.2M CREDIT — bien por debajo del genesis (10M). Diseñado para ser safety net, no presupuesto cerrado.

## Cap por ronda (capMax)

Techo duro de la emisión total en cualquier ronda. En producción, 5M CREDIT. Ajustable dentro de `[MIN_CAPMAX=1, MAX_CAPMAX=100M] CREDIT`.

Razón: incluso si el burn es absurdamente alto (ataque o evento puntual), la emisión queda clampeada. Eso preserva la previsibilidad del supply máximo.

## Sanity cap por (ronda, proyecto)

Límite paralelo, más local, impuesto por el `BurnTracker`:

- Default en producción: `10.000.000 CREDIT` por proyecto por ronda.
- Si `accumulated + amount > sanityCap`, `burnAndRecord` revierte con `SanityCapExceeded`.
- La gobernanza puede setear a 0 (deshabilitar) o ajustar vía propuesta.

Razón: impedir que un proyecto malicioso queme volumen absurdo para capturar share desproporcionado.

## Probation penalty (25%)

Los proyectos en probation inicial (por tiempo) reciben `projectShare / 4` en la emisión. El otro 75% **no se redistribuye** — simplemente no se acuña. Preserva la intención deflacionaria.

En producción, la probation inicial dura 30 días. Durante ese período, los stakers en proyectos nuevos capturan 25% de lo que sería completo.

## Resumen de parámetros ajustables vía gobernanza

| Parámetro | Contrato | Rango permitido | Valor en producción |
|---|---|---|---|
| `alpha` | RewardDistributor | `[0.5e18, 1.1e18]` | `0.95e18` |
| `capMax` | RewardDistributor | `[1e18, 100M * 1e18]` | `5M * 1e18` |
| `roundDuration` | BurnTracker | `[1 day, 30 days]` | `7 days` |
| `maxBurnPerRoundPerProject` | BurnTracker | `[0, ilimitado]` (0 = deshabilita) | `10M * 1e18` |
| `minCollateral` | ProjectRegistry | `> 0` | `10.000 GOV` |
| `probationDuration` | ProjectRegistry | `> 0` | `30 days` |
| `defaultSplit` | FeeRouter | suma = 10.000 bps | `(9500, 0, 500)` |
| `votingDelay` | Governor | `> 0` bloques | `7200` (~1d) |
| `votingPeriod` | Governor | `> 0` bloques | `50400` (~7d) |
| `proposalThreshold` | Governor | `>= 0` GOV | `10.000 GOV` |
| `quorumNumerator` | Governor | `[0, 100]` | `4` |
| `timelockMinDelay` | Timelock | `>= 0` seg | `172800` (2d) |

Parámetros **no ajustables**:

- Cap de GOV (`CAP_SUPPLY = 100M`, inmutable).
- `MIN_LOCK = 14 days`, `MAX_LOCK = 365 days`, `MAX_MULTIPLIER = 4x` en Staking.
- `MIN_ROUND_DURATION`, `MAX_ROUND_DURATION` en BurnTracker (bounds).
- `MIN_ALPHA`, `MAX_ALPHA`, `MIN_CAPMAX`, `MAX_CAPMAX`, `FLOOR_SCHEDULE_LENGTH`, `PROBATION_PENALTY_DENOM` en RewardDistributor.
- `floorSchedule` (grabado en el constructor).
- Dirección de cualquier contrato (sin upgrade path).

---

**Siguiente →** [Value accrual](02-value-accrual.md)
