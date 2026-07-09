# Votar em propostas

**Para quem é:** holders de GOV que querem participar das decisões da DAO.
**Pré-requisitos:** [Ter GOV](02-holding-gov.md) e [Governança](../02-core-concepts/05-governance.md).

## Antes de tudo: delegue

Você **só tem poder de voto se delegou GOV** — inclusive a si mesmo. E a delegação precisa estar ativa **antes** do snapshot da proposta.

```solidity
GovernanceToken.delegate(suaConta);   // ou delegate(representante)
```

O voto é lido por snapshot (`getPastVotes`) no bloco de referência da proposta. Delegar depois do snapshot não vale para a proposta em curso. Sem delegar, `getVotes` é zero.

> Por que snapshot? Para ser **imune a flash loans**: ninguém pode pegar GOV emprestado no mesmo bloco do voto para inflar poder. Você tem que ter (e ter delegado) o GOV **antes**.

## O ciclo de uma proposta

```
   Pending  ->  Active  ->  Succeeded  ->  Queued  ->  Executed
   (votingDelay) (votingPeriod) (venceu)   (na fila    (apos minDelay
   ~1 dia        ~7 dias                    do Timelock) do Timelock, 2 dias)
                    |
                    +-> Defeated (perdeu ou sem quorum)
```

Parâmetros de produção (do [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md)):

| Fase | Duração (produção) |
|---|---|
| `votingDelay` (Pending) | 7200 blocos (~1 dia) |
| `votingPeriod` (Active) | 50400 blocos (~7 dias) |
| `minDelay` do Timelock (Queued) | 172800 s (2 dias) |

Do início à execução, ~10 dias. A latência é intencional — é a janela de segurança da comunidade.

## Como votar

Durante a fase **Active**, chame `castVote` no Governor:

```solidity
CommunityGovernor.castVote(proposalId, support);
// support: 0 = Against, 1 = For, 2 = Abstain
```

Variantes: `castVoteWithReason(proposalId, support, reason)` para registrar uma justificativa, e `castVoteBySig(...)` para votar por assinatura (gasless via relayer).

## Quando uma proposta passa

- **Proposta Standard**: `For > Against` **e** quorum de **4%** do supply atingido. Abstain conta só para quorum, não para a razão For/Against.
- **Proposta Supermajority**: exige `For ≥ 75%` dos votos decisivos (`forVotes >= 3 * againstVotes` e `forVotes > 0`). Isso é acionado automaticamente quando a proposta contém **gestão de roles do Treasury ou do Timelock** (grant/revoke/renounce). O evento `ProposalTypeSet` sinaliza o tipo antes da votação abrir.

## Propor (se você tiver GOV suficiente)

Para **criar** uma proposta, você precisa de `proposalThreshold` = **10.000 GOV** delegados (0,01% do cap):

```solidity
CommunityGovernor.propose(targets, values, calldatas, description);
```

A proposta descreve exatamente as chamadas que o Timelock executará se aprovada. O Timelock só executa **esses** calldatas (o hash cobre targets/values/calldatas) — não há como injetar uma call que não foi votada.

## Depois de aprovada

1. **Queue** — qualquer um chama `queue(...)` para enfileirar no Timelock.
2. **Espera** o `minDelay` (2 dias).
3. **Execute** — qualquer um chama `execute(...)`. O `EXECUTOR_ROLE` é público (`address(0)`), então não depende de um executor específico. O delay já expirado é o único gate.

## O que a governança controla

Toda função privilegiada dos contratos econômicos (Treasury, Registry, FeeRouterV2, ProjectFunding, mint de GOV) só é chamável pelo Timelock — logo, só por proposta aprovada. Isso inclui ajustar a fee (respeitando o teto de 5%), o split, o `minTarget` das rodadas, ativar/suspender projetos e liberar fundos da tesouraria. Ver [Governança](../02-core-concepts/05-governance.md).

---

**Próximo →** [Sacar rev-share](05-claiming-revenue.md)
