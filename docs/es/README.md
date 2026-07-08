# Documentación de web3community

Bienvenido a la documentación pública de la DAO **web3community** — una plataforma multi-aplicación con economía de doble token (GOV + CREDIT estable 1:1 USDC), staking dirigido por proyecto y un ciclo económico sostenido por el consumo real dentro de las apps del ecosistema.

> **Remodel 2026-07-08.** El protocolo migró de "burn-to-mint deflacionario" a **riel de pagos + financiamiento por rev-share**: [`CreditPSM`](08-contracts-reference/15-CreditPSM.md) (CREDIT 1:1 USDC), [`FeeRouterV2`](08-contracts-reference/08b-FeeRouterV2.md) (fee 2,5%, split 40/40/20) y [`ProjectFunding`](08-contracts-reference/16-ProjectFunding.md) (rondas all-or-nothing, rev-share 1%–30%). Las páginas del modelo anterior están marcadas con "⚠️ LEGADO".

Esta doc es **código-primero**: todo lo que lees aquí es verificable en los contratos dentro de `contracts/`. Si la doc y el código divergen, gana el código — las divergencias son bugs de la doc, no features.

## Rutas de lectura

Cada lector tiene una entrada distinta. Usa la ruta correcta para tu caso.

### Soy nuevo en web3community — quiero entender lo básico

1. [Qué es web3community](01-getting-started/01-what-is-web3community.md)
2. [Modelo mental](01-getting-started/02-mental-model.md)
3. [Glosario](01-getting-started/03-glossary.md)
4. [Rutas de lectura recomendadas](01-getting-started/04-reading-paths.md)

### Soy usuario — quiero participar

1. [Cómo participar](04-for-users/01-participate.md)
2. [Tener GOV](04-for-users/02-holding-gov.md)
3. [Staking en proyectos](04-for-users/03-staking-in-projects.md)
4. [Votar en propuestas](04-for-users/04-voting.md)
5. [Reclamar rewards](04-for-users/05-claiming-rewards.md)

### Soy dev — quiero integrar una app al ecosistema

1. [Visión general de integración](05-for-developers/01-integration-overview.md)
2. [Direcciones de los contratos](05-for-developers/02-contract-addresses.md)
3. [Enviar un proyecto](05-for-developers/03-submitting-a-project.md)
4. [Consultar estado on-chain](05-for-developers/04-querying-state.md)
5. [Entorno local](05-for-developers/05-local-dev.md)

### Quiero entender la economía antes de cualquier exposición

1. [Doble token: GOV y CREDIT](02-core-concepts/01-dual-token-economy.md)
2. [Tokenomics](06-for-investors/01-tokenomics.md)
3. [Value accrual](06-for-investors/02-value-accrual.md)
4. [Riesgos y seguridad](06-for-investors/03-risk-and-security.md)
5. [Métricas que importan](06-for-investors/04-metrics-that-matter.md)

### Quiero consultar un contrato específico

Ve directo a [`08-contracts-reference/`](08-contracts-reference/). Un archivo por contrato.

## Árbol completo

| Sección | Contenido |
|---|---|
| [01-getting-started](01-getting-started/) | Introducción, modelo mental, glosario |
| [02-core-concepts](02-core-concepts/) | Doble token, staking dirigido, gobernanza, proyectos, tesorería (+ burn-to-mint y rewards, legado) |
| [03-protocol-overview](03-protocol-overview/) | Arquitectura, flujos de usuario, flujo de valor |
| [04-for-users](04-for-users/) | Guías paso a paso para usuarios finales |
| [05-for-developers](05-for-developers/) | Integración, direcciones, entorno local |
| [06-for-investors](06-for-investors/) | Tokenomics, value accrual, riesgos, métricas |
| [07-governance](07-governance/) | Ciclo de una propuesta, voting power, parámetros |
| [08-contracts-reference](08-contracts-reference/) | Referencia por contrato (uno por archivo) |
| [09-advanced](09-advanced/) | Deep dives, deploy a mainnet, modelo de seguridad |
| [10-reference](10-reference/) | FAQ, recursos, changelog |

## Convenciones

- **Todas las páginas están en español.**
- **Parámetros numéricos** citados aquí (quorum, lock mínimo, supply cap, etc.) vienen del código — constants en los `.sol`, constructors o parámetros de deploy de Ignition. No hay suposiciones.
- **Los diagramas son ASCII**. Elección deliberada: versionan en git, no dependen de CDN, funcionan en cualquier renderer de markdown.
- **Los enlaces internos** son relativos a la raíz de `docs/`. El renderer del hub los convierte a rutas web en tiempo de build.

## Estado del protocolo

- **Remodel 2026-07-08 activo**: `CreditPSM`, `FeeRouterV2` y `ProjectFunding` son el núcleo económico vigente; `FeeRouter` V1, `BurnTracker`, `RewardDistributor` V1/V2 y `LiquidityGauge` quedan como legado (claims históricos).
- 18 contratos deployables (ver [08-contracts-reference](08-contracts-reference/)).
- Solidity 0.8.24 con `viaIR` activado.
- OpenZeppelin Contracts 5.0.2 pinado.
- Listo para deploy en Sepolia post-auditoría externa.
