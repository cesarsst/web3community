# Qué es web3community

**Audiencia:** cualquier persona nueva en el proyecto — dev, usuario o curioso.
**Requisitos previos:** familiaridad básica con wallets EVM (MetaMask, Rabby, Coinbase Wallet). Solidity **no** es requerido para esta página.

## En una frase

web3community es **una plataforma multi-aplicación gobernada por una DAO**, en la que cada app del ecosistema comparte una misma moneda de uso (CREDIT), una misma capa política (gobernanza vía GOV) y un mismo motor económico que convierte uso real en emisión distribuida a los apoyadores.

## El problema que resuelve

En el modelo web2 tradicional, cada aplicación es un silo: token propio, gobernanza propia, base de usuarios propia, monetización propia. El resultado es fragmentación — el usuario cambia de wallet para cada app, el desarrollador sufre para conseguir liquidez y ninguno de los dos se beneficia de la agregación.

web3community comparte tres cosas entre todas las apps listadas:

1. **Identidad económica común.** Toda app acepta CREDIT como pago. Quien compra CREDIT puede usar cualquier app.
2. **Gobernanza común.** Un único Governor + Timelock decide adiciones, ajustes de parámetros y bloqueos de apps maliciosas.
3. **Motor de rewards común.** Quien bloquea GOV dirigido a un proyecto (directed staking) recibe CREDIT emitido en función del uso real de ese proyecto.

El resultado: apps individuales pueden ser pequeñas, pero la red agregada tiene efecto de red. Los usuarios migran de app a app sin cambiar de moneda. Los apoyadores del ecosistema capturan valor proporcional al crecimiento total, no al de una app específica.

## La DAO en 3 capas

Para entender la arquitectura, piensa en tres capas que se superponen.

```
    Capa politica            Governor + Timelock
           |                 (decide que cambia)
           v
    Capa de estado           Registry + Treasury + Staking + BurnTracker
           |                 (guarda quien y que)
           v
    Capa economica           RewardDistributor + FeeRouter + GOV + CREDIT
                             (mueve valor)
```

- **La capa política** está formada por [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) y [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Toda decisión pasa por propuesta + voto + delay de 2 días.
- **La capa de estado** guarda los hechos: quién es dueño de qué proyecto ([`ProjectRegistry`](../08-contracts-reference/03-ProjectRegistry.md)), cuánto de cada token está en la tesorería ([`Treasury`](../08-contracts-reference/04-Treasury.md)), quién stakeó cuánto en qué proyecto ([`Staking`](../08-contracts-reference/05-Staking.md)), cuánto fue quemado en cada ronda ([`BurnTracker`](../08-contracts-reference/06-BurnTracker.md)).
- **La capa económica** mueve valor. Los usuarios pagan en CREDIT a través del [`FeeRouter`](../08-contracts-reference/08-FeeRouter.md) — 95% se quema, 5% va a la app. Los stakers reciben CREDIT recién emitido vía [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md), cuya fórmula ata la emisión futura al burn pasado.

## Los dos tokens en una línea cada uno

- **GOV** — token de gobernanza y colateral de staking. Supply cap inmutable de 100M. Vota en propuestas. Se bloquea en proyectos para generar peso de rewards.
- **CREDIT** — token utilitario. Supply elástico controlado por gobernanza. Quemado cuando usas una app. Acuñado como reward para stakers en función de cuánto fue quemado en la ronda anterior.

Más detalle en [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## El ciclo que mantiene vivo al sistema

En una frase: **uso real → burn de CREDIT → emisión de CREDIT para stakers → más incentivo para apoyar apps → más apps → más uso**.

Si el uso cae, el burn cae, la emisión cae, el incentivo de staking cae, el sistema desacelera. Si el uso crece, todo el ciclo acelera. **El tokenomics no salva a un mal producto** — la sustentación del protocolo depende de que las apps generen utilidad real.

Desarrollo completo en [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

## Quién hace qué

| Rol | Qué hace | Cómo se beneficia |
|---|---|---|
| **Usuario final** | Compra CREDIT, usa las apps | Recibe el servicio de las apps |
| **Desarrollador de app** | Construye la app, integra al FeeRouter | Recibe rebate por uso + rewards si stakea en su propio proyecto |
| **Staker** | Bloquea GOV en un proyecto que apoya | Recibe CREDIT emitido proporcional al burn de ese proyecto |
| **Holder de GOV sin stake** | Participa en la gobernanza | Mantiene derecho de voto sobre parámetros económicos |

## Dónde está el código

- Contratos: `contracts/*.sol` en el repositorio público.
- Deploy: `ignition/modules/Dao.ts` + `ignition/parameters/*.json`.
- Tests: `test/`.

Todos verificables, auditables e inmutables post-deploy excepto por los parámetros ajustables vía gobernanza (listados en [Parámetros](../07-governance/03-parameters.md)).

---

**Siguiente →** [Modelo mental](02-mental-model.md)
