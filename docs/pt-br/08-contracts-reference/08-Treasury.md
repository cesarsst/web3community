# Treasury

**Para quem é:** devs/auditores.

Contrato: `contracts/Treasury.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

**Cofre simples multi-ativo** da DAO (reescrito no remodel 2026-07-08). Recebe a fatia da fee do [FeeRouterV2](06-FeeRouterV2.md) (40% da fee com os parâmetros default) e quaisquer outros ativos que a comunidade acumule. A **única via de saída** é `GOVERNANCE_ROLE` — em produção o `CommunityTimelock`, ou seja, toda saída passa por proposta aprovada.

Sem oracle, sem POL, sem buyback interno, sem rebates, sem sweep. Buyback de GOV, quando a DAO decidir, é executado por governança gastando os fundos daqui. O lastro do [CreditPSM](03-CreditPSM.md) **não** fica aqui — é segregado no próprio PSM.

Herança: `AccessControl`, `ReentrancyGuard`. Usa `SafeERC20`.

## Interface pública

### Roles

| Nome | Valor | Descrição |
|---|---|---|
| `GOVERNANCE_ROLE` | `keccak256("GOVERNANCE_ROLE")` | Única role capaz de movimentar fundos. Produção: Timelock. |

### Constructor

```solidity
constructor(address admin)   // reverte ZeroAddress; concede DEFAULT_ADMIN_ROLE + GOVERNANCE_ROLE a admin
```

### Entrada

```solidity
receive() external payable   // aceita ETH; emite EthReceived
```

### Saídas (`onlyRole(GOVERNANCE_ROLE) nonReentrant`)

```solidity
function transfer(IERC20 token, address to, uint256 amount) external
```
Transfere `amount` de `token` para `to`. Reverte `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`. Emite `TokenTransferred`.

```solidity
function transferETH(address payable to, uint256 amount) external
```
Transfere `amount` de ETH para `to` (via `call`). Reverte `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `EthTransferFailed`. Emite `EthTransferred`.

### Views

```solidity
function balanceOf(IERC20 token) external view returns (uint256)   // saldo de um ERC20 no cofre
function ethBalance() external view returns (uint256)             // saldo de ETH no cofre
```

## Eventos

| Evento | Emitido em | Indexados |
|---|---|---|
| `TokenTransferred(address token, address to, uint256 amount)` | `transfer` | `token`, `to` |
| `EthTransferred(address to, uint256 amount)` | `transferETH` | `to` |
| `EthReceived(address from, uint256 amount)` | `receive` | `from` |

## Erros

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `to`/`admin` é `address(0)` |
| `ZeroAmount()` | `amount == 0` |
| `InsufficientBalance(uint256 requested, uint256 available)` | saída maior que o saldo (ERC20 ou ETH) |
| `EthTransferFailed(address to, uint256 amount)` | `call` de ETH retornou falso |

## Roles

| Role | Produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` — existe só para gerir roles (padrão OZ). |
| `GOVERNANCE_ROLE` | `CommunityTimelock` — única capaz de movimentar fundos. |

No deploy o admin é transferido ao Timelock e o deployer renuncia. Alterar quem detém essas roles no Treasury exige **supermaioria de 75%** no [CommunityGovernor](10-CommunityGovernor.md).

## Invariantes

- **Saída só por governança:** `transfer`/`transferETH` são `onlyRole(GOVERNANCE_ROLE)`; em produção só o Timelock (proposta aprovada) satisfaz o gate.
- **Sem superfície econômica:** não há oracle/POL/buyback/rebates/sweep — cofre auditável e sem vetor de ataque econômico. Buyback de GOV é decisão de governança sobre estes fundos.
- **Lastro segregado:** o USDC do `CreditPSM` não passa por aqui.
- **CEI + `nonReentrant`** nas saídas.

## Ver também

[FeeRouterV2](06-FeeRouterV2.md) · [CommunityGovernor](10-CommunityGovernor.md) · [CommunityTimelock](09-CommunityTimelock.md)
