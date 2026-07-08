# BurnTracker

> ⚠️ **LEGADO** — substituído pelo remodel 2026-07-08 (ver [CreditPSM](15-CreditPSM.md), [FeeRouterV2](08b-FeeRouterV2.md) e [ProjectFunding](16-ProjectFunding.md)). Mantido deployado por compatibilidade histórica.

**Para quem é:** devs de apps listados (ganham `RECORDER_ROLE`), auditores.
**Pré-requisitos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

## Visão rápida

"Oracle interna" que contabiliza on-chain o burn de CREDIT por `(rodada, projectId)`. Única fonte de verdade consumida pelo `RewardDistributor` para calcular share de projeto.

Toda queima dentro da plataforma passa por `burnAndRecord` — atomicamente queima CREDIT do usuário (via `BURNER_ROLE` no CreditToken) e grava o burn no par `(round, projectId)`.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

## Parâmetros e storage

| Nome | Tipo | Valor | Descrição |
|---|---|---|---|
| `MIN_ROUND_DURATION` | `uint64` constant | `1 days` | Limite inferior |
| `MAX_ROUND_DURATION` | `uint64` constant | `30 days` | Limite superior |
| `CREDIT_TOKEN` | immutable | CREDIT | Token rastreado |
| `REGISTRY` | immutable | Registry | Para gating `isActive` |
| `currentRound` | `uint256` | começa em 0 | Rodada atual |
| `roundStartedAt` | `uint64` | `block.timestamp` no deploy | Timestamp da rodada atual |
| `roundDuration` | `uint64` | produção: `7 days` | Duração alvo |
| `maxBurnPerRoundPerProject` | `uint256` | produção: `10M * 1e18` (0 = desabilita) | Sanity cap |
| `totalBurnByRound` | mapping | `round → uint256` | Total |
| `burnByRoundProject` | mapping | `round → projectId → uint256` | Por projeto |
| `projectsWithBurnCount` | mapping | `round → uint256` | Contagem distinta |

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |
| `RECORDER_ROLE` | `FeeRouter` (e cada app adicional via proposta) |

## Funções externas

### `burnAndRecord(uint256 projectId, address from, uint256 amount)`

Queima `amount` de CREDIT do `from` e registra burn no `(currentRound, projectId)`.

- **Quem chama**: `RECORDER_ROLE`.
- **Reverte**: `ZeroAddress`, `ZeroAmount`, `ProjectNotActive`, `SanityCapExceeded`.
- **Eventos**: `BurnRecorded(round, projectId, from, amount, newTotalForProject)` + (do CREDIT) `BurnedByRole`.
- **ReentrancyGuard**: sim.

### Governance-gated

#### `closeRound()`

Fecha rodada atual, abre próxima. `currentRound++`, `roundStartedAt = now`.

- **Reverte**: apenas `AccessControlUnauthorizedAccount`.
- **Eventos**: `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)`.

`earlyClose = now < roundStartedAt + roundDuration`. Permite fechamento antecipado (emergência) ou tardio (fluxo normal).

#### `setRoundDuration(uint64 newDuration)`

Ajusta duração alvo.

- **Reverte**: `InvalidRoundDuration(provided, min, max)`.
- **Eventos**: `RoundDurationUpdated(old, new)`.

#### `setMaxBurnPerRoundPerProject(uint256 newMax)`

Ajusta sanity cap. `0` desabilita.

- **Eventos**: `MaxBurnPerRoundPerProjectUpdated(old, new)`.

### Views

- `getCurrentRound() → uint256`.
- `getRoundEndsAt() → uint64` — `roundStartedAt + roundDuration`.
- `isRoundReadyToClose() → bool` — `now >= roundEndsAt`.
- `getBurnForProjectInRound(round, projectId) → uint256`.
- `getTotalBurnForRound(round) → uint256`.

## Eventos

| Evento | Indexados |
|---|---|
| `BurnRecorded(round, projectId, from, amount, newTotalForProject)` | `round`, `projectId`, `from` |
| `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)` | `round` |
| `RoundDurationUpdated(oldDuration, newDuration)` | — |
| `MaxBurnPerRoundPerProjectUpdated(oldMax, newMax)` | — |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `from` ou dependências |
| `ZeroAmount()` | `amount == 0` |
| `ProjectNotActive(projectId)` | Status ≠ Active |
| `SanityCapExceeded(projectId, attempted, cap)` | Acumulado + amount > cap |
| `InvalidRoundDuration(provided, min, max)` | Fora de `[MIN_ROUND_DURATION, MAX_ROUND_DURATION]` |

## Invariantes

- **I2 (Burn no consumo)**: `burnAndRecord` queima via `burnByRole` nativo (`_burn` decrementa `totalSupply`). `totalSupply` cai em exatamente `amount`.
- **I3 (sanity cap)**: `accumulated + amount <= cap` quando `cap > 0`. Impede wash-burn.
- **I4 (Governance)**: `closeRound`, `setRoundDuration`, `setMaxBurnPerRoundPerProject` exigem `GOVERNANCE_ROLE`.
- **I7 (Active gate)**: só projetos `Active` aceitam `burnAndRecord`. Burn histórico não é revertido se projeto mudar status depois.
- **Sequencialidade**: `currentRound` só incrementa, nunca decrementa. Accounting de rodadas passadas permanece acessível indefinidamente.
- **CEI + ReentrancyGuard**: effects antes da chamada ao CreditToken.

## Observações importantes

### Por que atomic on-chain (caminho "c")

Alternativas rejeitadas:

- **Event listener off-chain**: depende de indexer confiável; cria janela entre burn e record.
- **App registra sem queimar**: double-spend trivial (inflaria rewards sem deflação).
- **Adotada**: app chama `BurnTracker.burnAndRecord(projectId, from, amount)` atomicamente. BurnTracker detém `BURNER_ROLE` no CreditToken e queima via `burnByRole` sem allowance.

### `closeRound` governance-gated

Permissionless seria vulnerável — qualquer um fechava no instante mais favorável a um projeto específico. Governance decide quando fechar.

### Fluxo de close sem RewardDistributor

O tracker **não** chama o distributor ao fechar. O distributor consome em pull (lendo views). Evita acoplamento cíclico.

### Rodada 0

Começa em `block.timestamp` do deploy. Primeiro close passa para round 1.

### Empty round

Rodada sem burn (`totalBurn == 0`) é permitida. Evento `RoundClosed` sai com `projectsCount = 0`.

### `tag` fixo na chamada ao CREDIT

Passa sempre `"burnTracker"`. O tag rico (projeto, round) já está no evento `BurnRecorded` — evita duplicação.

---

**Ver também**: [RewardDistributor](07-RewardDistributor.md), [FeeRouter](08-FeeRouter.md), [CreditToken](02-CreditToken.md).
