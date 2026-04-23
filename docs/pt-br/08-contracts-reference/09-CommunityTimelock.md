# CommunityTimelock

**Para quem é:** quem precisa auditar a camada executora da governança.
**Pré-requisitos:** [Governance (conceito)](../02-core-concepts/05-governance.md).

## Visão rápida

Wrapper identitário sobre `TimelockController` da OpenZeppelin 5.0.2. Executa, com delay, todas as decisões aprovadas pelo `CommunityGovernor`. Em produção é o único portador de `GOVERNANCE_ROLE` / `DEFAULT_ADMIN_ROLE` nos contratos econômicos (Treasury, Registry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy) e é `owner` do GovernanceToken.

Sem código adicional — herda `TimelockController` inteiro. Razão: manter identidade on-chain (nome "CommunityTimelock" no Etherscan) sem introduzir superfície extra.

## Herança

```
TimelockController (OZ 5.0.2)
  - AccessControl
  - IERC721Receiver (para receber NFTs via transfer)
  - IERC1155Receiver (idem)
```

## Parâmetros (via constructor, herdado)

```solidity
constructor(
    uint256 minDelay,
    address[] memory proposers,
    address[] memory executors,
    address admin
)
```

### Valores em produção

| Parâmetro | Valor | Razão |
|---|---|---|
| `minDelay` | `172800` (2 dias) | Janela de reação a proposta maliciosa |
| `proposers` | `[]` | Governor é concedido via `grantRole` no deploy |
| `executors` | `[address(0)]` | Qualquer um pode executar após delay |
| `admin` | deployer (bootstrap), renunciado após handoff | Timelock passa a ser self-administered |

## Roles (definidas em `TimelockController`)

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | **Self** (Timelock é admin de si) |
| `PROPOSER_ROLE` | `CommunityGovernor` |
| `CANCELLER_ROLE` | `CommunityGovernor` |
| `EXECUTOR_ROLE` | `address(0)` — qualquer endereço executa |

## Funções externas (herdadas de TimelockController)

### Proposta → agendamento

#### `schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)`

Agenda operação única. Requer `PROPOSER_ROLE`.

#### `scheduleBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt, uint256 delay)`

Batch.

### Execução

#### `execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt)`

Executa operação única após `minDelay`. Requer `EXECUTOR_ROLE` — em produção é `address(0)`, então qualquer um chama.

#### `executeBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt)`

Batch.

### Cancelamento

#### `cancel(bytes32 id)`

Cancela operação pending. Requer `CANCELLER_ROLE`.

### Views

- `getMinDelay() → uint256`.
- `hashOperation(target, value, data, predecessor, salt) → bytes32`.
- `hashOperationBatch(...) → bytes32`.
- `isOperation(id) → bool`.
- `isOperationPending(id) → bool`.
- `isOperationReady(id) → bool` — passou do delay.
- `isOperationDone(id) → bool`.
- `getTimestamp(id) → uint256` — timestamp em que vira ready.

### Admin

#### `updateDelay(uint256 newDelay)`

Ajusta `minDelay`. Só pode ser chamado por `this` (auto-governance) — requer proposta aprovada.

- **Eventos**: `MinDelayChange(oldDuration, newDuration)`.

## Eventos (herdados)

- `CallScheduled(id, index, target, value, data, predecessor, delay)`.
- `CallExecuted(id, index, target, value, data)`.
- `CallSalt(id, salt)`.
- `Cancelled(id)`.
- `MinDelayChange(oldDuration, newDuration)`.

## Invariantes

- **Self-administered pós-handoff**: `DEFAULT_ADMIN_ROLE` é do próprio Timelock. Mudança de role exige proposta aprovada.
- **Proposer = Governor**: único autorizado a `schedule`.
- **Executor aberto**: qualquer endereço executa após delay (o delay já é o gate de segurança).
- **Canceller = Governor**: apenas via `_cancel` em proposta contrária. Sem guardian unilateral no v1.
- **Timelock não pode ser "bypass"**: todas as funções state-changing dos contratos econômicos exigem `GOVERNANCE_ROLE`, que é exclusivo do Timelock.

## Observações importantes

### Por que `address(0)` como executor

Os parâmetros e targets da operação já são imutáveis após `schedule`. O delay já expirou quando alguém chama `execute`. Exigir `EXECUTOR_ROLE` dedicado só adicionaria fricção operacional — precisaria sempre ter um executor EOA ativo. Qualquer parte pode clicar "execute" sem alterar o resultado.

### `CANCELLER_ROLE` só com o Governor

`GovernorTimelockControl._cancel` chama `Timelock.cancel` ao cancelar proposta via governança. Não concedemos `CANCELLER_ROLE` a ninguém mais (nem multisig guardian) — cancelador externo poderia DoSar propostas válidas, violando "o voto é a fonte de verdade".

### Imutabilidade prática

Apesar do Timelock ser `self-administered`, não há "upgrade" do contrato em si. Se a DAO precisar de Timelock v2, deve:

1. Deployar novo Timelock.
2. Propor via v1: grant `GOVERNANCE_ROLE` (novo) e revoke (v1) em todos os contratos econômicos.
3. Similar para o GovernanceToken `transferOwnership`.
4. Propor no Governor v1 para mudar `timelock` referência (se Governor suportar) ou deployar Governor novo.

Esse caminho é complexo e exige múltiplas propostas — intencional.

### Deploy estratégia recomendada

1. Deploy Timelock com `proposers = []`, `executors = [0x0]`, `admin = deployer`.
2. Deploy Governor apontando para Timelock.
3. Deployer: `grantRole(PROPOSER_ROLE, governor)` + `grantRole(CANCELLER_ROLE, governor)`.
4. Deployer: `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`. Timelock vira self-administered.

Documentado em [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

### Sem `PAUSE`

Não existe botão de pausa unilateral. Se for necessário parar alguma operação, a DAO aprova proposta específica — por exemplo, `Registry.setProbation` para suspender um projeto malicioso.

---

**Ver também**: [CommunityGovernor](10-CommunityGovernor.md).
