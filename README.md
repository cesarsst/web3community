# web3community

DAO dual-token para uma plataforma multi-aplicativos: governança on-chain, um trilho de pagamento estável (CREDIT ↔ USDC 1:1) e um motor de funding que converte uso real dos apps em receita para os devs e rev-share para quem os financia.

> **Status**: testes verdes (365 passing, 0 failing) · slither sem findings high/medium · **pendências pré-mainnet: parecer jurídico do rev-share (≈ security) é bloqueador · auditoria externa · distribuição inicial**.

> **Modelo vigente (remodel 2026-07-08).** O modelo econômico antigo
> (burn-to-mint, emissão α·burn, buckets, gauge) foi **removido do código** —
> os contratos foram deletados, não apenas aposentados. Motivação no parecer
> `audit/economist/2026-07-08-feerouter-bypass.md` (taxa efetiva de ~80% sobre
> a receita do app não competia; bypass era estratégia dominante). Pilares:
>
> - **`CreditPSM`** — CREDIT estável 1:1 USDC, lastro integral sem função de saque;
> - **`FeeRouterV2`** — `pay(projectId, amount)` com fee de **2,5%** (teto duro 5%),
>   split 40/40/20 treasury/buyback GOV/grants, ~97,5% pro app na hora;
> - **`ProjectFunding`** — apps captam capital antecipado vendendo 1–30% da
>   receita bruta (rev-share) a investidores com GOV stakeado; distribuição
>   automática a cada `pay()`, all-or-nothing com refund.
>
> A documentação completa e atualizada está em `docs/pt-br/` (fonte de verdade)
> e `CHANGELOG.md` (`[Unreleased]`).

---

## 1. Como os contratos conversam entre si

O protocolo tem **11 contratos de núcleo** (+1 dev-only). Pense em três camadas: uma **política** que decide o que muda, uma de **estado** que guarda os fatos e uma **econômica** que move valor. As setas mostram quem _chama / lê_ quem em tempo de execução.

```
   Camada politica     CommunityGovernor ─propose/queue/execute─▶ CommunityTimelock
        │              (urna: propostas + votos)                 (executa com delay 2d;
        │                                                         porta o GOVERNANCE_ROLE)
        ▼
   Camada de estado    ProjectRegistry   Treasury   Staking   ProjectFunding
        │              (whitelist)       (cofre)    (peso)     (rodadas + rev-share)
        ▼
   Camada economica    CreditPSM        FeeRouterV2        GovernanceToken   CreditToken
                       (USDC<->CREDIT)  (pay + fee/split)  (GOV)             (CREDIT)
```

O caminho quente — o que acontece quando alguém **paga um app** — encadeia
usuário → PSM → FeeRouterV2 → app/ProjectFunding:

```
   usuario/app
      │
      │  buy/sell (USDC <-> CREDIT, 1:1)
      ▼
   CreditPSM  ──mint / burnByRole──▶  CreditToken (CREDIT)
      │                                    ▲
      │  (usuario agora tem CREDIT)        │  transferFrom / transfer de CREDIT
      ▼                                    │
   FeeRouterV2.pay(projectId, amount) ─────┘
      │   │   │
      │   │   └─▶ ProjectRegistry.isActive(projectId)        (gate: projeto Active?)
      │   │   └─▶ ProjectRegistry.getProject().owner          (fallback appRecipient)
      │   │
      │   └─▶ ProjectFunding.revShareBpsOf(projectId)         (quanto e rev-share?)
      │   └─▶ ProjectFunding.notifyRevenue(projectId, x)      (REVENUE_NOTIFIER_ROLE)
      │   └─▶ transfere: treasury / buyback / grants / appRecipient
      ▼
   PaymentRouted (evento)

   investidor
      │
      │  stake(projectId, GOV, lock)
      ▼
   Staking  ──transferFrom GOV──▶  GovernanceToken (GOV)
      │  ▲
      │  │  getWeight(investor, projectId)   (gate de invest / claim)
      ▼  │
   ProjectFunding.openRound / invest / claim / refund
      │  ──lê──▶ Staking.getWeight
      │  ──lê──▶ ProjectRegistry.getProject().owner   (paga o dono quando a rodada bate o alvo)
      ▼
   RoundOpened / Invested / RoundFunded / RevenueClaimed (eventos)
```

**As três camadas em uma frase cada:**

1. **Política** (Governor + Timelock) — decide _o que o protocolo faz_. Toda mudança de estado privilegiado passa por proposta + voto + delay.
2. **Estado** (Registry, Treasury, Staking, ProjectFunding) — guarda _quem é quem_ e _quanto tem o quê_: donos de projeto, status, colateral, saldos, pesos de stake, shares e receita das rodadas.
3. **Econômica** (PSM, FeeRouterV2, tokens GOV/CREDIT) — move _valor_: entrada/saída de dinheiro (PSM) e roteamento de pagamentos (FeeRouterV2).

**Dependências fixadas no construtor** (imutáveis, não mudam pós-deploy): `CreditPSM → (CREDIT, USDC)` · `Staking → (GOV, Registry)` · `ProjectFunding → (CREDIT, Registry, Staking)` · `FeeRouterV2 → (CREDIT, Registry, ProjectFunding)` · `CommunityGovernor → (GOV, Timelock, Treasury)`. Note que `Staking` **não** conhece `ProjectFunding` (é o funding que lê o staking), e o `CreditPSM` é independente do router e do funding — só toca `CREDIT` e `USDC`.

---

## 2. O fluxo de um pagamento — siga N CREDIT

O pagamento é o coração do modelo. Um usuário quer usar o "Chat App", que cobra **1000 CREDIT**. Ele já comprou CREDIT no PSM (depositou USDC, recebeu CREDIT 1:1), dá `approve(feeRouterV2, 1000)` e chama `feeRouterV2.pay(chatAppId, 1000)`. Dentro de uma única transação:

```
   [ Usuario paga 1000 CREDIT no Chat App via feeRouterV2.pay(chatAppId, 1000) ]
                               │
                               ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                        FeeRouterV2.pay()                               │
   │   1) checa Registry.isActive(chatAppId)  (senao reverte)              │
   │   2) puxa 1000 CREDIT do pagador (safeTransferFrom)                    │
   └───────┬───────────────────────────────────────────────────────────────┘
           │
           │  fee do protocolo = 2,5% de 1000 = 25 CREDIT
           │  split interno da FEE (40/40/20):
           │
           ├── 40% × 25 = 10 CREDIT ─▶ treasuryRecipient   (cofre da DAO)
           ├── 40% × 25 = 10 CREDIT ─▶ buybackRecipient    (compra de GOV)
           ├── 20% × 25 =  5 CREDIT ─▶ grantsRecipient     (grants; residuo da divisao)
           │
           │  rev-share do projeto = revShareBpsOf(chatAppId) × 1000
           │   (0 se o projeto nunca captou; supondo rodada Funded a 8% = 80 CREDIT)
           ├── 80 CREDIT ─▶ ProjectFunding  (safeTransfer) + notifyRevenue(chatAppId, 80)
           │                  └─ credita accRevenuePerShare aos investidores
           │
           │  o app fica com o RESTO = 1000 − 25 − 80 = 895 CREDIT
           └── 895 CREDIT ─▶ appRecipient  (setAppRecipient, ou owner do Registry)
                               │
                               ▼
                        PaymentRouted(projectId, payer, 1000,
                                      feeToTreasury=10, feeToBuyback=10,
                                      feeToGrants=5, revShare=80, toApp=895)
```

**Números do exemplo** (fee 2,5% split 40/40/20, rev-share 8%):

| Parcela | bps do pagamento | Sobre 1000 CREDIT | Vai para |
|---|---|---|---|
| Fee → treasury | 40% da fee (1,0%) | 10 | cofre da DAO |
| Fee → buyback GOV | 40% da fee (1,0%) | 10 | recompra de GOV |
| Fee → grants | 20% da fee (0,5%) | 5 | grants |
| Rev-share | `revShareBps` (0–30%) | 80 | investidores da rodada |
| **App** | resto | **895** | dono / recipient do app |

Se o projeto **nunca captou** (nenhuma rodada `Funded`), `revShareBpsOf` retorna 0 e o app leva `1000 − 25 = 975` (97,5%). O rev-share é sempre **descontado da fatia do app**, não somado por cima do pagamento — o usuário paga 1000 e ponto. No MVP dev os três recipients da fee apontam para o mesmo `Treasury`; o evento carrega o detalhamento por parcela para transparência contábil mesmo assim. A governança re-aponta `buyback`/`grants` quando os veículos dedicados existirem (`setRecipients`).

O buyback de GOV **ainda não é automatizado**: o CREDIT da parcela de buyback só se acumula no `buybackRecipient`. Executar a recompra é decisão de governança usando esses fundos — ver §7.

Para a UI existe `previewPay(projectId, amount)` (retorna `fee`, `revShare`, `toApp` sem executar) e `grossVolumeOf(projectId)` (volume bruto acumulado, métrica on-chain para investidores).

---

## 3. Papéis econômicos — e por que não é Ponzi

Muitos protocolos dual-token são Ponzi disfarçado: o "rendimento" de uns sai da entrada de outros, sem valor real por trás. Aqui a pergunta certa é **"de onde vem o valor?"** — e a resposta é fora da cadeia: **do usuário final que paga por um serviço que ele efetivamente quer usar**. Se nenhum app entregar utilidade, nenhuma fórmula salva o sistema. Não há emissão inflacionária, não há promessa de yield: todo CREDIT que circula foi lastreado 1:1 em USDC no PSM.

### Quem faz o quê e como ganha

| Agente | O que faz | Como ganha / de onde vem |
|---|---|---|
| **Usuário final** | Compra CREDIT no PSM (deposita USDC) e paga apps via `pay()` | Recebe o **serviço** do app (valor fora do protocolo). Pode resgatar CREDIT não gasto de volta em USDC 1:1 no PSM. |
| **App / dev** | Provê utilidade; recebe ~97,5% de cada pagamento na hora | **Receita direta em CREDIT** por uso real, imediata. Pode captar capital antecipado abrindo uma rodada no ProjectFunding (troca rev-share futuro por caixa agora). |
| **Investidor** | Stakea GOV no projeto e investe CREDIT numa rodada | Compra o direito a uma **fatia da receita bruta futura** (`revShareBps`, 1–30%), paga automaticamente a cada `pay()`. Se a rodada falhar, refund de 100%. |
| **Holder de GOV** | Governa (propõe, vota) e/ou stakea para curar/investir | Poder de decisão; GOV pode **valorizar** com o buyback financiado pela fee (não é yield direto). |
| **Treasury / DAO** | Acumula 40% da fee (= 1% do volume nos parâmetros default) | Financia o que a comunidade decidir por proposta (grants, buyback, operação). |

### Por que isso não é Ponzi — três âncoras

1. **CREDIT é 100% lastreado, não emitido.** Todo CREDIT nasce no `CreditPSM` contra depósito de USDC 1:1, e o PSM **não tem função de saque do lastro — nem para a governança**. A invariante `USDC.balanceOf(PSM) >= mintedOutstanding` vale por construção; quem tem CREDIT sempre pode resgatar USDC (enquanto houver lastro, que só sai pelo `sell()`). Não existe alavancagem sobre o lastro.

2. **A renda do investidor é receita real, não entrada de novos investidores.** O rev-share é uma fatia da receita bruta que o app **já está gerando** por uso — distribuída via acumulador `accRevenuePerShare` (padrão MasterChef) a cada pagamento. Se o app não fatura, o investidor não recebe: nada é prometido, nada é criado do nada.

3. **Rodada é all-or-nothing com skin in the game.** O dono do projeto só recebe o capital captado se a rodada **bater o alvo** (`_fund`); se o prazo vencer sem alvo, a rodada vira `Failed` e cada investidor pega `refund` de 100%. Investir e sacar rev-share exigem GOV stakeado no projeto (`getWeight(investor, projectId) > 0`) — curadoria com capital travado, não aposta grátis.

O valor do GOV, por sua vez, não vem de emissão: vem da **recompra financiada pela fee** (40% da fee vira pressão de compra de GOV) e do poder de governança sobre o Treasury. O motor só gira se os apps gerarem valor real — **tokenomics não salva produto ruim.**

---

## 4. Os 11 contratos — referência rápida

| # | Contrato | Papel (1 linha) |
|---|---|---|
| 1 | `GovernanceToken` (GOV) | ERC20Votes, cap **100M imutável**, Ownable2Step. Voto na governança + stake. `owner` = Timelock. |
| 2 | `CreditToken` (CREDIT) | ERC20 de pagamento, supply elástico. `MINTER_ROLE`+`BURNER_ROLE` só no PSM; admin = Timelock. **Sem genesis.** |
| 3 | `ProjectRegistry` | Whitelist on-chain. Status `Pending → Active → Probation → Removed` + colateral em GOV. Gated `GOVERNANCE_ROLE`. |
| 4 | `Staking` | Stake de GOV direcionado por projeto. Lock **14d–365d**, multiplier linear **1x→4x**. Gate de investimento; não é privilegiado (sem roles). |
| 5 | `Treasury` | Cofre simples multi-ativo. Só `transfer`/`transferETH`, gated `GOVERNANCE_ROLE`. **Sem POL, sem oracle, sem buyback interno.** |
| 6 | `CreditPSM` | Trilho estável: `buy`/`sell` USDC↔CREDIT **1:1**, lastro integral **sem saque**. Único minter/burner do CREDIT. |
| 7 | `FeeRouterV2` | Trilho de pagamento: `pay(projectId, amount)` — fee **2,5%** (teto duro 5%), split 40/40/20, rev-share descontado. |
| 8 | `ProjectFunding` | Rodadas de captação (`openRound`/`invest`/`claim`/`refund`), all-or-nothing, rev-share 1–30%, prazo 1–90d. |
| 9 | `CommunityTimelock` | OZ TimelockController, delay **2 dias** em produção. Portador do `GOVERNANCE_ROLE` de tudo acima. Self-administered. |
| 10 | `CommunityGovernor` | Governor OZ. Voting delay/period, quorum 4%, threshold 10k GOV. **Supermaioria 75%** para gestão de roles do Treasury/Timelock. |
| 11 | `TeamVesting` | 1 instância por beneficiário. Cliff + linear, `owner` = Timelock, revogável. Deploy opcional. |
| — | `DevFaucet` | ETH + USDC mock em rede local. **Não deployado em produção.** |

Detalhes de superfície pública, invariantes e roles em `docs/pt-br/03-protocol-overview/01-architecture.md` e `docs/pt-br/08-contracts-reference/`.

**O que os contratos econômicos deliberadamente NÃO fazem** (superfície minimalista):

- **Treasury** é um cofre e nada mais — sem POL, sem oracle, sem buyback interno. Buyback é decisão de governança gastando fundos do cofre.
- **CreditPSM** não tem função de saque do lastro, nem para governança.
- **Staking** não tem role nenhuma; todo gating é lógica de negócio (ownership da posição, status do projeto, expiração do lock).
- **FeeRouterV2** não queima nem emite CREDIT — só roteia. A **única queima** do protocolo é o `sell()` do PSM (resgate de USDC).

---

## 5. Deploy

Um único módulo Ignition (`ignition/modules/Dao.ts`) deploya e fia os 11 contratos, com a mesma sequência de calls em dev e produção (zero drift). Não há genesis de CREDIT — todo CREDIT nasce no PSM contra USDC.

```bash
# dev / local — USDC mock automático
npm run deploy:local
#   = DEPLOY_USDC_MOCK=true hardhat ignition deploy ./ignition/modules/Dao.ts \
#       --parameters ignition/parameters/dev.json --network localhost

# Sepolia / produção — usdcAddress DEVE ser o USDC oficial da rede
npm run deploy:sepolia
#   = hardhat ignition deploy ./ignition/modules/Dao.ts \
#       --parameters ignition/parameters/production.json --network sepolia
```

**USDC de lastro.** Em dev, a env `DEPLOY_USDC_MOCK=true` deploya um `ERC20DecimalsMock(6)` e o usa como lastro (o `usdcAddress` do JSON é ignorado). Em produção, **`ignition/parameters/production.json` precisa de um `usdcAddress` real** — o placeholder `0x0000…0000` faz o deploy anexar em endereço zero e quebra. Definir esse endereço é pré-requisito de qualquer deploy em rede pública.

**Seeds de desenvolvimento.** `npm run deploy:prod-sim` (ou `deploy:prod-sim:sync`, que também roda o `sync-frontend`) semeia a chain local sobre a stack já deployada: DevFaucet (ETH+USDC) fundado, GOV + delegação para o dev member, projeto #1 "cloud-terminal" registrado e ativado (Timelock impersonado), compra de CREDIT no PSM, stake + rodada de captação parcialmente preenchida e um pagamento demo via `FeeRouterV2.pay`. É idempotente (aborta se o projeto #1 já existe). O boot do container `web3c-hardhat` roda isso automaticamente.

**Fiação de roles (fases A–D no módulo):**

- **Fase A** — deploy dos 11 contratos com o deployer como admin temporário.
- **Fase B** — roles operacionais: `MINTER_ROLE`+`BURNER_ROLE` do CREDIT → PSM; `REVENUE_NOTIFIER_ROLE` do ProjectFunding → FeeRouterV2; `PROPOSER_ROLE`+`CANCELLER_ROLE` do Timelock → Governor.
- **Fase C** — roles de governança: `GOVERNANCE_ROLE`+`DEFAULT_ADMIN_ROLE` de Registry/Treasury/Funding/FeeRouterV2 → Timelock; `DEFAULT_ADMIN_ROLE` do CREDIT → Timelock; `transferOwnership` (2-step) do GOV → Timelock.
- **Fase D** — o deployer **renuncia** a todas as roles restantes; o admin do Timelock é renunciado **por último**.

Após a fase D o Timelock é a única autoridade, e só age por proposta aprovada. `TeamVesting` é uma fase opcional (`DEPLOY_TEAM_VESTING=true`).

**Primeira proposta em produção.** Como o GOV foi transferido em 2 steps, a primeira ação obrigatória após o deploy é submeter ao Governor uma proposta chamando `governanceToken.acceptOwnership()` pelo Timelock — isso finaliza a transferência de ownership e destrava mints futuros (distribuição inicial, vesting) via propostas.

---

## 6. Testes e qualidade

```bash
npm run compile          # hardhat compile (Solidity 0.8.24, viaIR, evm paris)
npm test                 # suite completa — 365 passing, 0 failing
npm run coverage         # cobertura (alvo ≥ 90% no pipeline de contratos)
npm run lint             # solhint + eslint
npm run typecheck        # tsc --noEmit

# slither (pipx install slither-analyzer)
slither contracts/<Contract>.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --solc-args "--optimize --optimize-runs 200 --evm-version paris"
```

- **Solidity 0.8.24** com `viaIR: true` (necessário pro Governor caber no EIP-170), evm `paris`.
- **OpenZeppelin Contracts 5.0.2** pinado exato.
- **Hardhat + Ignition** para orquestração de deploy.
- **Slither** sem findings high/medium. O único aviso remanescente (divide-before-multiply no `FeeRouterV2`) é **intencional** — a ordem preserva a semântica de arredondamento das parcelas da fee.
- Auditorias estáticas em `audit/slither/`; pareceres econômicos em `audit/economist/` (`2026-07-08-feerouter-bypass.md` é a origem do remodel).

---

## 7. Pendências antes de mainnet

1. **[BLOQUEADOR] Parecer jurídico do rev-share.** O `revShareBps` do `ProjectFunding` pode caracterizar valor mobiliário (security) em várias jurisdições — vender fatia de receita futura a investidores é um contrato de investimento. Enquanto não houver parecer jurídico validando o desenho (ou ajustando-o), **isso trava o mainnet**.
2. **Buyback de GOV não automatizado.** A parcela de buyback da fee (40% da fee) apenas se acumula no `buybackRecipient` — não há contrato que compre GOV no mercado e o distribua/queime. Hoje a recompra é uma ação manual de governança. Automatizá-la (ou decidir formalmente que fica manual) é pendência de design.
3. **Auditoria externa obrigatória** (Trail of Bits / OpenZeppelin / Certik) antes de qualquer valor real.
4. **Distribuição inicial de GOV.** Os contratos e as propostas de distribuição (venda pública, vesting do time, community rewards, liquidez) ainda não existem no repo e precisam ser desenhados/deployados. Até a primeira proposta de mint executar, **0 GOV existe em circulação** — o bootstrap do primeiro proposer segue o padrão de `docs/pt-br/09-advanced/02-mainnet-deployment.md`.
5. **`usdcAddress` real em `production.json`** (§5) — pré-requisito de qualquer deploy em rede pública.
6. **Smoke test de governança em Sepolia** por ≥ 2 semanas + primeira proposta `acceptOwnership()`.
7. **Operacional**: multi-sig Safe como segundo `CANCELLER_ROLE` no Timelock; bug bounty (Immunefi); monitoramento on-chain (Forta/Tenderly) de eventos críticos (`PaymentRouted`, `RoundFunded`, saídas grandes do Treasury, mudanças de fee/split/recipients); revisão de `votingDelay`/`votingPeriod` se o destino for L2 (os valores em blocos assumem ~12s/block do L1).

---

## Licença

A definir pelo mantenedor do projeto.
