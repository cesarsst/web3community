# Riscos e segurança

**Para quem é:** quem vai se expor ao protocolo e quer a lista honesta dos riscos.
**Pré-requisitos:** [Value accrual](02-value-accrual.md).

Esta página não vende. Ela lista os riscos reais, o que os mitiga on-chain e o que **ainda bloqueia** o mainnet. Nenhum protocolo é sem risco; o objetivo é que você conheça os seus antes de qualquer exposição.

## Riscos econômicos

### Risco de receita do app (o principal)

Uma posição de rev-share paga uma fatia da **receita real** do app. Se o app não vende, você não recebe.

- Não há retorno garantido. `pendingRevenue` só cresce quando há `FeeRouterV2.pay` no projeto.
- O rev-share é **por app específico**, não pela rede. Financiar um app que não engaja é o risco mais concreto e mais comum.
- **Mitigação parcial (all-or-nothing):** a rodada só paga o owner se bater o alvo. Se falhar, você saca 100% via `refund`. Isso protege contra financiar pela metade um projeto que nem decolou — mas **não** protege contra um app financiado que depois não fatura.

Este é o risco que você **assume conscientemente** ao investir: é participação em receita, não renda fixa.

### Risco de peg / lastro do PSM

O CREDIT vale 1 USDC porque o [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md) guarda 1 USDC para cada CREDIT que mintou.

- **Mitigação forte:** não existe função de saque do lastro — **nem para governança** (invariante I-PSM1). O USDC é segregado no próprio PSM, fora do Treasury. Verificável a qualquer momento em `backing()` vs `mintedOutstanding`.
- **Risco residual:** o peg depende da **solvência do próprio USDC**. Se o USDC de lastro perder o peg, o CREDIT herda esse risco — é um risco do ativo de reserva, externo ao protocolo, não do PSM.

### Risco de valorização do GOV

A tese do GOV é buyback proporcional ao GMV sobre supply fixo. Se o GMV agregado for baixo, o buyback é pequeno e a demanda estrutural não se materializa. O GOV pode não valorizar se os apps não gerarem volume. Além disso, o buyback **não é automático** — sua execução depende de a governança agir (ver [Value accrual](02-value-accrual.md)).

## Risco regulatório (BLOQUEADOR de mainnet)

Uma posição de rev-share — "pague X, receba uma fatia da receita futura de um empreendimento tocado por terceiros" — tem forte semelhança econômica com um **valor mobiliário (security)** em várias jurisdições.

> **Este é um bloqueador declarado e explícito de mainnet.** O deploy em mainnet depende de **parecer jurídico** sobre o enquadramento do rev-share. Enquanto esse parecer não existir, o protocolo permanece em rede local (31337) e Sepolia (11155111). Não é uma pendência menor — é condição para ir a produção, ao lado da auditoria externa.

Não trate as rodadas de rev-share como um produto de investimento aprovado. Elas não são, hoje, oferecidas em mainnet exatamente por causa disso.

## Superfície técnica

O protocolo é composto de **11 contratos de núcleo** (Solidity 0.8.24, OpenZeppelin 5.0.2 pinado, `viaIR`). Quanto menor a superfície, menor o risco — o remodel 2026-07-08 removeu contratos econômicos complexos e concentrou o trilho em três peças: PSM, FeeRouterV2 e ProjectFunding.

### Invariantes que sustentam a segurança

O que estas invariantes garantem é que classes inteiras de ataque econômico não são possíveis por construção:

- **Lastro integral do PSM, sem saque (I-PSM1).** `USDC.balanceOf(PSM) >= mintedOutstanding` sempre. Não há qualquer função — nem governança — que retire o lastro. A DAO gasta da fee, nunca do lastro.

- **Conservação no `pay`.** Cada pagamento reparte `amount` exatamente em `fee + revShare + toApp`, sem sobra nem criação de valor. A fee tem **teto duro** `FEE_BPS_CAP = 500` (5%): nem a governança consegue subir a fee acima disso.

- **All-or-nothing no funding.** Uma rodada só transfere capital ao owner se `raised == target`. Falha → `refund` integral. O investidor nunca financia parcialmente um projeto que não atingiu a meta.

- **Gate de GOV stakeado.** Investir e sacar rev-share exigem `Staking.getWeight(investor, projectId) > 0`. Impede investimento sem skin in the game e alinha investidor e projeto.

### Modelo de roles

O poder é minimizado e concentrado no Timelock (ver [Modelo de segurança](../09-advanced/03-security-model.md)):

- `MINTER_ROLE` / `BURNER_ROLE` do CREDIT: **só o PSM**. Nenhum outro contrato minta ou queima CREDIT.
- `REVENUE_NOTIFIER_ROLE` do ProjectFunding: **só o FeeRouterV2**. Só o router contabiliza receita.
- `GOVERNANCE_ROLE` dos contratos econômicos (Treasury, Registry, FeeRouterV2, ProjectFunding): **só o CommunityTimelock** em produção. Toda mudança de parâmetro passa por proposta + voto + delay.
- Gestão de roles no Treasury/Timelock exige **supermaioria de 75%** — barreira anti-captura do cofre.

### Qualidade

- 872 testes passando; slither sem findings high/medium.
- Contratos imutáveis pós-deploy, exceto pelos parâmetros ajustáveis via governança (listados em [Parâmetros](../07-governance/03-parameters.md)).

## O que ainda falta para mainnet

Dois bloqueadores explícitos, ambos necessários:

1. **Auditoria externa** dos contratos.
2. **Parecer jurídico** sobre o enquadramento do rev-share (risco regulatório acima).

Até lá, toda exposição é em testnet/local. Considere isso ao avaliar qualquer participação.

---

**Próximo →** [Métricas que importam](04-metrics-that-matter.md)
