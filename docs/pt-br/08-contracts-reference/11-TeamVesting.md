# TeamVesting

**Para quem é:** devs/auditores.

Contrato: `contracts/TeamVesting.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Cofre de **vesting linear com cliff** para distribuir GOV a um único beneficiário do time. Padrão de deploy: uma instância por membro (ou grupo custodiado por multi-sig) — simplifica contabilidade e isola revogação (a DAO revoga só aquela instância).

Convenções: `start` = início do vesting (normalmente TGE); `cliff` = offset em segundos a partir de `start` (antes de `start + cliff`, releasable = 0); `duration` = duração total em segundos (inclui o cliff). No cliff, libera-se `cliff / duration` da alocação de uma vez (padrão "hockey stick"); depois de `start + duration`, tudo está vested.

A alocação é dinâmica: `totalAllocation() = balanceOf(this) + released`. O owner (Timelock) funda o contrato transferindo GOV após o deploy.

Herança: `Ownable2Step`. Usa `SafeERC20`.

## Interface pública

### Immutables

| Nome | Tipo | Descrição |
|---|---|---|
| `token` | `IERC20 immutable public` | Token em vesting (GOV). |
| `beneficiary` | `address immutable public` | Recebe os releases. |
| `start` | `uint64 immutable public` | Início do cronograma (unix seconds). |
| `cliff` | `uint64 immutable public` | Offset do cliff a partir de `start`. |
| `duration` | `uint64 immutable public` | Duração total (inclui o cliff). |

### Storage

| Nome | Tipo | Descrição |
|---|---|---|
| `released` | `uint256 public` | Total já sacado via `release`. |
| `revoked` | `bool public` | `true` após `revoke`. |
| `revokedAt` | `uint64 public` | Timestamp do revoke (0 se não revogado). |
| `totalAllocatedAtRevoke` | `uint256 public` | Fronteira de vesting travada no revoke. |

### Constructor

```solidity
constructor(address token_, address beneficiary_, uint64 start_, uint64 cliff_, uint64 duration_, address owner_)
```
Reverte `ZeroAddress`, `ZeroDuration` (`duration_ == 0`), `CliffExceedsDuration` (`cliff_ > duration_`). Não valida que `start` é futuro (permite reconhecer serviço anterior ao TGE).

### Views

```solidity
function vestedAmount(uint64 timestamp) public view returns (uint256)  // após revoke: totalAllocatedAtRevoke
function releasable() public view returns (uint256)                    // vested(now) - released
function totalAllocation() public view returns (uint256)               // balanceOf+released, ou fronteira travada
```

### Mutações

```solidity
function release() external
```
Saca tudo que está releasable para `beneficiary` (pull-based: qualquer um chama, mas os tokens sempre vão para o beneficiário). Reverte `NothingToRelease`. Emite `Released`. CEI: `released += amount` antes do `safeTransfer`.

```solidity
function revoke(address returnTo) external onlyOwner
```
Revoga o vesting (one-shot). Congela `vestedAmount` em `vestedAmount(now)` e devolve o saldo não-vested a `returnTo` (Treasury). **Não** transfere o vested-but-unreleased ao beneficiário — este deve chamar `release`. Reverte `AlreadyRevoked`, `ZeroAddress`. Emite `Revoked`.

### Herdadas (Ownable2Step)

`transferOwnership(newOwner)`, `acceptOwnership()`, `owner()`, `pendingOwner()`.

## Eventos

| Evento | Emitido em | Indexados |
|---|---|---|
| `Released(address beneficiary, uint256 amount)` | `release` | `beneficiary` |
| `Revoked(address returnedTo, uint256 unvestedReturned, uint256 frozenVested)` | `revoke` | `returnedTo` |
| `OwnershipTransferStarted` / `OwnershipTransferred` | herdados | conforme OZ |

## Erros

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `token_`/`beneficiary_`/`returnTo` é `address(0)` |
| `ZeroDuration()` | `duration_ == 0` |
| `CliffExceedsDuration()` | `cliff_ > duration_` |
| `NothingToRelease()` | `release` sem valor releasable |
| `AlreadyRevoked()` | segunda chamada a `revoke` |

## Roles

Sem `AccessControl`. Usa `Ownable2Step`:

- `owner` — pode `revoke`. Produção: `CommunityTimelock` (via proposta).
- `beneficiary` — imutável; destino fixo dos releases.

## Invariantes

- **Fórmula linear (padrão OZ):** `vested(t) = 0` antes de `start+cliff`; `= total` após `start+duration`; senão `total * (t - start) / duration`.
- **Revoke one-shot e imutável:** após `revoke`, `vestedAmount` fica travado em `totalAllocatedAtRevoke` — o cronograma não retoma mesmo que mais tokens sejam enviados.
- **`released` preservado no revoke:** `released <= totalAllocatedAtRevoke` sempre (qualquer saque passado teve `released <= vestedAmount(t) <= vestedAmount(now)`).
- **Pull-based:** `release` transfere sempre para `beneficiary`; `revoke` não faz push surpresa ao beneficiário.
- **Não pausável:** para "pausar", a DAO aprova um `revoke` (semanticamente mais honesto).

## Ver também

[GovernanceToken](01-GovernanceToken.md) · [Treasury](08-Treasury.md) · [CommunityTimelock](09-CommunityTimelock.md)
