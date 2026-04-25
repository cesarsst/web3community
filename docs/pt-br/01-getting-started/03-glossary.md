# Glossário

**Para quem é:** qualquer leitor que bata em um termo estranho em outra página.
**Pré-requisitos:** nenhum.

Termos usados nas outras páginas. Definições baseadas no código, não em convenção externa.

## Alpha (α)

Fator multiplicador da fórmula de emissão em [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md) / [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md). Aplicado ao burn da rodada anterior. Em produção `950000000000000000` (= 0.95 em precisão 1e18). Ajustável via governança dentro dos bounds `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` — `MAX_ALPHA` foi reduzido de `1.1e18` para garantir IE1 (α < 1 permanente) por construção; ver `audit/economist/2026-04-22-consistency-audit.md` C2.

## Bonders

Quarto bucket do `RewardDistributorV2` (default 5% da emissão por rodada). Na Fase 1 do CLP, esse bucket vira **refill earmarkado do POL** — `RewardDistributorV2` mint CREDIT direto para o Treasury que acumula no ledger `polRefillBucket`. Na Fase 3, será reciclado para um `BondDepository` (usuários trocam ETH/CREDIT por CREDIT vested, protocolo acumula liquidez via bonds).

## Bucket (split de emissão)

Uma das 4 fatias da emissão V2: stakers (default 55%), LPs (25%), apps (15%), bonders (5%). Cada bucket tem destino e mecanismo de distribuição próprio. Soma exata 10000 bps — ver [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md).

## Burn (queima)

Decremento permanente de `totalSupply` de CREDIT via `_burn` nativo do ERC-20. Acontece quando um usuário paga em um app e o `FeeRouter` encaminha a fatia de `burnBps` ao `BurnTracker.burnAndRecord`, que por sua vez chama `CreditToken.burnByRole`.

## BurnTracker

Oráculo interno on-chain que contabiliza burn por `(rodada, projectId)`. Consumido pelo `RewardDistributor` para calcular share de cada projeto. Ver [BurnTracker](../08-contracts-reference/06-BurnTracker.md).

## Cap (de supply)

Limite máximo de tokens que podem existir. GOV tem cap **imutável** de 100M. CREDIT não tem cap hardcoded — sua inflação é controlada pelo `RewardDistributor` via `capMax` por rodada (ajustável via governança).

## Checkpoint (anti-flashloan)

Historiografia on-chain de pesos de staking por bloco. `Staking` escreve checkpoints em cada mudança; `RewardDistributor` lê no `snapshotBlock` da rodada (block.number de quando `finalizeRound` foi chamado). Impede que alguém stake no mesmo bloco de uma consulta para capturar share artificialmente.

## CLP (Credit Liquidity Protocol)

Pivot econômico de abril/2026 (parecer `audit/economist/2026-04-24-clp-pivot.md`). Reorganiza o protocolo em quatro fases:

- **1.1 — FFP buyback**: defesa de floor via swap real USDC→CREDIT + queima.
- **1.2 — POL**: liquidez própria do protocolo no pool CREDIT/USDC.
- **1.3 — LiquidityGauge**: incentiva LPs externos via bucket dedicado (25% emissão).
- **1.4 — Bucket-aware split**: `RewardDistributorV2` divide emissão em 4 buckets simultâneos.
- **3 (futuro)**: BondDepository — usuários trocam ETH/CREDIT por CREDIT vested.

## CREDIT

Token utilitário ERC-20 queimável do protocolo. Supply elástico. Usado para pagar dentro dos apps do ecossistema. Cunhado como reward para stakers (lazy, via claim) e como push direto para LPs/apps/bonders pelo `RewardDistributorV2`. Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## DAO (Decentralized Autonomous Organization)

Aqui se refere ao conjunto `CommunityGovernor` + `CommunityTimelock`, que juntos controlam **todos** os contratos econômicos do protocolo em produção.

## FFP (Floating com Floor Price)

Modelo de defesa de preço do CREDIT (Fase 1.1 CLP). Spot é livre acima do floor; quando spot < floor por >= 24h, governance pode propor `Treasury.executeBuyback(usdcAmount, minCreditOut)` que executa swap USDC→CREDIT via Uniswap V3 e **queima** o CREDIT comprado imediatamente. Floor calculado como `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)` — default `max(0.50 × MA90, $0.10)`. Caps por evento (20%) e mensal (30%) sobre reservas USDC do Treasury. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## FeeRouter

Contrato que recebe pagamentos em CREDIT dos usuários, divide segundo `split` (default 95% burn / 0% treasury / 5% rebate ao app) e distribui cada fatia para seu destino. Ver [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

## Finalize (de rodada)

Ação permissionless de congelar a emissão calculada para uma rodada — grava `RoundData` imutável (totalEmission, totalBurnAtFinalize, snapshotBlock). Após isso, stakers podem reivindicar. Função: `RewardDistributor.finalizeRound(round)`.

## Floor schedule

Array imutável de 24 valores em `RewardDistributor`. `floorSchedule[R]` é o piso de emissão da rodada R. Em produção decai linearmente de 400.000 CREDIT (rodada 0) a ~16.666 CREDIT (rodada 23). Rodadas >= 24 não têm floor.

## Genesis mint

Cunhagem inicial única de CREDIT (10M em produção) feita uma única vez via `CreditToken.mintGenesis(to, amount)`. Flag one-shot `genesisMinted` bloqueia chamadas subsequentes. Destinatário em produção: `Treasury`.

## GOV

Token de governança ERC-20 com extensão `ERC20Votes`. Supply cap imutável de 100M. Usado para votar (via `getPastVotes`) e como colateral de staking. Ver [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md).

## GOVERNANCE_ROLE

Role AccessControl concedida em produção **apenas** ao `CommunityTimelock`. Gate em todas as funções de governança-sensíveis dos contratos econômicos (Treasury, ProjectRegistry, Staking, BurnTracker, RewardDistributor, FeeRouter, UserSubsidy).

## LiquidityGauge

Adapter sobre o `UniswapV3Staker` canônico (Uniswap Foundation) que distribui o **bucket LPs** do `RewardDistributorV2` (default 25% da emissão) para LPs externos do par CREDIT/USDC. Usuário stakeia o NFT V3 no gauge → recebe CREDIT proporcional ao tempo in-range → após `unstake` o reward entra em vesting linear de 14 dias → `harvest` saca o vestido. Ver [LiquidityGauge](../08-contracts-reference/13-LiquidityGauge.md).

## Lock (de staking)

Tempo (em segundos) durante o qual uma posição de stake não pode ser desfeita. Faixa permitida: `[MIN_LOCK=14 dias, qualquer tempo]`. Multiplier saturou em 4x a partir de `MAX_LOCK=365 dias`.

## MA90

Média móvel de 90 dias do preço do CREDIT em USD, mantida no ring buffer `dailyPrices[90]` do Treasury. Atualizada por `recordDailyPrice` (permissionless, cooldown 22h). Usada como referência do floor relativo do FFP. Antes de bootstrapped (90 amostras), `ma90Price()` retorna 0 e o floor cai para `floorAbsoluteUsd` apenas (default $0.10).

## Multiplier (de staking)

Fator aplicado ao `amount` para calcular peso. Linear de 1x (14 dias) a 4x (365 dias), satura em 4x acima. Definido em `Staking._multiplier(lockDuration)`.

## ownerRecipient

Endereço canônico (com timelock 48h) que recebe o bucket apps do `RewardDistributorV2`. Setado via `proposeOwnerRecipient(projectId, newRecipient)` (só owner) → aguarda 48h → `applyOwnerRecipient(projectId)` (permissionless). Fallback é `project.owner` quando não há recipient explícito setado. Cancelável pelo owner OU por `GOVERNANCE_ROLE` (escape hatch). Ver [ProjectRegistry](../08-contracts-reference/03-ProjectRegistry.md).

## POL (Protocol-Owned Liquidity)

Liquidez própria do protocolo no pool CREDIT/USDC 0.3%. NFT custodiado pelo Treasury (slot `polTokenId`), range full ticks (`-887220, 887220`). Provisionada via `Treasury.addPOL` (seed) ou `addPOLFromRefill` (drena bucket bonders + USDC do balance livre). Sem rebalance ativo. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## Probation

Duas noções distintas no `ProjectRegistry`:

- **Probation inicial por tempo**: janela automática aplicada a todo projeto recém-ativado, durante `probationDuration` (30 dias em produção). Stake e pagamentos funcionam normalmente, mas **share de rewards é dividido por 4** (25%). Detectada via `isInProbation(projectId)`.
- **Probation punitiva**: status do enum `Project.Status`. Governança move manualmente um projeto de `Active` para `Probation` por má conduta. Bloqueia stake novo e pagamentos, mas **nunca bloqueia unstake**.

## Proposal (proposta)

Objeto do Governor contendo `(targets, values, calldatas, descriptionHash)`. Passa por estados Pending → Active → Succeeded/Defeated → Queued → Executed (ou Canceled/Expired). Só executável via Timelock após todos os delays.

## polRefillBucket

Ledger interno do Treasury que acumula o bucket bonders do `RewardDistributorV2` (5% default da emissão por rodada). Drenado por `Treasury.addPOLFromRefill(creditAmount, usdcAmount, ...)` que casa CREDIT do ledger com USDC do balance livre para injeção no `polTokenId`. CEI: debita ledger antes de chamada externa (idempotência em revert).

## Rebate

Fatia (default 5%) de um pagamento em CREDIT que o FeeRouter transfere ao `appRecipient` do projeto. É como o app captura caixa operacional.

## Recorder (RECORDER_ROLE)

Role no `BurnTracker` concedida a cada app listado (tipicamente ao `FeeRouter`). Autoriza chamada `burnAndRecord`. Concedida via proposta aprovada no Governor.

## Round / Rodada

Período de tempo contabilístico do protocolo. Iniciado em `BurnTracker` (`currentRound`). Aberto indefinidamente até governança chamar `closeRound()`, que incrementa `currentRound` e reseta `roundStartedAt`. Duração alvo em produção: 7 dias (`roundDuration = 604800`).

## RewardDistributorV2

Versão bucket-aware do distributor de emissão (Fase 1.4 CLP). Re-deploy paralelo ao V1 — V1 fica em modo claim-only durante migração de 4 rounds. V2 divide a emissão em 4 buckets simultâneos: stakers (lazy), LPs (push gauge), apps (push retrospectivo via burn), bonders (push refill POL). Ver [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md).

## Sanity cap

Limite máximo de burn por `(rodada, projectId)` no `BurnTracker`. Em produção `10_000_000e18` CREDIT. Previne ataque em que um projeto queima volume absurdo para capturar share desproporcional. Valor 0 = desativado (opt-out explícito por governança).

## Snapshot (de voto)

Bloco de referência para calcular voting power de uma proposta. `Governor` usa `getPastVotes(account, proposalSnapshot)`; `RewardDistributor` usa `getWeightAt(user, projectId, snapshotBlock)`. Ambos imunes a flash-loans que movam tokens no mesmo bloco.

## Split

Configuração `(burnBps, treasuryBps, rebateBps)` no `FeeRouter` que soma exatamente 10_000 bps = 100%. Default global 9500/0/500. Pode ser substituído por projeto via `setProjectSplit` (governança) ou por hora via `setAppRecipient` (owner do projeto apenas para o recipient do rebate).

## Staking (direcionado)

Ato de lockar GOV em um `projectId` específico do Registry. Define peso = `amount * multiplier(lockDuration) / 1e18`. Peso alimenta share de rewards. Ver [Staking](../08-contracts-reference/05-Staking.md).

## Timelock

Contrato que executa decisões do Governor com atraso mínimo (`minDelay`, em produção 2 dias). `CommunityTimelock` é subclasse trivial do `TimelockController` da OpenZeppelin. Único portador de `GOVERNANCE_ROLE` em produção.

## Treasury

Cofre multi-ativo da DAO. Recebe passivamente (transferências ERC-20 diretas) e só libera fundos via função `onlyRole(GOVERNANCE_ROLE)`. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## Vesting

Liberação gradual de GOV para um beneficiário do time ao longo do tempo, com cliff + linear. Uma instância de `TeamVesting` por membro. Ver [TeamVesting](../08-contracts-reference/11-TeamVesting.md).

## Voting delay / period

Parâmetros do Governor em **blocos**:

- `votingDelay` = blocos entre `propose` e abertura da votação. Em produção 7200 (~1 dia a 12s/bloco).
- `votingPeriod` = duração da votação. Em produção 50400 (~7 dias).

Ambos ajustáveis via `onlyGovernance` (proposta + execução pelo Timelock).

## Weight (peso de staking)

`amount * multiplier(lockDuration) / 1e18`. Lido com snapshot histórico via `Staking.getWeightAt` / `Staking.getTotalWeightAt` / `Staking.getGlobalWeightAt`.

---

**Próximo →** [Trilhas de leitura](04-reading-paths.md)
