# Rutas de lectura

**Audiencia:** lector que ya leyó [Qué es](01-what-is-web3community.md) y quiere una secuencia óptima para su propio caso.
**Requisitos previos:** [Qué es web3community](01-what-is-web3community.md), [Modelo mental](02-mental-model.md).

## Ruta del dev — quiero integrar una app

**Objetivo:** sacar una app desde cero y aceptar CREDIT en ella.

1. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md) — entender lo que estás pidiendo que el usuario gaste.
2. [Arquitectura](../03-protocol-overview/01-architecture.md) — ver cómo el FeeRouterV2 conversa con el resto.
3. [Visión general de integración](../05-for-developers/01-integration-overview.md) — flujo técnico paso a paso.
4. [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) — la función `pay` que vas a llamar (fee 2,5%; ~97,5% del pago llega a tu app al instante).
5. [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) — si quieres captar capital anticipado vía rev-share.
6. [Enviar un proyecto](../05-for-developers/03-submitting-a-project.md) — proceso de listado vía gobernanza.
7. [Entorno local](../05-for-developers/05-local-dev.md) — correr todo en localhost.

## Ruta del dev — quiero auditar los contratos

**Objetivo:** entender lo que el protocolo promete on-chain.

1. [Modelo mental](02-mental-model.md) — los 4 modelos.
2. [Arquitectura](../03-protocol-overview/01-architecture.md) — mapa de dependencias.
3. [Modelo de seguridad](../09-advanced/03-security-model.md) — invariantes, vectores mitigados.
4. [Referencia de contratos](../08-contracts-reference/) — léela en orden numérico (tokens → estado → economía → gobernanza → vesting/subsidio).

## Ruta del usuario — quiero usar una app

**Objetivo:** empezar a gastar CREDIT dentro de una app listada.

1. [Cómo participar](../04-for-users/01-participate.md) — pasos de onboarding.
2. [Tener GOV](../04-for-users/02-holding-gov.md) — si también quieres votar/stakear.
3. [Reclamar rewards](../04-for-users/05-claiming-rewards.md) — si ya stakeaste.

## Ruta del usuario — quiero stakear GOV e invertir en proyectos

**Objetivo:** bloquear GOV en proyecto(s) para poder invertir en sus rondas y recibir rev-share.

1. [Directed staking](../02-core-concepts/02-directed-staking.md) — cómo funciona el peso + multiplier.
2. [Staking en proyectos](../04-for-users/03-staking-in-projects.md) — flujo paso a paso.
3. [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) — invertir en una ronda y reclamar receita (rev-share).
4. [Staking (contrato)](../08-contracts-reference/05-Staking.md) — si quieres consultar on-chain.
5. [Reclamar rewards](../04-for-users/05-claiming-rewards.md) — solo si tienes rewards **legados** (pre-remodel) por retirar.

## Ruta de gobernanza — quiero participar en la DAO

**Objetivo:** votar, proponer, entender el poder del Governor.

1. [Governance (concepto)](../02-core-concepts/05-governance.md) — separación de poderes.
2. [Ciclo de propuesta](../07-governance/01-proposal-lifecycle.md) — Pending → Executed.
3. [Voting power](../07-governance/02-voting-power.md) — delegación y snapshot.
4. [Parámetros](../07-governance/03-parameters.md) — qué parámetros ajusta la DAO y en qué rangos.
5. [Votar en propuestas](../04-for-users/04-voting.md) — paso a paso operacional.

## Ruta económica — quiero entender la salud del protocolo

**Objetivo:** formar un juicio informado sobre el tokenomics y la sostenibilidad.

1. [Flujo de valor](../03-protocol-overview/03-economic-flows.md) — fee 2,5%, split 40/40/20, rev-share: por dónde transita el valor.
2. [Tokenomics](../06-for-investors/01-tokenomics.md) — GOV, CREDIT estable 1:1 vía PSM, parámetros.
3. [Value accrual](../06-for-investors/02-value-accrual.md) — de dónde viene el retorno real (rev-share + buyback).
4. [Riesgos y seguridad](../06-for-investors/03-risk-and-security.md) — vectores que pueden matar el sistema.
5. [Métricas que importan](../06-for-investors/04-metrics-that-matter.md) — qué mirar cada semana (GMV, receita distribuida, respaldo del PSM).
6. [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md) — **legado**: el modelo anterior, solo como contexto histórico.

## Ruta del curioso — solo quiero entender de forma general

**Objetivo:** narrativa lineal sin profundizar en contratos.

1. [Qué es](01-what-is-web3community.md)
2. [Modelo mental](02-mental-model.md)
3. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
4. [Flujo de valor](../03-protocol-overview/03-economic-flows.md)
5. [FAQ](../10-reference/01-faq.md)

---

**Siguiente →** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
