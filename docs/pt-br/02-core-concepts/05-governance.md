# Governança

**Para quem é:** quem quer entender **como** a DAO toma decisões.
**Pré-requisitos:** [Modelo mental](../01-getting-started/02-mental-model.md).

## Separação de poderes

A governança da web3community tem **três** componentes com papéis distintos:

```
  Detentores de GOV      CommunityGovernor       CommunityTimelock
  (com delegacao)         (urna eletronica)      (executor com delay)

  - detem voting     ->  - recebe proposta  ->   - segura 2 dias
    power                - abre janela           - executa contra
  - delegam pra si       - conta votos             contratos alvo
    ou pra outrem        - decide resultado
```

Nenhum dos três pode agir sozinho:

- **Governor** não executa nada — só agenda no Timelock.
- **Timelock** não decide nada — só executa o que foi agendado depois do delay.
- **Detentores de GOV** votam mas não podem chamar funções diretas dos contratos econômicos.

## Por que três etapas

### Threshold (entrada)

Para criar proposta, o propositor precisa ter pelo menos `proposalThreshold` de voting power delegado. Em produção: `10.000 GOV` (0.01% do cap). Impede spam de propostas por contas sem skin in the game.

### Quorum (participação mínima)

Uma proposta só vence se atingir quorum **e** tiver mais `For` que `Against`. Quorum em produção: **4%** do supply total ao bloco do snapshot. Evita que uma minoria ativa passe algo radical enquanto a maioria está dormindo.

### Delay total (janela de resposta)

Do momento de propor ao momento de executar, passam-se aproximadamente:

- `votingDelay` — 7200 blocos (~1 dia a 12s/bloco)
- `votingPeriod` — 50400 blocos (~7 dias)
- `timelockMinDelay` — 172800 segundos (2 dias)

Soma ~10 dias. Durante esse tempo, qualquer holder pode:

- Examinar a proposta on-chain.
- Delegar votos para reprovar.
- Organizar resposta off-chain.
- Sair da posição se desacordar.

Se uma proposta maliciosa passa, ainda há 2 dias após a aprovação para ação (retirar fundos, cancelar via minoria bloqueadora em proposta contrária, etc.).

## O que a DAO controla

**Tudo** que afeta o protocolo economicamente passa por proposta. Listagem completa em [Parâmetros](../07-governance/03-parameters.md). Resumo:

| Contrato | Parâmetros controlados |
|---|---|
| `ProjectRegistry` | `registerProject`, `activateProject`, `setProbation`, `reactivate`, `removeProject`, `setMinCollateral`, `setProbationDuration` |
| `Treasury` | `transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH` |
| `BurnTracker` | `closeRound`, `setRoundDuration`, `setMaxBurnPerRoundPerProject` |
| `RewardDistributor` | `setAlpha`, `setCapMax` |
| `FeeRouter` | `setDefaultSplit`, `setProjectSplit`, `clearProjectSplit` |
| `UserSubsidy` | `createCampaign`, `closeCampaign` |
| `GovernanceToken` | `mint` (via `Ownable2Step`, owner = Timelock) |
| `TeamVesting` | `revoke` (owner = Timelock) |

## O que a DAO **não** controla

Decisões que a DAO **não pode tomar** mesmo com 100% dos votos:

- **Aumentar o cap do GOV**. O cap (100M) é `immutable` no `GovernanceToken.CAP_SUPPLY`.
- **Remover o `MIN_LOCK` do Staking** (14 dias). É `constant` e protege stakers contra a própria governança.
- **Mudar a janela `[MIN_ROUND_DURATION, MAX_ROUND_DURATION]`** (1 dia a 30 dias).
- **Mudar `[MIN_ALPHA, MAX_ALPHA]`** (0.5 a 0.99 — reduzido de 1.1 para garantir IE1 α<1 permanente por construção; ver `audit/economist/2026-04-22-consistency-audit.md` C2) ou `[MIN_CAPMAX, MAX_CAPMAX]` (1 a 100M CREDIT).
- **Alterar `floorSchedule`**. Gravado no storage do `RewardDistributor` no deploy, sem função de write.
- **Mudar o endereço de qualquer contrato econômico**. Se a DAO precisar "substituir" um contrato, precisa deployar novo e migrar roles — a arquitetura não prevê upgrade in-place.

A imutabilidade dessas regras é um compromisso: **nem a DAO unânime pode quebrar os direitos que o usuário viu no deploy**. É a base de confiança que permite stakers imobilizarem capital.

## Quem é o dono do quê

Pós-deploy, após todos os handoffs:

| Recurso | Owner/Admin |
|---|---|
| `GOVERNANCE_ROLE` em todos os contratos econômicos | `CommunityTimelock` |
| `DEFAULT_ADMIN_ROLE` em todos os contratos com AccessControl | `CommunityTimelock` |
| `owner` do `GovernanceToken` | `CommunityTimelock` (após `acceptOwnership`) |
| `owner` de cada `TeamVesting` | `CommunityTimelock` |
| `PROPOSER_ROLE` + `CANCELLER_ROLE` no `CommunityTimelock` | `CommunityGovernor` |
| `EXECUTOR_ROLE` no `CommunityTimelock` | `address(0)` — qualquer um executa após o delay |
| `DEFAULT_ADMIN_ROLE` no `CommunityTimelock` | **Self** (o próprio Timelock) |
| `MINTER_ROLE` no `CreditToken` | `RewardDistributor` |
| `BURNER_ROLE` no `CreditToken` | `BurnTracker` |
| `RECORDER_ROLE` no `BurnTracker` | `FeeRouter` (e cada novo app listado recebe via proposta) |

O deployer **renuncia todas as roles** no fim do deploy. Após isso, ele não tem mais poder que qualquer holder de GOV.

## Papel do ERC20Votes

O `GovernanceToken` herda `ERC20Votes`. Isso adiciona duas funções críticas para a governança:

- `delegate(delegatee)` — cada holder precisa **delegar** voting power, mesmo a si mesmo. Se ninguém delega, `getVotes` retorna zero e o Governor não conta.
- `getPastVotes(account, blockNumber)` — retorna o voting power em um bloco passado. **Esta** é a função que o Governor usa para contar votos — imune a flash-loans.

**Flash-loan ataque mitigado**: um atacante que faz flash-loan de GOV no bloco de abertura da votação não consegue votar, porque `getPastVotes` consulta o bloco `snapshot = proposalSnapshot(proposalId)` que fica no passado (`votingDelay` atrás).

## Contratos-chave

| Contrato | Papel |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | Fonte de voting power |
| [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md) | Urna |
| [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md) | Executor com delay |

---

**Próximo →** [Project whitelist](06-project-whitelist.md)
