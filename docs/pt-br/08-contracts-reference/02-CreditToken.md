# CreditToken

**Para quem é:** devs integrando com o token utilitário ou auditores.
**Pré-requisitos:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## Visão rápida

Token ERC-20 utilitário, queimado no consumo dentro dos apps. Supply elástico sem cap hardcoded — a inflação é controlada economicamente pelo `RewardDistributor` (único holder de `MINTER_ROLE` em produção), que aplica a fórmula `min(max(alpha*burn, floor), capMax)` por rodada.

Queima em três caminhos: `burn` (self), `burnFrom` (com allowance), `burnByRole` (sem allowance, role-gated). O caminho `burnByRole` existe para habilitar burn atômico pelo `BurnTracker` sem exigir approve prévio do usuário (UX de 1 tx no app).

## Herança

```
ERC20 (OZ)
ERC20Burnable (OZ)
AccessControl (OZ)
```

## Parâmetros e storage

| Nome | Tipo | Valor | Descrição |
|---|---|---|---|
| `MINTER_ROLE` | `bytes32` constant | `keccak256("MINTER_ROLE")` | Role para cunhar |
| `BURNER_ROLE` | `bytes32` constant | `keccak256("BURNER_ROLE")` | Role para queimar sem allowance |
| `genesisMinted` | `bool` | `false` no deploy | Flag one-shot; previne re-execução de `mintGenesis` |
| `name` | ERC-20 | "Web3Community Credit" (produção) | — |
| `symbol` | ERC-20 | "CREDIT" (produção) | — |

Sem cap hardcoded.

## Roles e permissões

| Role | Em produção concedida a |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` (após handoff) |
| `MINTER_ROLE` | `RewardDistributor` |
| `BURNER_ROLE` | `BurnTracker` |

## Funções externas

### `mintGenesis(address to, uint256 amount)`

Cunhagem única de "genesis" (em produção: 10M CREDIT para o Treasury). Flag `genesisMinted` impede re-execução.

- **Quem chama**: `DEFAULT_ADMIN_ROLE`.
- **Reverte**:
  - `GenesisAlreadyMinted` se já chamado.
  - `ZeroAddress` / `ZeroAmount`.
- **Eventos**: `GenesisMinted(to, amount)` + `Transfer(0, to, amount)`.

### `mint(address to, uint256 amount, string calldata tag)`

Cunha `amount` para `to`. Não aplica cap (responsabilidade do caller).

- **Quem chama**: `MINTER_ROLE` (em produção, `RewardDistributor`).
- **Reverte**: `ZeroAddress`, `ZeroAmount`.
- **Eventos**: `Minted(to, amount, tag)` + `Transfer(0, to, amount)`.

### `burnByRole(address from, uint256 amount, string calldata tag)`

Queima `amount` do saldo de `from` **sem** consumir allowance. Usado pelo `BurnTracker` para queimar atomicamente em `burnAndRecord`.

- **Quem chama**: `BURNER_ROLE` (em produção, `BurnTracker`).
- **Reverte**: `ZeroAddress`, `ZeroAmount`, `ERC20InsufficientBalance`.
- **Eventos**: `BurnedByRole(operator, from, amount, tag)` + `Transfer(from, 0, amount)`.

### Funções herdadas relevantes

- **ERC-20**: `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`.
- **ERC20Burnable**: `burn(uint256)` (self-burn), `burnFrom(address, uint256)` (via allowance).
- **AccessControl**: `grantRole`, `revokeRole`, `renounceRole`, `hasRole`, `getRoleAdmin`, `supportsInterface`.

## Eventos

| Evento | Emitido em | Parâmetros indexados |
|---|---|---|
| `GenesisMinted(to, amount)` | `mintGenesis` | `to` |
| `Minted(to, amount, tag)` | `mint` | `to` |
| `BurnedByRole(operator, from, amount, tag)` | `burnByRole` | `operator`, `from` |
| `Transfer(from, to, value)` | herdado | `from`, `to` |
| `RoleGranted/RoleRevoked/RoleAdminChanged` | AccessControl | — |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `to` ou `from` é zero em operações que exigem válido |
| `ZeroAmount()` | `amount == 0` |
| `GenesisAlreadyMinted()` | `mintGenesis` segunda tentativa |
| OZ | `ERC20InsufficientBalance`, `ERC20InsufficientAllowance`, `AccessControlUnauthorizedAccount`, etc. |

## Invariantes

- **Genesis one-shot**: `mintGenesis` só executa uma vez por lifetime do contrato.
- **`MINTER_ROLE` gate**: `mint` exige role; em produção, só `RewardDistributor`.
- **`BURNER_ROLE` gate**: `burnByRole` exige role; em produção, só `BurnTracker`.
- **Supply elástico**: cresce com `mint`/`mintGenesis`; cai com `burn`/`burnFrom`/`burnByRole`. Sem cap hardcoded.
- **CEI aplicado**: `burnByRole` é checks → effect (`_burn` nativo) → sem interaction externa. Sem callback no `_burn`.

## Observações importantes

### Por que `burnByRole` em vez de `burnFrom` com allowance?

`FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole` é um caminho de **1 tx** do usuário. Se fosse via `burnFrom`, usuário precisaria:

1. `approve(burnTracker, amount)` — tx 1.
2. Chamar alguma função que acione `burnTracker.burnFrom(user, ...)` — tx 2.

Quebraria UX e abriria janela de front-run entre approve e burn. O caminho com role é seguro porque a role só é concedida a contratos específicos via proposta + Timelock.

O caminho via allowance (`burnFrom`) continua disponível para quem quer controle explícito de consentimento.

### Não herda `ERC20Permit` nem `ERC20Votes`

Decisão consciente para v1:

- CREDIT não vota. Se votasse, misturaria governança com uso operacional.
- Permit pode ser útil mas não é necessário no fluxo atual (allowance na tx do app).

Se permit virar necessário em v2, basta adicionar `ERC20Permit` como extensão preservando o storage layout.

### Gerenciamento de roles

O `DEFAULT_ADMIN_ROLE` tem poder de conceder/revogar `MINTER_ROLE` e `BURNER_ROLE`. Em produção, esse poder é do Timelock — qualquer mudança de minter/burner passa por proposta.

---

**Ver também**: [RewardDistributor](07-RewardDistributor.md), [BurnTracker](06-BurnTracker.md).
