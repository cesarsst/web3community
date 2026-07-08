# LiquidityGauge

> ⚠️ **LEGADO** — substituído pelo remodel 2026-07-08 (ver [CreditPSM](15-CreditPSM.md), [FeeRouterV2](08b-FeeRouterV2.md) e [ProjectFunding](16-ProjectFunding.md)). Mantido deployado por compatibilidade histórica.

**Para quem é:** LPs do par CREDIT/USDC, devs integrando UI de stake LP, auditores.
**Pré-requisitos:** [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md), [Distribuição de rewards](../02-core-concepts/04-rewards-distribution.md).

## Visão rápida

Adapter sobre o `UniswapV3Staker` canônico (Uniswap Foundation, mainnet `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`) que distribui o **bucket LPs** (default 25%) da emissão de CREDIT por rodada para LPs externos do par CREDIT/USDC. Implementa a Fase 1.3 do pivot Credit Liquidity Protocol (CLP).

Fluxo do usuário:

1. Usuário tem um NFT V3 (posição concentrada em pool whitelistada).
2. Chama `stake(tokenId, poolId)` — NFT vai para o staker e começa a acumular rewards in-range.
3. Quando quiser sair, chama `unstake(tokenId)` — NFT volta, rewards entram em **vesting linear de 14 dias**.
4. `harvest(user, maxAmount)` saca a fração já vestida.
5. `emergencyUnstake(tokenId)` (sempre permitido, mesmo paused) devolve o NFT mas **descarta rewards do ciclo atual** — fail-safe.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
Pausable (OZ)
IERC721Receiver
```

Usa `SafeERC20`.

## Parâmetros e storage

### Constants

| Nome | Valor |
|---|---|
| `VESTING_DURATION_MIN` | `1 days` |
| `VESTING_DURATION_MAX` | `90 days` |
| `INCENTIVE_DURATION_MIN` | `1 hours` |

### Immutables (constructor)

- `CREDIT_TOKEN` — endereço do CREDIT (rewardToken).
- `UNISWAP_V3_STAKER` — staker canônico Uniswap V3.
- `POSITION_MANAGER` — NPM canônico Uniswap V3 (`0xC36442b4a4522E871399CD717aBDD847Ab11FE88` em mainnet).

### Storage

| Nome | Tipo | Descrição |
|---|---|---|
| `vestingDuration` | `uint32` | Default `14 days`. Mutável dentro de `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]` |
| `poolCount` | `uint256` | Número de pools whitelistadas (1-based) |
| `pools[poolId]` | `PoolConfig` | Config por pool |
| `poolIdByAddress[pool]` | `uint256` | Lookup reverso (`0` = não whitelistada) |
| `stakes[tokenId]` | `Stake` | Estado do NFT staked |
| `totalVestingLocked` | `uint256` | Total de CREDIT reservado para `VestingPosition`s ainda não sacadas. Segrega o saldo: essa parcela pertence aos usuários e NÃO pode ser drenada via `governanceRescueRewards` |
| `denylisted[account]` | `bool` | Anti self-dealing (D.9) |

### Struct `PoolConfig`

```solidity
struct PoolConfig {
    address pool;                  // IUniswapV3Pool
    bool enabled;                  // false desabilita novos stakes
    bytes32 currentIncentiveHash;  // bytes32(0) = sem incentive ativa
}
```

### Struct `Stake`

```solidity
struct Stake {
    address owner;          // real owner do NFT
    uint256 poolId;         // pool whitelistada
    bytes32 incentiveHash;  // incentive em que o NFT está staked
    uint64 stakedAt;        // timestamp UNIX (seg)
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

## Roles e permissões

| Role | Em produção | Poder |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | conceder/revogar roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | whitelist, denylist, pause, vesting params, rescue |
| `REWARD_NOTIFIER_ROLE` | `Treasury` + `RewardDistributorV2` | criar incentives via `notifyRewardAmount` (plural por design — D.7) |

## Funções externas

### Governance (`GOVERNANCE_ROLE`)

#### `addPool(address pool) → uint256 poolId`

Adiciona uma pool à whitelist. Pool começa `enabled = true` mas SEM incentive ativa (precisa de `notifyRewardAmount` antes do primeiro stake).

- **Reverte**: `ZeroAddress`, `InvalidPool(0)` (já whitelistada).
- **Eventos**: `PoolAdded(poolId, pool)`.

#### `setPoolEnabled(uint256 poolId, bool enabled)`

Habilita/desabilita pool. NÃO afeta stakes existentes — eles continuam vestindo na incentive em que foram staked. Apenas `stake` novo é bloqueado.

- **Reverte**: `InvalidPool(poolId)`.
- **Eventos**: `PoolEnabledSet(poolId, enabled)`.

#### `setVestingDuration(uint32 newDuration)`

Atualiza vesting linear aplicado a NOVAS `VestingPosition`s. Não retroativo.

- **Reverte**: `InvalidVestingDuration(requested)` se fora de `[VESTING_DURATION_MIN, VESTING_DURATION_MAX]`.
- **Eventos**: `VestingDurationSet(oldDuration, newDuration)`.

#### `setDenylist(address account, bool denied)`

Marca/desmarca endereço como denylisted. Denylisted não podem chamar `stake` — bootstrap deve denylistar Treasury, Staking, RewardDistributor, FeeRouter (anti self-dealing — D.9).

- **Reverte**: `ZeroAddress`.
- **Eventos**: `DenylistSet(account, denied)`.

#### `pause()` / `unpause()`

Pausa entrada de novos stakes. `unstake`/`harvest` continuam operacionais; `emergencyUnstake` sempre operacional. IE10-friendly.

#### `endIncentive(uint256 poolId) → uint256 refund`

Encerra incentive ATUAL da pool (precisa estar expirada) e resgata refund para o gauge.

- **Reverte**: `InvalidPool`, `NoActiveIncentive`, `IncentiveNotExpired`.
- **Eventos**: `IncentiveEnded(poolId, incentiveHash, refund)`.

#### `governanceRescueRewards(address to, uint256 amount)`

Resgata CREDIT órfão no gauge (refunds de incentives encerradas, forfeits de `emergencyUnstake`). **Segregação on-chain**: o resgate NUNCA pode consumir CREDIT que lastreia `VestingPosition`s não sacadas (`totalVestingLocked`) — apenas o excedente (`getUnreservedBalance()`). `amount == type(uint256).max` transfere todo o saldo **não-reservado**.

- **Reverte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance(requested, available)`, `RescueExceedsUnreserved(available, requested)`.
- **Eventos**: `RewardsRescued(to, amount)`.

### Reward notification (`REWARD_NOTIFIER_ROLE`)

#### `notifyRewardAmount(uint256 poolId, uint256 amount, uint32 duration) → bytes32 incentiveHash`

Cria nova incentive no staker canônico. Caller transfere `amount` CREDIT (via allowance prévio) — gauge repassa para o staker. Incentive começa AGORA, termina em `block.timestamp + duration`.

Modelo simplificado: 1 incentive ativa por pool por vez. Reverte com `IncentiveOverlap` se já há incentive não-expirada.

- **Reverte**: `ZeroAmount`, `InvalidIncentiveDuration` (`< INCENTIVE_DURATION_MIN`), `InvalidPool`, `IncentiveOverlap`.
- **Eventos**: `RewardNotified(poolId, incentiveHash, amount, startTime, endTime)`.

### Usuário (público)

#### `stake(uint256 tokenId, uint256 poolId)`

Deposita o NFT no gauge e auto-stakeia na incentive ativa. NFT precisa estar `approve`-d para o gauge.

- **Reverte**: `Denylisted`, `InvalidPool`, `PoolDisabled`, `NoActiveIncentive`.
- **Eventos**: `Staked(user, tokenId, poolId, incentiveHash)`.
- **`whenNotPaused`**: sim. **`nonReentrant`**: sim.

#### `unstake(uint256 tokenId)`

Desfaz o stake, devolve NFT ao owner, cria `VestingPosition` com vesting linear. Se não havia rewards (in-range time = 0), apenas devolve o NFT.

- **Reverte**: `StakeNotFound`, `NotStakeOwner`.
- **Eventos**: `Unstaked(user, tokenId, rewardAmount)`.
- **NÃO `whenNotPaused`** — usuário sempre pode sair (IE10).

#### `emergencyUnstake(uint256 tokenId)`

Saída emergencial — devolve NFT ao owner. Rewards pendentes no staker (do ciclo atual) são DESCARTADOS. Vesting in-flight (positions prévias) NÃO é afetado.

Funciona MESMO PAUSADO (fail-safe IE10).

- **Reverte**: `StakeNotFound`, `NotStakeOwner`.
- **Eventos**: `EmergencyUnstaked(user, tokenId, forfeitedRewards)`.

#### `harvest(address user, uint256 maxAmount) → uint256 claimed`

Saca CREDIT já vestido. Compacta positions totalmente claimadas (anti-bloat). `maxAmount = type(uint256).max` saca tudo.

- **Reverte**: `ZeroAddress`.
- **Eventos**: `Harvested(user, amount)`.
- Caller pode harvestar para outrem.

### Views

- `vestedAmount(address user) → (uint256 vested, uint256 claimable)` — soma sobre todas as positions.
- `vestingCountOf(address user) → uint256`.
- `vestingAt(address user, uint256 index) → VestingPosition`.
- `getUnreservedBalance() → uint256` — `max(balanceOf(gauge) - totalVestingLocked, 0)`. Única parcela elegível para `governanceRescueRewards`.
- `incentiveByHash(bytes32) → IUniswapV3Staker.IncentiveKey` — útil off-chain.
- `pendingRewardsAtStaker() → uint256` — saldo agregado do gauge no staker.

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

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Endereço zero |
| `ZeroAmount()` | Valor zero |
| `InvalidPool(poolId)` | Pool não whitelistada ou já registrada |
| `PoolDisabled(poolId)` | Pool whitelistada mas `enabled == false` |
| `NoActiveIncentive(poolId)` | `currentIncentiveHash == bytes32(0)` |
| `Denylisted(account)` | Caller na denylist |
| `StakeNotFound(tokenId)` | NFT não gerenciado |
| `NotStakeOwner(tokenId, expected, actual)` | Caller não é owner |
| `InvalidVestingDuration(requested)` | Fora do range |
| `InvalidIncentiveDuration(requested)` | `< INCENTIVE_DURATION_MIN` |
| `IncentiveNotExpired(hash, endsAt)` | `endIncentive` antes do `endTime` |
| `IncentiveOverlap(poolId, currentHash)` | `notifyRewardAmount` com incentive ativa |
| `InsufficientBalance(requested, available)` | Rescue excede saldo total do gauge |
| `RescueExceedsUnreserved(available, requested)` | Rescue excede o saldo **não-reservado** (`balance - totalVestingLocked`) — protege vesting on-chain |

## Invariantes

- **IE6 (liquidez DEX)**: gauge fortalece IE6 incentivando liquidez incremental além do POL.
- **IE10 (não pausar usuário)**: `pause` bloqueia ENTRADA, não SAÍDA. `emergencyUnstake` é fail-safe sempre operacional.
- **D.4 vesting linear 14d**: `harvest` parcial. Saída antes do fim do vesting NÃO penaliza positions já criadas — vesting acumula independente do NFT estar staked.
- **D.9 anti self-dealing**: Treasury não pode stakear (denylisted no bootstrap).
- **Segregação on-chain de vesting**: `totalVestingLocked` (soma de `totalAmount - claimedAmount` das positions vivas) é intocável por `governanceRescueRewards` — o rescue só alcança `getUnreservedBalance()`. `unstake` incrementa a reserva (via `_createVestingPosition`), `harvest` decrementa pelo sacado; `emergencyUnstake` NÃO mexe (forfeit vira saldo não-reservado, positions prévias preservadas).

## Observações importantes

### Vesting acumula independente do stake

Após `unstake`, o usuário NÃO precisa manter o NFT staked para continuar vestindo. Razão: rewards já foram "ganhos" no staker oficial; segurá-los na position postergaria valor sem propósito econômico.

### Múltiplas positions por usuário

Cada `unstake` cria uma nova `VestingPosition`. Usuário pode ter várias simultâneas. `harvest` itera todas e compacta as exauridas via swap-and-pop.

### Staker oficial Uniswap, não custódia própria

O gauge é **adapter** sobre o `UniswapV3Staker` canônico — não reinventa custódia de NFT, não duplica lógica de `secondsInsideX128`. Toda a contabilidade in-range é do staker oficial. O gauge apenas:

1. Mantém ledger interno do real owner.
2. Repassa NFT via `safeTransferFrom` com `IncentiveKey` no calldata (staker faz auto-stake on receive).
3. Aplica vesting linear de 14d ao reward sacado.
4. Mantém whitelist/denylist e pause local.

### Integração com RewardDistributorV2

Cada `finalizeRound` do `RewardDistributorV2` faz mint de `lpsAmount` (default 25% da emissão), aprova o gauge e chama `notifyRewardAmount(gaugePoolId, lpsAmount, gaugeIncentiveDuration)`. Cria uma incentive nova de `gaugeIncentiveDuration` segundos (default 7 dias).

Quando o gauge está paused, `RewardDistributorV2` faz fallback para `Treasury.depositPendingGaugeRewards` — sem fallback, pause do gauge travaria `finalizeRound` da rodada inteira.

### Endereços canônicos Uniswap V3

- **Mainnet staker**: `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`.
- **Mainnet NPM**: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`.
- **Pool seed CREDIT/USDC**: fee tier 0.3% (`3000`) — D.1.

---

**Ver também**: [Treasury](04-Treasury.md), [RewardDistributorV2](07b-RewardDistributorV2.md), [CreditToken](02-CreditToken.md).
