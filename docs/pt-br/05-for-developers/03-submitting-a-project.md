# Submeter um projeto

**Para quem é:** dev/equipe que quer listar um app novo no `ProjectRegistry`.
**Pré-requisitos:** [Whitelist de projetos](../02-core-concepts/06-project-whitelist.md), [Visão geral de integração](01-integration-overview.md).

## O que significa "listar"

Listar um projeto no Registry da web3community é:

1. Registrar o par `(owner, metadataURI)` e travar colateral em GOV.
2. Ativar o projeto (transitar de `Pending` para `Active`).
3. Garantir que o `FeeRouter` (ou o futuro contrato do app) pode chamar `burnAndRecord` — isto é, que o app detém `RECORDER_ROLE` onde necessário.

O resultado: seu app aparece no Registry, aceita pagamentos via `FeeRouter.pay`, e gera burn rastreável para o `RewardDistributor`.

## O que você precisa antes

- **Ownership definido**: um endereço (EOA ou multisig) que será `owner` do projeto.
- **Colateral em GOV**: em produção, pelo menos `10.000 GOV` (`minCollateral`, ajustável). Leia o valor atual do Registry.
- **Metadata off-chain**: JSON estruturado, hospedado em IPFS/Arweave. O Registry armazena apenas o URI.
- **Apoio político**: alguém com ≥ 10.000 GOV delegados para submeter a proposta.

## Formato de metadata

A metadata é off-chain. Convenção recomendada (não enforceada on-chain):

```json
{
  "name": "ChatApp",
  "description": "Mensageria end-to-end encrypted com pagamento por mensagem",
  "icon": "ipfs://Qm...",
  "website": "https://chatapp.example",
  "contracts": {
    "main": "0x...",
    "frontend": "https://app.chatapp.example"
  },
  "contact": {
    "email": "team@chatapp.example",
    "discord": "..."
  },
  "pricing": [
    { "service": "envio de msg", "costCREDIT": "0.01" }
  ]
}
```

Sua UI e exploradores podem ler. O Registry guarda só o `metadataURI` (ex: `ipfs://Qm...`).

## Passo a passo completo

### 1. Preparar metadata

- Suba o JSON para IPFS ou Arweave.
- Anote o CID / URI.

### 2. Obter apoio político

- Encontre um holder de GOV (ou agregue vários via delegação) com ≥ `proposalThreshold` (10.000 GOV em produção).
- O apoiante será o `proposer` no Governor.

### 3. Montar a proposta

A proposta deve incluir (no mínimo):

```solidity
targets   = [address(registry), address(registry)]
values    = [0, 0]
calldatas = [
    abi.encode(registry.registerProject.selector, ownerAddress, metadataURI, collateralAmount),
    abi.encode(registry.activateProject.selector, /* projectId sera atribuido dinamicamente */)
]
```

Problema: a proposta **não sabe o `projectId` ainda** (ele é atribuído no `registerProject`). Duas estratégias:

**Estratégia A (duas propostas)**:

1. Primeira proposta: `registerProject(owner, metadataURI, collateral)`. Após executada, lê o `projectId` atribuído (via evento `ProjectRegistered`).
2. Segunda proposta: `activateProject(projectId)`.

**Estratégia B (uma proposta com pré-approve)**:

1. Proposta inclui `activateProject` assumindo o `projectId` que **será** atribuído (ver `_nextProjectId` atual no Registry). Requer que nenhuma outra proposta de `registerProject` se intercale entre propor e executar — difícil de garantir em teoria, mas aceitável em prática se a volumetria de registros for baixa.

Em ambas, a proposta deve também (provavelmente) incluir:

- `burnTracker.grantRole(RECORDER_ROLE, <contrato_que_vai_chamar_burnAndRecord>)` — se o app vai chamar direto. No bootstrap do v1, o `FeeRouter` já tem essa role, e apps chamam `FeeRouter.pay` — então este grant pode não ser necessário.

### 4. Approve do colateral

O `owner` do projeto precisa ter feito `GovernanceToken.approve(registry, collateralAmount)` **antes** de a proposta executar. Pode ser feito a qualquer momento durante o ciclo da proposta, mas melhor antes para evitar falha de execução.

### 5. Votação + execução

- Espera `votingDelay` (~1d em produção).
- Votação `votingPeriod` (~7d).
- Se vencer: `queue` no Timelock.
- Espera `minDelay` (2d).
- `execute` — a DAO chama `registerProject` (via Timelock), que puxa o GOV colateral e atribui `projectId`.
- Segunda proposta similar para `activateProject`.

### 6. Pós-ativação

Após `activateProject`:

- `activatedAt = now`, `probationEndsAt = now + probationDuration` (30d em produção).
- `projectId` está `Active`.
- `FeeRouter.pay` funciona para ele.
- Stake é permitido.
- **Durante 30 dias**, share de rewards é dividido por 4 (probation inicial por tempo).

Após 30 dias, a probation inicial expira automaticamente.

## Operações do owner após listagem

Sem necessidade de governança:

- `registry.updateMetadata(projectId, newURI)` — atualizar metadata.
- `registry.transferProjectOwnership(projectId, newOwner)` — iniciar transferência 2-step.
- `registry.acceptProjectOwnership(projectId)` — aceitar (chamado pelo novo owner).
- `feeRouter.setAppRecipient(projectId, recipient)` — setar destino do rebate.

Requer governança (proposta + execução):

- Qualquer mudança de status (`setProbation`, `reactivate`, `removeProject`).
- Qualquer override de split (`setProjectSplit`, `clearProjectSplit`).
- `burnTracker.revokeRole(RECORDER_ROLE, ...)` — revogar role se necessário.

## Custos totais

- **GOV collateral**: 10.000 GOV imobilizado até `removeProject`.
- **Gas de proposta**: pago pelo proposer.
- **Gas de execução**: pago por quem chamar `execute` (qualquer um, 2 dias após queue).

Custo total em gas: ~300-500k gas por proposta típica.

## Problemas comuns

### Proposta reverte com `InsufficientAllowance`

O owner do projeto não aprovou o Registry, ou a allowance é menor que `collateralAmount`. Solução: chame `GOV.approve(registry, collateralAmount)` antes da execução.

### Proposta reverte com `InsufficientCollateral`

Você passou `collateralAmount < minCollateral`. Consulte `registry.minCollateral()` para o valor atual.

### Proposta reverte com `EmptyMetadataURI`

`metadataURI` string não pode estar vazia. Passe ao menos um CID placeholder.

### Proposta não atinge quorum

- Aumente engajamento off-chain (forum, Discord).
- Aumente o tempo de campanha — proposte de novo se a primeira falhou.
- Considere delegar voting power para aumentar o peso total apoiante.

---

**Próximo →** [Consultar estado on-chain](04-querying-state.md)
