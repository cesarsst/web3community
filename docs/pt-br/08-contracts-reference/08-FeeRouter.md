# FeeRouter

**Para quem é:** devs de apps integrando pagamentos, auditores.
**Pré-requisitos:** [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md).

## Visão rápida

Interface única de pagamento entre usuários e apps. Todo consumo de CREDIT passa por `pay`, que divide em três destinos (burn / treasury / rebate) conforme split configurável. Default produção: `95/0/5`.

`pay` é público — qualquer endereço pode iniciar, desde que `user` tenha aprovado o FeeRouter. Payer econômico é sempre `user`; `msg.sender` é o iniciador da tx.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parâmetros e storage

| Nome | Tipo | Descrição |
|---|---|---|
| `_BPS_DENOMINATOR` | constant | `10.000` |
| `CREDIT` | immutable | CreditToken |
| `BURN_TRACKER` | immutable | BurnTracker |
| `REGISTRY` | immutable | ProjectRegistry |
| `TREASURY` | immutable | Treasury |
| `defaultSplit` | `Split` | produção: `(9500, 0, 500)` |
| `projectSplit` | mapping | override por projeto |
| `hasProjectSplit` | mapping | flag de override |
| `appRecipient` | mapping | override explícito; 0 = owner dinâmico |

### Struct `Split`

```solidity
struct Split {
    uint16 burnBps;
    uint16 treasuryBps;
    uint16 rebateBps;
}
// soma tem que ser 10000
```

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funções externas

### `pay(uint256 projectId, address user, uint256 amount) → (uint256 burned, uint256 toTreasury, uint256 toApp)`

Processa pagamento. Puxa `amount` de `user` via `transferFrom`, divide e distribui.

- **Quem chama**: público. `user` precisa ter `CREDIT.approve(feeRouter, amount)`.
- **Reverte**: `ZeroAddress` (user), `ZeroAmount`, `ProjectNotActive`, `SanityCapExceeded` (do BurnTracker).
- **Eventos**: `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` + (indireto) `BurnRecorded` do BurnTracker + `BurnedByRole` do CREDIT.
- **ReentrancyGuard**: sim.

Pipeline interno:

1. Check user, amount, `REGISTRY.isActive(projectId)`.
2. `CREDIT.safeTransferFrom(user, router, amount)`.
3. Calcula `(burned, toTreasury, toApp)` com dust handling — residuo vai para `toApp`.
4. Distribui: `safeTransfer(recipient, toApp)`, `safeTransfer(TREASURY, toTreasury)`.
5. `forceApprove(BURN_TRACKER, burned)` + `BURN_TRACKER.burnAndRecord(projectId, router, burned)`.

### Governance-gated

#### `setDefaultSplit(Split calldata newSplit)`

- **Reverte**: `InvalidSplit` se soma ≠ 10.000.
- **Eventos**: `DefaultSplitUpdated(old, new)`.

#### `setProjectSplit(uint256 projectId, Split calldata newSplit)`

Grava override. Ativa `hasProjectSplit[projectId] = true`.

- **Reverte**: `InvalidSplit`.
- **Eventos**: `ProjectSplitUpdated(projectId, newSplit)`.

#### `clearProjectSplit(uint256 projectId)`

Remove override. Retoma `defaultSplit`.

- **Reverte**: `NoProjectSplit` se não havia override (idempotência explícita).
- **Eventos**: `ProjectSplitCleared(projectId)`.

### Owner-gated

#### `setAppRecipient(uint256 projectId, address recipient)`

Registra endereço explícito de rebate. `address(0)` reseta para lookup dinâmico (`Registry.getProject(projectId).owner`).

- **Quem chama**: owner do projeto no Registry.
- **Reverte**: `NotProjectOwner` (ou bubbles `ProjectNotFound` do Registry).
- **Eventos**: `AppRecipientUpdated(projectId, oldRecipient, newRecipient)`.

### Views

- `getEffectiveSplit(uint256 projectId) → Split` — override ou default.
- `getEffectiveRecipient(uint256 projectId) → address`.
- `quote(uint256 projectId, uint256 amount) → (uint256 burned, uint256 toTreasury, uint256 toApp)` — sem side effects; reverte com `ZeroAmount` se amount zero.

## Eventos

| Evento | Indexados |
|---|---|
| `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` | `projectId`, `user`, `payer` |
| `DefaultSplitUpdated(oldSplit, newSplit)` | — |
| `ProjectSplitUpdated(projectId, newSplit)` | `projectId` |
| `ProjectSplitCleared(projectId)` | `projectId` |
| `AppRecipientUpdated(projectId, oldRecipient, newRecipient)` | `projectId`, `oldRecipient`, `newRecipient` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `InvalidSplit(burnBps, treasuryBps, rebateBps, total)` | Soma ≠ 10.000 |
| `ProjectNotActive(projectId)` | Status ≠ Active |
| `ZeroAmount()` | `amount == 0` |
| `ZeroAddress()` | Endereço zero |
| `NotProjectOwner(projectId, caller)` | `setAppRecipient` sem ser owner |
| `NoProjectSplit(projectId)` | `clearProjectSplit` sem override |

## Invariantes

- **I2 (Burn no consumo)**: toda `pay` com `burnBps > 0` aciona `BurnTracker.burnAndRecord` atomicamente.
- **I4 (Governance-gated setters)**: `setDefaultSplit`, `setProjectSplit`, `clearProjectSplit`.
- **I7 (Active gate)**: `pay` exige `isActive`. Dupla validação com BurnTracker.
- **Split soma 10.000**: enforçado on-chain em todos os setters e no constructor.
- **Sem custódia entre chamadas**: cada `pay` é atômico. FeeRouter termina com saldo 0.
- **Dust handling**: `toApp = amount - burned - toTreasury`. Residuo de arredondamento vai para o rebate.
- **ReentrancyGuard + CEI**: guard ativo, approve + burnAndRecord por último.

## Observações importantes

### Por que `pay` é público

Habilita UX flexível:

- **User paga direto** (assina tx).
- **App paga em nome do user** (gas sponsorship, após approve prévio).
- **Relayer / smart wallet** (AA-style).

Payer econômico é sempre `user` (via `transferFrom`). `msg.sender` só aparece no evento.

### Lookup dinâmico de recipient

Se `appRecipient[projectId] == 0`, o recipient é `REGISTRY.getProject(projectId).owner` — atualiza automaticamente quando o owner muda via `transferProjectOwnership`. Elimina necessidade de re-config manual.

### Sem sweep no v1

`FeeRouter` não custodia CREDIT entre chamadas. Nenhum fundo fica preso. Anomalias (tokens enviados por engano) ficam — resolvíveis só via upgrade (não há upgrade path no v1). Adicionar sweep criaria superfície de centralização.

### Pós-deploy dependências

- `BurnTracker.grantRole(RECORDER_ROLE, feeRouter)` — feito no Fase B do deploy.
- Apps individuais chamam `FeeRouter.pay`, não direto o BurnTracker.

---

**Ver também**: [BurnTracker](06-BurnTracker.md), [CreditToken](02-CreditToken.md), [Treasury](04-Treasury.md).
