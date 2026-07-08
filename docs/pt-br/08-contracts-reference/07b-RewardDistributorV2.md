# RewardDistributorV2

> ⚠️ **LEGADO** — substituído pelo remodel 2026-07-08 (ver [CreditPSM](15-CreditPSM.md), [FeeRouterV2](08b-FeeRouterV2.md) e [ProjectFunding](16-ProjectFunding.md)). Mantido deployado por compatibilidade histórica.

**Para quem é:** stakers consultando claim, owners de apps, LPs, auditores, devs integrando UIs.
**Pré-requisitos:** [RewardDistributor (V1)](07-RewardDistributor.md), [Distribuição de rewards](../02-core-concepts/04-rewards-distribution.md).

## Visão rápida

Distributor **bucket-aware** da Fase 1.4 do pivot Credit Liquidity Protocol (CLP). Reescreve a lógica de emissão para suportar split entre **4 buckets** em cada `finalizeRound`:

- **Stakers** (default 55%): pull-based via `claim`/`claimMany`. Mantém mecânica V1 (`projectShare × stakeShare`).
- **LPs** (default 25%): push direto para `LiquidityGauge` via `notifyRewardAmount`. Quando gauge paused, fallback para `Treasury.depositPendingGaugeRewards`.
- **Apps** (default 15%): push retrospectivo (burn-based). `appShare(p) = appsAmount × burn_{R-1}(p) / totalBurnPrev`. Mintado direto para `ProjectRegistry.ownerRecipient(p)`.
- **Bonders** (default 5%): push para `Treasury.depositPolRefill` (refill earmarkado do POL na Fase 1; reciclado para `BondDepository` na Fase 3).

V2 é **deploy paralelo** ao V1. V1 fica em modo claim-only durante a janela de migração de 4 rounds — governance revoga `MINTER_ROLE` no CREDIT do V1 após o cutoff.

A fórmula de emissão TOTAL é idêntica ao V1 (`min(max(alpha × burn, floor), capMax)`); o split em buckets é aplicado APÓS o cap (IE3 fortalecida — nenhum bucket excede `bucketBps[i] × capMax`).

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parâmetros e storage

### Constants — bucket layout

| Nome | Valor |
|---|---|
| `BUCKET_STAKERS` | `0` |
| `BUCKET_LPS` | `1` |
| `BUCKET_APPS` | `2` |
| `BUCKET_BONDERS` | `3` |
| `BPS_DENOMINATOR` | `10_000` |
| `MIN_BUCKET_STAKERS_BPS` | `3000` (30%) |
| `MIN_BUCKET_LPS_BPS` | `500` (5%) |
| `MAX_BUCKET_APPS_BPS` | `2500` (25%, IE4b) |
| `MAX_BUCKET_BONDERS_BPS` | `2000` (20%) |
| `SPLIT_TOLERANCE_WEI` | `3` |

### Constants — econ params (replicadas do V1)

| Nome | Valor |
|---|---|
| `PRECISION` | `1e18` |
| `MIN_ALPHA` | `5e17` (0.5) |
| `MAX_ALPHA` | `99e16` (0.99 — IE1) |
| `MIN_CAPMAX` | `1e18` |
| `MAX_CAPMAX` | `100_000_000e18` |
| `FLOOR_SCHEDULE_LENGTH` | `24` |
| `PROBATION_PENALTY_DENOM` | `4` |

### Dependências (immutable)

- `CREDIT` — CreditToken.
- `STAKING` — Staking.
- `BURN_TRACKER` — BurnTracker.
- `REGISTRY` — ProjectRegistry (consultado para `ownerRecipient` e probation).
- `GAUGE` — LiquidityGauge (`ILiquidityGaugeRewards`).
- `TREASURY` — Treasury (`ITreasuryRewards`, slim interface).

### Storage — bucket params

| Nome | Tipo | Descrição |
|---|---|---|
| `bucketBps[4]` | `uint16[4]` | Default `[5500, 2500, 1500, 500]`. Soma exata 10000 |
| `gaugePoolId` | `uint256` | Pool destino no gauge. Default `1` (CREDIT/USDC 0.3%) |
| `gaugeIncentiveDuration` | `uint32` | Default `7 days`. Bounds `[1h, 90d]` |

### Storage — emissão (replicada do V1)

| Nome | Tipo | Descrição |
|---|---|---|
| `alpha` | `uint256` | Default `0.95e18` |
| `capMax` | `uint256` | Default `5M × 1e18` em produção |
| `floorSchedule` | `uint256[24]` | Imutável pós-constructor |

### Storage — round state

| Nome | Tipo | Descrição |
|---|---|---|
| `lastFinalizedRound` | `uint256` | — |
| `isFirstRoundFinalized` | `bool` | Distingue "round 0 finalizado" de "nenhum finalizado" |
| `roundData[round]` | `RoundData` | Snapshot imutável |
| `bucketEmissionByRound[round][bucket]` | `uint256` | Audit trail por bucket |
| `claimed[round][projectId][user]` | `bool` | Anti double-claim |

### Struct `RoundData`

```solidity
struct RoundData {
    uint256 totalEmission;
    uint256 totalBurnAtFinalize;
    uint64 snapshotBlock;
    bool finalized;
}
```

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

`finalizeRound` e `claim`/`claimMany` são **permissionless**.

## Funções externas

### `finalizeRound(uint256 round)`

Permissionless. Aplica fórmula V1 antes do split, distribui:

1. **Checks**: sequencial, round closed, not finalized.
2. **Compute**: `totalEmission = min(max(alpha × burn_{R-1}, floor(R)), capMax)`.
3. **Split** em 4 valores via `bucketBps`. Bucket bonders recebe o **resíduo** da divisão inteira (proteção IE12 contra perda de 1-2 wei).
4. **Effects**: grava `roundData[round]` + `bucketEmissionByRound`.
5. **Interactions**:
   - **Apps**: loop em projetos com burn no round R-1, mint direto para `ownerRecipient(p)`.
   - **LPs**: mint para self, approve gauge, `notifyRewardAmount` (ou fallback Treasury se paused).
   - **Bonders**: mint para Treasury, `depositPolRefill`.
   - **Stakers**: NÃO mint aqui (lazy via `claim`).
6. **Assert IE12**: soma agendada/cunhada == totalEmission (tolerância 3 wei).

**Caso especial bootstrap (`totalBurnPrev == 0`)**: bucket apps NÃO emite — bonders absorve o residual. Sem burn não há sinal econômico para distribuir entre apps.

- **Reverte**: `RoundAlreadyFinalized`, `OutOfOrderFinalize(expected, provided)`, `RoundNotClosed(round)`, `EmissionMismatch(totalEmission, sumBuckets)`.
- **Eventos**: `RoundFinalizedV2(round, totalEmission, stakersAmount, lpsAmount, appsAmount, bondersAmount)` + N × `BucketEmissionMinted` + opcional `GaugePauseFallback`.

### `claim(uint256 round, uint256 projectId) → uint256 amount`

Reivindica reward de stakers. Mint lazy. Apenas o bucket stakers é processado aqui — buckets LPs/apps/bonders já foram empurrados em `finalizeRound`.

Mantém semântica V1: marca `claimed`, calcula via `projectShare × stakeShare`, mint via `CREDIT.mint`. Diferença: `projectShare` agora usa `bucketEmissionByRound[round][BUCKET_STAKERS]` como base, não `totalEmission`.

- **Reverte**: `RoundNotFinalized`, `AlreadyClaimed`.
- **Eventos**: `Claimed(user, round, projectId, amount)` se `amount > 0`.
- **ReentrancyGuard**: sim.

### `claimMany(uint256[] rounds, uint256[] projectIds) → uint256 total`

Batch.

- **Reverte**: `ArrayLengthMismatch`, `EmptyBatch`, `AlreadyClaimed`.

### Governance setters

#### `setBucketBps(uint16[4] newBps)`

Atualiza split. Não retroativo.

Bounds individuais (E.8):
- `stakers >= 30%` (preserva sinal econômico para Fase 2 gauge controller).
- `LPs >= 5%` (IE6 — liquidez incentivada).
- `apps <= 25%` (IE4b — anti auto-extração via wash burn).
- `bonders <= 20%` (Olympus mostrou que > 20% destrava ponzi).
- Soma exata 10000.

- **Reverte**: `BucketBpsOutOfBounds(bucket, provided, min, max)`, `BucketBpsSumInvalid(sum)`.
- **Eventos**: `BucketBpsUpdated(oldBps, newBps)`.

#### `setAlpha(uint256 newAlpha)` / `setCapMax(uint256 newCap)`

Idêntico ao V1. Bounds `[MIN_ALPHA, MAX_ALPHA]` / `[MIN_CAPMAX, MAX_CAPMAX]`.

#### `setGaugePoolId(uint256 newPoolId)` / `setGaugeIncentiveDuration(uint32 newDuration)`

Configura destino do bucket LPs. `gaugeIncentiveDuration` bounds `[1h, 90d]`.

### Views

- `previewClaim(user, round, projectId) → uint256` — preview do bucket stakers.
- `previewEmission(forRound) → uint256` — emissão TOTAL (antes do split).
- `getEmission(round) → uint256` — `roundData[round].totalEmission`.
- `getBucketEmission(round, bucket) → uint256` — valor agendado por bucket.
- `getProjectStakerEmission(round, projectId) → uint256` — share do projeto NO BUCKET STAKERS (com probation penalty).
- `isFinalized(round) → bool`.
- `getBucketBps() → uint16[4]` — split atual.

## Eventos

| Evento | Indexados |
|---|---|
| `RoundFinalizedV2(round, totalEmission, stakers, lps, apps, bonders)` | `round` |
| `BucketEmissionMinted(round, bucket, recipient, amount)` | `round`, `bucket`, `recipient` |
| `GaugePauseFallback(round, amount)` | `round` |
| `Claimed(user, round, projectId, amount)` | `user`, `round`, `projectId` |
| `BucketBpsUpdated(oldBps, newBps)` | — |
| `AlphaUpdated(oldAlpha, newAlpha)` | — |
| `CapMaxUpdated(oldCap, newCap)` | — |
| `GaugePoolIdUpdated(old, new)` | — |
| `GaugeIncentiveDurationUpdated(old, new)` | — |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Endereço zero no constructor |
| `RoundNotClosed(round)` | `BurnTracker.currentRound() <= round` |
| `RoundAlreadyFinalized(round)` | Segundo finalize |
| `RoundNotFinalized(round)` | claim sem finalize |
| `OutOfOrderFinalize(expected, provided)` | Pulou rodada |
| `AlreadyClaimed(round, projectId, user)` | Re-claim |
| `ArrayLengthMismatch()` / `EmptyBatch()` | `claimMany` malformado |
| `InvalidAlpha(provided, min, max)` | alpha fora do bound |
| `InvalidCapMax(provided, min, max)` | cap fora do bound |
| `BucketBpsSumInvalid(sum)` | Soma != 10000 |
| `BucketBpsOutOfBounds(bucket, provided, min, max)` | Bucket fora dos bounds individuais |
| `EmissionMismatch(totalEmission, sumBuckets)` | IE12 violada (assert defensivo) |
| `InvalidGaugeIncentiveDuration(requested)` | Fora de `[1h, 90d]` |

## Invariantes

- **IE1** alpha < 1: `MAX_ALPHA = 0.99e18`.
- **IE2** Floor temporário: `floorSchedule[24]` replicado do V1.
- **IE3 (fortalecida)**: cap aplicado ANTES do split — nenhum bucket excede `bucketBps[i] × capMax`.
- **IE4b (codificada)**: `bucketBps[apps] <= 2500`. Anti auto-extração via wash burn.
- **IE12 (criada)**: soma dos 4 buckets == `totalEmission` com tolerância de 3 wei. Validada em `finalizeRound` via assert.
- **I5**: snapshot anti-flashloan — `snapshotBlock` único por round, todos os buckets usam o mesmo.

## Observações importantes

### Por que stakers é lazy mas LPs/apps/bonders são push?

- **Stakers**: número de stakers pode ser milhares. Push iteraria todos — gas explosion. Pull (claim) delega o custo para quem se beneficia.
- **LPs**: 1 chamada (`notifyRewardAmount`) cria incentive no gauge — gauge faz a contabilidade in-range para todos os LPs. Push é O(1).
- **Apps**: loop em `1..totalProjects`. Limitado pela frequência de propostas DAO (esperado < 1000 projetos). Mint direto para `ownerRecipient`. Push é O(N projetos com burn).
- **Bonders**: 1 chamada (`depositPolRefill`) — Treasury é o "bucket". Push é O(1).

### Apps recebe via burn retrospectivo, não por gauge weights

A Fase 1 não tem gauge controller (vem na Fase 2). Por enquanto, o sinal econômico para distribuir entre apps é o **burn da rodada anterior** — o mesmo sinal que o V1 usava para stakers. Razão: burn já é uma medida real de uso do app, sem necessidade de votação adicional.

Apps que querem capturar esse bucket precisam:

1. Estar listados no Registry (`isActive`).
2. Gerar burn (= ter usuários pagando).
3. Ter `ownerRecipient(projectId)` setado (ou usar fallback `project.owner`). Setting explícito requer **timelock 48h** no Registry — vide `proposeOwnerRecipient` / `applyOwnerRecipient`.

### Recipient do bucket apps com timelock 48h

Para evitar que owner do projeto faça hot-swap do recipient entre `finalizeRound` e indexação off-chain (red flag E.3 #1 do parecer), o `ownerRecipient` no Registry tem **timelock de 48h**:

1. `proposeOwnerRecipient(projectId, newRecipient)` — só owner.
2. Aguarda `OWNER_RECIPIENT_TIMELOCK = 48h`.
3. `applyOwnerRecipient(projectId)` — permissionless após `effectiveAt`.

Se `ownerRecipient(projectId)` retorna `address(0)` (Removed/inexistente), share evapora — diferença cai sob tolerância IE12.

### Fallback gauge paused

Se `gauge.paused() == true` no momento de `finalizeRound`, o V2:

1. Mint `lpsAmount` para Treasury (não para self).
2. Chama `Treasury.depositPendingGaugeRewards(lpsAmount)` — accumula em ledger contábil.
3. Emite `GaugePauseFallback(round, amount)`.

Sem fallback, pause do gauge travaria `finalizeRound` da rodada inteira (red flag E.3 #2). Após despausar, governance chama `Treasury.flushPendingGaugeRewards(duration)`.

### Migration window — V1 vs V2

Durante a janela de migração (4 rounds):

- **V1** continua executando `claim`/`claimMany` para rewards de rounds antigos. `finalizeRound` ainda funciona (mas governance vai parar de chamar e migrar para V2).
- **V2** começa a finalizar novos rounds com bucket-aware split.
- Ambos têm `MINTER_ROLE` no CREDIT durante a janela.
- Após o cutoff (4 rounds), governance **revoga `MINTER_ROLE` do V1**. V1 vira read-only.

Stakers que não claimaram seus rewards V1 podem fazer isso a qualquer momento — V1 continua respondendo a `claim`, só não emite mais CREDIT (revogação do MINTER_ROLE bloqueia o `mint`). Isso é **intencional**: rewards V1 só são acessíveis na janela de migração.

### Exemplo numérico de split

Com `totalEmission = 902_500 CREDIT` (ex.: alpha 0.95 × burn 950k) e split default `[5500, 2500, 1500, 500]`:

| Bucket | bps | Amount |
|---|---|---|
| Stakers | 5500 | 496_375 CREDIT |
| LPs | 2500 | 225_625 CREDIT |
| Apps | 1500 | 135_375 CREDIT |
| Bonders | 500 | 45_125 CREDIT |
| **Total** | **10000** | **902_500** |

Apps de 135_375 são repartidos proporcionalmente entre projetos com burn:

```
appShare(projeto X) = 135_375 × burn_{R-1}(X) / totalBurnPrev
```

Stakers de 496_375 alimentam `_projectShare` no claim, que aplica `projectShare × stakeShare` como o V1.

---

**Ver também**: [RewardDistributor (V1)](07-RewardDistributor.md), [Treasury](04-Treasury.md), [LiquidityGauge](13-LiquidityGauge.md), [ProjectRegistry](03-ProjectRegistry.md).
