# GovernanceToken

**Para quem é:** devs integrando com o token de governança ou auditores.
**Pré-requisitos:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## Visão rápida

Token ERC-20 com extensão `ERC20Votes` (ERC-5805) e supply cap imutável de 100M. É o token de governança e colateral de staking do protocolo. Owner em produção é o `CommunityTimelock` (após `acceptOwnership`) — toda cunhagem requer proposta aprovada pela DAO.

**Não pré-minta no constructor**: o supply começa em zero. Toda distribuição (30% treasury / 25% team / 20% sale / 15% community / 10% liquidity, ou qualquer variação aprovada) acontece via propostas que chamam `mint`.

## Herança

```
ERC20 (OZ)
ERC20Permit (OZ, EIP-2612)
ERC20Votes (OZ, ERC-5805 snapshotting via Checkpoints)
Ownable2Step (OZ, transferência de owner 2-step)
```

## Parâmetros e storage

| Nome | Tipo | Valor | Descrição |
|---|---|---|---|
| `CAP_SUPPLY` | `uint256` immutable | 100_000_000 * 1e18 | Supply máximo absoluto. Aplicado em `_update`. |
| `name` | ERC-20 | "Web3Community Governance" (produção) | Usado no EIP-712 do `permit` e `delegateBySig`. **Não alterável** sem quebrar assinaturas passadas. |
| `symbol` | ERC-20 | "GOV" (produção) | — |

## Roles e permissões

Sem AccessControl. Usa `Ownable2Step`:

- `owner` — único permitido a chamar `mint`. Em produção: `CommunityTimelock`.
- `pendingOwner` — setado em `transferOwnership(newOwner)`; consolidação só com `acceptOwnership` pelo `pendingOwner`.

## Funções externas

### `mint(address to, uint256 amount, string calldata tag)`

Cunha `amount` para `to`, aplicando o cap imutável.

- **Quem chama**: apenas o `owner`.
- **Reverte**:
  - `ZeroAddress` se `to == address(0)`.
  - `ZeroAmount` se `amount == 0`.
  - `CapExceeded(attempted, cap)` se `totalSupply + amount > CAP_SUPPLY`.
- **Eventos**: `Minted(to, amount, tag)` + `Transfer(0, to, amount)`.
- **Uso**: proposta da DAO → Timelock.execute → `mint`.

### `cap() → uint256`

Retorna `CAP_SUPPLY`. View.

### `nonces(address owner) → uint256`

Retorna nonce atual. Usado por `permit` e `delegateBySig`. Herdado de `ERC20Permit` + `Nonces`.

### Funções herdadas relevantes

- **ERC-20**: `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`.
- **ERC20Permit**: `permit(owner, spender, value, deadline, v, r, s)` — approve gasless.
- **ERC20Votes**: `delegate(delegatee)`, `delegateBySig(...)`, `getVotes(account)`, `getPastVotes(account, timepoint)`, `getPastTotalSupply(timepoint)`, `delegates(account)`, `checkpoints(account, pos)`, `numCheckpoints(account)`.
- **Ownable2Step**: `transferOwnership(newOwner)`, `acceptOwnership()`, `owner()`, `pendingOwner()`.

## Eventos

| Evento | Emitido em | Parâmetros indexados |
|---|---|---|
| `Minted(to, amount, tag)` | `mint` | `to` |
| `Transfer(from, to, value)` | herdado ERC-20 | `from`, `to` |
| `Approval(owner, spender, value)` | herdado ERC-20 | `owner`, `spender` |
| `DelegateChanged(delegator, fromDelegate, toDelegate)` | `delegate` / `delegateBySig` | `delegator`, `fromDelegate`, `toDelegate` |
| `DelegateVotesChanged(delegate, previousBalance, newBalance)` | qualquer alteração que afete um delegate | `delegate` |
| `OwnershipTransferStarted(previousOwner, newOwner)` | `transferOwnership` | `previousOwner`, `newOwner` |
| `OwnershipTransferred(previousOwner, newOwner)` | `acceptOwnership` | `previousOwner`, `newOwner` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `CapExceeded(attemptedSupply, cap)` | `_update` recebe mint que excederia `CAP_SUPPLY` |
| `ZeroAddress()` | `mint` com `to == 0` |
| `ZeroAmount()` | `mint` com `amount == 0` |
| herdados OZ | `ERC20InsufficientBalance`, `ERC20InvalidSender`, `ERC20InvalidReceiver`, `ERC20InsufficientAllowance`, `ERC20InvalidApprover`, `ERC20InvalidSpender`, `ERC2612ExpiredSignature`, `ERC2612InvalidSigner`, `VotesExpiredSignature`, `InvalidAccountNonce`, `CheckpointUnorderedInsertion`, `OwnableInvalidOwner`, `OwnableUnauthorizedAccount` |

## Invariantes

- **I1 (Cap)**: `totalSupply() <= CAP_SUPPLY` em todo instante. Enforced em `_update` com revert `CapExceeded`.
- **I5 (Anti-flashloan)**: voto via `getPastVotes` (snapshot). Flash-loan no bloco atual não afeta snapshot passado.
- **Ownership**: só o `owner` cunha. Em produção, `owner` é o Timelock.
- **Domain separator**: `name` usado no EIP-712 é fixo no constructor — não mude sem estratégia de migração.

## Observações importantes

### Relacionamento com ERC20Votes `_maxSupply`

O `GovernanceToken` sobrescreve `_maxSupply` para retornar `CAP_SUPPLY`, garantindo que o check interno de `ERC20Votes` (que previne overflow uint208) também respeite o cap do projeto. Como `100M * 1e18 = 1e26` cabe confortavelmente em `uint208 (~4.11e62)`, não há conflito prático.

### Strategy de deploy

O deploy `Dao.ts`:

1. Deploya com `initialOwner = deployer`.
2. Deployer concede `MINTER_ROLE` em CreditToken, etc.
3. Deployer chama `transferOwnership(timelock)`.
4. Timelock fica como `pendingOwner`.
5. **Primeira proposta obrigatória em mainnet**: chamar `acceptOwnership()` pelo Timelock, consolidando a transferência.

Até a 5ª etapa acontecer, o deployer ainda é `owner` — é a janela crítica documentada em [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

### Uso com `TeamVesting`

Propostas de vesting transferem GOV do Treasury (ou cunham direto) para uma instância de `TeamVesting`. O vesting libera gradualmente para o beneficiário.

### Ausência de `burn`

GOV **não** é queimável. Não herda `ERC20Burnable`. O cap de 100M é o máximo absoluto — supply só pode crescer até o cap ou ficar igual.

---

**Ver também**: [CommunityGovernor](10-CommunityGovernor.md), [Staking](05-Staking.md).
