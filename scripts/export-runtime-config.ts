/**
 * Lê ignition/deployments/chain-<CHAIN_ID>/deployed_addresses.json e escreve
 * um JSON de runtime pro front:
 *
 *   { "chainId": 31337, "rpcUrl": "http://IP:8545", "addresses": { … } }
 *
 * Uso:
 *   CHAIN_ID=31337 PUBLIC_RPC_URL=http://1.2.3.4:8545 \
 *     tsx scripts/export-runtime-config.ts /shared/config.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || "http://127.0.0.1:8545";
const OUT = process.argv[2];

if (!OUT) {
  console.error("uso: tsx scripts/export-runtime-config.ts <out.json>");
  process.exit(1);
}

const FUTURE_ID_TO_NAME: Record<string, string> = {
  "CommunityDAOModule#phaseA_GovernanceToken": "GovernanceToken",
  "CommunityDAOModule#phaseA_CreditToken": "CreditToken",
  "CommunityDAOModule#phaseA_CommunityTimelock": "CommunityTimelock",
  "CommunityDAOModule#phaseA_ProjectRegistry": "ProjectRegistry",
  "CommunityDAOModule#phaseA_Treasury": "Treasury",
  "CommunityDAOModule#phaseA_Staking": "Staking",
  "CommunityDAOModule#phaseA_BurnTracker": "BurnTracker",
  "CommunityDAOModule#phaseA_RewardDistributor": "RewardDistributor",
  "CommunityDAOModule#phaseA_FeeRouter": "FeeRouter",
  "CommunityDAOModule#phaseA_CommunityGovernor": "CommunityGovernor",
  // Fase F (pivot CLP) — presentes quando o deploy rodou com DEPLOY_CLP_PHASE1.
  "CommunityDAOModule#phaseF_LiquidityGauge": "LiquidityGauge",
  "CommunityDAOModule#phaseF_RewardDistributorV2": "RewardDistributorV2",
};

const deployFile = resolve(
  __dirname,
  "..",
  "ignition",
  "deployments",
  `chain-${CHAIN_ID}`,
  "deployed_addresses.json",
);

if (!existsSync(deployFile)) {
  console.error(`nao existe ${deployFile} — rode o ignition primeiro`);
  process.exit(2);
}

const raw = JSON.parse(readFileSync(deployFile, "utf8")) as Record<string, string>;
const addresses: Record<string, string> = {};
for (const [futureId, addr] of Object.entries(raw)) {
  const name = FUTURE_ID_TO_NAME[futureId];
  if (name) addresses[name] = addr;
}

// Contratos dev deployados fora do Ignition pelo deploy-prod-sim (USDC mock,
// DevSwapPool, CreditPriceOracle, DevFaucet) — mesclados quando existirem.
const devFile = resolve(
  __dirname,
  "..",
  "ignition",
  "deployments",
  `chain-${CHAIN_ID}`,
  "dev_addresses.json",
);
if (existsSync(devFile)) {
  const devRaw = JSON.parse(readFileSync(devFile, "utf8")) as Record<string, string>;
  Object.assign(addresses, devRaw);
}

const body = {
  chainId: CHAIN_ID,
  rpcUrl: PUBLIC_RPC_URL,
  addresses,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(body, null, 2));
console.log(`wrote ${OUT}`);
console.log(JSON.stringify(body, null, 2));
