# Changelog de la doc

**Audiencia:** quien quiera saber qué cambió en la documentación.
**Requisitos previos:** ninguno.

Esta página lista cambios notables en la **documentación pública** (`/docs`). Para el changelog de los contratos, ver [`CHANGELOG.md`](https://github.com/web3community/web3community/blob/main/CHANGELOG.md) en la raíz del repositorio.

## [Unreleased]

### Changed

- Reestructuración completa del árbol de docs en 10 secciones progresivas siguiendo patrones de Uniswap / Aave / Optimism. Las rutas antiguas `/docs/01-governancetoken` etc. ahora viven en `/docs/contracts-reference/<Contract>`.
- Renderer Vue (`DocsView.vue`) actualizado para sidebar jerárquica, breadcrumb multi-nivel y navegación prev/next en el pie.
- `sync-docs.ts` del frontend actualizado para walk recursivo preservando el árbol completo.

### Added

- Sección `01-getting-started/` con introducción, modelo mental, glosario y rutas de lectura.
- Sección `02-core-concepts/` con 7 páginas cubriendo dual-token, staking dirigido, burn-to-mint, rewards, gobernanza, whitelist, treasury.
- Sección `03-protocol-overview/` con arquitectura, flujos de usuario y flujo de valor.
- Secciones `04-for-users/`, `05-for-developers/`, `06-for-investors/` con guías por persona.
- Sección `07-governance/` con ciclo de propuesta, voting power y parámetros ajustables.
- Sección `08-contracts-reference/` con 12 archivos (uno por `.sol`).
- Sección `09-advanced/` con deep dives, mainnet deployment y modelo de seguridad.
- Sección `10-reference/` con FAQ, recursos y este changelog.
- Documentación de los contratos `TeamVesting` y `UserSubsidy` (antes ausentes de la doc pública).

### Removed

- Archivos antiguos en la raíz de `docs/` (01-10 numerados + ADVANCED.md + MAINNET-DEPLOY.md + concepts/) migrados al nuevo árbol.

## Histórico (contratos)

Para cambios en los contratos en sí, consulta el archivo `CHANGELOG.md` de la raíz del repositorio, que sigue [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) + [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

Tópicos recientes (extraídos del CHANGELOG):

- v0.1.0 (2026-04-19): Añadidos `TeamVesting` y `UserSubsidy` completos + suites de test.
- Correcciones de flakiness en tests de vesting.
- Cobertura branch subida a 95%+ en `UserSubsidy` y 96.81% en `RewardDistributor`.

---

Ver también: [FAQ](01-faq.md), [Recursos](02-resources.md).
