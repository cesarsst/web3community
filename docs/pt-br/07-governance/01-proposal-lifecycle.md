# Ciclo de uma proposta

**Para quem é:** quem quer entender como uma decisão vira mudança on-chain, do rascunho à execução.
**Pré-requisitos:** noção de que a DAO controla os contratos econômicos ([O que é a web3community](../01-getting-started/01-what-is-web3community.md)).

Toda mudança governável no protocolo passa por um único caminho: [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) (OpenZeppelin Governor) para votar, [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) (TimelockController) para executar com atraso. Nenhuma EOA tem poder unilateral sobre os contratos econômicos em produção.

## O caminho, do início ao fim

```
propose ──▶ [votingDelay] ──▶ votação aberta ──▶ [votingPeriod] ──▶ Succeeded
   │           (7200 blk)         (cast votes)        (50400 blk)        │
   │                                                                     ▼
   │                                                                   queue
   │                                                                     │
   │                                                          [Timelock minDelay]
   │                                                              (2 dias)
   │                                                                     ▼
   └── proposalThreshold (10.000 GOV)                                 execute
       supermajority scan no propose                             (qualquer um chama)
```

## Estados da proposta

O `state(proposalId)` do Governor percorre:

| Estado | Significado |
|---|---|
| `Pending` | criada, aguardando o `votingDelay` para abrir a votação |
| `Active` | janela de votação aberta — `castVote` aceito |
| `Defeated` | não passou (quorum não atingido, ou regra de sucesso falhou) |
| `Succeeded` | passou — pronta para `queue` |
| `Queued` | enfileirada no Timelock, cumprindo o `minDelay` |
| `Executed` | executada — a mudança está on-chain |
| `Canceled` | cancelada (pelo proposer ou via governança) |
| `Expired` | passou do prazo de execução no Timelock sem ser executada |

## 1. Propor

`propose(targets, values, calldatas, description)` cria a proposta. Uma proposta é uma lista de chamadas que o Timelock executará se ela passar — por exemplo, "chame `FeeRouterV2.setFeeBps(300)`".

- **Threshold.** O proposer precisa ter, delegado a si, ao menos o `proposalThreshold` de voting power (produção: `10.000 GOV`, 0,01% do cap). Baixo o suficiente para não calcificar a governança, mas > 0 para bloquear spam de contas sem skin in the game.
- **Classificação automática de tipo.** No `propose`, o Governor **escaneia** os targets e calldatas. Se qualquer chamada for gestão de roles (`grantRole`/`revokeRole`/`renounceRole`) no **Treasury** ou no **próprio Timelock**, a proposta inteira é marcada como `Supermajority` (ver [Ciclo de uma proposta → supermaioria](#supermaioria-para-gestão-de-roles)). Emite `ProposalTypeSet` sempre — o frontend sinaliza o requisito de 75% antes da votação abrir.

## 2. Delay + votação

Depois de `propose`, há o `votingDelay` (produção: 7200 blocos, ~1 dia) antes de a votação abrir — janela para o ecossistema analisar a proposta. Aberta a votação, ela dura `votingPeriod` (produção: 50400 blocos, ~7 dias).

O voto usa **snapshot** de voting power no bloco de abertura (`getPastVotes`) — imune a flash loans (ver [Voting power](02-voting-power.md)). Opções: `For`, `Against`, `Abstain` (contagem `GovernorCountingSimple`).

## 3. Sucesso: quorum + regra de contagem

Para uma proposta `Succeeded`:

- **Quorum.** A soma dos votos precisa atingir a fração de quorum sobre o supply no snapshot — produção: **4%** (`GovernorVotesQuorumFraction`). Abstain conta para quorum.
- **Regra de sucesso:**
  - **Standard:** `For > Against` (maioria simples).
  - **Supermajority:** `For >= 3 * Against` **e** `For > 0` — equivalente a For ≥ 75% dos votos decisivos (Abstain fora da razão).

## 4. Queue + delay do Timelock

Uma proposta `Succeeded` é enfileirada com `queue`. A partir daí, o [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) impõe o `minDelay` (produção: **2 dias**, `172800s`) antes que a execução seja permitida. Esse atraso é a última linha de defesa: dá tempo de reação caso uma proposta maliciosa passe.

## 5. Executar

Após o `minDelay`, **qualquer um** pode chamar `execute` — o Timelock foi deployado com `executors = [address(0)]`, ou seja, execução pública pós-delay. Não é preciso um executor privilegiado: os targets e calldatas já são imutáveis desde o `queue` (o hash de operação cobre tudo), e o delay já expirou. Exigir um executor dedicado só adicionaria fricção, sem ganho de segurança.

O Timelock executa **exatamente** os calldatas registrados. Não há como injetar uma chamada que não estava na proposta aprovada.

## Cancelamento

O `CANCELLER_ROLE` fica só com o Governor (usado por `GovernorTimelockControl._cancel` quando uma proposta é cancelada via fluxo de governança). **Ninguém mais** recebe essa role — nem um guardian multisig no v1. Motivo: um cancelador externo poderia fazer DoS de propostas válidas, violando o princípio "o voto é a fonte de verdade".

## Supermaioria para gestão de roles

Alterar quem detém roles no Treasury ou no Timelock muda **quem pode movimentar o cofre da DAO** — o vetor clássico de captura. Por isso qualquer proposta que contenha gestão de roles nesses dois contratos exige `For >= 75%`, não maioria simples.

Anti-bypass (por que empacotar a chamada sensível não contorna a regra):

- **Batch misto contamina a proposta inteira.** Uma proposta que mistura gestão de roles do Treasury/Timelock com outras chamadas populares vira `Supermajority` por completo — não dá para diluir o requisito de 75% escondendo a chamada sensível entre outras.
- **Chamadas aninhadas falham no AccessControl.** Um contrato intermediário chamado pela proposta nunca é o Timelock, então a indireção não satisfaz o gate de role.

Detalhes de parâmetros em [Parâmetros](03-parameters.md).

---

**Próximo →** [Voting power](02-voting-power.md)
