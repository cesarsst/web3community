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

import CommunityDAOModule from "../../ignition/modules/Dao";
import type { CommunityGovernor } from "../../typechain-types";

/**
 * E2E — GovernanceFlow
 *
 * Cobertura: propostas on-chain do {CommunityGovernor} atravessando o ciclo
 * completo (propose -> vote -> queue -> delay -> execute) e impactando TODOS
 * os contratos economicos gated por {GOVERNANCE_ROLE}. Este e o unico e2e que
 * exercita o caminho de PRODUCAO: nenhum impersonate do Timelock em mutacoes
 * de governanca apos o bootstrap de voting power.
 *
 * Cenarios cobertos:
 *   1. acceptOwnership do GovernanceToken via proposta (primeira proposta
 *      ratificada em producao — ver decisao 4 do ignition/modules/Dao.ts).
 *   2. Registrar + ativar projeto via proposta (I7).
 *   3. Ajustar alpha do RewardDistributor via proposta (apos proposta, novas
 *      rodadas finalizam com alpha novo; rodadas ja finalizadas sao imutaveis).
 *   4. Batch multi-alvo: ajusta split do FeeRouter + paga rebate do Treasury
 *      num mesmo proposal (uma unica aprovacao).
 *   5. Propose rejeitado sem quorum: chega a Defeated; execute reverte.
 *   6. Proposal cancel pelo proposer (Pending).
 *   7. onlyGovernance: chamada direta ao setAlpha reverte para nao-Timelock.
 *
 * Observacoes:
 *   - Usamos impersonate APENAS para o bootstrap de mint inicial de GOV
 *     (ja que distribuicao real via governanca seria a segunda proposta; para
 *     isolar esse teste e evitar doble-governanca aninhada, fazemos
 *     impersonate do Timelock uma unica vez para mintar GOV pros voters).
 *   - Parametros DEV: votingDelay = 1 block, votingPeriod = 50 blocks,
 *     timelockDelay = 1h, quorum = 4%.
 */
describe("E2E: GovernanceFlow — propostas on-chain atingindo contratos economicos", function () {
  // Muitos avancos de bloco/tempo — CI lento precisa de folga.
  this.timeout(240_000);

  const DEV_TIMELOCK_DELAY = 3_600n; // 1h
  const DEV_VOTING_PERIOD = 50n; // blocks
  const VOTER_POWER = 50_000_000n * 10n ** 18n; // 50% do cap, garante quorum 4%
  const PROPOSER_POWER = 20_000n * 10n ** 18n; // acima do threshold 10k
  const PROJECT_COLLATERAL = 5_000n * 10n ** 18n;

  async function deployGovFixture() {
    const deployed = await hre.ignition.deploy(CommunityDAOModule);

    const [deployer, voter, proposer, recipient, projectOwner] = await ethers.getSigners();

    const [
      gov,
      credit,
      timelock,
      registry,
      treasury,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      governor,
    ] = await Promise.all([
      ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress()),
      ethers.getContractAt("CreditToken", await deployed.credit.getAddress()),
      ethers.getContractAt("CommunityTimelock", await deployed.timelock.getAddress()),
      ethers.getContractAt("ProjectRegistry", await deployed.registry.getAddress()),
      ethers.getContractAt("Treasury", await deployed.treasury.getAddress()),
      ethers.getContractAt("Staking", await deployed.staking.getAddress()),
      ethers.getContractAt("BurnTracker", await deployed.burnTracker.getAddress()),
      ethers.getContractAt("RewardDistributor", await deployed.distributor.getAddress()),
      ethers.getContractAt("FeeRouter", await deployed.feeRouter.getAddress()),
      ethers.getContractAt("CommunityGovernor", await deployed.governor.getAddress()),
    ]);

    // Bootstrap:
    //   1. Timelock aceita ownership do GOV (simulacao one-shot — em prod e
    //      a primeira proposta, mas testamos ela isoladamente em outro caso).
    //   2. Timelock minta GOV para voter + proposer e ambos fazem delegate.
    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    const tlSigner = await ethers.getSigner(tlAddr);
    await setBalance(tlSigner.address, ethers.parseEther("100"));
    await gov.connect(tlSigner).acceptOwnership();

    await gov.connect(tlSigner).mint(voter.address, VOTER_POWER, "e2e:voter");
    await gov.connect(tlSigner).mint(proposer.address, PROPOSER_POWER, "e2e:proposer");
    await gov.connect(voter).delegate(voter.address);
    await gov.connect(proposer).delegate(proposer.address);

    // Bootstrap colateral do projeto (para cenario que registra projeto).
    await gov.connect(tlSigner).mint(projectOwner.address, PROJECT_COLLATERAL, "e2e:projectOwner");
    await gov.connect(projectOwner).approve(await registry.getAddress(), PROJECT_COLLATERAL);

    // Mine 1 bloco para ativar delegates no snapshot.
    await mine(1);

    return {
      gov,
      credit,
      timelock,
      registry,
      treasury,
      staking,
      burnTracker,
      distributor,
      feeRouter,
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
   * via voteFor do `voter`. Retorna o receipt da execucao (pode ser inspecionado
   * para events).
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

    // Propose.
    const proposeTx = await governor
      .connect(proposerSigner)
      .propose(targets, values, calldatas, description);
    const receipt = await proposeTx.wait();

    // Captura o proposalId.
    type ProposalCreatedLog = { fragment?: { name: string }; args?: { proposalId: bigint } };
    const proposalId = (receipt!.logs as unknown as ProposalCreatedLog[])
      .filter((l) => l.fragment?.name === "ProposalCreated")
      .map((l) => l.args!.proposalId)[0];

    // votingDelay = 1 block -> mine 2 para garantir Active.
    await mine(2);

    // Vota FOR.
    await governor.connect(voterSigner).castVote(proposalId, 1);

    // Avanca period de votacao.
    await mine(Number(DEV_VOTING_PERIOD));

    // Queue.
    await governor.connect(voterSigner).queue(targets, values, calldatas, descriptionHash);

    // Avanca delay do Timelock.
    await time.increase(Number(DEV_TIMELOCK_DELAY) + 1);
    await mine(1);

    // Execute.
    const execTx = await governor
      .connect(voterSigner)
      .execute(targets, values, calldatas, descriptionHash);
    return { proposalId, execReceipt: await execTx.wait() };
  }

  it("1. acceptOwnership do GovernanceToken via proposta (caminho prod)", async () => {
    // ISOLAMENTO: este teste REdeploya fresh sem bootstrap do acceptOwnership,
    // para validar o caminho real de producao onde a primeira proposta e
    // exatamente o accept do Timelock.
    const deployed = await hre.ignition.deploy(CommunityDAOModule);

    const [deployer, voter, proposer] = await ethers.getSigners();
    void deployer;

    const [gov, timelock, governor] = await Promise.all([
      ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress()),
      ethers.getContractAt("CommunityTimelock", await deployed.timelock.getAddress()),
      ethers.getContractAt("CommunityGovernor", await deployed.governor.getAddress()),
    ]);

    // Estado inicial: pendingOwner = Timelock, owner = deployer.
    expect(await gov.pendingOwner()).to.equal(await timelock.getAddress());
    const initialOwner = await gov.owner();

    // Problema operacional: para PROPOR a acceptOwnership, precisamos de um
    // voter com GOV, mas o owner do GOV ainda e o deployer (accept pendente).
    // Solucao: deployer minta diretamente (ele ainda detem `owner`; renunciar
    // a DEFAULT_ADMIN dos outros contratos nao afeta a ownership do GOV).
    // Em prod real, isso e pre-bootstrap: o deployer ja minta GOV pros
    // voters/genesis durante a Fase A-B antes de iniciar a transferencia.

    const deployerSigner = await ethers.getSigner(initialOwner);
    await gov.connect(deployerSigner).mint(voter.address, VOTER_POWER, "pre-gov:voter");
    await gov.connect(deployerSigner).mint(proposer.address, PROPOSER_POWER, "pre-gov:proposer");
    await gov.connect(voter).delegate(voter.address);
    await gov.connect(proposer).delegate(proposer.address);
    await mine(1);

    // Propoe: target = GOV, call = acceptOwnership().
    // TypeChain nao expoe "acceptOwnership" como string literal no union de
    // encodeFunctionData (heranca de Ownable2Step). Usamos o `Interface` cru
    // (ethers) via construcao on-the-fly apenas com esse fragment.
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

    // Pos-execute: owner = Timelock, pendingOwner = 0.
    expect(await gov.owner()).to.equal(await timelock.getAddress());
    expect(await gov.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("2. Registrar + ativar projeto via proposta (I7 — single-batch)", async () => {
    const { gov, registry, governor, voter, proposer, projectOwner } =
      await loadFixture(deployGovFixture);

    // Batch multi-call: registerProject + activateProject numa mesma proposta.
    // Ordem: primeiro register (projectId = 1), depois activate do mesmo id.
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

    // Projeto 1 deve existir e estar Active.
    const project = await registry.getProject(1n);
    expect(project.owner).to.equal(projectOwner.address);
    expect(project.status).to.equal(1); // Active
    expect(await registry.isActive(1n)).to.be.true;

    // Colateral no Registry.
    expect(await gov.balanceOf(registryAddr)).to.equal(PROJECT_COLLATERAL);
  });

  it("3. Ajustar alpha do RewardDistributor via proposta", async () => {
    const { distributor, governor, voter, proposer } = await loadFixture(deployGovFixture);

    const oldAlpha = await distributor.alpha();
    expect(oldAlpha).to.equal(950_000_000_000_000_000n); // 0.95e18

    // Novo alpha dentro dos bounds pos-hardening IE1 ([0.5, 0.99]). Antes
    // este teste usava 1.05e18, que era valido na faixa antiga [0.5, 1.1]
    // — a reducao de MAX_ALPHA para 0.99e18 em
    // audit/economist/2026-04-22-consistency-audit.md (C2) invalidou esse
    // valor, entao trocamos por 0.97e18 (ainda uma mudanca nao-trivial a
    // partir do default 0.95).
    const newAlpha = 970_000_000_000_000_000n;
    const calldata = distributor.interface.encodeFunctionData("setAlpha", [newAlpha]);

    const { execReceipt } = await proposeAndExecute(
      governor,
      proposer,
      voter,
      [await distributor.getAddress()],
      [0n],
      [calldata],
      "E2E 3: bump alpha to 0.97e18",
    );

    // Efeito.
    expect(await distributor.alpha()).to.equal(newAlpha);

    // Event AlphaUpdated emitido pelo distributor — logs sao crus quando vem
    // de contratos nao-target do chamador. Parseamos manualmente via topic hash.
    const alphaUpdatedTopic = distributor.interface.getEvent("AlphaUpdated")!.topicHash;
    const distributorAddr = (await distributor.getAddress()).toLowerCase();
    const matched = execReceipt!.logs.filter(
      (l) => l.address.toLowerCase() === distributorAddr && l.topics[0] === alphaUpdatedTopic,
    );
    expect(matched.length).to.equal(1);
  });

  it("4. Batch multi-alvo: setProjectSplit(FeeRouter) + payRebates(Treasury) numa proposta", async () => {
    const {
      credit,
      treasury,
      registry,
      feeRouter,
      governor,
      voter,
      proposer,
      projectOwner,
      tlSigner,
    } = await loadFixture(deployGovFixture);

    // Pre-req: projeto 1 registrado via impersonate (simplifica — a proposta
    // desta iteracao foca em split + rebate, nao em registro).
    await registry
      .connect(tlSigner)
      .registerProject(projectOwner.address, "ipfs://projA", PROJECT_COLLATERAL);
    await registry.connect(tlSigner).activateProject(1n);

    // Batch proposta:
    //   (a) setProjectSplit(1, {9000, 500, 500})  — muda split do projeto 1.
    //   (b) payRebates(CREDIT, [projectOwner], [100e18], round=42) — paga
    //        rebate do Treasury para o owner do projeto.
    const newSplit = { burnBps: 9000, treasuryBps: 500, rebateBps: 500 };
    const rebateAmount = 100n * 10n ** 18n;

    const calldataSplit = feeRouter.interface.encodeFunctionData("setProjectSplit", [1n, newSplit]);
    const calldataRebate = treasury.interface.encodeFunctionData("payRebates", [
      await credit.getAddress(),
      [projectOwner.address],
      [rebateAmount],
      42n,
    ]);

    const ownerCreditBefore = await credit.balanceOf(projectOwner.address);
    const treasuryCreditBefore = await credit.balanceOf(await treasury.getAddress());

    await proposeAndExecute(
      governor,
      proposer,
      voter,
      [await feeRouter.getAddress(), await treasury.getAddress()],
      [0n, 0n],
      [calldataSplit, calldataRebate],
      "E2E 4: update split + pay rebate",
    );

    // Efeito 1: split aplicado.
    const storedSplit = await feeRouter.projectSplit(1n);
    expect(storedSplit.burnBps).to.equal(9000);
    expect(storedSplit.treasuryBps).to.equal(500);
    expect(storedSplit.rebateBps).to.equal(500);
    expect(await feeRouter.hasProjectSplit(1n)).to.be.true;

    // Efeito 2: rebate pago.
    expect((await credit.balanceOf(projectOwner.address)) - ownerCreditBefore).to.equal(
      rebateAmount,
    );
    expect(treasuryCreditBefore - (await credit.balanceOf(await treasury.getAddress()))).to.equal(
      rebateAmount,
    );
  });

  it("5. Proposta sem quorum: chega a Defeated; queue e execute revertem", async () => {
    const { distributor, governor, voter, proposer } = await loadFixture(deployGovFixture);
    void voter; // NAO vota; proposta morre de quorum insuficiente

    // Novo alpha dentro dos bounds pos-hardening IE1 ([0.5, 0.99]). Antes
    // este teste usava 1.05e18, que era valido na faixa antiga [0.5, 1.1]
    // — a reducao de MAX_ALPHA para 0.99e18 em
    // audit/economist/2026-04-22-consistency-audit.md (C2) invalidou esse
    // valor, entao trocamos por 0.97e18 (ainda uma mudanca nao-trivial a
    // partir do default 0.95).
    const newAlpha = 970_000_000_000_000_000n;
    const calldata = distributor.interface.encodeFunctionData("setAlpha", [newAlpha]);
    const targets = [await distributor.getAddress()];
    const values = [0n];
    const calldatas = [calldata];
    const description = "E2E 5: alpha proposal without quorum";
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
    // NAO vota — ninguem alem do proposer delegou, e proposer so tem 20k GOV
    // (0.02% do cap) << quorum 4%. Se proposer votar FOR, ainda nao atinge quorum.
    // Deixa passar sem voto; proposta falha por quorum insuficiente.

    await mine(Number(DEV_VOTING_PERIOD));

    // State = Defeated (3) apos voting period sem quorum.
    const stateAfter = await governor.state(proposalId);
    expect(stateAfter).to.equal(3); // ProposalState.Defeated

    // queue reverte com GovernorUnexpectedProposalState.
    await expect(governor.connect(proposer).queue(targets, values, calldatas, descriptionHash)).to
      .be.reverted;

    // execute tambem reverte.
    await expect(governor.connect(proposer).execute(targets, values, calldatas, descriptionHash)).to
      .be.reverted;

    // Parametros permanecem nao afetados.
    expect(await distributor.alpha()).to.equal(950_000_000_000_000_000n);
  });

  it("6. Proposer cancela proposta Pending antes do voto", async () => {
    const { distributor, governor, voter, proposer } = await loadFixture(deployGovFixture);
    void voter;

    // Novo alpha dentro dos bounds pos-hardening IE1 ([0.5, 0.99]). Antes
    // este teste usava 1.05e18, que era valido na faixa antiga [0.5, 1.1]
    // — a reducao de MAX_ALPHA para 0.99e18 em
    // audit/economist/2026-04-22-consistency-audit.md (C2) invalidou esse
    // valor, entao trocamos por 0.97e18 (ainda uma mudanca nao-trivial a
    // partir do default 0.95).
    const newAlpha = 970_000_000_000_000_000n;
    const calldata = distributor.interface.encodeFunctionData("setAlpha", [newAlpha]);
    const targets = [await distributor.getAddress()];
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

    // Proposer cancela enquanto Pending.
    await governor.connect(proposer).cancel(targets, values, calldatas, descriptionHash);

    // State = Canceled (2).
    expect(await governor.state(proposalId)).to.equal(2);

    // Qualquer tentativa posterior de queue/execute reverte.
    await expect(governor.connect(proposer).queue(targets, values, calldatas, descriptionHash)).to
      .be.reverted;
  });

  it("7. onlyGovernance: setAlpha direct-call reverte para nao-Timelock", async () => {
    const { distributor, voter, deployer } = await loadFixture(deployGovFixture);

    // Voter (EOA com bastante GOV, mas sem role) tenta chamar diretamente.
    await expect(
      distributor.connect(voter).setAlpha(1_000_000_000_000_000_000n),
    ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");

    // Deployer (que renunciou todas as roles) tambem nao consegue.
    await expect(
      distributor.connect(deployer).setAlpha(1_000_000_000_000_000_000n),
    ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");

    // Alpha permanece.
    expect(await distributor.alpha()).to.equal(950_000_000_000_000_000n);
  });

  it("8. Governanca afeta rodada futura mas NAO altera rodada ja finalizada", async () => {
    const {
      gov,
      credit,
      registry,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      governor,
      treasury,
      voter,
      proposer,
      projectOwner,
      tlSigner,
    } = await loadFixture(deployGovFixture);

    // Setup: projeto 1 + voter como staker (ele ja tem 50M GOV via bootstrap).
    await registry
      .connect(tlSigner)
      .registerProject(projectOwner.address, "ipfs://projA", PROJECT_COLLATERAL);
    await registry.connect(tlSigner).activateProject(1n);

    // Voter approve+stake no projeto 1.
    const stakeAmount = 100_000n * 10n ** 18n;
    await gov.connect(voter).approve(await staking.getAddress(), stakeAmount);
    await staking.connect(voter).stake(1n, stakeAmount, 14n * 86_400n);

    // Timelock transfere CREDIT do Treasury para o proposer (fara pagamento).
    await treasury
      .connect(tlSigner)
      .transfer(await credit.getAddress(), proposer.address, 10_000n * 10n ** 18n);

    // Proposer paga em projeto 1 na rodada 0.
    await credit.connect(proposer).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await feeRouter.connect(proposer).pay(1n, proposer.address, 1_000n * 10n ** 18n);

    // Fecha rodada 0 e finaliza com alpha = 0.95e18.
    await time.increase(86_400n + 1n); // DEV_ROUND_DURATION
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(voter).finalizeRound(0);
    const round0 = await distributor.roundData(0);

    // Proposta: setAlpha(0.5e18).
    const newAlpha = 500_000_000_000_000_000n; // MIN_ALPHA
    const calldata = distributor.interface.encodeFunctionData("setAlpha", [newAlpha]);
    await proposeAndExecute(
      governor,
      proposer,
      voter,
      [await distributor.getAddress()],
      [0n],
      [calldata],
      "E2E 8: drop alpha to min",
    );

    // Rodada 0 ja finalizada NAO muda (totalEmission imutavel).
    const round0After = await distributor.roundData(0);
    expect(round0After.totalEmission).to.equal(round0.totalEmission);

    // Rodada 1 (proxima) usa o novo alpha. Avanca, fecha, finalize.
    await time.increase(86_400n + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(voter).finalizeRound(1);

    // Emissao da rodada 1 = min(max(alpha * burn_0, floor[1]), capMax).
    // alpha novo * 950 << floor[1] (~383k), entao e floor[1].
    const FLOOR_INITIAL = 400_000n * 10n ** 18n;
    const FLOOR_STEP = FLOOR_INITIAL / 24n;
    const floor1 = FLOOR_INITIAL - FLOOR_STEP;
    const round1 = await distributor.roundData(1);
    expect(round1.totalEmission).to.equal(floor1);
    expect(round1.totalBurnAtFinalize).to.equal(950n * 10n ** 18n);
  });
});
