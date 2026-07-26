# 🧠 BRAIN — web3community (backend + frontend)

> **Cérebro do projeto.** Fonte única de contexto para o Claude nos dois repos.
> Carregado automaticamente via `CLAUDE.md` de:
> - `/home/ubuntu/web3community` (contratos Solidity / "backend")
> - `/home/ubuntu/web3community-frontend` (hub Vue 3)
>
> **Protocolo de manutenção:** ao concluir qualquer mudança significativa (novo contrato, mudança econômica, nova view, redeploy, decisão de arquitetura), atualize a seção correspondente E adicione uma entrada em [📌 Updates](#-updates-log-reverso). Datas sempre absolutas (YYYY-MM-DD).

---

## 1. Identidade

DAO dual-token **web3community**: ecossistema de projetos comunitários pagos em **CREDIT** (estável 1:1 USDC via PSM) com governança em **GOV** (ERC20Votes).

| Repo | Path | O que é |
|---|---|---|
| Backend | `/home/ubuntu/web3community` | Monorepo Hardhat de smart contracts (Solidity 0.8.24, OZ 5.0.2, viaIR, evm paris). **Não há API HTTP** — a "API" são funções públicas dos contratos. |
| Frontend | `/home/ubuntu/web3community-frontend` | Hub + landing (Vue 3.5 + Vite 6 + Pinia + viem 2.23 puro, **sem wagmi, sem vue-i18n, sem @cesarsst/vue-ui** — tudo hand-rolled por decisão). |
| SDK | `/home/ubuntu/utils/packages/web3community-sdk` | `@cesarsst/web3community-sdk` (viem) — usado por apps consumidores (ex.: cloud-terminal) p/ `payActivation`/`verifyActivationPayment`/walletLink. Contratos NÃO importam o SDK; acoplamento é via `config.json`. |

Redes: hardhat 31337 (dev, **in-memory — restart zera chain**), Sepolia 11155111. Sem mainnet ainda.

## 2. Estado atual do protocolo

**REMODEL 2026-07-08 — modelo ÚNICO** (motivado por `audit/economist/2026-07-08-feerouter-bypass.md`): payment rail + rev-share. O modelo econômico antigo (burn-to-mint, emissão, buckets, gauge) foi **removido do código** — contratos deletados, não apenas aposentados.

- `CreditPSM.sol` — CREDIT ↔ USDC 1:1 (`buy`, `sell`, `backing`), lastro integral sem saque. Único minter/burner do CREDIT.
- `FeeRouterV2.sol` — `pay(projectId, amount)` com fee 2,5% (cap 5%), split 40/40/20 treasury/buyback/grants, rev-share descontado, evento `PaymentRouted`.
- `ProjectFunding.sol` — rounds all-or-nothing, rev-share 1%–30%, duração 1–90 dias, gate de GOV stakeado.
- `Treasury.sol` — reescrito como cofre simples (transfer/transferETH gated GOVERNANCE_ROLE; sem POL/oracle/buyback/FFP).
- `CommunityGovernor.sol` — supermajority 75% agora dispara em gestão de roles do Treasury/Timelock (não há mais removePOL).
- SDK `@cesarsst/web3community-sdk` v0.2.0 (FeeRouterV2-only). cloud-terminal migrado.

Pendências pré-mainnet: parecer jurídico do rev-share (≈ security) = BLOQUEADOR; buyback automatizado de GOV não implementado (fundos acumulam no recipient); auditoria externa + distribuição inicial.

> ✅ **D1+D2+D3+D4 IMPLEMENTADOS (2026-07-11, branch `feat/wash-signal-mitigations-d1-d2`, PR #1) — vetor wash-payment fechado.** **D1/D2 (`FeeRouterV2.pay`):** marca `selfPayment` (pagador = owner ou appRecipient) e NÃO credita `grossVolumeOf`/`uniquePayersOf` nesse caso (split de valor intacto). Novo `uniquePayersOf[projectId]` (+`hasPaid`) = pagadores DISTINTOS; **UI/automação leem isso, não a soma bruta**. Evento `PaymentRouted` +`bool selfPayment` (ABI mudou → resync frontend+SDK já feito). **D3 (`ProjectFunding.invest`):** gate trocado de `getWeight > 0` para `getWeight >= minInvestWeight` (default `100e18` = ~100 GOV no lock mín; ajustável por governança via `setMinInvestWeight`; novo error `InsufficientStakeWeight`). Gate ASSIMÉTRICO: **`claim` mantém `> 0`** (piso é barreira de ENTRADA, não de saída — não pune quem investiu e reduziu stake). Força atacante a imobilizar GOV real por carteira sybil → ataque deixa de compensar (`audit/economist/sim/sybil-cost-sim.js`). **D4 (`FeeRouterV2`):** novo `recentVolumeOf(projectId)` = volume com **decaimento exponencial** (meia-vida `volumeHalfLife`, default 30d, governável via `setVolumeHalfLife`; aproximação = half-lives inteiras por shift + interp. linear, erro máx ~6%). `grossVolumeOf` **intacto** (soma eterna p/ auditoria); **UI/automação leem `recentVolumeOf`** — wash em rajada evapora. Pré-req duro de qualquer automação indexada a volume (recompra auto, grants). 386 testes, slither sem high/medium novo. **Vetor wash-payment agora fechado nas 4 camadas.**
>
> ⚠️ **PENDÊNCIA DE SEGURANÇA DE MODELO (pré-mainnet) — integridade de sinal / wash-payment.** O modelo é conservativo e à prova de *roubo* (nenhuma invariante deixa extrair mais CREDIT do que se injeta), MAS os 3 sinais derivados — GMV (`grossVolumeOf`, soma cega), pressão de buyback e rev-share acumulado — são lidos de `pay()` como se todo volume fosse orgânico. Atacante que controla app+pagador(+stake) faz `pay()` **circular** e falsifica os 3 por **custo de 2,5%/ciclo** (1,5% se detém 100% do GOV): `msg.sender` nunca é checado contra `owner`/`appRecipient`; gate de GOV é auto-satisfazível por self-stake; rev-share circular volta 100% via `claim` (independe do `revShareBps`); auto-rodada (self-invest → `_fund` devolve o `raised`) forja o selo "app financiado com tração". 1 CREDIT de fee imprime **40 CREDIT de GMV falso**. Dano = decisão de terceiros sobre sinal falso (rug de investidor de rev-share) e, crítico, **qualquer automação futura indexada a GMV** (recompra automática, grants pro-rata) vira dreno de treasury. **Não é ataque de valor (CEI/conservação não cobrem) — é ataque de sinal/reputação, não on-chain verificável.** Correções propostas (parecer §6): (1) view de pagadores-únicos / GMV-sem-self-payment, (2) guarda anti-self-payment no `pay`, (3) decaimento/janela no GMV como pré-requisito DURO de qualquer automação indexada a volume. Ver `audit/economist/2026-07-10-wash-signal-integrity.md` (sim reproduzível em `sim/`).

## 3. Mapa de contratos (superfície pública)

Core: `GovernanceToken` (GOV, cap 100M) · `CreditToken` (CREDIT) · `CommunityGovernor` + `CommunityTimelock` · `ProjectRegistry` (whitelist, colateral GOV) · `Treasury` (cofre simples) · `Staking` (lock 14d–365d, mult máx 4x; gate de investimento) · `TeamVesting`.
Remodel (motor econômico): `CreditPSM` · `FeeRouterV2` · `ProjectFunding`.
Dev-only (rede local): `DevFaucet` (ETH+USDC) · `ERC20DecimalsMock` (USDC).
**Deletados no remodel** (não referenciar): BurnTracker, RewardDistributor(V2), LiquidityGauge, FeeRouter V1, CreditPriceOracle, UserSubsidy, DevSwapPool + interfaces/mocks Uniswap/Chainlink.
Dev/mocks: `contracts/dev/` (DevFaucet), `contracts/test/` (ERC20DecimalsMock, ERC20Mock, ReentrantStakingERC20Mock).

Roles: `MINTER_ROLE`, `BURNER_ROLE` (CREDIT → PSM), `REVENUE_NOTIFIER_ROLE` (ProjectFunding → FeeRouterV2), `GOVERNANCE_ROLE`, `PROPOSER_ROLE`, `CANCELLER_ROLE`, `DEFAULT_ADMIN_ROLE` (fiação em `ignition/modules/Dao.ts`, fases A–D; deployer renuncia tudo, Timelock por último).

Digest auto-gerado de constantes/immutables/params: `.claude/protocol-state.md` (backend).

## 4. Fluxo de integração (crítico entender)

```
contratos (backend) ──deploy Ignition──▶ ignition/deployments/
        │
        ├─ scripts/export-runtime-config.ts ──▶ /shared/config.json {chainId, rpcUrl, addresses}
        │        └─ nginx do frontend serve como GET /config.json (no-store)
        │        └─ frontend: src/runtime.ts carrega ANTES do mount
        │
        ├─ frontend: npm run sync:contracts  ──▶ src/contracts/abis.ts + addresses.ts (AUTOGERADOS, nunca editar)
        ├─ frontend: npm run sync:docs       ──▶ src/content/docs/pt-br/ (fonte: backend docs/)
        └─ SDK: scripts/sync-abis.mjs        ──▶ ABIs do @cesarsst/web3community-sdk
```

⚠️ Após QUALQUER redeploy local: endereços mudam → rodar `sync:contracts` no frontend (Dockerfile falha o build se `abis.ts` não existir).

## 5. Frontend — mapa rápido

- Rotas: `/` landing · `/docs/:locale/:slug*` (pt-br) · `/app/*` (guard `requiresWallet` → ConnectModal): overview, tokens, swap (PSM), faucet, staking, invest (ProjectFunding), governance(/new/:id), treasury, registry, dev (só chain 31337).
- Pinia stores (setup): wallet, tokens, staking, governance, funding, treasury, registry, market.
- Composables-chave: `useViemClients` (publicClient singleton), `useTx` (simula antes de assinar p/ decodificar revert), `useContract`, `useAutoRefresh` (watchBlocks 4s), `useToasts`.
- Wallets: EIP-6963 injected + WalletConnect + Coinbase SDK.
- i18n: docs só pt-br no momento (en/es removidas no remodel — tradução posterior); UI do hub é PT-BR hardcoded.
- Reverts traduzidos p/ PT em `src/utils/errors.ts`.
- Fórum Flarum externo: `VITE_FORUM_URL` ou `hostname:5191`.
- Landing seção "Um exemplo de verdade" (`#exemplo`): cards trocados por diorama 3D `components/landing/PaymentFlow3D.vue` (CSS 3D puro, zero dep — cofre abastecido → app/investidores/DAO, linhas SVG com dash animado; versão mobile vertical simplificada; respeita `prefers-reduced-motion`).

## 6. Comandos essenciais

Backend (`/home/ubuntu/web3community`):
```bash
npm run compile | test | coverage | lint | typecheck
npm run node                 # hardhat node local
npm run deploy:local         # Ignition dev.json (DEPLOY_USDC_MOCK=true)
npm run deploy:prod-sim:sync # seeds dev + sync frontend
```

Frontend (`/home/ubuntu/web3community-frontend`):
```bash
npm run dev | build | typecheck
npm run sync:contracts   # regenerar ABIs/addresses após redeploy
npm run sync:docs        # copiar docs do backend
```

Deploy prod: push na branch `production` (ambos os repos) → GitHub Actions SSH → `/home/ubuntu/swarm/docker-compose.production.yml` → build `--no-cache` de `web3c-hardhat` / `web3c-frontend` + `up -d`.

## 7. Convenções e regras do projeto

- Solidity: pipeline do agente `dao-dev` (backend `.claude/agents/`): impl → test → NatSpec → slither → coverage ≥90%; invariantes I1–I7. Agentes irmãos: `dao-economist`, `dao-docs`.
- Docs: só pt-br no momento (en/es removidas no remodel; retradução é tarefa futura).
- Frontend: componentes UI próprios em `components/ui/` com tokens em `styles/tokens.css`; não introduzir vue-ui/wagmi/axios sem decisão registrada aqui.
- `src/contracts/abis.ts` e `addresses.ts`: autogerados, nunca editar à mão.
- Envs backend: `.env.example` (SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY sem 0x, ETHERSCAN_API_KEY, COINMARKETCAP_API_KEY, REPORT_GAS) + flags de deploy (`DEPLOY_USDC_MOCK` p/ dev, `DEPLOY_TEAM_VESTING`).
- Envs frontend: `VITE_CHAIN_ID`, `VITE_RPC_URL`, `VITE_WC_PROJECT_ID`, `VITE_APP_NAME/DESCRIPTION/URL`, `VITE_FORUM_URL` (sobrescritos por `/config.json` em prod).

## 8. Referências

- README backend (37KB, aviso do remodel no topo) · `CHANGELOG.md` (126KB, `[Unreleased]` = remodel).
- `docs/pt-br/` (10 seções; en/es removidas no remodel).
- `audit/slither/` · `audit/economist/` (pareceres; `2026-07-08-feerouter-bypass.md` = origem do remodel; `2026-07-10-wash-signal-integrity.md` = pendência de sinal/wash-payment, ver ⚠️ em §2).
- `.claude/protocol-state.md` (digest de estado do protocolo).
- SDK: `/home/ubuntu/utils/packages/web3community-sdk/src/` (config.ts, activation.ts, walletLink.ts).
- Consumidor #1 do SDK: cloud-terminal (ativação paga em CREDIT via `FeeRouter.pay`).

## 9. Decisões registradas (memory)

| Data | Decisão | Motivo |
|---|---|---|
| 2026-07-11 | D4: `recentVolumeOf` com decaimento (meia-vida 30d) no `FeeRouterV2`; UI/automação leem isso, `grossVolumeOf` vira só auditoria. Vetor wash-payment fechado (D1-D4) | Mitigação do parecer `2026-07-10-wash-signal-integrity.md` |
| 2026-07-11 | D3: piso `minInvestWeight` (default 100e18) no `ProjectFunding.invest`; gate assimétrico (claim mantém `>0`). Força imobilizar GOV real por carteira sybil. D4 pendente | Mitigação do parecer `2026-07-10-wash-signal-integrity.md` |
| 2026-07-11 | D1 (anti-self-payment) + D2 (`uniquePayersOf`) implementados no `FeeRouterV2`; UI passa a ler pagadores-únicos, não GMV bruto. D3/D4 pendentes | Mitigação do parecer `2026-07-10-wash-signal-integrity.md` |
| 2026-07-10 | Registrada pendência de segurança de modelo: wash-payment falsifica GMV/buyback/rev-share por 2,5%/ciclo (§2 ⚠️) — a resolver antes do mainnet, bloqueante para automação indexada a volume | Parecer `2026-07-10-wash-signal-integrity.md` |
| 2026-07-08 | Remodel econômico: PSM + FeeRouterV2 (fee 2,5%) + ProjectFunding substituem burn 80% | Bypass do FeeRouter identificado em parecer econômico |
| — | Frontend sem wagmi/vue-i18n/vue-ui/axios | viem puro + dicionários inline + UI própria; simplicidade > stack padrão do swarm |
| — | Rewards V1 aposentado na UI | V2 (bucket-aware/CLP) é o modelo vigente |
| — | pt-br = fonte de verdade das docs | en/es são traduções com paridade estrita |

## 10. 📌 Updates (log reverso)

> Adicione no TOPO. Formato: `- **YYYY-MM-DD** — o quê / onde / impacto.`

- **2026-07-11** — **Mitigação D4 do wash-payment implementada — vetor FECHADO** (`FeeRouterV2.sol`, mesmo branch/PR #1, via dao-dev). Novo `recentVolumeOf(projectId)` = volume com decaimento exponencial: meia-vida `volumeHalfLife` (default 30d, governável via `setVolumeHalfLife` + evento; error `ZeroHalfLife` p/ 0). Aproximação sem float: meias-vidas inteiras por shift (`v >> q`) + interpolação linear no resto, cap 64 half-lives (além disso → 0). Erro máx ~6% (secante superestima 2^-x), aceitável p/ sinal. `grossVolumeOf` **INTACTO** (soma eterna, auditoria); `recentVolumeOf` é o novo número que **UI/automação leem** — wash em rajada evapora, e automação indexada a volume não é drenável por histórico falso. +6 testes (incrementa; cai ~50% após 1 half-life; evapora após muitas enquanto grossVolume intacto; self-payment não move; setter só governança; conservação). +2 SSTORE por pay qualificado. Suite 386 passing; slither sem high/medium novo. **ABI mudou (nova view `recentVolumeOf` + evento) → resync frontend/SDK.** As 4 camadas (D1-D4) do parecer 2026-07-10 estão implementadas.
- **2026-07-11** — **Mitigação D3 do wash-payment implementada** (`ProjectFunding.sol`, mesmo branch/PR #1, via dao-dev). Gate de `invest` trocado de `getWeight > 0` para `getWeight >= minInvestWeight` (novo storage governável, default `100e18` = ~100 GOV no lock mín 1x; setter `setMinInvestWeight` gated GOVERNANCE_ROLE + evento; novo error `InsufficientStakeWeight`). **Gate assimétrico** — `claim` mantém `> 0` (piso é barreira de ENTRADA, não de saída: não pune retroativamente quem investiu e reduziu stake, evita fundos presos; documentado no NatSpec do claim). É a peça que força o atacante a imobilizar GOV real por carteira "investidora" fake → o sybil deixa de compensar. +3 testes (abaixo/exato/acima do piso; claim sem piso após reduzir stake; setter só governança); 1 teste antigo ajustado (invest sem stake agora → `InsufficientStakeWeight`). Suite 380 passing; slither sem high/medium novo. **Pendente: D4** (janela no GMV, pré-req de automação indexada a volume).
- **2026-07-11** — **Mitigações D1+D2 do wash-payment implementadas** (`FeeRouterV2.sol`, branch `feat/wash-signal-mitigations-d1-d2`, via dao-dev). D1: guarda anti-self-payment — pagador = owner/appRecipient marca `selfPayment` e não credita contadores de sinal (split de valor intacto, conservação preservada). D2: novo `uniquePayersOf[projectId]` + `hasPaid` = pagadores distintos; **UI/automação devem ler isso, não `grossVolumeOf`**. Evento `PaymentRouted` +`bool selfPayment` no fim → **ABI mudou, resync frontend/SDK obrigatório no merge**. 5 testes novos (self-payment via owner e via appRecipient rotacionado; 2º pagamento do mesmo terceiro não move uniquePayers; 2 terceiros → 2; conservação); suite 377 passing; compile limpo; slither sem high/medium novo. **Pendente: D3** (peso mínimo no `ProjectFunding.invest`, fecha auto-rodada) **+ D4** (janela no GMV, pré-req de automação). Custo sybil pós-fix modelado em `audit/economist/sim/sybil-cost-sim.js`.
- **2026-07-10** — **Parecer econômico novo + PENDÊNCIA DE SEGURANÇA DE MODELO registrada** (`audit/economist/2026-07-10-wash-signal-integrity.md` + `sim/wash-signal-integrity-sim.js`). Achado: modelo pós-remodel é à prova de roubo (conservação/CEI), mas os 3 sinais derivados (GMV `grossVolumeOf`, pressão de buyback, rev-share `accRevenuePerShare`) são falsificáveis por `pay()` circular a **2,5%/ciclo** (atacante controla app+pagador+stake; `msg.sender` não é gated contra owner/appRecipient; self-stake satisfaz o gate de GOV; rev-share circular volta 100% via `claim`; auto-rodada forja "app financiado"). 1 CREDIT de fee = 40 de GMV falso. Dano: rug de investidor de rev-share por sinal falso e — crítico — qualquer automação futura indexada a GMV (recompra auto / grants pro-rata) viraria dreno de treasury. Não coberto por invariante (é ataque de sinal, não de valor). Correções propostas: view de pagadores-únicos, guarda anti-self-payment no `pay`, decaimento/janela no GMV (pré-requisito duro de automação). Registrado em §2 ⚠️ e §9. **Nenhuma mudança de código ainda** — só análise/documentação. Distingue-se do parecer 2026-07-08 (incentivo inverso: app *evitar* o roteamento).
- **2026-07-09** — Fix layout `PaymentFlow3D.vue` (desktop): grid era `1fr 1fr` com `origin | vault` na linha de cima → cofre caía em ~x75 enquanto as linhas SVG (viewBox) esperam cofre no centro x50 e coin em x15; wires apontavam pro vazio (cofre parecia "num flex alinhado com a moeda, ignorando as linhas"). Trocado por grid de 1 coluna (`origin/vault/sinks` empilhados): cofre `justify-self:center`, coin `justify-self:start` + `margin-left:4%`. Mobile ≤760px zera o `margin-left`. Verificado via Playwright: desktop `vaultPct=50/coinPct=15` (batem com o SVG), mobile intacto (`is-compact`, wires SVG `display:none`, sinks 1 coluna).
- **2026-07-09** — **Legado REMOVIDO do código** (não só aposentado): deletados BurnTracker, RewardDistributor(V2), LiquidityGauge, FeeRouter V1, CreditPriceOracle, UserSubsidy, DevSwapPool + interfaces/mocks e testes. Treasury/Governor/DevFaucet/CreditToken/Staking/ProjectRegistry com NatSpec reescrito; Ignition `Dao.ts` = 11 contratos do modelo novo (sem genesis; USDC mock via `DEPLOY_USDC_MOCK`); `deploy-prod-sim`/`boot-node.sh`/`export-runtime-config` reescritos; boot do container auto-provisiona. Suite **365 passing**; slither sem high/medium (divide-before-multiply no FeeRouterV2 é intencional). SDK 0.2.0 (FeeRouterV2-only) + cloud-terminal migrado. Frontend: views/stores/copy legadas removidas, Overview reescrito, vue-tsc verde. **Docs pt-br reconstruídas do zero (35 páginas), en/es/governance/apresentacao removidas** (tradução posterior).
- **2026-07-09** — Landing: seção "Um exemplo de verdade" (`#exemplo`) trocou os 4 cards estáticos por diorama 3D animado `components/landing/PaymentFlow3D.vue` (CSS 3D puro, zero dep — mantém regra viem-puro/UI hand-rolled). Fluxo: cofre abastecido → 3 destinos (app 89,5% / investidores 8% / DAO 2,5%) ligados por linhas SVG com dash animado ditando direção. Mobile ≤760px = pilha vertical simplificada. Split bars mantidos abaixo. Verificado desktop+mobile via Playwright.
- **2026-07-08** — Remodel implementado ponta a ponta: contratos `CreditPSM`/`ProjectFunding`/`FeeRouterV2` (+14 testes, 872 total; slither limpo pós-CEI no `invest`), deploy local com roles via Timelock, hub com SwapView (PSM) + InvestView, landing e docs pt-br/en/es sincronizadas (fee 2,5% 40/40/20, rev-share 1-30%, CREDIT estável). Legado (FeeRouter V1, BurnTracker, RewardDistributorV2, Gauge) segue deployado, marcado ⚠️ LEGADO nas docs. Parecer que motivou: `audit/economist/2026-07-08-feerouter-bypass.md`.
- **2026-07-08** — BRAIN.md criado; CLAUDE.md dos dois repos passam a importá-lo. Estado capturado: remodel deployável via `scripts/deploy-remodel.ts`, frontend em refatoração pós-backup `387b3f3`.
