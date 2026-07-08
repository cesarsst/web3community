# Sacando rev-share (e claims legados)

**Para quem é:** investidor esperando para sacar a receita que acumulou — e staker antigo com claims de emissão pendentes.
**Pré-requisitos:** [Staking em projetos](03-staking-in-projects.md), [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

> **Remodel 2026-07-08**: a renda vigente é o **rev-share** do [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md), sacado na aba **Investir** do hub. O claiming de emissão (`RewardDistributor` V1/V2) é **legado** — claims históricos continuam sacáveis, mas não há emissão nova. As duas jornadas estão nesta página.

## Sacando rev-share (modelo vigente)

### O que precisa ter acontecido antes

1. Você investiu CREDIT numa rodada que bateu o alvo (`Funded`) — com GOV stakeado no projeto.
2. O app recebeu pagamentos via `FeeRouterV2.pay` — cada um acumula sua fatia automaticamente.
3. Você **mantém** GOV stakeado no projeto (gate do `claim`).

### Descobrindo o que pode sacar

```solidity
uint256 pendente = funding.pendingRevenue(projectId, you);
```

Sem side effects — use livremente na UI (aba Investir).

### Sacando

```solidity
uint256 amount = funding.claim(projectId);
```

- Reverte `NoGovStaked` se você não tem mais GOV stakeado no projeto — o valor **não é perdido**, fica retido até você re-stakear.
- Reverte `NothingToClaim` se não há receita pendente.
- **Nunca expira.** Sem deadline, sem janela.

O que você recebe é CREDIT **estável** (resgatável 1:1 em USDC no PSM) que veio de receita real do app — não de emissão.

### Rodada Failed — refund

Se a rodada venceu sem bater o alvo, o caminho é outro: `funding.refund(projectId)` devolve 100% do que você investiu.

---

## Claims de emissão (LEGADO)

> ⚠️ **LEGADO** — todo o restante desta página descreve o claiming do trilho de emissão pré-remodel (`RewardDistributor` V1/V2). Direitos históricos persistem (não há deadline), mas rodadas novas não geram emissão.

## O que precisa ter acontecido antes

Pre-condições para você poder claim da rodada R-1:

1. Você tinha posição stakada em `(user, projectId)` no bloco do snapshot (setado em `finalizeRound(R-1)`).
2. A governança chamou `BurnTracker.closeRound()` fechando a rodada R-1 (currentRound virou R).
3. Alguém — pode ser você — chamou `RewardDistributorV2.finalizeRound(R-1)` (rodadas antigas da janela de migração são reivindicadas no V1).
4. Você ainda **não** reivindicou essa combinação `(R-1, projectId)`.

## Descobrindo o que pode claim

### Preview

```solidity
uint256 amount = rewardDistributor.previewClaim(you, round, projectId);
```

Retorna o valor que seria cunhado **se você chamasse `claim` agora**. Zero se:

- Round não finalizado.
- Já reivindicado.
- Seu peso era zero no snapshot.
- Projeto não gerou burn e peso global é zero (bootstrap edge case).

Sem side effects — use livremente na UI.

### Ver status de reivindicação

```solidity
bool alreadyClaimed = rewardDistributor.claimed(round, projectId, you);
```

## Reivindicando uma rodada

```solidity
uint256 amount = rewardDistributor.claim(round, projectId);
```

Passos internos:

1. Checa `roundData[round].finalized` — reverte `RoundNotFinalized` se false.
2. Checa `claimed[round][projectId][you]` — reverte `AlreadyClaimed` se true.
3. Calcula `amount`.
4. Se `amount > 0`:
   - Marca `claimed[...][you] = true`.
   - Emite `Claimed`.
   - Chama `CREDIT.mint(you, amount, "rewardRoundV2:stakers")` (no V1 legado, tag `"rewardRound"`).
5. Se `amount == 0`: não marca claimed, não cunha, retorna 0 (no-op silencioso).

O que você reivindica é a sua fatia do **bucket stakers** — 55% da emissão da rodada no split default do V2. Os outros buckets (LPs 25%, apps 15%, bonders 5%) são push no `finalizeRound` e não passam pelo `claim`.

Essa semântica de `amount == 0` sendo no-op é intencional — se por algum motivo o cálculo retornou 0 mas pode mudar, você não "queima" o slot de claim.

## Reivindicando em batch

Mais eficiente se você tem múltiplas rodadas ou múltiplos projetos:

```solidity
uint256[] memory rounds     = [5, 5, 6, 6, 7];
uint256[] memory projectIds = [42, 17, 42, 17, 42];

uint256 total = rewardDistributor.claimMany(rounds, projectIds);
```

Arrays **paralelos** — `rounds[i]` combina com `projectIds[i]`. Devem ter mesmo tamanho (senão `ArrayLengthMismatch`) e não podem ser vazios (senão `EmptyBatch`).

Efeito: uma única tx cunha `total` CREDIT, executando N claims individuais.

## Quando você perde claim

Você **não** perde claim por tempo — não há deadline. A única forma de perder é:

- **Não stakar antes do snapshot da rodada**. Stake depois não gera peso retroativo.
- **Unstakar antes do snapshot**. Depois do snapshot você pode unstakar que não afeta o claim daquela rodada.
- **O projeto não gerar burn nem ter peso suficiente** durante as rodadas em que você stakou.

Mas uma vez que seu peso foi gravado no snapshot e a rodada foi finalizada, você tem direito permanente de reivindicar.

## UI workflow típico

1. Conectar wallet no hub.
2. Ir para "My Rewards".
3. O app carrega todas as rodadas finalizadas desde sua primeira stake.
4. Para cada rodada × projeto em que você stakou e não reivindicou, mostra preview.
5. Você seleciona quais quer reivindicar.
6. App monta uma única tx `claimMany` com os pares selecionados.
7. Você assina, paga gas, recebe CREDIT.

## Gas

- `claim` único: ~180-220k gas (mint + evento).
- `claimMany` com N pares: ~180k + ~140k × N.

Batch é significativamente mais eficiente do que N txs individuais. Use quando possível.

## O que você recebe

CREDIT. Fungível, ERC-20 padrão. Você pode:

- Gastar em apps do ecossistema.
- Vender em DEX externa (se tiver liquidez).
- Manter (exposição à apreciação se supply continuar caindo).
- Re-usar (comprar mais GOV na DEX para stakar mais — o "re-stake" não é automático no v1).

Não há **auto-compound**. Não há **auto-claim**. Se você esquece, o CREDIT não é cunhado — ele só existe quando você solicita.

## Edge cases

### Round 0 — não há burn anterior

Na rodada 0, `burn_{-1}` é considerado 0. A emissão vem do floor (`floorSchedule[0]`). Shares por projeto são computados via **peso global** (`staking.getGlobalWeightAt`).

Portanto, se você stakou logo no início e o peso global só é o seu, você captura uma fatia grande. É o incentivo de ser early.

### Bootstrap sem stake

Se uma rodada finaliza e `globalWeight == 0` no snapshot, nenhum claim funciona — `_projectStakerShare` retorna 0 em todos os casos no caminho bootstrap. O bucket stakers é calculado mas **não é cunhado** (ninguém para distribuir). Os buckets LPs e bonders continuam sendo cunhados (push no `finalizeRound`); apps não emite sem burn.

### Probation inicial durante o claim

`RewardDistributorV2._calculateClaim` lê `REGISTRY.isInProbation(projectId)` **no momento do claim**, não do finalize. Se a probation inicial terminou entre finalize e claim, você recebe share cheio (probation é por tempo; `probationEndsAt` é setado na ativação e não muda).

### Projeto vira `Removed` entre finalize e claim

Seu direito de claim persiste — `roundData` é imutável após finalize. Você pode reivindicar mesmo com o projeto removido. Além disso, você pode unstake imediatamente (bypass de lock) se ainda tiver posição.

---

**Próximo →** [Visão geral de integração (devs)](../05-for-developers/01-integration-overview.md)
