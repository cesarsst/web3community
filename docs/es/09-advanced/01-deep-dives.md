# Deep dives

**Audiencia:** auditores y devs que necesitan entender decisiones arquitectónicas específicas en profundidad.
**Requisitos previos:** lectura de las secciones 01–08.

Esta página agrega decisiones de diseño no obvias que atraviesan múltiples contratos.

> **Nota — remodel 2026-07-08**: los deep dives sobre burn/emisión (BurnTracker, splits del FeeRouter V1, incentivo al burn) documentan el razonamiento del modelo **anterior**. Se mantienen porque explican por qué el diseño llegó a donde llegó — incluida la falla (bypass del router) que motivó el remodel.

## Anti-flashloan en dos dimensiones

Dos dimensiones del protocolo están protegidas contra manipulación por préstamo relámpago:

### 1. Voto

`GovernanceToken` hereda `ERC20Votes`. El voting power se lee vía `getPastVotes(account, snapshotBlock)`. Cuando se crea una propuesta, el Governor graba `snapshotBlock = block.number + votingDelay`. Toda llamada `castVote` consulta `getPastVotes` **en ese** bloque.

El flash-loan toma y devuelve en el mismo bloque. Por lo tanto: la posición del atacante en el bloque del snapshot es cero (o anterior al préstamo).

### 2. Peso de stake

`RewardDistributor._calculateClaim` usa `Staking.getWeightAt(user, projectId, snapshotBlock)`, donde `snapshotBlock = roundData[round].snapshotBlock` (grabado en `finalizeRound`).

Flash-stake en el bloque del finalize no entra — el peso se lee **después** del push en el `Checkpoints.Trace208`. El atacante tendría que mantener posición por al menos un bloque antes, cosa que un flash-loan no permite.

Detalles de implementación: `Checkpoints.Trace208` usa `uint48` para `block.number` (cabe en ~8920 años a 1s/bloque) y `uint208` para valor (peso máximo teórico 100M×4=4e26, muy por debajo de 2^208).

## Burn atómico con `BURNER_ROLE`

### Alternativas consideradas

**(a) Event listener off-chain**: las apps queman CREDIT directo y el indexer escucha `Transfer(to=0)` para imputar burn a proyecto.

Rechazada porque:
- Depende de indexer confiable.
- No hay prueba criptográfica on-chain de "qué proyecto consumió".
- La ventana entre burn y record crea race conditions.

**(b) La app registra burn sin quemar**: confía en la app.

Rechazada porque: double-spend trivial (la app registraría burn sin consumir CREDIT, inflando rewards sin deflación).

**(c) Atomic on-chain vía `BURNER_ROLE`**: app → `BurnTracker.burnAndRecord` → `CREDIT.burnByRole` sin allowance. **Adoptada.**

### Por qué sin allowance

Exigir allowance rompería UX:

1. Usuario `approve(burnTracker, amount)` — tx 1.
2. La app llama a `burnAndRecord(projectId, from, amount)` — tx 2.

Dos txs. Ventana de front-run entre approve y burn. El usuario firmaría dos cosas en secuencia.

Con `burnByRole`:

1. Usuario `approve(feeRouter, amount)` + `feeRouter.pay(projectId, user, amount)` — 2 txs pero la primera es una única allowance reutilizable.
2. `FeeRouter.pay` internamente acciona `BurnTracker.burnAndRecord`, que llama a `CREDIT.burnByRole` sin exigir otra allowance.

Mitigación del riesgo: `BURNER_ROLE` solo se concede vía propuesta aprobada en el Governor + Timelock. Revocable en cualquier momento.

## Probation doble

Dos nociones distintas coexisten en el `ProjectRegistry`:

| Dimensión | Probation inicial por tiempo | Probation punitiva |
|---|---|---|
| Dónde vive | `isInProbation(projectId)` view | `Project.status == Probation` |
| Cuándo aplica | Automático post-activación por `probationDuration` | La gobernanza mueve manualmente |
| `isActive(projectId)` retorna | `true` (el proyecto está Active) | `false` |
| `isInProbation(projectId)` retorna | `true` | `false` (es estrictamente "Active dentro de la ventana") |
| ¿Acepta stake nuevo? | sí | no |
| ¿Acepta pago? | sí | no |
| ¿Acepta burn? | sí | no |
| ¿Bypass lock en unstake? | no | no (solo `Removed` bypassea) |
| Share de reward | 25% (penalty /4) | cero (porque `isActive = false` → share = 0) |

La penalty de 25% se aplica en el RewardDistributor usando `REGISTRY.isInProbation(projectId)` en el momento del claim. No se aplica a la punitiva (que ya está bloqueada por `isActive = false` en stake/pay).

## Split 95/0/5 — por qué 0 de treasury

Decisión de diseño: el default **no** captura porción para el Treasury. Razones:

- **Preservar incentivo al burn.** Cada centavo dirigido al Treasury es un centavo menos quemado. El modelo deflacionario depende del burn máximo posible.
- **El Treasury tiene otras fuentes.** Genesis mint (10M CREDIT), slash de proyectos removidos, buyback futuro, porción explícita en proyectos específicos vía `setProjectSplit`.
- **Evitar doble captura.** Si el default ya diera 5% al Treasury, las propuestas de override tendrían que "poner a cero" para dar algo a la app — UX peor que el inverso.

Si en el futuro la DAO quiere capturar directo, basta con `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})`. No exige cambio de contrato.

## Dust handling en el split

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- captura residuo
```

El residuo de redondeo va a `toApp`. En splits con división no exacta, la app puede recibir 1-2 wei más que el calculado nominal. Aceptable y auditable vía evento `Paid`.

Alternativas:

- **Redondear cada parcela separadamente**: se pierden wei. La suma final puede ser `amount - 3 wei`.
- **Exigir que el split sea divisor exacto de `amount`**: inviable en general.

La elección actual preserva `burned + toTreasury + toApp == amount` siempre.

## Floor decay — 24 entradas inmutables

`floorSchedule` es `uint256[24] memory` en el constructor del `RewardDistributor`. Tamaño fijo:

- **Fuerza al caller a pasar 24 valores** (array dinámico exigiría check adicional).
- **Inmutable post-deploy**: ninguna función de write expone cambio.

En producción, decaimiento lineal:

```
floor[R] = 400_000e18 - R * (400_000/24 * 1e18)
```

Ajustado para valores con 1e18 precisión:

- `floor[0]  = 400_000.000000000000000000`
- `floor[1]  = 383_333.333333333333333334`  (+ dust redondeo)
- ...
- `floor[23] = 16_666.666666666666666682`

La suma es ~5.2M CREDIT — bien por debajo del genesis de 10M. No es presupuesto cerrado, es safety net.

## CEI + ReentrancyGuard — patrón doble

Todos los contratos que mueven valor siguen:

1. **CEI** — Checks, Effects, Interactions. Effects antes de `safeTransfer` / `safeTransferFrom`.
2. **`ReentrancyGuard`** en todas las funciones state-changing que mueven tokens.

El guard es defensa en profundidad:

- Si el token es ERC-20 conocido (GOV, CREDIT), CEI solo sería suficiente (sin callbacks).
- Si el token es arbitrario (Treasury recibe cualquier ERC-20), puede tener hooks (ERC-777 legacy, o tokens maliciosos custom). El guard blinda.
- Incluso con tokens "seguros", el guard evita regresiones futuras que introduzcan callbacks.

Costo: ~2k gas por llamada en el camino feliz. Aceptable en operaciones que cuestan 100k+.

## Checkpoints globales en el Staking

El `Staking` mantiene **tres** rieles paralelos de peso:

```
_userWeight[user][projectId]   — por usuario-proyecto
_projectWeight[projectId]       — agregado por proyecto
_globalWeightCheckpoints        — agregado global
```

Cada escritura actualiza los 3 en O(1):

```solidity
uint256 newProjectWeight = oldProjectWeight - oldUserWeight + newUserWeight;
uint256 newGlobalWeight  = oldGlobalWeight  - oldUserWeight + newUserWeight;
```

Invariante: `globalWeight == SUM(projectWeight[i])` siempre.

Motivación: `RewardDistributor` en el camino bootstrap necesita `projectWeight / globalWeight`. Sin agregado global O(1), sería necesario iterar sobre N proyectos en cada finalize — inviable en gas.

## `finalizeRound` permissionless

Cualquiera puede llamar. Orden secuencial: `round == lastFinalizedRound + 1` (o 0 si es el primero).

Por qué permissionless:

- Destrabar claim no necesita gobernanza — es acción puramente mecánica.
- Gas pagado por el llamador (~200k gas).
- Cualquier staker tiene incentivo: si no finaliza, no claim.

La secuencialidad fuerza que rondas anteriores sean procesadas antes. Impide "saltar" una ronda con parámetros indeseables (alpha/capMax) — si quieres skip, sería vía propuesta cambiando parámetros antes del finalize específico.

## Genesis one-shot

`CreditToken.mintGenesis` tiene flag `genesisMinted` que impide re-ejecución. ¿Por qué no usar `Ownable` + `renounceOwnership`?

- AccessControl es más flexible (múltiples roles).
- El genesis es una **única** acuñación con regla específica. Separarla del `mint` operacional (role-based) es más claro.
- El flag es barato (~20k gas por check tras deploy).

## Separación MINTER vs DEFAULT_ADMIN en el CreditToken

- `DEFAULT_ADMIN_ROLE` puede llamar a `mintGenesis` (una vez) y `grantRole`/`revokeRole`.
- `MINTER_ROLE` puede llamar a `mint` (operacional, sin flag one-shot).

Si `DEFAULT_ADMIN` también tuviera `MINTER_ROLE`, el admin podría acuñar en cualquier momento. Separando, el admin solo acuña el genesis; la inflación operacional queda aislada en el contrato económico (`RewardDistributor`).

## El camino de bootstrap si nadie tiene GOV

Problema canónico de DAO ERC20Votes + Timelock:

1. Para cambiar el estado, hace falta propuesta.
2. Para proponer, hace falta GOV delegado por encima del threshold.
3. Para tener GOV, alguien necesita haber minteado.
4. Pero mintear ya es cambio de estado.

Solución: el deploy atribuye ownership al deployer (temporal). El deployer llama a `mint` inicial y `transferOwnership(timelock)`. El Timelock se vuelve `pendingOwner`. **La primera propuesta aprobada en mainnet debe ser `acceptOwnership()` por el Timelock** — consolida la transferencia.

Ventana crítica: entre deploy y acceptOwnership, el deployer puede re-mintear libremente. Mitigación: el deployer es multi-sig auditable, primera propuesta priorizada, renuncia planeada.

Documentado en [Mainnet deployment](02-mainnet-deployment.md).

---

**Siguiente →** [Mainnet deployment](02-mainnet-deployment.md)
