# Whitelist de projetos

**Para quem é:** devs que querem listar um app, stakers que querem entender em que estão alocando.
**Pré-requisitos:** [Governança](05-governance.md).

## Por que whitelist

O protocolo compartilha um motor econômico: uso nos apps listados gera burn, que gera emissão, que vai para stakers. Se **qualquer um** pudesse se incluir como projeto e acionar `burnAndRecord`, o modelo colapsaria — um atacante queima volume de CREDIT que ele mesmo cunhou em outro app e captura rewards.

A whitelist coloca uma barreira econômica (colateral em GOV) e política (passar por proposta) antes de um novo app receber `RECORDER_ROLE`. É a primeira linha de defesa contra sybil de apps.

## Os 4 estados de um projeto

```
      registerProject          activateProject        setProbation      reactivate
   Pending ------------>  Active ------------------>  Probation --------->  Active ...
                                                          |
                                                          | removeProject
                                                          v
                                                       Removed (terminal)
```

Transições válidas (definidas em `ProjectRegistry` enum `Status`):

- `Pending` → `Active` (via `activateProject`, governance-gated)
- `Active` → `Probation` (via `setProbation`, governance-gated)
- `Active` → `Removed` (via `removeProject`, governance-gated)
- `Probation` → `Active` (via `reactivate`, governance-gated)
- `Probation` → `Removed` (via `removeProject`)
- `Removed` → **nada** (terminal)

## Pending — projeto registrado mas não operacional

Após `registerProject`:

- Colateral em GOV foi pullado do `owner` para o Registry.
- `metadataURI` foi gravado.
- `activatedAt` = 0, `probationEndsAt` = 0.
- Stake e pagamentos **não** funcionam (`isActive` retorna false).
- Owner pode atualizar metadata.

Propósito: janela entre aprovação da proposta e ativação efetiva. Dá tempo para verificações finais.

## Active — projeto operacional

Após `activateProject`:

- `activatedAt = block.timestamp`.
- `probationEndsAt = activatedAt + probationDuration` (em produção, 30 dias).
- `isActive(projectId)` = true.
- Stake, pagamentos e `burnAndRecord` funcionam.
- **Durante a janela de probation inicial**, `isInProbation(projectId)` = true e share de reward é dividido por 4.

Após `probationEndsAt`, a penalidade automaticamente some. Nenhuma ação adicional é necessária.

## Probation (punitiva) — projeto suspenso

Status distinto da probation inicial por tempo. Governança move um projeto `Active` para `Probation` para suspender operação por má conduta (sem remover o colateral).

- `isActive` retorna false.
- Stake novo bloqueado (`ProjectNotActive`).
- Pagamentos bloqueados (`ProjectNotActive`).
- Unstake **NÃO** é bypassed — usuário só sai quando o lock expirar normalmente.
- Registros de burn passados permanecem — história é história.

Do Probation, a DAO pode:

- `reactivate(projectId)` → volta para `Active`. `activatedAt` e `probationEndsAt` **não mudam** (o ancoramento original é preservado).
- `removeProject(projectId, slash, treasury)` → terminal.

## Removed — terminal

Único estado que bypassa o lock no `Staking.unstake` (porque a DAO removeu o projeto, não o staker). Stakers saem assim que quiserem.

- `isActive` retorna false definitivamente.
- Stake, pagamentos, toda operação bloqueada.
- Colateral já foi drenado:
  - `slash == true` → foi para `treasury`.
  - `slash == false` → foi para o `owner` do projeto.
- Transferência pendente de ownership é cancelada.
- `metadataURI` fica congelada — não há mais update.

## Colateral — skin in the game

Todo projeto precisa locka GOV como colateral no momento de `registerProject`:

- Em produção, `minCollateral = 10.000 GOV` (ajustável via governança).
- O colateral fica custodiado **no Registry** — não no Treasury, não no owner.
- Só é liberado via `removeProject`:
  - Sem slash (projeto sai em bons termos): vai para o `owner`.
  - Com slash (má conduta): vai para o `treasury`.
- **Não há topup nem withdraw parcial no v1**. Se o colateral mínimo aumentar, projetos existentes continuam com o colateral antigo (grandfathered) — a mudança só afeta novos registros.

O colateral serve três propósitos:

1. **Custo de entrada**: desincentiva listar apps lixo.
2. **Anti-sybil**: 10k GOV é ~0.01% do cap, valor não trivial.
3. **Mecanismo de slash**: se o app se prova fraudulento, a DAO queima o colateral (via slash).

## Metadata off-chain

O Registry guarda uma `metadataURI` (IPFS/Arweave). O conteúdo exato é off-chain mas convencionalmente contém:

- Nome legível do projeto.
- Descrição.
- Ícone.
- Endereços dos contratos do app (se aplicável).
- Link do site, docs, contato.

Owner atualiza via `updateMetadata(projectId, metadataURI)`. Não requer proposta — é operacional. A única exceção é pós-`Removed`, em que a URI congela.

## Transferência de ownership (2-step)

O owner de um projeto pode transferir para outro endereço via processo 2-step (análogo ao `Ownable2Step`):

1. `transferProjectOwnership(projectId, newOwner)` — owner atual propõe transferência.
2. `acceptProjectOwnership(projectId)` — `newOwner` aceita explicitamente.

Até o accept, o pendingOwner **não tem poder**. Isso protege contra transferência acidental para endereço errado ou inalcançável.

### Checklist ao receber ownership de um projeto

Antes de chamar `acceptProjectOwnership`, o `newOwner` deve auditar o estado do projeto para não herdar configurações maliciosas do owner antigo. Especificamente:

1. **Auditar `feeRouter.appRecipient(projectId)`.** `setAppRecipient` é **owner-gated** (não governance-gated) — o owner atual pode setar qualquer endereço **antes** de iniciar a transferência. Se o owner antigo definir `appRecipient` para um endereço malicioso antes de chamar `transferProjectOwnership`, o novo owner herda o recipient ao aceitar e **todo o rebate de 5%** passa a cair no endereço malicioso até o novo owner rodar `setAppRecipient(projectId, <endereço legítimo>)` ou `setAppRecipient(projectId, address(0))` (reset para lookup dinâmico que segue o owner do Registry).
2. **Auditar `feeRouter.hasProjectSplit(projectId)` e `feeRouter.getProjectSplit(projectId)`.** Override de split por projeto só é ajustável via `GOVERNANCE_ROLE`, então não é vetor direto do owner — mas vale confirmar que o split corresponde ao que foi negociado.
3. **Auditar `registry.getProject(projectId).status`.** Aceitar ownership de projeto `Probation` punitiva é aceitar que stakes e pagamentos estão bloqueados até a DAO `reactivate` ou `removeProject`.
4. **Auditar `registry.getProject(projectId).collateral`.** Confirmar que o colateral em GOV custodiado pelo Registry bate com o esperado — em `removeProject(slash=false)` esse valor vai para o `owner` (ou seja, você).

Boa prática: executar `setAppRecipient(projectId, address(0))` imediatamente após `acceptProjectOwnership` — reseta para lookup dinâmico (que segue `registry.getProject(...).owner`), neutralizando qualquer recipient herdado. Depois, se quiser direcionar para um multisig operacional, setar explicitamente.

## Consequências no resto do sistema

Dependências diretas do status do projeto:

- **`Staking.stake` / `increaseStake`**: exige `Active`.
- **`Staking.unstake`**: só bypassa lock se `Removed`.
- **`BurnTracker.burnAndRecord`**: exige `Active`. Se projeto vai para `Probation` após burn, o burn histórico **não é revertido**.
- **`FeeRouter.pay`**: exige `Active`.
- **`RewardDistributor._calculateClaim`**: penalty `/ 4` se `isInProbation(projectId)` no momento do claim.

---

**Próximo →** [Treasury e fees](07-treasury-and-fees.md)
