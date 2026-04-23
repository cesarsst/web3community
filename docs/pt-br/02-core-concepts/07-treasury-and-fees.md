# Treasury e fees

**Para quem é:** quem quer entender o fluxo de caixa do protocolo.
**Pré-requisitos:** [Dual-token](01-dual-token-economy.md), [Governança](05-governance.md).

## O cofre da DAO

O `Treasury` é o cofre multi-ativo central. Três propriedades fundamentais:

1. **Recebe passivamente**. Não há função `deposit`. Qualquer um transfere ERC-20 (ou ETH via `receive`) direto para o endereço do Treasury.
2. **Só libera via governança**. Todas as funções de saída (`transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH`) exigem `GOVERNANCE_ROLE`.
3. **Sem pause**. Deliberadamente não há função para congelar saídas. Qualquer poder unilateral de congelar a tesouraria seria vetor de captura.

O Treasury recebe:

- **Genesis mint de CREDIT** (10M em produção). Essa é a única entrada "programática"; subsequente é por transferência explícita.
- **Fatia de `treasuryBps`** do split do `FeeRouter` (default 0 em produção, mas ajustável via governança).
- **Colateral de slash** de projetos removidos com `slash == true`.
- **Subsídios devolvidos** quando uma campanha do `UserSubsidy` é fechada com sobra.
- **Qualquer doação / buyback / fee de app** que a DAO decidir aceitar.

## O que a DAO faz com o Treasury

Operações típicas, todas via proposta:

- **Pagar rebates a apps** (`payRebates(token, apps[], amounts[], round)`) — batch transfer com evento `RebatesPaid` para rastreabilidade.
- **Patrocinar campanhas de `UserSubsidy`** — transferir CREDIT para o contrato de subsídio antes de `createCampaign`.
- **Fundar `TeamVesting`** — transferir GOV para uma instância de vesting que depois libera ao beneficiário.
- **Buyback de GOV com stable** — `executeBuyback` (stub v1 — só emite evento; integração DEX virá em fase posterior).
- **Financiar operações off-chain** (marketing, auditorias, etc.) — `transfer` para um multisig operacional.

## Fees — o FeeRouter

Interface **única** de pagamento entre usuários e apps. Função principal:

```solidity
function pay(uint256 projectId, address user, uint256 amount)
    external returns (uint256 burned, uint256 toTreasury, uint256 toApp);
```

O `user` precisa ter dado `approve(feeRouter, amount)` em CREDIT **antes**. `msg.sender` é quem iniciou a tx — pode ser o próprio user, o app, um relayer, uma smart wallet.

## Split padrão — 95 / 0 / 5

Em produção (`ignition/parameters/production.json`):

```
burnBps     = 9500   (95% queimado via BurnTracker)
treasuryBps = 0      (nada para o Treasury no default)
rebateBps   = 500    (5% para o appRecipient)
```

A soma tem que ser exatamente 10_000 (`_BPS_DENOMINATOR`). Splits diferentes são rejeitados com `InvalidSplit`.

Decisão de design: 0% para treasury no default **para não erodir o incentivo ao burn**. O Treasury recebe receita por outras vias (genesis já cunhado, slash, doações, buyback gerenciado). Se no futuro a DAO quiser capturar parte direta, basta propor `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})` — a arquitetura permite.

### Consequência estrutural — Treasury sem receita recorrente no default

Com `treasuryBps = 0` em produção, o Treasury **não acumula receita operacional automática**. As entradas recorrentes são apenas:

- Slash de colateral de projetos removidos com `slash == true` (eventual, depende de má conduta).
- Sobras de campanhas `UserSubsidy.closeCampaign` (eventual, depende de campanhas existirem).
- Doações externas e ETH enviados direto ao endereço.

Todas essas são **eventuais**, não recorrentes. Consequências:

1. `executeBuyback` é **stub v1** (não executa swap — ver seção "Buyback — stub v1" abaixo) e, mesmo depois de integrado a uma DEX, precisará de stables/CREDIT no Treasury para ter lastro. Sem fonte recorrente, qualquer buyback operacional depende de doações externas ou de uma mudança de split ativa.
2. Pagamentos recorrentes (rebates retroativos, fundo de emergência, pagamento de auditorias/operação) dependem do genesis (10M CREDIT) ou de novas propostas mintando GOV para venda.

**Para ativar tesouraria com cash flow recorrente antes de habilitar buyback real em mainnet, a DAO precisa aprovar uma proposta `setDefaultSplit` que eleve `treasuryBps > 0`.** Valor concreto a ser decidido pela DAO; `(9000, 500, 500)` (9% burn / 5% treasury / 5% rebate, todos em bps/10000) é uma calibração razoável que preserva o incentivo deflacionário e o incentivo do app, mas só a DAO decide. Essa proposta é **pré-requisito** para qualquer programa de buyback sustentável e está listada como dependência pré-mainnet no README §7.

## Override por projeto

Alguns projetos podem negociar splits diferentes via proposta:

```solidity
feeRouter.setProjectSplit(projectId, Split({burnBps, treasuryBps, rebateBps}));
```

A flag `hasProjectSplit[projectId]` sinaliza que existe override. `clearProjectSplit` remove.

Uso típico: um app de alto volume que aceitaria taxa efetiva maior (porque tem outra fonte de receita) pode negociar `8000/1500/500` (15% treasury), financiando mais agressivamente o cofre.

## Recipient do rebate

Por default, o rebate vai para `ProjectRegistry.getProject(projectId).owner`. Se o owner transfere o projeto, o destino muda automaticamente — **lookup dinâmico**.

O owner atual pode setar um endereço explícito via:

```solidity
feeRouter.setAppRecipient(projectId, recipient);
```

Útil quando o owner é um multisig e o rebate deve cair numa wallet operacional separada. Passar `address(0)` reseta para lookup dinâmico.

**Não é governance-gated** — é owner-gated. Rotação operacional de caixa não precisa de proposta.

## Dust handling

Em splits com divisão não-exata:

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- residuo vai aqui
```

Em vez de arredondar separadamente cada parcela (perde wei), o `toApp` captura o residuo. Consequência: o app pode receber 1-2 wei a mais que o calculado nominal. Aceitável e auditável.

## Fluxo completo de um pagamento

```
user tem 1000 CREDIT                FeeRouter
user chama approve(feeRouter, 1000) --- allowance OK
user chama pay(projectId, user, 1000)
                                      |
                                      v
                      Check: projectId esta Active
                      Check: user != 0, amount > 0
                                      |
                                      v
                      transferFrom(user, this, 1000)
                      FeeRouter tem 1000 CREDIT
                                      |
                                      | split = 9500/0/500
                                      v
                        burned = 950, toTreasury = 0, toApp = 50
                                      |
          +---------------------------+----------------------------+
          |                           |                            |
          v                           v                            v
   approve(tracker, 950)       (sem transfer ao            transfer(appRecipient, 50)
   tracker.burnAndRecord       Treasury nesse split)
                                                              appRecipient eh
                                                              projectOwner por default
                                      |
   tracker chama                      |
   credit.burnByRole(router, 950)    |
                                      |
   CREDIT.totalSupply -= 950          |
   burnByRoundProject[R][pid] += 950  |
   totalBurnByRound[R] += 950         |
                                      v
                              Paid event emitted
```

Após a tx: **FeeRouter tem 0 CREDIT**. Ele nunca custodia entre chamadas. Cada `pay` é atômico.

## Saídas de ETH

O Treasury aceita ETH via `receive` e pode sacar via `sweepETH(to, amount)`. Usa `call{value}` (não `transfer`/`send`) para compatibilidade com destinos que são contratos com `receive` pesado. Se o destino rejeitar, reverte com `ETHTransferFailed`.

O uso é de **cortesia** — o protocolo opera primariamente em ERC-20 (CREDIT, GOV, stables). ETH é aceito para não deixar doações travadas mas não é o fluxo principal.

## Buyback — stub v1

`executeBuyback(stable, amountIn, minGovOut, swapData)` no v1 **não executa swap**. Apenas emite `BuybackRequested`. A razão: modelagem adequada de slippage, TWAP e resistência a frontrunning exige decisão cuidadosa entre DEX (Uniswap v3 vs Balancer) e vai em fase separada.

Enquanto isso, a DAO pode aprovar a intenção on-chain. Workers off-chain observam o evento e processam manualmente (ou via contrato de integração futuro).

## Resumo

| Componente | Função | Gatekeeping |
|---|---|---|
| Treasury | Custódia multi-ativo | `GOVERNANCE_ROLE` nas saídas |
| FeeRouter | Interface de pagamento | `GOVERNANCE_ROLE` nos setters, público no `pay` |
| Split default | 95% burn / 0% treasury / 5% rebate | Ajustável por proposta |
| Split por projeto | Override via `setProjectSplit` | `GOVERNANCE_ROLE` |
| Recipient do rebate | Owner do projeto (dinâmico) ou explícito | Owner do projeto (setter) |
| Buyback | Stub — só evento no v1 | `GOVERNANCE_ROLE` |

---

**Próximo →** [Arquitetura](../03-protocol-overview/01-architecture.md)
