# Parâmetros ajustáveis pela DAO

**Para quem é:** quem quer saber exatamente o que a DAO pode mudar e quais são as faixas permitidas on-chain.
**Pré-requisitos:** [Ciclo de uma proposta](01-proposal-lifecycle.md).

Esta página lista **todos** os parâmetros ajustáveis via governança nos contratos de produção: o valor vigente, o bound on-chain (que nem a governança ultrapassa) e a função usada para alterar. Os valores citados vêm do código — constants nos `.sol` e defaults do `ignition/modules/Dao.ts`.

## FeeRouterV2 — o trilho de pagamento

Setters `onlyRole(GOVERNANCE_ROLE)` (Timelock em produção), exceto `setAppRecipient` (owner do projeto).

| Parâmetro | Valor vigente | Bound on-chain | Função |
|---|---|---|---|
| `feeBps` | `250` (2,5%) | teto duro `FEE_BPS_CAP = 500` (5%) — `FeeAboveCap` acima | `setFeeBps(newFeeBps)` |
| `feeSplit` | `4000/4000/2000` (treasury/buyback/grants) | soma **exata** de 10.000 bps — `SplitDoesNotSumTo10000` | `setFeeSplit({treasuryBps, buybackBps, grantsBps})` |
| recipients | treasury/buyback/grants (dev: os 3 = Treasury) | nenhum pode ser `address(0)` | `setRecipients(treasury, buyback, grants)` |
| `appRecipientOf[id]` | fallback = owner do projeto | não pode ser `address(0)` | `setAppRecipient(projectId, recipient)` *(owner-gated)* |

O teto de 5% é o guardrail mais importante do router: **nem a governança consegue tornar o protocolo caro**. Os eventos `PaymentRouted` carregam o detalhamento por parcela mesmo quando os três recipients apontam para o mesmo endereço (transparência contábil on-chain).

## ProjectFunding — captação e rev-share

Setter `onlyRole(GOVERNANCE_ROLE)`. As faixas de rodada são **constants imutáveis** — não ajustáveis nem por governança.

| Parâmetro | Valor vigente | Ajustável? | Função |
|---|---|---|---|
| `minTarget` | `100e18` CREDIT | Sim (governança) | `setMinTarget(newMin)` |
| `MIN_REV_SHARE_BPS` | `100` (1%) | Não — constant | — |
| `MAX_REV_SHARE_BPS` | `3000` (30%) | Não — constant | — |
| `MIN_ROUND_DURATION` | `1 days` | Não — constant | — |
| `MAX_ROUND_DURATION` | `90 days` | Não — constant | — |

## ProjectRegistry — whitelist de projetos

Setters `onlyRole(GOVERNANCE_ROLE)`. O ciclo de vida do projeto (register/activate/probation/remove) também é governança — ver [Submeter um projeto](../05-for-developers/03-submitting-a-project.md).

| Parâmetro | Valor vigente | Bound | Função |
|---|---|---|---|
| `minCollateral` | prod: `10_000e18` GOV (dev: `1_000e18`) | `> 0` — `ZeroAmount` | `setMinCollateral(newMin)` |
| `probationDuration` | prod: `30 dias` (dev: `1 dia`) | `> 0` — `ZeroAmount` | `setProbationDuration(newDuration)` |
| `OWNER_RECIPIENT_TIMELOCK` | `48 horas` | Não — constant | — |

Ambos afetam **só registros/ativações futuras** — projetos existentes não são retroativamente alterados.

## Treasury — o cofre

Sem parâmetros de configuração. As saídas de fundos são as únicas operações governáveis, ambas `onlyRole(GOVERNANCE_ROLE)`:

| Função | O que faz |
|---|---|
| `transfer(token, to, amount)` | saída de ERC-20 (inclui execução de buyback de GOV) |
| `transferETH(to, amount)` | saída de ETH |

> **Atenção — supermaioria (75%).** Alterar quem detém roles no Treasury (`grantRole`/`revokeRole`/`renounceRole`) muda quem pode esvaziar o cofre. Qualquer proposta com essas chamadas no Treasury **ou no próprio Timelock** é classificada como `Supermajority` e exige `For >= 75%`. Ver [Ciclo de uma proposta](01-proposal-lifecycle.md#supermaioria-para-gestão-de-roles).

## CreditPSM — sem parâmetros

O PSM é **imutável por design**: sem owner, sem roles próprias, sem setters. Conversão 1:1, sem taxa, lastro sem função de saque. Para mudar qualquer coisa, deploya-se outro PSM e a governança migra as roles de mint/burn no CreditToken.

## GovernanceToken — só mint até o cap

Owner em produção = Timelock. Não há setter de parâmetro — `CAP_SUPPLY` é imutável.

| Função | O que faz | Bound |
|---|---|---|
| `mint(to, amount, tag)` | cunha GOV até o cap | `CapExceeded` se supply pós-mint > 100M |

## CommunityGovernor — parâmetros da própria governança

Setters `onlyGovernance` (só via proposta + Timelock). Valores em **blocos** (o clock é `block.number`).

| Parâmetro | Produção | Dev | Função |
|---|---|---|---|
| `votingDelay` | `7200` (~1 dia) | `1` bloco | `setVotingDelay(newDelay)` |
| `votingPeriod` | `50400` (~7 dias) | `50` blocos | `setVotingPeriod(newPeriod)` |
| `proposalThreshold` | `10_000e18` GOV | idem | `setProposalThreshold(newThreshold)` |
| quorum | `4%` | `4%` | `updateQuorumNumerator(newNumerator)` |

O `name` do Governor (`"CommunityGovernor"`) **não** é um parâmetro — trava o domain separator EIP-712 e nunca deve ser alterado (invalidaria assinaturas de voto por sig).

## CommunityTimelock — o delay

| Parâmetro | Produção | Dev |
|---|---|---|
| `minDelay` | `172800s` (2 dias) | `3600s` (1 hora) |

Ajustável via `updateDelay`, que é `onlyRole(DEFAULT_ADMIN_ROLE)` — em produção o próprio Timelock (self-administered), ou seja, só muda por proposta aprovada. A regra de supermaioria de 75% cobre a gestão de roles do Timelock.

## Resumo dos guardrails imutáveis

Estes limites **nenhuma** proposta ultrapassa:

- Fee ≤ 5% (`FEE_BPS_CAP`).
- Supply de GOV ≤ 100M (`CAP_SUPPLY`).
- Rev-share de rodada entre 1% e 30%; duração entre 1 e 90 dias.
- Lastro do PSM sem função de saque.
- Split da fee sempre soma 10.000 bps.

---

**Próximo →** [Referência de contratos](../08-contracts-reference/)
