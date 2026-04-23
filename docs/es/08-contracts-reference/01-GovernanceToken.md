# GovernanceToken

**Audiencia:** devs integrando con el token de gobernanza o auditores.
**Requisitos previos:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## Visión rápida

Token ERC-20 con extensión `ERC20Votes` (ERC-5805) y supply cap inmutable de 100M. Es el token de gobernanza y colateral de staking del protocolo. Owner en producción es el `CommunityTimelock` (tras `acceptOwnership`) — toda acuñación requiere propuesta aprobada por la DAO.

**No pre-mintea en el constructor**: el supply comienza en cero. Toda distribución (30% treasury / 25% team / 20% sale / 15% community / 10% liquidity, o cualquier variación aprobada) ocurre vía propuestas que llaman a `mint`.

## Herencia

```
ERC20 (OZ)
ERC20Permit (OZ, EIP-2612)
ERC20Votes (OZ, ERC-5805 snapshotting via Checkpoints)
Ownable2Step (OZ, transferencia de owner 2-step)
```

## Parámetros y storage

| Nombre | Tipo | Valor | Descripción |
|---|---|---|---|
| `CAP_SUPPLY` | `uint256` immutable | 100_000_000 * 1e18 | Supply máximo absoluto. Aplicado en `_update`. |
| `name` | ERC-20 | "Web3Community Governance" (producción) | Usado en el EIP-712 del `permit` y `delegateBySig`. **No alterable** sin romper firmas pasadas. |
| `symbol` | ERC-20 | "GOV" (producción) | — |

## Roles y permisos

Sin AccessControl. Usa `Ownable2Step`:

- `owner` — único permitido para llamar a `mint`. En producción: `CommunityTimelock`.
- `pendingOwner` — seteado en `transferOwnership(newOwner)`; consolidación solo con `acceptOwnership` por el `pendingOwner`.

## Funciones externas

### `mint(address to, uint256 amount, string calldata tag)`

Acuña `amount` para `to`, aplicando el cap inmutable.

- **Quién llama**: solo el `owner`.
- **Revierte**:
  - `ZeroAddress` si `to == address(0)`.
  - `ZeroAmount` si `amount == 0`.
  - `CapExceeded(attempted, cap)` si `totalSupply + amount > CAP_SUPPLY`.
- **Eventos**: `Minted(to, amount, tag)` + `Transfer(0, to, amount)`.
- **Uso**: propuesta de la DAO → Timelock.execute → `mint`.

### `cap() → uint256`

Retorna `CAP_SUPPLY`. View.

### `nonces(address owner) → uint256`

Retorna nonce actual. Usado por `permit` y `delegateBySig`. Heredado de `ERC20Permit` + `Nonces`.

### Funciones heredadas relevantes

- **ERC-20**: `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`.
- **ERC20Permit**: `permit(owner, spender, value, deadline, v, r, s)` — approve gasless.
- **ERC20Votes**: `delegate(delegatee)`, `delegateBySig(...)`, `getVotes(account)`, `getPastVotes(account, timepoint)`, `getPastTotalSupply(timepoint)`, `delegates(account)`, `checkpoints(account, pos)`, `numCheckpoints(account)`.
- **Ownable2Step**: `transferOwnership(newOwner)`, `acceptOwnership()`, `owner()`, `pendingOwner()`.

## Eventos

| Evento | Emitido en | Parámetros indexados |
|---|---|---|
| `Minted(to, amount, tag)` | `mint` | `to` |
| `Transfer(from, to, value)` | heredado ERC-20 | `from`, `to` |
| `Approval(owner, spender, value)` | heredado ERC-20 | `owner`, `spender` |
| `DelegateChanged(delegator, fromDelegate, toDelegate)` | `delegate` / `delegateBySig` | `delegator`, `fromDelegate`, `toDelegate` |
| `DelegateVotesChanged(delegate, previousBalance, newBalance)` | cualquier alteración que afecte a un delegate | `delegate` |
| `OwnershipTransferStarted(previousOwner, newOwner)` | `transferOwnership` | `previousOwner`, `newOwner` |
| `OwnershipTransferred(previousOwner, newOwner)` | `acceptOwnership` | `previousOwner`, `newOwner` |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `CapExceeded(attemptedSupply, cap)` | `_update` recibe mint que excedería `CAP_SUPPLY` |
| `ZeroAddress()` | `mint` con `to == 0` |
| `ZeroAmount()` | `mint` con `amount == 0` |
| heredados OZ | `ERC20InsufficientBalance`, `ERC20InvalidSender`, `ERC20InvalidReceiver`, `ERC20InsufficientAllowance`, `ERC20InvalidApprover`, `ERC20InvalidSpender`, `ERC2612ExpiredSignature`, `ERC2612InvalidSigner`, `VotesExpiredSignature`, `InvalidAccountNonce`, `CheckpointUnorderedInsertion`, `OwnableInvalidOwner`, `OwnableUnauthorizedAccount` |

## Invariantes

- **I1 (Cap)**: `totalSupply() <= CAP_SUPPLY` en todo instante. Enforceado en `_update` con revert `CapExceeded`.
- **I5 (Anti-flashloan)**: voto vía `getPastVotes` (snapshot). Flash-loan en el bloque actual no afecta al snapshot pasado.
- **Ownership**: solo el `owner` acuña. En producción, `owner` es el Timelock.
- **Domain separator**: `name` usado en el EIP-712 es fijo en el constructor — no cambies sin estrategia de migración.

## Observaciones importantes

### Relación con ERC20Votes `_maxSupply`

El `GovernanceToken` sobrescribe `_maxSupply` para retornar `CAP_SUPPLY`, garantizando que el check interno de `ERC20Votes` (que previene overflow uint208) también respete el cap del proyecto. Como `100M * 1e18 = 1e26` cabe cómodamente en `uint208 (~4.11e62)`, no hay conflicto práctico.

### Strategy de deploy

El deploy `Dao.ts`:

1. Deploya con `initialOwner = deployer`.
2. El deployer concede `MINTER_ROLE` en CreditToken, etc.
3. El deployer llama a `transferOwnership(timelock)`.
4. El Timelock queda como `pendingOwner`.
5. **Primera propuesta obligatoria en mainnet**: llamar a `acceptOwnership()` por el Timelock, consolidando la transferencia.

Hasta que la 5ª etapa ocurra, el deployer aún es `owner` — es la ventana crítica documentada en [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

### Uso con `TeamVesting`

Las propuestas de vesting transfieren GOV del Treasury (o acuñan directo) a una instancia de `TeamVesting`. El vesting libera gradualmente al beneficiario.

### Ausencia de `burn`

GOV **no** es quemable. No hereda `ERC20Burnable`. El cap de 100M es el máximo absoluto — el supply solo puede crecer hasta el cap o quedarse igual.

---

**Ver también**: [CommunityGovernor](10-CommunityGovernor.md), [Staking](05-Staking.md).
