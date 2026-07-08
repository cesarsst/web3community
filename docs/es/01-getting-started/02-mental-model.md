# Modelo mental

**Audiencia:** lector que ya sabe que es una DAO multi-app (ver [Qué es](01-what-is-web3community.md)) y ahora quiere entender cómo **piensa** el sistema.
**Requisitos previos:** [Qué es web3community](01-what-is-web3community.md).

Esta página da los cuatro modelos mentales que usa el protocolo desde el remodel 2026-07-08. Si internalizas los cuatro, el resto de la doc se lee rápido — la mayoría de los detalles son consecuencias de estos modelos.

## 1. Dos tokens, dos roles totalmente distintos

La primera trampa es tratar GOV y CREDIT como "dos tokens de una DAO". **No son simétricos**. Cada uno sirve un papel que el otro no puede servir.

```
  GOV (Governance)                     CREDIT (Payment rail)
  -----------------                    ---------------------
  Supply FIJO 100M                     Supply ELASTICO
  (cap inmutable)                      (mint/burn 1:1 via CreditPSM)

  Vota en propuestas                   NO vota

  Colateral de staking                 Estable: 1 CREDIT = 1 USDC
  (lock para poder invertir            (respaldo 100% retenido
   y reclamar rev-share)                en el PSM)

  Captura valor via buyback            NO captura valor: es medio
  continuo (40% de la fee)             de pago, no apuesta

  Su precio flota                      Su precio NO flota
```

GOV es **derecho político, llave de inversión y captura de valor de largo plazo**. CREDIT es **dinero operacional estable de la plataforma**. Nunca mezcles los dos en el razonamiento — un error común es pensar "CREDIT se va a valorizar" (no: es estable por construcción) o "stakeo CREDIT" (no existe — se stakea GOV).

Referencia: [Dual-token economy](../02-core-concepts/01-dual-token-economy.md). Contratos: [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md), [CreditToken](../08-contracts-reference/02-CreditToken.md), [CreditPSM](../08-contracts-reference/15-CreditPSM.md).

## 2. CREDIT es un riel de pago, no una apuesta

En el modelo anterior, CREDIT era deflacionario y su precio flotaba. Eso murió en el remodel. Hoy:

```
  buy():   depositas 100 USDC  ->  el PSM mintea 100 CREDIT para ti
  sell():  devuelves 100 CREDIT -> el PSM los quema y te devuelve 100 USDC

  - Sin fee de conversion, sin slippage, sin pool.
  - USDC tiene 6 decimales, CREDIT 18: el PSM convierte por 1e12 exacto.
  - El USDC depositado queda RETENIDO en el contrato CreditPSM.
  - NO existe funcion de retiro del respaldo. Ni para la governanza.
```

Consecuencia práctica: tener CREDIT es como tener saldo prepago. Compras lo que vas a gastar, gastas, y si sobra puedes redimir 1:1. La pregunta "¿conviene holdear CREDIT?" no tiene sentido en este modelo — CREDIT no rinde ni se aprecia; **el activo de exposición al protocolo es GOV**.

Si la DAO quiere gastar dinero, gasta de la fee que recauda el `FeeRouterV2` — nunca del respaldo del PSM. El respaldo está **segregado por construcción**.

Referencia: [CreditPSM](../08-contracts-reference/15-CreditPSM.md).

## 3. El retorno del inversor viene de ingresos reales — no de emisión

Muchos protocolos pagan "yield" acuñando supply nuevo (dilución disfrazada de retorno). Aquí no hay emisión de rewards: hay **rev-share sobre ingresos brutos reales**.

```
  1. El dueno de un proyecto Active abre UNA ronda de captacion:
     openRound(projectId, alvo en CREDIT, revShareBps 1%-30%, plazo 1-90 dias)

  2. Inversores CON GOV STAKEADO en ese proyecto aportan CREDIT.
     - Sin GOV stakeado en el proyecto -> invest() revierte (NoGovStaked).

  3. All-or-nothing:
     - alcanzo el alvo  -> el dueno recibe todo lo captado; rev-share ACTIVO.
     - vencio sin alvo  -> ronda Failed; refund() devuelve el 100%.

  4. Desde entonces, CADA pago que la app recibe via FeeRouterV2.pay
     descuenta el rev-share y lo acredita pro-rata a los inversores
     (shares = CREDIT invertido). claim() retira lo acumulado
     (exige mantener GOV stakeado; el derecho nunca expira).
```

**Consecuencia práctica**: invertir aquí es underwriting de apps, no farming. Eliges un proyecto, stakeas GOV en él (skin in the game), aportas capital, y tu retorno es un % de la facturación real — si la app factura cero, recibes cero. El `grossVolumeOf[projectId]` del router te da el volumen bruto on-chain para auditar antes de invertir.

Referencia: [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), [Flujo de valor](../03-protocol-overview/03-economic-flows.md).

## 4. Todo cambio político pasa por delay

Ninguna función privilegiada de los contratos económicos acepta llamada directa. Todas exigen `GOVERNANCE_ROLE`, que en producción solo lo tiene [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Y el Timelock solo ejecuta lo que antes fue aprobado por [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) y esperó el delay (en producción, 172800 segundos = 2 días).

```
  Alice propone    Delay 1d      Votacion 7d      Cola timelock    Delay 2d      Ejecucion
  (requiere   ->  (anti-MEV)  -> (quorum 4%,   -> (encola en    -> (tiempo de -> (cualquiera
   10k GOV                         For > Against)   el timelock)     respuesta)    hace clic)
   delegados
   a si)
```

Esto garantiza que **ningún actor aislado puede drenar fondos, sustituir contratos o cambiar parámetros de forma unilateral**. Y hay límites que ni la gobernanza cruza: la fee del `FeeRouterV2` tiene un techo duro de **5%** (`FEE_BPS_CAP = 500`) grabado como constante, y el respaldo del PSM no tiene función de retiro. El costo es latencia: las propuestas tardan ~10 días en ejecutarse. Es intencional — la latencia es el mecanismo de seguridad.

Referencia: [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md). Contratos: [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md), [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md).

## Lo que NO es el modelo

Para evitar confusiones comunes:

- **No es burn-to-mint.** Desde el remodel 2026-07-08 los pagos **no queman** CREDIT y **no hay emisión** de rewards. Ese modelo (burn 70% / emisión `min(max(α×burn, floor), capMax)`) es legado — ver abajo.
- **No es yield-farming.** No existe reward por lockear tokens. El staking de GOV es la **llave** para invertir y reclamar rev-share, no una fuente de emisión.
- **No es un algorithmic stablecoin.** CREDIT no depende de arbitraje ni de un token volátil de respaldo: cada CREDIT minteado por el PSM tiene 1 USDC retenido en el contrato.
- **No es launchpad de tokens.** `ProjectFunding` no emite tokens del proyecto: vende una fatia de los ingresos futuros (revenue-based financing), con shares contables internas.
- **No es ICO de CREDIT.** CREDIT se adquiere 1:1 contra USDC, cuando quieras, sin descuentos ni ventas.

## El modelo anterior (legado)

Hasta 2026-07-08: `FeeRouter` V1 dividía cada pago en 70% burn / 20% treasury / 10% rebate; `RewardDistributorV2` emitía `min(max(0.95 × burn, floor), capMax)` por ronda, repartido en buckets 55/25/15/5 (stakers/LPs/apps/bonders); `BurnTracker` contabilizaba el burn y `LiquidityGauge` incentivaba LPs.

**Motivo del cambio:** con ~80% de tasa efectiva sobre la app, el protocolo no competía con Stripe (~3,8%) ni con las app stores; para cualquier app racional, hacer bypass del router era la estrategia dominante (parecer `audit/economist/2026-07-08-feerouter-bypass.md`). Las páginas legadas siguen disponibles con aviso: [FeeRouter](../08-contracts-reference/08-FeeRouter.md), [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md), [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md), [BurnTracker](../08-contracts-reference/06-BurnTracker.md), [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md).

---

**Siguiente →** [Glosario](03-glossary.md)
