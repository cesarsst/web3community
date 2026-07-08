# O que é a web3community

**Para quem é:** qualquer pessoa nova no projeto — dev, usuário ou curioso.
**Pré-requisitos:** familiaridade básica com carteiras EVM (MetaMask, Rabby, Coinbase Wallet). Solidity **não** é exigido para esta página.

## Em uma frase

A web3community é **uma plataforma multi-aplicativos governada por uma DAO**, em que cada app do ecossistema compartilha uma mesma moeda de uso (CREDIT, estável 1:1 com USDC), uma mesma camada política (governança via GOV) e um mesmo motor econômico que converte uso real em receita para os apps e renda de rev-share para quem os financia (remodel 2026-07-08).

## O problema que ela resolve

No modelo web2 tradicional, cada aplicativo é um silo: token próprio, governança própria, base de usuários própria, monetização própria. O resultado é fragmentação — usuário troca carteira para cada app, desenvolvedor sofre para arrancar liquidez e nenhum dos dois se beneficia da agregação.

A web3community compartilha três coisas entre todos os apps listados:

1. **Identidade econômica comum.** Todo app aceita CREDIT como pagamento. Quem compra CREDIT pode usar qualquer app.
2. **Governança comum.** Um único Governor + Timelock decide adições, ajustes de parâmetros e bloqueios de apps maliciosos.
3. **Motor de funding comum.** Quem trava GOV direcionado a um projeto (staking direcionado) pode financiar a rodada de captação dele e recebe fatia da receita real (rev-share) a cada pagamento. (Legado: no modelo pré-2026-07-08, o stake capturava CREDIT emitido em função do burn.)

O resultado: apps individuais podem ser pequenos, mas a rede agregada tem efeito de rede. Usuários migram de app para app sem trocar de moeda. Apoiadores do ecossistema capturam valor proporcional ao crescimento total, não a um app específico.

## A DAO em 3 camadas

Para entender a arquitetura, pense em três camadas que se sobrepõem.

```
    Camada politica          Governor + Timelock
           |                 (decide o que muda)
           v
    Camada de estado         Registry + Treasury + Staking + ProjectFunding
           |                 (guarda quem e o que)
           v
    Camada economica         CreditPSM + FeeRouterV2 + GOV + CREDIT
                             (move valor)
```

- **Camada política** é formada por [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) e [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Toda decisão passa por proposta + voto + delay de 2 dias.
- **Camada de estado** guarda os fatos: quem é dono de qual projeto ([`ProjectRegistry`](../08-contracts-reference/03-ProjectRegistry.md)), quanto de cada token está na tesouraria ([`Treasury`](../08-contracts-reference/04-Treasury.md)), quem stakou quanto em qual projeto ([`Staking`](../08-contracts-reference/05-Staking.md)), quem captou e quem investiu em cada rodada ([`ProjectFunding`](../08-contracts-reference/16-ProjectFunding.md)).
- **Camada econômica** move valor. Usuários compram CREDIT 1:1 com USDC no [`CreditPSM`](../08-contracts-reference/15-CreditPSM.md) e pagam através do [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) — fee de 2,5% (40% treasury / 40% buyback de GOV / 20% grants), rev-share pro funding (se houver) e o resto (~89,5-97,5%) direto pro app. (Legado: o trilho burn-to-mint com FeeRouter V1 + RewardDistributor está descrito nas páginas dos contratos.)

## Os dois tokens em uma linha cada

- **GOV** — token de governança e colateral de staking. Supply cap imutável de 100M. Vota em propostas. É lockado em projetos para gerar peso — que dá o direito de investir nas rodadas de captação. Captura valorização via buyback contínuo financiado pela fee.
- **CREDIT** — meio de pagamento **estável 1:1 com USDC** (compra e resgate no PSM, sem taxa, lastro 100% retido). Não é deflacionário nem especulativo.

Mais detalhe em [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## O ciclo que mantém o sistema vivo

Em uma frase: **uso real → receita pros apps (97,5%) + rev-share pros investidores + fee pro protocolo (2,5%) → mais capital antecipado pra apps → mais apps → mais uso**.

Se o uso cai, a receita cai, o rev-share seca, o buyback de GOV para, o sistema desacelera. Se o uso cresce, todo o ciclo acelera. **Tokenomics não salva produto ruim** — a sustentação do protocolo depende dos apps gerarem utilidade real.

Detalhamento completo em [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).

## Quem faz o quê

| Papel | O que faz | Como se beneficia |
|---|---|---|
| **Usuário final** | Compra CREDIT no PSM (1:1 USDC), usa os apps | Recebe o serviço dos apps; resgata o CREDIT quando quiser |
| **Desenvolvedor de app** | Constrói app, integra ao FeeRouterV2 | Fica com ~89,5-97,5% da receita na hora + capital antecipado via rodada de funding |
| **Investidor** | Trava GOV no projeto e investe CREDIT na rodada | Recebe % da receita real (rev-share) a cada pagamento |
| **Holder de GOV sem stake** | Participa da governança | Voto sobre parâmetros + buyback contínuo (1% do GMV) |

## Onde está o código

- Contratos: `contracts/*.sol` no repositório público.
- Deploy: `ignition/modules/Dao.ts` + `ignition/parameters/*.json`.
- Testes: `test/`.

Todos verificáveis, auditáveis e imutáveis pós-deploy exceto pelos parâmetros ajustáveis via governança (listados em [Parâmetros](../07-governance/03-parameters.md)).

---

**Próximo →** [Modelo mental](02-mental-model.md)
