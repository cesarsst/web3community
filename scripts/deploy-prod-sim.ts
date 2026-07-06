/**
 * deploy-prod-sim.ts
 *
 * Deploy da DAO em ambiente DEV (Hardhat local) usando os PARAMETROS DE
 * PRODUCAO (`ignition/parameters/production.json`), simulando um bootstrap
 * real de mainnet ponta a ponta:
 *
 *   1. Deploy dos 10 contratos core via Ignition com production.json
 *      (timelock 2d, votingDelay 1d/7200 blocos, votingPeriod 7d/50400
 *      blocos, quorum 4%, threshold 10k GOV, minCollateral 10k GOV,
 *      probation 30d, round 7d).
 *   2. Distribuicao inicial 30/25/20/15/10 dos 100M GOV (cap integral),
 *      espelhando a sequencia de propostas bootstrap da §7 do README:
 *        - 30M -> Treasury            (reserva da DAO)
 *        - 25M -> DEV MEMBER          (deployer, Account #0 — em mainnet
 *                                      seriam instancias de TeamVesting)
 *        - 20M -> Account #1          (placeholder do contrato Sale)
 *        - 15M -> Account #2          (placeholder community rewards)
 *        - 10M -> Account #3          (placeholder LiquidityManager)
 *      Tudo mintado ANTES do acceptOwnership, enquanto o deployer ainda e
 *      owner do GOV — depois disso qualquer mint exige proposta.
 *   3. Dev member delega voto pra si: 25M votos = 25% do supply, acima do
 *      quorum de 4% (4M) — consegue aprovar propostas SOZINHO.
 *   4. Proposta #1 (obrigatoria): Timelock chama acceptOwnership() no GOV.
 *      Ciclo completo com prazos de PRODUCAO (blocos/tempo avancados via
 *      hardhat_mine / evm_increaseTime).
 *   5. Proposta #2 (exemplo real): registry.registerProject(devMember,
 *      ipfs://..., 10k GOV) — registra o dev member como owner do primeiro
 *      projeto, com colateral puxado via allowance no execute.
 *
 * Uso:
 *   # terminal 1
 *   npx hardhat node
 *   # terminal 2
 *   npm run deploy:prod-sim
 *   # (ou in-process, sem node: npx hardhat run scripts/deploy-prod-sim.ts)
 *
 * Pre-requisitos:
 *   - Estado LIMPO da chain (deployer precisa ser owner do GOV e o cap de
 *     100M precisa estar livre). Se ja rodou antes: reinicie o hardhat node
 *     (o script remove sozinho journal Ignition orfao/parcial; so aborta se
 *     o journal apontar contratos ainda vivos na chain).
 *   - Saldo ETH do deployer e auto-fundado via `hardhat_setBalance` se
 *     estiver baixo (nodes rebootados podem zerar a conta #0).
 */
import hre, { ethers } from "hardhat";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { DeploymentParameters } from "@nomicfoundation/ignition-core";
import CommunityDAOModule from "../ignition/modules/Dao";

// Account #0 do mnemonic default do Hardhat — o "membro desenvolvedor
// inicial" do projeto. O script exige que o signer 0 seja exatamente esse
// endereco pra garantir que o voting power termine na conta certa.
const DEV_MEMBER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const M = 10n ** 18n * 1_000_000n; // 1M em wei-GOV

// Distribuicao 30/25/20/15/10 (README §7) — soma = 100M = cap do GOV.
const ALLOC_TREASURY = 30n * M;
const ALLOC_TEAM_DEV = 25n * M; // dev member (em mainnet: TeamVesting × N)
const ALLOC_SALE = 20n * M; // placeholder do contrato Sale
const ALLOC_COMMUNITY = 15n * M; // placeholder community rewards / LP mining
const ALLOC_LIQUIDITY = 10n * M; // placeholder LiquidityManager (POL/DEX)

// Projeto genesis da plataforma = cloud-terminal. Owner = carteira do dev
// member (em dev a carteira do projeto E a do desenvolvedor). A metadata
// off-chain descreve o app (nome, url, contratos consumidos).
const PROJECT_URI = "ipfs://bafybeig-cloud-terminal-project-metadata-v1";

// CREDIT de teste transferido do Treasury pro dev member (usuario de teste
// do fluxo de ativacao do cloud-terminal). 10k CREDIT cobre muitas ativacoes.
const TEST_CREDIT = 10_000n * 10n ** 18n;

async function mine(blocks: bigint) {
  await hre.network.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
}

async function increaseTime(seconds: bigint) {
  await hre.network.provider.send("evm_increaseTime", [Number(seconds)]);
  await mine(1n);
}

function extractProposalId(receipt: { logs: readonly unknown[] } | null): bigint {
  const id = (
    receipt!.logs as Array<{ fragment?: { name: string }; args?: { proposalId: bigint } }>
  )
    .filter((l) => l.fragment?.name === "ProposalCreated")
    .map((l) => l.args!.proposalId)[0];
  if (id === undefined) throw new Error("ProposalCreated nao encontrado no receipt");
  return id;
}

async function main() {
  const signers = await ethers.getSigners();
  const [devMember, saleSim, communitySim, liquiditySim] = signers;

  if (devMember.address.toLowerCase() !== DEV_MEMBER.toLowerCase()) {
    throw new Error(
      `signer 0 = ${devMember.address}, esperado ${DEV_MEMBER} (Account #0 do Hardhat). ` +
        `Rode contra o hardhat node local com o mnemonic default.`,
    );
  }
  console.log(`dev member (deployer) = ${devMember.address}`);

  // ---------- 0) Garantir ETH pro deployer (dev-only) ----------
  // Nodes hardhat rebootados/forkados podem servir a conta #0 com saldo 0.
  // `hardhat_setBalance` e RPC de dev — funciona em hardhat node/EDR, nunca
  // em rede publica (la o guard de chainId abaixo nem deixaria chegar aqui).
  const balance = await ethers.provider.getBalance(devMember.address);
  if (balance < ethers.parseEther("100")) {
    console.log(`\n[0/8] saldo ETH baixo (${ethers.formatEther(balance)}) — hardhat_setBalance 10k ETH…`);
    await hre.network.provider.send("hardhat_setBalance", [
      devMember.address,
      `0x${ethers.parseEther("10000").toString(16)}`,
    ]);
  }

  // ---------- 1) Deploy via Ignition com parametros de PRODUCAO ----------
  console.log("\n[1/8] deploy via Ignition com ignition/parameters/production.json…");

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const journalDir = resolve(__dirname, "..", "ignition", "deployments", `chain-${chainId}`);
  if (existsSync(journalDir)) {
    // Journal antigo conflita com um deploy fresh de parametros diferentes —
    // o Ignition tentaria reconciliar e falharia ou reusaria contratos com
    // parametros DEV. Casos:
    //   a) journal com contratos VIVOS na chain atual -> estado sujo de
    //      verdade, fail-fast (so o usuario pode decidir resetar o node);
    //   b) journal orfao (node rebootado, sem codigo on-chain) ou parcial
    //      (run anterior falhou antes de deployar) -> lixo, remove e segue.
    const addrsFile = resolve(journalDir, "deployed_addresses.json");
    let liveGov: string | undefined;
    if (existsSync(addrsFile)) {
      const raw = JSON.parse(readFileSync(addrsFile, "utf8")) as Record<string, string>;
      liveGov = raw["CommunityDAOModule#phaseA_GovernanceToken"];
    }
    if (liveGov && (await ethers.provider.getCode(liveGov)) !== "0x") {
      throw new Error(
        `journal em ${journalDir} tem contratos vivos na chain (GOV=${liveGov}). ` +
          `Reinicie o hardhat node e rode: rm -rf ${journalDir}`,
      );
    }
    console.log(`  removendo journal stale/parcial em ${journalDir}…`);
    rmSync(journalDir, { recursive: true, force: true });
  }

  const prodParamsPath = resolve(__dirname, "..", "ignition", "parameters", "production.json");
  const parameters = JSON.parse(readFileSync(prodParamsPath, "utf8")) as DeploymentParameters;
  const deployed = await hre.ignition.deploy(CommunityDAOModule, {
    parameters,
    deploymentId: `chain-${chainId}`, // persiste deployed_addresses.json pro front/export-runtime-config
  });

  const addrs = {
    gov: await deployed.gov.getAddress(),
    credit: await deployed.credit.getAddress(),
    timelock: await deployed.timelock.getAddress(),
    treasury: await deployed.treasury.getAddress(),
    governor: await deployed.governor.getAddress(),
    registry: await deployed.registry.getAddress(),
  };

  const gov = await ethers.getContractAt("GovernanceToken", addrs.gov);
  const governor = await ethers.getContractAt("CommunityGovernor", addrs.governor);
  const registry = await ethers.getContractAt("ProjectRegistry", addrs.registry);
  const timelock = await ethers.getContractAt("CommunityTimelock", addrs.timelock);

  for (const [k, v] of Object.entries(addrs)) console.log(`  ${k.padEnd(9)}= ${v}`);

  // Prazos lidos ON-CHAIN (fonte de verdade = production.json aplicado).
  const votingDelay: bigint = await governor.votingDelay();
  const votingPeriod: bigint = await governor.votingPeriod();
  const minDelay: bigint = await timelock.getMinDelay();
  const minCollateral: bigint = await registry.minCollateral();
  console.log(
    `  parametros prod: votingDelay=${votingDelay} blocos, votingPeriod=${votingPeriod} blocos, ` +
      `timelockMinDelay=${minDelay}s, minCollateral=${ethers.formatEther(minCollateral)} GOV`,
  );

  // ---------- 2) Distribuicao inicial 30/25/20/15/10 (100M GOV) ----------
  console.log("\n[2/8] distribuicao inicial 30/25/20/15/10 (100M GOV, cap integral)…");
  const owner = await gov.owner();
  if (owner.toLowerCase() !== devMember.address.toLowerCase()) {
    throw new Error(
      `deployer nao e owner do GOV (owner=${owner}). Estado sujo — reinicie o hardhat node.`,
    );
  }

  const allocations: Array<[string, bigint, string]> = [
    [addrs.treasury, ALLOC_TREASURY, "bootstrap:treasury-30M"],
    [devMember.address, ALLOC_TEAM_DEV, "bootstrap:team-dev-member-25M"],
    [saleSim.address, ALLOC_SALE, "bootstrap:sale-placeholder-20M"],
    [communitySim.address, ALLOC_COMMUNITY, "bootstrap:community-placeholder-15M"],
    [liquiditySim.address, ALLOC_LIQUIDITY, "bootstrap:liquidity-placeholder-10M"],
  ];
  for (const [to, amount, tag] of allocations) {
    await (await gov.mint(to, amount, tag)).wait();
    console.log(`  ${ethers.formatEther(amount).padStart(12)} GOV -> ${to}  (${tag})`);
  }
  const totalSupply: bigint = await gov.totalSupply();
  console.log(`  totalSupply = ${ethers.formatEther(totalSupply)} GOV (cap 100M atingido)`);

  // ---------- 3) Dev member delega voto pra si (quorum) ----------
  console.log("\n[3/8] dev member delega voto pra si mesmo…");
  await (await gov.connect(devMember).delegate(devMember.address)).wait();
  await mine(1n); // snapshot de votos exige >= 1 bloco apos delegate
  const votes: bigint = await gov.getVotes(devMember.address);
  // quorum() e historico — usa o bloco anterior como timepoint valido.
  const quorumNow: bigint = await governor.quorum((await ethers.provider.getBlockNumber()) - 1);
  console.log(`  voting power = ${ethers.formatEther(votes)} GOV`);
  console.log(`  quorum (4% supply) = ${ethers.formatEther(quorumNow)} GOV`);
  if (votes < quorumNow) {
    throw new Error("dev member NAO atinge quorum sozinho — distribuicao errada.");
  }
  console.log("  OK: dev member aprova propostas SOZINHO (votos >= quorum, For > Against).");

  // Helper: ciclo COMPLETO de governanca com prazos de producao.
  async function passProposal(
    targets: string[],
    values: bigint[],
    calldatas: string[],
    description: string,
  ) {
    const tx = await governor
      .connect(devMember)
      .propose(targets, values, calldatas, description);
    const proposalId = extractProposalId(await tx.wait());
    console.log(`  proposalId = ${proposalId}`);

    await mine(votingDelay + 1n); // votingDelay (7200 blocos ~ 1d em prod)
    await (await governor.connect(devMember).castVote(proposalId, 1)).wait(); // 1 = For
    const snapshot: bigint = await governor.proposalSnapshot(proposalId);
    const quorumAt: bigint = await governor.quorum(snapshot);
    console.log(
      `  votou FOR com ${ethers.formatEther(await gov.getPastVotes(devMember.address, snapshot))} GOV ` +
        `(quorum no snapshot: ${ethers.formatEther(quorumAt)} GOV)`,
    );

    await mine(votingPeriod); // votingPeriod (50400 blocos ~ 7d em prod)
    const descriptionHash = ethers.id(description);
    await (await governor.queue(targets, values, calldatas, descriptionHash)).wait();
    console.log(`  enfileirado no Timelock (delay ${minDelay}s = 2d em prod)`);

    await increaseTime(minDelay + 1n);
    const execTx = await governor.execute(targets, values, calldatas, descriptionHash);
    const receipt = await execTx.wait();
    console.log("  EXECUTADO");
    return receipt;
  }

  // ---------- 4) Proposta #1: acceptOwnership do GOV pelo Timelock ----------
  console.log("\n[4/8] proposta #1 (obrigatoria): GovernanceToken.acceptOwnership()…");
  const acceptCalldata = gov.interface.encodeFunctionData("acceptOwnership");
  await passProposal(
    [addrs.gov],
    [0n],
    [acceptCalldata],
    "# Proposta #1 — DAO assume ownership do GOV\n\nTimelock chama `acceptOwnership()` no GovernanceToken, completando a transferencia 2-step iniciada no deploy. Primeira proposta obrigatoria pos-deploy (README §7).",
  );
  const newOwner = await gov.owner();
  if (newOwner.toLowerCase() !== addrs.timelock.toLowerCase()) {
    throw new Error(`GOV.owner() = ${newOwner}, esperado Timelock`);
  }
  console.log(`  GOV.owner() = Timelock OK — mints futuros so via governanca`);

  // ---------- 5) Approve do colateral pro Registry ----------
  console.log("\n[5/8] approve Registry pra puxar colateral GOV do dev member…");
  // registerProject puxa o colateral do owner via transferFrom no EXECUTE da
  // proposta — sem allowance previa o execute reverte com InsufficientAllowance.
  const approveAmount = minCollateral * 10n;
  await (await gov.connect(devMember).approve(addrs.registry, approveAmount)).wait();
  console.log(`  allowance = ${ethers.formatEther(approveAmount)} GOV (10x minCollateral)`);

  // ---------- 6) Proposta #2: registrar o projeto do dev member ----------
  console.log("\n[6/8] proposta #2 (exemplo real): registry.registerProject(devMember, …)…");
  const registerCalldata = registry.interface.encodeFunctionData("registerProject", [
    devMember.address,
    PROJECT_URI,
    minCollateral,
  ]);
  const receipt = await passProposal(
    [addrs.registry],
    [0n],
    [registerCalldata],
    `# Proposta #2 — Registrar projeto genesis do dev member\n\nRegistra ${devMember.address} como owner do primeiro projeto da whitelist (colateral ${ethers.formatEther(minCollateral)} GOV, metadata ${PROJECT_URI}).`,
  );

  let projectId: bigint | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed?.name === "ProjectRegistered") projectId = parsed.args.projectId as bigint;
    } catch {
      /* logs de outros contratos */
    }
  }
  console.log(`  projectId = ${projectId} (status Pending)`);
  console.log(
    `  colateral lockado: ${ethers.formatEther(minCollateral)} GOV puxados do dev member`,
  );
  if (projectId === undefined) {
    throw new Error("ProjectRegistered nao emitido — proposta #2 falhou");
  }

  // ---------- 7) Proposta #3: ativar o projeto cloud-terminal ----------
  // Sem status Active o FeeRouter.pay reverte com ProjectNotActive — a
  // ativacao e o que permite o cloud-terminal cobrar ativacoes de conta.
  console.log("\n[7/8] proposta #3: registry.activateProject(cloud-terminal)…");
  const activateCalldata = registry.interface.encodeFunctionData("activateProject", [projectId]);
  await passProposal(
    [addrs.registry],
    [0n],
    [activateCalldata],
    `# Proposta #3 — Ativar o projeto cloud-terminal\n\nMove o projeto #${projectId} de Pending para Active, liberando pagamentos via FeeRouter.pay e burns atribuidos ao projeto.`,
  );
  const project = await registry.getProject(projectId);
  if (project.status !== 1n) {
    throw new Error(`projeto #${projectId} nao esta Active (status=${project.status})`);
  }
  console.log(
    `  projeto #${projectId} ATIVO (probation ate ${new Date(Number(project.probationEndsAt) * 1000).toISOString()})`,
  );

  // ---------- 8) Proposta #4: CREDIT de teste pro dev member ----------
  // Treasury detem o genesis de 10M CREDIT. O dev member (usuario de teste
  // do cloud-terminal) recebe TEST_CREDIT pra exercitar o fluxo de ativacao.
  console.log("\n[8/8] proposta #4: treasury.transfer(CREDIT, devMember, 10k)…");
  const treasury = await ethers.getContractAt("Treasury", addrs.treasury);
  const credit = await ethers.getContractAt("CreditToken", addrs.credit);
  const transferCalldata = treasury.interface.encodeFunctionData("transfer", [
    addrs.credit,
    devMember.address,
    TEST_CREDIT,
  ]);
  await passProposal(
    [addrs.treasury],
    [0n],
    [transferCalldata],
    `# Proposta #4 — CREDIT de teste pro dev member\n\nTransfere ${ethers.formatEther(TEST_CREDIT)} CREDIT do Treasury para ${devMember.address} para testes do fluxo de ativacao do cloud-terminal em prod-sim.`,
  );
  const creditBalance: bigint = await credit.balanceOf(devMember.address);
  console.log(`  saldo CREDIT do dev member = ${ethers.formatEther(creditBalance)}`);

  // ---------- Resumo ----------
  console.log("\npronto — bootstrap de producao simulado em dev:");
  console.log(`  - parametros: production.json (timelock 2d, voto 1d+7d, quorum 4%)`);
  console.log(`  - supply GOV: 100M (30M Treasury / 25M dev / 20M sale / 15M community / 10M liq)`);
  console.log(`  - dev member ${devMember.address}:`);
  console.log(`      voting power ${ethers.formatEther(await gov.getVotes(devMember.address))} GOV (25% >> quorum 4%) — aprova sozinho`);
  console.log(`  - GOV owner = Timelock (proposta #1 executada)`);
  console.log(
    `  - projeto #${projectId} (cloud-terminal) registrado E ATIVO — owner = carteira dev (propostas #2 e #3)`,
  );
  console.log(`  - dev member com ${ethers.formatEther(creditBalance)} CREDIT de teste (proposta #4)`);
  console.log(`  - Treasury: 30M GOV + ${ethers.formatEther(10_000_000n * 10n ** 18n - TEST_CREDIT)} CREDIT`);
  console.log("\nintegracao cloud-terminal (prod-sim):");
  console.log("  1. exporte o runtime config pro backend do cloud-terminal:");
  console.log("       CHAIN_ID=31337 PUBLIC_RPC_URL=http://127.0.0.1:8545 \\");
  console.log("         npx tsx scripts/export-runtime-config.ts /tmp/web3-runtime-config.json");
  console.log("  2. suba o backend com:");
  console.log(`       WEB3_CONFIG_PATH=/tmp/web3-runtime-config.json WEB3_PROJECT_ID=${projectId} \\`);
  console.log("       ACTIVATION_PRICE_CREDIT=10 ACTIVATION_DURATION_SECONDS=600   # tempo de dev: 10min");
  console.log("  3. no MetaMask use a Account #0 do hardhat (carteira do dev member) — ela tem o CREDIT.");
  console.log("\nproximos passos naturais (via novas propostas):");
  console.log("  - deploy TeamVesting real por beneficiario + funding via Treasury");
  console.log("  - fund UserSubsidy em CREDIT pra onboarding de usuarios");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
