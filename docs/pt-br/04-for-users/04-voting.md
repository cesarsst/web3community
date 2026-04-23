# Votar em propostas

**Para quem é:** holder de GOV que quer participar das decisões da DAO.
**Pré-requisitos:** [Ter GOV](02-holding-gov.md), [Governance (conceito)](../02-core-concepts/05-governance.md).

## Pré-requisito absoluto: delegar

Ter GOV **não** te dá voting power automático. Você precisa delegar uma vez:

```solidity
GovernanceToken.delegate(yourAddress)
```

Sem isso, `getVotes(you) == 0` e o Governor não contabiliza seus votos. Depois de delegado, está sempre ativo — transferências de GOV atualizam automaticamente.

Se quer delegar a outrem:

```solidity
GovernanceToken.delegate(delegate_address)
```

A mudança entra em vigor no bloco seguinte. Propostas já abertas não são afetadas (usam snapshot anterior).

## Ciclo de uma proposta (visão do votante)

```
  +-------------+       +-------------+       +-------------+       +-------------+
  |   Pending   | ----> |   Active    | ----> | Succeeded   | ----> |  Queued     |
  | (votingDelay|       |(votingPeriod|       | ou Defeated |       | (timelock)  |
  |  ~1 dia)    |       | ~7 dias)    |       |             |       |             |
  +-------------+       +-------------+       +-------------+       +-------------+
                                                                           |
                                                                           | minDelay 2d
                                                                           v
                                                                    +-------------+
                                                                    |  Executed   |
                                                                    +-------------+

  Estados alternativos:
  - Canceled: proposer desistiu ou governanca cancelou
  - Expired: proposta nao foi queued em timely fashion
```

Durante o estado `Active` é que você vota.

## Como votar

Função principal no Governor:

```solidity
function castVote(uint256 proposalId, uint8 support) public returns (uint256);
```

Onde `support`:

- `0` — Against
- `1` — For
- `2` — Abstain

Variantes:

- `castVoteWithReason(proposalId, support, reason)` — anexa razão em string (indexada em evento).
- `castVoteBySig(proposalId, support, v, r, s)` — voto via assinatura (EIP-712, permite gasless via relayer).
- `castVoteWithReasonAndParamsBySig(...)` — versão com razão + params.

## Sua voting power

Quando a proposta abre, o Governor calcula um snapshot block. Seu peso de voto é:

```solidity
uint256 power = GovernanceToken.getPastVotes(you, snapshotBlock);
```

Ou seja: **seu balance de GOV no bloco do snapshot, via sua delegação no bloco do snapshot**. Se você delegou a si, é o seu próprio balance. Se delegou a X, X tem o poder; você não vota com aquele token.

Comprar ou vender GOV **depois** do snapshot não muda o poder daquela proposta.

## Como a proposta é decidida

Definido em `GovernorCountingSimple`:

**Para vencer**, a proposta precisa:

1. Atingir **quorum** — `forVotes + abstainVotes >= quorum(snapshotBlock)`. Em produção, quorum = 4% do supply no snapshot.
2. Ter mais `For` que `Against` — `forVotes > againstVotes`.

Se ambas as condições verdadeiras quando a janela fecha → `Succeeded`. Caso contrário → `Defeated`.

## Após `Succeeded`

Qualquer um (não precisa ser o proposer) pode chamar:

```solidity
CommunityGovernor.queue(proposalId);       // ou
CommunityGovernor.queue(targets, values, calldatas, descriptionHash);
```

Isso enfileira a proposta no Timelock. Agora o estado é `Queued`. O Timelock agenda a execução para `now + minDelay` (2 dias em produção).

Após o delay expirar, qualquer um chama:

```solidity
CommunityGovernor.execute(proposalId);
```

Que executa as chamadas efetivas (`targets[].call(calldatas[])`) via Timelock.

## Cancelamento

- O proposer pode cancelar **sua própria** proposta enquanto ela está `Pending` (voting delay) ou `Active` (period).
- Governança pode cancelar via proposta contrária (meta-proposta).
- Cancelamentos pós-queue também invalidam a operação no Timelock (`Timelock.cancel`).

O Timelock v1 **não** tem guardian separado — não há botão de pânico unilateral. Isso é intencional: nenhum ator pode cancelar propostas sozinho, porque isso seria vetor de captura.

## Parâmetros em produção

| Parâmetro | Valor | Fonte |
|---|---|---|
| `votingDelay` | 7200 blocos (~1d) | `production.json` |
| `votingPeriod` | 50400 blocos (~7d) | `production.json` |
| `proposalThreshold` | 10.000 GOV | `production.json` |
| `quorumNumerator` | 4 (% do supply) | `production.json` |
| `timelockMinDelay` | 172800 seg (2d) | `production.json` |

Todos ajustáveis via proposta (onlyGovernance nos setters). Mais em [Parâmetros](../07-governance/03-parameters.md).

## Tutorial: votar passo a passo

1. **Primeiro uso:** `GovernanceToken.delegate(you)`. Paga gas uma vez.
2. **Achar proposta:** via hub ou indexador (procure por evento `ProposalCreated` do Governor).
3. **Ler a proposta** — descrição e `(targets, calldatas)` vão dizer exatamente o que ela faz on-chain.
4. **Votar** — `CommunityGovernor.castVote(proposalId, support)`. Ou com razão: `castVoteWithReason`.
5. **Espere fechar.** Se vencer, alguém chama `queue` (talvez você).
6. **Após delay do Timelock** — alguém chama `execute`.

## O que checar antes de votar For

- Quem propôs (tem histórico na DAO? é uma entidade conhecida?).
- O que exatamente a proposta faz — decodifique os `calldatas` contra as ABIs dos contratos.
- Se a proposta altera parâmetro: está dentro dos bounds dos contratos? (ver [Parâmetros](../07-governance/03-parameters.md)).
- Se a proposta move fundos: para onde? quanto? por quê?
- Qual é a discussão off-chain (forum, Discord, etc.)?

## Votar via UI

O hub frontend oferece:

- Lista de propostas abertas.
- Decodificação legível dos `calldatas`.
- Botões para For / Against / Abstain.
- Feedback em tempo real do progresso de votação + quorum.
- Botões para `queue` / `execute` quando chega a hora.

Nada impede você de chamar direto os contratos via sua wallet, mas a UI é o caminho ergonômico.

---

**Próximo →** [Reivindicar rewards](05-claiming-rewards.md)
