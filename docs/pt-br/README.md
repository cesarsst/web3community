# Documentação da web3community

Bem-vindo à documentação pública da DAO **web3community** — uma plataforma multi-aplicativos com economia dual-token (GOV + CREDIT), staking direcionado por projeto e ciclo econômico sustentado pelo consumo real dentro dos apps do ecossistema.

Esta doc é **código-primeiro**: tudo o que você lê aqui é verificável nos contratos em `contracts/`. Se a doc e o código divergirem, o código ganha — divergências são bugs da doc, não features.

## Trilhas de leitura

Cada leitor tem uma entrada diferente. Use a trilha certa para o seu caso.

### Sou novo na web3community — quero entender o básico

1. [O que é a web3community](01-getting-started/01-what-is-web3community.md)
2. [Modelo mental](01-getting-started/02-mental-model.md)
3. [Glossário](01-getting-started/03-glossary.md)
4. [Trilhas de leitura recomendadas](01-getting-started/04-reading-paths.md)

### Sou usuário — quero participar

1. [Como participar](04-for-users/01-participate.md)
2. [Ter GOV](04-for-users/02-holding-gov.md)
3. [Staking em projetos](04-for-users/03-staking-in-projects.md)
4. [Votar em propostas](04-for-users/04-voting.md)
5. [Reivindicar rewards](04-for-users/05-claiming-rewards.md)

### Sou dev — quero integrar um app ao ecossistema

1. [Visão geral de integração](05-for-developers/01-integration-overview.md)
2. [Endereços dos contratos](05-for-developers/02-contract-addresses.md)
3. [Submeter um projeto](05-for-developers/03-submitting-a-project.md)
4. [Consultar estado on-chain](05-for-developers/04-querying-state.md)
5. [Ambiente local](05-for-developers/05-local-dev.md)

### Quero entender a economia antes de qualquer exposição

1. [Dual-token: GOV e CREDIT](02-core-concepts/01-dual-token-economy.md)
2. [Tokenomics](06-for-investors/01-tokenomics.md)
3. [Value accrual](06-for-investors/02-value-accrual.md)
4. [Riscos e segurança](06-for-investors/03-risk-and-security.md)
5. [Métricas que importam](06-for-investors/04-metrics-that-matter.md)

### Quero consultar contrato específico

Vá direto a [`08-contracts-reference/`](08-contracts-reference/). Um arquivo por contrato.

## Árvore completa

| Seção | Conteúdo |
|---|---|
| [01-getting-started](01-getting-started/) | Introdução, modelo mental, glossário |
| [02-core-concepts](02-core-concepts/) | Dual-token, staking direcionado, burn-to-mint, rewards, governança, projetos, tesouraria |
| [03-protocol-overview](03-protocol-overview/) | Arquitetura, fluxos de usuário, fluxo de valor |
| [04-for-users](04-for-users/) | Guias passo a passo para usuários finais |
| [05-for-developers](05-for-developers/) | Integração, endereços, ambiente local |
| [06-for-investors](06-for-investors/) | Tokenomics, value accrual, riscos, métricas |
| [07-governance](07-governance/) | Ciclo de uma proposta, voting power, parâmetros |
| [08-contracts-reference](08-contracts-reference/) | Referência por contrato (um por arquivo) |
| [09-advanced](09-advanced/) | Deep dives, mainnet deploy, modelo de segurança |
| [10-reference](10-reference/) | FAQ, recursos, changelog |

## Convenções

- **Todas as páginas estão em português.**
- **Parâmetros numéricos** citados aqui (quorum, lock mínimo, supply cap, etc.) vêm do código — constants nos `.sol`, constructors ou parâmetros de deploy Ignition. Não há chutes.
- **Diagramas são ASCII**. Escolha deliberada: versionam em git, não dependem de CDN, funcionam em qualquer renderer de markdown.
- **Links internos** são relativos à raiz de `docs/`. O renderer do hub converte para rotas web em tempo de build.

## Status do protocolo

- 15 contratos em produção (veja [08-contracts-reference](08-contracts-reference/)).
- Solidity 0.8.24 com `viaIR` ativado.
- OpenZeppelin Contracts 5.0.2 pinado.
- Pronto para deploy Sepolia pós-auditoria externa.
