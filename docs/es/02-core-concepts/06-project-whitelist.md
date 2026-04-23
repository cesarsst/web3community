# Whitelist de proyectos

**Audiencia:** devs que quieren listar una app, stakers que quieren entender en qué están asignando capital.
**Requisitos previos:** [Gobernanza](05-governance.md).

## Por qué whitelist

El protocolo comparte un motor económico: uso en las apps listadas genera burn, que genera emisión, que va a los stakers. Si **cualquiera** pudiera incluirse como proyecto y accionar `burnAndRecord`, el modelo colapsaría — un atacante quema volumen de CREDIT que él mismo acuñó en otra app y captura rewards.

La whitelist coloca una barrera económica (colateral en GOV) y política (pasar por propuesta) antes de que una nueva app reciba `RECORDER_ROLE`. Es la primera línea de defensa contra sybil de apps.

## Los 4 estados de un proyecto

```
      registerProject          activateProject        setProbation      reactivate
   Pending ------------>  Active ------------------>  Probation --------->  Active ...
                                                          |
                                                          | removeProject
                                                          v
                                                       Removed (terminal)
```

Transiciones válidas (definidas en `ProjectRegistry` enum `Status`):

- `Pending` → `Active` (vía `activateProject`, governance-gated)
- `Active` → `Probation` (vía `setProbation`, governance-gated)
- `Active` → `Removed` (vía `removeProject`, governance-gated)
- `Probation` → `Active` (vía `reactivate`, governance-gated)
- `Probation` → `Removed` (vía `removeProject`)
- `Removed` → **nada** (terminal)

## Pending — proyecto registrado pero no operativo

Tras `registerProject`:

- El colateral en GOV fue pulleado del `owner` al Registry.
- `metadataURI` fue grabado.
- `activatedAt` = 0, `probationEndsAt` = 0.
- Stake y pagos **no** funcionan (`isActive` retorna false).
- El owner puede actualizar metadata.

Propósito: ventana entre la aprobación de la propuesta y la activación efectiva. Da tiempo para verificaciones finales.

## Active — proyecto operativo

Tras `activateProject`:

- `activatedAt = block.timestamp`.
- `probationEndsAt = activatedAt + probationDuration` (en producción, 30 días).
- `isActive(projectId)` = true.
- Stake, pagos y `burnAndRecord` funcionan.
- **Durante la ventana de probation inicial**, `isInProbation(projectId)` = true y el share de reward queda dividido por 4.

Tras `probationEndsAt`, la penalización desaparece automáticamente. No se requiere acción adicional.

## Probation (punitiva) — proyecto suspendido

Status distinto de la probation inicial por tiempo. La gobernanza mueve un proyecto `Active` a `Probation` para suspender la operación por mala conducta (sin remover el colateral).

- `isActive` retorna false.
- Stake nuevo bloqueado (`ProjectNotActive`).
- Pagos bloqueados (`ProjectNotActive`).
- Unstake **NO** es bypasseado — el usuario solo sale cuando el lock expire normalmente.
- Registros de burn pasados permanecen — la historia es historia.

Desde Probation, la DAO puede:

- `reactivate(projectId)` → vuelve a `Active`. `activatedAt` y `probationEndsAt` **no cambian** (el anclaje original se preserva).
- `removeProject(projectId, slash, treasury)` → terminal.

## Removed — terminal

Único estado que bypassea el lock en `Staking.unstake` (porque la DAO removió el proyecto, no el staker). Los stakers salen cuando quieran.

- `isActive` retorna false definitivamente.
- Stake, pagos, toda operación bloqueada.
- El colateral ya fue drenado:
  - `slash == true` → fue a `treasury`.
  - `slash == false` → fue al `owner` del proyecto.
- La transferencia pendiente de ownership se cancela.
- `metadataURI` queda congelada — ya no hay update.

## Colateral — skin in the game

Todo proyecto necesita bloquear GOV como colateral en el momento de `registerProject`:

- En producción, `minCollateral = 10.000 GOV` (ajustable vía gobernanza).
- El colateral queda custodiado **en el Registry** — no en el Treasury, no en el owner.
- Solo se libera vía `removeProject`:
  - Sin slash (proyecto sale en buenos términos): va al `owner`.
  - Con slash (mala conducta): va al `treasury`.
- **No hay topup ni withdraw parcial en v1**. Si el colateral mínimo aumenta, los proyectos existentes continúan con el colateral antiguo (grandfathered) — el cambio solo afecta a nuevos registros.

El colateral sirve a tres propósitos:

1. **Costo de entrada**: desincentiva listar apps basura.
2. **Anti-sybil**: 10k GOV es ~0.01% del cap, un valor no trivial.
3. **Mecanismo de slash**: si la app se prueba fraudulenta, la DAO quema el colateral (vía slash).

## Metadata off-chain

El Registry guarda un `metadataURI` (IPFS/Arweave). El contenido exacto es off-chain pero convencionalmente contiene:

- Nombre legible del proyecto.
- Descripción.
- Ícono.
- Direcciones de los contratos de la app (si aplica).
- Link del sitio, docs, contacto.

El owner actualiza vía `updateMetadata(projectId, metadataURI)`. No requiere propuesta — es operacional. La única excepción es post-`Removed`, donde la URI se congela.

## Transferencia de ownership (2-step)

El owner de un proyecto puede transferir a otra dirección vía proceso 2-step (análogo a `Ownable2Step`):

1. `transferProjectOwnership(projectId, newOwner)` — el owner actual propone la transferencia.
2. `acceptProjectOwnership(projectId)` — `newOwner` acepta explícitamente.

Hasta el accept, el pendingOwner **no tiene poder**. Esto protege contra transferencia accidental a dirección equivocada o inalcanzable.

## Consecuencias en el resto del sistema

Dependencias directas del status del proyecto:

- **`Staking.stake` / `increaseStake`**: exige `Active`.
- **`Staking.unstake`**: solo bypassea lock si `Removed`.
- **`BurnTracker.burnAndRecord`**: exige `Active`. Si el proyecto va a `Probation` tras un burn, el burn histórico **no se revierte**.
- **`FeeRouter.pay`**: exige `Active`.
- **`RewardDistributor._calculateClaim`**: penalty `/ 4` si `isInProbation(projectId)` en el momento del claim.

---

**Siguiente →** [Treasury y fees](07-treasury-and-fees.md)
