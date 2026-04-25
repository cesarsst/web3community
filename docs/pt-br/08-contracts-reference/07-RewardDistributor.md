# RewardDistributor (V1)

**Para quem é:** stakers consultando preview de rewards V1 ainda não claimados, auditores, devs integrando UIs de reward.
**Pré-requisitos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Rewards distribution](../02-core-concepts/04-rewards-distribution.md), [RewardDistributorV2](07b-RewardDistributorV2.md).

> **Status pós-pivot CLP (Fase 1.4):** V1 entra em modo **claim-only** durante a janela de migração de 4 rounds. `finalizeRound` continua funcional mas não será mais chamado em produção — novos rounds são finalizados pelo [RewardDistributorV2](07b-RewardDistributorV2.md). Após o cutoff, governance **revoga `MINTER_ROLE`** do V1 no CreditToken, e `claim` continua respondendo (sem cunhar) até stakers limparem seus rewards históricos. A doc abaixo descreve o V1 como deployado.

## Visão rápida

V1 do distributor de emissão (pré-CLP). Calcula emissão de CREDIT por rodada e cunha sob demanda para stakers via claim pull-based.

Fórmula: `emissao_R = min(max(alpha * burn_{R-1}, floor(R)), capMax)`. **Toda** a emissão é tratada como bucket único de stakers (sem split em LPs/apps/bonders — isso é V2). Emissão por projeto computada sob demanda em `_calculateClaim` para escalar custo de gas com número de claims, não com número de projetos.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

## Parâmetros e storage

### Constants

| Nome | Valor |
|---|---|
| `PRECISION` | `1e18` |
| `MIN_ALPHA` | `5e17` (0.5) |
| `MAX_ALPHA` | `99e16` (0.99) — reduzido de `11e17` para garantir IE1 (α<1 permanente) por construção; ver `audit/economist/2026-04-22-consistency-audit.md` C2 |
| `MIN_CAPMAX` | `1e18` |
| `MAX_CAPMAX` | `100_000_000e18` |
| `FLOOR_SCHEDULE_LENGTH` | `24` |
| `PROBATION_PENALTY_DENOM` | `4` |

### Dependências (immutable)

- `CREDIT` — CreditToken.
- `STAKING` — Staking.
- `BURN_TRACKER` — BurnTracker.
- `REGISTRY` — ProjectRegistry.

### Storage

| Nome | Tipo | Descrição |
|---|---|---|
| `alpha` | `uint256` | produção: `0.95e18`. Ajustável via governança. |
| `capMax` | `uint256` | produção: `5M * 1e18`. Ajustável. |
| `floorSchedule` | `uint256[24]` | imutável pós-constructor |
| `lastFinalizedRound` | `uint256` | — |
| `isFirstRoundFinalized` | `bool` | one-shot para marcar "round 0 finalizado" |
| `roundData` | mapping | `round → RoundData` |
| `claimed` | mapping | `round → projectId → user → bool` |

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

`finalizeRound` e `claim` / `claimMany` são **permissionless** — qualquer um chama.

## Funções externas

### `finalizeRound(uint256 round)`

Grava `roundData[round]` imutável. Permissionless.

- **Reverte**: `RoundAlreadyFinalized`, `OutOfOrderFinalize(expected, provided)`, `RoundNotClosed(round)`.
- **Eventos**: `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)`.

Pré-condições:

- `!roundData[round].finalized`.
- `round == expected` (sequencial).
- `BURN_TRACKER.currentRound() > round`.

### `claim(uint256 round, uint256 projectId) → uint256 amount`

Reivindica reward do `msg.sender`. Marca `claimed` e cunha CREDIT se `amount > 0`.

- **Reverte**: `RoundNotFinalized`, `AlreadyClaimed`.
- **Eventos**: `Claimed(user, round, projectId, amount)` se `amount > 0`.
- **ReentrancyGuard**: sim.

### `claimMany(uint256[] rounds, uint256[] projectIds) → uint256 total`

Batch.

- **Reverte**: `ArrayLengthMismatch`, `EmptyBatch`, `AlreadyClaimed` em qualquer par.
- Entries com `amount == 0` são no-op (não marcam claimed).

### Governance-gated

#### `setAlpha(uint256 newAlpha)`

- **Reverte**: `InvalidAlpha(provided, min, max)` se fora de `[MIN_ALPHA, MAX_ALPHA]`.
- **Eventos**: `AlphaUpdated(old, new)`.
- Afeta só rodadas não-finalizadas.

#### `setCapMax(uint256 newCap)`

- **Reverte**: `InvalidCapMax(provided, min, max)` se fora de `[MIN_CAPMAX, MAX_CAPMAX]`.
- **Eventos**: `CapMaxUpdated(old, new)`.

### Views

- `previewClaim(user, round, projectId) → uint256` — sem side effects.
- `previewEmission(forRound) → uint256` — aplica fórmula com state atual.
- `getEmission(round) → uint256` — `roundData[round].totalEmission`.
- `getProjectEmission(round, projectId) → uint256` — share do projeto.
- `isFinalized(round) → bool`.

## Eventos

| Evento | Indexados |
|---|---|
| `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)` | `round` |
| `Claimed(user, round, projectId, amount)` | `user`, `round`, `projectId` |
| `AlphaUpdated(oldAlpha, newAlpha)` | — |
| `CapMaxUpdated(oldCap, newCap)` | — |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Endereço zero no constructor |
| `RoundNotClosed(round)` | `BurnTracker.currentRound() <= round` |
| `RoundAlreadyFinalized(round)` | Segunda tentativa de finalize |
| `RoundNotFinalized(round)` | claim/preview sem finalize |
| `OutOfOrderFinalize(expected, provided)` | Pulou rodada |
| `AlreadyClaimed(round, projectId, user)` | Re-claim |
| `ArrayLengthMismatch()` | `claimMany` arrays diferentes |
| `EmptyBatch()` | `claimMany` vazio |
| `InvalidAlpha(provided, min, max)` | alpha fora do bound |
| `InvalidCapMax(provided, min, max)` | cap fora do bound |

## Invariantes

- **I2**: burn gera reward por consumo, não por volume passivo.
- **I3**: cap por rodada (`capMax` + schedule decrescente) garante emissão limitada.
- **I5**: snapshot histórico do Staking (`getWeightAt`) impede flash-stake.
- **I6**: lock mínimo 14d no Staking torna flash-stake inviável.
- **I7**: penalidade probation para projetos novos (25% share).
- **Sequencialidade**: `finalizeRound` só aceita `round == lastFinalizedRound + 1` (ou 0 se primeiro).
- **Imutabilidade de round finalized**: após finalize, `roundData[round]` é imutável. Mudança de `alpha`/`capMax` afeta só rodadas ainda não finalizadas.
- **No-op silencioso**: `claim` com `amount == 0` não marca `claimed[...][user] = true` — permite retry se estado mudou.

## Observações importantes

### Dois caminhos de `_projectShare`

**Com burn anterior:**

```
share = emissao * burnProjetoPrev / totalBurnPrev
```

**Sem burn anterior (bootstrap):**

```
share = emissao * projectWeightSnapshot / globalWeightSnapshot
```

Detecção: `rd.totalBurnAtFinalize == 0`. Requer `Staking.getGlobalWeightAt` (trilho global, O(1) por update no Staking).

### Probation penalty aplicada no claim

`REGISTRY.isInProbation(projectId)` é consultado no momento do claim, **não** do finalize. Se probation terminou entre finalize e claim, usuário recebe share cheio. Não há vetor de manipulação porque `probationEndsAt` é setado em `activateProject` e nunca muda.

### FloorSchedule imutável

Gravado no constructor. 24 entradas. Rodadas >= 24 não têm floor. Em produção: decai linearmente de 400k a ~16.666 CREDIT.

### Schedule `uint256[24]` no constructor

Array FIXO (não dinâmico) obriga caller a passar exatamente 24 valores. Array dinâmico exigiria check adicional — aqui é barato e explícito.

### Admin inicial renuncia após handoff

Deploy: `DEFAULT_ADMIN_ROLE` e `GOVERNANCE_ROLE` ao `admin` (deployer). Handoff transfere ambas ao Timelock e renuncia. Em produção, só Timelock governa.

### Migração para V2 (Fase 1.4 CLP)

A janela de migração é de **4 rounds**:

1. V2 começa a finalizar novos rounds com bucket-aware split.
2. V1 continua respondendo a `claim`/`claimMany` para rounds antigos.
3. Ambos têm `MINTER_ROLE` no CREDIT durante a janela.
4. **Após cutoff**: governance revoga `MINTER_ROLE` do V1 no CreditToken. V1 vira read-only — `claim` ainda computa o amount mas o `mint` falha. Stakers que não limparam rewards V1 perdem acesso a eles.

Stakers devem **claim agressivamente** durante a janela de migração para não perder rewards V1.

---

**Ver também**: [RewardDistributorV2](07b-RewardDistributorV2.md), [Staking](05-Staking.md), [BurnTracker](06-BurnTracker.md), [CreditToken](02-CreditToken.md).
