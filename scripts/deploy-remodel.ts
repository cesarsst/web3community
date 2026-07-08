import { ethers, network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * Deploy do remodel 2026-07-08 (payment rail + funding por rev-share) sobre
 * um ambiente local ja provisionado pelo deploy-prod-sim.
 *
 *  1. CreditPSM     — mint/redeem CREDIT<->USDC 1:1 (lastro integral).
 *  2. ProjectFunding — rodadas de captacao + distribuicao de rev-share.
 *  3. FeeRouterV2   — fee 2,5% (40/40/20 treasury/buyback/grants) + rev-share.
 *
 * Wiring:
 *  - CreditToken: MINTER_ROLE + BURNER_ROLE pro PSM (via Timelock impersonado
 *    — na rede local o admin dos contratos ja foi transferido pra governanca,
 *    como em producao; aqui simulamos a execucao da proposta).
 *  - ProjectFunding: REVENUE_NOTIFIER_ROLE pro FeeRouterV2; governanca
 *    (GOVERNANCE_ROLE + DEFAULT_ADMIN) transferida ao Timelock.
 *  - FeeRouterV2: recipients = Treasury (os tres, MVP dev — eventos carregam
 *    o detalhamento); governanca transferida ao Timelock.
 *
 * Uso: npx hardhat run scripts/deploy-remodel.ts --network localhost
 */

const FEE_BPS = 250; // 2,5%
const FEE_SPLIT = { treasuryBps: 4000, buybackBps: 4000, grantsBps: 2000 };

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = network.config.chainId ?? 31337;
  const depDir = resolve(__dirname, `../ignition/deployments/chain-${chainId}`);
  const deployed = JSON.parse(readFileSync(resolve(depDir, "deployed_addresses.json"), "utf8")) as Record<string, string>;
  const devFile = resolve(depDir, "dev_addresses.json");
  const dev = existsSync(devFile) ? (JSON.parse(readFileSync(devFile, "utf8")) as Record<string, string>) : {};

  const addr = {
    credit: deployed["CommunityDAOModule#phaseA_CreditToken"],
    registry: deployed["CommunityDAOModule#phaseA_ProjectRegistry"],
    staking: deployed["CommunityDAOModule#phaseA_Staking"],
    treasury: deployed["CommunityDAOModule#phaseA_Treasury"],
    timelock: deployed["CommunityDAOModule#phaseA_CommunityTimelock"],
    usdc: dev["USDC"],
  };
  for (const [k, v] of Object.entries(addr)) {
    if (!v) throw new Error(`endereco de ${k} nao encontrado nos deployments`);
  }
  console.log("[deploy-remodel] base:", addr);

  // ------------------------------------------------ 1. CreditPSM
  const CreditPSM = await ethers.getContractFactory("CreditPSM");
  const psm = await CreditPSM.deploy(addr.credit, addr.usdc);
  await psm.waitForDeployment();
  console.log("[1/3] CreditPSM:", await psm.getAddress());

  // ------------------------------------------------ 2. ProjectFunding
  const ProjectFunding = await ethers.getContractFactory("ProjectFunding");
  const funding = await ProjectFunding.deploy(deployer.address, addr.credit, addr.registry, addr.staking);
  await funding.waitForDeployment();
  console.log("[2/3] ProjectFunding:", await funding.getAddress());

  // ------------------------------------------------ 3. FeeRouterV2
  const FeeRouterV2 = await ethers.getContractFactory("FeeRouterV2");
  const router = await FeeRouterV2.deploy(
    deployer.address,
    addr.credit,
    addr.registry,
    await funding.getAddress(),
    addr.treasury,
    addr.treasury,
    addr.treasury,
    FEE_BPS,
    FEE_SPLIT,
  );
  await router.waitForDeployment();
  console.log("[3/3] FeeRouterV2:", await router.getAddress());

  // ------------------------------------------------ roles
  // REVENUE_NOTIFIER pro router (deployer ainda e admin do funding).
  await (await funding.grantRole(await funding.REVENUE_NOTIFIER_ROLE(), await router.getAddress())).wait();

  // MINTER/BURNER do CREDIT pro PSM — precisa do Timelock (admin real).
  // Rede local: impersona (equivale a executar a proposta de governanca).
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr.timelock] });
  await network.provider.request({ method: "hardhat_setBalance", params: [addr.timelock, "0xDE0B6B3A7640000"] });
  const timelockSigner = await ethers.getSigner(addr.timelock);
  const credit = await ethers.getContractAt("CreditToken", addr.credit);
  await (await credit.connect(timelockSigner).grantRole(await credit.MINTER_ROLE(), await psm.getAddress())).wait();
  await (await credit.connect(timelockSigner).grantRole(await credit.BURNER_ROLE(), await psm.getAddress())).wait();
  await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr.timelock] });
  console.log("[roles] CREDIT MINTER+BURNER -> PSM; REVENUE_NOTIFIER -> FeeRouterV2");

  // Governanca dos contratos novos -> Timelock; deployer renuncia.
  for (const c of [funding, router]) {
    const GOV = await c.GOVERNANCE_ROLE();
    const ADMIN = await c.DEFAULT_ADMIN_ROLE();
    await (await c.grantRole(GOV, addr.timelock)).wait();
    await (await c.grantRole(ADMIN, addr.timelock)).wait();
    await (await c.renounceRole(GOV, deployer.address)).wait();
    await (await c.renounceRole(ADMIN, deployer.address)).wait();
  }
  console.log("[roles] governanca de Funding/RouterV2 -> Timelock (deployer renunciou)");

  // ------------------------------------------------ persistencia
  const merged = {
    ...dev,
    CreditPSM: await psm.getAddress(),
    ProjectFunding: await funding.getAddress(),
    FeeRouterV2: await router.getAddress(),
  };
  writeFileSync(devFile, JSON.stringify(merged, null, 2) + "\n");
  console.log("[persist] dev_addresses.json atualizado");
  console.log("\nPronto. Rode `npm run sync:contracts` no frontend.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
