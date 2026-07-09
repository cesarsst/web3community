# Ambiente local

**Para quem é:** dev que quer rodar o protocolo inteiro na máquina para testar integração, UI ou os contratos.
**Pré-requisitos:** Node ≥ 20, o repositório `web3community` clonado, `npm install` já rodado.

Este guia leva de zero a uma chain local semeada: contratos deployados, projeto #1 ativo, rodada de captação aberta e um pagamento demo já processado. Tudo com uma stack idêntica à de produção, mais um USDC mock e um faucet exclusivos de rede local.

> **A chain local é in-memory.** Reiniciar o `hardhat node` zera tudo — endereços incluídos. Depois de qualquer redeploy, ressincronize o frontend e o SDK (ver o fim desta página).

## 1. Subir o node

```bash
npm run node      # hardhat node em http://127.0.0.1:8545 (chainId 31337)
```

Deixe rodando em um terminal. Ele expõe 20 contas unlocked pré-financiadas com ETH — a Account #0 é o `deployer`.

## 2. Deploy da stack (Ignition)

Em outro terminal, deploye o módulo `Dao.ts` com o mock de USDC ligado:

```bash
DEPLOY_USDC_MOCK=true npm run deploy:local
```

O que `DEPLOY_USDC_MOCK=true` faz: deploya um `ERC20DecimalsMock` de 6 decimais como o USDC de lastro do PSM, em vez de apontar para um endereço oficial. É a única diferença relevante entre o deploy local e o de produção. O módulo faz tudo o resto automaticamente:

- deploya os 11 contratos de núcleo (GOV, CREDIT, Timelock, Registry, Treasury, Staking, CreditPSM, ProjectFunding, FeeRouterV2, Governor) + o USDC mock;
- concede `MINTER_ROLE` e `BURNER_ROLE` do CREDIT **só ao PSM** (único emissor/queimador);
- concede `REVENUE_NOTIFIER_ROLE` do ProjectFunding **só ao FeeRouterV2**;
- transfere `GOVERNANCE_ROLE`/`DEFAULT_ADMIN_ROLE` dos contratos econômicos ao Timelock.

Parâmetros de dev (defaults do módulo): `feeBps=250` (2,5%), split `4000/4000/2000`, `minCollateral=1_000e18`, `probationDuration=1 dia`, `votingDelay=1 bloco`, `votingPeriod=50 blocos`, `timelockMinDelay=1h`.

## 3. Seeds de desenvolvimento

Com a stack deployada, rode o script de seeds:

```bash
npm run deploy:prod-sim
# ou, para semear E sincronizar o frontend de uma vez:
npm run deploy:prod-sim:sync
```

`scripts/deploy-prod-sim.ts` é **idempotente** — se detecta o projeto #1 já registrado, aborta cedo. Ele provisiona:

1. **DevFaucet** (ETH + USDC mock) + funding do faucet.
2. **GOV** para o dev member (Account #0) + `delegate` (ativa o voto).
3. **Projeto #1 "cloud-terminal"** registrado e ativado — o script impersona o Timelock (`hardhat_impersonateAccount`), o que equivale a uma proposta de governança executada. **Só funciona em rede local.**
4. Dev member **compra CREDIT no PSM** (USDC mock mintado direto).
5. **Stake** de 100k GOV no projeto #1 (lock de 1 ano, peso 4x) + **rodada de captação aberta** parcialmente preenchida (alvo 50k, rev-share 8%).
6. **Pagamento demo** via `FeeRouterV2.pay` (gera `grossVolumeOf` on-chain).

### CREDIT: compra-se no PSM, não sai do faucet

O `DevFaucet` entrega **ETH (gas) + USDC mock** — de propósito, ele **não** distribui CREDIT. Para ter CREDIT, você compra 1:1 no PSM com o USDC do faucet:

```ts
await usdc.approve(psmAddress, amount)
await psm.buy(usdcAmount)   // recebe usdcAmount * 1e12 de CREDIT (6 -> 18 decimais)
```

Isso é intencional: todo CREDIT em circulação nasce de um `buy()`, então o lastro do PSM permanece **integral** mesmo na rede local. Na UI do hub, é a aba "Trocar CREDIT" (SwapView).

## 4. Sincronizar o frontend e o SDK

Depois de deployar (ou redeployar), os endereços mudaram. Regenere os artefatos consumidos pelos clientes:

```bash
# no frontend (/home/ubuntu/web3community-frontend)
npm run sync:contracts   # regenera src/contracts/abis.ts + addresses.ts (AUTOGERADOS — nunca editar à mão)
```

O `sync:contracts` lê os deployments do Ignition e reescreve os ABIs/addresses. O build do frontend **falha** se `abis.ts` não existir, então esse passo é obrigatório após todo redeploy. `npm run deploy:prod-sim:sync` já encadeia o seed + o sync do frontend.

Para o SDK, os ABIs vêm de `scripts/sync-abis.mjs` (`npm run sync-abis` dentro de `@cesarsst/web3community-sdk`). Os **endereços** o SDK recebe em runtime via `RuntimeConfig` — gere-o a partir do deploy local:

```bash
CHAIN_ID=31337 PUBLIC_RPC_URL=http://127.0.0.1:8545 \
  npx tsx scripts/export-runtime-config.ts /tmp/web3-runtime-config.json
```

Esse JSON `{ chainId, rpcUrl, addresses }` é exatamente o que `createWeb3CommunitySdk` e `loadRuntimeConfig` consomem — ver [Visão geral de integração](01-integration-overview.md).

## Fluxo completo, resumido

```bash
npm run node                                  # terminal 1
DEPLOY_USDC_MOCK=true npm run deploy:local    # terminal 2
npm run deploy:prod-sim:sync                  # seeds + sync do frontend
# frontend: npm run dev  ->  hub em http://localhost:5173
```

Ao final você tem: faucet (ETH+USDC), projeto #1 ativo com rodada aberta (8%, alvo 50k), dev member com GOV delegado + stake + CREDIT em carteira, e um pagamento demo já contabilizado.

---

**Próximo →** [Tokenomics](../06-for-investors/01-tokenomics.md)
