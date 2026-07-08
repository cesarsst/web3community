# CreditPSM

**Audiencia:** devs integrando compra/redención de CREDIT, auditores, holders verificando el respaldo.
**Requisitos previos:** [CreditToken](02-CreditToken.md), [Modelo mental](../01-getting-started/02-mental-model.md).

## Visión rápida

Peg Stability Module (`contracts/CreditPSM.sol`): convierte USDC ↔ CREDIT a **1:1, sin fee**. Pilar del remodel 2026-07-08 ("payment rail"): CREDIT deja de ser activo especulativo/deflacionario y se vuelve riel de pago estable. Todo CREDIT minteado por aquí está 100% respaldado por el USDC retenido en este contrato.

Dos flujos, simétricos:

- `buy(usdcAmount)`: el usuario deposita USDC, recibe CREDIT 1:1 (mint).
- `sell(creditAmount)`: el usuario devuelve CREDIT (quemado), recibe USDC 1:1.

**No hay ninguna función de retiro del respaldo — ni para la gobernanza.** El contrato no tiene owner, no tiene roles propios, no tiene setters, no es pausable. Si la DAO quiere gastar, gasta de la fee del [`FeeRouterV2`](08b-FeeRouterV2.md) — nunca de aquí.

## Herencia

```
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parámetros y storage

| Nombre | Tipo | Valor | Descripción |
|---|---|---|---|
| `CREDIT` | `CreditToken` immutable | dirección del CreditToken (18 dec) | token minteado/quemado |
| `USDC` | `IERC20` immutable | dirección de la stablecoin de respaldo (6 dec asumidos) | respaldo retenido |
| `SCALE` | `uint256` immutable | `10 ** (18 - usdcDecimals)` = `1e12` para USDC | factor de conversión de decimales |
| `mintedOutstanding` | `uint256` | arranca en 0 | CREDIT en circulación minteado por este PSM (18 dec) |

El constructor revierte con `InvalidDecimals` si la stablecoin tiene más de 18 decimales.

## Roles y permisos

El PSM no define roles propios. Necesita, en el `CreditToken`:

| Role (en CreditToken) | Para qué |
|---|---|
| `MINTER_ROLE` | mintear en `buy` (`mint(user, creditOut, "psm:buy")`) |
| `BURNER_ROLE` | quemar en `sell` — **siempre sobre el saldo del propio PSM** (después del `transferFrom` del vendedor); la role de burn nunca toca saldo de terceros |

## Funciones externas

### `buy(uint256 usdcAmount) → uint256 creditOut`

Compra CREDIT con USDC a 1:1.

- **Quién llama**: cualquiera (`nonReentrant`). Requiere `USDC.approve(psm, usdcAmount)` previo.
- **Efectos**: `creditOut = usdcAmount × SCALE`; jala el USDC (`safeTransferFrom`), incrementa `mintedOutstanding`, mintea CREDIT al caller.
- **Revierte**: `ZeroAmount` si `usdcAmount == 0`.
- **Eventos**: `Bought(user, usdcIn, creditOut)`.

### `sell(uint256 creditAmount) → uint256 usdcOut`

Redime USDC devolviendo CREDIT a 1:1. El CREDIT se quema.

- **Quién llama**: cualquiera (`nonReentrant`). Requiere `CREDIT.approve(psm, creditAmount)` previo.
- **Efectos**: `usdcOut = creditAmount / SCALE`; jala el CREDIT al PSM, lo quema del saldo propio (`burnByRole(this, amount, "psm:sell")`), decrementa `mintedOutstanding` (con clamp en cero), transfiere el USDC.
- **Revierte**:
  - `ZeroAmount` si `creditAmount == 0`.
  - `DustAmount(amount, granularity)` si `creditAmount` no es múltiplo de `SCALE` (1e12) — el polvo por debajo de 1e-6 USDC revierte en vez de ser confiscado.
  - `InsufficientBacking(requested, available)` si el USDC retenido no cubre la redención (solo posible redimiendo CREDIT **legado**, minteado fuera del PSM).
- **Eventos**: `Sold(user, creditIn, usdcOut)`.

## Views

| Función | Retorna |
|---|---|
| `backing()` | USDC retenido actual (6 decimales) |
| `backingNormalized()` | ídem, escalado a 18 decimales — comparable directo con `mintedOutstanding` |
| `mintedOutstanding()` | CREDIT en circulación minteado por este PSM |

## Eventos

| Evento | Emitido en | Parámetros indexados |
|---|---|---|
| `Bought(user, usdcIn, creditOut)` | `buy` | `user` |
| `Sold(user, creditIn, usdcOut)` | `sell` | `user` |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAmount()` | `buy(0)` o `sell(0)` |
| `DustAmount(uint256 amount, uint256 granularity)` | `sell` con monto no múltiplo de `SCALE` |
| `InsufficientBacking(uint256 requested, uint256 available)` | `sell` que excede el USDC retenido |
| `InvalidDecimals(uint8 decimals)` | constructor con stablecoin > 18 decimales |

## Invariantes

- **I-PSM1 (respaldo integral)**: `USDC.balanceOf(this) >= mintedOutstanding` (en unidades normalizadas). No existe NINGUNA función de retiro del respaldo — ni para la gobernanza.
- **I-PSM2 (conversión exacta)**: `buy` convierte `usdc × 1e12`; `sell` exige múltiplo de `1e12` (el polvo revierte, no se confisca).
- **Burn solo del saldo propio**: `sell` hace `transferFrom` del vendedor hacia el PSM y quema de su propio saldo — `BURNER_ROLE` nunca toca saldo de terceros.
- **Clamp conservador**: `mintedOutstanding` puede quedar por debajo del real si alguien redime CREDIT de otra origen (genesis/legado) — el clamp en cero mantiene el contador como "mejor estimación conservadora" sin revertir redenciones.

## Observaciones importantes

### Por qué no hay fee de conversión

El PSM es infraestructura, no fuente de ingreso. La monetización del protocolo está en el `FeeRouterV2` (fee de 2,5% sobre pagos). Poner fee en la conversión penalizaría la entrada/salida y debilitaría el peg.

### CREDIT legado

El CREDIT anterior al remodel (genesis de 10M + rewards emitidos por los RewardDistributor) circula sin respaldo correspondiente en el PSM. `sell` lo acepta, pero la redención agregada está limitada al USDC efectivamente depositado vía `buy` — de ahí el error `InsufficientBacking` y el clamp del contador.

---

**Ver también**: [CreditToken](02-CreditToken.md), [FeeRouterV2](08b-FeeRouterV2.md), [ProjectFunding](16-ProjectFunding.md).
