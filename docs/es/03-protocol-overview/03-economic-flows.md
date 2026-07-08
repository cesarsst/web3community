# Flujo de valor

**Para quién es:** lector que quiere entender por dónde el valor real entra, transita y sale del protocolo.
**Prerrequisitos:** [Arquitectura](01-architecture.md), [Flujos de usuario](02-user-flows.md).

> **Remodel 2026-07-08.** Esta página describe el modelo vigente: riel de pagos + financiamiento por rev-share. El flujo del modelo anterior (burn 70/20/10 + emisión) está al final, como legado.

## De dónde viene el valor real

La única fuente de **valor externo** en el sistema es el usuario final que deposita USDC en el `CreditPSM` para obtener CREDIT y pagar por servicios de las apps. Si nadie quiere usar las apps, nadie compra CREDIT, y el sistema muere — esa es la invariante dura, igual que antes del remodel.

Lo que cambió es el **riel**: no hay pool, no hay precio flotante, no hay burn. CREDIT es saldo prepago estable:

```
   [ Usuario Charlie ]
        |
        |  1. psm.buy(1000 USDC)  ->  1000 CREDIT (1:1, sin fee)
        |     (el USDC queda RETENIDO en el PSM como respaldo integral)
        v
   [ Wallet de Charlie: 1000 CREDIT ]
        |
        |  2. Usa el ChatApp (projectId 42, ronda financiada al 8%).
        |     approve + feeRouterV2.pay(42, 1000)
        v
   [ FeeRouterV2 ]
        |
        |  fee del protocolo: 2,5% = 25 CREDIT
        |
        +---> 10,0 CREDIT -> treasuryRecipient   (40% de la fee = 1,0% del pago)
        +---> 10,0 CREDIT -> buybackRecipient    (40% de la fee — recompra de GOV)
        +--->  5,0 CREDIT -> grantsRecipient     (20% de la fee — fomento de apps)
        |
        |  rev-share del proyecto: 8% = 80 CREDIT
        +---> 80 CREDIT -> ProjectFunding (notifyRevenue: pro-rata a inversores)
        |
        |  resto: 895 CREDIT (~89,5%)
        +---> directo al appRecipient, EN LA MISMA TX
              (sin ronda financiada seria 975 = 97,5%)
```

**El valor real entró en el protocolo en la etapa 1.** Todas las etapas siguientes redistribuyen ese valor — nada se acuña, nada se quema, el supply de CREDIT no cambia con los pagos.

## Los 5 agentes y por qué cada uno está en el juego

```
   +----------+   +-------------+   +-----------+   +-----------+   +------------+
   | Usuario  |   |    App      |   | Inversor  |   |  Holder   |   |  Treasury  |
   | final    |   | (ChatApp)   |   | (Alice)   |   |  de GOV   |   |  (DAO)     |
   +----+-----+   +------+------+   +-----+-----+   +-----+-----+   +-----+------+
        |                |                |               |               |
   compra CREDIT    recibe ~97,5%    stakea GOV en    vota en el     recibe 40% de
   1:1 en el PSM    de cada pago     el proyecto +    Governor       la fee (= 1%
   paga en apps     (~89,5% con      invierte CREDIT                 del GMV) para
                    rev-share 8%)    en la ronda      expuesto al    opex
        |           + capital        (all-or-nothing) buyback             |
        |           anticipado si         |           continuo (40%      |
        |           abre ronda            |           de la fee)         |
        |                |                |               |               |
   extrae valor     caja inmediata   recibe % de la   captura valor  financia grants
   de un servicio   + financiacion   receita REAL     del volumen    y operacion via
   (fuera del       sin deuda        en cada pago     de pagos       propuestas
   protocolo)       bancaria         (claim s/expira)
```

Nota: **no hay yield "del aire"**. Cada CREDIT que un inversor reclama salió de un pago real de un usuario. Ningún actor recibe valor que no provino de algún actor aguas arriba.

## La economía de una app

Con fee de 2,5% y sin ronda financiada, la app retiene **97,5%** de cada pago — comparable a un procesador de pagos (Stripe cobra ~3,8%) y muy lejos de las app stores (15–30%). Si la app abrió ronda con rev-share de 8%, retiene **89,5%** y a cambio recibió capital anticipado.

### El costo del capital, en números

Ejemplo ilustrativo (los valores dependen del GMV real):

- ChatApp abre ronda: alvo **10.000 CREDIT**, rev-share **8%**, plazo 30 días. La ronda se completa → ChatApp recibe 10.000 CREDIT íntegros.
- ChatApp factura **2.000 CREDIT/mes** de GMV. El rev-share descuenta 2.000 × 8% = **160 CREDIT/mes** para los inversores.
- Costo anualizado del capital: 160 × 12 / 10.000 ≈ **19% a.a.** — comparable a revenue-based financing tradicional, sin deuda, sin garantía personal, sin diluir equity.
- Para los inversores, esos mismos números son el rendimiento bruto: ~19% a.a. **mientras el GMV se sostenga** — si la facturación cae, el retorno cae con ella; si crece, crece junto.

El rev-share no tiene fecha de fin en el MVP: es una fatia perpetua de la receita bruta (la V2 del contrato podrá introducir caps/vencimientos — decisión de gobernanza futura).

## De dónde viene el valor del GOV

GOV es el único activo del sistema con tesis de apreciación, por tres mecanismos:

1. **Buyback continuo**: 40% de la fee de cada pago (= 1% del GMV) va al `buybackRecipient` para recompra de GOV. Volumen de pagos ↑ → presión de compra estructural ↑.
2. **Gate de inversión**: para invertir en cualquier ronda (y para reclamar el rev-share) es obligatorio tener GOV stakeado en el proyecto. Más rondas atractivas → más demanda de GOV para stakear.
3. **Gobernanza**: GOV vota los parámetros (fee dentro del techo de 5%, split, minTarget, whitelist).

## Rotación de CREDIT

CREDIT entra al supply por **una** vía operacional:

1. `CreditPSM.buy` — mint 1:1 contra USDC depositado (respaldo retenido; `mintedOutstanding` lo contabiliza).

*(Vías legadas: el genesis one-shot de 10M al Treasury y los mints de los RewardDistributor pre-remodel. Ese CREDIT circula pero no tiene respaldo en el PSM — las redenciones están limitadas al USDC efectivamente depositado.)*

Y sale por **una** vía:

- `CreditPSM.sell` — quema el CREDIT devuelto y libera USDC 1:1.

El supply de CREDIT ya no es una curva a analizar: **sigue la demanda de saldos de pago**. Crece cuando entra dinero para gastar, cae cuando los usuarios redimen. El precio no flota: 1 CREDIT = 1 USDC por construcción, con `backing()`/`backingNormalized()` verificables on-chain contra `mintedOutstanding`.

## Rotación de GOV

GOV entra al supply de forma permanente hasta alcanzar el cap:

1. Genesis: 0 en el deploy.
2. `mint`: sólo por el owner (Timelock en producción) hasta alcanzar `CAP_SUPPLY = 100M`.
3. Tras alcanzar el cap, `mint` revierte con `CapExceeded`.

No hay burn de GOV en el código.

Circulación:

- **Holder libre** -> compra/venta en DEX.
- **Holder -> Staking**: `stake` lockea GOV en el contrato (habilita invertir en la ronda del proyecto); `unstake` libera.
- **Holder -> Registry**: `registerProject` lockea GOV como colateral; `removeProject` libera (al owner o al treasury).
- **Holder -> TeamVesting (via Timelock)**: contratos de vesting que liberan gradualmente.
- **Holder -> Governor**: `delegate` no mueve GOV, sólo confiere poder de voto.
- **Mercado -> buybackRecipient**: la recompra financiada por el 40% de la fee retira GOV del mercado de forma continua.

## El rol del Treasury en este flujo

El Treasury es el **presupuesto operacional** de la DAO:

- Recibe el 40% de la fee del protocolo — con fee de 2,5%, equivale a **1% del GMV** — para opex.
- Recibe colateral de proyectos removidos con slash y donaciones/activos diversos.
- Distribuye vía propuestas: grants (coordinado con el 20% de la fee), subsidios (`UserSubsidy`), vesting (`TeamVesting`), operación off-chain.

**Separación crítica**: el respaldo USDC del PSM **no es del Treasury**. Está segregado en el `CreditPSM`, sin función de retiro — ni siquiera una propuesta de gobernanza puede gastarlo. Si la DAO quiere gastar, gasta de la fee. Nunca del respaldo.

## Invariantes económicas de salud

Tres señales simples, todas on-chain:

1. **GMV creciente** — `feeRouterV2.grossVolumeOf[projectId]` agregado entre proyectos. Es el proxy directo de uso real (sustituye al "burn por ronda" del modelo legado). GMV plano o cayendo por semanas = alerta.
2. **Respaldo íntegro del PSM** — `psm.backingNormalized() >= psm.mintedOutstanding()`. Garantizado por construcción; cualquier divergencia sería evidencia de bug crítico.
3. **Receita distribuida a inversores creciente** — `funding.totalRevenueDistributed[projectId]`. Mide si el rev-share está pagando de verdad; es el "yield real" agregado del ecosistema.

Métricas completas en [Métricas que importan](../06-for-investors/04-metrics-that-matter.md).

## El modelo anterior (legado) — y por qué cambió

Hasta 2026-07-08, el camino de un pago era: `FeeRouter.pay` → **70% quemado** (vía `BurnTracker`), 20% al Treasury, 10% a la app. La emisión de la ronda siguiente era `min(max(0.95 × burn, floor), capMax)`, repartida en buckets 55/25/15/5 (stakers/LPs/apps/bonders) por el `RewardDistributorV2`. El staker vivía de emisión; la app, del rebate + stake en el propio proyecto.

**El problema**: para la app, la tasa efectiva era ~80% del pago (incluso contando el bucket apps y el stake, la cuenta solo cerraba con supuestos agresivos). Contra Stripe (~3,8%) o cualquier PSP, no había caso de negocio: **la estrategia dominante era hacer bypass del router** — cobrar fuera y usar el protocolo solo como vitrina. El parecer `audit/economist/2026-07-08-feerouter-bypass.md` formalizó el análisis y motivó el remodel.

El modelo vigente invierte la lógica: fee competitiva de procesador de pagos (2,5%), la app retiene casi todo, y el retorno del inversor sale de receita real — no de emisión que dependía de un burn que las apps tenían incentivo de evitar.

---

**Siguiente ->** [Cómo participar](../04-for-users/01-participate.md)
