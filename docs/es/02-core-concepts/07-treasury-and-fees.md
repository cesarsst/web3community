# Treasury y fees

**Audiencia:** quien quiera entender el flujo de caja del protocolo.
**Requisitos previos:** [Dual-token](01-dual-token-economy.md), [Gobernanza](05-governance.md).

## El cofre de la DAO

El `Treasury` es el cofre multi-activo central. Tres propiedades fundamentales:

1. **Recibe pasivamente**. No hay función `deposit`. Cualquiera transfiere ERC-20 (o ETH vía `receive`) directo a la dirección del Treasury.
2. **Solo libera vía gobernanza**. Todas las funciones de salida (`transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH`) exigen `GOVERNANCE_ROLE`.
3. **Sin pause**. Deliberadamente no hay función para congelar salidas. Cualquier poder unilateral de congelar la tesorería sería vector de captura.

El Treasury recibe:

- **Genesis mint de CREDIT** (10M en producción). Esa es la única entrada "programática"; la subsiguiente es por transferencia explícita.
- **Porción de `treasuryBps`** del split del `FeeRouter` (default 0 en producción, pero ajustable vía gobernanza).
- **Colateral de slash** de proyectos removidos con `slash == true`.
- **Subsidios devueltos** cuando una campaña del `UserSubsidy` se cierra con sobrante.
- **Cualquier donación / buyback / fee de app** que la DAO decida aceptar.

## Qué hace la DAO con el Treasury

Operaciones típicas, todas vía propuesta:

- **Pagar rebates a apps** (`payRebates(token, apps[], amounts[], round)`) — batch transfer con evento `RebatesPaid` para rastreabilidad.
- **Patrocinar campañas de `UserSubsidy`** — transferir CREDIT al contrato de subsidio antes de `createCampaign`.
- **Fundar `TeamVesting`** — transferir GOV a una instancia de vesting que después libera al beneficiario.
- **Buyback de GOV con stable** — `executeBuyback` (stub v1 — solo emite evento; la integración DEX vendrá en fase posterior).
- **Financiar operaciones off-chain** (marketing, auditorías, etc.) — `transfer` a un multisig operacional.

## Fees — el FeeRouter

Interfaz **única** de pago entre usuarios y apps. Función principal:

```solidity
function pay(uint256 projectId, address user, uint256 amount)
    external returns (uint256 burned, uint256 toTreasury, uint256 toApp);
```

El `user` necesita haber dado `approve(feeRouter, amount)` en CREDIT **antes**. `msg.sender` es quien inició la tx — puede ser el propio user, la app, un relayer, una smart wallet.

## Split por defecto — 95 / 0 / 5

En producción (`ignition/parameters/production.json`):

```
burnBps     = 9500   (95% quemado via BurnTracker)
treasuryBps = 0      (nada al Treasury en el default)
rebateBps   = 500    (5% al appRecipient)
```

La suma tiene que ser exactamente 10_000 (`_BPS_DENOMINATOR`). Splits diferentes son rechazados con `InvalidSplit`.

Decisión de diseño: 0% al treasury en el default **para no erosionar el incentivo al burn**. El Treasury recibe ingresos por otras vías (genesis ya acuñado, slash, donaciones, buyback gestionado). Si en el futuro la DAO quiere capturar parte directa, basta con proponer `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})` — la arquitectura lo permite.

## Override por proyecto

Algunos proyectos pueden negociar splits diferentes vía propuesta:

```solidity
feeRouter.setProjectSplit(projectId, Split({burnBps, treasuryBps, rebateBps}));
```

El flag `hasProjectSplit[projectId]` señala que existe override. `clearProjectSplit` lo remueve.

Uso típico: una app de alto volumen que aceptaría una tasa efectiva mayor (porque tiene otra fuente de ingresos) puede negociar `8000/1500/500` (15% treasury), financiando más agresivamente el cofre.

## Recipient del rebate

Por default, el rebate va a `ProjectRegistry.getProject(projectId).owner`. Si el owner transfiere el proyecto, el destino cambia automáticamente — **lookup dinámico**.

El owner actual puede setear una dirección explícita vía:

```solidity
feeRouter.setAppRecipient(projectId, recipient);
```

Útil cuando el owner es un multisig y el rebate debe caer en una wallet operacional separada. Pasar `address(0)` resetea al lookup dinámico.

**No es governance-gated** — es owner-gated. La rotación operacional de caja no necesita propuesta.

## Dust handling

En splits con división no exacta:

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- residuo vai aqui
```

En lugar de redondear separadamente cada parcela (se pierden wei), `toApp` captura el residuo. Consecuencia: la app puede recibir 1-2 wei más que el cálculo nominal. Aceptable y auditable.

## Flujo completo de un pago

```
user tiene 1000 CREDIT              FeeRouter
user llama approve(feeRouter, 1000) --- allowance OK
user llama pay(projectId, user, 1000)
                                      |
                                      v
                      Check: projectId esta Active
                      Check: user != 0, amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                      FeeRouter tiene 1000 CREDIT
                                      |
                                      | split = 9500/0/500
                                      v
                        burned = 950, toTreasury = 0, toApp = 50
                                      |
          +---------------------------+----------------------------+
          |                           |                            |
          v                           v                            v
   approve(tracker, 950)       (sin transfer al             transfer(appRecipient, 50)
   tracker.burnAndRecord       Treasury en este split)
                                                              appRecipient es
                                                              projectOwner por default
                                      |
   tracker llama                      |
   credit.burnByRole(router, 950)     |
                                      |
   CREDIT.totalSupply -= 950          |
   burnByRoundProject[R][pid] += 950  |
   totalBurnByRound[R] += 950         |
                                      v
                              Paid event emitted
```

Tras la tx: **FeeRouter tiene 0 CREDIT**. Nunca custodia entre llamadas. Cada `pay` es atómico.

## Salidas de ETH

El Treasury acepta ETH vía `receive` y puede retirar vía `sweepETH(to, amount)`. Usa `call{value}` (no `transfer`/`send`) para compatibilidad con destinos que son contratos con `receive` pesado. Si el destino rechaza, revierte con `ETHTransferFailed`.

El uso es de **cortesía** — el protocolo opera primariamente en ERC-20 (CREDIT, GOV, stables). ETH es aceptado para no dejar donaciones trabadas pero no es el flujo principal.

## Buyback — stub v1

`executeBuyback(stable, amountIn, minGovOut, swapData)` en v1 **no ejecuta swap**. Solo emite `BuybackRequested`. La razón: modelar adecuadamente slippage, TWAP y resistencia a frontrunning exige decisión cuidadosa entre DEX (Uniswap v3 vs Balancer) y va en fase separada.

Mientras tanto, la DAO puede aprobar la intención on-chain. Workers off-chain observan el evento y procesan manualmente (o vía un contrato de integración futuro).

## Resumen

| Componente | Función | Gatekeeping |
|---|---|---|
| Treasury | Custodia multi-activo | `GOVERNANCE_ROLE` en las salidas |
| FeeRouter | Interfaz de pago | `GOVERNANCE_ROLE` en los setters, público en el `pay` |
| Split default | 95% burn / 0% treasury / 5% rebate | Ajustable por propuesta |
| Split por proyecto | Override vía `setProjectSplit` | `GOVERNANCE_ROLE` |
| Recipient del rebate | Owner del proyecto (dinámico) o explícito | Owner del proyecto (setter) |
| Buyback | Stub — solo evento en v1 | `GOVERNANCE_ROLE` |

---

**Siguiente →** [Arquitectura](../03-protocol-overview/01-architecture.md)
