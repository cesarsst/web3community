# TeamVesting

**Audiencia:** auditores, beneficiarios, equipo operacional del protocolo.
**Requisitos previos:** [Tokenomics](../06-for-investors/01-tokenomics.md).

## Visión rápida

Cofre de vesting lineal con cliff para distribuir GOV a **un único beneficiario**. Estándar: una instancia por miembro del equipo (o grupo custodiado por multi-sig). Simplifica la contabilidad off-chain y aísla la revocación — si alguien sale, la DAO revoca solo esa instancia.

Fórmula OZ estándar: `vested(t) = total * (t - start) / duration`, cero antes del cliff, "hockey stick" en el cliff (libera `cliff/duration` de una sola vez).

## Herencia

```
Ownable2Step (OZ)
```

Usa `SafeERC20`.

## Parámetros (vía constructor, immutable)

| Nombre | Tipo | Descripción |
|---|---|---|
| `token` | IERC20 | Token en vesting (producción: GOV) |
| `beneficiary` | address | Quien recibe los releases |
| `start` | uint64 | Timestamp de inicio del cronograma |
| `cliff` | uint64 | Offset en segundos a partir de `start`. Antes del cliff, releasable = 0 |
| `duration` | uint64 | Duración TOTAL en segundos (incluye cliff) |

### Storage mutable

| Nombre | Tipo | Descripción |
|---|---|---|
| `released` | uint256 | Total ya retirado |
| `revoked` | bool | true tras la primera llamada a `revoke` |
| `revokedAt` | uint64 | timestamp del revoke |
| `totalAllocatedAtRevoke` | uint256 | Frontera congelada post-revoke |

### Ejemplo de parámetros (propuesta típica)

```
start    = TGE timestamp
cliff    = 365 days
duration = 4 * 365 days  (12m cliff + 36m linear = 48m total)
```

En `start + 12m`, libera 25% de una sola vez. Después gotea linealmente hasta `start + 48m`.

## Roles y permisos

- `owner` — en producción: `CommunityTimelock`. Único que puede `revoke`.
- `beneficiary` — inmutable. Siempre recibe los tokens en `release`.

## Funciones externas

### `release()`

Retira todo lo que está `releasable` para el `beneficiary`.

- **Quién llama**: cualquiera (el pago va al `beneficiary` independientemente).
- **Revierte**: `NothingToRelease` si `releasable() == 0`.
- **Eventos**: `Released(beneficiary, amount)`.

### `revoke(address returnTo)`

Revoca el vesting. **One-shot** — la segunda llamada revierte.

- **Quién llama**: `owner` (Timelock vía propuesta en producción).
- **Revierte**: `AlreadyRevoked`, `ZeroAddress` (returnTo).
- **Eventos**: `Revoked(returnTo, unvestedReturned, frozenVested)`.

Efectos:

1. `revoked = true`, `revokedAt = now`, `totalAllocatedAtRevoke = vestedAmount(now)`.
2. Transfiere `unvested` a `returnTo` (típicamente Treasury).
3. `vestedAmount` futuro retorna siempre `totalAllocatedAtRevoke`.

El beneficiario sigue pudiendo llamar a `release` para retirar vested-but-unreleased existente.

### Views

- `vestedAmount(uint64 timestamp) → uint256` — total vested en `timestamp`. Post-revoke retorna `totalAllocatedAtRevoke`.
- `releasable() → uint256` — `vestedAmount(now) - released`.
- `totalAllocation() → uint256` — asignación total reconocida. Antes de revoke: `balanceOf(this) + released`. Tras revoke: `totalAllocatedAtRevoke`.

### Heredadas (Ownable2Step)

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

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | `token`, `beneficiary` o `returnTo` cero |
| `ZeroDuration()` | `duration == 0` (división por cero) |
| `CliffExceedsDuration()` | `cliff > duration` |
| `NothingToRelease()` | `releasable() == 0` |
| `AlreadyRevoked()` | Segunda llamada a `revoke` |

## Invariantes

- **Allocation capturada dinámicamente**: `totalAllocation() = balanceOf(this) + released` (pre-revoke). Las transferencias adicionales post-deploy aumentan la asignación.
- **Revoke congela la frontera**: tras revoke, `vestedAmount` retorna siempre `totalAllocatedAtRevoke`. Las transferencias post-revoke **no** aumentan vested.
- **Pull-based release**: cualquiera llama, los tokens siempre van al `beneficiary`.
- **CEI en `release`**: `released += amount` antes de `safeTransfer`.
- **Revoke one-shot**: el flag `revoked` bloquea re-ejecución.

## Observaciones importantes

### Por qué Ownable2Step en vez de AccessControl

La autoridad sobre la revocación es inherentemente singular (DAO vía Timelock) y el 2-step protege contra transferencia de propiedad a dirección equivocada durante migración. AccessControl sería overkill.

### Por qué `start` puede ser en el pasado

La DAO puede deliberadamente iniciar el cronograma en el pasado — ej.: reconocimiento de servicio anterior al TGE. Si el beneficiario llama a `release` justo tras el deploy y el pasado es suficiente, el primer retiro es inmediato. Comportamiento intencional.

### Ningún auto-compound / auto-transfer de vested en el revoke

`revoke` **no** transfiere el vested-but-unreleased al beneficiario automáticamente. El beneficiario debe llamar a `release` para recolectar. Esa separación:

- Mantiene UX "pull".
- Evita transferencia sorpresa al `beneficiary` (que puede ser multisig offline en el momento de la propuesta).

### Instancia por miembro

Patrón de deploy: un `TeamVesting` **por** miembro del equipo. Razones:

- **Aislamiento**: revocar uno no afecta a los demás.
- **Contabilidad**: 1 instancia = 1 cronograma, fácil de auditar.
- **Parámetros individuales**: cliff/duration pueden variar por persona.

### Sin pause

Mismo racional que el Treasury. Si es necesario "pausar", la DAO aprueba `revoke` — semánticamente más honesto.

### Fórmula detallada

```
vested(t) = 0                                 se t < start + cliff
vested(t) = total                             se t >= start + duration
vested(t) = total * (t - start) / duration    caso contrario
```

`total = balanceOf(this) + released` (pre-revoke) o `totalAllocatedAtRevoke` (post-revoke).

### Cuidado con transferencias adicionales

Si la DAO (vía Treasury) transfiere más GOV a la instancia tras el start, el `totalAllocation` sube automáticamente. Eso raramente es deseable — evita enviar transferencias posteriores al funded.

---

**Ver también**: [GovernanceToken](01-GovernanceToken.md), [Treasury](04-Treasury.md).
