# Visión general de integración

**Audiencia:** dev que quiere listar una app en el ecosistema y aceptar CREDIT como pago.
**Requisitos previos:** [Arquitectura](../03-protocol-overview/01-architecture.md), [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md).

## El contrato que necesitas conocer

Para aceptar pagos en CREDIT, vas a interactuar con **un** contrato principal:

- [`FeeRouter`](../08-contracts-reference/08-FeeRouter.md) — función `pay(projectId, user, amount)`.

Todo lo demás (burn, treasury, rebate, status del proyecto) se maneja automáticamente dentro de él.

## El ciclo completo de integración

```
1. Desarrolla tu app (fuera del protocolo — cualquier stack)
   La logica del app sabe: "servicio X cuesta N CREDIT"

2. Registra el proyecto via propuesta (requiere 10.000 GOV como colateral)
   Resultado: projectId asignado (ej: 42)

3. Tras la activacion, tu app puede llamar FeeRouter.pay en nombre del usuario
   (con approve previo del usuario)

4. (Opcional) Stake en el propio projectId para capturar emision via (B)

5. Monitorea eventos y metricas
```

## Lo que la app llama

Desde el punto de vista del backend/contrato de tu app, el flujo es:

```solidity
// Paso 1 (off-chain): UI de tu app muestra el precio al usuario
// Paso 2: UI pide approve
IERC20(creditToken).approve(feeRouter, amount);

// Paso 3: UI/app llama pay (o el usuario llama directo)
(uint256 burned, uint256 toTreasury, uint256 toApp) =
    feeRouter.pay(projectId, user, amount);

// Paso 4: app verifica exito (via evento Paid o return values)
// Paso 5: app entrega el servicio al usuario
```

`pay` es **pública** — cualquiera puede llamar, siempre que `user` tenga `allowance`. Eso permite:

- **El propio usuario** llamando a `pay` (paga el gas él mismo).
- **La app** llamando a `pay` en nombre del usuario (gas sponsorship — la app paga gas, el usuario solo aprobó antes).
- **Un relayer / smart wallet** llamando a `pay` en nombre del usuario (meta-tx-like).

El "payer económico" siempre es `user` (pagado vía `transferFrom`).

## Cuánto recibe la app

Dado el split default en producción (95% burn, 0% treasury, 5% rebate):

- Inmediato: **5%** va al `appRecipient` (default es el `owner` del proyecto en el Registry).
- Indirectamente, vía `RewardDistributor` de la ronda siguiente: **share de emisión proporcional al burn del proyecto**, que la app puede capturar si stakea.

Desarrollo de las 3 fuentes de ingreso (rebate + stake + apreciación del CREDIT retenido) en [Flujo de valor](../03-protocol-overview/03-economic-flows.md).

## Eventos que quieres monitorear

Del `FeeRouter`:

- `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` — a cada pago de tu proyecto.

Del `BurnTracker`:

- `BurnRecorded(round, projectId, from, amount, newTotalForProject)` — burn de tu proyecto en cada ronda.
- `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)` — para saber cuándo cierra una ronda.

Del `RewardDistributor`:

- `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)` — cuando puedes empezar a reclamar.
- `Claimed(user, round, projectId, amount)` — cada claim hecho por stakers de tu proyecto.

## Configurando destino del rebate

Por default, el rebate va a `ProjectRegistry.getProject(projectId).owner`. Si quieres direccionar a otra dirección (por ejemplo, un contrato de distribución interna de la app, un multisig operacional, etc.):

```solidity
// Llamable por el owner actual del proyecto
feeRouter.setAppRecipient(projectId, newRecipient);
```

Pasar `address(0)` resetea al lookup dinámico (vuelve a seguir al owner del Registry).

Esta función es **owner-gated**, no governance-gated — la rotación operacional no requiere propuesta.

## Cuota y límites

- **Sanity cap por ronda**: en producción 10M CREDIT de burn por proyecto por ronda. Si tu app explota en volumen en una ronda, la tx que sobrepase el cap revierte con `SanityCapExceeded`. Usa batch scheduling off-chain si esperas volumen absurdo (split en múltiples rondas).
- **El proyecto tiene que estar `Active`**. Si pasa a `Probation` (punitiva) o `Removed`, `pay` revierte con `ProjectNotActive`.

## Testeando

Desarrollo local vía Hardhat + Ignition (ver [Entorno local](05-local-dev.md)).

Para testnet Sepolia, el equipo del protocolo provee direcciones tras el deploy. Tu UI apunta a esas direcciones usando la configuración apropiada.

## Lo que la app **no** necesita hacer

- **No** llames a `BurnTracker.burnAndRecord` directamente desde tu app. El `FeeRouter.pay` lo hace por ti. Solo el `FeeRouter` tiene `RECORDER_ROLE` en el bootstrap.
- **No** llames a `CreditToken.burnByRole` directamente. El camino oficial de burn es vía `FeeRouter`.
- **No** necesitas preocuparte por el splitting. Lo hace el `FeeRouter` automáticamente.

## Seguridad

Tu app debe:

- Verificar que el `user` en la llamada `pay` sea quien esperas (no pases `user = msg.sender` ciegamente si el flujo es meta-tx).
- Confiar en el retorno de `pay` — si la tx no revirtió, el pago fue procesado con éxito.
- Tratar `ProjectNotActive` y `SanityCapExceeded` como señales de error irrecuperables en esa tx.

Tu app **no necesita**:

- Guardar CREDIT intermedio — `pay` es atómico.
- Gestionar allowance infinita — la UX más limpia es approve por cantidad, no infinita, pero depende de tu UX.

---

**Siguiente →** [Direcciones de los contratos](02-contract-addresses.md)
