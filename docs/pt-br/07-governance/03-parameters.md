# Parâmetros ajustáveis pela DAO

**Para quem é:** quem quer saber exatamente o que a DAO pode mudar e quais são as faixas permitidas.
**Pré-requisitos:** [Ciclo de uma proposta](01-proposal-lifecycle.md).

Esta página lista **todos** os parâmetros ajustáveis via governança, o valor em produção, o bound on-chain, e qual função é usada para alterar.

## Contratos e funções de ajuste

### GovernanceToken

Owner em produção = `CommunityTimelock`. Propostas que chamem:

| Função | O que faz | Bound on-chain |
|---|---|---|
| `mint(to, amount, tag)` | Cunha GOV para `to` até atingir `CAP_SUPPLY` | Reverte com `CapExceeded` se supply pós-mint > 100M |

Sem setters de parâmetro — `CAP_SUPPLY` é imutável.

### CreditToken

Admin em produção = `CommunityTimelock`. Propostas:

| Função | O que faz | Bound on-chain |
|---|---|---|
| `grantRole(MINTER_ROLE, addr)` | Concede poder de mint | — |
| `revokeRole(MINTER_ROLE, addr)` | Revoga | — |
| `grantRole(BURNER_ROLE, addr)` | Concede poder de burn role-gated | — |
| `revokeRole(BURNER_ROLE, addr)` | Revoga | — |

`mintGenesis` não é chamável após a primeira execução (flag `genesisMinted`).

### ProjectRegistry

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `registerProject(owner, uri, collateral)` | Lista novo projeto | `collateral >= minCollateral` | — |
| `activateProject(id)` | Pending → Active | status deve ser Pending | — |
| `setProbation(id)` | Active → Probation | status deve ser Active | — |
| `reactivate(id)` | Probation → Active | status deve ser Probation | — |
| `removeProject(id, slash, treasury)` | → Removed | status != Removed | — |
| `setMinCollateral(newMin)` | Ajusta colateral mínimo | `newMin > 0` | `10.000 GOV` |
| `setProbationDuration(newDuration)` | Ajusta probation inicial | `newDuration > 0` | `2.592.000 seg` (30d) |

### Treasury

| Função | O que faz | Bound on-chain |
|---|---|---|
| `transfer(token, to, amount)` | Envia ERC-20 | `balance suficiente` |
| `batchTransfer(token, recipients[], amounts[])` | Batch de transfers | arrays válidos, saldo total suficiente |
| `payRebates(token, apps[], amounts[], round)` | Batch com evento semântico | idem |
| `executeBuyback(stable, amountIn, minGovOut, swapData)` | Stub v1 — só emite evento | `stable != 0, amountIn > 0, minGovOut > 0` |
| `sweepETH(to, amount)` | Saca ETH | `balance suficiente` |

### Staking

Sem parâmetros ajustáveis. `MIN_LOCK`, `MAX_LOCK`, `MULTIPLIER_PRECISION`, `MAX_MULTIPLIER` são `constant`.

### BurnTracker

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `closeRound()` | Fecha rodada atual, abre próxima | — | — |
| `setRoundDuration(new)` | Ajusta duração alvo da rodada | `[MIN_ROUND_DURATION=1d, MAX_ROUND_DURATION=30d]` | `604.800 seg` (7d) |
| `setMaxBurnPerRoundPerProject(new)` | Sanity cap; 0 = desabilita | — | `10M CREDIT` |
| `grantRole(RECORDER_ROLE, app)` | Autoriza app a chamar `burnAndRecord` | — | — |
| `revokeRole(RECORDER_ROLE, app)` | Desautoriza | — | — |

### RewardDistributor

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `finalizeRound(round)` | Grava emissão imutável da rodada | sequencial, rodada fechada no tracker | — |
| `setAlpha(new)` | Ajusta alpha | `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` | `0.95e18` |
| `setCapMax(new)` | Ajusta teto por rodada | `[MIN_CAPMAX=1e18, MAX_CAPMAX=100M*1e18]` | `5M CREDIT` |
| `grantRole(GOVERNANCE_ROLE, addr)` | idem | — | — |

`floorSchedule` é **imutável** após deploy.

### FeeRouter

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `setDefaultSplit(split)` | Split global default | `burnBps + treasuryBps + rebateBps == 10.000` | `(9500, 0, 500)` |
| `setProjectSplit(id, split)` | Override por projeto | idem | — |
| `clearProjectSplit(id)` | Remove override | override precisa existir | — |

`setAppRecipient(id, recipient)` é owner-gated (não governance).

### UserSubsidy

| Função | O que faz | Bound on-chain |
|---|---|---|
| `createCampaign(root, amountPerUser, maxClaims, deadline)` | Abre campanha Merkle | `root != 0, amount > 0, maxClaims > 0, deadline > now` |
| `closeCampaign(id, returnTo)` | Fecha e devolve sobras | campanha existe e não fechada |

### TeamVesting

Uma instância por beneficiário. Owner = `CommunityTimelock`.

| Função | O que faz | Bound on-chain |
|---|---|---|
| `revoke(returnTo)` | One-shot; congela fronteira | `!revoked, returnTo != 0` |

Cronograma (`start`, `cliff`, `duration`) é imutável (setado no constructor).

### CommunityTimelock

Self-administered pós-handoff. Propostas:

| Função | O que faz |
|---|---|
| `updateDelay(newDelay)` | Ajusta `minDelay`. Novo valor aplicado a propostas futuras. |
| `grantRole(PROPOSER_ROLE, addr)` | Adiciona proposer |
| `revokeRole(PROPOSER_ROLE, addr)` | Remove |
| `grantRole(CANCELLER_ROLE, addr)` | Adiciona canceller |
| `revokeRole(CANCELLER_ROLE, addr)` | Remove |
| `grantRole(EXECUTOR_ROLE, addr)` | Adiciona executor |

### CommunityGovernor

Todas as mudanças são `onlyGovernance` (precisam vir via proposta aprovada pelo próprio Governor). Valores em produção em `ignition/parameters/production.json`.

| Função | O que faz | Bound on-chain | Valor em produção |
|---|---|---|---|
| `setVotingDelay(new)` | Ajusta delay até abrir votação | `> 0` (uint48) | `7200` (~1d) |
| `setVotingPeriod(new)` | Ajusta duração da votação | `> 0` (uint32) | `50400` (~7d) |
| `setProposalThreshold(new)` | Ajusta threshold para propor | `>= 0` | `10.000 * 1e18 GOV` |
| `updateQuorumNumerator(new)` | Ajusta numerador do quorum | `[0, 100]` | `4` |
| `relay(target, value, data)` | Executa operação arbitrária como se fosse o governor (rara) | — | — |

## Parâmetros imutáveis

A DAO **não pode** alterar:

| Parâmetro | Onde | Valor |
|---|---|---|
| `CAP_SUPPLY` do GOV | `GovernanceToken` | 100.000.000 * 1e18 |
| `MIN_LOCK` do Staking | `Staking` | 14 dias |
| `MAX_LOCK` do Staking | `Staking` | 365 dias |
| `MAX_MULTIPLIER` do Staking | `Staking` | 4e18 |
| `MULTIPLIER_PRECISION` do Staking | `Staking` | 1e18 |
| `MIN_ROUND_DURATION` | `BurnTracker` | 1 dia |
| `MAX_ROUND_DURATION` | `BurnTracker` | 30 dias |
| `MIN_ALPHA`, `MAX_ALPHA` | `RewardDistributor` | `0.5e18`, `0.99e18` (reduzido de `1.1e18` — ver `audit/economist/2026-04-22-consistency-audit.md` C2; garante IE1 α<1 permanente por construção) |
| `MIN_CAPMAX`, `MAX_CAPMAX` | `RewardDistributor` | `1e18`, `100M*1e18` |
| `FLOOR_SCHEDULE_LENGTH` | `RewardDistributor` | 24 |
| `PROBATION_PENALTY_DENOM` | `RewardDistributor` | 4 (25%) |
| `floorSchedule` (valores) | `RewardDistributor` | gravados no deploy |
| `_BPS_DENOMINATOR` | `FeeRouter` | 10.000 |
| Endereços dos contratos | deploy | fixos |
| `CommunityGovernor` `name` (EIP-712) | `CommunityGovernor` | "CommunityGovernor" |

Esses valores são o **piso constitucional** do protocolo: nem a DAO unânime pode alterar.

## Como propor uma mudança de parâmetro

Exemplo: reduzir `alpha` de `0.95e18` para `0.90e18`.

```solidity
targets   = [address(rewardDistributor)];
values    = [0];
calldatas = [
    abi.encodeWithSelector(rewardDistributor.setAlpha.selector, 0.90e18)
];
description = "Reduce alpha to 0.90 to increase deflationary pressure";

governor.propose(targets, values, calldatas, description);
```

Pré-requisitos:

- O proposer tem >= 10k GOV delegados.
- O valor novo `0.90e18` está dentro de `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]`. Se fora, a execução reverte (mesmo com voto aprovado).

## Efeito temporal das mudanças

Mudanças de parâmetro entram em vigor **no bloco da execução** e afetam apenas estado futuro:

- `setAlpha` altera o cálculo de `finalizeRound` para rodadas **não-finalizadas**. Rodadas com `roundData[r].finalized == true` têm `totalEmission` imutável.
- `setCapMax` idem.
- `setRoundDuration` afeta rodadas futuras (rodadas já abertas não são truncadas).
- `setMaxBurnPerRoundPerProject` afeta gatings em novos `burnAndRecord` — acumulados passados permanecem.
- `setDefaultSplit` / `setProjectSplit` afetam `pay`s futuros.
- `setMinCollateral` / `setProbationDuration` afetam **novos** registros; existentes não são grandfather-alterados.

## Observabilidade

Eventos de mudança de parâmetro:

```
# RewardDistributor
event AlphaUpdated(uint256 oldAlpha, uint256 newAlpha);
event CapMaxUpdated(uint256 oldCap, uint256 newCap);

# BurnTracker
event RoundDurationUpdated(uint64 oldDuration, uint64 newDuration);
event MaxBurnPerRoundPerProjectUpdated(uint256 oldMax, uint256 newMax);

# FeeRouter
event DefaultSplitUpdated(Split oldSplit, Split newSplit);
event ProjectSplitUpdated(uint256 indexed projectId, Split newSplit);
event ProjectSplitCleared(uint256 indexed projectId);

# ProjectRegistry
event MinCollateralUpdated(uint256 oldMin, uint256 newMin);
event ProbationDurationUpdated(uint64 oldDuration, uint64 newDuration);
```

Indexadores externos devem monitorar e mostrar histórico de parâmetros para transparência.

---

**Próximo →** [Referência de contratos](../08-contracts-reference/)
