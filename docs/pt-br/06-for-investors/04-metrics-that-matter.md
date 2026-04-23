# Métricas que importam

**Para quem é:** quem acompanha a saúde operacional do protocolo.
**Pré-requisitos:** [Value accrual](02-value-accrual.md), [Consultar estado on-chain](../05-for-developers/04-querying-state.md).

Métricas que você pode calcular direto dos contratos. Todas on-chain, sem depender de indexador externo.

## Métricas de uso (saúde do protocolo)

### Burn por rodada

**O que é**: quanto CREDIT foi queimado em cada rodada. Proxy direto do uso real dos apps.

**Como ler**:

```solidity
burnTracker.getTotalBurnForRound(round);
```

**Como interpretar**:

- Crescente ao longo das rodadas → protocolo ganhando tração.
- Plano → estável.
- Decrescente → alerta; investigue causa (app caiu? saída de usuários?).
- Zero por muitas rodadas → sinal terminal.

### Burn por projeto

**O que é**: distribuição do burn entre projetos ativos.

**Como ler**:

```solidity
burnTracker.getBurnForProjectInRound(round, projectId);
```

Para cada `projectId` listado, em cada rodada.

**Como interpretar**:

- Concentração em 1-2 projetos → alta dependência; risco se um some.
- Distribuição equilibrada → ecossistema saudável com múltiplos contribuintes.
- Projetos novos aparecendo consistentemente → entrada saudável.

### Projetos com burn por rodada

**O que é**: quantos projetos distintos tiveram pelo menos 1 burn.

**Como ler**:

```solidity
burnTracker.projectsWithBurnCount(round);
```

**Como interpretar**: número crescente = amplitude do ecossistema crescendo. Estagnação = poucos projetos estão segurando tudo.

### Projetos totais no Registry

```solidity
registry.totalProjects();
```

Soma de todos que já foram registrados (inclui `Removed`). Para ativos, itere via `registry.isActive(id)` de 1 a `totalProjects()`.

## Métricas de staking

### Stake total agregado

```solidity
staking.totalStaked();
```

GOV total imobilizado em posições. Alta = confiança de holders. Baixa = holders preferem liquidez a exposição.

### Peso global

```solidity
staking.getGlobalWeight();
```

Soma de pesos em todos os projetos. Reflete tanto o `totalStaked` quanto a escolha de locks longos (multiplier).

### Stake por projeto

```solidity
staking.totalStakedByProject(projectId);
staking.getTotalWeight(projectId);
```

Indicador de qual projeto tem mais apoiadores. Deve correlacionar com burn do projeto ao longo do tempo (apps com bom stake tendem a gerar mais uso).

### Distribuição de locks

Não há view agregada para distribuição de `lockDuration`. Métrica derivada é `globalWeight / totalStaked` — se for > 1 significa lock médio acima de 14 dias (multiplier > 1x). Perto de 4 significa muitos stakers em lock máximo.

## Métricas econômicas

### Supply de CREDIT

```solidity
credit.totalSupply();
```

Compare com o último valor e com `supply + emissao - burn` esperado da rodada. Divergência → investigar.

### Supply de GOV em circulação

```solidity
gov.totalSupply();
```

Em produção, começa em 0 e cresce via `mint` aprovados. Compare com o cap (`gov.cap()` = 100M) para saber o que ainda pode ser cunhado.

### GOV imobilizado

Soma de:

```solidity
staking.totalStaked();                    // em staking
// + colateral em projetos ativos
//   (iterar registry.getProject(id).collateral para id ativo)
// + saldos de TeamVesting (ainda não released)
// + Treasury
```

Razão `GOV_imobilizado / totalSupply` indica quão "em atividade" o GOV está. Alta = boa sinalização. Baixa = muitos holders parados.

### Emissão por rodada

```solidity
rd.getEmission(round);             // se finalized
rd.previewEmission(round);         // preview
```

Compare com `capMax` para saber se está dominado pelo cap (emissão saturou) ou pelo burn.

### Razão emissão / burn

```
ratio = emissao_R / burn_{R-1}
```

Se `alpha = 0.95`, essa razão deve ser ~0.95 (quando burn alto, não clampado por floor nem cap).

Se ratio = 1 exato → emissão atingiu `capMax` (clampada no teto).
Se ratio > 1 → emissão dominada pelo floor (burn baixo, bootstrap).
Se ratio ~ 0.95 → operação normal.

### Treasury balances

```solidity
treasury.balanceOf(IERC20(gov));
treasury.balanceOf(IERC20(credit));
address(treasury).balance;              // ETH
// + outros ERC-20 que a DAO receba
```

Monitorar saídas grandes. Eventos `Transferred`, `BatchTransferred`, `RebatesPaid` indicam o que a DAO aprovou gastar.

## Métricas de governança

### Participação em votos

Por proposta:

```solidity
(againstVotes, forVotes, abstainVotes) = governor.proposalVotes(proposalId);
totalVotes = againstVotes + forVotes + abstainVotes;
```

Compare `totalVotes` com `getPastTotalSupply(snapshot)` para participação %. Tendência declinante = engajamento caindo.

### Quorum atingido

```solidity
quorumNeeded = governor.quorum(snapshot);
quorumAtingido = forVotes + abstainVotes >= quorumNeeded;
```

### Propostas pendentes

Monitorar eventos `ProposalCreated` + `state(id)`.

### Delegação ativa

Para um account específico:

```solidity
gov.delegates(account);     // para quem delegou (0 se ninguem)
gov.getVotes(account);      // voting power atual
```

Agregado: soma de `getVotes` para addresses conhecidos. Compare com `totalSupply` para % delegado. Alta % delegada = governança vibrante.

## Métricas de rodadas

### Rodada atual

```solidity
burnTracker.currentRound();
burnTracker.roundStartedAt();
burnTracker.roundDuration();
burnTracker.isRoundReadyToClose();
```

### Última rodada finalizada

```solidity
rd.lastFinalizedRound();
rd.isFirstRoundFinalized();
```

Gap entre `currentRound - 1` e `lastFinalizedRound` indica se há rodadas fechadas sem finalize. Gap grande = alguém precisa chamar `finalizeRound` (permissionless, qualquer um pode).

### Histórico de emissões

```solidity
for (uint r = 0; r <= rd.lastFinalizedRound(); r++) {
    rd.roundData(r);  // { totalEmission, totalBurnAtFinalize, snapshotBlock, finalized }
}
```

Calcule cumulativo de emissão vs cumulativo de burn para ver saldo líquido de supply ao longo do tempo.

## Métricas operacionais do FeeRouter

### Volume total pago

Indexar eventos `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)`.

Sum(amount) = volume bruto do protocolo.
Sum(burned) = pressão deflacionária acumulada.
Sum(toApp) = caixa total distribuído para apps.

### Split efetivo por projeto

```solidity
feeRouter.getEffectiveSplit(projectId);
```

Para projetos com override vs default.

## Dashboard mínimo sugerido

Para dev/staker/operador acompanhar:

```
┌ Saúde do uso ─────────────────────────┐
│ Total burn (ultimas 4 rodadas)         │
│ Burn por projeto top-5                 │
│ N projetos com burn                    │
│ N projetos Active no Registry          │
└────────────────────────────────────────┘
┌ Staking ──────────────────────────────┐
│ Total staked (GOV)                     │
│ Global weight                          │
│ Top-5 projetos por weight              │
│ Weight / Staked ratio (lock medio)     │
└────────────────────────────────────────┘
┌ Supply ───────────────────────────────┐
│ CREDIT totalSupply                     │
│ GOV totalSupply vs cap                 │
│ Delta supply ultima rodada             │
│ Ratio emissao/burn                     │
└────────────────────────────────────────┘
┌ Governança ───────────────────────────┐
│ Propostas abertas                      │
│ % participacao ultima proposta         │
│ Quorum vigente (4% do supply)          │
│ Lista pendente no Timelock             │
└────────────────────────────────────────┘
┌ Treasury ─────────────────────────────┐
│ Saldos GOV, CREDIT, outros tokens      │
│ ETH                                    │
│ Saidas recentes (Transferred event)    │
└────────────────────────────────────────┘
```

Todas essas métricas são derivadas de chamadas `view` nos contratos + indexação de eventos. Nenhum dado off-chain é necessário.

## Sinais de alerta

- Burn por rodada caindo por > 3 rodadas consecutivas.
- `totalStaked` caindo rapidamente (stakers unstakando após lock).
- Participação em propostas < 50% do quorum mínimo.
- Projetos atingindo `SanityCapExceeded` — sinal de possível abuso.
- `RoundClosed.earlyClose = true` sem contexto claro via proposta.
- Saídas grandes do Treasury sem proposta correspondente conhecida (investigar imediatamente — seria evidência de exploit, embora access control mitigue).

---

**Próximo →** [Ciclo de proposta](../07-governance/01-proposal-lifecycle.md)
