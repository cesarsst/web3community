# Glossário

**Para quem é:** qualquer leitor que bata em um termo estranho em outra página.
**Pré-requisitos:** nenhum.

Termos usados nas outras páginas. Definições baseadas no código, não em convenção externa.

## AppRecipient

Endereço que recebe a parcela `toApp` de cada pagamento processado pelo [`FeeRouterV2`](../08-contracts-reference/06-FeeRouterV2.md). Configurável pelo dono do projeto via `setAppRecipient(projectId, recipient)`; fallback é o owner do projeto no Registry.

## Backing (lastro)

USDC retido no [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md) que garante o resgate 1:1 de todo CREDIT mintado por ele. Verificável on-chain via `backing()` (6 decimais) e `backingNormalized()` (18 decimais). Não existe função de saque do lastro — nem para governança.

## Buyback (de GOV)

Mecanismo de captura de valor do GOV: 40% da fee do protocolo (1% do GMV com os parâmetros default) é encaminhada ao `buybackRecipient` do FeeRouterV2 para financiar recompra de GOV no mercado, executada por governança. A automação do buyback ainda não está implementada — os fundos acumulam no recipient até a DAO executar (ver [Value accrual](../06-for-investors/02-value-accrual.md)).

## Cap (de supply)

Limite máximo de tokens que podem existir. GOV tem cap **imutável** de 100M. CREDIT não tem cap hardcoded — seu supply cresce e encolhe com o `buy`/`sell` do PSM, sempre 1:1 com o lastro em USDC.

## Checkpoint (anti-flashloan)

Historiografia on-chain de pesos de staking por bloco. [`Staking`](../08-contracts-reference/05-Staking.md) escreve checkpoints (`Checkpoints.Trace208`) em cada mudança; views `getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` leem em bloco passado. Impede que alguém mova tokens no mesmo bloco de uma consulta para manipular peso ou voto.

## Claim (de rev-share)

Saque, pelo investidor, da receita acumulada de um projeto no [`ProjectFunding`](../08-contracts-reference/07-ProjectFunding.md) via `claim(projectId)`. Exige GOV ainda stakeado no projeto; o valor **nunca expira** — sem stake ele apenas fica retido até re-stake.

## CREDIT

Token de pagamento ERC-20 do protocolo, **estável 1:1 com USDC**. Supply elástico, mas lastreado: mintado quando alguém compra no [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md) (`buy`), queimado quando resgata (`sell`). Usado para pagar dentro dos apps (via `FeeRouterV2.pay`) e para financiar rodadas no `ProjectFunding`. Não é deflacionário nem especulativo: é meio de pagamento. Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## CreditPSM

Peg Stability Module. Converte USDC ↔ CREDIT a 1:1, sem taxa: `buy()` deposita USDC e minta CREDIT (6→18 decimais); `sell()` queima CREDIT e devolve USDC. Lastro 100% retido no contrato, **sem função de saque — nem para governança**. Ver [CreditPSM](../08-contracts-reference/03-CreditPSM.md).

## DAO (Decentralized Autonomous Organization)

Aqui se refere ao conjunto `CommunityGovernor` + `CommunityTimelock`, que juntos controlam **todos** os contratos econômicos do protocolo em produção.

## DevFaucet

Contrato exclusivo de **rede local** (`contracts/dev/DevFaucet.sol`): entrega ETH (gas) + USDC mock para carteiras de teste, com cooldown por destinatário. CREDIT não sai do faucet de propósito — compra-se 1:1 no PSM com o USDC recebido, preservando o lastro integral. **Não é deployado em produção.** Ver [DevFaucet](../08-contracts-reference/12-DevFaucet.md).

## Fee do protocolo

Percentual de cada pagamento cobrado pelo [`FeeRouterV2`](../08-contracts-reference/06-FeeRouterV2.md): default **2,5%** (250 bps), com teto duro `FEE_BPS_CAP = 500` (5%) que nem governança ultrapassa. Repartida em 40% treasury / 40% buyback de GOV / 20% grants (split ajustável via governança, soma exata 10.000 bps).

## FeeRouterV2

Trilho de pagamento do protocolo. `pay(projectId, amount)` cobra a fee de 2,5%, desconta o rev-share do projeto (se houver rodada financiada) e transfere o resto (~89,5–97,5%) pro `appRecipient` na hora. Acumula `grossVolumeOf[projectId]` (GMV on-chain). Ver [FeeRouterV2](../08-contracts-reference/06-FeeRouterV2.md).

## Genesis mint

Capacidade one-shot do `CreditToken` (`mintGenesis(to, amount)`, flag `genesisMinted`). Existe por flexibilidade de deploy; no modelo vigente **a via canônica de emissão de CREDIT é o PSM** — todo CREDIT circulante deve nascer de `buy()` para preservar o lastro 1:1.

## GMV (Gross Merchandise Volume)

Volume bruto de pagamentos processados. On-chain por projeto em `FeeRouterV2.grossVolumeOf[projectId]`. Métrica central para avaliar rodadas de investimento.

## GOV

Token de governança ERC-20 com extensão `ERC20Votes`. Supply cap imutável de 100M. Usado para votar (via `getPastVotes`), como colateral de projetos no Registry e como stake direcionado (gate de investimento). Ver [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md).

## GOVERNANCE_ROLE

Role AccessControl concedida em produção **apenas** ao `CommunityTimelock`. Gate em todas as funções governança-sensíveis dos contratos econômicos (Treasury, ProjectRegistry, FeeRouterV2, ProjectFunding).

## Grants

20% da fee do protocolo (0,5% do GMV com os defaults), encaminhados ao `grantsRecipient` do FeeRouterV2 para financiar novos apps e iniciativas da comunidade, sob decisão da governança.

## Lock (de staking)

Tempo (em segundos) durante o qual uma posição de stake não pode ser desfeita. Mínimo `MIN_LOCK = 14 dias`; qualquer duração acima é aceita, mas o multiplier satura em 4x a partir de `MAX_LOCK = 365 dias`.

## Multiplier (de staking)

Fator aplicado ao `amount` para calcular peso. Linear de 1x (14 dias) a 4x (365 dias), satura em 4x acima. Definido em `Staking.multiplier(lockDuration)`.

## PaymentRouted

Evento emitido pelo `FeeRouterV2` a cada `pay`, com detalhamento completo: `(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)`. É a fonte de verdade para verificação server-side de pagamentos (usada pelo SDK em `verifyActivationPayment`).

## ProjectFunding

Contrato de captação + redistribuição de receita. Dono de projeto Active abre **uma** rodada (alvo em CREDIT, rev-share de 1–30%, prazo 1–90 dias). Investidores com GOV stakeado no projeto depositam CREDIT; all-or-nothing (bateu o alvo → dono recebe e rev-share ativa; venceu sem bater → refund integral). Receita distribuída pro-rata às shares via acumulador tipo MasterChef; `claim` exige GOV stakeado e nunca expira. Ver [ProjectFunding](../08-contracts-reference/07-ProjectFunding.md).

## Probation

Duas noções distintas no `ProjectRegistry`:

- **Probation inicial por tempo**: janela automática aplicada a todo projeto recém-ativado, durante `probationDuration` (30 dias em produção). Sinaliza on-chain (via `isInProbation`) que o projeto é novo. Stake e pagamentos funcionam normalmente.
- **Probation punitiva**: status do enum `Project.Status`. Governança move manualmente um projeto de `Active` para `Probation` por má conduta. Bloqueia stake novo e pagamentos, mas **nunca bloqueia unstake**.

## Proposal (proposta)

Objeto do Governor contendo `(targets, values, calldatas, descriptionHash)`. Passa por estados Pending → Active → Succeeded/Defeated → Queued → Executed (ou Canceled/Expired). Só executável via Timelock após todos os delays.

## PSM (Peg Stability Module)

Ver [CreditPSM](#creditpsm).

## Refund

Devolução de 100% do CREDIT investido numa rodada do `ProjectFunding` que venceu o prazo sem bater o alvo (`Failed`). Chamada pelo próprio investidor via `refund(projectId)`.

## Rev-share

Fatia da **receita bruta** de um projeto (1% a 30%, em bps: 100–3000) prometida aos investidores da rodada de captação do `ProjectFunding`. Descontada automaticamente pelo `FeeRouterV2` a cada `pay` e distribuída pro-rata às shares. Só ativa após a rodada bater o alvo (`Funded`); `revShareBpsOf` retorna 0 caso contrário.

## Rodada de captação (funding round)

Rodada única por projeto no `ProjectFunding`: `openRound(alvo, revShareBps, prazo)` com alvo ≥ `minTarget` (default 100 CREDIT), rev-share 1–30% e prazo de 1 a 90 dias. All-or-nothing: `Funded` paga o dono e ativa o rev-share; prazo vencido sem alvo → `Failed` e refund integral.

## Shares (de rodada)

Unidades de participação numa rodada do `ProjectFunding`. `shares = CREDIT investido` (1:1, imutável após a rodada ser financiada). Determinam a fatia pro-rata do rev-share.

## Snapshot (de voto)

Bloco de referência para calcular voting power de uma proposta. `Governor` usa `getPastVotes(account, proposalSnapshot)` — imune a flash-loans que movam tokens no mesmo bloco.

## Split da fee

Repartição interna da fee do protocolo no `FeeRouterV2` — `(treasuryBps, buybackBps, grantsBps)`, default 4000/4000/2000 (40% treasury / 40% buyback de GOV / 20% grants), soma exata 10.000 bps. Ajustável via governança.

## Staking (direcionado)

Ato de lockar GOV em um `projectId` específico do Registry. Define peso = `amount * multiplier(lockDuration) / 1e18`. O peso é o **gate de investimento**: `ProjectFunding.invest` e `claim` exigem `getWeight(investor, projectId) > 0`. Ver [Staking](../08-contracts-reference/05-Staking.md).

## Timelock

Contrato que executa decisões do Governor com atraso mínimo (`minDelay`, em produção 2 dias). `CommunityTimelock` é subclasse trivial do `TimelockController` da OpenZeppelin. Único portador de `GOVERNANCE_ROLE` em produção.

## Treasury

Cofre multi-ativo da DAO. Recebe passivamente (transferências ERC-20 diretas + a fatia treasury da fee) e só libera fundos via `transfer`/`transferETH`, ambas `onlyRole(GOVERNANCE_ROLE)`. Ver [Treasury](../08-contracts-reference/08-Treasury.md).

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
