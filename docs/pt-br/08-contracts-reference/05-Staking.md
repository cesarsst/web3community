# Staking

**Para quem é:** devs/auditores.

Contrato: `contracts/Staking.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Cofre de stake de GOV **direcionado por projeto**. O usuário lockeia GOV em um `projectId` do [ProjectRegistry](04-ProjectRegistry.md) e recebe `weight` proporcional ao amount e à duração do lock.

No modelo vigente o peso cumpre dois papéis:

- **Gate de investimento:** [ProjectFunding](07-ProjectFunding.md) exige `getWeight(investor, projectId) > 0` para investir e para sacar rev-share — só quem tem GOV em stake no projeto participa da captação e da redistribuição.
- **Curadoria:** o peso agregado por projeto (`getTotalWeight` / `getTotalWeightAt`, com checkpoints por bloco) é um sinal on-chain de convicção da comunidade em cada projeto.

Sem `AccessControl`: nenhuma função é privilegiada por role — o gating é lógica de negócio (ownership da posição, status do projeto, expiração do lock).

Herança: `ReentrancyGuard`. Usa `SafeERC20`, `Checkpoints.Trace208`, `SafeCast`.

## Interface pública

### Constantes

| Nome | Valor | Descrição |
|---|---|---|
| `MIN_LOCK` | `14 days` | Lock mínimo. Abaixo reverte `LockTooShort`. |
| `MAX_LOCK` | `365 days` | Duração em que o multiplicador satura. |
| `MULTIPLIER_PRECISION` | `1e18` | `1e18` = 1,0x. |
| `MAX_MULTIPLIER` | `4e18` | Multiplicador máximo (4x) em `MAX_LOCK`. |

Curva do multiplicador: linear de **1x (14d) a 4x (365d)**; locks acima de `MAX_LOCK` são aceitos (multiplicador satura em 4x, mas o tempo real de lock é respeitado no unstake). Peso = `amount * multiplier(lockDuration)`.

### Tipo / storage

```solidity
struct StakePosition {
    uint256 amount;       // GOV lockado (0 = posição inexistente)
    uint64  lockStartAt;  // início do lock atual
    uint64  lockDuration; // duração absoluta desde lockStartAt
}
```

| Nome | Tipo | Descrição |
|---|---|---|
| `GOV_TOKEN` | `IERC20 immutable` | Token GOV lockado. |
| `REGISTRY` | `ProjectRegistry immutable` | Consultado p/ `isActive` (stake) e status `Removed` (bypass de lock). |
| `positions` | `mapping(address => mapping(uint256 => StakePosition)) public` | Posição por (user, projectId). |
| `totalStakedByProject` | `mapping(uint256 => uint256) public` | Soma de `amount` por projeto. |
| `totalStaked` | `uint256 public` | Total global lockado. |

### Constructor

```solidity
constructor(address govToken_, address registry_)   // reverte ZeroAddress
```

### Views

```solidity
function getPosition(address user, uint256 projectId) external view returns (StakePosition memory)
function getWeight(address user, uint256 projectId) external view returns (uint256)     // 0 se sem posição
function getTotalWeight(uint256 projectId) external view returns (uint256)
function getWeightAt(address user, uint256 projectId, uint256 blockNumber) external view returns (uint256)
function getTotalWeightAt(uint256 projectId, uint256 blockNumber) external view returns (uint256)
function getGlobalWeight() external view returns (uint256)
function getGlobalWeightAt(uint256 blockNumber) external view returns (uint256)
function getLockEnd(address user, uint256 projectId) external view returns (uint64)     // 0 se sem posição
function isUnlocked(address user, uint256 projectId) external view returns (bool)
function multiplier(uint64 lockDuration) external pure returns (uint256)                // reverte LockTooShort < MIN_LOCK
```

As views `*At` usam `upperLookupRecent` (checkpoint com chave `<= blockNumber`) e só são confiáveis para `blockNumber < block.number`.

### Mutações (todas `nonReentrant`)

```solidity
function stake(uint256 projectId, uint256 amount, uint64 lockDuration) external
```
Abre ou **consolida** posição (Opção B): se já existe, `amount` soma, `lockDuration = max(remaining, novo)` e `lockStartAt` reseta para `now`. Exige projeto `Active`. Reverte `ZeroAmount`, `LockTooShort`, `ProjectNotActive`. Emite `Staked`.

```solidity
function increaseStake(uint256 projectId, uint256 amount) external
```
Aumenta `amount` **preservando** `lockStartAt`/`lockDuration` (não reabre lock expirado). Exige posição existente e projeto `Active`. Reverte `ZeroAmount`, `PositionNotFound`, `ProjectNotActive`. Emite `StakeIncreased`.

```solidity
function extendLock(uint256 projectId, uint64 newLockDuration) external
```
Estende a duração (nunca encurta), sem alterar `lockStartAt`. Reverte `PositionNotFound`, `CannotShortenLock` (novo `<=` atual). Emite `LockExtended`.

```solidity
function unstake(uint256 projectId, uint256 amount) external
function unstakeAll(uint256 projectId) external
```
Remove `amount` (ou tudo). Exige lock expirado **ou** projeto em `Removed` (bypass — a DAO removeu o projeto, não pune o staker). Probation não bypassa. Reverte `ZeroAmount`, `PositionNotFound`, `InsufficientStake`, `LockNotExpired`. Emite `Unstaked` (sempre) e `EarlyUnstakeAllowed` (se bypass por `Removed`).

## Eventos

`Staked(user, projectId, amount, lockDuration, lockStartAt, weight)`, `StakeIncreased(user, projectId, amount, newAmount, newWeight)`, `LockExtended(user, projectId, newLockDuration, newWeight)`, `Unstaked(...)`, `EarlyUnstakeAllowed(user, projectId, amount)`. Todos com `user` e `projectId` indexados.

## Erros

`ZeroAddress`, `ZeroAmount`, `ProjectNotActive(projectId)`, `LockTooShort(provided, minimum)`, `LockNotExpired(unlockAt, nowTs)`, `CannotShortenLock(current, provided)`, `PositionNotFound(user, projectId)`, `InsufficientStake(requested, available)`.

## Roles

Nenhuma. O contrato não é privilegiado na governança.

## Invariantes

- **I6 (lock mínimo 14d):** `stake`/`extendLock` reforçam `>= MIN_LOCK`; `unstake` reverte `LockNotExpired` enquanto o lock vige, exceto projeto `Removed`.
- **Unstake nunca preso por governança:** Probation/Removed bloqueiam stake novo, mas nunca bloqueiam unstake; `Removed` libera imediatamente (bypass do lock).
- **Consolidação (Opção B):** novo `stake` reseta `lockStartAt` sobre toda a posição, impedindo esticar peso via micro-stakes sem re-commitar o amount antigo.
- **Peso via snapshot:** `getWeightAt`/`getTotalWeightAt`/`getGlobalWeightAt` usam `Checkpoints.Trace208` (chave = `block.number`) — consumo por bloco ancorado é imune a flash-stake no bloco corrente.
- **Overflow:** peso máximo teórico por (user, projeto) = `100M * 1e18 * 4 = 4e26`, cabe em `uint208`. Chave cabe em `uint48`.
- **CEI + `nonReentrant`** em todas as funções que movem GOV.

## Ver também

[ProjectRegistry](04-ProjectRegistry.md) · [ProjectFunding](07-ProjectFunding.md) · [GovernanceToken](01-GovernanceToken.md)
