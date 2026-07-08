# Tener GOV

**Audiencia:** usuario que quiere entender qué representa el token GOV y cómo usarlo.
**Requisitos previos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md).

## Lo que GOV hace por ti

Tener GOV en la wallet te da tres capacidades:

1. **Votar en propuestas** (si delegas voting power a ti mismo).
2. **Stakear en proyectos** (bloquea GOV — es el requisito para invertir en la ronda del proyecto y reclamar rev-share vía `ProjectFunding`).
3. **Registrar un proyecto** como owner (si tienes `minCollateral` disponible y consigues aprobación de la gobernanza).

Sin GOV, aún puedes ser usuario (gastar CREDIT en apps), pero no participas en las decisiones ni en el staking.

## Activar voting power con `delegate`

GOV es ERC-20 con extensión ERC20Votes. Para votar, necesitas **delegar voting power**. Tener balance no alcanza.

```
GovernanceToken.delegate(yourAddress)
```

Si quieres votar tú mismo, delega a ti. Si quieres que alguien vote en tu lugar (un delegate en quien confías), delega a su dirección.

La delegación:

- Es **gratuita** (solo pagas gas).
- Puede ser **transferida** en cualquier momento (`delegate(newDelegatee)`).
- Sigue tu balance automáticamente — si recibes más GOV, tu delegate gana más peso.
- Si vendes GOV, tu delegate pierde peso en la misma proporción.

**Importante**: el cambio de delegación entra en vigor en el bloque siguiente. Las propuestas que ya tenían un snapshot anterior usan la delegación vigente **en el bloque del snapshot**.

## Snapshot y anti-flashloan

Cuando se abre una propuesta, el Governor graba el bloque de snapshot. La función de voto consulta:

```solidity
uint256 votingPower = GovernanceToken.getPastVotes(account, snapshotBlock);
```

`getPastVotes` es histórico — inmune a flash-loans. Quien tome préstamo relámpago de GOV **después** del snapshot no tiene voting power en la propuesta.

## Cómo adquirir GOV

GOV en circulación viene de:

- Asignaciones iniciales aprobadas por la DAO (genesis distribution: treasury, team, public sale, community rewards, liquidity).
- Staking rewards (fuera del alcance de v1 — la emisión de CREDIT como reward no acuña GOV).
- Compra en DEX externa.

Detalles de la distribución en [Tokenomics](../06-for-investors/01-tokenomics.md).

## Usar GOV como colateral para listar un proyecto

Si eres dueño de una app y quieres listarla en el Registry:

1. Espera a que la DAO acepte la propuesta de listado.
2. Haz `GovernanceToken.approve(registry, collateralAmount)` (mínimo 10.000 GOV en producción).
3. Cuando la propuesta de `registerProject` ejecute, el `registerProject` hará pull del GOV vía `transferFrom`.

El GOV queda **bloqueado en el Registry** hasta que el proyecto sea `Removed`:

- Si la remoción es sin slash: vuelve a ti.
- Si la remoción es con slash: va a la tesorería.

Más detalle en [Enviar un proyecto](../05-for-developers/03-submitting-a-project.md).

## Transferir GOV

GOV es ERC-20 estándar. Las transferencias siguen el flujo normal:

```
gov.transfer(recipient, amount)
gov.approve(spender, amount)
gov.transferFrom(owner, recipient, amount)
```

**Atención a la delegación cuando transfieres**: si delegas a X y después transfieres todo tu GOV a Y, el voting power de X cae a cero. Y **no** recibe voting power automáticamente — necesita delegar explícitamente.

## Permit (EIP-2612)

GOV hereda `ERC20Permit`. Puedes firmar un "approve sin tx" vía `permit(owner, spender, value, deadline, v, r, s)`. Útil para UX donde quieres aprobar y usar en una tx única (gasless approve).

## Supply cap

100M GOV es el techo absoluto, inmutable. Cuando `totalSupply() == 100M`, las llamadas `mint` revierten con `CapExceeded`. Esto significa que **la emisión de GOV es previsible** — todo lo que existe o existirá de GOV sale del proceso de aprobación de la DAO hasta alcanzar el cap.

Verificar el supply actual: `GovernanceToken.totalSupply()` / `GovernanceToken.cap()`.

## Sobre yield (no) garantizado

Tener GOV **no paga yield por sí solo**. Recibes CREDIT **solo si stakeas GOV en un proyecto, inviertes en su ronda de captación y la app factura de verdad** (rev-share sobre receita real — ver [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md)). Mantener GOV parado en la wallet te da solo derecho a voto — no distribuye CREDIT.

Si quieres participar en el incentivo económico, empieza por [Staking en proyectos](03-staking-in-projects.md) y después invierte en una ronda.

---

**Siguiente →** [Staking en proyectos](03-staking-in-projects.md)
