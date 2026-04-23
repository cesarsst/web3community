# Parámetros ajustables por la DAO

**Audiencia:** quien quiera saber exactamente lo que puede cambiar la DAO y cuáles son los rangos permitidos.
**Requisitos previos:** [Ciclo de una propuesta](01-proposal-lifecycle.md).

Esta página lista **todos** los parámetros ajustables vía gobernanza, el valor en producción, el bound on-chain y qué función se usa para alterarlo.

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

| Función | Qué hace | Bound on-chain |
|---|---|---|
| `transfer(token, to, amount)` | Envía ERC-20 | `balance suficiente` |
| `batchTransfer(token, recipients[], amounts[])` | Batch de transfers | arrays válidos, saldo total suficiente |
| `payRebates(token, apps[], amounts[], round)` | Batch con evento semántico | idem |
| `executeBuyback(stable, amountIn, minGovOut, swapData)` | Stub v1 — solo emite evento | `stable != 0, amountIn > 0, minGovOut > 0` |
| `sweepETH(to, amount)` | Retira ETH | `balance suficiente` |

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
| `setAlpha(new)` | Ajusta alpha | `[MIN_ALPHA=0.5e18, MAX_ALPHA=1.1e18]` | `0.95e18` |
| `setCapMax(new)` | Ajusta techo por ronda | `[MIN_CAPMAX=1e18, MAX_CAPMAX=100M*1e18]` | `5M CREDIT` |
| `grantRole(GOVERNANCE_ROLE, addr)` | idem | — | — |

`floorSchedule` es **inmutable** tras el deploy.

### FeeRouter

| Función | Qué hace | Bound on-chain | Valor en producción |
|---|---|---|---|
| `setDefaultSplit(split)` | Split global default | `burnBps + treasuryBps + rebateBps == 10.000` | `(9500, 0, 500)` |
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
| `MIN_ALPHA`, `MAX_ALPHA` | `RewardDistributor` | `0.5e18`, `1.1e18` |
| `MIN_CAPMAX`, `MAX_CAPMAX` | `RewardDistributor` | `1e18`, `100M*1e18` |
| `FLOOR_SCHEDULE_LENGTH` | `RewardDistributor` | 24 |
| `PROBATION_PENALTY_DENOM` | `RewardDistributor` | 4 (25%) |
| `floorSchedule` (valores) | `RewardDistributor` | grabados en el deploy |
| `_BPS_DENOMINATOR` | `FeeRouter` | 10.000 |
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
- El valor nuevo `0.90e18` está dentro de `[MIN_ALPHA=0.5e18, MAX_ALPHA=1.1e18]`. Si está fuera, la ejecución revierte (incluso con el voto aprobado).

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
```

Los indexadores externos deben monitorear y mostrar el histórico de parámetros para transparencia.

---

**Siguiente →** [Referencia de contratos](../08-contracts-reference/)
