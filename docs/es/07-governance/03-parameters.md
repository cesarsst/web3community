# Parámetros ajustables por la DAO

**Audiencia:** quien quiera saber exactamente lo que puede cambiar la DAO y cuáles son los rangos permitidos.
**Requisitos previos:** [Ciclo de una propuesta](01-proposal-lifecycle.md).

Esta página lista **todos** los parámetros ajustables vía gobernanza, el valor en producción, el bound on-chain y qué función se usa para alterarlo.

> **⚠️ Actualización — remodel 2026-07-08.** Los parámetros de los contratos legados (`RewardDistributor` V1/V2, `FeeRouter` V1, `BurnTracker`, `LiquidityGauge`) listados abajo ya no gobiernan ningún flujo económico nuevo. Los parámetros del núcleo vigente son estos:

### FeeRouterV2 (vigente)

| Función | Ajusta | Bound on-chain | Producción |
|---|---|---|---|
| `setFeeBps(newFeeBps)` | Fee del protocolo | `<= FEE_BPS_CAP = 500` (5%, constante — ni la gobernanza lo supera) | `250` (2,5%) |
| `setFeeSplit({treasuryBps, buybackBps, grantsBps})` | Repartición de la fee | suma `== 10.000` | `(4000, 4000, 2000)` — 40/40/20 |
| `setRecipients(treasury, buyback, grants)` | Destinos de la fee | ≠ 0 | Treasury (MVP dev: los tres) |
| `setAppRecipient(projectId, recipient)` | Destino del pago de la app | ≠ 0; **solo el owner del proyecto** (no es gobernanza) | fallback: owner del Registry |

### ProjectFunding (vigente)

| Función | Ajusta | Bound on-chain | Producción |
|---|---|---|---|
| `setMinTarget(newMin)` | Alvo mínimo de ronda (anti-spam) | sin bound | `100e18` (100 CREDIT) |

Constantes no ajustables del vigente: `MIN/MAX_REV_SHARE_BPS = 100/3000` (1%–30%), `MIN/MAX_ROUND_DURATION = 1/90 días`, `ACC_PRECISION = 1e18`. El `CreditPSM` **no tiene parámetro alguno** (sin owner, sin setters, sin fee).

## Contratos y funciones de ajuste

### GovernanceToken

Owner en producción = `CommunityTimelock`. Propuestas que llamen:

| Función | Qué hace | Bound on-chain |
|---|---|---|
| `mint(to, amount, tag)` | Acuña GOV a `to` hasta alcanzar `CAP_SUPPLY` | Revierte con `CapExceeded` si supply post-mint > 100M |

Sin setters de parámetro — `CAP_SUPPLY` es inmutable.

### CreditToken

Admin en producción = `CommunityTimelock`. Propuestas:

| Función | Qué hace | Bound on-chain |
|---|---|---|
| `grantRole(MINTER_ROLE, addr)` | Concede poder de mint | — |
| `revokeRole(MINTER_ROLE, addr)` | Revoca | — |
| `grantRole(BURNER_ROLE, addr)` | Concede poder de burn role-gated | — |
| `revokeRole(BURNER_ROLE, addr)` | Revoca | — |

`mintGenesis` no es llamable tras la primera ejecución (flag `genesisMinted`).

### ProjectRegistry

| Función | Qué hace | Bound on-chain | Valor en producción |
|---|---|---|---|
| `registerProject(owner, uri, collateral)` | Lista nuevo proyecto | `collateral >= minCollateral` | — |
| `activateProject(id)` | Pending → Active | status debe ser Pending | — |
| `setProbation(id)` | Active → Probation | status debe ser Active | — |
| `reactivate(id)` | Probation → Active | status debe ser Probation | — |
| `removeProject(id, slash, treasury)` | → Removed | status != Removed | — |
| `setMinCollateral(newMin)` | Ajusta colateral mínimo | `newMin > 0` | `10.000 GOV` |
| `setProbationDuration(newDuration)` | Ajusta probation inicial | `newDuration > 0` | `2.592.000 seg` (30d) |

### Treasury

Movimiento de fondos (todas `GOVERNANCE_ROLE` = Timelock):

| Función | Qué hace | Bound on-chain |
|---|---|---|
| `transfer(token, to, amount)` | Envía ERC-20 | saldo suficiente; para CREDIT, no puede invadir las reservas `polRefillBucket + pendingGaugeRewards` (`TransferExceedsUnreservedCredit`) |
| `batchTransfer(token, recipients[], amounts[])` | Batch de transfers | arrays válidos, saldo total suficiente, misma regla de reservas para CREDIT |
| `payRebates(token, apps[], amounts[], round)` | Batch con evento semántico | idem |
| `executeBuyback(usdcAmount, minCreditOut)` | **Buyback real (FFP, Fase 1.1)**: swap USDC → CREDIT vía Uniswap V3 + burn inmediato del CREDIT comprado | infra seteada (oracle/router/feed); spot TWAP < floor por >= `triggerDurationSecs`; sanidad Chainlink USDC/USD; `usdcAmount` <= cap por evento y cap mensual; `minCreditOut > 0` |
| `sweepETH(to, amount)` | Retira ETH | `balance suficiente` |

Parámetros FFP (buyback/floor) — setters `GOVERNANCE_ROLE`, bounds vía `_checkBounds` (`ParamOutOfBounds` si está fuera):

| Función | Bound on-chain | Default |
|---|---|---|
| `setFloorMultiplierBps(bps)` | `[3000, 8000]` | `5000` (floor relativo = 50% de la MA90) |
| `setFloorAbsoluteUsd(value)` | `[1e16 ($0.01), 1e19 ($10.00)]` | `1e17` ($0.10) |
| `setTriggerDurationSecs(secs)` | `[1 hour, 7 days]` | `24 hours` |
| `setTwapWindowSecs(secs)` | `[5 minutes, 2 hours]` | `30 minutes` |
| `setChainlinkSanityLowBps(bps)` | `[9000, 9999]` | `9900` (0.99) |
| `setChainlinkSanityHighBps(bps)` | `[10001, 11000]` | `10100` (1.01) |
| `setCapPerEventBps(bps)` | `[100, 5000]` | `2000` (20% de las reservas USDC) |
| `setCapMonthlyBps(bps)` | `[100, 7000]` | `3000` (30% del snapshot mensual) |
| `setSlippageMaxBps(bps)` | `[10, 500]` | `100` (1%) |
| `setSwapFeeTier(fee)` | `!= 0` (fail-fast en el swap si el pool no existe) | `3000` (0.3%) |
| `setPriceOracle(oracle)` / `setSwapRouter(router)` / `setChainlinkFeed(feed)` | sin bound; `address(0)` deshabilita/pausa el buyback | `address(0)` hasta que la propuesta lo setee |

POL y saldos reservados (Fases 1.2/1.3):

| Función | Qué hace | Observación |
|---|---|---|
| `addPOL(...)` / `addPOLFromRefill(creditAmount, usdcAmount, ...)` | Provisiona liquidez CREDIT/USDC (posición NFT custodiada en el Treasury) | `GOVERNANCE_ROLE` |
| `removePOL(liquidityAmount, amount0Min, amount1Min, deadline)` | Remueve liquidez POL | `GOVERNANCE_ROLE` **+ supermayoría 75% en el Governor** (scan de `propose`) |
| `collectPOLFees(amount0Max, amount1Max)` | Colecta fees de la posición POL | `GOVERNANCE_ROLE` |
| `depositPolRefill(amount)` / `depositPendingGaugeRewards(amount)` | Acreditan los ledgers reservados | roles dedicadas; la reserva agregada post-depósito no puede exceder `balanceOf(CREDIT)` (`DepositExceedsCreditBalance`) |
| `flushPendingGaugeRewards(amount, poolId, duration)` | Drena el ledger a incentive en el gauge (`0` = todo / pool default) | `GOVERNANCE_ROLE` |
| `writeDownPolRefillBucket(amount)` / `writeDownPendingGaugeRewards(amount)` | Válvulas de write-down de los ledgers (escape/reciclaje) | `GOVERNANCE_ROLE`, eventos auditables |

### Staking

Sin parámetros ajustables. `MIN_LOCK`, `MAX_LOCK`, `MULTIPLIER_PRECISION`, `MAX_MULTIPLIER` son `constant`.

### BurnTracker

| Función | Qué hace | Bound on-chain | Valor en producción |
|---|---|---|---|
| `closeRound()` | Cierra ronda actual, abre la siguiente | — | — |
| `setRoundDuration(new)` | Ajusta duración objetivo de la ronda | `[MIN_ROUND_DURATION=1d, MAX_ROUND_DURATION=30d]` | `604.800 seg` (7d) |
| `setMaxBurnPerRoundPerProject(new)` | Sanity cap; 0 = deshabilita | — | `10M CREDIT` |
| `grantRole(RECORDER_ROLE, app)` | Autoriza a la app a llamar `burnAndRecord` | — | — |
| `revokeRole(RECORDER_ROLE, app)` | Desautoriza | — | — |

### RewardDistributor

| Función | Qué hace | Bound on-chain | Valor en producción |
|---|---|---|---|
| `finalizeRound(round)` | Graba emisión inmutable de la ronda | secuencial, ronda cerrada en el tracker | — |
| `setAlpha(new)` | Ajusta alpha | `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` | `0.95e18` |
| `setCapMax(new)` | Ajusta techo por ronda | `[MIN_CAPMAX=1e18, MAX_CAPMAX=100M*1e18]` | `5M CREDIT` |
| `grantRole(GOVERNANCE_ROLE, addr)` | idem | — | — |

`floorSchedule` es **inmutable** tras el deploy.

### RewardDistributorV2 (deploy opcional — Fase F / pivote CLP)

Hereda `setAlpha`/`setCapMax`/`finalizeRound` con los mismos bounds del V1, y añade el split de emisión en 4 buckets:

| Función | Qué hace | Bound on-chain | Valor default |
|---|---|---|---|
| `setBucketBps([stakers, lps, apps, bonders])` | Split de la emisión por ronda | suma `== 10.000`; `stakers >= 3000`; `lps >= 500`; `apps <= 2500`; `bonders <= 2000` | `[5500, 2500, 1500, 500]` (55/25/15/5) |

### LiquidityGauge (deploy opcional — Fase F / pivote CLP)

| Función | Qué hace | Bound on-chain |
|---|---|---|
| `addPool(pool)` / `setPoolEnabled(poolId, enabled)` | Whitelist de pools Uniswap V3 | — |
| `setVestingDuration(newDuration)` | Vesting de los rewards de LP | `[VESTING_DURATION_MIN=1d, VESTING_DURATION_MAX=90d]` |
| `setDenylist(account, denied)` / `pause()` / `unpause()` | Controles operacionales | — |
| `endIncentive(poolId)` | Termina incentive y recupera refund | — |
| `governanceRescueRewards(to, amount)` | Rescata CREDIT **no reservado** | limitado por `getUnreservedBalance()` — `totalVestingLocked` (vesting de usuarios) es intocable (`RescueExceedsUnreserved`) |

### CreditPriceOracle

**Sin parámetros ajustables** — adapter inmutable por diseño (sin owner, sin setters, sin storage mutable): pool, tokens, feed Chainlink, staleness (6h) y banda de sanidad (`[9900, 10100]` bps) se fijan en el constructor. Para cambiar cualquier cosa, se deploya otro adapter y la gobernanza lo apunta vía `Treasury.setPriceOracle(oracle)`.

### FeeRouter

| Función | Qué hace | Bound on-chain | Valor en producción |
|---|---|---|---|
| `setDefaultSplit(split)` | Split global default | `burnBps + treasuryBps + rebateBps == 10.000` | `(7000, 2000, 1000)` — 70% burn / 20% treasury / 10% rebate (Fase 0) |
| `setProjectSplit(id, split)` | Override por proyecto | idem | — |
| `clearProjectSplit(id)` | Remueve override | el override tiene que existir | — |

`setAppRecipient(id, recipient)` es owner-gated (no governance).

### UserSubsidy

| Función | Qué hace | Bound on-chain |
|---|---|---|
| `createCampaign(root, amountPerUser, maxClaims, deadline)` | Abre campaña Merkle | `root != 0, amount > 0, maxClaims > 0, deadline > now` |
| `closeCampaign(id, returnTo)` | Cierra y devuelve sobrantes | la campaña existe y no está cerrada |

### TeamVesting

Una instancia por beneficiario. Owner = `CommunityTimelock`.

| Función | Qué hace | Bound on-chain |
|---|---|---|
| `revoke(returnTo)` | One-shot; congela frontera | `!revoked, returnTo != 0` |

El cronograma (`start`, `cliff`, `duration`) es inmutable (seteado en el constructor).

### CommunityTimelock

Self-administered post-handoff. Propuestas:

| Función | Qué hace |
|---|---|
| `updateDelay(newDelay)` | Ajusta `minDelay`. El nuevo valor se aplica a propuestas futuras. |
| `grantRole(PROPOSER_ROLE, addr)` | Añade proposer |
| `revokeRole(PROPOSER_ROLE, addr)` | Remueve |
| `grantRole(CANCELLER_ROLE, addr)` | Añade canceller |
| `revokeRole(CANCELLER_ROLE, addr)` | Remueve |
| `grantRole(EXECUTOR_ROLE, addr)` | Añade executor |

### CommunityGovernor

Todos los cambios son `onlyGovernance` (necesitan venir vía propuesta aprobada por el propio Governor). Valores en producción en `ignition/parameters/production.json`.

| Función | Qué hace | Bound on-chain | Valor en producción |
|---|---|---|---|
| `setVotingDelay(new)` | Ajusta delay hasta abrir votación | `> 0` (uint48) | `7200` (~1d) |
| `setVotingPeriod(new)` | Ajusta duración de la votación | `> 0` (uint32) | `50400` (~7d) |
| `setProposalThreshold(new)` | Ajusta threshold para proponer | `>= 0` | `10.000 * 1e18 GOV` |
| `updateQuorumNumerator(new)` | Ajusta numerador del quorum | `[0, 100]` | `4` |
| `relay(target, value, data)` | Ejecuta operación arbitraria como si fuera el governor (rara) | — | — |

**Supermayoría 75% (enforced on-chain, no ajustable).** El `propose` escanea el batch: si cualquier call tiene target en el `TREASURY` (immutable, seteado en el constructor) con selector de `Treasury.removePOL` (`0x6a71d4b3`) o de gestión de roles (`grantRole`/`revokeRole`/`renounceRole`), o target en el propio Timelock con selector de gestión de roles, la propuesta entera se marca `ProposalType.Supermajority` (evento `ProposalTypeSet`) y sólo pasa con `forVotes >= 3 × againstVotes` y `forVotes > 0` (For >= 75% de los votos decisivos; Abstain fuera de la razón). Un batch mixto contamina la propuesta entera — por diseño.

## Parámetros inmutables

La DAO **no puede** alterar:

| Parámetro | Dónde | Valor |
|---|---|---|
| `CAP_SUPPLY` de GOV | `GovernanceToken` | 100.000.000 * 1e18 |
| `MIN_LOCK` del Staking | `Staking` | 14 días |
| `MAX_LOCK` del Staking | `Staking` | 365 días |
| `MAX_MULTIPLIER` del Staking | `Staking` | 4e18 |
| `MULTIPLIER_PRECISION` del Staking | `Staking` | 1e18 |
| `MIN_ROUND_DURATION` | `BurnTracker` | 1 día |
| `MAX_ROUND_DURATION` | `BurnTracker` | 30 días |
| `MIN_ALPHA`, `MAX_ALPHA` | `RewardDistributor` | `0.5e18`, `0.99e18` (reducido de `1.1e18` — ver `audit/economist/2026-04-22-consistency-audit.md` C2; garantiza IE1 α<1 permanente por construcción) |
| `MIN_CAPMAX`, `MAX_CAPMAX` | `RewardDistributor` | `1e18`, `100M*1e18` |
| `FLOOR_SCHEDULE_LENGTH` | `RewardDistributor` | 24 |
| `PROBATION_PENALTY_DENOM` | `RewardDistributor` | 4 (25%) |
| `floorSchedule` (valores) | `RewardDistributor` | grabados en el deploy |
| `_BPS_DENOMINATOR` | `FeeRouter` | 10.000 |
| Regla de supermayoría 75% (`removePOL` / gestión de roles en Treasury/Timelock) | `CommunityGovernor` | `forVotes >= 3 × againstVotes`; `TREASURY` es `immutable` |
| Bounds de los buckets del V2 | `RewardDistributorV2` | `MIN_BUCKET_STAKERS_BPS=3000`, `MIN_BUCKET_LPS_BPS=500`, `MAX_BUCKET_APPS_BPS=2500`, `MAX_BUCKET_BONDERS_BPS=2000` |
| Configuración entera del oracle | `CreditPriceOracle` | pool/tokens/feed/staleness 6h/banda `[9900, 10100]` — todo en el constructor |
| Direcciones de los contratos | deploy | fijos |
| `CommunityGovernor` `name` (EIP-712) | `CommunityGovernor` | "CommunityGovernor" |

Esos valores son el **piso constitucional** del protocolo: ni la DAO unánime puede alterarlos.

## Cómo proponer un cambio de parámetro

Ejemplo: reducir `alpha` de `0.95e18` a `0.90e18`.

```solidity
targets   = [address(rewardDistributor)];
values    = [0];
calldatas = [
    abi.encodeWithSelector(rewardDistributor.setAlpha.selector, 0.90e18)
];
description = "Reduce alpha to 0.90 to increase deflationary pressure";

governor.propose(targets, values, calldatas, description);
```

Prerrequisitos:

- El proposer tiene >= 10k GOV delegados.
- El valor nuevo `0.90e18` está dentro de `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]`. Si está fuera, la ejecución revierte (incluso con el voto aprobado).

## Efecto temporal de los cambios

Los cambios de parámetro entran en vigor **en el bloque de la ejecución** y afectan solo estado futuro:

- `setAlpha` altera el cálculo de `finalizeRound` para rondas **no finalizadas**. Rondas con `roundData[r].finalized == true` tienen `totalEmission` inmutable.
- `setCapMax` idem.
- `setRoundDuration` afecta rondas futuras (rondas ya abiertas no son truncadas).
- `setMaxBurnPerRoundPerProject` afecta gatings en nuevos `burnAndRecord` — acumulados pasados permanecen.
- `setDefaultSplit` / `setProjectSplit` afectan `pay`s futuros.
- `setMinCollateral` / `setProbationDuration` afectan **nuevos** registros; los existentes no son grandfather-alterados.

## Observabilidad

Eventos de cambio de parámetro:

```
# RewardDistributor
event AlphaUpdated(uint256 oldAlpha, uint256 newAlpha);
event CapMaxUpdated(uint256 oldCap, uint256 newCap);

# BurnTracker
event RoundDurationUpdated(uint64 oldDuration, uint64 newDuration);
event MaxBurnPerRoundPerProjectUpdated(uint256 oldMax, uint256 newMax);

# FeeRouter
event DefaultSplitUpdated(Split oldSplit, Split newSplit);
event ProjectSplitUpdated(uint256 indexed projectId, Split newSplit);
event ProjectSplitCleared(uint256 indexed projectId);

# ProjectRegistry
event MinCollateralUpdated(uint256 oldMin, uint256 newMin);
event ProbationDurationUpdated(uint64 oldDuration, uint64 newDuration);

# Treasury (FFP)
event BuybackParamsUpdated(bytes32 indexed paramKey, uint256 newValue);
event BuybackInfraUpdated(bytes32 indexed paramKey, address indexed addrOrZero, uint256 numericOrZero);

# RewardDistributorV2
event BucketBpsUpdated(uint16[4] oldBps, uint16[4] newBps);

# CommunityGovernor
event ProposalTypeSet(uint256 indexed proposalId, ProposalType proposalType);
```

Los indexadores externos deben monitorear y mostrar el histórico de parámetros para transparencia.

---

**Siguiente →** [Referencia de contratos](../08-contracts-reference/)
