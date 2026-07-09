# ProjectRegistry

**Para quem é:** devs/auditores.

Contrato: `contracts/ProjectRegistry.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Whitelist on-chain dos projetos/apps do ecossistema — fonte única da verdade para: owner de cada projeto, colateral GOV lockado (skin in the game), status (`Pending`/`Active`/`Probation`/`Removed`), URI de metadata off-chain e o `ownerRecipient` canônico (destino de pagamentos, com timelock operacional de 48h).

Consumido por [Staking](05-Staking.md), [FeeRouterV2](06-FeeRouterV2.md) e [ProjectFunding](07-ProjectFunding.md) para gating (`isActive`) e lookup de owner. Todas as mutações de ciclo de vida são gated por `GOVERNANCE_ROLE` — em produção o `CommunityTimelock`, ou seja, passam por proposta aprovada na DAO.

Herança: `AccessControl`. Usa `SafeERC20` para movimentar GOV.

## Interface pública

### Tipos

```solidity
enum Status { Pending, Active, Probation, Removed }
// Transições: Pending->Active; Active->Probation; Active->Removed;
//             Probation->Active; Probation->Removed. Removed é terminal.

struct Project {
    address owner;
    uint256 collateral;      // GOV lockado (wei)
    Status  status;
    uint64  activatedAt;     // 0 enquanto Pending
    uint64  probationEndsAt; // activatedAt + probationDuration
    string  metadataURI;
}

struct PendingRecipientChange {
    address newRecipient;    // address(0) = limpar explicit (volta ao owner)
    uint64  effectiveAt;     // 0 = sem proposta pendente
}
```

### Constantes / storage

| Nome | Tipo | Valor / descrição |
|---|---|---|
| `GOVERNANCE_ROLE` | `bytes32 constant` | `keccak256("GOVERNANCE_ROLE")`. Produção: Timelock. |
| `OWNER_RECIPIENT_TIMELOCK` | `uint64 constant` | `48 hours`. Delay operacional do ownerRecipient. |
| `GOV_TOKEN` | `IERC20 immutable` | Token de colateral (GOV). Exposto via `govToken()`. |
| `minCollateral` | `uint256 public` | Colateral mínimo para registrar. Ajustável. |
| `probationDuration` | `uint64 public` | Duração da probation inicial automática. Ajustável. |
| `pendingOwnerRecipient` | `mapping(uint256 => PendingRecipientChange) public` | Proposta pendente por projeto. |

### Constructor

```solidity
constructor(address govToken_, address initialAdmin, uint256 initialMinCollateral, uint64 initialProbationDuration)
```
Concede `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE` a `initialAdmin`. Reverte `ZeroAddress`/`ZeroAmount` para parâmetros inválidos. `_nextProjectId` começa em 1 (ID 0 é sempre inválido).

### Views

```solidity
function govToken() external view returns (address)
function totalProjects() external view returns (uint256)          // inclui Removed
function getProject(uint256 projectId) external view returns (Project memory)  // reverte ProjectNotFound
function isActive(uint256 projectId) external view returns (bool) // false p/ inexistente (não reverte)
function isInProbation(uint256 projectId) external view returns (bool) // probation INICIAL por tempo
function pendingOwner(uint256 projectId) external view returns (address)
function ownerRecipient(uint256 projectId) external view returns (address recipient) // explicit ou fallback=owner
```

### Governança (`onlyRole(GOVERNANCE_ROLE)`)

```solidity
function registerProject(address owner, string calldata metadataURI, uint256 collateralAmount) external returns (uint256 projectId)
```
Registra em `Pending` e puxa `collateralAmount` de GOV do `owner` (precisa de approve prévio). Reverte `ZeroAddress`, `EmptyMetadataURI`, `InsufficientCollateral`, `InsufficientAllowance`. Emite `ProjectRegistered`.

```solidity
function activateProject(uint256 projectId) external   // Pending -> Active; seta activatedAt/probationEndsAt
function setProbation(uint256 projectId) external       // Active -> Probation (punitiva)
function reactivate(uint256 projectId) external         // Probation -> Active
function removeProject(uint256 projectId, bool slash, address treasury) external // terminal; slash envia colateral ao treasury, senão devolve ao owner
function setMinCollateral(uint256 newMin) external      // reverte ZeroAmount
function setProbationDuration(uint64 newDuration) external // reverte ZeroAmount
```

### Owner do projeto

```solidity
function updateMetadata(uint256 projectId, string calldata metadataURI) external // só owner; reverte se Removed
function transferProjectOwnership(uint256 projectId, address newOwner) external  // inicia transferência 2-step
function acceptProjectOwnership(uint256 projectId) external                      // pendingOwner consolida
function proposeOwnerRecipient(uint256 projectId, address newRecipient) external // só owner; arma timelock 48h
```

### ownerRecipient (permissionless após timelock)

```solidity
function applyOwnerRecipient(uint256 projectId) external   // qualquer um após effectiveAt
function cancelOwnerRecipient(uint256 projectId) external  // owner OU GOVERNANCE_ROLE (escape hatch)
```

## Eventos

`ProjectRegistered`, `ProjectActivated`, `ProjectProbation`, `ProjectReactivated`, `ProjectRemoved(id, slashed, collateralReturned)`, `MetadataUpdated`, `OwnershipTransferInitiated`, `OwnershipTransferAccepted`, `MinCollateralUpdated`, `ProbationDurationUpdated`, `OwnerRecipientProposed`, `OwnerRecipientApplied`, `OwnerRecipientCancelled`.

## Erros

`ZeroAddress`, `ZeroAmount`, `EmptyMetadataURI`, `InsufficientCollateral(provided, required)`, `InsufficientAllowance(provided, required)`, `ProjectNotFound(projectId)`, `ProjectAlreadyRemoved(projectId)`, `InvalidStatus(projectId, current, expected)`, `NotProjectOwner(projectId, caller)`, `NotPendingOwner(projectId, caller)`, `OwnerRecipientTimelockActive(effectiveAt, nowTs)`, `NoPendingOwnerRecipient(projectId)`.

## Roles

| Role | Produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` — gerencia roles. |
| `GOVERNANCE_ROLE` | `CommunityTimelock` — registro, ativação, probation, remoção e ajuste de parâmetros. |

Owner de projeto e ações de ownerRecipient **não** exigem role — são gated por ownership da posição/lógica de negócio.

## Invariantes

- **Governança (I7):** só `GOVERNANCE_ROLE` (Timelock) altera ciclo de vida e parâmetros econômicos; registro/remoção de projeto exigem proposta aprovada.
- **Colateral:** `collateral >= minCollateral` na criação; `minCollateral` nunca é zero. Em `removeProject`, `slash=true` envia ao treasury, `slash=false` devolve ao owner.
- **Máquina de status:** transições restritas; `Removed` é terminal (reverte `ProjectAlreadyRemoved`).
- **ownerRecipient com timelock 48h:** `propose` só arma; `apply` só após `effectiveAt` (permissionless), fechando o vetor de hot-swap de recipient. `cancel` disponível ao owner ou à governança.
- **Fallback de recipient:** `ownerRecipient` retorna o explicit setado ou, na ausência, o `owner` do projeto; `address(0)` só para projetos inexistentes.
- **CEI:** efeitos de storage antes das transferências de GOV (padrão em `registerProject`/`removeProject`).

## Ver também

[Staking](05-Staking.md) · [ProjectFunding](07-ProjectFunding.md) · [FeeRouterV2](06-FeeRouterV2.md)
