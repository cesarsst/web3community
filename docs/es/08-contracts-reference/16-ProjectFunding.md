# ProjectFunding

**Audiencia:** dueños de proyectos captando capital, inversores, devs de UI, auditores.
**Requisitos previos:** [FeeRouterV2](08b-FeeRouterV2.md), [Staking](05-Staking.md), [Value accrual](../06-for-investors/02-value-accrual.md).

## Visión rápida

Captación + redistribución de receita por proyecto (`contracts/ProjectFunding.sol`), remodel 2026-07-08. Sustituye la emisión inflacionaria de CREDIT como fuente de renta del inversor: quien financia un proyecto compra el derecho a una fatia (`revShareBps`) de la **receita bruta futura**, pagada automáticamente por el [`FeeRouterV2`](08b-FeeRouterV2.md) en cada pago.

Ciclo completo:

```
1. Dueño del proyecto (Registry) abre rodada:
   alvo en CREDIT, rev-share ofrecido (1%-30%) y plazo (1-90 dias).

2. Inversores con GOV stakeado EN el proyecto (Staking.getWeight > 0)
   depositan CREDIT hasta el alvo (nunca por encima).

3. Alvo alcanzado -> paga al dueño (integro) y activa el rev-share.
   Plazo vencido sin alvo -> rodada Failed, refund() devuelve el 100%.

4. FeeRouterV2 llama notifyRevenue en cada pago; el inversor retira
   con claim() (exige mantener GOV stakeado; el derecho nunca expira).
```

**All-or-nothing**: la rodada solo paga al dueño si alcanza el alvo. Protege al inversor de financiar a medias un proyecto inviable.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Tipos

```solidity
enum RoundStatus { None, Open, Funded, Failed }

struct Round {
    uint256 target;       // alvo en CREDIT (18d)
    uint256 raised;       // captado hasta ahora
    uint64  deadline;     // timestamp limite
    uint16  revShareBps;  // fatia de la receita bruta ofrecida
    RoundStatus status;
}
```

## Parámetros y storage

| Nombre | Tipo | Valor | Descripción |
|---|---|---|---|
| `REVENUE_NOTIFIER_ROLE` | `bytes32` constant | `keccak256("REVENUE_NOTIFIER_ROLE")` | rol del FeeRouterV2 — único autorizado a notificar receita |
| `GOVERNANCE_ROLE` | `bytes32` constant | `keccak256("GOVERNANCE_ROLE")` | Timelock — ajusta `minTarget` |
| `MIN_REV_SHARE_BPS` | `uint16` constant | `100` (1%) | piso del rev-share |
| `MAX_REV_SHARE_BPS` | `uint16` constant | `3000` (30%) | techo del rev-share |
| `MIN_ROUND_DURATION` | `uint64` constant | `1 days` | plazo mínimo |
| `MAX_ROUND_DURATION` | `uint64` constant | `90 days` | plazo máximo |
| `ACC_PRECISION` | `uint256` constant | `1e18` | precisión del acumulador |
| `CREDIT` / `REGISTRY` / `STAKING` | immutables | — | dependencias |
| `minTarget` | `uint256` | `100e18` default | alvo mínimo (anti-spam), ajustable por gobernanza |
| `rounds[projectId]` | `mapping` | — | la rodada (única) de cada proyecto |
| `sharesOf[projectId][investor]` | `mapping` | — | shares (= CREDIT invertido, 1:1) |
| `accRevenuePerShare[projectId]` | `mapping` | — | acumulador de receita por share |
| `rewardDebt[projectId][investor]` | `mapping` | — | checkpoint del inversor (patrón MasterChef) |
| `totalRevenueDistributed[projectId]` | `mapping` | — | receita total ya distribuida (auditoría/UI) |

## Roles y permisos

| Role | En producción concedido a | Autoriza |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | gestión de roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | `setMinTarget` |
| `REVENUE_NOTIFIER_ROLE` | `FeeRouterV2` | `notifyRevenue` |

## Funciones externas

### `openRound(uint256 projectId, uint256 target, uint16 revShareBps, uint64 duration)`

Abre la rodada de captación del proyecto. Una única por proyecto (MVP).

- **Quién llama**: el `owner` del proyecto en el Registry, con proyecto `Active` (`nonReentrant`).
- **Revierte**:
  - `ProjectNotActive(projectId)` / `NotProjectOwner(projectId, caller)`.
  - `RoundAlreadyExists(projectId)` si `status != None` (incluye rodadas Failed — no hay segunda chance en el MVP).
  - `RevShareOutOfBounds(provided, 100, 3000)` — rev-share fuera de 1%–30%.
  - `TargetOutOfBounds(provided, minTarget)` — alvo < `minTarget`.
  - `DurationOutOfBounds(provided, 1 days, 90 days)`.
- **Efectos**: `rounds[projectId] = {target, 0, now + duration, revShareBps, Open}`.
- **Eventos**: `RoundOpened(projectId, target, revShareBps, deadline)`.

### `invest(uint256 projectId, uint256 amount)`

Invierte CREDIT en la rodada abierta. **Exige GOV stakeado en el proyecto.**

- **Quién llama**: cualquier inversor con `STAKING.getWeight(msg.sender, projectId) > 0` (`nonReentrant`). Requiere `CREDIT.approve(funding, amount)` previo.
- **Revierte**:
  - `RoundNotOpen(projectId)` si `status != Open` o `now > deadline`.
  - `ZeroAmount`.
  - `NoGovStaked(projectId, investor)` — el gate de GOV.
  - `ExceedsTarget(requested, remaining)` — no se puede sobrepasar el alvo (garantiza `raised == target` exacto en el cierre).
- **Efectos** (CEI: effects antes de interactions): `raised += amount`, `sharesOf += amount`, después `safeTransferFrom`. Si `raised == target`, finaliza automáticamente: `_fund` marca `Funded`, transfiere todo el captado al owner y activa el rev-share.
- **Eventos**: `Invested(projectId, investor, amount, totalRaised)`; en el cierre, `RoundFunded(projectId, raised, paidTo)`.

### `closeExpiredRound(uint256 projectId)`

Sella como `Failed` una rodada con plazo vencido y alvo no alcanzado. **Permissionless** — cualquiera puede "carimbar" la falla.

- **Revierte**: `RoundNotOpen(projectId)`, `RoundStillOpen(projectId)` si `now <= deadline`.
- **Eventos**: `RoundFailed(projectId, raised)`.

### `refund(uint256 projectId)`

Devuelve el **100%** de lo invertido en una rodada `Failed`.

- **Quién llama**: cada inversor por sí (`nonReentrant`).
- **Revierte**: `RoundNotFailed(projectId)`, `NothingToRefund(projectId, investor)`.
- **Efectos**: zera `sharesOf`, decrementa `raised`, transfiere el CREDIT de vuelta.
- **Eventos**: `Refunded(projectId, investor, amount)`.

### `notifyRevenue(uint256 projectId, uint256 amount)`

Recibe la fatia de rev-share de un pago. **Solo FeeRouterV2** (`REVENUE_NOTIFIER_ROLE`).

- **Precondición**: el router ya transfirió `amount` de CREDIT a este contrato — aquí solo se actualiza el acumulador.
- **Revierte**: `ZeroAmount`, `NoActiveShares(projectId)` si la rodada no está `Funded`.
- **Efectos**: `accRevenuePerShare += amount × 1e18 / raised`; `totalRevenueDistributed += amount`. O(1) por pago.
- **Eventos**: `RevenueNotified(projectId, amount)`.

### `claim(uint256 projectId) → uint256 amount`

Retira la receita acumulada del inversor en el proyecto.

- **Quién llama**: el inversor, **con GOV aún stakeado en el proyecto** (`nonReentrant`) — skin in the game. Sin stake, el valor **no se pierde**: queda retenido hasta que vuelva a stakear. El derecho **nunca expira**.
- **Revierte**: `NoGovStaked(projectId, investor)`, `NothingToClaim(projectId, investor)`.
- **Efectos**: `amount = shares × acc / 1e18 - rewardDebt`; actualiza `rewardDebt`; transfiere el CREDIT. O(1) por claim.
- **Eventos**: `RevenueClaimed(projectId, investor, amount)`.

### `setMinTarget(uint256 newMin)`

Ajusta el alvo mínimo de rodada.

- **Quién llama**: `GOVERNANCE_ROLE`.
- **Eventos**: `MinTargetUpdated(previous, current)`.

## Views

| Función | Retorna |
|---|---|
| `revShareBpsOf(projectId)` | rev-share activo (`revShareBps` si `Funded`, si no **0**) — consumido por el router |
| `pendingRevenue(projectId, investor)` | receita pendiente de claim |
| `rounds(projectId)` | struct completo de la rodada |
| `sharesOf(projectId, investor)` / `rewardDebt(...)` / `accRevenuePerShare(projectId)` / `totalRevenueDistributed(projectId)` | contabilidad interna |

## Eventos

| Evento | Emitido en | Parámetros indexados |
|---|---|---|
| `RoundOpened(projectId, target, revShareBps, deadline)` | `openRound` | `projectId` |
| `Invested(projectId, investor, amount, totalRaised)` | `invest` | `projectId`, `investor` |
| `RoundFunded(projectId, raised, paidTo)` | `_fund` (alvo alcanzado) | `projectId`, `paidTo` |
| `RoundFailed(projectId, raised)` | `closeExpiredRound` | `projectId` |
| `Refunded(projectId, investor, amount)` | `refund` | `projectId`, `investor` |
| `RevenueNotified(projectId, amount)` | `notifyRevenue` | `projectId` |
| `RevenueClaimed(projectId, investor, amount)` | `claim` | `projectId`, `investor` |
| `MinTargetUpdated(previous, current)` | `setMinTarget` | — |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAmount()` / `ZeroAddress()` | montos/direcciones cero |
| `ProjectNotActive(projectId)` | `openRound` con proyecto no Active |
| `NotProjectOwner(projectId, caller)` | `openRound` por no-dueño |
| `RoundAlreadyExists(projectId)` | segunda rodada del mismo proyecto |
| `RoundNotFound(projectId)` / `RoundNotOpen(projectId)` / `RoundStillOpen(projectId)` / `RoundNotFailed(projectId)` | transiciones de estado inválidas |
| `RevShareOutOfBounds(provided, min, max)` | rev-share fuera de `[100, 3000]` bps |
| `TargetOutOfBounds(provided, min)` | alvo < `minTarget` |
| `DurationOutOfBounds(provided, min, max)` | plazo fuera de `[1, 90]` días |
| `NoGovStaked(projectId, investor)` | `invest`/`claim` sin GOV stakeado en el proyecto |
| `ExceedsTarget(requested, remaining)` | aporte que sobrepasaría el alvo |
| `NothingToRefund` / `NothingToClaim` | nada que retirar |
| `NoActiveShares(projectId)` | `notifyRevenue` sin rodada Funded |

## Invariantes

- **Una rodada exitosa POR PROYECTO** (MVP). Rodadas subsecuentes exigirían apilar pools de shares con bps distintos — fuera de escopo, documentado para V2.
- **Shares = CREDIT invertido** (1:1, inmutables después del `Funded`).
- **All-or-nothing**: el dueño solo recibe con `raised == target`; `ExceedsTarget` garantiza igualdad exacta.
- **Acumulador MasterChef**: O(1) por pago, O(1) por claim, sin loops sobre inversores.
- **Gate de GOV en invest y claim**: materializa "quien tiene GOV en stake recibe la redistribución". Sin stake el valor queda acumulado — nunca expira ni se redistribuye a otros.
- **CEI en `invest`**: effects antes de interactions; el token es confiable (CREDIT, sin hooks), pero el orden canónico elimina la clase entera de reentrancy.

## Observaciones importantes

### El rendimiento del inversor, en una fórmula

```
rendimiento_anual ≈ revShareBps × GMV_anual / raised
```

Ejemplo: rodada de 10.000 CREDIT al 8%, app facturando 2.000 CREDIT/mes → 160 CREDIT/mes para el pool de inversores → ~19% a.a. Del lado de la app, ese mismo número es su costo de capital — comparable a revenue-based financing. Ver [Value accrual](../06-for-investors/02-value-accrual.md).

### Claim antes de unstake

`claim` exige GOV stakeado **en el momento del claim**. Si vas a hacer unstake, reclama antes — el valor no se pierde, pero queda inaccesible hasta re-stake.

---

**Ver también**: [FeeRouterV2](08b-FeeRouterV2.md), [Staking](05-Staking.md), [CreditPSM](15-CreditPSM.md).
