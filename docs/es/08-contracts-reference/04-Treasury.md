# Treasury

**Audiencia:** devs construyendo integraciones con la tesorería, auditores.
**Requisitos previos:** [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md).

## Visión rápida

Custodia multi-activo de la DAO. Recibe pasivamente cualquier ERC-20 (y ETH vía `receive`). La única vía de salida es `GOVERNANCE_ROLE` — ningún admin puede drenar fondos fuera del ciclo de gobernanza.

Sin función `deposit` — cualquier pagador usa `token.transfer(treasury, amount)` directo. Sin pause — el poder unilateral de congelar sería vector de captura.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parámetros y storage

No hay storage mutable. El contrato solo custodia balances de los tokens que recibe.

## Roles y permisos

| Role | En producción |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funciones externas

### Governance-gated

#### `transfer(IERC20 token, address to, uint256 amount)`

Transfiere ERC-20 del treasury a `to`.

- **Revierte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`.
- **Eventos**: `Transferred(token, to, amount)`.
- **ReentrancyGuard**: sí.

#### `batchTransfer(IERC20 token, address[] recipients, uint256[] amounts)`

Batch de transfers en un único token.

- **Revierte**: `ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance`.
- **Eventos**: N × `Transferred` + 1 × `BatchTransferred(token, total, recipientCount)`.

#### `payRebates(IERC20 token, address[] apps, uint256[] amounts, uint256 round)`

Idéntico en mecánica a `batchTransfer`, pero con evento semántico `RebatesPaid` que incluye `round`.

- **Eventos**: N × `Transferred` + 1 × `RebatesPaid(token, round, total, appCount)`.

#### `executeBuyback(address stable, uint256 amountIn, uint256 minGovOut, bytes swapData)`

**Stub v1** — emite evento `BuybackRequested` pero **no** ejecuta swap. Integración DEX vendrá en fase posterior.

- **Revierte**: `ZeroAddress` (stable), `ZeroAmount` (amountIn o minGovOut).
- **Eventos**: `BuybackRequested(stable, amountIn, minGovOut, swapData)`.

#### `sweepETH(address payable to, uint256 amount)`

Retira ETH custodiado.

- **Revierte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `ETHTransferFailed`.
- **Eventos**: `ETHSwept(to, amount)`.

### `receive()`

Acepta ETH enviado directamente. Emite `ETHReceived(sender, amount)`. Sin autorización — cualquiera puede donar ETH.

### Views

- `balanceOf(IERC20 token) → uint256` — wrapper sobre `token.balanceOf(this)`.

## Eventos

| Evento | Emitido en | Parámetros indexados |
|---|---|---|
| `Transferred(token, to, amount)` | `_transfer` (usado por `transfer` y helpers) | `token`, `to` |
| `BatchTransferred(token, totalAmount, recipientCount)` | `batchTransfer` | `token` |
| `RebatesPaid(token, round, totalAmount, appCount)` | `payRebates` | `token`, `round` |
| `BuybackRequested(stable, amountIn, minGovOut, swapData)` | `executeBuyback` | `stable` |
| `ETHReceived(from, amount)` | `receive` | `from` |
| `ETHSwept(to, amount)` | `sweepETH` | `to` |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | Dirección cero en operación que exige válido |
| `ZeroAmount()` | Valor cero |
| `ArrayLengthMismatch()` | Arrays con tamaños diferentes |
| `EmptyBatch()` | Arrays vacíos |
| `InsufficientBalance(token, requested, available)` | Saldo insuficiente en el token |
| `ETHTransferFailed()` | `call{value}` en el destino falló |

## Invariantes

- **I4 (Governance-only exit)**: toda salida de valor exige `GOVERNANCE_ROLE`. En producción, ese papel es exclusivo del Timelock.
- **Sin pause**: no hay función de emergency stop. El riesgo residual aceptado a cambio de descentralización.
- **CEI**: checks → (sin effects de storage, solo evento antes) → interaction. Ver cada función.
- **ReentrancyGuard**: todas las salidas de valor.

## Observaciones importantes

### Por qué no tiene `deposit`

El Treasury es un cofre, no un bookkeeper. Quien quiera enviar fondos usa `transfer` directo. Simplifica el modelo mental y elimina superficie de ataque (permisos cruzados).

### Por qué `executeBuyback` es stub

La integración con DEX exige modelar:

- TWAP oracle para precio justo.
- Slippage máximo explícito.
- Resistencia a frontrunning.
- Elección entre Uniswap v3, Balancer weighted pools, etc.

La decisión responsable es una fase separada. En v1, `executeBuyback` solo registra la intención on-chain vía evento — workers off-chain o contratos futuros pueden actuar después. La DAO puede aprobar buybacks vía `transfer` manual mientras tanto (ej.: `transfer(stable, dex_router, amount)` con otra propuesta para completar el swap).

### Tokens no estándar

`SafeERC20` se usa en todas las salidas para tolerar tokens no estándar (USDC histórico no retorna bool en transfer, por ejemplo). `forceApprove` podría usarse en integraciones con approve, pero no hay approve saliendo del Treasury en v1 (no llama contratos externos que consumen allowance).

### Recepción de ETH

`receive` tiene `emit ETHReceived` — no es payable silencioso. Eso da indexación off-chain de cualquier donación.

El constructor **no** es payable — no acepta ETH durante el deploy (sin justificación para).

---

**Ver también**: [FeeRouter](08-FeeRouter.md), [UserSubsidy](12-UserSubsidy.md), [TeamVesting](11-TeamVesting.md).
