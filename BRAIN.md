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

**REMODEL 2026-07-08 ativo** (motivado por `audit/economist/2026-07-08-feerouter-bypass.md`): payment rail + rev-share substitui modelo econômico antigo (burn 80%).

- `CreditPSM.sol` — CREDIT ↔ USDC 1:1 (`buy`, `sell`, `backing`).
- `FeeRouterV2.sol` — `pay(projectId, amount)` com fee 2,5% (cap 5%), split 40/40/20 treasury/buyback/grants.
- `ProjectFunding.sol` — rounds de investimento all-or-nothing com rev-share 1%–30%, duração ≤90 dias.
- FeeRouter V1 (burn/treasury/rebate) e README §1–§6 = **referência histórica**.
- Rewards V1 aposentado no frontend (`/app/rewards` → redirect `rewards-v2`).
- Status qualidade: 872 testes passando; slither sem high/medium.
- Frontend: último commit `387b3f3` = backup pré-remodelagem; refatoração de UI do remodel em andamento.

Pendências pré-mainnet: auditoria externa + distribuição inicial (README §7).

## 3. Mapa de contratos (superfície pública)

Core: `GovernanceToken` (GOV) · `CreditToken` (CREDIT) · `CommunityGovernor` + `CommunityTimelock` · `ProjectRegistry` (whitelist, timelock owner-recipient 48h) · `Treasury` (FFP buyback, POL, MA 90d, Chainlink staleness 6h) · `Staking` (lock 14d–365d, mult máx 4x) · `BurnTracker` · `RewardDistributor` V1/`RewardDistributorV2` (bucket-aware/CLP) · `FeeRouter` V1 · `LiquidityGauge` (UniswapV3Staker) · `TeamVesting` · `UserSubsidy` · `CreditPriceOracle` (Chainlink USDC/USD, fallback 1:1).
Remodel: `CreditPSM` · `FeeRouterV2` · `ProjectFunding`.
Dev/mocks: `contracts/dev/` (DevFaucet, DevSwapPool), `contracts/test/`.

Roles: `MINTER_ROLE`, `BURNER_ROLE`, `RECORDER_ROLE`, `GOVERNANCE_ROLE`, `PROPOSER_ROLE`, `CANCELLER_ROLE`, `DEFAULT_ADMIN_ROLE` (fiação em `ignition/modules/Dao.ts` — atenção ao comentário BUG FIX ~L465 sobre ordem de renúncia de roles).

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
        ├─ frontend: npm run sync:docs       ──▶ src/content/docs/{pt-br,en,es}/ (fonte: backend docs/)
        └─ SDK: scripts/sync-abis.mjs        ──▶ ABIs do @cesarsst/web3community-sdk
```

⚠️ Após QUALQUER redeploy local: endereços mudam → rodar `sync:contracts` no frontend (Dockerfile falha o build se `abis.ts` não existir).

## 5. Frontend — mapa rápido

- Rotas: `/` landing · `/docs/:locale/:slug*` (pt-br|en|es) · `/app/*` (guard `requiresWallet` → ConnectModal): overview, tokens, swap, faucet, staking, invest, rewards-v2, gauge, governance(/new/:id), treasury, registry, rounds, dev (só chain 31337).
- 11 Pinia stores (setup): wallet, tokens, staking, governance, rewardsV2, gauge, funding, treasury, registry, rounds, market.
- Composables-chave: `useViemClients` (publicClient singleton), `useTx` (simula antes de assinar p/ decodificar revert), `useContract`, `useAutoRefresh` (watchBlocks 4s), `useToasts`.
- Wallets: EIP-6963 injected + WalletConnect + Coinbase SDK.
- i18n: docs por árvore de arquivos (pt-br fonte de verdade, paridade 52/52/52); UI do hub é PT-BR hardcoded (decisão: vue-i18n = overkill, `DocsView.vue` ~L82).
- Reverts traduzidos p/ PT em `src/utils/errors.ts`.
- Fórum Flarum externo: `VITE_FORUM_URL` ou `hostname:5191`.

## 6. Comandos essenciais

Backend (`/home/ubuntu/web3community`):
```bash
npm run compile | test | coverage | lint | typecheck
npm run node                 # hardhat node local
npm run deploy:local         # Ignition dev.json
npm run deploy:prod-sim:sync # full CLP + sync frontend
npm run sim                  # simulação econômica → scripts/simulation/output/
npx hardhat run scripts/deploy-remodel.ts   # PSM/FeeRouterV2/ProjectFunding
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
- Docs: pt-br é fonte de verdade; en/es devem manter paridade estrita de arquivos.
- Frontend: componentes UI próprios em `components/ui/` com tokens em `styles/tokens.css`; não introduzir vue-ui/wagmi/axios sem decisão registrada aqui.
- `src/contracts/abis.ts` e `addresses.ts`: autogerados, nunca editar à mão.
- Envs backend: `.env.example` (SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY sem 0x, ETHERSCAN_API_KEY, COINMARKETCAP_API_KEY, REPORT_GAS) + flags de deploy (`DEPLOY_TEAM_VESTING`, `DEPLOY_USER_SUBSIDY`, `DEPLOY_CLP_PHASE1`, `DEPLOY_CLP_ORACLE`).
- Envs frontend: `VITE_CHAIN_ID`, `VITE_RPC_URL`, `VITE_WC_PROJECT_ID`, `VITE_APP_NAME/DESCRIPTION/URL`, `VITE_FORUM_URL` (sobrescritos por `/config.json` em prod).

## 8. Referências

- README backend (37KB, aviso do remodel no topo) · `CHANGELOG.md` (126KB, `[Unreleased]` = remodel + pivot CLP).
- `docs/` trilíngue (10 seções × 3 locales).
- `audit/slither/` · `audit/economist/` (pareceres; `2026-07-08-feerouter-bypass.md` = origem do remodel).
- `.claude/protocol-state.md` (digest de estado do protocolo).
- SDK: `/home/ubuntu/utils/packages/web3community-sdk/src/` (config.ts, activation.ts, walletLink.ts).
- Consumidor #1 do SDK: cloud-terminal (ativação paga em CREDIT via `FeeRouter.pay`).

## 9. Decisões registradas (memory)

| Data | Decisão | Motivo |
|---|---|---|
| 2026-07-08 | Remodel econômico: PSM + FeeRouterV2 (fee 2,5%) + ProjectFunding substituem burn 80% | Bypass do FeeRouter identificado em parecer econômico |
| — | Frontend sem wagmi/vue-i18n/vue-ui/axios | viem puro + dicionários inline + UI própria; simplicidade > stack padrão do swarm |
| — | Rewards V1 aposentado na UI | V2 (bucket-aware/CLP) é o modelo vigente |
| — | pt-br = fonte de verdade das docs | en/es são traduções com paridade estrita |

## 10. 📌 Updates (log reverso)

> Adicione no TOPO. Formato: `- **YYYY-MM-DD** — o quê / onde / impacto.`

- **2026-07-08** — Remodel implementado ponta a ponta: contratos `CreditPSM`/`ProjectFunding`/`FeeRouterV2` (+14 testes, 872 total; slither limpo pós-CEI no `invest`), deploy local com roles via Timelock, hub com SwapView (PSM) + InvestView, landing e docs pt-br/en/es sincronizadas (fee 2,5% 40/40/20, rev-share 1-30%, CREDIT estável). Legado (FeeRouter V1, BurnTracker, RewardDistributorV2, Gauge) segue deployado, marcado ⚠️ LEGADO nas docs. Parecer que motivou: `audit/economist/2026-07-08-feerouter-bypass.md`.
- **2026-07-08** — BRAIN.md criado; CLAUDE.md dos dois repos passam a importá-lo. Estado capturado: remodel deployável via `scripts/deploy-remodel.ts`, frontend em refatoração pós-backup `387b3f3`.
