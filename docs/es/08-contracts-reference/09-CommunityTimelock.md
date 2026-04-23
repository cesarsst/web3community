# CommunityTimelock

**Audiencia:** quien necesita auditar la capa ejecutora de la gobernanza.
**Requisitos previos:** [Governance (concepto)](../02-core-concepts/05-governance.md).

## Visión rápida

Wrapper identitario sobre `TimelockController` de OpenZeppelin 5.0.2. Ejecuta, con delay, todas las decisiones aprobadas por el `CommunityGovernor`. En producción es el único portador de `GOVERNANCE_ROLE` / `DEFAULT_ADMIN_ROLE` en los contratos económicos (Treasury, Registry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy) y es `owner` del GovernanceToken.

Sin código adicional — hereda `TimelockController` entero. Razón: mantener identidad on-chain (nombre "CommunityTimelock" en Etherscan) sin introducir superficie extra.

## Herencia

```
TimelockController (OZ 5.0.2)
  - AccessControl
  - IERC721Receiver (para receber NFTs via transfer)
  - IERC1155Receiver (idem)
```

## Parámetros (vía constructor, heredado)

```solidity
constructor(
    uint256 minDelay,
    address[] memory proposers,
    address[] memory executors,
    address admin
)
```

### Valores en producción

| Parámetro | Valor | Razón |
|---|---|---|
| `minDelay` | `172800` (2 días) | Ventana de reacción a propuesta maliciosa |
| `proposers` | `[]` | El Governor se concede vía `grantRole` en el deploy |
| `executors` | `[address(0)]` | Cualquiera puede ejecutar tras el delay |
| `admin` | deployer (bootstrap), renunciado tras handoff | El Timelock pasa a ser self-administered |

## Roles (definidos en `TimelockController`)

| Role | En producción |
|---|---|
| `DEFAULT_ADMIN_ROLE` | **Self** (el Timelock es admin de sí mismo) |
| `PROPOSER_ROLE` | `CommunityGovernor` |
| `CANCELLER_ROLE` | `CommunityGovernor` |
| `EXECUTOR_ROLE` | `address(0)` — cualquier dirección ejecuta |

## Funciones externas (heredadas de TimelockController)

### Propuesta → agendamiento

#### `schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)`

Agenda operación única. Requiere `PROPOSER_ROLE`.

#### `scheduleBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt, uint256 delay)`

Batch.

### Ejecución

#### `execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt)`

Ejecuta operación única tras `minDelay`. Requiere `EXECUTOR_ROLE` — en producción es `address(0)`, entonces cualquiera llama.

#### `executeBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt)`

Batch.

### Cancelamiento

#### `cancel(bytes32 id)`

Cancela operación pending. Requiere `CANCELLER_ROLE`.

### Views

- `getMinDelay() → uint256`.
- `hashOperation(target, value, data, predecessor, salt) → bytes32`.
- `hashOperationBatch(...) → bytes32`.
- `isOperation(id) → bool`.
- `isOperationPending(id) → bool`.
- `isOperationReady(id) → bool` — pasó del delay.
- `isOperationDone(id) → bool`.
- `getTimestamp(id) → uint256` — timestamp en que se vuelve ready.

### Admin

#### `updateDelay(uint256 newDelay)`

Ajusta `minDelay`. Solo puede ser llamado por `this` (auto-governance) — requiere propuesta aprobada.

- **Eventos**: `MinDelayChange(oldDuration, newDuration)`.

## Eventos (heredados)

- `CallScheduled(id, index, target, value, data, predecessor, delay)`.
- `CallExecuted(id, index, target, value, data)`.
- `CallSalt(id, salt)`.
- `Cancelled(id)`.
- `MinDelayChange(oldDuration, newDuration)`.

## Invariantes

- **Self-administered post-handoff**: `DEFAULT_ADMIN_ROLE` es del propio Timelock. El cambio de role exige propuesta aprobada.
- **Proposer = Governor**: único autorizado para `schedule`.
- **Executor abierto**: cualquier dirección ejecuta tras el delay (el delay ya es el gate de seguridad).
- **Canceller = Governor**: solo vía `_cancel` en propuesta contraria. Sin guardian unilateral en v1.
- **El Timelock no puede ser "bypass"**: todas las funciones state-changing de los contratos económicos exigen `GOVERNANCE_ROLE`, que es exclusivo del Timelock.

## Observaciones importantes

### Por qué `address(0)` como executor

Los parámetros y targets de la operación ya son inmutables tras `schedule`. El delay ya expiró cuando alguien llama a `execute`. Exigir `EXECUTOR_ROLE` dedicado solo agregaría fricción operacional — se necesitaría siempre tener un executor EOA activo. Cualquier parte puede hacer clic en "execute" sin alterar el resultado.

### `CANCELLER_ROLE` solo con el Governor

`GovernorTimelockControl._cancel` llama a `Timelock.cancel` al cancelar propuesta vía gobernanza. No concedemos `CANCELLER_ROLE` a nadie más (ni multisig guardian) — un cancelador externo podría hacer DoS de propuestas válidas, violando "el voto es la fuente de verdad".

### Inmutabilidad práctica

A pesar de que el Timelock es `self-administered`, no hay "upgrade" del contrato en sí. Si la DAO necesita Timelock v2, debe:

1. Deployar nuevo Timelock.
2. Proponer vía v1: grant `GOVERNANCE_ROLE` (nuevo) y revoke (v1) en todos los contratos económicos.
3. Similar para el GovernanceToken `transferOwnership`.
4. Proponer en el Governor v1 para cambiar la referencia `timelock` (si el Governor lo soporta) o deployar Governor nuevo.

Ese camino es complejo y exige múltiples propuestas — intencional.

### Estrategia de deploy recomendada

1. Deploy Timelock con `proposers = []`, `executors = [0x0]`, `admin = deployer`.
2. Deploy Governor apuntando al Timelock.
3. Deployer: `grantRole(PROPOSER_ROLE, governor)` + `grantRole(CANCELLER_ROLE, governor)`.
4. Deployer: `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`. El Timelock queda self-administered.

Documentado en [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

### Sin `PAUSE`

No existe botón de pausa unilateral. Si es necesario parar alguna operación, la DAO aprueba una propuesta específica — por ejemplo, `Registry.setProbation` para suspender un proyecto malicioso.

---

**Ver también**: [CommunityGovernor](10-CommunityGovernor.md).
