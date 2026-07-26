# Documentação da web3community

Bem-vindo à documentação pública da DAO **web3community** — uma plataforma multi-aplicativos com moeda de pagamento estável (CREDIT, 1:1 com USDC), governança on-chain (GOV) e um motor de funding que converte uso real dos apps em receita para os desenvolvedores e rev-share para quem os financia.

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
5. [Sacar rev-share](04-for-users/05-claiming-revenue.md)

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
| [02-core-concepts](02-core-concepts/) | Dual-token, staking direcionado, trilho de pagamento, funding por rev-share, governança, projetos, tesouraria |
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
- **Parâmetros numéricos** citados aqui (quorum, lock mínimo, supply cap, fee, etc.) vêm do código — constants nos `.sol`, constructors ou parâmetros de deploy Ignition. Não há chutes.
- **Diagramas são ASCII**. Escolha deliberada: versionam em git, não dependem de CDN, funcionam em qualquer renderer de markdown.
- **Links internos** são relativos à raiz de `docs/`. O renderer do hub converte para rotas web em tempo de build.

## O modelo em uma frase

Usuários compram CREDIT 1:1 com USDC no [CreditPSM](08-contracts-reference/03-CreditPSM.md), pagam nos apps via [FeeRouterV2](08-contracts-reference/06-FeeRouterV2.md) (fee de 2,5%; o app fica com ~89,5–97,5% na hora), e investidores que financiaram um projeto via [ProjectFunding](08-contracts-reference/07-ProjectFunding.md) recebem uma fatia da receita bruta a cada pagamento.

## Status do protocolo

- **11 contratos de núcleo** + 1 utilitário exclusivo de rede local (`DevFaucet`) — veja [08-contracts-reference](08-contracts-reference/).
- Solidity 0.8.24 com `viaIR` ativado.
- OpenZeppelin Contracts 5.0.2 pinado.
- Redes: hardhat local (31337) e Sepolia (11155111). Mainnet depende de auditoria externa e de parecer jurídico sobre o rev-share (ver [Riscos e segurança](06-for-investors/03-risk-and-security.md)).
