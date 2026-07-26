# CommunityTimelock

**Para quem é:** devs/auditores.

Contrato: `contracts/CommunityTimelock.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Wrapper identitário sobre o `TimelockController` da OpenZeppelin 5. Executa, com delay, todas as decisões aprovadas pelo [CommunityGovernor](10-CommunityGovernor.md). Em produção é o único portador de `GOVERNANCE_ROLE` / `DEFAULT_ADMIN_ROLE` nos contratos econômicos (Treasury, ProjectRegistry, FeeRouterV2, ProjectFunding) e o único `owner` do [GovernanceToken](01-GovernanceToken.md) após o bootstrap.

O wrapper é **propositalmente sem código adicional** — herda `TimelockController` integralmente. A motivação é identidade on-chain (nome do contrato no explorer) e concentrar a NatSpec de deploy num único lugar, sem introduzir superfície de bug extra.

Herança: `TimelockController`.

## Interface pública

### Constructor

```solidity
constructor(uint256 minDelay, address[] proposers, address[] executors, address admin)
```
Repassa todos os parâmetros ao constructor do `TimelockController` sem alteração.

- `minDelay` — delay mínimo (segundos) entre `schedule` e `execute`. Sugestão produção: `172800` (2 dias); dev: `3600` (1h).
- `proposers` — endereços iniciais com `PROPOSER_ROLE` + `CANCELLER_ROLE`. Deploy recomendado: `[]` (o Governor recebe ambas após seu deploy).
- `executors` — endereços com `EXECUTOR_ROLE`. Recomendado: `[address(0)]` (execução pública após o delay).
- `admin` — `DEFAULT_ADMIN_ROLE` inicial (deployer), que renuncia ao final para o Timelock ficar self-administered.

### Herdadas (TimelockController)

- **Agendamento/execução:** `schedule`, `scheduleBatch`, `execute`, `executeBatch`, `cancel`.
- **Consulta:** `getMinDelay`, `getTimestamp`, `isOperation`, `isOperationPending`, `isOperationReady`, `isOperationDone`, `hashOperation`, `hashOperationBatch`.
- **Config:** `updateDelay` (só via a própria execução do Timelock).
- **Roles (AccessControl):** `PROPOSER_ROLE`, `EXECUTOR_ROLE`, `CANCELLER_ROLE`, `DEFAULT_ADMIN_ROLE`, mais `grantRole`/`revokeRole`/`renounceRole`/`hasRole`.
- **Receiver:** `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`, `receive()`.

## Eventos

Herdados: `CallScheduled`, `CallExecuted`, `CallSalt`, `Cancelled`, `MinDelayChange`, mais os de `AccessControl`.

## Roles

| Role | Estratégia recomendada de deploy |
|---|---|
| `PROPOSER_ROLE` | Concedida ao Governor. |
| `CANCELLER_ROLE` | Concedida ao Governor (usada por `GovernorTimelockControl._cancel`). Não concedida a mais ninguém. |
| `EXECUTOR_ROLE` | `address(0)` — execução permissionless após o delay (o delay é o gate real). |
| `DEFAULT_ADMIN_ROLE` | Deployer no bootstrap; renuncia ao final → Timelock self-administered. |

Alterar quem detém roles **no próprio Timelock** exige supermaioria de 75% no Governor.

## Invariantes

- **I4 (governança):** contratos econômicos cedem `GOVERNANCE_ROLE` / `owner` ao Timelock; nenhuma EOA retém poder unilateral após o wiring de produção.
- **I7 (projetos via Registry):** só o Timelock (após proposta aprovada) satisfaz o `GOVERNANCE_ROLE` do `ProjectRegistry`.
- **Self-administered:** após a renúncia do deployer, roles do Timelock só mudam por proposta do Governor.
- **Sem cancelador externo:** `CANCELLER_ROLE` fica só com o Governor — um cancelador externo poderia DoSar propostas válidas.

## Ver também

[CommunityGovernor](10-CommunityGovernor.md) · [Treasury](08-Treasury.md) · [ProjectRegistry](04-ProjectRegistry.md)
