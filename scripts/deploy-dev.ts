/**
 * deploy-dev.ts
 *
 * Fluxo end-to-end pro ambiente DEV (Hardhat local). Faz em um unico script:
 *
 *   1. Deploy de todos os contratos via Ignition (ou reusa se o container ja
 *      deployou no boot — ver docker/boot-node.sh).
 *   2. Minta 1_000_000 GOV para o deployer (Account #0).
 *   3. Minta 1_000_000 GOV para a Treasury (reserva on-chain da DAO — tem que
 *      acontecer ANTES do acceptOwnership, pois o deployer perde o poder de
 *      mint quando o Timelock assumir ownership).
 *   4. Deployer delega voto pra si mesmo.
 *   5. Cria proposta pro Timelock chamar `GovernanceToken.acceptOwnership()`.
 *   6. Avanca votingDelay, vota FOR, avanca votingPeriod, enfileira no Timelock,
 *      avanca timelockMinDelay, executa. No fim, o Timelock e owner do GOV.
 *   7. Deployer da `approve(Registry, minCollateral * 10)` em GOV, pra que uma
 *      proposta futura de `registerProject(deployer, ...)` possa puxar o
 *      colateral via `transferFrom` no momento do execute. Sem esse approve,
 *      o execute reverte com `InsufficientAllowance(0x2a1b2dd8)`.
 *   8. Cria uma segunda proposta: Treasury.transfer(CREDIT, deployer, 1_000_000e18).
 *      Essa e apenas CRIADA (sem voto/queue/execute) pra demonstrar o fluxo da UI.
 *
 * Uso:
 *   npx hardhat run scripts/deploy-dev.ts --network localhost
 *
 * Pre-requisitos:
 *   - Hardhat node rodando (estado in-memory).
 *   - Estado LIMPO: se ja rodou antes e o Timelock ja virou owner do GOV, o
 *     mint inicial falha. Reinicie o hardhat node pra zerar:
 *       docker restart web3c-hardhat
 */
import hre, { ethers } from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DeploymentParameters } from "@nomicfoundation/ignition-core";
import CommunityDAOModule from "../ignition/modules/Dao";

const DEV_VOTING_DELAY = 1n; // blocos
const DEV_VOTING_PERIOD = 50n; // blocos
const DEV_TIMELOCK_DELAY = 3_600n; // segundos
const MINT_AMOUNT = 1_000_000n * 10n ** 18n;

async function mine(blocks: number) {
  await hre.network.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
}

type Addresses = {
  gov: string;
  credit: string;
  timelock: string;
  treasury: string;
  governor: string;
  registry: string;
};

async function ensureDeployed(): Promise<Addresses> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployFile = resolve(
    __dirname,
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json",
  );

  // Se ja temos o deployed_addresses.json com codigo on-chain (o container
  // auto-deploya no boot), reusa. Isso evita que `hre.ignition.deploy()` tente
  // re-deployar em cima e gere enderecos duplicados.
  if (existsSync(deployFile)) {
    const raw = JSON.parse(readFileSync(deployFile, "utf8")) as Record<string, string>;
    const govAddr = raw["CommunityDAOModule#phaseA_GovernanceToken"];
    if (govAddr) {
      const code = await ethers.provider.getCode(govAddr);
      if (code !== "0x") {
        console.log("  reusando deploy existente (container ja rodou ignition)");
        return {
          gov: govAddr,
          credit: raw["CommunityDAOModule#phaseA_CreditToken"],
          timelock: raw["CommunityDAOModule#phaseA_CommunityTimelock"],
          treasury: raw["CommunityDAOModule#phaseA_Treasury"],
          governor: raw["CommunityDAOModule#phaseA_CommunityGovernor"],
          registry: raw["CommunityDAOModule#phaseA_ProjectRegistry"],
        };
      }
    }
  }

  // Deploy novo via Ignition (usa os mesmos parametros que o container usa).
  console.log("  deployando via Ignition…");
  const devParamsPath = resolve(__dirname, "..", "ignition", "parameters", "dev.json");
  const parameters = JSON.parse(readFileSync(devParamsPath, "utf8")) as DeploymentParameters;
  const deployed = await hre.ignition.deploy(CommunityDAOModule, { parameters });
  return {
    gov: await deployed.gov.getAddress(),
    credit: await deployed.credit.getAddress(),
    timelock: await deployed.timelock.getAddress(),
    treasury: await deployed.treasury.getAddress(),
    governor: await deployed.governor.getAddress(),
    registry: await deployed.registry.getAddress(),
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`deployer = ${deployer.address}`);

  // ---------- 1) Deploy ----------
  console.log("\n[1/8] garantindo contratos deployados…");
  const addrs = await ensureDeployed();

  const gov = await ethers.getContractAt("GovernanceToken", addrs.gov);
  const credit = await ethers.getContractAt("CreditToken", addrs.credit);
  const treasury = await ethers.getContractAt("Treasury", addrs.treasury);
  const governor = await ethers.getContractAt("CommunityGovernor", addrs.governor);
  const registry = await ethers.getContractAt("ProjectRegistry", addrs.registry);

  console.log(`  GOV        = ${addrs.gov}`);
  console.log(`  CREDIT     = ${addrs.credit}`);
  console.log(`  Timelock   = ${addrs.timelock}`);
  console.log(`  Treasury   = ${addrs.treasury}`);
  console.log(`  Governor   = ${addrs.governor}`);
  console.log(`  Registry   = ${addrs.registry}`);

  // ---------- 2) Mint 1M GOV pro deployer ----------
  console.log(`\n[2/8] mint ${MINT_AMOUNT / 10n ** 18n} GOV -> deployer…`);
  const currentOwner = await gov.owner();
  if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `deployer nao e mais owner do GOV (owner=${currentOwner}). Reinicie o hardhat node pra zerar estado: docker restart web3c-hardhat`,
    );
  }
  await (await gov.mint(deployer.address, MINT_AMOUNT, "deploy-dev:deployer")).wait();
  const bal: bigint = await gov.balanceOf(deployer.address);
  console.log(`  balance = ${ethers.formatEther(bal)} GOV`);

  // ---------- 3) Mint 1M GOV pra Treasury (reserva DA DAO) ----------
  // Tem que rodar ANTES do acceptOwnership — depois que o Timelock vira owner,
  // qualquer mint novo exige uma proposta de governanca. Esse saldo permite que
  // a DAO distribua GOV em propostas futuras (rewards, contributor grants,
  // buyback inverso, etc) sem precisar refazer o 2-step de ownership.
  console.log(`\n[3/8] mint ${MINT_AMOUNT / 10n ** 18n} GOV -> Treasury…`);
  await (await gov.mint(addrs.treasury, MINT_AMOUNT, "deploy-dev:treasury-reserve")).wait();
  const treasuryGov: bigint = await gov.balanceOf(addrs.treasury);
  console.log(`  treasury GOV balance = ${ethers.formatEther(treasuryGov)}`);

  // ---------- 4) Delega voto pra si mesmo ----------
  console.log("\n[4/8] delegate votes -> self…");
  await (await gov.delegate(deployer.address)).wait();
  await mine(1); // snapshot precisa de >=1 bloco apos delegate
  const votes: bigint = await gov.getVotes(deployer.address);
  console.log(`  voting power = ${ethers.formatEther(votes)} GOV`);

  // ---------- 5) Propoe acceptOwnership ----------
  console.log("\n[5/8] proposta 1: GovernanceToken.acceptOwnership()…");
  const acceptCalldata = gov.interface.encodeFunctionData("acceptOwnership");
  const description1 =
    "# DAO assume ownership do GOV\n\nTimelock chama `acceptOwnership()` no GovernanceToken, completando a transferencia 2-step iniciada no deploy.";
  const descriptionHash1 = ethers.id(description1);

  const proposeTx1 = await governor.propose([addrs.gov], [0], [acceptCalldata], description1);
  const receipt1 = await proposeTx1.wait();
  const proposalId1 = (
    receipt1!.logs as Array<{ fragment?: { name: string }; args?: { proposalId: bigint } }>
  )
    .filter((l) => l.fragment?.name === "ProposalCreated")
    .map((l) => l.args!.proposalId)[0];
  console.log(`  proposalId = ${proposalId1}`);

  // ---------- 6) Vote -> Queue -> Execute ----------
  console.log("\n[6/8] vote FOR -> queue -> execute…");

  await mine(Number(DEV_VOTING_DELAY) + 1);
  await (await governor.castVote(proposalId1, 1)).wait();
  console.log("  voted FOR");

  await mine(Number(DEV_VOTING_PERIOD));
  console.log("  votingPeriod concluido");

  await (await governor.queue([addrs.gov], [0], [acceptCalldata], descriptionHash1)).wait();
  console.log("  enfileirado no Timelock");

  await hre.network.provider.send("evm_increaseTime", [Number(DEV_TIMELOCK_DELAY) + 1]);
  await mine(1);

  await (await governor.execute([addrs.gov], [0], [acceptCalldata], descriptionHash1)).wait();
  const newOwner = await gov.owner();
  const ok = newOwner.toLowerCase() === addrs.timelock.toLowerCase();
  console.log(`  executado. GOV.owner() = ${newOwner} ${ok ? "(Timelock OK)" : "(ERRO)"}`);

  // ---------- 7) Approve Registry pro deployer conseguir registrar um projeto ----------
  // Em `ProjectRegistry.registerProject(owner, uri, collateralAmount)`, o
  // Registry puxa `collateralAmount` de GOV do `owner` via `transferFrom` no
  // momento em que o Timelock executa. O owner da chamada (no nosso caso, o
  // deployer) precisa ter aprovado o Registry ANTES — senao o execute reverte
  // com `InsufficientAllowance(0x2a1b2dd8)` (selector que aparece no front).
  // Aprovamos 10x o minCollateral pra cobrir varias proposals sem refresh.
  console.log("\n[7/8] approve Registry pra puxar colateral GOV do deployer…");
  const minCollateral: bigint = await registry.minCollateral();
  const approveAmount = minCollateral * 10n;
  await (await gov.approve(addrs.registry, approveAmount)).wait();
  const allowance: bigint = await gov.allowance(deployer.address, addrs.registry);
  console.log(
    `  minCollateral = ${ethers.formatEther(minCollateral)} GOV; allowance setada = ${ethers.formatEther(allowance)} GOV`,
  );

  // ---------- 8) Proposta 2: pagar 1M CREDIT ao deployer ----------
  console.log("\n[8/8] proposta 2: Treasury.transfer(CREDIT, deployer, 1_000_000e18)…");

  const treasuryCredit: bigint = await credit.balanceOf(addrs.treasury);
  console.log(`  treasury CREDIT balance = ${ethers.formatEther(treasuryCredit)}`);
  if (treasuryCredit < MINT_AMOUNT) {
    throw new Error("Treasury nao tem CREDIT suficiente (esperava >= 1M do genesis).");
  }

  const payCalldata = treasury.interface.encodeFunctionData("transfer", [
    addrs.credit,
    deployer.address,
    MINT_AMOUNT,
  ]);
  const description2 = `# Pagar 1M CREDIT ao deployer\n\nTreasury.transfer do CREDIT token: 1_000_000 CREDIT -> ${deployer.address}.`;

  const proposeTx2 = await governor.propose([addrs.treasury], [0], [payCalldata], description2);
  const receipt2 = await proposeTx2.wait();
  const proposalId2 = (
    receipt2!.logs as Array<{ fragment?: { name: string }; args?: { proposalId: bigint } }>
  )
    .filter((l) => l.fragment?.name === "ProposalCreated")
    .map((l) => l.args!.proposalId)[0];
  console.log(`  proposalId = ${proposalId2}`);
  console.log("  proposta CRIADA (sem voto/queue/execute — use a UI pra levar adiante)");

  console.log("\npronto. fluxo completo:");
  console.log(`  - 1M GOV no deployer (${deployer.address})`);
  console.log(`  - 1M GOV na Treasury  (${addrs.treasury})`);
  console.log(`  - GOV owner = Timelock (${addrs.timelock})`);
  console.log(`  - proposta #1 (acceptOwnership): EXECUTADA`);
  console.log(`  - deployer approve Registry em ${ethers.formatEther(approveAmount)} GOV`);
  console.log(`  - proposta #2 (pagar 1M CREDIT): AGUARDANDO voto na UI`);

  console.log("\npra que a proposta #2 seja EXECUTADA, precisa na ordem:");
  console.log(`  1. votingDelay   — aguardar ${DEV_VOTING_DELAY} bloco(s) (snapshot ativa).`);
  console.log(`  2. castVote(FOR) — alguem com voting power precisa votar a favor.`);
  console.log(`                     quorum = 4% do supply ativo de GOV snapshotado.`);
  console.log(`                     como o deployer delegou 1M GOV pra si e o supply`);
  console.log(`                     total de GOV no momento do snapshot e 2M (1M deployer +`);
  console.log(`                     1M Treasury, nao delegado), basta o deployer votar FOR.`);
  console.log(`  3. votingPeriod  — aguardar ${DEV_VOTING_PERIOD} blocos ate a votacao fechar.`);
  console.log(`  4. queue()       — enfileira no Timelock (requer state=Succeeded).`);
  console.log(`  5. timelockDelay — aguardar ${DEV_TIMELOCK_DELAY}s (1h em dev).`);
  console.log(`  6. execute()     — Timelock chama Treasury.transfer.`);
  console.log(`                     Treasury precisa de >= 1M CREDIT (tem 10M do genesis) e`);
  console.log(`                     GOVERNANCE_ROLE ja esta concedida ao Timelock (fase C).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
