# CreditToken (CREDIT)

**Para quem é:** devs/auditores.

Contrato: `contracts/CreditToken.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Token utilitário ERC-20 do protocolo — o **trilho de pagamento estável** do modelo vigente (remodel 2026-07-08). CREDIT vale 1:1 USDC porque só entra e sai de circulação pelo [CreditPSM](03-CreditPSM.md): `buy` minta contra USDC depositado, `sell` queima devolvendo USDC. Sem cap hardcoded — a expansão/contração do supply é 100% lastreada no PSM.

No modelo vigente, **apenas o `CreditPSM` detém `MINTER_ROLE` e `BURNER_ROLE`**. Nenhum outro contrato cunha ou queima CREDIT. O caminho `burnByRole` (queima sem allowance) é usado pelo PSM para queimar CREDIT que já está no próprio saldo do PSM (após o `transferFrom` do vendedor) — a role nunca toca saldo de terceiros.

Herança: `ERC20`, `ERC20Burnable`, `AccessControl`.

## Interface pública

### Roles / storage

| Nome | Tipo | Valor | Descrição |
|---|---|---|---|
| `MINTER_ROLE` | `bytes32 constant` | `keccak256("MINTER_ROLE")` | Autoriza `mint`. Produção: apenas o `CreditPSM`. |
| `BURNER_ROLE` | `bytes32 constant` | `keccak256("BURNER_ROLE")` | Autoriza `burnByRole` (queima sem allowance). Produção: apenas o `CreditPSM`. |
| `genesisMinted` | `bool public` | `false` no deploy | Flag one-shot; impede re-execução de `mintGenesis`. |

### Constructor

```solidity
constructor(string name_, string symbol_, address initialAdmin)
```
`initialAdmin` recebe `DEFAULT_ADMIN_ROLE`. Reverte com `ZeroAddress` se `initialAdmin == 0`. Nada é cunhado no constructor.

### Funções

```solidity
function mintGenesis(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE)
```
Cunhagem única de genesis (`amount` e `to` são parâmetros, sem hardcode). One-shot via `genesisMinted`. **Não** consome `MINTER_ROLE`. Emite `GenesisMinted` + `Transfer(0, to, amount)`.

```solidity
function mint(address to, uint256 amount, string calldata tag) external onlyRole(MINTER_ROLE)
```
Cunha `amount` para `to`. Sem cap on-chain. Produção: chamado só pelo `CreditPSM` em `buy` (tag `"psm:buy"`). Emite `Minted` + `Transfer(0, to, amount)`.

```solidity
function burnByRole(address from, uint256 amount, string calldata tag) external onlyRole(BURNER_ROLE)
```
Queima `amount` de `from` **sem** consumir allowance. Produção: chamado só pelo `CreditPSM` em `sell` (tag `"psm:sell"`), sempre sobre o saldo do próprio PSM. Emite `BurnedByRole` + `Transfer(from, 0, amount)`.

### Herdadas relevantes

- **ERC-20:** `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`, `name`, `symbol`, `decimals`.
- **ERC20Burnable:** `burn(uint256)` (self-burn), `burnFrom(address, uint256)` (via allowance).
- **AccessControl:** `grantRole`, `revokeRole`, `renounceRole`, `hasRole`, `getRoleAdmin`, `supportsInterface`.

## Eventos

| Evento | Emitido em | Indexados |
|---|---|---|
| `GenesisMinted(address to, uint256 amount)` | `mintGenesis` | `to` |
| `Minted(address to, uint256 amount, string tag)` | `mint` | `to` |
| `BurnedByRole(address operator, address from, uint256 amount, string tag)` | `burnByRole` | `operator`, `from` |
| `Transfer` / `Approval` | herdados ERC-20 | — |
| `RoleGranted` / `RoleRevoked` / `RoleAdminChanged` | `AccessControl` | conforme OZ |

## Erros

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `to`/`from`/`initialAdmin` é `address(0)` |
| `ZeroAmount()` | `amount == 0` |
| `GenesisAlreadyMinted()` | segunda chamada a `mintGenesis` |
| herdados OZ | `ERC20InsufficientBalance`, `ERC20InsufficientAllowance`, `AccessControlUnauthorizedAccount`, etc. |

## Roles

| Role | Produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` (após handoff). Gerencia as demais roles via proposta. |
| `MINTER_ROLE` | Apenas o `CreditPSM`. |
| `BURNER_ROLE` | Apenas o `CreditPSM`. |

## Invariantes

- **Genesis one-shot:** `mintGenesis` executa no máximo uma vez.
- **Lastro via PSM:** no modelo vigente só o `CreditPSM` cunha/queima CREDIT, o que mantém `totalSupply` de CREDIT em circulação alinhado ao USDC retido no PSM (ver invariantes I-PSM1/I-PSM2 do [CreditPSM](03-CreditPSM.md)).
- **`burnByRole` seguro:** só o PSM detém a role e só queima o próprio saldo; o gate é revogável pelo admin (Timelock).
- **CEI em `burnByRole`:** checks → `_burn` → sem interação externa.
- **CREDIT não vota:** não herda `ERC20Votes` (separação governança × uso operacional). Não herda `ERC20Permit`.

## Ver também

[CreditPSM](03-CreditPSM.md) · [FeeRouterV2](06-FeeRouterV2.md) · [GovernanceToken](01-GovernanceToken.md)
