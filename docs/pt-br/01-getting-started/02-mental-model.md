# Modelo mental

**Para quem é:** leitor que já sabe que é uma DAO multi-app (ver [O que é](01-what-is-web3community.md)) e agora quer entender como o sistema **pensa**.
**Pré-requisitos:** [O que é a web3community](01-what-is-web3community.md).

Esta página dá os quatro modelos mentais que o protocolo usa. Se você internalizar os quatro, o resto da doc lê rápido — a maioria dos detalhes são consequências desses modelos.

## 1. Dois tokens, dois papéis totalmente distintos

A primeira armadilha é tratar GOV e CREDIT como "dois tokens de uma DAO". Eles **não são simétricos**. Cada um serve um papel que o outro não consegue servir.

```
  GOV (Governance)                     CREDIT (Utility)
  -----------------                    -----------------
  Supply FIXO 100M                     Supply ELASTICO
  (cap imutavel)                       (mint/burn via roles)

  Vota em propostas                    NAO vota

  Colateral de staking                 Queimado quando usuario
  (trava pra ganhar peso)              paga em um app

  Nao e queimado no uso                Cunhado como reward

  Valoriza (se) por                    Desinflaciona por
  apreciacao do ecossistema            formula burn > mint
```

GOV é **direito político e peso econômico de longo prazo**. CREDIT é **dinheiro operacional da plataforma**. Nunca misture os dois no raciocínio — um erro comum é pensar "stakar mais CREDIT" (não existe — você staka GOV) ou "vender voto com CREDIT" (não existe — só GOV vota).

Referência: [Dual-token economy](../02-core-concepts/01-dual-token-economy.md). Contratos: [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md), [CreditToken](../08-contracts-reference/02-CreditToken.md).

## 2. Staking é direcionado, não genérico

No Uniswap, Aave, Curve: você staka um token e recebe reward "do protocolo". Indefinido. Aqui é diferente.

Quando você staka GOV, você **escolhe um projeto**. Seu peso de voto no rewards fica amarrado ao sucesso daquele projeto. Se o ChatApp é o projeto escolhido e o ChatApp gera muito burn, você captura muito reward. Se o ChatApp some do mapa, seu peso vira zero reward — mesmo que outros projetos estejam bombando.

```
  stake(projectId=ChatApp, amount=100 GOV, lock=180 dias)
                 |
                 v
  Voce gera peso SO no ChatApp. Peso = 100 * multiplier(180 dias).
  O multiplier varia de 1x (14 dias) a 4x (365 dias).

  Quando a rodada fecha:
     seu_reward = emissao_rodada
                * (burn_do_ChatApp / burn_total)
                * (seu_peso / peso_total_no_ChatApp)
```

**Consequência prática**: você precisa escolher projetos. A seleção ativa é parte do modelo — não é passivo. Ser staker aqui é como ser um "curador de apps": você aloca capital onde acha que vai gerar uso.

Referência: [Directed staking](../02-core-concepts/02-directed-staking.md). Contrato: [Staking](../08-contracts-reference/05-Staking.md).

## 3. Rewards vêm do burn — não do ar

Muitos protocolos cunham reward usando supply novo sem contrapartida ("dilui quem não stakou para pagar quem stakou"). Isso tende a criar espiral inflacionária.

Aqui a fórmula é explicitamente **pós-paga**:

```
  emissao da rodada R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Traduzindo:

- `burn_{R-1}` — quanto CREDIT foi queimado na rodada anterior. Fonte verificável on-chain no [`BurnTracker`](../08-contracts-reference/06-BurnTracker.md).
- `alpha` — multiplicador. Em produção 0.95 (`950000000000000000` wei do arquivo `ignition/parameters/production.json`), ou seja, emite-se **levemente menos** do que foi queimado. O sistema é **levemente deflacionário se o uso for constante**.
- `floor(R)` — piso de emissão da rodada R. Tabela decrescente com 24 entradas (~6 meses se `roundDuration = 7 dias`). Existe só para o bootstrap — garante algum reward enquanto o uso ainda não existe.
- `capMax` — teto duro. Default 5M CREDIT por rodada em produção (`capMax: 5000000000000000000000000`).

**Implicação**: se ninguém usa os apps, não há burn, e depois do round 24 não há floor — logo, não há emissão. Stakers só ganham se o ecossistema gerar uso real. É uma ponte entre utilidade on-chain e reward, não um poço sem fundo.

Referência: [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md). Contrato: [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md).

## 4. Toda mudança política passa por delay

Nenhuma função privilegiada dos contratos econômicos aceita chamada direta. Todas exigem `GOVERNANCE_ROLE`, que em produção só o [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) detém. E o Timelock só executa o que foi antes aprovado pelo [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) e esperou o delay (em produção, 172800 segundos = 2 dias).

```
  Alice propoe      Delay 1d      Votacao 7d      Fila timelock    Delay 2d      Execucao
  (precisa de  ->  (anti-MEV)  -> (quorum 4%,  -> (enfileira no -> (tempo de  -> (qualquer
   10k GOV                         >= 50% For)   timelock)        resposta)     um clica)
   delegados
   a si)
```

Isso garante que **nenhum ator isolado pode drenar fundos, substituir contratos ou mudar parâmetros de forma unilateral**. O custo é latência: propostas levam ~10 dias para executar. Isso é intencional — a latência é o mecanismo de segurança.

Referência: [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md). Contratos: [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md), [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md).

## O que NÃO é o modelo

Para evitar confusões comuns:

- **Não é yield-farming.** Staking aqui trava GOV direcionado a um projeto. Rewards são em CREDIT e vêm de uso real, não de dilução.
- **Não é AMM.** Não há pool de liquidez interna. Troca de CREDIT por stable acontece fora da web3community (DEX externa).
- **Não é launchpad.** O Registry é whitelist de apps que aceitam CREDIT, não distribuidor de tokens novos.
- **Não é ICO de CREDIT.** O genesis de 10M CREDIT é cunhado uma única vez para a tesouraria (`mintGenesis`, one-shot). Emissão subsequente vem só do `RewardDistributor`, atrelada a burn.

---

**Próximo →** [Glossário](03-glossary.md)
