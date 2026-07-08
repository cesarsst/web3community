# Modelo mental

**Para quem é:** leitor que já sabe que é uma DAO multi-app (ver [O que é](01-what-is-web3community.md)) e agora quer entender como o sistema **pensa**.
**Pré-requisitos:** [O que é a web3community](01-what-is-web3community.md).

Esta página dá os quatro modelos mentais que o protocolo usa. Se você internalizar os quatro, o resto da doc lê rápido — a maioria dos detalhes são consequências desses modelos.

> **Remodel 2026-07-08.** O protocolo deixou de ser "burn-to-mint deflacionário" e virou **trilho de pagamento + funding por rev-share**: CREDIT é estável 1:1 com USDC (via [CreditPSM](../08-contracts-reference/15-CreditPSM.md)), apps pagam fee de 2,5% no [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), e investidores financiam projetos em troca de fatia da receita real via [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). Os modelos abaixo já refletem isso; o mecanismo antigo aparece marcado como legado.

## 1. Dois tokens, dois papéis totalmente distintos

A primeira armadilha é tratar GOV e CREDIT como "dois tokens de uma DAO". Eles **não são simétricos**. Cada um serve um papel que o outro não consegue servir.

```
  GOV (Governance)                     CREDIT (Payment rail)
  -----------------                    -----------------
  Supply FIXO 100M                     Supply ELASTICO
  (cap imutavel)                       (mint no buy, burn no sell
                                        do CreditPSM, 1:1 USDC)

  Vota em propostas                    NAO vota

  Colateral de staking                 Meio de pagamento nos apps
  (trava pra ganhar peso e             (estavel: 1 CREDIT = 1 USDC,
   direito de investir)                 lastro 100% retido no PSM)

  Captura valorizacao via              NAO valoriza nem cai:
  buyback continuo (40% da             resgatavel a qualquer
  fee do FeeRouterV2)                  momento no PSM
```

GOV é **direito político, gate de investimento e peso econômico de longo prazo**. CREDIT é **dinheiro operacional estável da plataforma** — pense nele como "USDC com trilhos do ecossistema", não como aposta. Quem captura a valorização do ecossistema é o GOV (via buyback financiado pela fee); CREDIT nunca foi feito para valorizar no modelo atual. Um erro comum é pensar "stakar CREDIT" (não existe — você staka GOV e **investe** CREDIT) ou "vender voto com CREDIT" (não existe — só GOV vota).

Referência: [Dual-token economy](../02-core-concepts/01-dual-token-economy.md). Contratos: [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md), [CreditToken](../08-contracts-reference/02-CreditToken.md).

## 2. Staking é direcionado, não genérico

No Uniswap, Aave, Curve: você staka um token e recebe reward "do protocolo". Indefinido. Aqui é diferente.

Quando você staka GOV, você **escolhe um projeto**. E o stake compra duas coisas amarradas àquele projeto:

1. **Direito de investir**: só quem tem GOV stakeado no projeto pode entrar na rodada de captação dele no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) — e precisa **manter** o stake para sacar o rev-share (skin in the game).
2. **Curadoria com pele em jogo**: seu capital fica amarrado ao sucesso daquele projeto. Se o ChatApp gera receita, seu investimento rende; se some do mapa, não rende — mesmo que outros projetos estejam bombando.

```
  stake(projectId=ChatApp, amount=100 GOV, lock=180 dias)
                 |
                 v
  Voce gera peso SO no ChatApp. Peso = 100 * multiplier(180 dias).
  O multiplier varia de 1x (14 dias) a 4x (365 dias).

  Com GOV stakeado no ChatApp, voce pode:
     invest(ChatApp, X CREDIT)   na rodada de captacao
     claim(ChatApp)              a cada rodada de receita acumulada
```

(Legado: no modelo pré-remodel, o peso de stake também rateava a emissão de CREDIT por burn — fórmula em [Rewards distribution](../02-core-concepts/04-rewards-distribution.md), contratos `RewardDistributor`/`V2`, hoje legados.)

**Consequência prática**: você precisa escolher projetos. A seleção ativa é parte do modelo — não é passivo. Ser staker aqui é como ser um "curador de apps": você aloca capital onde acha que vai gerar receita real.

Referência: [Directed staking](../02-core-concepts/02-directed-staking.md). Contratos: [Staking](../08-contracts-reference/05-Staking.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

## 3. Renda vem de receita real — não de emissão

Muitos protocolos cunham reward usando supply novo sem contrapartida ("dilui quem não stakou para pagar quem stakou"). Isso tende a criar espiral inflacionária. Desde o remodel 2026-07-08, aqui **não há emissão nenhuma como renda**: o que o investidor recebe é fatia da **receita bruta real** do projeto que ele financiou.

```
  usuario paga 100 CREDIT no ChatApp (FeeRouterV2.pay)
       |
       +--> 2,5 CREDIT  fee do protocolo (40% treasury / 40% buyback GOV / 20% grants)
       +--> 8,0 CREDIT  rev-share (se o ChatApp captou com rev-share de 8%)
       |                 --> rateado pro-rata entre os investidores da rodada
       +--> 89,5 CREDIT pro dono do ChatApp, na hora
```

Traduzindo:

- O investidor financiou a rodada do ChatApp em CREDIT e recebe % de **cada pagamento** — não de emissão. Se o app não fatura, não há renda. Yield verificável on-chain (`totalRevenueDistributed`, `grossVolumeOf`).
- O rev-share é escolhido pelo dono na abertura da rodada, entre **1% e 30%** (100-3000 bps), com prazo de 1 a 90 dias e regra all-or-nothing.
- A fee de 2,5% (teto duro de 5%) financia o protocolo: 40% treasury, 40% buyback contínuo de GOV, 20% grants.

**Implicação**: se ninguém usa os apps, não há receita — logo, não há renda para ninguém. Continua sendo uma ponte entre utilidade real e retorno, mas agora sem inflar nem queimar supply.

(Legado: a fórmula antiga `emissao_R = min(max(alpha * burn_{R-1}, floor(R)), capMax)` com α=0.95 está documentada em [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md) e [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md) — contratos mantidos deployados por compatibilidade histórica.)

Referência: [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

## 4. Toda mudança política passa por delay

Nenhuma função privilegiada dos contratos econômicos aceita chamada direta. Todas exigem `GOVERNANCE_ROLE`, que em produção só o [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) detém. E o Timelock só executa o que foi antes aprovado pelo [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) e esperou o delay (em produção, 172800 segundos = 2 dias).

```
  Alice propoe      Delay 1d      Votacao 7d       Fila timelock    Delay 2d      Execucao
  (precisa de  ->  (anti-MEV)  -> (quorum 4%,   -> (enfileira no -> (tempo de  -> (qualquer
   10k GOV                         For > Against)  timelock)        resposta)     um clica)
   delegados
   a si)
```

Isso garante que **nenhum ator isolado pode drenar fundos, substituir contratos ou mudar parâmetros de forma unilateral**. O custo é latência: propostas levam ~10 dias para executar. Isso é intencional — a latência é o mecanismo de segurança.

Referência: [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md). Contratos: [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md), [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md).

## O que NÃO é o modelo

Para evitar confusões comuns:

- **Não é yield-farming.** Staking aqui trava GOV direcionado a um projeto e é o gate para investir. A renda do investidor é rev-share de receita real, não emissão nem dilução.
- **CREDIT não é aposta.** É estável 1:1 com USDC via `CreditPSM` — não valoriza, não desvaloriza, resgata a qualquer momento. Quem quer exposição à valorização do ecossistema segura GOV.
- **Não é launchpad de token.** O Registry é whitelist de apps que aceitam CREDIT; o `ProjectFunding` vende fatia de **receita**, não tokens novos.
- **Não é banco.** O lastro do PSM é segregado e sem função de saque — nem a governança alcança. O treasury vive da fee (1% do GMV), nunca do lastro.
- **Não é o modelo burn-to-mint.** Queima de 70%, emissão por fórmula, buckets 55/25/15/5 e rodadas de burn são **legado** pré-2026-07-08 — contratos ainda deployados, mas fora do fluxo vigente.

---

**Próximo →** [Glossário](03-glossary.md)
