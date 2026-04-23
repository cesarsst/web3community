# Changelog da doc

**Para quem é:** quem quer saber o que mudou na documentação.
**Pré-requisitos:** nenhum.

Esta página lista mudanças notáveis na **documentação pública** (`/docs`). Para o changelog dos contratos, veja [`CHANGELOG.md`](https://github.com/web3community/web3community/blob/main/CHANGELOG.md) na raiz do repositório.

## [Unreleased]

### Changed

- Restruturação completa da árvore de docs em 10 seções progressivas seguindo padrões de Uniswap / Aave / Optimism. Rotas antigas `/docs/01-governancetoken` etc. agora vivem em `/docs/contracts-reference/<Contract>`.
- Renderer Vue (`DocsView.vue`) atualizado para sidebar hierárquica, breadcrumb multi-nível e navegação prev/next no rodapé.
- `sync-docs.ts` do frontend atualizado para walk recursivo preservando árvore completa.

### Added

- Seção `01-getting-started/` com introdução, modelo mental, glossário e trilhas de leitura.
- Seção `02-core-concepts/` com 7 páginas cobrindo dual-token, staking direcionado, burn-to-mint, rewards, governança, whitelist, treasury.
- Seção `03-protocol-overview/` com arquitetura, fluxos de usuário e fluxo de valor.
- Seções `04-for-users/`, `05-for-developers/`, `06-for-investors/` com guias por persona.
- Seção `07-governance/` com ciclo de proposta, voting power e parâmetros ajustáveis.
- Seção `08-contracts-reference/` com 12 arquivos (um por `.sol`).
- Seção `09-advanced/` com deep dives, mainnet deployment e modelo de segurança.
- Seção `10-reference/` com FAQ, recursos e este changelog.
- Documentação dos contratos `TeamVesting` e `UserSubsidy` (antes ausentes da doc pública).

### Removed

- Arquivos antigos na raiz de `docs/` (01-10 numerados + ADVANCED.md + MAINNET-DEPLOY.md + concepts/) migrados para a nova árvore.

## Histórico (contratos)

Para mudanças nos contratos em si, consulte o arquivo `CHANGELOG.md` da raiz do repositório, que segue [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) + [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

Tópicos recentes (extraídos do CHANGELOG):

- v0.1.0 (2026-04-19): Adicionados `TeamVesting` e `UserSubsidy` completos + suites de teste.
- Correções de flakiness em testes de vesting.
- Cobertura branch subida para 95%+ em `UserSubsidy` e 96.81% em `RewardDistributor`.

---

Ver também: [FAQ](01-faq.md), [Recursos](02-resources.md).
