# Glossário

**Para quem é:** qualquer leitor que bata em um termo estranho em outra página.
**Pré-requisitos:** nenhum.

Termos usados nas outras páginas. Definições baseadas no código, não em convenção externa.

> **Nota do remodel 2026-07-08**: termos do ciclo burn-to-mint (burn, emissão, buckets, rodadas de burn, CLP, FFP) descrevem o modelo **legado** — contratos mantidos deployados, mas fora do fluxo vigente. O modelo atual gira em torno de [CreditPSM](../08-contracts-reference/15-CreditPSM.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) e [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

## Alpha (α)

**Legado (pré-remodel 2026-07-08).** Fator multiplicador da fórmula de emissão em [`RewardDistributor`](../08-contracts-reference/07-RewardDistributor.md) / [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md). Aplicado ao burn da rodada anterior. Em produção `950000000000000000` (= 0.95 em precisão 1e18). Ajustável via governança dentro dos bounds `[MIN_ALPHA=0.5e18, MAX_ALPHA=0.99e18]` — `MAX_ALPHA` foi reduzido de `1.1e18` para garantir IE1 (α < 1 permanente) por construção; ver `audit/economist/2026-04-22-consistency-audit.md` C2.

## Bonders

Quarto bucket do `RewardDistributorV2` (default 5% da emissão por rodada). Na Fase 1 do CLP, esse bucket vira **refill earmarkado do POL** — `RewardDistributorV2` mint CREDIT direto para o Treasury que acumula no ledger `polRefillBucket`. Na Fase 3, será reciclado para um `BondDepository` (usuários trocam ETH/CREDIT por CREDIT vested, protocolo acumula liquidez via bonds).

## Bucket (split de emissão)

Uma das 4 fatias da emissão V2: stakers (default 55%), LPs (25%), apps (15%), bonders (5%). Cada bucket tem destino e mecanismo de distribuição próprio. Soma exata 10000 bps — ver [`RewardDistributorV2`](../08-contracts-reference/07b-RewardDistributorV2.md).

## Burn (queima)

Decremento permanente de `totalSupply` de CREDIT via `_burn` nativo do ERC-20. No modelo vigente, acontece apenas no resgate do PSM (`CreditPSM.sell` queima o CREDIT devolvido e libera o USDC 1:1). **Legado**: no modelo pré-remodel, acontecia quando um usuário pagava em um app e o `FeeRouter` V1 encaminhava a fatia de `burnBps` ao `BurnTracker.burnAndRecord`. O `FeeRouterV2` **não queima nada**.

## BurnTracker

**Legado (pré-remodel 2026-07-08).** Oráculo interno on-chain que contabiliza burn por `(rodada, projectId)`. Consumido pelo `RewardDistributor` para calcular share de cada projeto. Ver [BurnTracker](../08-contracts-reference/06-BurnTracker.md).

## Cap (de supply)

Limite máximo de tokens que podem existir. GOV tem cap **imutável** de 100M. CREDIT não tem cap hardcoded — sua inflação é controlada pelo `RewardDistributor` via `capMax` por rodada (ajustável via governança).

## Checkpoint (anti-flashloan)

Historiografia on-chain de pesos de staking por bloco. `Staking` escreve checkpoints em cada mudança; `RewardDistributor` lê no `snapshotBlock` da rodada (block.number de quando `finalizeRound` foi chamado). Impede que alguém stake no mesmo bloco de uma consulta para capturar share artificialmente.

## CLP (Credit Liquidity Protocol)

**Legado (superado pelo remodel 2026-07-08).** Pivot econômico de abril/2026 (parecer `audit/economist/2026-04-24-clp-pivot.md`). Reorganizava o protocolo em quatro fases:

- **1.1 — FFP buyback**: defesa de floor via swap real USDC→CREDIT + queima.
- **1.2 — POL**: liquidez própria do protocolo no pool CREDIT/USDC.
- **1.3 — LiquidityGauge**: incentiva LPs externos via bucket dedicado (25% emissão).
- **1.4 — Bucket-aware split**: `RewardDistributorV2` divide emissão em 4 buckets simultâneos.
- **3 (futuro)**: BondDepository — usuários trocam ETH/CREDIT por CREDIT vested.

## CREDIT

Token de pagamento ERC-20 do protocolo, **estável 1:1 com USDC** desde o remodel 2026-07-08. Supply elástico, mas lastreado: mintado quando alguém compra no [`CreditPSM`](../08-contracts-reference/15-CreditPSM.md) (`buy`), queimado quando resgata (`sell`). Usado para pagar dentro dos apps (via `FeeRouterV2.pay`) e para financiar rodadas no `ProjectFunding`. Não é deflacionário nem especulativo: é meio de pagamento. **Legado**: antes do remodel era cunhado como reward de emissão e queimado a cada pagamento. Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## CreditPSM

Peg Stability Module do remodel 2026-07-08. Converte USDC ↔ CREDIT a 1:1, sem taxa: `buy()` deposita USDC e minta CREDIT (6→18 decimais); `sell()` queima CREDIT e devolve USDC. Lastro 100% retido no contrato, **sem função de saque — nem para governança**. Ver [CreditPSM](../08-contracts-reference/15-CreditPSM.md).

## CreditPriceOracle

Adapter de produção do `ICreditPriceOracle` (`contracts/CreditPriceOracle.sol`). Deriva o TWAP do CREDIT em USD (18 decimais) da pool Uniswap V3 CREDIT/USDC e converte USDC → USD via feed Chainlink USDC/USD (staleness máxima 6h, banda de sanidade fixa `[9900, 10100]` bps). Endereços imutáveis, setados no constructor. É a fonte de preço do `Treasury` no FFP (`peekTwapPrice`).

## DAO (Decentralized Autonomous Organization)

Aqui se refere ao conjunto `CommunityGovernor` + `CommunityTimelock`, que juntos controlam **todos** os contratos econômicos do protocolo em produção.

## FFP (Floating com Floor Price)

Modelo de defesa de preço do CREDIT (Fase 1.1 CLP). Spot é livre acima do floor (lido do `CreditPriceOracle` em produção); quando spot < floor por >= 24h, governance pode propor `Treasury.executeBuyback(usdcAmount, minCreditOut)` que executa swap USDC→CREDIT via Uniswap V3 e **queima** o CREDIT comprado imediatamente. Floor calculado como `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)` — default `max(0.50 × MA90, $0.10)`. Caps por evento (20%) e mensal (30%) sobre reservas USDC do Treasury. Ver [Treasury](../08-contracts-reference/04-Treasury.md).

## FeeRouter

**Legado (pré-remodel 2026-07-08).** Contrato V1 que recebia pagamentos em CREDIT, dividia segundo `split` (default de produção 70% burn / 20% treasury / 10% rebate ao app) e distribuía cada fatia. Substituído pelo [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) — a taxa efetiva de ~80-90% pro app não competia com processadores de pagamento (parecer `audit/economist/2026-07-08-feerouter-bypass.md`). Ver [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

## FeeRouterV2

Trilho de pagamento do remodel 2026-07-08. `pay(projectId, amount)` cobra fee do protocolo de **2,5%** (250 bps; teto duro de 5% que nem governança ultrapassa), reparte a fee em 40% treasury / 40% buyback de GOV / 20% grants, desconta o rev-share do projeto (se houver rodada financiada) e transfere o resto (~89,5-97,5%) pro dono do app na hora. Acumula `grossVolumeOf[projectId]` (GMV on-chain). Ver [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

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

## ProjectFunding

Contrato de captação + redistribuição de receita do remodel 2026-07-08. Dono de projeto Active abre **uma** rodada (alvo em CREDIT, rev-share de 1-30%, prazo 1-90 dias). Investidores com GOV stakeado no projeto depositam CREDIT; all-or-nothing (bateu o alvo → dono recebe e rev-share ativa; venceu sem bater → refund integral). Receita distribuída pro-rata às shares via acumulador tipo MasterChef; `claim` exige GOV stakeado e nunca expira. Ver [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

## Probation

Duas noções distintas no `ProjectRegistry`:

- **Probation inicial por tempo**: janela automática aplicada a todo projeto recém-ativado, durante `probationDuration` (30 dias em produção). Stake e pagamentos funcionam normalmente, mas **share de rewards é dividido por 4** (25%). Detectada via `isInProbation(projectId)`.
- **Probation punitiva**: status do enum `Project.Status`. Governança move manualmente um projeto de `Active` para `Probation` por má conduta. Bloqueia stake novo e pagamentos, mas **nunca bloqueia unstake**.

## Proposal (proposta)

Objeto do Governor contendo `(targets, values, calldatas, descriptionHash)`. Passa por estados Pending → Active → Succeeded/Defeated → Queued → Executed (ou Canceled/Expired). Só executável via Timelock após todos os delays.

## polRefillBucket

Ledger interno do Treasury que acumula o bucket bonders do `RewardDistributorV2` (5% default da emissão por rodada). Drenado por `Treasury.addPOLFromRefill(creditAmount, usdcAmount, ...)` que casa CREDIT do ledger com USDC do balance livre para injeção no `polTokenId`. CEI: debita ledger antes de chamada externa (idempotência em revert). Segregado **on-chain**: saídas genéricas de CREDIT (`transfer`/`batchTransfer`/`payRebates`/`addPOL`) não podem invadir o ledger, depósitos exigem lastro em `balanceOf(CREDIT)`, e governança pode reciclá-lo via `writeDownPolRefillBucket`.

## Rebate

**Legado (pré-remodel 2026-07-08).** Fatia (default 10% em produção) de um pagamento em CREDIT que o FeeRouter V1 transferia ao `appRecipient` do projeto. No modelo vigente o app recebe direto do `FeeRouterV2` a parcela `toApp` (~89,5-97,5% do pagamento) — não é mais "rebate", é a receita do app.

## Recorder (RECORDER_ROLE)

**Legado (pré-remodel 2026-07-08).** Role no `BurnTracker` concedida a cada app listado (tipicamente ao `FeeRouter` V1). Autoriza chamada `burnAndRecord`. Concedida via proposta aprovada no Governor.

## Remodel 2026-07-08

Mudança de modelo econômico: de "burn-to-mint deflacionário" para "trilho de pagamento + funding por rev-share". Motivo: a taxa efetiva de ~80% pro app no modelo antigo não competia com Stripe/app stores — o bypass era estratégia dominante (equilíbrio de Nash no colapso; parecer `audit/economist/2026-07-08-feerouter-bypass.md`). Três contratos novos: [CreditPSM](../08-contracts-reference/15-CreditPSM.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) e [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). Os contratos do ciclo burn-to-mint continuam deployados por compatibilidade histórica.

## Rev-share

Fatia da **receita bruta** de um projeto (1% a 30%, em bps: 100-3000) prometida aos investidores da rodada de captação do `ProjectFunding`. Descontada automaticamente pelo `FeeRouterV2` a cada `pay` e distribuída pro-rata às shares. Só ativa após a rodada bater o alvo (`Funded`); `revShareBpsOf` retorna 0 caso contrário.

## Rodada de captação (funding round)

Rodada única por projeto no `ProjectFunding`: `openRound(alvo, revShareBps, prazo)` com alvo ≥ `minTarget`, rev-share 1-30% e prazo de 1 a 90 dias. All-or-nothing: `Funded` paga o dono e ativa o rev-share; prazo vencido sem alvo → `Failed` e refund integral. Não confundir com a rodada contabilística de burn (abaixo, legado).

## Round / Rodada (de burn)

**Legado (pré-remodel 2026-07-08).** Período de tempo contabilístico do ciclo burn-to-mint. Iniciado em `BurnTracker` (`currentRound`). Aberto indefinidamente até governança chamar `closeRound()`, que incrementa `currentRound` e reseta `roundStartedAt`. Duração alvo em produção: 7 dias (`roundDuration = 604800`).

## RewardDistributorV2

**Legado (pré-remodel 2026-07-08).** Versão bucket-aware do distributor de emissão (Fase 1.4 CLP). Re-deploy paralelo ao V1 — V1 fica em modo claim-only durante migração de 4 rounds. V2 divide a emissão em 4 buckets simultâneos: stakers (lazy), LPs (push gauge), apps (push retrospectivo via burn), bonders (push refill POL). No modelo vigente não há emissão como renda — ver [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). Ver [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md).

## Sanity cap

Limite máximo de burn por `(rodada, projectId)` no `BurnTracker`. Em produção `10_000_000e18` CREDIT. Previne ataque em que um projeto queima volume absurdo para capturar share desproporcional. Valor 0 = desativado (opt-out explícito por governança).

## Snapshot (de voto)

Bloco de referência para calcular voting power de uma proposta. `Governor` usa `getPastVotes(account, proposalSnapshot)`; `RewardDistributor` usa `getWeightAt(user, projectId, snapshotBlock)`. Ambos imunes a flash-loans que movam tokens no mesmo bloco.

## Split

Duas acepções:

- **Split da fee (vigente)**: repartição interna da fee de 2,5% no `FeeRouterV2` — `(treasuryBps, buybackBps, grantsBps)`, default 4000/4000/2000 (40% treasury / 40% buyback de GOV / 20% grants), soma exata 10_000 bps.
- **Split de pagamento (legado)**: configuração `(burnBps, treasuryBps, rebateBps)` no `FeeRouter` V1, default de produção 7000/2000/1000.

## Staking (direcionado)

Ato de lockar GOV em um `projectId` específico do Registry. Define peso = `amount * multiplier(lockDuration) / 1e18`. Desde o remodel 2026-07-08, o peso é o **gate de investimento**: `ProjectFunding.invest` e `claim` exigem `getWeight(investor, projectId) > 0`. (Legado: o peso também rateava a emissão de rewards.) Ver [Staking](../08-contracts-reference/05-Staking.md).

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
