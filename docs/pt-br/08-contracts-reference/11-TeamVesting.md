# TeamVesting

**Para quem é:** auditores, beneficiários, equipe operacional do protocolo.
**Pré-requisitos:** [Tokenomics](../06-for-investors/01-tokenomics.md).

## Visão rápida

Cofre de vesting linear com cliff para distribuir GOV a **um único beneficiário**. Padrão: uma instância por membro do time (ou grupo custodiado por multi-sig). Simplifica contabilidade off-chain e isola revogação — se alguém sai, a DAO revoga somente aquela instância.

Formula OZ padrão: `vested(t) = total * (t - start) / duration`, zero antes do cliff, "hockey stick" no cliff (libera `cliff/duration` de uma vez).

## Herança

```
Ownable2Step (OZ)
```

Usa `SafeERC20`.

## Parâmetros (via constructor, immutable)

| Nome | Tipo | Descrição |
|---|---|---|
| `token` | IERC20 | Token sendo vested (produção: GOV) |
| `beneficiary` | address | Quem recebe os releases |
| `start` | uint64 | Timestamp início do cronograma |
| `cliff` | uint64 | Offset em segundos a partir de `start`. Antes do cliff, releasable = 0 |
| `duration` | uint64 | Duração TOTAL em segundos (inclui cliff) |

### Storage mutável

| Nome | Tipo | Descrição |
|---|---|---|
| `released` | uint256 | Total já sacado |
| `revoked` | bool | true após primeira chamada a `revoke` |
| `revokedAt` | uint64 | timestamp do revoke |
| `totalAllocatedAtRevoke` | uint256 | Fronteira congelada pós-revoke |

### Exemplo de parâmetros (proposta típica)

```
start    = TGE timestamp
cliff    = 365 days
duration = 4 * 365 days  (12m cliff + 36m linear = 48m total)
```

No `start + 12m`, libera 25% de uma vez. Depois pinga linearmente até `start + 48m`.

## Roles e permissões

- `owner` — em produção: `CommunityTimelock`. Único que pode `revoke`.
- `beneficiary` — imutável. Sempre recebe os tokens em `release`.

## Funções externas

### `release()`

Saca tudo que está `releasable` para o `beneficiary`.

- **Quem chama**: qualquer um (o pagamento vai para `beneficiary` independentemente).
- **Reverte**: `NothingToRelease` se `releasable() == 0`.
- **Eventos**: `Released(beneficiary, amount)`.

### `revoke(address returnTo)`

Revoga o vesting. **One-shot** — segunda chamada reverte.

- **Quem chama**: `owner` (Timelock via proposta em produção).
- **Reverte**: `AlreadyRevoked`, `ZeroAddress` (returnTo).
- **Eventos**: `Revoked(returnTo, unvestedReturned, frozenVested)`.

Efeitos:

1. `revoked = true`, `revokedAt = now`, `totalAllocatedAtRevoke = vestedAmount(now)`.
2. Transfere `unvested` para `returnTo` (tipicamente Treasury).
3. `vestedAmount` futuro retorna sempre `totalAllocatedAtRevoke`.

Beneficiário continua podendo chamar `release` para sacar vested-but-unreleased existente.

### Views

- `vestedAmount(uint64 timestamp) → uint256` — total vested em `timestamp`. Pós-revoke retorna `totalAllocatedAtRevoke`.
- `releasable() → uint256` — `vestedAmount(now) - released`.
- `totalAllocation() → uint256` — alocação total reconhecida. Antes de revoke: `balanceOf(this) + released`. Após revoke: `totalAllocatedAtRevoke`.

### Herdadas (Ownable2Step)

- `transferOwnership(newOwner)`.
- `acceptOwnership()`.
- `owner() → address`.
- `pendingOwner() → address`.

## Eventos

| Evento | Indexados |
|---|---|
| `Released(beneficiary, amount)` | `beneficiary` |
| `Revoked(returnTo, unvestedReturned, frozenVested)` | `returnTo` |
| `OwnershipTransferStarted(previousOwner, newOwner)` | `previousOwner`, `newOwner` |
| `OwnershipTransferred(previousOwner, newOwner)` | `previousOwner`, `newOwner` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `token`, `beneficiary` ou `returnTo` zero |
| `ZeroDuration()` | `duration == 0` (divisão por zero) |
| `CliffExceedsDuration()` | `cliff > duration` |
| `NothingToRelease()` | `releasable() == 0` |
| `AlreadyRevoked()` | Segunda chamada a `revoke` |

## Invariantes

- **Allocation capturada dinamicamente**: `totalAllocation() = balanceOf(this) + released` (pre-revoke). Transferências adicionais pós-deploy aumentam alocação.
- **Revoke congela fronteira**: após revoke, `vestedAmount` retorna sempre `totalAllocatedAtRevoke`. Transferências pós-revoke **não** aumentam vested.
- **Pull-based release**: qualquer um chama, tokens sempre vão para `beneficiary`.
- **CEI em `release`**: `released += amount` antes de `safeTransfer`.
- **Revoke one-shot**: flag `revoked` bloqueia re-execução.

## Observações importantes

### Por que Ownable2Step em vez de AccessControl

A autoridade sobre revogação é inerentemente singular (DAO via Timelock) e o 2-step protege contra transferência de propriedade para endereço errado durante migração. AccessControl seria overkill.

### Por que `start` pode ser no passado

A DAO pode deliberadamente iniciar o cronograma no passado — ex.: reconhecimento de serviço anterior ao TGE. Se beneficiário chama `release` logo após deploy e o passado é suficiente, primeiro saque é imediato. Comportamento intencional.

### Nenhum auto-compound / auto-transfer de vested no revoke

`revoke` **não** transfere o vested-but-unreleased para o beneficiário automaticamente. Beneficiário deve chamar `release` para coletar. Essa separação:

- Mantém UX "pull".
- Evita transferência surpresa para `beneficiary` (que pode ser multisig offline no momento da proposta).

### Instância por membro

Padrão de deploy: um `TeamVesting` **por** membro do time. Razões:

- **Isolamento**: revogar um não afeta os outros.
- **Contabilidade**: 1 instância = 1 cronograma, fácil de auditar.
- **Parâmetros individuais**: cliff/duration podem variar por pessoa.

### Sem pause

Mesma racional do Treasury. Se necessário "pausar", a DAO aprova `revoke` — semanticamente mais honesto.

### Formula detalhada

```
vested(t) = 0                                 se t < start + cliff
vested(t) = total                             se t >= start + duration
vested(t) = total * (t - start) / duration    caso contrario
```

`total = balanceOf(this) + released` (pre-revoke) ou `totalAllocatedAtRevoke` (pós-revoke).

### Cuidado com transferências adicionais

Se a DAO (via Treasury) transfere mais GOV para a instância após o start, o `totalAllocation` sobe automaticamente. Isso raramente é desejável — evite enviar transferências posteriores à funded.

---

**Ver também**: [GovernanceToken](01-GovernanceToken.md), [Treasury](04-Treasury.md).
