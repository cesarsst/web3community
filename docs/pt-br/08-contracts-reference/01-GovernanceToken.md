# GovernanceToken (GOV)

**Para quem é:** devs/auditores.

Contrato: `contracts/GovernanceToken.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Token de governança e colateral do protocolo. ERC-20 com voto on-chain (`ERC20Votes`, ERC-5805) e **supply cap imutável de 100.000.000 GOV**. O owner controla a cunhagem; em produção o owner é o `CommunityTimelock` (transferência em 2 passos via `Ownable2Step`), então todo mint passa por proposta aprovada na DAO.

Não pré-minta no constructor: `totalSupply()` começa em 0. Toda distribuição acontece via chamadas explícitas de `mint`.

Herança: `ERC20`, `ERC20Permit` (EIP-2612), `ERC20Votes`, `Ownable2Step`.

## Interface pública

### Constantes / immutables

| Nome | Tipo | Valor | Descrição |
|---|---|---|---|
| `CAP_SUPPLY` | `uint256 immutable public` | `100_000_000 * 10**18` | Supply máximo absoluto. Fixado no constructor; cabe em `uint208` do `ERC20Votes`. |

### Constructor

```solidity
constructor(string name_, string symbol_, address initialOwner)
```

`initialOwner` recebe o poder de cunhar. Em produção é o deployer temporariamente, depois transferido ao Timelock.

### Funções

```solidity
function mint(address to, uint256 amount, string calldata tag) external onlyOwner
```
Cunha `amount` para `to`. `tag` é apenas rótulo off-chain (via evento), não afeta contabilidade. Emite `Minted` + `Transfer(0, to, amount)`.

```solidity
function cap() external view returns (uint256)            // retorna CAP_SUPPLY
function nonces(address ownerAddr) public view returns (uint256)  // nonce de permit/delegateBySig
```

### Herdadas relevantes

- **ERC-20:** `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`, `name`, `symbol`, `decimals`.
- **ERC20Permit:** `permit(owner, spender, value, deadline, v, r, s)`, `DOMAIN_SEPARATOR()`.
- **ERC20Votes:** `delegate(delegatee)`, `delegateBySig(...)`, `getVotes(account)`, `getPastVotes(account, timepoint)`, `getPastTotalSupply(timepoint)`, `delegates(account)`, `checkpoints(account, pos)`, `numCheckpoints(account)`, `clock()`, `CLOCK_MODE()`.
- **Ownable2Step:** `transferOwnership(newOwner)`, `acceptOwnership()`, `owner()`, `pendingOwner()`.

## Eventos

| Evento | Emitido em | Indexados |
|---|---|---|
| `Minted(address to, uint256 amount, string tag)` | `mint` | `to` |
| `Transfer` / `Approval` | herdados ERC-20 | — |
| `DelegateChanged` / `DelegateVotesChanged` | delegação / mudança de saldo | conforme OZ |
| `OwnershipTransferStarted` / `OwnershipTransferred` | `transferOwnership` / `acceptOwnership` | conforme OZ |

## Erros

| Erro | Quando ocorre |
|---|---|
| `CapExceeded(uint256 attemptedSupply, uint256 cap)` | mint que ultrapassaria `CAP_SUPPLY` (checado em `_update`) |
| `ZeroAddress()` | `mint` com `to == address(0)` |
| `ZeroAmount()` | `mint` com `amount == 0` |
| herdados OZ | `ERC20InsufficientBalance`, `ERC20InsufficientAllowance`, `ERC2612ExpiredSignature`, `VotesExpiredSignature`, `OwnableUnauthorizedAccount`, entre outros |

## Roles

Sem `AccessControl`. Usa `Ownable2Step`:

- `owner` — único endereço autorizado a `mint`. Produção: `CommunityTimelock`.
- `pendingOwner` — setado por `transferOwnership`; consolida só via `acceptOwnership` chamado pelo próprio pendingOwner.

## Invariantes

- **I1 (cap):** `totalSupply() <= CAP_SUPPLY` sempre. Enforced em `_update` — mint acima reverte com `CapExceeded`. `_maxSupply()` também retorna `CAP_SUPPLY`, mantendo a proteção interna do `ERC20Votes` alinhada ao cap do projeto.
- **I5 (anti-flashloan):** voto lido via snapshot (`getPastVotes`), nunca `balanceOf` corrente — flash loan no bloco atual não altera snapshot passado.
- **Ownership:** apenas o `owner` cunha; em produção é o Timelock.
- **Domain separator:** `name` do EIP-712 é fixado no constructor — alterá-lo invalida assinaturas passadas de `permit` / `delegateBySig`.
- **Sem burn:** GOV não herda `ERC20Burnable`; supply só cresce até o cap.

## Ver também

[CreditToken](02-CreditToken.md) · [Staking](05-Staking.md) · [CommunityGovernor](10-CommunityGovernor.md) · [TeamVesting](11-TeamVesting.md)
