# Submeter um projeto

**Para quem é:** dev que quer listar um app no ecossistema e (opcionalmente) captar capital numa rodada de rev-share.
**Pré-requisitos:** [Visão geral de integração](01-integration-overview.md), entender [staking direcionado](../02-core-concepts/03-directed-staking.md).

Listar um app tem duas etapas independentes:

1. **Registrar o projeto** no [`ProjectRegistry`](../08-contracts-reference/04-ProjectRegistry.md) — trava colateral em GOV e, depois de aprovado pela governança, deixa o projeto `Active` (pronto para receber pagamentos via `FeeRouterV2.pay`).
2. **Abrir uma rodada de captação** (opcional) no [`ProjectFunding`](../08-contracts-reference/07-ProjectFunding.md) — vende uma fatia da sua receita bruta futura (rev-share) em troca de capital antecipado.

Você pode parar na etapa 1: um projeto `Active` já cobra pagamentos e fica com ~97,5% (fee de 2,5%, sem rev-share). A etapa 2 é só se você quiser capital adiantado.

## Etapa 1 — Registrar no ProjectRegistry

### Quem pode registrar

`registerProject` é `onlyRole(GOVERNANCE_ROLE)`. Em produção o único portador dessa role é o [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) — ou seja, **o registro passa por uma proposta de governança aprovada** (invariante I7: projetos entram só pela DAO). Você não chama `registerProject` diretamente; você submete uma proposta que o Timelock executa.

### O colateral

O registro trava **colateral em GOV** (skin in the game) no Registry. O `owner` declarado precisa ter aprovado o Registry para o `transferFrom` antes da execução da proposta:

```ts
// owner do projeto aprova o Registry a puxar o colateral
await gov.approve(registryAddress, collateralAmount)
```

Regras on-chain do colateral:

- `collateralAmount >= minCollateral` (produção: `10_000e18` GOV; dev: `1_000e18`). Abaixo disso, `InsufficientCollateral`.
- Allowance insuficiente reverte com `InsufficientAllowance` (mensagem explícita, antes do erro genérico do ERC-20).
- O colateral só é liberado em `removeProject`: **devolvido ao owner** (remoção limpa) ou **enviado ao Treasury** (slash por má conduta). Não há saque parcial.

### Metadata

`metadataURI` é uma URI off-chain (IPFS/Arweave) com nome, descrição, ícone e os endereços de contrato do seu app. Não pode ser vazia. O owner pode atualizá-la depois sem passar por governança, via `updateMetadata(projectId, uri)`.

### A máquina de status

```
Pending ──(governança: activateProject)──▶ Active ──┐
                                             │       │
              (governança: setProbation) ◀───┘       │
                     │                                │
                  Probation ──(reactivate)──▶ Active  │
                     │                                │
                     └──────(removeProject)──────────▶ Removed (terminal)
```

- **`registerProject`** cria o projeto em `Pending` (colateral já travado, mas ainda não operacional).
- **`activateProject`** (governança) move para `Active`. É aqui que o projeto passa a receber pagamentos e a aceitar stake. Também inicia a **probation inicial por tempo** (`probationDuration`, 30 dias em produção): uma janela automática que só sinaliza "projeto novo" via `isInProbation` — pagamentos e stake funcionam normalmente.
- **`setProbation`** (governança, punitiva) suspende um projeto por má conduta: `isActive` volta `false`, bloqueia pagamentos e stake novo, mas **nunca bloqueia unstake**.
- **`removeProject`** é terminal e decide o destino do colateral (owner ou Treasury).

Um pagamento só passa quando `REGISTRY.isActive(projectId) == true`. Enquanto `Pending` ou `Probation`, `FeeRouterV2.pay` reverte com `ProjectNotActive`.

### Definir o recipient de pagamento

Por padrão a parcela `toApp` de cada pagamento vai para o `owner` do projeto. Para rotacionar (ex.: hot wallet operacional), o owner chama:

```ts
await feeRouterV2.setAppRecipient(projectId, operationalWallet)
```

Essa função é owner-gated (não passa por governança) — rotação operacional é responsabilidade sua.

## Etapa 2 — Abrir uma rodada de captação

Com o projeto `Active`, o **owner** abre uma rodada (única por projeto, no MVP) no `ProjectFunding`:

```ts
await funding.openRound(
  projectId,
  target,        // alvo em CREDIT (18 decimais), >= minTarget (default 100e18)
  revShareBps,   // fatia da receita bruta oferecida: 100–3000 (1%–30%)
  duration       // segundos: 1 dia a 90 dias
)
```

Bounds on-chain (revertem fora da faixa):

| Parâmetro | Mínimo | Máximo | Erro |
|---|---|---|---|
| `revShareBps` | `100` (1%) | `3000` (30%) | `RevShareOutOfBounds` |
| `target` | `minTarget` (100e18) | — | `TargetOutOfBounds` |
| `duration` | `1 days` | `90 days` | `DurationOutOfBounds` |

`openRound` exige projeto `Active` e `msg.sender == owner`. Só uma rodada por projeto: uma segunda chamada reverte com `RoundAlreadyExists`.

### O que acontece na rodada

- **Investidores com GOV stakeado no seu projeto** depositam CREDIT via `invest(projectId, amount)`. O gate é `Staking.getWeight(investor, projectId) > 0` — quem não stakou GOV no projeto não pode investir (`NoGovStaked`).
- **All-or-nothing.** Quando `raised == target`, a rodada finaliza automaticamente: o `ProjectFunding` transfere **todo o capital captado** para você (o owner) e ativa o rev-share (`RoundStatus.Funded`).
- Se o prazo vence sem bater o alvo, qualquer um "carimba" a falha com `closeExpiredRound`, e cada investidor saca 100% do que aportou com `refund`. Você não recebe nada — protege o investidor de financiar pela metade um projeto inviável.

### Depois de financiada

Com a rodada `Funded`, `revShareBpsOf(projectId)` passa a retornar o bps prometido, e o `FeeRouterV2` **desconta essa fatia automaticamente a cada `pay`**, encaminhando-a ao `ProjectFunding` para distribuição pro-rata aos investidores. Você não faz nada — o desconto é on-chain e atômico.

Consequência: com rev-share ativo, sua parcela `toApp` cai de ~97,5% para `100% - 2,5% - revShareBps%`. Ex.: rev-share de 8% → você fica com ~89,5% de cada pagamento. É o custo do capital antecipado.

## Resumo do fluxo

```
1. owner aprova GOV pro Registry
2. proposta de governança: registerProject(owner, uri, colateral)  -> Pending
3. proposta de governança: activateProject(projectId)              -> Active
4. (agora já cobra pagamentos: fee 2,5%, app fica com ~97,5%)
5. (opcional) owner: openRound(projectId, alvo, revShareBps, prazo)
6. investidores stakados investem CREDIT -> alvo batido -> capital pro owner + rev-share ativo
```

---

**Próximo →** [Consultar estado on-chain](04-querying-state.md)
