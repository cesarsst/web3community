# Métricas que importam

**Para quem é:** quem acompanha a saúde operacional do protocolo.
**Pré-requisitos:** [Value accrual](02-value-accrual.md), [Consultar estado on-chain](../05-for-developers/04-querying-state.md).

Métricas que você pode calcular direto dos contratos. Todas on-chain, sem depender de indexador externo.

## Métricas do remodel 2026-07-08 (saúde do protocolo)

A renda do investidor agora é **receita real, não emissão** — as métricas primárias mudaram de burn/emissão para GMV/receita distribuída.

### Volume bruto por projeto (GMV)

**O que é**: todo pagamento que passou pelo `FeeRouterV2` para o projeto. É o proxy direto de uso real — substitui o burn como métrica primária.

```solidity
feeRouterV2.grossVolumeOf(projectId);
```

**Como interpretar**: crescente → app ganhando tração (e rev-share dos investidores crescendo junto). Zero por muito tempo → sinal terminal. Para série temporal, indexe eventos `PaymentRouted` (têm o detalhamento fee/rev-share/app por pagamento).

### Receita distribuída aos investidores

```solidity
funding.totalRevenueDistributed(projectId);   // acumulado pago via rev-share
funding.pendingRevenue(projectId, investor);  // pendente de claim do investidor
```

### Yield realizado por projeto

```
round = funding.rounds(projectId);
yield_acumulado = totalRevenueDistributed / round.raised
yield_anualizado ~= yield_acumulado * (365 dias / idade_da_rodada)
```

**Como interpretar**: compare com o custo de oportunidade (rev-share de 8% sobre GMV mensal de 20% do captado ≈ 19% a.a.). Yield real depende 100% do GMV do app — não é prometido.

### Rev-share ativo e status das rodadas

```solidity
funding.revShareBpsOf(projectId);   // 0 = sem rodada Funded; 100-3000 bps
funding.rounds(projectId);          // { target, raised, deadline, revShareBps, status }
```

Razão Funded/Failed entre projetos indica confiança dos investidores na esteira de projetos.

### Lastro do PSM (peg do CREDIT)

```solidity
psm.backingNormalized();     // lastro USDC em 18 dec
psm.mintedOutstanding();     // CREDIT em circulacao mintado pelo PSM
```

**Invariante I-PSM1**: `backingNormalized() >= mintedOutstanding`. Qualquer um verifica a qualquer momento. Violação = bug crítico (não há função de saque do lastro).

### Fee acumulada do protocolo

Indexe `PaymentRouted` e some `feeToTreasury` / `feeToBuyback` / `feeToGrants`: receita do protocolo (1% do GMV pro treasury), pressão de buyback de GOV (1% do GMV) e grants (0,5% do GMV).

## Métricas de uso do trilho legado (burn-to-mint)

> ⚠️ **LEGADO** — as métricas de burn/emissão abaixo só se movem para claims históricos; o FeeRouterV2 não queima nem emite. Úteis para auditar o passado, não para acompanhar o presente.

### Burn por rodada

**O que é**: quanto CREDIT foi queimado em cada rodada. Era o proxy de uso real no modelo antigo.

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

No modelo vigente, deve acompanhar `psm.mintedOutstanding()` (+ resíduo legado de genesis/emissões antigas). Supply cresce = demanda por trilho crescendo; encolhe = usuários resgatando USDC. Não é mais métrica de deflação.

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

### Emissão por rodada (legado)

```solidity
rd.getEmission(round);             // se finalized
rd.previewEmission(round);         // preview
```

Compare com `capMax` para saber se está dominado pelo cap (emissão saturou) ou pelo burn.

### Razão emissão / burn (legado)

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

## Métricas de rodadas de burn (legado)

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

## Métricas operacionais do FeeRouterV2

### Volume total pago

Indexar eventos `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)`.

Sum(amount) = GMV do protocolo (bate com Σ `grossVolumeOf`).
Sum(revShare) = renda total repassada a investidores.
Sum(toApp) = caixa total distribuído para apps (~89,5-97,5% do GMV).
Sum(fee*) = receita do protocolo (2,5% do GMV: 40/40/20).

### Preview de pagamento

```solidity
feeRouterV2.previewPay(projectId, amount);  // (fee, revShare, toApp)
```

(Legado: `feeRouter.getEffectiveSplit` e eventos `Paid` do V1 seguem consultáveis para o histórico.)

## Dashboard mínimo sugerido

Para dev/investidor/operador acompanhar:

```
┌ Saúde do uso (GMV) ───────────────────┐
│ GMV total (PaymentRouted, 30d)         │
│ grossVolumeOf top-5 projetos           │
│ N projetos com pagamento no periodo    │
│ N projetos Active no Registry          │
└────────────────────────────────────────┘
┌ Funding / rev-share ──────────────────┐
│ Rodadas Open / Funded / Failed         │
│ totalRevenueDistributed top-5          │
│ Yield anualizado por projeto           │
│ Rev-share medio (bps) das Funded       │
└────────────────────────────────────────┘
┌ Staking ──────────────────────────────┐
│ Total staked (GOV)                     │
│ Global weight                          │
│ Top-5 projetos por weight              │
│ Weight / Staked ratio (lock medio)     │
└────────────────────────────────────────┘
┌ Peg / Supply ─────────────────────────┐
│ psm.backingNormalized vs               │
│   psm.mintedOutstanding (I-PSM1)       │
│ CREDIT totalSupply                     │
│ GOV totalSupply vs cap                 │
└────────────────────────────────────────┘
┌ Governança ───────────────────────────┐
│ Propostas abertas                      │
│ % participacao ultima proposta         │
│ Quorum vigente (4% do supply)          │
│ Lista pendente no Timelock             │
└────────────────────────────────────────┘
┌ Treasury / fee ───────────────────────┐
│ Fee acumulada (treasury/buyback/grants)│
│ Saldos GOV, CREDIT, outros tokens      │
│ Saidas recentes (Transferred event)    │
└────────────────────────────────────────┘
```

Todas essas métricas são derivadas de chamadas `view` nos contratos + indexação de eventos. Nenhum dado off-chain é necessário.

## Sinais de alerta

- GMV (`PaymentRouted`) caindo por > 4 semanas consecutivas.
- `backingNormalized() < mintedOutstanding` — violação de I-PSM1; bug crítico, investigar imediatamente.
- Rodadas de funding consistentemente `Failed` — investidores não confiam na esteira de projetos.
- `totalRevenueDistributed` estagnado em projetos Funded com GMV positivo — rev-share não está fluindo (investigar roles).
- `FeeUpdated` aproximando `feeBps` do teto de 500 sem justificativa clara.
- `totalStaked` caindo rapidamente (stakers unstakando após lock — enfraquece o gate de investimento).
- Participação em propostas < 50% do quorum mínimo.
- Saídas grandes do Treasury sem proposta correspondente conhecida (investigar imediatamente — seria evidência de exploit, embora access control mitigue).
- (Legado) claims históricos anômalos nos RewardDistributors.

---

**Próximo →** [Ciclo de proposta](../07-governance/01-proposal-lifecycle.md)
