# Modelo de segurança

**Para quem é:** auditor, dev avançado ou investidor técnico que quer o mapa de confiança do protocolo.
**Pré-requisitos:** ter lido os contratos em `contracts/*.sol`; [Riscos e segurança](../06-for-investors/03-risk-and-security.md).

O modelo de segurança se apoia em três pilares: **roles minimizadas** (cada poder concentrado no menor lugar possível), **invariantes** (classes de ataque impossíveis por construção) e **governança via Timelock** com anti-captura por supermaioria.

## Mapa de roles

O princípio é: cada capacidade sensível pertence a **um único** detentor, e esse detentor é o mais restrito possível.

| Role | Detentor em produção | Poder |
|---|---|---|
| `MINTER_ROLE` (CREDIT) | **só o `CreditPSM`** | mintar CREDIT (só contra USDC depositado) |
| `BURNER_ROLE` (CREDIT) | **só o `CreditPSM`** | queimar CREDIT (só o próprio saldo, no `sell`) |
| `REVENUE_NOTIFIER_ROLE` (ProjectFunding) | **só o `FeeRouterV2`** | contabilizar rev-share de um pagamento |
| `GOVERNANCE_ROLE` (Treasury, Registry, FeeRouterV2, ProjectFunding) | **só o `CommunityTimelock`** | ajustar parâmetros, mover fundos, gerir projetos |
| `PROPOSER_ROLE` / `CANCELLER_ROLE` (Timelock) | **só o `CommunityGovernor`** | enfileirar / cancelar operações aprovadas |
| `EXECUTOR_ROLE` (Timelock) | `address(0)` (público pós-delay) | executar operação já vencida |
| `DEFAULT_ADMIN_ROLE` (contratos econômicos) | **só o `CommunityTimelock`** | gerir roles (padrão OZ) |

Consequências desse desenho:

- **Só o PSM cria ou destrói CREDIT.** Nenhum outro contrato — nem a governança — minta CREDIT. Isso é o que sustenta o lastro integral: CREDIT só nasce contra USDC.
- **Só o FeeRouterV2 notifica receita.** O `ProjectFunding.notifyRevenue` é gated por `REVENUE_NOTIFIER_ROLE`; ninguém pode inflar artificialmente o acumulador de rev-share.
- **Nenhuma EOA tem poder unilateral** sobre os contratos econômicos após o bootstrap. O deployer transfere tudo ao Timelock e renuncia às próprias roles.

## Invariantes

O que uma invariante garante: um estado que **nunca** pode ocorrer, verificável em teste e por construção.

### I-PSM1 — lastro integral, sem saque

```
USDC.balanceOf(CreditPSM) >= mintedOutstanding   (em unidades normalizadas)
```

Não existe **nenhuma** função de saque do lastro no PSM — nem para governança. `buy` deposita USDC e minta 1:1; `sell` queima CREDIT (do próprio saldo do PSM, após `transferFrom` do vendedor — a role de burn nunca toca saldo de terceiro) e devolve USDC 1:1. Se a DAO quiser gastar, gasta da **fee** (via Treasury), nunca do lastro. O USDC do PSM é segregado do Treasury por construção.

### Conservação no `pay`

Cada `FeeRouterV2.pay(projectId, amount)` reparte `amount` **exatamente**:

```
amount = fee + revShare + toApp
  fee     = amount * feeBps / 10000            (feeBps <= FEE_BPS_CAP = 500)
  revShare = amount * revShareBpsOf(id) / 10000 (0 se a rodada não financiou)
  toApp    = amount - fee - revShare
```

Sem sobra, sem criação de valor. O teto duro `FEE_BPS_CAP` (5%) é enforced no `setFeeBps` e no constructor — a governança não consegue passar dele.

### All-or-nothing no funding

Uma rodada só transfere capital ao owner quando `raised == target` (finaliza automaticamente no `invest` que fecha o alvo). Prazo vencido sem alvo → `Failed` → `refund` devolve 100%. O investidor nunca financia parcialmente um projeto que não atingiu a meta.

### Gate de GOV stakeado

`ProjectFunding.invest` e `claim` exigem `Staking.getWeight(msg.sender, projectId) > 0`. Materializa "quem tem GOV em stake no projeto participa da rodada e recebe a redistribuição". Sem stake, o rev-share não é perdido — fica acruado até o investidor voltar a stakear.

### Anti-flashloan (staking e voto)

- **Voto:** o Governor usa `getPastVotes` (snapshot) — poder congelado em bloco anterior ao voto (I5). Ver [Voting power](../07-governance/02-voting-power.md).
- **Staking:** pesos são historiografados por bloco (`Checkpoints.Trace208`); consultas históricas (`getWeightAt`) leem bloco passado, impedindo flash-staking no mesmo bloco de uma distribuição.

## Governança via Timelock

Toda mudança governável percorre `Governor` (voto) → `Timelock` (execução com delay). Ver [Ciclo de uma proposta](../07-governance/01-proposal-lifecycle.md). Propriedades de segurança:

- **Delay como última defesa.** O `minDelay` do Timelock (2 dias em produção) dá janela de reação mesmo se uma proposta maliciosa passar.
- **Execução determinística.** O Timelock só executa os calldatas exatos da proposta aprovada (o hash de operação cobre targets/values/calldatas). Não há injeção de chamada não escaneada.
- **Execução pública.** `executors = [address(0)]` — qualquer um executa uma operação vencida. Reduz o vetor de captura (não há executor privilegiado a comprometer) sem perda de segurança (o delay é o gate real).

## Supermaioria anti-captura

Alterar quem detém roles no **Treasury** ou no **Timelock** decide quem pode esvaziar o cofre — o vetor clássico de captura de uma DAO. O `CommunityGovernor` fecha esse vetor:

- No `propose`, escaneia targets+calldatas. Qualquer `grantRole`/`revokeRole`/`renounceRole` com `target == TREASURY` ou `target == timelock()` marca a proposta inteira como `Supermajority`.
- `_voteSucceeded` passa a exigir `forVotes >= 3 * againstVotes` **e** `forVotes > 0` (For ≥ 75% dos votos decisivos).
- **Batch misto contamina tudo:** empacotar a chamada sensível junto de chamadas populares não dilui o requisito — a proposta inteira vira `Supermajority`.
- **Chamadas aninhadas falham:** um contrato intermediário chamado pela proposta nunca é o Timelock, então a indireção não passa no AccessControl do Treasury/Timelock.

## Padrões de implementação

- **CEI estrito** (Checks-Effects-Interactions) em todas as funções que movem tokens — effects antes de `safeTransfer`.
- **`ReentrancyGuard`** nas funções state-changing do PSM, FeeRouterV2, ProjectFunding, Treasury e Staking (mesmo com tokens sem hooks conhecidos, é blindagem contra regressão).
- **`SafeERC20`** em todas as transferências.
- **Custom errors** em vez de strings, com args para diagnóstico off-chain.
- Solidity 0.8.24 (aritmética checked; overflow reverte, não wrappa) + OpenZeppelin 5.0.2 pinado.

## Estado de verificação

- 872 testes passando; slither sem findings high/medium.
- **Pendências de mainnet:** auditoria externa + parecer jurídico sobre o rev-share (ver [Riscos e segurança](../06-for-investors/03-risk-and-security.md)). Até lá, só testnet/local.

---

**Próximo →** [FAQ](../10-reference/01-faq.md)
