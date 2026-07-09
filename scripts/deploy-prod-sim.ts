import { ethers, network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-prod-sim — seeds de DESENVOLVIMENTO sobre a stack do remodel
 * (payment rail + funding por rev-share) ja deployada pelo Ignition
 * (Dao.ts com DEPLOY_USDC_MOCK=true). Idempotente: re-execucao numa chain
 * ja semeada detecta o projeto #1 e aborta cedo.
 *
 * O que provisiona:
 *  1. DevFaucet (ETH + USDC; CREDIT se compra no PSM) + funding do faucet.
 *  2. GOV pro dev member (Account #0) + delegacao (voto ativo).
 *  3. Projeto #1 "cloud-terminal" registrado e ativado (Timelock impersonado
 *     — equivale a proposta de governanca executada; rede local apenas).
 *  4. Dev member compra CREDIT no PSM (USDC mock mintado direto).
 *  5. Stake de GOV no projeto #1 + rodada de captacao ABERTA parcialmente
 *     preenchida (demo do fluxo de investimento na UI).
 *  6. Pagamento demo via FeeRouterV2.pay (fee 2,5% + volume on-chain).
 *  7. dev_addresses.json com o DevFaucet (PSM/Funding/RouterV2/USDC vem do
 *     proprio Ignition via export-runtime-config).
 *
 * Uso:
 *   npx hardhat run scripts/deploy-prod-sim.ts --network localhost
 *   # (roda automaticamente no boot do container web3c-hardhat)
 */

const GOV_DEV_MEMBER = 1_000_000n * 10n ** 18n; // 1M GOV
const COLLATERAL = 1_000n * 10n ** 18n; // = minCollateral dev
const USDC_DEV_MEMBER = 500_000n * 10n ** 6n; // 500k USDC
const USDC_FAUCET = 1_000_000n * 10n ** 6n; // 1M USDC pro faucet
const ETH_FAUCET = 100n * 10n ** 18n; // 100 ETH pro faucet
const PSM_BUY = 200_000n * 10n ** 6n; // dev compra 200k CREDIT
const STAKE_AMOUNT = 100_000n * 10n ** 18n; // 100k GOV no projeto #1
const STAKE_LOCK = 365n * 24n * 60n * 60n; // 1 ano (peso 4x)
const ROUND_TARGET = 50_000n * 10n ** 18n; // alvo da rodada demo
const ROUND_REV_SHARE_BPS = 800; // 8%
const ROUND_DURATION = 30n * 24n * 60n * 60n; // 30 dias
const ROUND_PARTIAL = 20_000n * 10n ** 18n; // preenchimento parcial (demo)
const DEMO_PAYMENT = 1_000n * 10n ** 18n; // pagamento demo

const FAUCET_DRIP_ETH = 1n * 10n ** 18n;
const FAUCET_DRIP_USDC = 250n * 10n ** 6n;
const FAUCET_COOLDOWN = 300n; // 5 min

async function main() {
  const [dev] = await ethers.getSigners();
  const chainId = network.config.chainId ?? 31337;
  const depDir = resolve(__dirname, `../ignition/deployments/chain-${chainId}`);
  const deployed = JSON.parse(
    readFileSync(resolve(depDir, "deployed_addresses.json"), "utf8"),
  ) as Record<string, string>;

  const addr = {
    gov: deployed["CommunityDAOModule#phaseA_GovernanceToken"],
    credit: deployed["CommunityDAOModule#phaseA_CreditToken"],
    timelock: deployed["CommunityDAOModule#phaseA_CommunityTimelock"],
    registry: deployed["CommunityDAOModule#phaseA_ProjectRegistry"],
    staking: deployed["CommunityDAOModule#phaseA_Staking"],
    usdc: deployed["CommunityDAOModule#phaseA_UsdcMock"],
    psm: deployed["CommunityDAOModule#phaseA_CreditPSM"],
    funding: deployed["CommunityDAOModule#phaseA_ProjectFunding"],
    router: deployed["CommunityDAOModule#phaseA_FeeRouterV2"],
  };
  for (const [k, v] of Object.entries(addr)) {
    if (!v) throw new Error(`endereco de ${k} ausente — rode o Ignition com DEPLOY_USDC_MOCK=true`);
  }

  const gov = await ethers.getContractAt("GovernanceToken", addr.gov);
  const credit = await ethers.getContractAt("CreditToken", addr.credit);
  const registry = await ethers.getContractAt("ProjectRegistry", addr.registry);
  const staking = await ethers.getContractAt("Staking", addr.staking);
  const usdc = await ethers.getContractAt("ERC20DecimalsMock", addr.usdc);
  const psm = await ethers.getContractAt("CreditPSM", addr.psm);
  const funding = await ethers.getContractAt("ProjectFunding", addr.funding);
  const router = await ethers.getContractAt("FeeRouterV2", addr.router);

  // Idempotencia: se o projeto #1 ja existe, chain ja foi semeada.
  if ((await registry.totalProjects()) > 0n) {
    console.log("[prod-sim] chain ja semeada (projeto #1 existe) — nada a fazer.");
    return;
  }

  console.log("[1/7] DevFaucet (ETH + USDC)…");
  const DevFaucet = await ethers.getContractFactory("DevFaucet");
  const faucet = await DevFaucet.deploy(
    addr.usdc,
    dev.address,
    FAUCET_DRIP_ETH,
    FAUCET_DRIP_USDC,
    FAUCET_COOLDOWN,
  );
  await faucet.waitForDeployment();
  await (await usdc.mint(await faucet.getAddress(), USDC_FAUCET)).wait();
  await (await dev.sendTransaction({ to: await faucet.getAddress(), value: ETH_FAUCET })).wait();
  console.log("      DevFaucet:", await faucet.getAddress());

  console.log("[2/7] GOV pro dev member + delegacao…");
  // Ownership do GOV e 2-step: pendingOwner = Timelock, dev ainda e owner
  // efetivo na rede local — mint direto funciona ate o aceite formal.
  await (await gov.mint(dev.address, GOV_DEV_MEMBER, "dev-member-seed")).wait();
  await (await gov.delegate(dev.address)).wait();

  console.log("[3/7] projeto #1 cloud-terminal (Timelock impersonado)…");
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr.timelock] });
  await network.provider.request({ method: "hardhat_setBalance", params: [addr.timelock, "0xDE0B6B3A7640000"] });
  const timelockSigner = await ethers.getSigner(addr.timelock);
  await (await gov.approve(addr.registry, COLLATERAL)).wait();
  await (
    await registry
      .connect(timelockSigner)
      .registerProject(dev.address, "ipfs://web3c/projects/cloud-terminal.json", COLLATERAL)
  ).wait();
  await (await registry.connect(timelockSigner).activateProject(1)).wait();
  await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr.timelock] });
  // Avanca alem da probation inicial (1d em dev) pra UX limpa no hub.
  await network.provider.send("evm_increaseTime", [86_401]);
  await network.provider.send("evm_mine", []);

  console.log("[4/7] USDC pro dev + compra de CREDIT no PSM…");
  await (await usdc.mint(dev.address, USDC_DEV_MEMBER)).wait();
  await (await usdc.approve(addr.psm, ethers.MaxUint256)).wait();
  await (await psm.buy(PSM_BUY)).wait();
  console.log("      CREDIT:", ethers.formatEther(await credit.balanceOf(dev.address)));

  console.log("[5/7] stake de GOV no projeto #1 + rodada de captacao…");
  await (await gov.approve(addr.staking, ethers.MaxUint256)).wait();
  await (await staking.stake(1, STAKE_AMOUNT, STAKE_LOCK)).wait();
  await (await funding.openRound(1, ROUND_TARGET, ROUND_REV_SHARE_BPS, ROUND_DURATION)).wait();
  await (await credit.approve(addr.funding, ethers.MaxUint256)).wait();
  await (await funding.invest(1, ROUND_PARTIAL)).wait();
  console.log(`      rodada: ${ethers.formatEther(ROUND_PARTIAL)}/${ethers.formatEther(ROUND_TARGET)} CREDIT (aberta, demo)`);

  console.log("[6/7] pagamento demo via FeeRouterV2…");
  await (await credit.approve(addr.router, ethers.MaxUint256)).wait();
  await (await router.pay(1, DEMO_PAYMENT)).wait();
  console.log("      grossVolume(1):", ethers.formatEther(await router.grossVolumeOf(1)));

  console.log("[7/7] dev_addresses.json…");
  const devFile = resolve(depDir, "dev_addresses.json");
  const existing = existsSync(devFile)
    ? (JSON.parse(readFileSync(devFile, "utf8")) as Record<string, string>)
    : {};
  writeFileSync(
    devFile,
    JSON.stringify({ ...existing, DevFaucet: await faucet.getAddress() }, null, 2) + "\n",
  );

  console.log("\n[prod-sim] pronto. Resumo:");
  console.log("  - faucet ETH+USDC (CREDIT: compre no PSM, aba Trocar CREDIT)");
  console.log("  - projeto #1 ativo, rodada de captacao aberta (8%, alvo 50k)");
  console.log("  - dev member (Account #0): GOV delegado, stake 100k, CREDIT em carteira");
  console.log("\nintegracao cloud-terminal:");
  console.log("  CHAIN_ID=31337 PUBLIC_RPC_URL=http://127.0.0.1:8545 \\");
  console.log("    npx tsx scripts/export-runtime-config.ts /tmp/web3-runtime-config.json");
  console.log("  WEB3_CONFIG_PATH=/tmp/web3-runtime-config.json WEB3_PROJECT_ID=1 \\");
  console.log("  ACTIVATION_PRICE_CREDIT=10 ACTIVATION_DURATION_SECONDS=600");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
