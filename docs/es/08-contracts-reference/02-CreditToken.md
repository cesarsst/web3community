# CreditToken

**Audiencia:** devs integrando con el token utilitario o auditores.
**Requisitos previos:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## Visión rápida

Token ERC-20 utilitario, quemado en el consumo dentro de los apps. Supply elástico sin cap hardcodeado — la inflación es controlada económicamente por el `RewardDistributor` (único holder de `MINTER_ROLE` en producción), que aplica la fórmula `min(max(alpha*burn, floor), capMax)` por ronda.

Quema en tres caminos: `burn` (self), `burnFrom` (con allowance), `burnByRole` (sin allowance, role-gated). El camino `burnByRole` existe para habilitar burn atómico por el `BurnTracker` sin exigir approve previo del usuario (UX de 1 tx en la app).

## Herencia

```
ERC20 (OZ)
ERC20Burnable (OZ)
AccessControl (OZ)
```

## Parámetros y storage

| Nombre | Tipo | Valor | Descripción |
|---|---|---|---|
| `MINTER_ROLE` | `bytes32` constant | `keccak256("MINTER_ROLE")` | Role para acuñar |
| `BURNER_ROLE` | `bytes32` constant | `keccak256("BURNER_ROLE")` | Role para quemar sin allowance |
| `genesisMinted` | `bool` | `false` en el deploy | Flag one-shot; previene re-ejecución de `mintGenesis` |
| `name` | ERC-20 | "Web3Community Credit" (producción) | — |
| `symbol` | ERC-20 | "CREDIT" (producción) | — |

Sin cap hardcodeado.

## Roles y permisos

| Role | En producción concedido a |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` (tras handoff) |
| `MINTER_ROLE` | `RewardDistributor` |
| `BURNER_ROLE` | `BurnTracker` |

## Funciones externas

### `mintGenesis(address to, uint256 amount)`

Acuñación única de "genesis" (en producción: 10M CREDIT al Treasury). Flag `genesisMinted` impide re-ejecución.

- **Quién llama**: `DEFAULT_ADMIN_ROLE`.
- **Revierte**:
  - `GenesisAlreadyMinted` si ya se llamó.
  - `ZeroAddress` / `ZeroAmount`.
- **Eventos**: `GenesisMinted(to, amount)` + `Transfer(0, to, amount)`.

### `mint(address to, uint256 amount, string calldata tag)`

Acuña `amount` para `to`. No aplica cap (responsabilidad del caller).

- **Quién llama**: `MINTER_ROLE` (en producción, `RewardDistributor`).
- **Revierte**: `ZeroAddress`, `ZeroAmount`.
- **Eventos**: `Minted(to, amount, tag)` + `Transfer(0, to, amount)`.

### `burnByRole(address from, uint256 amount, string calldata tag)`

Quema `amount` del saldo de `from` **sin** consumir allowance. Usado por el `BurnTracker` para quemar atómicamente en `burnAndRecord`.

- **Quién llama**: `BURNER_ROLE` (en producción, `BurnTracker`).
- **Revierte**: `ZeroAddress`, `ZeroAmount`, `ERC20InsufficientBalance`.
- **Eventos**: `BurnedByRole(operator, from, amount, tag)` + `Transfer(from, 0, amount)`.

### Funciones heredadas relevantes

- **ERC-20**: `transfer`, `transferFrom`, `approve`, `balanceOf`, `allowance`, `totalSupply`.
- **ERC20Burnable**: `burn(uint256)` (self-burn), `burnFrom(address, uint256)` (vía allowance).
- **AccessControl**: `grantRole`, `revokeRole`, `renounceRole`, `hasRole`, `getRoleAdmin`, `supportsInterface`.

## Eventos

| Evento | Emitido en | Parámetros indexados |
|---|---|---|
| `GenesisMinted(to, amount)` | `mintGenesis` | `to` |
| `Minted(to, amount, tag)` | `mint` | `to` |
| `BurnedByRole(operator, from, amount, tag)` | `burnByRole` | `operator`, `from` |
| `Transfer(from, to, value)` | heredado | `from`, `to` |
| `RoleGranted/RoleRevoked/RoleAdminChanged` | AccessControl | — |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | `to` o `from` es cero en operaciones que exigen válido |
| `ZeroAmount()` | `amount == 0` |
| `GenesisAlreadyMinted()` | `mintGenesis` segundo intento |
| OZ | `ERC20InsufficientBalance`, `ERC20InsufficientAllowance`, `AccessControlUnauthorizedAccount`, etc. |

## Invariantes

- **Genesis one-shot**: `mintGenesis` solo se ejecuta una vez por lifetime del contrato.
- **`MINTER_ROLE` gate**: `mint` exige role; en producción, solo `RewardDistributor`.
- **`BURNER_ROLE` gate**: `burnByRole` exige role; en producción, solo `BurnTracker`.
- **Supply elástico**: crece con `mint`/`mintGenesis`; cae con `burn`/`burnFrom`/`burnByRole`. Sin cap hardcodeado.
- **CEI aplicado**: `burnByRole` es checks → effect (`_burn` nativo) → sin interaction externa. Sin callback en el `_burn`.

## Observaciones importantes

### Por qué `burnByRole` en vez de `burnFrom` con allowance?

`FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole` es un camino de **1 tx** del usuario. Si fuera vía `burnFrom`, el usuario necesitaría:

1. `approve(burnTracker, amount)` — tx 1.
2. Llamar alguna función que accione `burnTracker.burnFrom(user, ...)` — tx 2.

Rompería UX y abriría ventana de front-run entre approve y burn. El camino con role es seguro porque el role solo es concedido a contratos específicos vía propuesta + Timelock.

El camino vía allowance (`burnFrom`) sigue disponible para quien quiera control explícito de consentimiento.

### No hereda `ERC20Permit` ni `ERC20Votes`

Decisión consciente para v1:

- CREDIT no vota. Si votara, mezclaría gobernanza con uso operacional.
- Permit puede ser útil pero no es necesario en el flujo actual (allowance en la tx de la app).

Si permit se vuelve necesario en v2, basta con agregar `ERC20Permit` como extensión preservando el storage layout.

### Gestión de roles

El `DEFAULT_ADMIN_ROLE` tiene poder de conceder/revocar `MINTER_ROLE` y `BURNER_ROLE`. En producción, ese poder es del Timelock — cualquier cambio de minter/burner pasa por propuesta.

---

**Ver también**: [RewardDistributor](07-RewardDistributor.md), [BurnTracker](06-BurnTracker.md).
