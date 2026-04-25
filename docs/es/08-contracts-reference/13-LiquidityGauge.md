# LiquidityGauge

**Para quién es:** LPs del par CREDIT/USDC, devs integrando UI de stake LP, auditores.
**Prerrequisitos:** [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md), [Distribución de rewards](../02-core-concepts/04-rewards-distribution.md).

## Vista rápida

Adapter sobre el `UniswapV3Staker` canónico (Uniswap Foundation, mainnet `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`) que distribuye el **bucket LPs** (default 25%) de la emisión de CREDIT por ronda a LPs externos del par CREDIT/USDC. Implementa la Fase 1.3 del pivote Credit Liquidity Protocol (CLP).

Flujo del usuario:

1. Usuario tiene un NFT V3 (posición concentrada en pool whitelisteada).
2. Llama `stake(tokenId, poolId)` — el NFT va al staker y empieza a acumular rewards in-range.
3. Cuando quiera salir, llama `unstake(tokenId)` — el NFT vuelve, los rewards entran en **vesting lineal de 14 días**.
4. `harvest(user, maxAmount)` retira la fracción ya vested.
5. `emergencyUnstake(tokenId)` (siempre permitido, incluso paused) devuelve el NFT pero **descarta los rewards del ciclo actual** — fail-safe.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
Pausable (OZ)
IERC721Receiver
```

Usa `SafeERC20`.

## Parámetros y storage

### Constants

| Nombre | Valor |
|---|---|
| `VESTING_DURATION_MIN` | `1 days` |
| `VESTING_DURATION_MAX` | `90 days` |
| `INCENTIVE_DURATION_MIN` | `1 hours` |

### Immutables (constructor)

- `CREDIT_TOKEN` — dirección del CREDIT (rewardToken).
- `UNISWAP_V3_STAKER` — staker canónico Uniswap V3.
- `POSITION_MANAGER` — NPM canónico Uniswap V3 (`0xC36442b4a4522E871399CD717aBDD847Ab11FE88` en mainnet).

### Storage

| Nombre | Tipo | Descripción |
|---|---|---|
| `vestingDuration` | `uint32` | Default `14 days`. Mutable dentro de `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]` |
| `poolCount` | `uint256` | Número de pools whitelisteadas (1-based) |
| `pools[poolId]` | `PoolConfig` | Config por pool |
| `poolIdByAddress[pool]` | `uint256` | Lookup inverso (`0` = no whitelisteada) |
| `stakes[tokenId]` | `Stake` | Estado del NFT staked |
| `denylisted[account]` | `bool` | Anti self-dealing (D.9) |

### Struct `PoolConfig`

```solidity
struct PoolConfig {
    address pool;                  // IUniswapV3Pool
    bool enabled;                  // false deshabilita stakes nuevos
    bytes32 currentIncentiveHash;  // bytes32(0) = sin incentive activa
}
```

### Struct `Stake`

```solidity
struct Stake {
    address owner;          // owner real del NFT
    uint256 poolId;         // pool whitelisteada
    bytes32 incentiveHash;  // incentive en la que el NFT está staked
    uint64 stakedAt;        // timestamp UNIX (s)
}
```

### Struct `VestingPosition`

```solidity
struct VestingPosition {
    uint256 totalAmount;
    uint256 claimedAmount;
    uint64 startedAt;
    uint64 endsAt;
}
```

## Roles y permisos

| Role | En producción | Poder |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | conceder/revocar roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | whitelist, denylist, pause, vesting params, rescue |
| `REWARD_NOTIFIER_ROLE` | `Treasury` + `RewardDistributorV2` | crear incentives vía `notifyRewardAmount` (plural por diseño — D.7) |

## Funciones externas

### Governance (`GOVERNANCE_ROLE`)

#### `addPool(address pool) -> uint256 poolId`

Agrega una pool a la whitelist. Pool empieza `enabled = true` pero SIN incentive activa (requiere `notifyRewardAmount` antes del primer stake).

- **Revierte**: `ZeroAddress`, `InvalidPool(0)` (ya whitelisteada).
- **Eventos**: `PoolAdded(poolId, pool)`.

#### `setPoolEnabled(uint256 poolId, bool enabled)`

Habilita/deshabilita pool. NO afecta stakes existentes — siguen vesting en la incentive en la que fueron staked. Sólo `stake` nuevo es bloqueado.

- **Revierte**: `InvalidPool(poolId)`.
- **Eventos**: `PoolEnabledSet(poolId, enabled)`.

#### `setVestingDuration(uint32 newDuration)`

Actualiza el vesting lineal aplicado a NUEVAS `VestingPosition`s. No retroactivo.

- **Revierte**: `InvalidVestingDuration(requested)` si fuera de `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]`.
- **Eventos**: `VestingDurationSet(oldDuration, newDuration)`.

#### `setDenylist(address account, bool denied)`

Marca/desmarca dirección como denylisted. Direcciones denylisted no pueden llamar `stake` — bootstrap debe denylistar Treasury, Staking, RewardDistributor, FeeRouter (anti self-dealing — D.9).

- **Revierte**: `ZeroAddress`.
- **Eventos**: `DenylistSet(account, denied)`.

#### `pause()` / `unpause()`

Pausa entrada de stakes nuevos. `unstake`/`harvest` siguen operacionales; `emergencyUnstake` siempre operacional. IE10-friendly.

#### `endIncentive(uint256 poolId) -> uint256 refund`

Termina la incentive ACTUAL de la pool (debe estar expirada) y rescata refund al gauge.

- **Revierte**: `InvalidPool`, `NoActiveIncentive`, `IncentiveNotExpired`.
- **Eventos**: `IncentiveEnded(poolId, incentiveHash, refund)`.

#### `governanceRescueRewards(address to, uint256 amount)`

Rescata CREDIT huérfano en el gauge (refunds de incentives terminadas, forfeits de `emergencyUnstake`). `amount == type(uint256).max` transfiere todo el balance.

- **Revierte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`.
- **Eventos**: `RewardsRescued(to, amount)`.

### Reward notification (`REWARD_NOTIFIER_ROLE`)

#### `notifyRewardAmount(uint256 poolId, uint256 amount, uint32 duration) -> bytes32 incentiveHash`

Crea nueva incentive en el staker canónico. El caller transfiere `amount` CREDIT (vía allowance previo) — el gauge la repasa al staker. La incentive empieza AHORA, termina en `block.timestamp + duration`.

Modelo simplificado: 1 incentive activa por pool a la vez. Revierte con `IncentiveOverlap` si ya hay incentive no expirada.

- **Revierte**: `ZeroAmount`, `InvalidIncentiveDuration` (`< INCENTIVE_DURATION_MIN`), `InvalidPool`, `IncentiveOverlap`.
- **Eventos**: `RewardNotified(poolId, incentiveHash, amount, startTime, endTime)`.

### Usuario (público)

#### `stake(uint256 tokenId, uint256 poolId)`

Deposita el NFT en el gauge y auto-stakea en la incentive activa. El NFT debe estar `approve`-do al gauge.

- **Revierte**: `Denylisted`, `InvalidPool`, `PoolDisabled`, `NoActiveIncentive`.
- **Eventos**: `Staked(user, tokenId, poolId, incentiveHash)`.
- **`whenNotPaused`**: sí. **`nonReentrant`**: sí.

#### `unstake(uint256 tokenId)`

Deshace el stake, devuelve el NFT al owner, crea `VestingPosition` con vesting lineal. Si no había rewards (in-range time = 0), sólo devuelve el NFT.

- **Revierte**: `StakeNotFound`, `NotStakeOwner`.
- **Eventos**: `Unstaked(user, tokenId, rewardAmount)`.
- **NO `whenNotPaused`** — el usuario siempre puede salir (IE10).

#### `emergencyUnstake(uint256 tokenId)`

Salida emergencial — devuelve el NFT al owner. Rewards pendientes en el staker (del ciclo actual) son DESCARTADOS. Vesting in-flight (positions previas) NO se ve afectado.

Funciona INCLUSO PAUSED (fail-safe IE10).

- **Revierte**: `StakeNotFound`, `NotStakeOwner`.
- **Eventos**: `EmergencyUnstaked(user, tokenId, forfeitedRewards)`.

#### `harvest(address user, uint256 maxAmount) -> uint256 claimed`

Retira CREDIT ya vested. Compacta positions totalmente claimadas (anti-bloat). `maxAmount = type(uint256).max` retira todo.

- **Revierte**: `ZeroAddress`.
- **Eventos**: `Harvested(user, amount)`.
- El caller puede harvestar para otra persona.

### Views

- `vestedAmount(address user) -> (uint256 vested, uint256 claimable)` — suma sobre todas las positions.
- `vestingCountOf(address user) -> uint256`.
- `vestingAt(address user, uint256 index) -> VestingPosition`.
- `incentiveByHash(bytes32) -> IUniswapV3Staker.IncentiveKey` — útil off-chain.
- `pendingRewardsAtStaker() -> uint256` — balance agregado del gauge en el staker.

## Eventos

| Evento | Indexados |
|---|---|
| `PoolAdded(poolId, pool)` | `poolId`, `pool` |
| `PoolEnabledSet(poolId, enabled)` | `poolId` |
| `RewardNotified(poolId, incentiveHash, amount, startTime, endTime)` | `poolId`, `incentiveHash` |
| `IncentiveEnded(poolId, incentiveHash, refund)` | `poolId`, `incentiveHash` |
| `Staked(user, tokenId, poolId, incentiveHash)` | `user`, `tokenId`, `poolId` |
| `Unstaked(user, tokenId, rewardAmount)` | `user`, `tokenId` |
| `EmergencyUnstaked(user, tokenId, forfeitedRewards)` | `user`, `tokenId` |
| `Harvested(user, amount)` | `user` |
| `VestingDurationSet(old, new)` | — |
| `DenylistSet(account, denied)` | `account` |
| `RewardsRescued(to, amount)` | `to` |

## Errores customizados

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | Dirección cero |
| `ZeroAmount()` | Valor cero |
| `InvalidPool(poolId)` | Pool no whitelisteada o ya registrada |
| `PoolDisabled(poolId)` | Pool whitelisteada pero `enabled == false` |
| `NoActiveIncentive(poolId)` | `currentIncentiveHash == bytes32(0)` |
| `Denylisted(account)` | Caller en denylist |
| `StakeNotFound(tokenId)` | NFT no gestionado |
| `NotStakeOwner(tokenId, expected, actual)` | Caller no es owner |
| `InvalidVestingDuration(requested)` | Fuera del rango |
| `InvalidIncentiveDuration(requested)` | `< INCENTIVE_DURATION_MIN` |
| `IncentiveNotExpired(hash, endsAt)` | `endIncentive` antes del `endTime` |
| `IncentiveOverlap(poolId, currentHash)` | `notifyRewardAmount` con incentive activa |
| `InsufficientBalance(requested, available)` | Rescue excede balance |

## Invariantes

- **IE6 (liquidez DEX)**: el gauge fortalece IE6 incentivando liquidez incremental más allá del POL.
- **IE10 (no pausar usuario)**: `pause` bloquea ENTRADA, no SALIDA. `emergencyUnstake` es fail-safe siempre operacional.
- **D.4 vesting lineal 14d**: `harvest` parcial. Salida antes del fin del vesting NO penaliza positions ya creadas — el vesting acumula independiente de que el NFT esté staked.
- **D.9 anti self-dealing**: el Treasury no puede stakear (denylisted en bootstrap).

## Notas importantes

### El vesting acumula independiente del stake

Tras `unstake`, el usuario NO necesita mantener el NFT staked para seguir vesting. Razón: los rewards ya fueron "ganados" en el staker oficial; mantenerlos en la position diferiría valor sin propósito económico.

### Múltiples positions por usuario

Cada `unstake` crea una nueva `VestingPosition`. El usuario puede tener varias simultáneas. `harvest` itera todas y compacta las exhaustas vía swap-and-pop.

### Staker oficial Uniswap, no custodia propia

El gauge es **adapter** sobre el `UniswapV3Staker` canónico — no reinventa custodia de NFT, no duplica lógica de `secondsInsideX128`. Toda la contabilidad in-range pertenece al staker oficial. El gauge sólo:

1. Mantiene el ledger interno del owner real.
2. Repasa el NFT vía `safeTransferFrom` con `IncentiveKey` en el calldata (el staker auto-stakea on receive).
3. Aplica vesting lineal de 14d al reward retirado.
4. Mantiene whitelist/denylist y pause locales.

### Integración con RewardDistributorV2

Cada `RewardDistributorV2.finalizeRound` mintea `lpsAmount` (default 25% de la emisión), aprueba el gauge y llama `notifyRewardAmount(gaugePoolId, lpsAmount, gaugeIncentiveDuration)`. Crea una incentive nueva de `gaugeIncentiveDuration` segundos (default 7 días).

Cuando el gauge está paused, `RewardDistributorV2` cae a `Treasury.depositPendingGaugeRewards` — sin ese fallback, pausar el gauge trabaría `finalizeRound` de toda la ronda.

### Direcciones canónicas Uniswap V3

- **Mainnet staker**: `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`.
- **Mainnet NPM**: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`.
- **Pool seed CREDIT/USDC**: fee tier 0.3% (`3000`) — D.1.

---

**Ver también**: [Treasury](04-Treasury.md), [RewardDistributorV2](07b-RewardDistributorV2.md), [CreditToken](02-CreditToken.md).
