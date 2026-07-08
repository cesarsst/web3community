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
 *   6. Propostas #3/#4: activateProject(cloud-terminal) + CREDIT de teste.
 *   7. Fase 1 do pivot CLP (DEPLOY_CLP_PHASE1 default true aqui): deploy de
 *      LiquidityGauge + RewardDistributorV2 via Ignition (mocks Uniswap
 *      locais pro constructor do gauge), proposta #5 de wiring/migracao
 *      (MINTER V2, cutoff V1, notifier, depositors, pool, Treasury->gauge).
 *   8. Stake de 1M GOV do dev member no projeto #1 (lock 365d, 4x) e seed
 *      de burn via FeeRouter.pay — dados reais pro frontend.
 *   9. Ciclo completo de rewards V2: propostas #6/#7 (closeRound) +
 *      finalizeRound(0..1) + claim do bucket stakers.
 *  10. Infra dev de mercado (rede local): USDC mock + DevSwapPool
 *      (AMM CREDIT/USDC que alimenta TWAP) + CreditPriceOracle (feed
 *      Chainlink = 0x0 -> 1 USDC = 1 USD) + DevFaucet (ETH+CREDIT+USDC).
 *      Proposta #8 funda o faucet/seed via Treasury e aponta
 *      setPriceOracle/setSwapRouter pro par dev — buyback funcional.
 *      Enderecos extras persistidos em ignition/deployments/
 *      chain-<id>/dev_addresses.json (mesclados pelo export-runtime-config).
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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DeploymentParameters } from "@nomicfoundation/ignition-core";
// ATENCAO: o modulo Ignition e importado DINAMICAMENTE dentro de main().
// A flag DEPLOY_CLP_PHASE1 e lida no build do modulo (import-time) — um
// import estatico aqui rodaria antes de setarmos a flag abaixo.

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

// Stake do dev member no projeto #1 (cloud-terminal): 1M GOV com lock de
// 365 dias = multiplier 4x (MAX_LOCK do Staking).
const STAKE_AMOUNT = 1_000_000n * 10n ** 18n;
const STAKE_LOCK = 365n * 24n * 3600n;

// Seed de burn pro ciclo de rewards V2: pagamento de 100 CREDIT no FeeRouter
// atribuido ao projeto #1 na rodada 0 (70% queima com o split default).
const SEED_PAYMENT = 100n * 10n ** 18n;

// Pool "CREDIT/USDC" whitelistada no LiquidityGauge. Endereco arbitrario —
// o gauge nao chama metodos da pool (mesmo padrao dos testes unitarios).
const MOCK_POOL = "0x" + "11".repeat(20);

// ---------- Infra dev de mercado (steps 13-15) ----------
// Seed da DevSwapPool: 500k CREDIT / 50k USDC => preco inicial $0.10/CREDIT.
const POOL_SEED_CREDIT = 500_000n * 10n ** 18n;
const POOL_SEED_USDC = 50_000n * 10n ** 6n; // USDC mock tem 6 decimais

// Funding do DevFaucet.
const FAUCET_CREDIT = 100_000n * 10n ** 18n;
const FAUCET_USDC = 100_000n * 10n ** 6n;
const FAUCET_ETH = 500n * 10n ** 18n;

// Drip por claim: 1 ETH (gas) + 100 CREDIT (10 ativacoes de 10) + 250 USDC
// (compras na pool). Cooldown curto — e uma rede local.
const DRIP_ETH = 1n * 10n ** 18n;
const DRIP_CREDIT = 100n * 10n ** 18n;
const DRIP_USDC = 250n * 10n ** 6n;
const DRIP_COOLDOWN = 300n; // 5 min

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
  // Liga o deploy da Fase 1 do pivot CLP (LiquidityGauge + RewardDistributorV2)
  // ANTES do import do modulo Ignition — a flag e lida no build do modulo.
  process.env.DEPLOY_CLP_PHASE1 = process.env.DEPLOY_CLP_PHASE1 ?? "true";
  const { default: CommunityDAOModule } = await import("../ignition/modules/Dao");

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
    console.log(`\n[0/15] saldo ETH baixo (${ethers.formatEther(balance)}) — hardhat_setBalance 10k ETH…`);
    await hre.network.provider.send("hardhat_setBalance", [
      devMember.address,
      `0x${ethers.parseEther("10000").toString(16)}`,
    ]);
  }

  // ---------- 1) Deploy via Ignition com parametros de PRODUCAO ----------
  console.log("\n[1/15] deploy via Ignition com ignition/parameters/production.json…");

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

  // Periferia Uniswap V3 nao existe em chain local — mocks (mesmos dos testes
  // unitarios) satisfazem os constructors do LiquidityGauge. Deployados FORA
  // do Ignition pra manter o modulo identico ao de mainnet.
  console.log("  deploy de mocks Uniswap (staker + positionManager) pro LiquidityGauge…");
  const NPMMock = await ethers.getContractFactory("NonfungiblePositionManagerERC721Mock");
  const npmMock = await NPMMock.deploy();
  await npmMock.waitForDeployment();
  const StakerMock = await ethers.getContractFactory("UniswapV3StakerMock");
  const stakerMock = await StakerMock.deploy();
  await stakerMock.waitForDeployment();
  await (await stakerMock.setPositionManager(await npmMock.getAddress())).wait();

  const prodParamsPath = resolve(__dirname, "..", "ignition", "parameters", "production.json");
  const parameters = JSON.parse(readFileSync(prodParamsPath, "utf8")) as DeploymentParameters;
  const moduleParams = parameters.CommunityDAOModule as Record<string, unknown>;
  moduleParams.uniswapV3Staker = await stakerMock.getAddress();
  moduleParams.positionManager = await npmMock.getAddress();

  const deployed = await hre.ignition.deploy(CommunityDAOModule, {
    parameters,
    deploymentId: `chain-${chainId}`, // persiste deployed_addresses.json pro front/export-runtime-config
  });

  if (!deployed.liquidityGauge || !deployed.distributorV2) {
    throw new Error(
      "LiquidityGauge/RewardDistributorV2 nao deployados — DEPLOY_CLP_PHASE1 nao chegou ao modulo Ignition.",
    );
  }

  const addrs = {
    gov: await deployed.gov.getAddress(),
    credit: await deployed.credit.getAddress(),
    timelock: await deployed.timelock.getAddress(),
    treasury: await deployed.treasury.getAddress(),
    governor: await deployed.governor.getAddress(),
    registry: await deployed.registry.getAddress(),
    staking: await deployed.staking.getAddress(),
    burnTracker: await deployed.burnTracker.getAddress(),
    feeRouter: await deployed.feeRouter.getAddress(),
    distributorV1: await deployed.distributor.getAddress(),
    gauge: await deployed.liquidityGauge.getAddress(),
    distributorV2: await deployed.distributorV2.getAddress(),
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
  console.log("\n[2/15] distribuicao inicial 30/25/20/15/10 (100M GOV, cap integral)…");
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
  console.log("\n[3/15] dev member delega voto pra si mesmo…");
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
  console.log("\n[4/15] proposta #1 (obrigatoria): GovernanceToken.acceptOwnership()…");
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
  console.log("\n[5/15] approve Registry pra puxar colateral GOV do dev member…");
  // registerProject puxa o colateral do owner via transferFrom no EXECUTE da
  // proposta — sem allowance previa o execute reverte com InsufficientAllowance.
  const approveAmount = minCollateral * 10n;
  await (await gov.connect(devMember).approve(addrs.registry, approveAmount)).wait();
  console.log(`  allowance = ${ethers.formatEther(approveAmount)} GOV (10x minCollateral)`);

  // ---------- 6) Proposta #2: registrar o projeto do dev member ----------
  console.log("\n[6/15] proposta #2 (exemplo real): registry.registerProject(devMember, …)…");
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
  console.log("\n[7/15] proposta #3: registry.activateProject(cloud-terminal)…");
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
  console.log("\n[8/15] proposta #4: treasury.transfer(CREDIT, devMember, 10k)…");
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

  // ---------- 9) Proposta #5: wiring da Fase 1.4 (RewardDistributorV2) ----------
  // Espelha docs/governance/fase1-4-bucket-split.md (propostas #2/#3/#5 de
  // migracao, comprimidas em um batch — prod-sim nao precisa da janela de
  // 4 rounds de coexistencia V1/V2):
  //   1. CREDIT.grantRole(MINTER_ROLE, V2)      — V2 mint no finalizeRound
  //   2. CREDIT.revokeRole(MINTER_ROLE, V1)     — cutoff: evita dupla emissao
  //   3. Gauge.grantRole(REWARD_NOTIFIER_ROLE, V2) — bucket LPs via notify
  //   4. Treasury.grantRole(POL_REFILL_DEPOSITOR_ROLE, V2)     — bucket bonders
  //   5. Treasury.grantRole(GAUGE_FALLBACK_DEPOSITOR_ROLE, V2) — gauge paused
  //   6. Gauge.addPool(MOCK_POOL)               — poolId 1 == gaugePoolId default do V2
  //   7. Treasury.setLiquidityGauge(gauge, 1)   — habilita flushPendingGaugeRewards
  console.log("\n[9/15] proposta #5: wiring V2 (roles + pool gauge + cutoff V1)…");
  const gauge = await ethers.getContractAt("LiquidityGauge", addrs.gauge);
  const distributorV2 = await ethers.getContractAt("RewardDistributorV2", addrs.distributorV2);
  const MINTER_ROLE = ethers.id("MINTER_ROLE");
  const REWARD_NOTIFIER_ROLE = ethers.id("REWARD_NOTIFIER_ROLE");
  const POL_REFILL_DEPOSITOR_ROLE = ethers.id("POL_REFILL_DEPOSITOR_ROLE");
  const GAUGE_FALLBACK_DEPOSITOR_ROLE = ethers.id("GAUGE_FALLBACK_DEPOSITOR_ROLE");

  await passProposal(
    [addrs.credit, addrs.credit, addrs.gauge, addrs.treasury, addrs.treasury, addrs.gauge, addrs.treasury],
    [0n, 0n, 0n, 0n, 0n, 0n, 0n],
    [
      credit.interface.encodeFunctionData("grantRole", [MINTER_ROLE, addrs.distributorV2]),
      credit.interface.encodeFunctionData("revokeRole", [MINTER_ROLE, addrs.distributorV1]),
      gauge.interface.encodeFunctionData("grantRole", [REWARD_NOTIFIER_ROLE, addrs.distributorV2]),
      treasury.interface.encodeFunctionData("grantRole", [POL_REFILL_DEPOSITOR_ROLE, addrs.distributorV2]),
      treasury.interface.encodeFunctionData("grantRole", [GAUGE_FALLBACK_DEPOSITOR_ROLE, addrs.distributorV2]),
      gauge.interface.encodeFunctionData("addPool", [MOCK_POOL]),
      treasury.interface.encodeFunctionData("setLiquidityGauge", [addrs.gauge, 1n]),
    ],
    "# Proposta #5 — Migracao de rewards para o RewardDistributorV2 (Fase 1.4)\n\nConcede MINTER_ROLE do CREDIT ao V2 e revoga do V1 (cutoff), concede REWARD_NOTIFIER_ROLE no LiquidityGauge e roles de depositor no Treasury, whitelista a pool CREDIT/USDC (poolId 1) e aponta o Treasury pro gauge.",
  );
  if (!(await credit.hasRole(MINTER_ROLE, addrs.distributorV2))) {
    throw new Error("V2 nao recebeu MINTER_ROLE");
  }
  if (await credit.hasRole(MINTER_ROLE, addrs.distributorV1)) {
    throw new Error("V1 ainda tem MINTER_ROLE (cutoff falhou)");
  }
  console.log("  V2 = minter unico do CREDIT; gauge poolId 1 whitelistada; Treasury -> gauge ok");

  // ---------- 10) Stake do dev member no projeto #1 ----------
  // Acao de usuario (permissionless) — staking direcionado de GOV no
  // cloud-terminal com lock maximo (365d = multiplier 4x).
  console.log("\n[10/15] stake: 1M GOV no projeto #1 (lock 365d, 4x)…");
  const staking = await ethers.getContractAt("Staking", addrs.staking);
  await (await gov.connect(devMember).approve(addrs.staking, STAKE_AMOUNT)).wait();
  await (await staking.connect(devMember).stake(projectId, STAKE_AMOUNT, STAKE_LOCK)).wait();
  const weight: bigint = await staking.getWeight(devMember.address, projectId);
  console.log(
    `  stake ok — weight = ${ethers.formatEther(weight)} (${ethers.formatEther(STAKE_AMOUNT)} GOV x4)`,
  );

  // ---------- 11) Seed de burn: pagamento no FeeRouter (round 0) ----------
  console.log("\n[11/15] seed de burn: FeeRouter.pay de 100 CREDIT no projeto #1…");
  const feeRouter = await ethers.getContractAt("FeeRouter", addrs.feeRouter);
  const burnTracker = await ethers.getContractAt("BurnTracker", addrs.burnTracker);
  await (await credit.connect(devMember).approve(addrs.feeRouter, SEED_PAYMENT)).wait();
  await (await feeRouter.connect(devMember).pay(projectId, devMember.address, SEED_PAYMENT)).wait();
  const round0Burn: bigint = await burnTracker.getBurnForProjectInRound(0n, projectId);
  console.log(`  burn registrado na rodada 0: ${ethers.formatEther(round0Burn)} CREDIT`);

  // ---------- 12) Ciclo de rewards V2: close -> finalize -> claim ----------
  // Round 0: emissao = floorSchedule[0] (400k CREDIT) — burnPrev inexistente,
  //          bucket apps cai no bonders (bootstrap documentado no contrato).
  // Round 1: emissao usa o burn da rodada 0 vs floorSchedule[1]; bucket apps
  //          minta pro ownerRecipient do projeto (= dev member).
  console.log("\n[12/15] ciclo V2: closeRound -> finalizeRound -> claim (rounds 0 e 1)…");
  for (const round of [0n, 1n]) {
    await passProposal(
      [addrs.burnTracker],
      [0n],
      [burnTracker.interface.encodeFunctionData("closeRound")],
      `# Proposta #${6n + round} — Fechar rodada ${round}\n\nBurnTracker.closeRound(): encerra a rodada ${round} e abre a ${round + 1n}, liberando o finalizeRound do RewardDistributorV2.`,
    );
    if (round > 0n) {
      // O bucket LPs cria um incentivo de 7d no gauge a cada finalize; sem
      // avancar o relogio o proximo finalize reverte com IncentiveOverlap.
      // Em producao os rounds ja distam 7d (roundDuration) — simulamos isso.
      await increaseTime(7n * 24n * 3600n);
    }
    await (await distributorV2.finalizeRound(round)).wait();
    const emission: bigint = await distributorV2.getEmission(round);
    const buckets = await Promise.all(
      [0, 1, 2, 3].map((b) => distributorV2.getBucketEmission(round, b)),
    );
    console.log(
      `  round ${round} finalizado — emissao ${ethers.formatEther(emission)} CREDIT ` +
        `(stakers ${ethers.formatEther(buckets[0])} / lps ${ethers.formatEther(buckets[1])} / ` +
        `apps ${ethers.formatEther(buckets[2])} / bonders ${ethers.formatEther(buckets[3])})`,
    );

    const claimPreview: bigint = await distributorV2.previewClaim(devMember.address, round, projectId);
    if (claimPreview > 0n) {
      await (await distributorV2.connect(devMember).claim(round, projectId)).wait();
      console.log(`  claim stakers do dev member (round ${round}): ${ethers.formatEther(claimPreview)} CREDIT`);
    } else {
      console.log(`  claim stakers do dev member (round ${round}): 0 (nada a puxar)`);
    }
  }
  const finalCreditBalance: bigint = await credit.balanceOf(devMember.address);
  console.log(`  saldo CREDIT final do dev member = ${ethers.formatEther(finalCreditBalance)}`);

  // ---------- 13) Infra dev de mercado: USDC mock + pool + oracle + faucet ----------
  // Contratos de contracts/dev/ — EXCLUSIVOS da rede local. Deployados fora
  // do Ignition (mesmo racional dos mocks Uniswap do gauge: o modulo
  // permanece identico ao de mainnet).
  console.log("\n[13/15] infra dev: USDC mock + DevSwapPool + CreditPriceOracle + DevFaucet…");
  const USDCMock = await ethers.getContractFactory("ERC20DecimalsMock");
  const usdcMock = await USDCMock.deploy("USD Coin (Dev)", "USDC", 6);
  await usdcMock.waitForDeployment();
  const usdcAddr = await usdcMock.getAddress();

  const DevPool = await ethers.getContractFactory("DevSwapPool");
  const devPool = await DevPool.deploy(addrs.credit, usdcAddr);
  await devPool.waitForDeployment();
  const devPoolAddr = await devPool.getAddress();

  // Feed Chainlink = address(0) => fallback deliberado 1 USDC = 1 USD do
  // CreditPriceOracle (nao ha feed USDC/USD em chain local).
  const Oracle = await ethers.getContractFactory("CreditPriceOracle");
  const oracle = await Oracle.deploy(devPoolAddr, addrs.credit, usdcAddr, ethers.ZeroAddress);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();

  const Faucet = await ethers.getContractFactory("DevFaucet");
  const faucet = await Faucet.deploy(
    addrs.credit,
    usdcAddr,
    devMember.address,
    DRIP_ETH,
    DRIP_CREDIT,
    DRIP_USDC,
    DRIP_COOLDOWN,
  );
  await faucet.waitForDeployment();
  const faucetAddr = await faucet.getAddress();
  console.log(`  USDC (mock)       = ${usdcAddr}`);
  console.log(`  DevSwapPool       = ${devPoolAddr}`);
  console.log(`  CreditPriceOracle = ${oracleAddr}`);
  console.log(`  DevFaucet         = ${faucetAddr}`);

  // ---------- 14) Proposta #8: funding dev + wiring do oracle/router ----------
  // Treasury e quem custodia o CREDIT (genesis) — funding do faucet e do
  // seed da pool sai de la via governanca, como qualquer gasto da DAO.
  // No mesmo batch, o Treasury passa a enxergar o par dev como fonte de
  // preco (setPriceOracle) e venue de buyback (setSwapRouter).
  console.log("\n[14/15] proposta #8: Treasury funda faucet+seed e aponta oracle/router dev…");
  await passProposal(
    [addrs.treasury, addrs.treasury, addrs.treasury, addrs.treasury],
    [0n, 0n, 0n, 0n],
    [
      treasury.interface.encodeFunctionData("transfer", [addrs.credit, faucetAddr, FAUCET_CREDIT]),
      treasury.interface.encodeFunctionData("transfer", [addrs.credit, devMember.address, POOL_SEED_CREDIT]),
      treasury.interface.encodeFunctionData("setPriceOracle", [oracleAddr]),
      treasury.interface.encodeFunctionData("setSwapRouter", [devPoolAddr]),
    ],
    "# Proposta #8 — Infra dev de mercado (rede local)\n\nFunda o DevFaucet com CREDIT, libera CREDIT pro seed da DevSwapPool (CREDIT/USDC), e aponta o Treasury pro CreditPriceOracle e pro router dev — habilitando TWAP e buyback na simulacao local.",
  );
  console.log(`  faucet fundado com ${ethers.formatEther(FAUCET_CREDIT)} CREDIT via Treasury`);

  // ---------- 15) Seed da pool + funding restante + smoke tests ----------
  console.log("\n[15/15] seed da DevSwapPool + funding do faucet + smoke tests…");
  // USDC mock: mint aberto (dev) — deployer cunha pro seed e pro faucet.
  await (await usdcMock.mint(devMember.address, POOL_SEED_USDC)).wait();
  await (await usdcMock.mint(faucetAddr, FAUCET_USDC)).wait();

  await (await credit.connect(devMember).approve(devPoolAddr, POOL_SEED_CREDIT)).wait();
  await (await usdcMock.connect(devMember).approve(devPoolAddr, POOL_SEED_USDC)).wait();
  const creditIsToken0 = (await devPool.TOKEN0()).toLowerCase() === addrs.credit.toLowerCase();
  const [seed0, seed1] = creditIsToken0
    ? [POOL_SEED_CREDIT, POOL_SEED_USDC]
    : [POOL_SEED_USDC, POOL_SEED_CREDIT];
  await (await devPool.connect(devMember).seed(seed0, seed1)).wait();
  console.log(
    `  pool semeada: ${ethers.formatEther(POOL_SEED_CREDIT)} CREDIT / ${ethers.formatUnits(POOL_SEED_USDC, 6)} USDC (~$0.10/CREDIT)`,
  );

  await (await devMember.sendTransaction({ to: faucetAddr, value: FAUCET_ETH })).wait();

  // Smoke test 1: TWAP do oracle (janela de 30min do Treasury) ~ $0.10.
  const twap: bigint = await oracle.peekTwapPrice.staticCall(1800);
  console.log(`  TWAP CreditPriceOracle(1800s) = $${ethers.formatEther(twap)} / CREDIT`);
  if (twap === 0n) throw new Error("oracle retornou preco zero");

  // Smoke test 2: quote de compra na pool (100 USDC -> CREDIT).
  const quoteOut: bigint = await devPool.quoteExactInput(usdcAddr, 100n * 10n ** 6n);
  console.log(`  quote: 100 USDC -> ${ethers.formatEther(quoteOut)} CREDIT`);

  // Smoke test 3: claim do faucet numa carteira nova (padrao do hub: uma
  // conta unlocked do node aciona claimFor pra quem ainda nao tem gas).
  const freshWallet = ethers.Wallet.createRandom();
  await (await faucet.connect(signers[19]).claimFor(freshWallet.address)).wait();
  const fEth = await ethers.provider.getBalance(freshWallet.address);
  const fCredit: bigint = await credit.balanceOf(freshWallet.address);
  const fUsdc: bigint = await usdcMock.balanceOf(freshWallet.address);
  console.log(
    `  faucet.claimFor(fresh): ${ethers.formatEther(fEth)} ETH + ${ethers.formatEther(fCredit)} CREDIT + ${ethers.formatUnits(fUsdc, 6)} USDC`,
  );
  if (fEth !== DRIP_ETH || fCredit !== DRIP_CREDIT || fUsdc !== DRIP_USDC) {
    throw new Error("drip do faucet divergente do configurado");
  }

  // Persiste os enderecos dev pro export-runtime-config/sync-contracts
  // mesclarem no config do hub e do backend.
  const devAddrsFile = resolve(journalDir, "dev_addresses.json");
  writeFileSync(
    devAddrsFile,
    JSON.stringify(
      {
        USDC: usdcAddr,
        DevSwapPool: devPoolAddr,
        CreditPriceOracle: oracleAddr,
        DevFaucet: faucetAddr,
      },
      null,
      2,
    ),
  );
  console.log(`  enderecos dev persistidos em ${devAddrsFile}`);

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
  console.log(`  - Treasury: 30M GOV + ${ethers.formatEther(10_000_000n * 10n ** 18n - TEST_CREDIT)} CREDIT (genesis)`);
  console.log(`  - CLP Fase 1: LiquidityGauge ${addrs.gauge}`);
  console.log(`                RewardDistributorV2 ${addrs.distributorV2} (MINTER unico; V1 cortado)`);
  console.log(`  - stake: ${ethers.formatEther(STAKE_AMOUNT)} GOV do dev no projeto #${projectId} (lock 365d, weight 4x)`);
  console.log(`  - rounds 0 e 1 fechados e finalizados no V2 (emissao floor + burn-driven); claims pagos`);
  console.log(`  - saldo CREDIT final do dev member: ${ethers.formatEther(finalCreditBalance)}`);
  console.log(`  - infra dev de mercado (proposta #8 + seed):`);
  console.log(`      USDC mock ${usdcAddr}`);
  console.log(`      DevSwapPool ${devPoolAddr} (500k CREDIT / 50k USDC, ~$0.10)`);
  console.log(`      CreditPriceOracle ${oracleAddr} (TWAP da pool, USDC=USD 1:1) — Treasury.setPriceOracle OK`);
  console.log(`      DevFaucet ${faucetAddr} (drip ${ethers.formatEther(DRIP_ETH)} ETH + ${ethers.formatEther(DRIP_CREDIT)} CREDIT + ${ethers.formatUnits(DRIP_USDC, 6)} USDC, cooldown ${DRIP_COOLDOWN}s)`);
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
