# O que é a web3community

**Para quem é:** qualquer pessoa nova no projeto — dev, usuário ou curioso.
**Pré-requisitos:** familiaridade básica com carteiras EVM (MetaMask, Rabby, Coinbase Wallet). Solidity **não** é exigido para esta página.

## Em uma frase

A web3community é **uma plataforma multi-aplicativos governada por uma DAO**, em que cada app do ecossistema compartilha uma mesma moeda de uso (CREDIT), uma mesma camada política (governança via GOV) e um mesmo motor econômico que converte uso real em emissão distribuída a apoiadores.

## O problema que ela resolve

No modelo web2 tradicional, cada aplicativo é um silo: token próprio, governança própria, base de usuários própria, monetização própria. O resultado é fragmentação — usuário troca carteira para cada app, desenvolvedor sofre para arrancar liquidez e nenhum dos dois se beneficia da agregação.

A web3community compartilha três coisas entre todos os apps listados:

1. **Identidade econômica comum.** Todo app aceita CREDIT como pagamento. Quem compra CREDIT pode usar qualquer app.
2. **Governança comum.** Um único Governor + Timelock decide adições, ajustes de parâmetros e bloqueios de apps maliciosos.
3. **Motor de rewards comum.** Quem trava GOV direcionado a um projeto (staking direcionado) recebe CREDIT emitido em função do uso real daquele projeto.

O resultado: apps individuais podem ser pequenos, mas a rede agregada tem efeito de rede. Usuários migram de app para app sem trocar de moeda. Apoiadores do ecossistema capturam valor proporcional ao crescimento total, não a um app específico.

## A DAO em 3 camadas

Para entender a arquitetura, pense em três camadas que se sobrepõem.

```
    Camada politica          Governor + Timelock
           |                 (decide o que muda)
           v
    Camada de estado         Registry + Treasury + Staking + BurnTracker
           |                 (guarda quem e o que)
           v
    Camada economica         RewardDistributor + FeeRouter + GOV + CREDIT
                             (move valor)
```

- **Camada política** é formada por [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) e [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Toda decisão passa por proposta + voto + delay de 2 dias.
- **Camada de estado** guarda os fatos: quem é dono de qual projeto ([`ProjectRegistry`](../08-contracts-reference/03-ProjectRegistry.md)), quanto de cada token está na tesouraria ([`Treasury`](../08-contracts-reference/04-Treasury.md)), quem stakou quanto em qual projeto ([`Staking`](../08-contracts-reference/05-Staking.md)), quanto foi queimado em cada rodada ([`BurnTracker`](../08-contracts-reference/06-BurnTracker.md)).
- **Camada econômica** move valor. Usuários pagam em CREDIT através do [`FeeRouter`](../08-contracts-reference/08-FeeRouter.md) — no split default de produção, 70% é queimado, 20% vai à tesouraria e 10% vai ao app. Stakers recebem CREDIT recém-emitido via [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md), cuja fórmula amarra emissão futura ao burn passado.

## Os dois tokens em uma linha cada

- **GOV** — token de governança e colateral de staking. Supply cap imutável de 100M. Vota em propostas. É lockado em projetos para gerar peso de rewards.
- **CREDIT** — token utilitário. Supply elástico controlado por governança. Queimado quando você usa um app. Cunhado como reward para stakers em função do quanto foi queimado na rodada anterior.

Mais detalhe em [Dual-token economy](../02-core-concepts/01-dual-token-economy.md).

## O ciclo que mantém o sistema vivo

Em uma frase: **uso real → burn de CREDIT → emissão de CREDIT para stakers → mais incentivo para suportar apps → mais apps → mais uso**.

Se o uso cai, o burn cai, a emissão cai, o incentivo de staking cai, o sistema desacelera. Se o uso cresce, todo o ciclo acelera. **Tokenomics não salva produto ruim** — a sustentação do protocolo depende dos apps gerarem utilidade real.

Detalhamento completo em [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

## Quem faz o quê

| Papel | O que faz | Como se beneficia |
|---|---|---|
| **Usuário final** | Compra CREDIT, usa os apps | Recebe o serviço dos apps |
| **Desenvolvedor de app** | Constrói app, integra ao FeeRouter | Recebe rebate por uso + rewards se stakar no próprio projeto |
| **Staker** | Trava GOV em projeto que suporta | Recebe CREDIT emitido proporcional ao burn desse projeto |
| **Holder de GOV sem stake** | Participa da governança | Mantém direito de voto sobre parâmetros econômicos |

## Onde está o código

- Contratos: `contracts/*.sol` no repositório público.
- Deploy: `ignition/modules/Dao.ts` + `ignition/parameters/*.json`.
- Testes: `test/`.

Todos verificáveis, auditáveis e imutáveis pós-deploy exceto pelos parâmetros ajustáveis via governança (listados em [Parâmetros](../07-governance/03-parameters.md)).

---

**Próximo →** [Modelo mental](02-mental-model.md)
