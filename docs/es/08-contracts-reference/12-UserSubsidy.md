# UserSubsidy

**Audiencia:** apps creando campañas de subsidio, auditores, usuarios elegibles.
**Requisitos previos:** [Tokenomics](../06-for-investors/01-tokenomics.md).

## Visión rápida

Distribuye CREDIT pre-financiado a primeros usuarios de las apps vía Merkle drops con cap de claims. Subsidia **demanda** (no oferta) durante el bootstrap, hasta que el GMV orgánico de las apps se sostenga solo. *(La redacción original apuntaba al burn/emisión del modelo pre-remodel; el mecanismo de subsidio en sí sigue vigente y es independiente del modelo económico.)*

Campañas múltiples simultáneas con IDs monotónicos, una por app/ronda. La DAO aprueba root + budget vía propuesta; los usuarios elegibles hacen claim vía Merkle proof.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`, `MerkleProof`.

## Parámetros y storage

| Nombre | Tipo | Descripción |
|---|---|---|
| `credit` | `IERC20` immutable | CreditToken |
| `nextCampaignId` | uint256 | Contador monotónico |
| `campaigns` | mapping | `id → Campaign` |
| `hasClaimed` | mapping | `id → user → bool` |

### Struct `Campaign`

```solidity
struct Campaign {
    bytes32 merkleRoot;
    uint128 amountPerUser;
    uint64 deadline;
    uint64 createdAt;
    uint32 maxClaims;
    uint32 claimed;
    bool closed;
}
```

Empaquetado en 3 slots.

## Roles y permisos

| Role | En producción |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funciones externas

### Governance-gated

#### `createCampaign(bytes32 merkleRoot, uint128 amountPerUser, uint32 maxClaims, uint64 deadline) → uint256 campaignId`

Abre nueva campaña. **No** mueve fondos — la DAO debe transferir `maxClaims × amountPerUser` de CREDIT a este contrato en llamada separada de la misma propuesta.

- **Revierte**: `ZeroRoot`, `ZeroAmount`, `ZeroMaxClaims`, `DeadlineInPast`.
- **Eventos**: `CampaignCreated(campaignId, merkleRoot, amountPerUser, maxClaims, deadline)`.

#### `closeCampaign(uint256 campaignId, address returnTo)`

Cierra campaña y devuelve sobrantes a `returnTo` (típicamente Treasury).

- **Revierte**: `ZeroAddress`, `CampaignNotFound`, `CampaignAlreadyClosed`.
- **Eventos**: `CampaignClosed(campaignId, returnedTo, unclaimedReturned)`.

Calcula `remainingBudget = (maxClaims - claimed) * amountPerUser`.

### User-facing

#### `claim(uint256 campaignId, bytes32[] calldata proof)`

Ejerce claim. `msg.sender` es siempre el destinatario.

- **Revierte**: `CampaignNotFound`, `CampaignAlreadyClosed`, `CampaignExpired`, `AlreadyClaimed`, `CapReached`, `InvalidProof`.
- **Eventos**: `Claimed(campaignId, user, amount)`.

Leaf esperado:

```solidity
leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))
```

Double-hash estándar OZ contra second-preimage en nodos intermedios.

### Views

- `campaigns(uint256 id) → Campaign`.
- `hasClaimed(uint256 id, address user) → bool`.
- `isEligible(uint256 campaignId, address user, bytes32[] proof) → bool` — sin consumir claim.

## Eventos

| Evento | Indexados |
|---|---|
| `CampaignCreated(campaignId, merkleRoot, amountPerUser, maxClaims, deadline)` | `campaignId` |
| `Claimed(campaignId, user, amount)` | `campaignId`, `user` |
| `CampaignClosed(campaignId, returnedTo, unclaimedReturned)` | `campaignId`, `returnedTo` |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | `credit`, `admin` o `returnTo` cero |
| `ZeroAmount()` | `amountPerUser == 0` |
| `ZeroRoot()` | `merkleRoot == 0` |
| `ZeroMaxClaims()` | `maxClaims == 0` |
| `DeadlineInPast()` | `deadline <= block.timestamp` |
| `CampaignNotFound()` | El ID no existe |
| `CampaignAlreadyClosed()` | Campaña cerrada |
| `CampaignExpired()` | `now > deadline` |
| `AlreadyClaimed()` | El user ya hizo claim |
| `CapReached()` | `claimed >= maxClaims` |
| `InvalidProof()` | El proof no valida contra la root |

## Invariantes

- **Merkle root gate**: solo direcciones en el Merkle tree pueden reclamar.
- **Cap por campaña**: `claimed <= maxClaims` siempre.
- **One-claim-per-user**: `hasClaimed[id][user]` bloquea re-claim.
- **msg.sender = recipient**: el claim siempre va a quien firmó.
- **CEI**: checks → effect (`hasClaimed = true`, `claimed++`) → interaction (`safeTransfer`).
- **ReentrancyGuard**: `claim` y `closeCampaign`.

## Observaciones importantes

### Merkle (no firma por app)

Mantiene a la app off-chain — cualquier selector de "quién es usuario real" (wallets con interacción > X, tiempo > Y) se computa fuera de la cadena, y solo la raíz compactada entra on-chain vía propuesta. La DAO aprueba la raíz, no la lógica de selección.

### Double-hash leaf

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(user))))
```

Estándar OZ para prevenir second-preimage en nodos intermedios (un nodo interno de 64 bytes podría coincidir con el hash single-hash de `abi.encode(address)`).

### Budget implícito

El contrato **no** reserva saldo por campaña separadamente. La DAO debe transferir `maxClaims × amountPerUser` antes de crear. Si el saldo se agota (ej.: múltiples campañas compartiendo pool), `claim` revierte en el `safeTransfer` — la DAO necesita re-fondear.

¿Por qué? Los tokens son fungibles, el overhead de "reservar" no trae garantía real contra mis-funding.

### `closeCampaign` antes del deadline

Permitido — escenarios de emergencia (merkle comprometida, lista sybil descubierta). Governance-gated + timelock-gated (2d), entonces los usuarios tienen 2 días de aviso antes de que el close se efective.

### `msg.sender` = recipient obligatorio

Sin parámetro `to`. Impide "claim en nombre de otro", que combinado con listas grandes se convertiría en herramienta para que un operador sybil haga claim de usuarios desatentos.

El relayer/AA que quiera gasless claim usa `msg.sender` de la cuenta del usuario — el recipient siempre es la misma cuenta que firmó.

### `isEligible` — view útil para UI

Verifica elegibilidad sin consumir claim. Retorna `true` si (existe) + (no cerrada) + (dentro del deadline) + (aún no hizo claim) + (cap no alcanzado) + (el proof valida).

### Inmutabilidad del `credit`

Seteado en el constructor. Simplifica el modelo mental (un UserSubsidy = un token) y elimina el vector de swap-token-on-the-fly.

---

**Ver también**: [Treasury](04-Treasury.md), [CreditToken](02-CreditToken.md).
