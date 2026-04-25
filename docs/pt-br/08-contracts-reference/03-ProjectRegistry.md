# ProjectRegistry

**Para quem é:** devs listando projetos, auditores, stakers verificando status.
**Pré-requisitos:** [Project whitelist](../02-core-concepts/06-project-whitelist.md).

## Visão rápida

Whitelist on-chain de projetos/apps do ecossistema. Fonte única da verdade para:

- Quem é dono de cada projeto.
- Quanto GOV foi lockado como colateral (skin in the game).
- Status do projeto (`Pending`, `Active`, `Probation`, `Removed`).
- URI de metadata off-chain.
- **`ownerRecipient`** — destinatário canônico do bucket apps do `RewardDistributorV2` (Fase 1.4), com timelock de 48h.

Consumido por `Staking`, `BurnTracker`, `RewardDistributor`/`RewardDistributorV2` e `FeeRouter` para gating e lookup de owner/recipient.

## Herança

```
AccessControl (OZ)
```

Usa `SafeERC20` para movimentação de GOV.

## Parâmetros e storage

### Constants

| Nome | Valor |
|---|---|
| `OWNER_RECIPIENT_TIMELOCK` | `48 hours` |

### Storage

| Nome | Tipo | Descrição |
|---|---|---|
| `GOV_TOKEN` | `IERC20` immutable | Endereço do GovernanceToken |
| `minCollateral` | `uint256` | Colateral mínimo (produção: `10.000 * 1e18`) |
| `probationDuration` | `uint64` | Duração da probation inicial (produção: `30 days`) |
| `_nextProjectId` | `uint256` private | Próximo ID (começa em 1) |
| `_projects` | mapping | `projectId → Project` |
| `_pendingOwners` | mapping | `projectId → pendingOwner` |
| `_ownerRecipient` | mapping | `projectId → recipient explícito` (Fase 1.4) |
| `pendingOwnerRecipient` | mapping | `projectId → PendingRecipientChange` |

### Struct `PendingRecipientChange`

```solidity
struct PendingRecipientChange {
    address newRecipient;  // address(0) = "limpar explicit"
    uint64 effectiveAt;    // block.timestamp + 48h no propose
}
```

### Struct `Project`

```solidity
struct Project {
    address owner;                // owner atual
    uint256 collateral;           // GOV lockado
    Status status;                // enum
    uint64 activatedAt;           // timestamp da 1a ativacao (0 se Pending)
    uint64 probationEndsAt;       // timestamp fim probation inicial
    string metadataURI;           // IPFS/Arweave
}
```

### Enum `Status`

```solidity
enum Status { Pending, Active, Probation, Removed }
```

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funções externas

### Governance-gated (`onlyRole(GOVERNANCE_ROLE)`)

#### `registerProject(owner, metadataURI, collateralAmount) → projectId`

Registra novo projeto em `Pending`. Puxa colateral via `transferFrom` do `owner`.

- **Reverte**: `ZeroAddress` (owner), `EmptyMetadataURI`, `InsufficientCollateral`, `InsufficientAllowance`.
- **Eventos**: `ProjectRegistered(projectId, owner, collateral, metadataURI)`.
- **Pré-condição**: `owner` fez `GOV.approve(registry, collateralAmount)` antes.

#### `activateProject(projectId)`

Pending → Active. Seta `activatedAt` e `probationEndsAt`.

- **Reverte**: `ProjectNotFound`, `InvalidStatus` (se não for Pending).
- **Eventos**: `ProjectActivated(projectId, activatedAt, probationEndsAt)`.

#### `setProbation(projectId)`

Active → Probation (punitiva).

- **Reverte**: `InvalidStatus` (precisa estar Active).
- **Eventos**: `ProjectProbation(projectId)`.

#### `reactivate(projectId)`

Probation → Active. Não altera `activatedAt` nem `probationEndsAt`.

- **Reverte**: `InvalidStatus` (precisa estar Probation).
- **Eventos**: `ProjectReactivated(projectId)`.

#### `removeProject(projectId, slash, treasury)`

Status → Removed (terminal). Se `slash`, envia colateral ao `treasury`; senão, ao owner.

- **Reverte**: `ProjectAlreadyRemoved`, `ZeroAddress` (se `slash && treasury == 0`).
- **Eventos**: `ProjectRemoved(projectId, slashed, collateralReturned)`.

#### `setMinCollateral(newMin)`

Ajusta colateral mínimo. Afeta apenas registros futuros.

- **Reverte**: `ZeroAmount`.
- **Eventos**: `MinCollateralUpdated(old, new)`.

#### `setProbationDuration(newDuration)`

Ajusta probation inicial. Afeta apenas ativações futuras.

- **Reverte**: `ZeroAmount`.
- **Eventos**: `ProbationDurationUpdated(old, new)`.

### Owner-gated (owner do projeto)

#### `updateMetadata(projectId, metadataURI)`

Atualiza URI. Não requer proposta.

- **Reverte**: `ProjectAlreadyRemoved`, `NotProjectOwner`, `EmptyMetadataURI`.
- **Eventos**: `MetadataUpdated(projectId, newURI)`.

#### `transferProjectOwnership(projectId, newOwner)`

Inicia transferência 2-step.

- **Reverte**: `NotProjectOwner`, `ProjectAlreadyRemoved`, `ZeroAddress`.
- **Eventos**: `OwnershipTransferInitiated(projectId, currentOwner, pendingOwner)`.

#### `acceptProjectOwnership(projectId)`

Aceita a transferência (chamado pelo `pendingOwner`).

- **Reverte**: `NotPendingOwner`.
- **Eventos**: `OwnershipTransferAccepted(projectId, previous, new)`.

### ownerRecipient timelock (Fase 1.4)

#### `proposeOwnerRecipient(uint256 projectId, address newRecipient)` — owner do projeto

Inicia proposta de mudança do `ownerRecipient`. Reseta clock de 48h. `newRecipient = address(0)` reseta para fallback (= owner do projeto).

- **Reverte**: `ProjectAlreadyRemoved`, `NotProjectOwner`.
- **Eventos**: `OwnerRecipientProposed(projectId, owner, newRecipient, effectiveAt)`.

#### `applyOwnerRecipient(uint256 projectId)` — permissionless

Aplica proposta após `effectiveAt`. Bots/keepers podem chamar.

- **Reverte**: `NoPendingOwnerRecipient`, `OwnerRecipientTimelockActive(effectiveAt, now)`.
- **Eventos**: `OwnerRecipientApplied(projectId, oldRecipient, newRecipient)`.

#### `cancelOwnerRecipient(uint256 projectId)` — owner do projeto OU `GOVERNANCE_ROLE`

Cancela proposta pendente. Escape hatch caso owner esteja comprometido.

- **Reverte**: `NoPendingOwnerRecipient`, `NotProjectOwner` (se caller não é owner nem governance).
- **Eventos**: `OwnerRecipientCancelled(projectId, canceller)`.

### Views

- `govToken() → address` — endereço do token de colateral.
- `totalProjects() → uint256` — `_nextProjectId - 1`.
- `getProject(projectId) → Project` — reverte com `ProjectNotFound` se não existe.
- `isActive(projectId) → bool` — retorna `false` para inexistente (não reverte).
- `isInProbation(projectId) → bool` — probation **inicial por tempo** apenas; `false` para Probation punitiva.
- `pendingOwner(projectId) → address`.
- `ownerRecipient(projectId) → address` — recipient explícito ou fallback para `project.owner`. `address(0)` se projeto inexistente.

## Eventos

Todos listados acima. Campos `projectId`, `owner`, `currentOwner`, `pendingOwnerAddr`, `newOwner`, `previousOwner` são `indexed` onde aplicável.

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Endereço inválido |
| `ZeroAmount()` | Valor zero em setter |
| `EmptyMetadataURI()` | URI vazia |
| `InsufficientCollateral(provided, required)` | Colateral < `minCollateral` |
| `InsufficientAllowance(provided, required)` | Allowance < colateral |
| `ProjectNotFound(projectId)` | ID não existe |
| `ProjectAlreadyRemoved(projectId)` | Status é Removed |
| `InvalidStatus(projectId, current, expected)` | Transição inválida |
| `NotProjectOwner(projectId, caller)` | Caller não é owner |
| `NotPendingOwner(projectId, caller)` | Caller não é pending |
| `NoPendingOwnerRecipient(projectId)` | apply/cancel sem proposta pendente |
| `OwnerRecipientTimelockActive(effectiveAt, now)` | apply antes do `effectiveAt` |

## Invariantes

- **I7 (Governance-gated)**: registros e transições são exclusivamente via `GOVERNANCE_ROLE` (exceto metadata/ownership que são owner-gated).
- **Custódia fiel**: soma dos `collateral` em projetos não-`Removed` == `GOV.balanceOf(registry)`.
- **ID monotônico**: IDs só crescem; nunca reutilizados.
- **Removed terminal**: uma vez Removed, sempre Removed. Metadata congela.
- **CEI em `registerProject` e `removeProject`**: effects antes de `safeTransfer`.

## Observações importantes

### Duas noções de "probation"

- **Inicial por tempo** (`isInProbation` view): aplicada automaticamente após `activateProject`, dura `probationDuration`. Projeto é `Active` mas recebe share de reward /4.
- **Punitiva** (status `Probation` do enum): a governança move manualmente. Bloqueia operações; não bypassa lock.

São distintas e coexistem.

### Sem topup / withdraw parcial no v1

Se v2 precisar, adicione funções novas sem quebrar layout.

### Probation → Active preserva ancoramento

`reactivate` **não** recalcula `activatedAt` / `probationEndsAt`. Se o projeto ainda estiver dentro da janela inicial de probation, a penalidade de reward se mantém.

### Por que `ownerRecipient` tem timelock de 48h

Com a Fase 1.4 do CLP, o `RewardDistributorV2` mint CREDIT direto para `ownerRecipient(projectId)` ao finalizar a rodada. Sem timelock, o owner poderia fazer hot-swap entre `finalizeRound` e indexação off-chain, desviando o bucket apps inteiro para um endereço hostil sem que stakers/auditores percebam a tempo.

48h é compatível com o ciclo operacional da DAO (proposta + execução do Timelock principal levam ~2 dias). `cancelOwnerRecipient` está disponível tanto para o owner quanto para `GOVERNANCE_ROLE` — escape hatch caso a chave do owner seja comprometida e a proposta seja maliciosa.

`ownerRecipient` retorna o explícito quando setado, ou cai para `project.owner` como fallback — preserva compatibilidade com projetos antigos que jamais chamaram `proposeOwnerRecipient`.

---

**Ver também**: [Staking](05-Staking.md), [FeeRouter](08-FeeRouter.md), [BurnTracker](06-BurnTracker.md).
