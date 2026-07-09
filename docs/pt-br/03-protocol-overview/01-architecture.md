# Arquitetura: os 11 contratos e quem chama quem

**Para quem é:** dev, auditor e qualquer leitor que queira o mapa completo do sistema.
**Pré-requisitos:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md), idealmente [Trilho de pagamento](../02-core-concepts/03-payment-rail.md).

## Os 11 contratos de núcleo (+1 dev-only)

| # | Contrato | Papel | Roles/owner em produção |
|---|---|---|---|
| 1 | [`GovernanceToken`](../08-contracts-reference/01-GovernanceToken.md) (GOV) | Token de voto (ERC20Votes), cap imutável 100M | `owner` = Timelock |
| 2 | [`CreditToken`](../08-contracts-reference/02-CreditToken.md) (CREDIT) | Token de pagamento, supply elástico | `MINTER_ROLE`+`BURNER_ROLE` = PSM; admin = Timelock |
| 3 | [`ProjectRegistry`](../08-contracts-reference/04-ProjectRegistry.md) | Whitelist de projetos, status, colateral | `GOVERNANCE_ROLE`+admin = Timelock |
| 4 | [`Staking`](../08-contracts-reference/05-Staking.md) | Stake de GOV direcionado por projeto | sem roles (não privilegiado) |
| 5 | [`Treasury`](../08-contracts-reference/08-Treasury.md) | Cofre multi-ativo da DAO | `GOVERNANCE_ROLE`+admin = Timelock |
| 6 | [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) | Governor (propostas + contagem) | — (é a fonte das propostas) |
| 7 | [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md) | Executa decisões com delay | self-administered; portador do `GOVERNANCE_ROLE` |
| 8 | [`TeamVesting`](../08-contracts-reference/11-TeamVesting.md) | Vesting de GOV do time (cliff+linear) | `owner` = Timelock |
| 9 | [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md) | USDC ↔ CREDIT 1:1 | sem roles próprias (usa roles no CREDIT) |
| 10 | [`ProjectFunding`](../08-contracts-reference/07-ProjectFunding.md) | Captação + rev-share por projeto | `REVENUE_NOTIFIER_ROLE` = FeeRouterV2; gov+admin = Timelock |
| 11 | [`FeeRouterV2`](../08-contracts-reference/06-FeeRouterV2.md) | Trilho de pagamento (fee 2,5% + rev-share) | `GOVERNANCE_ROLE`+admin = Timelock |
| — | [`DevFaucet`](../08-contracts-reference/12-DevFaucet.md) | ETH + USDC mock em rede local | **não deployado em produção** |

Solidity 0.8.24 com `viaIR`, OpenZeppelin 5.0.2 pinado. Redes: hardhat local (31337) e Sepolia (11155111).

## Camadas

```
   Camada politica       CommunityGovernor  ->  CommunityTimelock
          |              (decide)              (executa com delay 2d)
          v
   Camada de estado      ProjectRegistry   Treasury   Staking   ProjectFunding
          |              (quem/o que)      (cofre)    (peso)    (rodadas)
          v
   Camada economica      CreditPSM    FeeRouterV2    GovernanceToken   CreditToken
                         (USDC<->CREDIT) (pay+split)  (GOV)             (CREDIT)
```

- **Política** decide *o que muda* — toda mudança passa por proposta + voto + delay.
- **Estado** guarda os fatos: donos de projeto, status, colateral, saldos da tesouraria, pesos de stake, shares e receita das rodadas.
- **Econômica** move valor: entrada/saída de dinheiro (PSM) e roteamento de pagamentos (FeeRouterV2).

## Quem chama quem (runtime)

Setas = "chama / lê em tempo de execução".

```
   usuario/app
      |
      |  buy/sell (USDC<->CREDIT)
      v
   CreditPSM  --mint/burnByRole-->  CreditToken (CREDIT)
      |                                  ^
      |                                  |  transferFrom/transfer de CREDIT
      |  (CREDIT em maos do usuario)     |
      v                                  |
   FeeRouterV2.pay(projectId, amount) ---+
      |   |   |
      |   |   +--> ProjectRegistry.isActive(projectId)     (gate: projeto Active?)
      |   |   +--> ProjectRegistry.getProject().owner       (fallback appRecipient)
      |   |
      |   +--> ProjectFunding.revShareBpsOf(projectId)      (quanto e rev-share?)
      |   +--> ProjectFunding.notifyRevenue(projectId, x)   (REVENUE_NOTIFIER_ROLE)
      |   +--> transfere: treasury / buyback / grants / appRecipient
      v
   PaymentRouted (evento)

   investidor
      |
      |  stake(projectId, GOV, lock)
      v
   Staking  --transferFrom GOV-->  GovernanceToken (GOV)
      |  ^
      |  |  getWeight(investor, projectId)   (gate de invest/claim)
      v  |
   ProjectFunding.invest / claim ------------+
      |  --lê--> Staking.getWeight
      |  --lê--> ProjectRegistry.getProject().owner   (paga o dono no Funded)
      v
   RoundFunded / RevenueClaimed (eventos)

   governanca
      |
      |  propose -> vote -> queue -> execute
      v
   CommunityGovernor --_queue/_execute--> CommunityTimelock
                                              |
                                              |  GOVERNANCE_ROLE / owner
                                              v
                          Treasury.transfer, Registry.activate/setStatus,
                          FeeRouterV2.setFeeBps/setFeeSplit/setRecipients,
                          ProjectFunding.setMinTarget,
                          GovernanceToken.mint, TeamVesting.*
```

## Dependências de construção (imutáveis)

Endereços fixados no constructor (não mudam pós-deploy):

- **CreditPSM** → `CREDIT`, `USDC`.
- **Staking** → `GOV_TOKEN`, `REGISTRY`.
- **ProjectFunding** → `CREDIT`, `REGISTRY`, `STAKING`.
- **FeeRouterV2** → `CREDIT`, `REGISTRY`, `FUNDING`.
- **CommunityGovernor** → `token` (GOV), `timelock`, `treasury` (para o scan de supermajoridade).

Cada dependência é uma seta permanente. Note que `Staking` não conhece `ProjectFunding` (é o funding que lê o staking) e o `CreditPSM` é independente do funding e do router — só toca `CREDIT` e `USDC`.

## O que os contratos econômicos NÃO fazem

Por design, a superfície é minimalista:

- **Treasury** é um cofre simples: só `transfer`/`transferETH` (`GOVERNANCE_ROLE`). **Sem POL, sem oracle, sem buyback interno.** A execução de buyback é decisão de governança usando fundos do cofre.
- **CreditPSM** não tem função de saque do lastro — nem para governança.
- **Staking** não é privilegiado: nenhuma role, todo gating é lógica de negócio (ownership da posição, status do projeto, expiração do lock).
- **FeeRouterV2** não queima nem emite CREDIT — só roteia. A única queima do protocolo é o `sell()` do PSM.

## Fiação de roles no deploy

O módulo Ignition (`ignition/modules/Dao.ts`) faz o wiring em fases:

1. **Deploy** dos 11 contratos (sem genesis de CREDIT — todo CREDIT nasce no PSM).
2. **Roles operacionais**: `MINTER_ROLE`+`BURNER_ROLE` do CREDIT → PSM; `REVENUE_NOTIFIER_ROLE` do ProjectFunding → FeeRouterV2; `PROPOSER`+`CANCELLER` do Timelock → Governor.
3. **Roles de governança**: `GOVERNANCE_ROLE`+`DEFAULT_ADMIN_ROLE` de Registry/Treasury/Funding/FeeRouterV2 → Timelock; `owner` do GOV → Timelock.
4. **Renúncia** do deployer a todas as roles restantes.

Após a fase 4, o Timelock é a única autoridade — e ele só age por proposta aprovada.

---

**Próximo →** [Fluxo de valor](03-economic-flows.md)
