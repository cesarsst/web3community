# Staking

**Para quem é:** devs lendo peso de stakers, auditores, usuários curiosos.
**Pré-requisitos:** [Directed staking](../02-core-concepts/02-directed-staking.md).

## Visão rápida

Cofre de stake direcionado por projeto. Usuário lockeia GOV em um `projectId` específico do `ProjectRegistry` e recebe `weight = amount * multiplier(lockDuration) / 1e18`. Peso alimenta share de rewards no `RewardDistributor`.

Lock mínimo 14 dias, máximo aceito ilimitado (multiplier satura em 4x a partir de 365 dias). Stake novo só em projetos `Active`. Unstake bypassa lock se projeto virou `Removed`.

## Herança

```
ReentrancyGuard (OZ)
```

Usa `SafeERC20`, `Checkpoints.Trace208`, `SafeCast`.

## Parâmetros e storage

| Nome | Tipo | Valor | Descrição |
|---|---|---|---|
| `MIN_LOCK` | `uint256` constant | `14 days` | Lock mínimo |
| `MAX_LOCK` | `uint256` constant | `365 days` | Saturação do multiplier |
| `MULTIPLIER_PRECISION` | `uint256` constant | `1e18` | Precisão FP |
| `MAX_MULTIPLIER` | `uint256` constant | `4e18` | 4x |
| `GOV_TOKEN` | `IERC20` immutable | GOV | Token stakado |
| `REGISTRY` | `ProjectRegistry` immutable | Registry | Para gating |
| `positions` | mapping | `user → projectId → StakePosition` | Posições |
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

## Roles e permissões

**Sem roles.** Staking não é privilegiado — toda função é lógica de negócio (ownership da posição, status do projeto, expiração do lock). Não usa `AccessControl`.

## Funções externas

### State-changing

#### `stake(uint256 projectId, uint256 amount, uint64 lockDuration)`

Abre ou consolida posição. Se já existe posição: `newAmount = old + amount`, `newLockDuration = max(remaining, lockDuration)`, `lockStartAt = now` (**reset**).

- **Reverte**: `ZeroAmount`, `LockTooShort`, `ProjectNotActive`, erros do ERC-20.
- **Eventos**: `Staked(user, projectId, amount, lockDuration, lockStartAt, weight)`.
- **ReentrancyGuard**: sim.

#### `increaseStake(uint256 projectId, uint256 amount)`

Aumenta `amount` **preservando** `lockStartAt` e `lockDuration`.

- **Reverte**: `ZeroAmount`, `PositionNotFound`, `ProjectNotActive`.
- **Eventos**: `StakeIncreased(user, projectId, amountAdded, newAmount, newWeight)`.

#### `extendLock(uint256 projectId, uint64 newLockDuration)`

Estende `lockDuration`. Sempre estritamente maior que o atual.

- **Reverte**: `PositionNotFound`, `CannotShortenLock`.
- **Eventos**: `LockExtended(user, projectId, newLockDuration, newWeight)`.

#### `unstake(uint256 projectId, uint256 amount)`

Remove `amount`. Se `projectRemoved`, bypassa lock; caso contrário exige lock expirado.

- **Reverte**: `ZeroAmount`, `PositionNotFound`, `InsufficientStake`, `LockNotExpired`.
- **Eventos**: `Unstaked(user, projectId, amount, remaining, newWeight)` + (se bypass) `EarlyUnstakeAllowed(user, projectId, amount)`.

#### `unstakeAll(uint256 projectId)`

Atalho para `unstake` com `amount = position.amount`.

- **Eventos**: idem `unstake`.

### Views

- `getPosition(user, projectId) → StakePosition`.
- `getWeight(user, projectId) → uint256`.
- `getTotalWeight(projectId) → uint256`.
- `getWeightAt(user, projectId, blockNumber) → uint256` — snapshot.
- `getTotalWeightAt(projectId, blockNumber) → uint256` — snapshot.
- `getGlobalWeight() → uint256`.
- `getGlobalWeightAt(blockNumber) → uint256`.
- `getLockEnd(user, projectId) → uint64` — timestamp expiração.
- `isUnlocked(user, projectId) → bool`.
- `multiplier(lockDuration) → uint256` — pure, calcula multiplier.

## Eventos

| Evento | Emitido em | Parâmetros indexados |
|---|---|---|
| `Staked(user, projectId, amount, lockDuration, lockStartAt, weight)` | `stake` | `user`, `projectId` |
| `StakeIncreased(user, projectId, amountAdded, newAmount, newWeight)` | `increaseStake` | `user`, `projectId` |
| `LockExtended(user, projectId, newLockDuration, newWeight)` | `extendLock` | `user`, `projectId` |
| `Unstaked(user, projectId, amount, remaining, newWeight)` | `unstake`/`unstakeAll` | `user`, `projectId` |
| `EarlyUnstakeAllowed(user, projectId, amount)` | `unstake` com bypass (projeto Removed) | `user`, `projectId` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Construtor com endereço zero |
| `ZeroAmount()` | `amount == 0` |
| `ProjectNotActive(projectId)` | Status ≠ Active em stake/increase |
| `LockTooShort(provided, minimum)` | `lockDuration < 14 days` |
| `LockNotExpired(unlockAt, nowTs)` | Tentativa de unstake antes do fim do lock, projeto não-Removed |
| `CannotShortenLock(current, provided)` | `newLockDuration <= lockDuration` em extend |
| `PositionNotFound(user, projectId)` | Posição inexistente |
| `InsufficientStake(requested, available)` | `amount > position.amount` |

## Invariantes

- **I5 (Anti-flashloan de peso)**: `getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` via `Checkpoints.Trace208`, consultáveis em `blockNumber < block.number`. `RewardDistributor` usa no `snapshotBlock` da rodada.
- **I6 (Lock mínimo)**: `MIN_LOCK = 14 days`, enforçado em stake e extend.
- **Conservação**: `totalStaked == SUM(totalStakedByProject[i])` sempre. `globalWeight == SUM(projectWeight[i])` sempre.
- **Bypass só por `Removed`**: probation (inicial ou punitiva) **não** bypassa lock.
- **CEI + ReentrancyGuard**: effects antes de `safeTransfer`, guard ativo em todas as funções que movem GOV.

## Observações importantes

### Três trilhos de checkpoint

O contrato mantém **três** tracks de peso — por usuário-projeto, por projeto, global. O agregado por projeto é atualizado em O(1) em cada update via diff `newUserWeight - oldUserWeight`. Global idem. Evita iteração sobre N stakers.

### Multiplier formula

```
multiplier(d) = 1e18                                   se d == 14d
multiplier(d) = 1e18 + (d-14d) * (4e18-1e18)/(365d-14d) se 14d < d < 365d
multiplier(d) = 4e18                                   se d >= 365d
```

Pure, sem storage.

### Locks > `MAX_LOCK`

São aceitos literalmente. O multiplier satura em 4x mas o tempo real é respeitado. Ou seja, você pode stakar com `lockDuration = 2 anos` — recebe peso 4x × amount, mas não pode unstake antes dos 2 anos.

### Consolidação `stake` resetando `lockStartAt`

Intencional. Impede que micro-stakes prolonguem peso indefinidamente sem re-commit do amount antigo. Se você quer aumentar amount sem resetar lock, use `increaseStake`.

### Chave `uint48` do Checkpoints

Tick = `block.number` cabe em `uint48` por ~8920 anos em 1s block time. Valor = peso cabe em `uint208` com folga (peso máximo teórico: 100M GOV × 4x = 4e26, bem abaixo de 2^208 ~ 4.11e62).

---

**Ver também**: [RewardDistributor](07-RewardDistributor.md), [ProjectRegistry](03-ProjectRegistry.md).
