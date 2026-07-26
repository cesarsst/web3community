import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

/**
 * E2E — ProjectLifecycle (remodel 2026-07-08)
 *
 * Cobertura: ciclo de vida completo de um projeto no {ProjectRegistry} e o
 * impacto nos dependentes do modelo vigente (Staking, FeeRouterV2,
 * ProjectFunding). Complementa `FullLifecycle.test.ts` explorando os 4 estados
 * do enum Status e suas transicoes.
 *
 * Cenarios cobertos:
 *   1. Pending -> Active: stake/pay bloqueados em Pending, liberados apos activate.
 *   2. Probation inicial por tempo: pay funciona normalmente; isInProbation
 *      transita de true para false apos a janela (sem penalidade de reward — o
 *      modelo de emissao foi removido).
 *   3. Probation punitiva (status Probation): stake novo e pay bloqueados;
 *      unstake ainda exige lock expirado (bypass so em Removed).
 *   4. Removed (slash): colateral vai pro treasury; staker consegue unstake cedo.
 *   5. Removed (clean): colateral volta pro owner original.
 *   6. Rev-share acruado antes da remocao permanece sacavel — historia e
 *      historia. Enquanto o investidor mantem GOV stakeado, o claim honra a
 *      receita ja notificada mesmo com o projeto Removed.
 *   7. Ownership 2-step do projeto: transfer + accept; o pagamento (appRecipient
 *      dinamico via Registry.owner) segue o novo dono.
 *
 * Todos usam `impersonateAccount(timelock)` para execucoes privilegiadas
 * (registry) em vez de propostas completas do Governor, conforme padrao do
 * `FullLifecycle.test.ts`. Proposta real e2e fica em `governanceFlow.e2e.test.ts`.
 *
 * Nota USDC: a fixture seta `DEPLOY_USDC_MOCK=true` (PSM reverte sem lastro).
 */
describe("E2E: ProjectLifecycle — estados do projeto e impacto nos dependentes", function () {
  this.timeout(180_000);

  const E18 = 10n ** 18n;
  const E6 = 10n ** 6n;

  const DEV_PROBATION_DURATION = 86_400n; // 1d
  const MIN_LOCK = 14n * 86_400n; // 14d
  const MAX_LOCK = 365n * 86_400n;

  const ALICE_GOV = 50_000n * E18;
  const BOB_GOV = 30_000n * E18;
  const PROJECT_COLLATERAL = 5_000n * E18;

  const FEE_BPS = 250n; // 2,5%

  async function deployLifecycleFixture() {
    const original = process.env.DEPLOY_USDC_MOCK;
    process.env.DEPLOY_USDC_MOCK = "true";
    let deployed;
    try {
      const path = require.resolve("../../ignition/modules/Dao");
      delete require.cache[path];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../ignition/modules/Dao");
      deployed = await hre.ignition.deploy(mod.default);
    } finally {
      if (original === undefined) delete process.env.DEPLOY_USDC_MOCK;
      else process.env.DEPLOY_USDC_MOCK = original;
    }

    const [deployer, alice, bob, charlie, projectOwnerA, projectOwnerB] = await ethers.getSigners();

    const [gov, credit, timelock, registry, treasury, staking, usdc, psm, funding, feeRouterV2] =
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
      ]);

    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    const tlSigner = await ethers.getSigner(tlAddr);
    await setBalance(tlSigner.address, ethers.parseEther("100"));

    await gov.connect(tlSigner).acceptOwnership();

    // Mint GOV para os atores.
    await gov.connect(tlSigner).mint(alice.address, ALICE_GOV, "e2e:alice");
    await gov.connect(tlSigner).mint(bob.address, BOB_GOV, "e2e:bob");
    await gov
      .connect(tlSigner)
      .mint(projectOwnerA.address, PROJECT_COLLATERAL, "e2e:projA:collateral");
    await gov
      .connect(tlSigner)
      .mint(projectOwnerB.address, PROJECT_COLLATERAL, "e2e:projB:collateral");

    // Semeia USDC para os atores comprarem CREDIT no PSM.
    for (const s of [alice, charlie]) {
      await usdc.mint(s.address, 1_000_000n * E6);
      await usdc.connect(s).approve(await psm.getAddress(), ethers.MaxUint256);
    }

    // Owners aprovam Registry para transferFrom do colateral.
    await gov.connect(projectOwnerA).approve(await registry.getAddress(), PROJECT_COLLATERAL);
    await gov.connect(projectOwnerB).approve(await registry.getAddress(), PROJECT_COLLATERAL);

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
      deployer,
      alice,
      bob,
      charlie,
      projectOwnerA,
      projectOwnerB,
      tlSigner,
    };
  }

  it("Pending -> Active: stake e pay bloqueiam em Pending; liberam apos activate", async () => {
    const { gov, credit, registry, staking, psm, feeRouterV2, alice, charlie, projectOwnerA, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    // Register project mas NAO activate.
    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;

    expect(await registry.isActive(projectId)).to.be.false;
    expect((await registry.getProject(projectId)).status).to.equal(0); // Pending

    // Stake reverte com ProjectNotActive.
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await expect(staking.connect(alice).stake(projectId, 10_000n * E18, MIN_LOCK))
      .to.be.revertedWithCustomError(staking, "ProjectNotActive")
      .withArgs(projectId);

    // Charlie compra CREDIT e aprova o router.
    await psm.connect(charlie).buy(1_000n * E6);
    await credit.connect(charlie).approve(await feeRouterV2.getAddress(), ethers.MaxUint256);

    // Pay reverte com ProjectNotActive (FeeRouterV2 checa antes do transferFrom).
    await expect(
      feeRouterV2.connect(charlie).pay(projectId, 1_000n * E18),
    ).to.be.revertedWithCustomError(feeRouterV2, "ProjectNotActive");

    // Activate — agora tudo desbloqueia.
    await registry.connect(tlSigner).activateProject(projectId);
    expect(await registry.isActive(projectId)).to.be.true;

    await staking.connect(alice).stake(projectId, 10_000n * E18, MIN_LOCK);
    expect((await staking.getPosition(alice.address, projectId)).amount).to.equal(10_000n * E18);

    await expect(feeRouterV2.connect(charlie).pay(projectId, 1_000n * E18)).to.not.be.reverted;
  });

  it("Probation inicial por tempo: pay funciona; isInProbation transita para false", async () => {
    const { gov, credit, registry, staking, psm, feeRouterV2, alice, charlie, projectOwnerA, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    // Logo apos activate: isInProbation = true (janela automatica), status Active.
    expect(await registry.isInProbation(projectId)).to.be.true;
    expect(await registry.isActive(projectId)).to.be.true;

    // Stake e pagamento dentro da janela de probation funcionam normalmente
    // (no modelo vigente nao ha penalidade de reward — a emissao foi removida).
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectId, 10_000n * E18, MIN_LOCK);

    await psm.connect(charlie).buy(2_000n * E6); // 2000 CREDIT (paga duas vezes)
    await credit.connect(charlie).approve(await feeRouterV2.getAddress(), ethers.MaxUint256);

    const ownerBefore = await credit.balanceOf(projectOwnerA.address);
    const amount = 1_000n * E18;
    await feeRouterV2.connect(charlie).pay(projectId, amount);
    // Sem rodada de funding -> app recebe 97,5% (fee 2,5%).
    expect((await credit.balanceOf(projectOwnerA.address)) - ownerBefore).to.equal(
      (amount * (10_000n - FEE_BPS)) / 10_000n,
    );

    // Ainda dentro da janela.
    await time.increase(DEV_PROBATION_DURATION / 2n);
    expect(await registry.isInProbation(projectId)).to.be.true;

    // Apos a janela (probation = 1d), isInProbation vira false; projeto segue Active.
    await time.increase(DEV_PROBATION_DURATION);
    expect(await registry.isInProbation(projectId)).to.be.false;
    expect(await registry.isActive(projectId)).to.be.true;

    // Pagamento pos-probation continua funcionando igual.
    const ownerBefore2 = await credit.balanceOf(projectOwnerA.address);
    await feeRouterV2.connect(charlie).pay(projectId, amount);
    expect((await credit.balanceOf(projectOwnerA.address)) - ownerBefore2).to.equal(
      (amount * (10_000n - FEE_BPS)) / 10_000n,
    );
  });

  it("Probation punitiva (status Probation): stake novo e pay bloqueados; unstake exige lock", async () => {
    const { gov, credit, registry, staking, psm, feeRouterV2, alice, charlie, projectOwnerA, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectId, 10_000n * E18, MIN_LOCK);

    // Move para Probation punitiva.
    await registry.connect(tlSigner).setProbation(projectId);
    expect((await registry.getProject(projectId)).status).to.equal(2); // Probation
    expect(await registry.isActive(projectId)).to.be.false;
    expect(await registry.isInProbation(projectId)).to.be.false;

    // Stake novo reverte (projeto nao Active).
    await expect(staking.connect(alice).stake(projectId, 1_000n * E18, MIN_LOCK))
      .to.be.revertedWithCustomError(staking, "ProjectNotActive")
      .withArgs(projectId);

    await expect(staking.connect(alice).increaseStake(projectId, 1_000n * E18))
      .to.be.revertedWithCustomError(staking, "ProjectNotActive")
      .withArgs(projectId);

    // Pay reverte.
    await psm.connect(charlie).buy(1_000n * E6);
    await credit.connect(charlie).approve(await feeRouterV2.getAddress(), ethers.MaxUint256);
    await expect(
      feeRouterV2.connect(charlie).pay(projectId, 100n * E18),
    ).to.be.revertedWithCustomError(feeRouterV2, "ProjectNotActive");

    // Unstake antes do lock: reverte (Probation NAO bypassa lock).
    await expect(staking.connect(alice).unstakeAll(projectId)).to.be.revertedWithCustomError(
      staking,
      "LockNotExpired",
    );

    // Apos o lock expirar, unstake normal funciona mesmo em Probation.
    await time.increase(MIN_LOCK + 1n);
    const aliceGovBefore = await gov.balanceOf(alice.address);
    await staking.connect(alice).unstakeAll(projectId);
    expect((await gov.balanceOf(alice.address)) - aliceGovBefore).to.equal(10_000n * E18);

    // Reactivate.
    await registry.connect(tlSigner).reactivate(projectId);
    expect(await registry.isActive(projectId)).to.be.true;

    await gov.connect(alice).approve(await staking.getAddress(), 5_000n * E18);
    await staking.connect(alice).stake(projectId, 5_000n * E18, MIN_LOCK);
    expect((await staking.getPosition(alice.address, projectId)).amount).to.equal(5_000n * E18);
  });

  it("Removed (slash): colateral vai pro treasury; staker bypass de lock", async () => {
    const { gov, registry, staking, treasury, alice, projectOwnerA, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    const aliceStake = 20_000n * E18;
    await staking.connect(alice).stake(projectId, aliceStake, 90n * 86_400n);

    const treasuryGovBefore = await gov.balanceOf(await treasury.getAddress());
    expect(await gov.balanceOf(await registry.getAddress())).to.equal(PROJECT_COLLATERAL);

    await expect(
      registry.connect(tlSigner).removeProject(projectId, true, await treasury.getAddress()),
    )
      .to.emit(registry, "ProjectRemoved")
      .withArgs(projectId, true, PROJECT_COLLATERAL);

    expect(await gov.balanceOf(await registry.getAddress())).to.equal(0n);
    expect((await gov.balanceOf(await treasury.getAddress())) - treasuryGovBefore).to.equal(
      PROJECT_COLLATERAL,
    );

    const removedProject = await registry.getProject(projectId);
    expect(removedProject.status).to.equal(3); // Removed
    expect(removedProject.collateral).to.equal(0n);

    // Alice consegue unstake IMEDIATAMENTE mesmo com lock 90d vigente.
    const aliceGovBefore = await gov.balanceOf(alice.address);
    await expect(staking.connect(alice).unstakeAll(projectId))
      .to.emit(staking, "EarlyUnstakeAllowed")
      .withArgs(alice.address, projectId, aliceStake);
    expect((await gov.balanceOf(alice.address)) - aliceGovBefore).to.equal(aliceStake);
  });

  it("Removed (clean): colateral volta pro owner original", async () => {
    const { gov, registry, projectOwnerA, tlSigner } = await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    const ownerGovBefore = await gov.balanceOf(projectOwnerA.address);

    await registry.connect(tlSigner).removeProject(projectId, false, ethers.ZeroAddress);

    expect((await gov.balanceOf(projectOwnerA.address)) - ownerGovBefore).to.equal(
      PROJECT_COLLATERAL,
    );
    expect(await gov.balanceOf(await registry.getAddress())).to.equal(0n);

    await expect(registry.connect(tlSigner).removeProject(projectId, false, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved")
      .withArgs(projectId);

    await expect(registry.connect(projectOwnerA).updateMetadata(projectId, "ipfs://post-removed"))
      .to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved")
      .withArgs(projectId);
  });

  it("Rev-share acruado antes da remocao permanece sacavel: claim honra receita historica", async () => {
    const {
      gov,
      credit,
      registry,
      staking,
      treasury,
      psm,
      funding,
      feeRouterV2,
      alice,
      charlie,
      projectOwnerA,
      tlSigner,
    } = await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    // Alice stakeia (necessario pra investir e pra sacar rev-share depois).
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectId, 10_000n * E18, MAX_LOCK);

    // Alice compra CREDIT e financia INTEGRALMENTE a rodada (alvo minimo 100).
    const target = 1_000n * E18;
    const revShareBps = 1000n; // 10%
    await psm.connect(alice).buy(2_000n * E6); // 2000 CREDIT
    await funding.connect(projectOwnerA).openRound(projectId, target, revShareBps, 30n * 86_400n);
    await credit.connect(alice).approve(await funding.getAddress(), ethers.MaxUint256);
    await funding.connect(alice).invest(projectId, target); // completa -> Funded
    expect((await funding.rounds(projectId)).status).to.equal(2n); // Funded

    // Charlie paga no projeto ainda ativo -> rev-share notificado.
    await psm.connect(charlie).buy(1_000n * E6);
    await credit.connect(charlie).approve(await feeRouterV2.getAddress(), ethers.MaxUint256);
    const payment = 1_000n * E18;
    await feeRouterV2.connect(charlie).pay(projectId, payment);

    const expectedPending = (payment * revShareBps) / 10_000n; // 100 (Alice detem 100% das shares)
    expect(await funding.pendingRevenue(projectId, alice.address)).to.equal(expectedPending);

    // Agora REMOVE o projeto (slash). O rev-share ja acruado deve sobreviver.
    await registry.connect(tlSigner).removeProject(projectId, true, await treasury.getAddress());
    expect((await registry.getProject(projectId)).status).to.equal(3); // Removed

    // Alice ainda tem GOV stakeado (nao fez unstake) -> claim honra o historico.
    expect(await funding.pendingRevenue(projectId, alice.address)).to.equal(expectedPending);
    const aliceBefore = await credit.balanceOf(alice.address);
    await funding.connect(alice).claim(projectId);
    expect((await credit.balanceOf(alice.address)) - aliceBefore).to.equal(expectedPending);

    // Novos pays no projeto Removed revertem.
    await expect(
      feeRouterV2.connect(charlie).pay(projectId, 100n * E18),
    ).to.be.revertedWithCustomError(feeRouterV2, "ProjectNotActive");
  });

  it("Ownership 2-step do projeto: transfer + accept; appRecipient dinamico segue o dono", async () => {
    const { credit, registry, psm, feeRouterV2, charlie, projectOwnerA, projectOwnerB, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    // Sem override de appRecipient — pay resolve dinamicamente via Registry.owner.
    expect(await feeRouterV2.appRecipientOf(projectId)).to.equal(ethers.ZeroAddress);

    // Charlie compra CREDIT e aprova o router.
    await psm.connect(charlie).buy(1_000n * E6);
    await credit.connect(charlie).approve(await feeRouterV2.getAddress(), ethers.MaxUint256);
    const amount = 100n * E18;
    const toApp = (amount * (10_000n - FEE_BPS)) / 10_000n; // 97,5

    // Inicia transferencia de ownership.
    await registry.connect(projectOwnerA).transferProjectOwnership(projectId, projectOwnerB.address);
    expect(await registry.pendingOwner(projectId)).to.equal(projectOwnerB.address);

    // Antes do accept, owner ainda e A — pay vai pra A (sem rodada de funding).
    const ownerABefore = await credit.balanceOf(projectOwnerA.address);
    await feeRouterV2.connect(charlie).pay(projectId, amount);
    expect((await credit.balanceOf(projectOwnerA.address)) - ownerABefore).to.equal(toApp);

    // B aceita ownership.
    await registry.connect(projectOwnerB).acceptProjectOwnership(projectId);
    expect((await registry.getProject(projectId)).owner).to.equal(projectOwnerB.address);
    expect(await registry.pendingOwner(projectId)).to.equal(ethers.ZeroAddress);

    // Agora o pagamento segue o novo owner (lookup dinamico via Registry).
    const ownerBBefore = await credit.balanceOf(projectOwnerB.address);
    await feeRouterV2.connect(charlie).pay(projectId, amount);
    expect((await credit.balanceOf(projectOwnerB.address)) - ownerBBefore).to.equal(toApp);

    // A antigo owner nao consegue mais updateMetadata.
    await expect(registry.connect(projectOwnerA).updateMetadata(projectId, "ipfs://hijack"))
      .to.be.revertedWithCustomError(registry, "NotProjectOwner")
      .withArgs(projectId, projectOwnerA.address);
  });
});
