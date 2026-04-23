# Staking

**Audiencia:** devs leyendo peso de stakers, auditores, usuarios curiosos.
**Requisitos previos:** [Directed staking](../02-core-concepts/02-directed-staking.md).

## Visión rápida

Cofre de stake dirigido por proyecto. El usuario bloquea GOV en un `projectId` específico del `ProjectRegistry` y recibe `weight = amount * multiplier(lockDuration) / 1e18`. El peso alimenta el share de rewards en el `RewardDistributor`.

Lock mínimo 14 días, máximo aceptado ilimitado (el multiplier satura en 4x a partir de 365 días). Stake nuevo solo en proyectos `Active`. Unstake bypassea el lock si el proyecto pasó a `Removed`.

## Herencia

```
ReentrancyGuard (OZ)
```

Usa `SafeERC20`, `Checkpoints.Trace208`, `SafeCast`.

## Parámetros y storage

| Nombre | Tipo | Valor | Descripción |
|---|---|---|---|
| `MIN_LOCK` | `uint256` constant | `14 days` | Lock mínimo |
| `MAX_LOCK` | `uint256` constant | `365 days` | Saturación del multiplier |
| `MULTIPLIER_PRECISION` | `uint256` constant | `1e18` | Precisión FP |
| `MAX_MULTIPLIER` | `uint256` constant | `4e18` | 4x |
| `GOV_TOKEN` | `IERC20` immutable | GOV | Token stakeado |
| `REGISTRY` | `ProjectRegistry` immutable | Registry | Para gating |
| `positions` | mapping | `user → projectId → StakePosition` | Posiciones |
| `totalStakedByProject` | mapping | `projectId → uint256` | GOV agregado |
| `totalStaked` | `uint256` | — | Global |
| `_userWeight` | mapping | `user → projectId → Trace208` | Checkpoints |
| `_projectWeight` | mapping | `projectId → Trace208` | Checkpoints |
| `_globalWeightCheckpoints` | `Trace208` | — | Global |

### Struct `StakePosition`

```solidity
struct StakePosition {
    uint256 amount;
    uint64 lockStartAt;
    uint64 lockDuration;
}
```

## Roles y permisos

**Sin roles.** Staking no es privilegiado — toda función es lógica de negocio (ownership de la posición, status del proyecto, expiración del lock). No usa `AccessControl`.

## Funciones externas

### State-changing

#### `stake(uint256 projectId, uint256 amount, uint64 lockDuration)`

Abre o consolida posición. Si ya existe posición: `newAmount = old + amount`, `newLockDuration = max(remaining, lockDuration)`, `lockStartAt = now` (**reset**).

- **Revierte**: `ZeroAmount`, `LockTooShort`, `ProjectNotActive`, errores del ERC-20.
- **Eventos**: `Staked(user, projectId, amount, lockDuration, lockStartAt, weight)`.
- **ReentrancyGuard**: sí.

#### `increaseStake(uint256 projectId, uint256 amount)`

Aumenta `amount` **preservando** `lockStartAt` y `lockDuration`.

- **Revierte**: `ZeroAmount`, `PositionNotFound`, `ProjectNotActive`.
- **Eventos**: `StakeIncreased(user, projectId, amountAdded, newAmount, newWeight)`.

#### `extendLock(uint256 projectId, uint64 newLockDuration)`

Extiende `lockDuration`. Siempre estrictamente mayor que el actual.

- **Revierte**: `PositionNotFound`, `CannotShortenLock`.
- **Eventos**: `LockExtended(user, projectId, newLockDuration, newWeight)`.

#### `unstake(uint256 projectId, uint256 amount)`

Remueve `amount`. Si `projectRemoved`, bypassea lock; si no, exige lock expirado.

- **Revierte**: `ZeroAmount`, `PositionNotFound`, `InsufficientStake`, `LockNotExpired`.
- **Eventos**: `Unstaked(user, projectId, amount, remaining, newWeight)` + (si bypass) `EarlyUnstakeAllowed(user, projectId, amount)`.

#### `unstakeAll(uint256 projectId)`

Atajo para `unstake` con `amount = position.amount`.

- **Eventos**: idem `unstake`.

### Views

- `getPosition(user, projectId) → StakePosition`.
- `getWeight(user, projectId) → uint256`.
- `getTotalWeight(projectId) → uint256`.
- `getWeightAt(user, projectId, blockNumber) → uint256` — snapshot.
- `getTotalWeightAt(projectId, blockNumber) → uint256` — snapshot.
- `getGlobalWeight() → uint256`.
- `getGlobalWeightAt(blockNumber) → uint256`.
- `getLockEnd(user, projectId) → uint64` — timestamp expiración.
- `isUnlocked(user, projectId) → bool`.
- `multiplier(lockDuration) → uint256` — pure, calcula multiplier.

## Eventos

| Evento | Emitido en | Parámetros indexados |
|---|---|---|
| `Staked(user, projectId, amount, lockDuration, lockStartAt, weight)` | `stake` | `user`, `projectId` |
| `StakeIncreased(user, projectId, amountAdded, newAmount, newWeight)` | `increaseStake` | `user`, `projectId` |
| `LockExtended(user, projectId, newLockDuration, newWeight)` | `extendLock` | `user`, `projectId` |
| `Unstaked(user, projectId, amount, remaining, newWeight)` | `unstake`/`unstakeAll` | `user`, `projectId` |
| `EarlyUnstakeAllowed(user, projectId, amount)` | `unstake` con bypass (proyecto Removed) | `user`, `projectId` |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | Constructor con dirección cero |
| `ZeroAmount()` | `amount == 0` |
| `ProjectNotActive(projectId)` | Status ≠ Active en stake/increase |
| `LockTooShort(provided, minimum)` | `lockDuration < 14 days` |
| `LockNotExpired(unlockAt, nowTs)` | Intento de unstake antes del fin del lock, proyecto no-Removed |
| `CannotShortenLock(current, provided)` | `newLockDuration <= lockDuration` en extend |
| `PositionNotFound(user, projectId)` | Posición inexistente |
| `InsufficientStake(requested, available)` | `amount > position.amount` |

## Invariantes

- **I5 (Anti-flashloan de peso)**: `getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` vía `Checkpoints.Trace208`, consultables en `blockNumber < block.number`. `RewardDistributor` los usa en el `snapshotBlock` de la ronda.
- **I6 (Lock mínimo)**: `MIN_LOCK = 14 days`, enforceado en stake y extend.
- **Conservación**: `totalStaked == SUM(totalStakedByProject[i])` siempre. `globalWeight == SUM(projectWeight[i])` siempre.
- **Bypass solo por `Removed`**: probation (inicial o punitiva) **no** bypassea lock.
- **CEI + ReentrancyGuard**: effects antes de `safeTransfer`, guard activo en todas las funciones que mueven GOV.

## Observaciones importantes

### Tres rieles de checkpoint

El contrato mantiene **tres** tracks de peso — por usuario-proyecto, por proyecto, global. El agregado por proyecto es actualizado en O(1) en cada update vía diff `newUserWeight - oldUserWeight`. El global idem. Evita iteración sobre N stakers.

### Multiplier formula

```
multiplier(d) = 1e18                                   se d == 14d
multiplier(d) = 1e18 + (d-14d) * (4e18-1e18)/(365d-14d) se 14d < d < 365d
multiplier(d) = 4e18                                   se d >= 365d
```

Pure, sin storage.

### Locks > `MAX_LOCK`

Son aceptados literalmente. El multiplier satura en 4x pero el tiempo real se respeta. Es decir, puedes stakear con `lockDuration = 2 años` — recibes peso 4x × amount, pero no puedes unstakear antes de los 2 años.

### Consolidación `stake` reseteando `lockStartAt`

Intencional. Impide que micro-stakes prolonguen peso indefinidamente sin re-commit del amount antiguo. Si quieres aumentar amount sin resetear el lock, usa `increaseStake`.

### Clave `uint48` del Checkpoints

Tick = `block.number` cabe en `uint48` por ~8920 años en 1s block time. Valor = peso cabe en `uint208` con holgura (peso máximo teórico: 100M GOV × 4x = 4e26, bien por debajo de 2^208 ~ 4.11e62).

---

**Ver también**: [RewardDistributor](07-RewardDistributor.md), [ProjectRegistry](03-ProjectRegistry.md).
