# Trilhas de leitura

**Para quem é:** leitor que já leu [O que é](01-what-is-web3community.md) e quer uma sequência ótima para o próprio caso.
**Pré-requisitos:** [O que é a web3community](01-what-is-web3community.md), [Modelo mental](02-mental-model.md).

## Trilha do dev — quero integrar um app

**Objetivo:** tirar um app do zero e aceitar CREDIT nele.

1. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md) — entender o que você está pedindo que o usuário gaste (CREDIT estável 1:1 USDC).
2. [Fluxo de valor](../03-protocol-overview/03-economic-flows.md) — como o pagamento se reparte (fee 2,5%, rev-share, ~89,5–97,5% pro app).
3. [Visão geral de integração](../05-for-developers/01-integration-overview.md) — fluxo técnico passo a passo (`pay(projectId, amount)` + evento `PaymentRouted`).
4. [FeeRouterV2](../08-contracts-reference/06-FeeRouterV2.md) — a função `pay` que o usuário vai chamar; [ProjectFunding](../08-contracts-reference/07-ProjectFunding.md) se você quiser captar.
5. [Submeter um projeto](../05-for-developers/03-submitting-a-project.md) — processo de listagem via governança.
6. [Ambiente local](../05-for-developers/05-local-dev.md) — rodar tudo em localhost.

## Trilha do dev — quero auditar os contratos

**Objetivo:** entender o que o protocolo promete on-chain.

1. [Modelo mental](02-mental-model.md) — os 4 modelos.
2. [Arquitetura](../03-protocol-overview/01-architecture.md) — mapa de dependências.
3. [Modelo de segurança](../09-advanced/03-security-model.md) — invariantes, vetores mitigados.
4. [Referência de contratos](../08-contracts-reference/) — leia na ordem numérica (tokens → trilho de pagamento → estado → funding → governança → vesting).

## Trilha do usuário — quero usar um app

**Objetivo:** começar a gastar CREDIT dentro de um app listado.

1. [Como participar](../04-for-users/01-participate.md) — onboarding: comprar CREDIT no PSM (1:1, sem taxa) e pagar nos apps.
2. [CreditPSM](../08-contracts-reference/03-CreditPSM.md) — entrada e saída do CREDIT (compra e resgate).
3. [Ter GOV](../04-for-users/02-holding-gov.md) — se quiser também votar/investir.

## Trilha do investidor — quero stakar GOV e investir em projetos

**Objetivo:** travar GOV em projeto(s), investir CREDIT nas rodadas e receber rev-share da receita real.

1. [Directed staking](../02-core-concepts/02-directed-staking.md) — stake como curadoria + gate de investimento.
2. [Staking em projetos](../04-for-users/03-staking-in-projects.md) — fluxo passo a passo (stake → invest → claim).
3. [ProjectFunding](../08-contracts-reference/07-ProjectFunding.md) — rodadas all-or-nothing, rev-share 1–30%, prazo 1–90 dias.
4. [Sacar rev-share](../04-for-users/05-claiming-revenue.md) — como sacar (nunca expira).
5. [Staking (contrato)](../08-contracts-reference/05-Staking.md) — se quiser consultar on-chain.

## Trilha de governança — quero participar da DAO

**Objetivo:** votar, propor, entender o poder do Governor.

1. [Governance (conceito)](../02-core-concepts/05-governance.md) — separação de poderes.
2. [Ciclo de proposta](../07-governance/01-proposal-lifecycle.md) — Pending → Executed.
3. [Voting power](../07-governance/02-voting-power.md) — delegação e snapshot.
4. [Parâmetros](../07-governance/03-parameters.md) — quais parâmetros a DAO ajusta e em que faixas.
5. [Votar em propostas](../04-for-users/04-voting.md) — passo a passo operacional.

## Trilha econômica — quero entender a saúde do protocolo

**Objetivo:** formar um juízo informado sobre o tokenomics e a sustentabilidade.

1. [Fluxo de valor](../03-protocol-overview/03-economic-flows.md) — por onde o valor real entra, transita e sai (PSM, fee 2,5% 40/40/20, rev-share).
2. [Trilho de pagamento](../02-core-concepts/03-payment-rail.md) + [Funding por rev-share](../02-core-concepts/04-project-funding.md) — os dois conceitos centrais.
3. [Value accrual](../06-for-investors/02-value-accrual.md) — de onde vem valor real (GOV captura via buyback de 1% do GMV).
4. [Riscos e segurança](../06-for-investors/03-risk-and-security.md) — receita do app, peg/lastro, regulatório.
5. [Métricas que importam](../06-for-investors/04-metrics-that-matter.md) — GMV, receita distribuída, lastro do PSM.

## Trilha do curioso — só quero entender de forma geral

**Objetivo:** narrativa linear sem aprofundar em contrato.

1. [O que é](01-what-is-web3community.md)
2. [Modelo mental](02-mental-model.md)
3. [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
4. [Fluxo de valor](../03-protocol-overview/03-economic-flows.md)
5. [FAQ](../10-reference/01-faq.md)

---

**Próximo →** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md)
