# FeeRouterV2

**Audiencia:** devs de apps integrando pagos, inversores auditando volumen, auditores.
**Requisitos previos:** [Flujo de valor](../03-protocol-overview/03-economic-flows.md), [ProjectFunding](16-ProjectFunding.md).

## Visión rápida

Riel de pagos del remodel 2026-07-08 (`contracts/FeeRouterV2.sol`). Sustituye el modelo burn-to-mint ([FeeRouter V1](08-FeeRouter.md), split 70/20/10) por una tasa competitiva con procesadores de pago:

```
pay(projectId, 100 CREDIT):
  - fee del protocolo (default 2,5%) ->
      40% treasury | 40% buyback de GOV | 20% grants
  - rev-share del proyecto (ProjectFunding.revShareBpsOf; 0 si el
    proyecto nunca capto) -> inversores, via notifyRevenue
  - resto -> appRecipient del proyecto, EN LA MISMA TX
    (~89,5 CREDIT con rev-share de 8%; ~97,5 sin rev-share)
```

Sin burn, sin emisión: CREDIT es riel estable (ver [CreditPSM](15-CreditPSM.md)). La renta del inversor viene de receita real; el valor del GOV viene del buyback financiado por la fee.

**Diferencia clave vs V1**: `pay(projectId, amount)` no tiene parámetro `user` — el payer económico es siempre `msg.sender`.

## Herencia

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parámetros y storage

| Nombre | Tipo | Valor | Descripción |
|---|---|---|---|
| `GOVERNANCE_ROLE` | `bytes32` constant | `keccak256("GOVERNANCE_ROLE")` | gate de los setters económicos |
| `FEE_BPS_CAP` | `uint16` constant | `500` (5%) | **techo duro de la fee — ni la gobernanza lo supera** |
| `CREDIT` | `IERC20` immutable | CreditToken | moneda de pago |
| `REGISTRY` | `ProjectRegistry` immutable | — | gate `isActive` + fallback de recipient |
| `FUNDING` | `ProjectFunding` immutable | — | fuente del `revShareBpsOf` + destino del rev-share |
| `feeBps` | `uint16` | `250` (2,5%) default | fee del protocolo en bps del pago |
| `feeSplit` | `FeeSplit {treasuryBps, buybackBps, grantsBps}` | `(4000, 4000, 2000)` | repartición de la fee (bps de la PROPIA fee, suma 10000) |
| `treasuryRecipient` / `buybackRecipient` / `grantsRecipient` | `address` | configurables | destinos de la fee (MVP dev: los tres = Treasury) |
| `appRecipientOf[projectId]` | `mapping` | `0` default | recipient de pago por proyecto (fallback: owner del Registry) |
| `grossVolumeOf[projectId]` | `mapping` | acumulativo | **volumen bruto on-chain — métrica para inversores** |

El constructor valida: direcciones ≠ 0, `initialFeeBps <= FEE_BPS_CAP`, split sumando 10000.

## Roles y permisos

| Role | En producción concedido a | Autoriza |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` | gestión de roles |
| `GOVERNANCE_ROLE` | `CommunityTimelock` | `setFeeBps`, `setFeeSplit`, `setRecipients` |

Además, el FeeRouterV2 **tiene** `REVENUE_NOTIFIER_ROLE` en el `ProjectFunding` (único autorizado a `notifyRevenue`).

`setAppRecipient` no usa roles: es owner-gated por proyecto (verifica el owner en el Registry).

## Funciones externas

### `pay(uint256 projectId, uint256 amount)`

Paga `amount` de CREDIT al proyecto `projectId`. Orden: fee → rev-share → app, todo atómico.

- **Quién llama**: cualquiera (`nonReentrant`). Requiere `CREDIT.approve(router, amount)` previo; el payer es `msg.sender`.
- **Pasos**:
  1. Jala `amount` de CREDIT del payer.
  2. `fee = amount × feeBps / 10000`; se reparte `toTreasury = fee × treasuryBps / 10000`, `toBuyback = fee × buybackBps / 10000`, `toGrants = fee - toTreasury - toBuyback` (el residuo del redondeo va a grants).
  3. `revShare = amount × FUNDING.revShareBpsOf(projectId) / 10000` — 0 si el proyecto no tiene ronda `Funded`.
  4. `toApp = amount - fee - revShare` → transferido a `appRecipientOf[projectId]` (o al owner del Registry si no está seteado).
  5. El rev-share se **transfiere al ProjectFunding ANTES** del `notifyRevenue` (el funding solo contabiliza, no hace pull).
  6. `grossVolumeOf[projectId] += amount`.
- **Revierte**: `ZeroAmount`, `ProjectNotActive(projectId)`.
- **Eventos**: `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)` — las 5 parcelas detalladas para contabilidad on-chain.

### `setFeeBps(uint16 newFeeBps)`

Ajusta la fee del protocolo.

- **Quién llama**: `GOVERNANCE_ROLE`.
- **Revierte**: `FeeAboveCap(provided, cap)` si `newFeeBps > 500`.
- **Eventos**: `FeeUpdated(previousBps, currentBps)`.

### `setFeeSplit(FeeSplit calldata newSplit)`

Ajusta la repartición interna de la fee.

- **Quién llama**: `GOVERNANCE_ROLE`.
- **Revierte**: `SplitDoesNotSumTo10000(sum)` si la suma ≠ 10000.
- **Eventos**: `FeeSplitUpdated(treasuryBps, buybackBps, grantsBps)`.

### `setRecipients(address treasury_, address buyback_, address grants_)`

Ajusta los tres destinos de la fee.

- **Quién llama**: `GOVERNANCE_ROLE`.
- **Revierte**: `ZeroAddress` si cualquiera es 0.
- **Eventos**: `RecipientsUpdated(treasury, buyback, grants)`.

### `setAppRecipient(uint256 projectId, address recipient)`

El dueño del proyecto rotaciona el recipient de sus pagos (rotación operacional, como en el V1).

- **Quién llama**: el `owner` del proyecto en el Registry.
- **Revierte**: `NotProjectOwner(projectId, caller)`, `ZeroAddress`.
- **Eventos**: `AppRecipientUpdated(projectId, recipient)`.

## Views

| Función | Retorna |
|---|---|
| `previewPay(projectId, amount)` | `(fee, revShare, toApp)` — desglose previo para UI |
| `grossVolumeOf(projectId)` | volumen bruto acumulado del proyecto |
| `appRecipientOf(projectId)` | recipient configurado (0 = fallback al owner) |
| `feeBps()` / `feeSplit()` / `*Recipient()` | parámetros vigentes |

## Eventos

| Evento | Emitido en | Parámetros indexados |
|---|---|---|
| `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)` | `pay` | `projectId`, `payer` |
| `FeeUpdated(previousBps, currentBps)` | `setFeeBps` | — |
| `FeeSplitUpdated(treasuryBps, buybackBps, grantsBps)` | `setFeeSplit` | — |
| `RecipientsUpdated(treasury, buyback, grants)` | `setRecipients` | — |
| `AppRecipientUpdated(projectId, recipient)` | `setAppRecipient` | `projectId` |

## Errores custom

| Error | Cuándo ocurre |
|---|---|
| `ZeroAddress()` | constructor/setters con dirección 0 |
| `ZeroAmount()` | `pay(_, 0)` |
| `ProjectNotActive(uint256 projectId)` | pago a proyecto no `Active` |
| `NotProjectOwner(uint256 projectId, address caller)` | `setAppRecipient` por no-dueño |
| `FeeAboveCap(uint16 provided, uint16 cap)` | fee > 500 bps |
| `SplitDoesNotSumTo10000(uint256 sum)` | split inválido |

## Invariantes

- **Techo duro de la fee**: `feeBps <= FEE_BPS_CAP = 500` — validado en constructor y setter; constante inmutable.
- **Split exacto**: `treasuryBps + buybackBps + grantsBps == 10000`, con residuo de redondeo de la fee asignado a grants (nada se pierde).
- **Conservación**: `toTreasury + toBuyback + toGrants + revShare + toApp == amount` en todo `pay`.
- **I4 (gobernanza vía Timelock)**: setters económicos son `GOVERNANCE_ROLE`.
- **I7 (proyectos vía Registry)**: `pay` exige proyecto `Active`.
- **Transfer-then-notify**: el CREDIT del rev-share llega al `ProjectFunding` antes del `notifyRevenue` — el acumulador nunca contabiliza fondos que no están en el contrato.

## Observaciones importantes

### Los tres recipients pueden apuntar al mismo endereço

En el MVP dev, treasury/buyback/grants apuntan los tres al Treasury. Los eventos cargan el detalle por parcela justamente para mantener la transparencia contable on-chain aunque el destino físico coincida.

### Sin `RECORDER_ROLE`

A diferencia del V1, integrar una app no exige conceder roles: basta que el proyecto esté `Active` en el Registry. La integración se reduce a `approve` + `pay`.

---

**Ver también**: [CreditPSM](15-CreditPSM.md), [ProjectFunding](16-ProjectFunding.md), [FeeRouter V1 (legado)](08-FeeRouter.md).
