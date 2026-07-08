# Tokenomics

**Audiencia:** quien quiera entender la distribución y la dinámica de supply de los dos tokens.
**Requisitos previos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Flujo de valor](../03-protocol-overview/03-economic-flows.md).

Esta página describe la arquitectura económica de los tokens **tras el remodel 2026-07-08**. **No es recomendación ni promesa de valorización.** Todos los parámetros ajustables vía gobernanza pueden cambiar; los rangos de parámetros ajustables están codificados on-chain.

## GOV — supply fijo

| Aspecto | Valor | Fuente |
|---|---|---|
| Supply cap | 100.000.000 GOV | `GovernanceToken.CAP_SUPPLY` (inmutable) |
| Supply en el deploy | 0 | constructor del `GovernanceToken` |
| Emisión | Exclusivamente vía `mint(to, amount, tag)` por el owner | `GovernanceToken.mint` |
| Owner en producción | `CommunityTimelock` | handoff vía `transferOwnership` + `acceptOwnership` |

Cada GOV en circulación solo puede existir si el Timelock (vía propuesta aprobada) llamó a `mint`. El cap de 100M nunca puede excederse — la función revierte con `CapExceeded` si se intenta.

### Las tres funciones económicas del GOV

1. **Gobernanza**: vota propuestas (fee dentro del techo de 5%, split de la fee, whitelist de proyectos, minTarget de rondas).
2. **Gate de inversión**: `ProjectFunding.invest` y `claim` exigen GOV stakeado en el proyecto (`Staking.getWeight > 0`). Sin GOV en stake no se invierte ni se retira rev-share.
3. **Captura de valor**: el 40% de la fee del protocolo (= 1% del GMV con fee de 2,5%) financia el buyback continuo de GOV.

### Distribución planeada

La distribución no se hace en el deploy. El genesis de GOV es 0. La DAO decide vía propuestas secuenciales. El repositorio documenta la propuesta inicial típica:

```
30%  Treasury permanente         (30M)   - queda en Treasury, sale via propuestas futuras
25%  Team + early contributors    (25M)   - via TeamVesting contracts, cliff 12m + linear 36m
20%  Public sale / community      (20M)   - via sale contract (a definir en propuesta)
15%  Community rewards            (15M)   - incentivos / airdrops via UserSubsidy
10%  Liquidity                    (10M)   - provision de LP en DEX externa
----
100% (100M — atinge cap)
```

**Esos valores son intención de propuesta, no programación automática.** Ninguna línea de código del repositorio implementa los porcentajes 30/25/20/15/10 — no hay schedule on-chain, y los contratos `Sale`, LBP/`LiquidityManager` y `LPRewards` citados **no existen en el repo**. Cada asignación es una propuesta separada, votada individualmente. La DAO puede ajustar las proporciones antes de ejecutar cada bucket. Hasta que la propuesta de distribución se ejecute, **0 GOV está en circulación** — el 100% del cap permanece minteable por el Timelock.

### TeamVesting

Cada miembro del equipo recibe una instancia separada de `TeamVesting`. Parámetros típicos:

- `start` = timestamp del TGE.
- `cliff` = 365 días.
- `duration` = 4 × 365 días (incluye cliff; 12m cliff + 36m linear).

Tras el cliff, libera `cliff/duration = 25%` de una sola vez ("hockey stick") y después linealmente hasta 100%. `release()` es pull — cualquiera puede llamar, pero los tokens siempre van al `beneficiary`.

Revocación: el `owner` (Timelock, vía propuesta) puede revocar en cualquier punto. Congela la frontera en `totalAllocatedAtRevoke = vestedAmount(now)` y devuelve el unvested al `returnTo`.

### No hay yield en GOV per se

Tener GOV parado en la wallet **no** paga nada. GOV participa en la economía vía:

- Staking en proyectos (habilita invertir en rondas + reclamar rev-share).
- Colateral de listado de proyecto (bloquea GOV sin generar retorno).
- Voto en propuestas (gratuito).
- Exposición indirecta al buyback continuo (40% de la fee).

## CREDIT — estable 1:1 con USDC

| Aspecto | Valor | Fuente |
|---|---|---|
| Precio | 1 CREDIT = 1 USDC, por construcción | `CreditPSM.buy`/`sell` (1:1, sin fee) |
| Supply cap | No aplica — supply elástico sigue la demanda de saldos de pago | `CreditPSM` |
| Mint vigente | `CreditPSM.buy`: deposita USDC, mintea `usdc × 1e12` | `CreditPSM` con `MINTER_ROLE` |
| Burn vigente | `CreditPSM.sell`: quema CREDIT devuelto, libera USDC 1:1 | `CreditPSM` con `BURNER_ROLE` |
| Respaldo | 100% retenido en el PSM; `backing() >= mintedOutstanding` (normalizado) | invariante I-PSM1, sin función de retiro |
| Genesis (legado) | 10.000.000 CREDIT one-shot al Treasury (pre-remodel) | `mintGenesis` con flag `genesisMinted` |

**CREDIT dejó de ser deflacionario.** No hay fórmula de emisión, no hay burn en pagos, no hay floor schedule, no hay capMax. La pregunta "¿cuánto vale CREDIT?" tiene respuesta fija: 1 USDC — verificable llamando `psm.backingNormalized()` y comparando con `psm.mintedOutstanding()`.

**Nota sobre el CREDIT legado**: el genesis (10M) y los rewards minteados antes del remodel circulan sin respaldo correspondiente en el PSM. `sell()` atiende cualquier CREDIT, pero limitado al USDC efectivamente depositado (`InsufficientBacking` si se excede); el contador `mintedOutstanding` clampea en cero para tolerar redenciones de CREDIT legado.

## El flujo de la fee — de dónde sale el valor para los stakeholders

Cada pago de `amount` CREDIT vía `FeeRouterV2.pay` se divide así:

```
fee      = amount × 2,5%          (feeBps = 250; techo duro 500 = 5%)
  ├─ 40% → treasuryRecipient      (= 1,0% del pago — opex de la DAO)
  ├─ 40% → buybackRecipient       (= 1,0% del pago — recompra de GOV)
  └─ 20% → grantsRecipient        (= 0,5% del pago — fomento de apps)
revShare = amount × revShareBpsOf (0 a 30%; 0 si el proyecto nunca captó)
toApp    = amount - fee - revShare  (~97,5% sin rev-share; ~89,5% con 8%)
```

El evento `PaymentRouted` registra las 5 parcelas de cada pago; `grossVolumeOf[projectId]` acumula el volumen bruto — la métrica base para valorar rondas.

## Rondas de captación (ProjectFunding)

| Parámetro | Valor | Fuente |
|---|---|---|
| Rondas por proyecto | **1** (MVP) | `RoundAlreadyExists` |
| Rev-share | 1% a 30% (`[100, 3000]` bps) | `MIN/MAX_REV_SHARE_BPS` (constantes) |
| Duración | 1 a 90 días | `MIN/MAX_ROUND_DURATION` (constantes) |
| Alvo mínimo | 100 CREDIT (`minTarget`, ajustable por gobernanza) | `setMinTarget` |
| Regla de cierre | All-or-nothing: alvo 100% o refund integral | `_fund` / `closeExpiredRound` + `refund` |
| Shares | = CREDIT invertido (1:1), inmutables tras `Funded` | `sharesOf` |
| Elegibilidad | GOV stakeado en el proyecto (invest **y** claim) | `NoGovStaked` |
| Distribución | Pro-rata vía acumulador `accRevenuePerShare` (MasterChef, 1e18) | `notifyRevenue`/`claim` |
| Expiración del claim | Nunca | doc del contrato |

## Subsidios — UserSubsidy

El contrato `UserSubsidy` distribuye CREDIT pre-financiado a primeros usuarios de las apps vía Merkle drops.

Parámetros por campaña (propuestos por la DAO):

- `merkleRoot` — raíz del árbol de usuarios elegibles.
- `amountPerUser` — CREDIT por claim.
- `maxClaims` — cap total de claims ejecutables.
- `deadline` — hasta cuándo pueden reclamar.

La DAO funda el contrato transfiriendo `maxClaims × amountPerUser` de CREDIT del Treasury antes de crear la campaña. Los sobrantes tras `closeCampaign` vuelven al `returnTo` (típicamente Treasury).

## Resumen de parámetros ajustables vía gobernanza

| Parámetro | Contrato | Rango permitido | Valor en producción |
|---|---|---|---|
| `feeBps` | FeeRouterV2 | `[0, 500]` (techo duro 5%) | `250` (2,5%) |
| `feeSplit` | FeeRouterV2 | suma = 10.000 bps | `(4000, 4000, 2000)` — 40% treasury / 40% buyback / 20% grants |
| `treasuryRecipient` / `buybackRecipient` / `grantsRecipient` | FeeRouterV2 | ≠ 0 | Treasury (MVP dev: los tres) |
| `minTarget` | ProjectFunding | `>= 0` | `100e18` (100 CREDIT) |
| `minCollateral` | ProjectRegistry | `> 0` | `10.000 GOV` |
| `probationDuration` | ProjectRegistry | `> 0` | `30 days` |
| `votingDelay` | Governor | `> 0` bloques | `7200` (~1d) |
| `votingPeriod` | Governor | `> 0` bloques | `50400` (~7d) |
| `proposalThreshold` | Governor | `>= 0` GOV | `10.000 GOV` |
| `quorumNumerator` | Governor | `[0, 100]` | `4` |
| `timelockMinDelay` | Timelock | `>= 0` seg | `172800` (2d) |

Parámetros **no ajustables** (constantes/immutables):

- Cap de GOV (`CAP_SUPPLY = 100M`).
- `FEE_BPS_CAP = 500` (5%) en FeeRouterV2 — ni la gobernanza lo supera.
- `MIN_REV_SHARE_BPS = 100`, `MAX_REV_SHARE_BPS = 3000`, `MIN_ROUND_DURATION = 1 day`, `MAX_ROUND_DURATION = 90 days`, `ACC_PRECISION = 1e18` en ProjectFunding.
- El PSM no tiene **ningún** parámetro: sin owner, sin setters, sin fee, sin función de retiro del respaldo. `SCALE` es immutable derivado de los decimales del USDC.
- `MIN_LOCK = 14 days`, `MAX_LOCK = 365 days`, `MAX_MULTIPLIER = 4x` en Staking.
- Dirección de cualquier contrato (sin upgrade path).

### Parámetros del modelo legado

`alpha`, `capMax`, `floorSchedule`, `roundDuration`, `sanityCap`, splits del FeeRouter V1 y `bucketBps` del RewardDistributorV2 pertenecen al modelo burn-to-mint anterior al remodel y ya no gobiernan ningún flujo económico nuevo. Referencia histórica en las páginas de contratos marcadas como legado.

---

**Siguiente →** [Value accrual](02-value-accrual.md)
