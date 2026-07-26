import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  mine,
  time,
} from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type { CommunityGovernor } from "../../typechain-types";

/**
 * E2E — GovernanceFlow (remodel 2026-07-08)
 *
 * Cobertura: propostas on-chain do {CommunityGovernor} atravessando o ciclo
 * completo (propose -> vote -> queue -> delay -> execute) e impactando os
 * contratos economicos do modelo vigente gated por {GOVERNANCE_ROLE}
 * (FeeRouterV2, ProjectFunding, ProjectRegistry, Treasury). Este e o unico e2e
 * que exercita o caminho de PRODUCAO: nenhum impersonate do Timelock em
 * mutacoes de governanca apos o bootstrap de voting power.
 *
 * Cenarios cobertos:
 *   1. acceptOwnership do GovernanceToken via proposta (primeira proposta
 *      ratificada em producao — ver decisao 4 do ignition/modules/Dao.ts).
 *   2. Registrar + ativar projeto via proposta (I7 — single-batch).
 *   3. Ajustar a fee do FeeRouterV2 via proposta (respeitando o teto duro).
 *   4. Batch multi-alvo: setFeeSplit(FeeRouterV2) + Treasury.transfer numa
 *      unica proposta (uma unica aprovacao).
 *   5. Proposta rejeitada sem quorum: chega a Defeated; queue/execute revertem.
 *   6. Proposer cancela proposta Pending antes do voto.
 *   7. onlyGovernance: setFeeBps direct-call reverte para nao-Timelock.
 *   8. Ajustar minTarget do ProjectFunding via proposta (efeito em rodada
 *      futura).
 *
 * Nota USDC: o modulo Ignition deploya o USDC de lastro do PSM apenas com
 * `DEPLOY_USDC_MOCK=true`. A fixture seta a flag e restaura depois.
 */
describe("E2E: GovernanceFlow — propostas on-chain atingindo contratos economicos", function () {
  this.timeout(240_000);

  const DEV_TIMELOCK_DELAY = 3_600n; // 1h
  const DEV_VOTING_PERIOD = 50n; // blocks
  const VOTER_POWER = 50_000_000n * 10n ** 18n; // 50% do cap, garante quorum 4%
  const PROPOSER_POWER = 20_000n * 10n ** 18n; // acima do threshold 10k
  const PROJECT_COLLATERAL = 5_000n * 10n ** 18n;

  const E18 = 10n ** 18n;
  const E6 = 10n ** 6n;

  async function ignitionDeployWithUsdcMock() {
    const original = process.env.DEPLOY_USDC_MOCK;
    process.env.DEPLOY_USDC_MOCK = "true";
    try {
      const path = require.resolve("../../ignition/modules/Dao");
      delete require.cache[path];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../ignition/modules/Dao");
      return await hre.ignition.deploy(mod.default);
    } finally {
      if (original === undefined) delete process.env.DEPLOY_USDC_MOCK;
      else process.env.DEPLOY_USDC_MOCK = original;
    }
  }

  async function deployGovFixture() {
    const deployed = await ignitionDeployWithUsdcMock();

    const [deployer, voter, proposer, recipient, projectOwner] = await ethers.getSigners();

    const [gov, credit, timelock, registry, treasury, staking, usdc, psm, funding, feeRouterV2, governor] =
      await Promise.all([
        ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress()),
        ethers.getContractAt("CreditToken", await deployed.credit.getAddress()),
        ethers.getContractAt("CommunityTimelock", await deployed.timelock.getAddress()),
        ethers.getContractAt("ProjectRegistry", await deployed.registry.getAddress()),
        ethers.getContractAt("Treasury", await deployed.treasury.getAddress()),
        ethers.getContractAt("Staking", await deployed.staking.getAddress()),
        ethers.getContractAt("ERC20DecimalsMock", await deployed.usdc.getAddress()),
        ethers.getContractAt("CreditPSM", await deployed.psm.getAddress()),
        ethers.getContractAt("ProjectFunding", await deployed.funding.getAddress()),
        ethers.getContractAt("FeeRouterV2", await deployed.feeRouterV2.getAddress()),
        ethers.getContractAt("CommunityGovernor", await deployed.governor.getAddress()),
      ]);

    // Bootstrap: Timelock aceita ownership do GOV e minta GOV para voter +
    // proposer, ambos delegam.
    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    const tlSigner = await ethers.getSigner(tlAddr);
    await setBalance(tlSigner.address, ethers.parseEther("100"));
    await gov.connect(tlSigner).acceptOwnership();

    await gov.connect(tlSigner).mint(voter.address, VOTER_POWER, "e2e:voter");
    await gov.connect(tlSigner).mint(proposer.address, PROPOSER_POWER, "e2e:proposer");
    await gov.connect(voter).delegate(voter.address);
    await gov.connect(proposer).delegate(proposer.address);

    // Colateral do projeto (para cenario que registra projeto).
    await gov.connect(tlSigner).mint(projectOwner.address, PROJECT_COLLATERAL, "e2e:projectOwner");
    await gov.connect(projectOwner).approve(await registry.getAddress(), PROJECT_COLLATERAL);

    await mine(1);

    return {
      gov,
      credit,
      timelock,
      registry,
      treasury,
      staking,
      usdc,
      psm,
      funding,
      feeRouterV2,
      governor,
      deployer,
      voter,
      proposer,
      recipient,
      projectOwner,
      tlSigner,
    };
  }

  /**
   * Helper: executa o ciclo completo de uma proposta assumindo quorum atingido
   * via voteFor do `voter`. Retorna o receipt da execucao.
   */
  async function proposeAndExecute(
    governor: CommunityGovernor,
    proposerSigner: HardhatEthersSigner,
    voterSigner: HardhatEthersSigner,
    targets: string[],
    values: bigint[],
    calldatas: string[],
    description: string,
  ) {
    const descriptionHash = ethers.id(description);

    const proposeTx = await governor
      .connect(proposerSigner)
      .propose(targets, values, calldatas, description);
    const receipt = await proposeTx.wait();

    type ProposalCreatedLog = { fragment?: { name: string }; args?: { proposalId: bigint } };
    const proposalId = (receipt!.logs as unknown as ProposalCreatedLog[])
      .filter((l) => l.fragment?.name === "ProposalCreated")
      .map((l) => l.args!.proposalId)[0];

    await mine(2);
    await governor.connect(voterSigner).castVote(proposalId, 1);
    await mine(Number(DEV_VOTING_PERIOD));
    await governor.connect(voterSigner).queue(targets, values, calldatas, descriptionHash);
    await time.increase(Number(DEV_TIMELOCK_DELAY) + 1);
    await mine(1);

    const execTx = await governor
      .connect(voterSigner)
      .execute(targets, values, calldatas, descriptionHash);
    return { proposalId, execReceipt: await execTx.wait() };
  }

  it("1. acceptOwnership do GovernanceToken via proposta (caminho prod)", async () => {
    // ISOLAMENTO: redeploya fresh sem bootstrap do acceptOwnership, validando
    // o caminho real de producao onde a primeira proposta e o accept do Timelock.
    const deployed = await ignitionDeployWithUsdcMock();

    const [deployer, voter, proposer] = await ethers.getSigners();
    void deployer;

    const [gov, timelock, governor] = await Promise.all([
      ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress()),
      ethers.getContractAt("CommunityTimelock", await deployed.timelock.getAddress()),
      ethers.getContractAt("CommunityGovernor", await deployed.governor.getAddress()),
    ]);

    expect(await gov.pendingOwner()).to.equal(await timelock.getAddress());
    const initialOwner = await gov.owner();

    // Pre-bootstrap: deployer ainda detem `owner` do GOV (renunciar admin dos
    // outros contratos nao afeta a ownership do GOV) — minta GOV pros voters.
    const deployerSigner = await ethers.getSigner(initialOwner);
    await gov.connect(deployerSigner).mint(voter.address, VOTER_POWER, "pre-gov:voter");
    await gov.connect(deployerSigner).mint(proposer.address, PROPOSER_POWER, "pre-gov:proposer");
    await gov.connect(voter).delegate(voter.address);
    await gov.connect(proposer).delegate(proposer.address);
    await mine(1);

    // Propoe: target = GOV, call = acceptOwnership().
    const rawIface = new ethers.Interface(["function acceptOwnership()"]);
    const calldata = rawIface.encodeFunctionData("acceptOwnership", []);
    const description = "E2E 1: Timelock acceptOwnership of GovernanceToken";

    await proposeAndExecute(
      governor,
      proposer,
      voter,
      [await gov.getAddress()],
      [0n],
      [calldata],
      description,
    );

    expect(await gov.owner()).to.equal(await timelock.getAddress());
    expect(await gov.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("2. Registrar + ativar projeto via proposta (I7 — single-batch)", async () => {
    const { gov, registry, governor, voter, proposer, projectOwner } =
      await loadFixture(deployGovFixture);

    const registryAddr = await registry.getAddress();

    const calldataRegister = registry.interface.encodeFunctionData("registerProject", [
      projectOwner.address,
      "ipfs://governance-registered",
      PROJECT_COLLATERAL,
    ]);
    const calldataActivate = registry.interface.encodeFunctionData("activateProject", [1n]);

    await proposeAndExecute(
      governor,
      proposer,
      voter,
      [registryAddr, registryAddr],
      [0n, 0n],
      [calldataRegister, calldataActivate],
      "E2E 2: Register + activate project 1",
    );

    const project = await registry.getProject(1n);
    expect(project.owner).to.equal(projectOwner.address);
    expect(project.status).to.equal(1); // Active
    expect(await registry.isActive(1n)).to.be.true;
    expect(await gov.balanceOf(registryAddr)).to.equal(PROJECT_COLLATERAL);
  });

  it("3. Ajustar a fee do FeeRouterV2 via proposta (respeita o teto duro)", async () => {
    const { feeRouterV2, governor, voter, proposer } = await loadFixture(deployGovFixture);

    const oldFee = await feeRouterV2.feeBps();
    expect(oldFee).to.equal(250n); // 2,5% default

    // Novo fee dentro do teto duro (FEE_BPS_CAP = 500 = 5%). Muda para 3%.
    const newFee = 300n;
    const calldata = feeRouterV2.interface.encodeFunctionData("setFeeBps", [newFee]);

    const { execReceipt } = await proposeAndExecute(
      governor,
      proposer,
      voter,
      [await feeRouterV2.getAddress()],
      [0n],
      [calldata],
      "E2E 3: bump fee to 3%",
    );

    expect(await feeRouterV2.feeBps()).to.equal(newFee);

    // Event FeeUpdated emitido pelo router — logs crus (target != chamador direto).
    const feeUpdatedTopic = feeRouterV2.interface.getEvent("FeeUpdated")!.topicHash;
    const routerAddr = (await feeRouterV2.getAddress()).toLowerCase();
    const matched = execReceipt!.logs.filter(
      (l) => l.address.toLowerCase() === routerAddr && l.topics[0] === feeUpdatedTopic,
    );
    expect(matched.length).to.equal(1);
  });

  it("4. Batch multi-alvo: setFeeSplit(FeeRouterV2) + Treasury.transfer numa proposta", async () => {
    const { credit, treasury, usdc, psm, feeRouterV2, governor, voter, proposer, recipient } =
      await loadFixture(deployGovFixture);

    // Pre-req: financiar o Treasury com CREDIT (sem genesis) via PSM.buy.
    const treasuryFund = 1_000n * E18;
    await usdc.mint(voter.address, 1_000n * E6);
    await usdc.connect(voter).approve(await psm.getAddress(), 1_000n * E6);
    await psm.connect(voter).buy(1_000n * E6);
    await credit.connect(voter).transfer(await treasury.getAddress(), treasuryFund);

    // Batch proposta:
    //   (a) setFeeSplit(50/30/20) — muda a reparticao da fee.
    //   (b) Treasury.transfer(CREDIT, recipient, 400e18) — paga do cofre.
    const newSplit = { treasuryBps: 5000, buybackBps: 3000, grantsBps: 2000 };
    const transferAmount = 400n * E18;

    const calldataSplit = feeRouterV2.interface.encodeFunctionData("setFeeSplit", [newSplit]);
    const calldataTransfer = treasury.interface.encodeFunctionData("transfer", [
      await credit.getAddress(),
      recipient.address,
      transferAmount,
    ]);

    const recipientBefore = await credit.balanceOf(recipient.address);
    const treasuryBefore = await credit.balanceOf(await treasury.getAddress());

    await proposeAndExecute(
      governor,
      proposer,
      voter,
      [await feeRouterV2.getAddress(), await treasury.getAddress()],
      [0n, 0n],
      [calldataSplit, calldataTransfer],
      "E2E 4: update fee split + treasury transfer",
    );

    // Efeito 1: split aplicado.
    const storedSplit = await feeRouterV2.feeSplit();
    expect(storedSplit.treasuryBps).to.equal(5000);
    expect(storedSplit.buybackBps).to.equal(3000);
    expect(storedSplit.grantsBps).to.equal(2000);

    // Efeito 2: transfer do Treasury.
    expect((await credit.balanceOf(recipient.address)) - recipientBefore).to.equal(transferAmount);
    expect(treasuryBefore - (await credit.balanceOf(await treasury.getAddress()))).to.equal(
      transferAmount,
    );
  });

  it("5. Proposta sem quorum: chega a Defeated; queue e execute revertem", async () => {
    const { feeRouterV2, governor, voter, proposer } = await loadFixture(deployGovFixture);
    void voter; // NAO vota; proposta morre de quorum insuficiente

    const newFee = 300n;
    const calldata = feeRouterV2.interface.encodeFunctionData("setFeeBps", [newFee]);
    const targets = [await feeRouterV2.getAddress()];
    const values = [0n];
    const calldatas = [calldata];
    const description = "E2E 5: fee proposal without quorum";
    const descriptionHash = ethers.id(description);

    const proposeTx = await governor
      .connect(proposer)
      .propose(targets, values, calldatas, description);
    const receipt = await proposeTx.wait();
    type ProposalCreatedLog = { fragment?: { name: string }; args?: { proposalId: bigint } };
    const proposalId = (receipt!.logs as unknown as ProposalCreatedLog[])
      .filter((l) => l.fragment?.name === "ProposalCreated")
      .map((l) => l.args!.proposalId)[0];

    await mine(2); // ativa
    // NAO vota — proposer so tem 20k GOV (0.02% do cap) << quorum 4%.
    await mine(Number(DEV_VOTING_PERIOD));

    const stateAfter = await governor.state(proposalId);
    expect(stateAfter).to.equal(3); // ProposalState.Defeated

    await expect(governor.connect(proposer).queue(targets, values, calldatas, descriptionHash)).to
      .be.reverted;
    await expect(governor.connect(proposer).execute(targets, values, calldatas, descriptionHash)).to
      .be.reverted;

    // Parametro permanece.
    expect(await feeRouterV2.feeBps()).to.equal(250n);
  });

  it("6. Proposer cancela proposta Pending antes do voto", async () => {
    const { feeRouterV2, governor, voter, proposer } = await loadFixture(deployGovFixture);
    void voter;

    const newFee = 300n;
    const calldata = feeRouterV2.interface.encodeFunctionData("setFeeBps", [newFee]);
    const targets = [await feeRouterV2.getAddress()];
    const values = [0n];
    const calldatas = [calldata];
    const description = "E2E 6: proposer cancels";
    const descriptionHash = ethers.id(description);

    const proposeTx = await governor
      .connect(proposer)
      .propose(targets, values, calldatas, description);
    const receipt = await proposeTx.wait();
    type ProposalCreatedLog = { fragment?: { name: string }; args?: { proposalId: bigint } };
    const proposalId = (receipt!.logs as unknown as ProposalCreatedLog[])
      .filter((l) => l.fragment?.name === "ProposalCreated")
      .map((l) => l.args!.proposalId)[0];

    await governor.connect(proposer).cancel(targets, values, calldatas, descriptionHash);
    expect(await governor.state(proposalId)).to.equal(2); // Canceled

    await expect(governor.connect(proposer).queue(targets, values, calldatas, descriptionHash)).to
      .be.reverted;
  });

  it("7. onlyGovernance: setFeeBps direct-call reverte para nao-Timelock", async () => {
    const { feeRouterV2, voter, deployer } = await loadFixture(deployGovFixture);

    // Voter (EOA com muito GOV, mas sem role) tenta chamar diretamente.
    await expect(feeRouterV2.connect(voter).setFeeBps(300)).to.be.revertedWithCustomError(
      feeRouterV2,
      "AccessControlUnauthorizedAccount",
    );

    // Deployer (que renunciou todas as roles) tambem nao consegue.
    await expect(feeRouterV2.connect(deployer).setFeeBps(300)).to.be.revertedWithCustomError(
      feeRouterV2,
      "AccessControlUnauthorizedAccount",
    );

    expect(await feeRouterV2.feeBps()).to.equal(250n);
  });

  it("8. Ajustar minTarget do ProjectFunding via proposta afeta rodada futura", async () => {
    const { funding, registry, governor, voter, proposer, projectOwner, tlSigner } =
      await loadFixture(deployGovFixture);

    // Setup: projeto 1 registrado/ativo via impersonate (o foco e o setMinTarget).
    await registry
      .connect(tlSigner)
      .registerProject(projectOwner.address, "ipfs://projA", PROJECT_COLLATERAL);
    await registry.connect(tlSigner).activateProject(1n);

    const oldMin = await funding.minTarget();
    expect(oldMin).to.equal(100n * E18); // default

    // Proposta: setMinTarget(1_000e18).
    const newMin = 1_000n * E18;
    const calldata = funding.interface.encodeFunctionData("setMinTarget", [newMin]);
    await proposeAndExecute(
      governor,
      proposer,
      voter,
      [await funding.getAddress()],
      [0n],
      [calldata],
      "E2E 8: raise minTarget to 1000 CREDIT",
    );

    expect(await funding.minTarget()).to.equal(newMin);

    // Efeito observavel: abrir rodada com alvo abaixo do novo minimo reverte.
    await expect(
      funding.connect(projectOwner).openRound(1n, 500n * E18, 1000, 30n * 86_400n),
    ).to.be.revertedWithCustomError(funding, "TargetOutOfBounds");

    // Alvo >= novo minimo passa.
    await expect(
      funding.connect(projectOwner).openRound(1n, newMin, 1000, 30n * 86_400n),
    ).to.emit(funding, "RoundOpened");
  });
});
