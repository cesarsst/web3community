# Governança: CommunityGovernor + Timelock

**Para quem é:** quem quer votar, propor ou entender quem controla os contratos econômicos.
**Pré-requisitos:** [Dual-token economy](01-dual-token-economy.md).

## Separação de poderes

Nenhuma função privilegiada dos contratos econômicos aceita chamada direta de uma EOA. Todas exigem `GOVERNANCE_ROLE`, que em produção **só o [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) detém**. E o Timelock só executa o que o [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) aprovou por voto e esperou o delay.

```
   Governor          Timelock            Contratos economicos
   (decide)   --->   (aplica delay) ---> (Treasury, Registry,
   voto do GOV       minDelay 2 dias      FeeRouterV2, ProjectFunding,
                                          owner do GovernanceToken)
```

- **Governor** — recebe propostas, conta votos (poder de voto lido do GOV via `ERC20Votes`), decide sucesso.
- **Timelock** — enfileira a proposta aprovada, espera `minDelay` e executa. É o único portador de `GOVERNANCE_ROLE`/`DEFAULT_ADMIN_ROLE` nos contratos econômicos e o único `owner` do GovernanceToken após o bootstrap.

O `CommunityGovernor` compõe o stack canônico da OpenZeppelin 5.0.x: `Governor` + `GovernorSettings` + `GovernorCountingSimple` + `GovernorVotes` + `GovernorVotesQuorumFraction` + `GovernorTimelockControl`.

## Parâmetros (produção)

Valores de produção em `ignition/parameters/production.json`, todos ajustáveis depois via governança:

| Parâmetro | Valor produção | Significado |
|---|---|---|
| `votingDelay` | **7200 blocos** (~1 dia @ 12s) | espera entre `propose` e a abertura da votação (anti-MEV/anti-flashloan) |
| `votingPeriod` | **50400 blocos** (~7 dias) | duração da janela de votação |
| `proposalThreshold` | 10.000 GOV (0,01% do cap) | poder de voto delegado mínimo para propor |
| `quorumNumerator` | **4%** | fração do supply que precisa participar para valer |
| `minDelay` (Timelock) | **172800 s** (2 dias) | atraso entre enfileirar e executar |

> O clock do Governor é em **blocos** (`GovernanceToken` não sobrescreve `clock()`, então o ERC20Votes usa `block.number`). Toda a aritmética de delay/period é em blocos.

Em dev (`dev.json`) os valores são reduzidos (votingDelay 1, votingPeriod 50, minDelay 3600 s) para iterar rápido — mas o threshold e o quorum de 4% são mantidos.

## Contagem de votos

`GovernorCountingSimple` conta `For / Against / Abstain`. Para uma proposta **Standard**, sucede se `For > Against` **e** o quorum de 4% for atingido (Abstain conta para quorum, não para a razão For/Against).

O poder de voto é lido por **snapshot** no bloco de referência da proposta:

```solidity
quorum(timepoint)  // usa getPastTotalSupply do ERC20Votes
```

Como usa `getPastVotes`/`getPastTotalSupply`, o voto é **imune a flash loans** que movam GOV no mesmo bloco (invariante I5). Você precisa ter GOV delegado (a si mesmo ou a outra conta) **antes** do snapshot.

## Supermajoridade: 75% para gestão de roles

Alterar quem detém roles no [Treasury](../08-contracts-reference/08-Treasury.md) ou no próprio Timelock muda quem pode movimentar o cofre da DAO — é o vetor clássico de captura. Por isso o `propose` **escaneia** os targets/calldatas da proposta:

```solidity
// qualquer call de grantRole/revokeRole/renounceRole com
// target == TREASURY  OU  target == timelock()
// marca a proposta INTEIRA como Supermajority
```

Quando marcada, `_voteSucceeded` passa a exigir:

```solidity
return forVotes > 0 && forVotes >= 3 * againstVotes;   // For >= 75% dos votos decisivos
```

Isto é, **For ≥ 75%** dos votos decisivos (For/Against; Abstain fora da razão). Um batch que **misture** gestão de roles do Treasury/Timelock com outras calls é contaminado **inteiro** pelo tipo Supermajority — de propósito: empacotar a call sensível junto de calls populares seria exatamente o vetor de diluição do requisito de 75%. O evento `ProposalTypeSet` sinaliza o tipo de toda proposta (inclusive Standard) para indexação off-chain.

## Ciclo de uma proposta

```
Alice propoe      votingDelay      votingPeriod      Fila timelock    minDelay      Execucao
(>= 10k GOV   ->  (7200 blocos, -> (50400 blocos, -> (enfileira,   -> (2 dias,   -> (qualquer
 delegados)       ~1 dia)           ~7 dias;          Queued)          resposta)     um executa)
                                    For > Against
                                    + quorum 4%)
```

Estados possíveis: `Pending → Active → Succeeded/Defeated → Queued → Executed` (ou `Canceled`/`Expired`). Só executa via Timelock após todos os delays.

## Por que a latência é intencional

Propostas levam ~10 dias do início à execução. **A latência é o mecanismo de segurança**: nenhum ator isolado pode drenar fundos, trocar contratos ou mudar parâmetros unilateralmente. O custo é tempo de resposta; o ganho é que a comunidade tem uma janela para reagir a qualquer proposta maliciosa que passe.

## Deploy de roles (por que ninguém tem backdoor)

No bootstrap de produção, o deployer:

1. concede `PROPOSER_ROLE` + `CANCELLER_ROLE` ao Governor no Timelock;
2. concede `GOVERNANCE_ROLE` + `DEFAULT_ADMIN_ROLE` ao Timelock em cada contrato econômico e transfere o `owner` do GovernanceToken para ele;
3. **renuncia** às próprias roles.

O `EXECUTOR_ROLE` é `address(0)` — qualquer um pode clicar "execute" numa proposta já vencida (o delay é o gate real). `CANCELLER_ROLE` fica só com o Governor (via `_cancel`), para que ninguém externo possa DoSar propostas válidas. Resultado: após o wiring, **nenhuma EOA retém poder unilateral** (invariante I4).

---

**Próximo →** [Arquitetura do protocolo](../03-protocol-overview/01-architecture.md)
