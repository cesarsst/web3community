# Qué es web3community

**Audiencia:** cualquier persona nueva en el proyecto — dev, usuario o curioso.
**Requisitos previos:** familiaridad básica con wallets EVM (MetaMask, Rabby, Coinbase Wallet). Solidity **no** es requerido para esta página.

> **Remodel 2026-07-08.** El protocolo abandonó el modelo "burn-to-mint deflacionario" y pasó a ser un **riel de pagos + financiamiento por rev-share**. Esta página describe el modelo vigente. El modelo anterior queda documentado como referencia histórica — ver [la sección de legado](#el-modelo-anterior-legado) al final.

## En una frase

web3community es **una plataforma multi-aplicación gobernada por una DAO**, en la que cada app del ecosistema comparte una misma moneda de pago estable (CREDIT, 1:1 con USDC), una misma capa política (gobernanza vía GOV) y un mismo motor de financiamiento que convierte ingresos reales de las apps en retorno para sus inversores (rev-share).

## El problema que resuelve

En el modelo web2 tradicional, cada aplicación es un silo: token propio, gobernanza propia, base de usuarios propia, monetización propia. El resultado es fragmentación — el usuario cambia de wallet para cada app, el desarrollador sufre para conseguir capital y ninguno de los dos se beneficia de la agregación.

web3community comparte tres cosas entre todas las apps listadas:

1. **Riel de pago común.** Toda app acepta CREDIT como pago. CREDIT es estable — se compra y se redime 1:1 contra USDC en el [`CreditPSM`](../08-contracts-reference/15-CreditPSM.md), con respaldo del 100% retenido on-chain. Quien tiene CREDIT puede pagar en cualquier app.
2. **Gobernanza común.** Un único Governor + Timelock decide adiciones, ajustes de parámetros y bloqueos de apps maliciosas.
3. **Financiamiento común.** El dueño de un proyecto puede abrir una ronda de captación en [`ProjectFunding`](../08-contracts-reference/16-ProjectFunding.md): los inversores (con GOV stakeado en el proyecto) aportan CREDIT por adelantado y, a cambio, reciben un porcentaje (1%–30%) de los ingresos brutos futuros de esa app, pagado automáticamente en cada pago que la app recibe.

El resultado: apps individuales pueden ser pequeñas, pero la red agregada tiene efecto de red. Los usuarios migran de app a app sin cambiar de moneda. Los inversores capturan valor proporcional a los ingresos **reales** de las apps que eligieron financiar — no a una emisión inflacionaria.

## La DAO en 3 capas

Para entender la arquitectura, piensa en tres capas que se superponen.

```
    Capa politica            Governor + Timelock
           |                 (decide que cambia)
           v
    Capa de estado           Registry + Treasury + Staking
           |                 (guarda quien y que)
           v
    Capa economica           CreditPSM + FeeRouterV2 + ProjectFunding + GOV + CREDIT
                             (mueve valor)
```

- **La capa política** está formada por [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) y [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Toda decisión pasa por propuesta + voto + delay de 2 días.
- **La capa de estado** guarda los hechos: quién es dueño de qué proyecto ([`ProjectRegistry`](../08-contracts-reference/03-ProjectRegistry.md)), cuánto de cada token está en la tesorería ([`Treasury`](../08-contracts-reference/04-Treasury.md)), quién stakeó cuánto GOV en qué proyecto ([`Staking`](../08-contracts-reference/05-Staking.md)).
- **La capa económica** mueve valor. El usuario compra CREDIT depositando USDC en el [`CreditPSM`](../08-contracts-reference/15-CreditPSM.md) (1:1, sin fee). Paga en las apps a través del [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) — fee del protocolo de **2,5%** (dividida 40% tesorería / 40% buyback de GOV / 20% grants), después el rev-share del proyecto (si hubo ronda financiada) va a los inversores vía [`ProjectFunding`](../08-contracts-reference/16-ProjectFunding.md), y el resto (~89,5%–97,5%) va al dueño de la app **en el mismo instante**.

## Los dos tokens en una línea cada uno

- **GOV** — token de gobernanza, colateral de staking y llave de inversión. Supply cap inmutable de 100M. Vota en propuestas. Se stakea en proyectos para poder invertir en sus rondas y reclamar rev-share. Captura valor vía buyback continuo financiado por la fee del protocolo.
- **CREDIT** — medio de pago estable. 1:1 con USDC vía `CreditPSM` (respaldo 100% retenido, sin función de retiro — ni siquiera para la gobernanza). No es deflacionario ni especulativo: es el dinero operacional de la plataforma.

Más detalle en [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## El ciclo que mantiene vivo al sistema

En una frase: **uso real → pagos en CREDIT → fee de 2,5% financia tesorería, buyback de GOV y grants → rev-share paga a los inversores → más capital disponible para nuevas apps → más apps → más uso**.

Si el uso cae, los ingresos caen, el rev-share cae, el buyback cae, el sistema desacelera. Si el uso crece, todo el ciclo acelera. **El tokenomics no salva a un mal producto** — la sustentación del protocolo depende de que las apps generen ingresos reales.

Desarrollo completo en [Flujo de valor](../03-protocol-overview/03-economic-flows.md).

## Quién hace qué

| Rol | Qué hace | Cómo se beneficia |
|---|---|---|
| **Usuario final** | Compra CREDIT en el PSM (1:1 USDC), usa las apps | Recibe el servicio de las apps; puede redimir CREDIT sobrante 1:1 |
| **Desarrollador de app** | Construye la app, integra `FeeRouterV2.pay` | Recibe ~97,5% de cada pago al instante (~89,5% con rev-share de 8%) + capital anticipado si abre ronda |
| **Inversor** | Stakea GOV en un proyecto y aporta CREDIT en su ronda | Recibe % de los ingresos **reales** de la app en cada pago (rev-share 1%–30%) |
| **Holder de GOV** | Participa en la gobernanza | Derecho de voto + exposición al buyback continuo de GOV (40% de la fee) |

## Dónde está el código

- Contratos: `contracts/*.sol` en el repositorio público. Los tres pilares del remodel: `CreditPSM.sol`, `FeeRouterV2.sol`, `ProjectFunding.sol`.
- Deploy: `ignition/modules/Dao.ts` + `ignition/parameters/*.json`; remodel vía `scripts/deploy-remodel.ts`.
- Tests: `test/`.

Todos verificables, auditables e inmutables post-deploy excepto por los parámetros ajustables vía gobernanza (listados en [Parámetros](../07-governance/03-parameters.md)).

## El modelo anterior (legado)

Hasta 2026-07-08, el protocolo operaba en modo "burn-to-mint": 70% de cada pago se quemaba, 20% iba a la tesorería y 10% a la app ([`FeeRouter`](../08-contracts-reference/08-FeeRouter.md) V1); la emisión de CREDIT de cada ronda seguía `min(max(α × burn, floor), capMax)` con α = 0,95 y se repartía a stakers/LPs/apps/bonders ([`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md)).

**Por qué cambió:** la tasa efectiva de ~80% sobre la app no competía con Stripe (~3,8%) ni con las app stores — hacer el bypass del router era la estrategia dominante para cualquier app racional. El parecer económico `audit/economist/2026-07-08-feerouter-bypass.md` documenta el análisis. Las páginas de los contratos legados permanecen en [08-contracts-reference](../08-contracts-reference/) marcadas con el aviso de legado.

---

**Siguiente →** [Modelo mental](02-mental-model.md)
