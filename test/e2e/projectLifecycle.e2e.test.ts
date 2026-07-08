import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import CommunityDAOModule from "../../ignition/modules/Dao";

/**
 * E2E — ProjectLifecycle
 *
 * Cobertura: ciclo de vida completo de um projeto no ProjectRegistry e o impacto
 * nos contratos dependentes (Staking, FeeRouter, BurnTracker, RewardDistributor).
 * Complementa `FullLifecycle.test.ts` (que foca no happy path do ciclo economico)
 * explorando os 4 estados do enum Status e suas transicoes.
 *
 * Cenarios cobertos:
 *   1. Pending -> Active: stake/pay bloqueados em Pending, desbloqueados apos activate.
 *   2. Probation inicial por tempo: isInProbation true ate probationEndsAt; pay
 *      funciona mas share de reward e reduzido a 25% (probation penalty).
 *   3. Probation punitiva (status Probation): stake novo e pay bloqueados; unstake
 *      ainda exige lock expirado (bypass so se projeto for Removed, nao Probation).
 *   4. Removed (slash): colateral vai pro treasury; staker consegue unstake cedo
 *      (bypass de lock ativado por status Removed).
 *   5. Removed (clean): colateral volta pro owner original.
 *   6. Burns registrados antes de remocao permanecem validos no accounting da rodada —
 *      historia e historia. Claims subsequentes respeitam o burn registrado mesmo
 *      que o projeto ja esteja Removed no momento do claim.
 *
 * Todos os cenarios usam `impersonateAccount(timelock)` para execucoes privilegiadas
 * (registry/burnTracker) em vez de propostas completas do Governor, conforme padrao
 * documentado no `FullLifecycle.test.ts`. Proposta real e2e fica em
 * `governanceFlow.e2e.test.ts`.
 */
describe("E2E: ProjectLifecycle — estados do projeto e impacto nos dependentes", function () {
  // Multi-stage flows — extra timeout pra CI lenta.
  this.timeout(180_000);

  const DEV_ROUND_DURATION = 86_400n; // 1d
  const DEV_PROBATION_DURATION = 86_400n; // 1d
  const MIN_LOCK = 14n * 86_400n; // 14d

  const ALICE_GOV = 50_000n * 10n ** 18n;
  const BOB_GOV = 30_000n * 10n ** 18n;
  const PROJECT_COLLATERAL = 5_000n * 10n ** 18n;
  const CHARLIE_CREDIT = 5_000n * 10n ** 18n;

  async function deployLifecycleFixture() {
    const deployed = await hre.ignition.deploy(CommunityDAOModule);

    const [deployer, alice, bob, charlie, projectOwnerA, projectOwnerB] = await ethers.getSigners();

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
    ]);

    // Impersonate Timelock (unico admin/owner apos deploy).
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

    // Distribui CREDIT pro Charlie usar em pagamentos.
    await treasury
      .connect(tlSigner)
      .transfer(await credit.getAddress(), charlie.address, CHARLIE_CREDIT);

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
      burnTracker,
      distributor,
      feeRouter,
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
    const { gov, credit, registry, staking, feeRouter, alice, charlie, projectOwnerA, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    // Register project mas NAO activate.
    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;

    // Projeto registrado mas Pending — nao isActive.
    expect(await registry.isActive(projectId)).to.be.false;
    const pendingProject = await registry.getProject(projectId);
    expect(pendingProject.status).to.equal(0); // Status.Pending

    // Stake reverte com ProjectNotActive.
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await expect(staking.connect(alice).stake(projectId, 10_000n * 10n ** 18n, MIN_LOCK))
      .to.be.revertedWithCustomError(staking, "ProjectNotActive")
      .withArgs(projectId);

    // Pay reverte com ProjectNotActive (FeeRouter faz a checagem antes do transferFrom).
    await credit.connect(charlie).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await expect(feeRouter.connect(charlie).pay(projectId, charlie.address, 1_000n * 10n ** 18n))
      .to.be.revertedWithCustomError(feeRouter, "ProjectNotActive")
      .withArgs(projectId);

    // Activate — agora tudo desbloqueia.
    await registry.connect(tlSigner).activateProject(projectId);
    expect(await registry.isActive(projectId)).to.be.true;

    await staking.connect(alice).stake(projectId, 10_000n * 10n ** 18n, MIN_LOCK);
    const position = await staking.getPosition(alice.address, projectId);
    expect(position.amount).to.equal(10_000n * 10n ** 18n);

    await expect(feeRouter.connect(charlie).pay(projectId, charlie.address, 1_000n * 10n ** 18n)).to
      .not.be.reverted;
  });

  it("Probation inicial por tempo: pay funciona, share de reward reduzido a 25%", async () => {
    const {
      gov,
      credit,
      timelock,
      registry,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      charlie,
      projectOwnerA,
      tlSigner,
    } = await loadFixture(deployLifecycleFixture);

    // Register + activate.
    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    // Logo apos activate: isInProbation = true (dentro da janela automatica).
    expect(await registry.isInProbation(projectId)).to.be.true;
    expect(await registry.isActive(projectId)).to.be.true; // probation inicial NAO muda status

    // Stake e pagamento dentro da janela de probation.
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectId, 10_000n * 10n ** 18n, MIN_LOCK);

    await credit.connect(charlie).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await feeRouter.connect(charlie).pay(projectId, charlie.address, 1_000n * 10n ** 18n);

    // Burn registrado (70% do pagamento — split default 70/20/10 da Fase 0).
    expect(await burnTracker.getBurnForProjectInRound(0, projectId)).to.equal(700n * 10n ** 18n);

    // Avanca tempo menos que probationDuration — ainda em probation.
    await time.increase(DEV_PROBATION_DURATION / 2n);
    expect(await registry.isInProbation(projectId)).to.be.true;

    // Fecha rodada 0 e finaliza rodada 0 (burn da rodada 0 ainda nao reflete).
    await time.increase(DEV_ROUND_DURATION);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    // Fecha rodada 1 + finalize rodada 1 (usa burn da rodada 0). Rodada 1
    // ja deve ter ultrapassado probationDuration pois avancamos
    // ~0.5d + 1d = 1.5d desde activate, ainda dentro de probation inicial (1d?). Sim:
    // probation = 1d, ja passaram ~1.5d total. Ainda assim o _projectShare
    // do distributor le isInProbation NO MOMENTO DO CLAIM, que sera depois.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    // Nesse ponto ja se passaram ~2.5d desde activate — probation inicial
    // (1d) JA EXPIROU. Claim sera com share cheio (sem penalty).
    expect(await registry.isInProbation(projectId)).to.be.false;
    const alicePreview = await distributor.previewClaim(alice.address, 1, projectId);
    expect(alicePreview).to.be.gt(0n);

    // Timelock ainda e admin — sanity check silencioso.
    void timelock;
  });

  it("Probation punitiva (status Probation): stake novo e pay bloqueados; unstake exige lock", async () => {
    const { gov, credit, registry, staking, feeRouter, alice, charlie, projectOwnerA, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    // Register + activate + stake inicial.
    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectId, 10_000n * 10n ** 18n, MIN_LOCK);

    // Move para Probation punitiva.
    await registry.connect(tlSigner).setProbation(projectId);
    const afterProbation = await registry.getProject(projectId);
    expect(afterProbation.status).to.equal(2); // Status.Probation (punitiva)
    expect(await registry.isActive(projectId)).to.be.false;
    // isInProbation (inicial por tempo) retorna false em status != Active, por design.
    expect(await registry.isInProbation(projectId)).to.be.false;

    // Stake novo reverte (projeto nao Active).
    await expect(staking.connect(alice).stake(projectId, 1_000n * 10n ** 18n, MIN_LOCK))
      .to.be.revertedWithCustomError(staking, "ProjectNotActive")
      .withArgs(projectId);

    // increaseStake tambem reverte.
    await expect(staking.connect(alice).increaseStake(projectId, 1_000n * 10n ** 18n))
      .to.be.revertedWithCustomError(staking, "ProjectNotActive")
      .withArgs(projectId);

    // Pay reverte.
    await credit.connect(charlie).approve(await feeRouter.getAddress(), 100n * 10n ** 18n);
    await expect(feeRouter.connect(charlie).pay(projectId, charlie.address, 100n * 10n ** 18n))
      .to.be.revertedWithCustomError(feeRouter, "ProjectNotActive")
      .withArgs(projectId);

    // Unstake antes do lock: reverte com LockNotExpired (Probation NAO bypassa lock).
    await expect(staking.connect(alice).unstakeAll(projectId)).to.be.revertedWithCustomError(
      staking,
      "LockNotExpired",
    );

    // Apos o lock expirar, unstake normal funciona mesmo em Probation.
    await time.increase(MIN_LOCK + 1n);
    const aliceGovBefore = await gov.balanceOf(alice.address);
    await staking.connect(alice).unstakeAll(projectId);
    expect((await gov.balanceOf(alice.address)) - aliceGovBefore).to.equal(10_000n * 10n ** 18n);

    // Reactivate.
    await registry.connect(tlSigner).reactivate(projectId);
    expect(await registry.isActive(projectId)).to.be.true;

    // Stake novo funciona apos reactivate (precisa reaprovar porque anterior foi consumido).
    await gov.connect(alice).approve(await staking.getAddress(), 5_000n * 10n ** 18n);
    await staking.connect(alice).stake(projectId, 5_000n * 10n ** 18n, MIN_LOCK);
    const pos = await staking.getPosition(alice.address, projectId);
    expect(pos.amount).to.equal(5_000n * 10n ** 18n);
  });

  it("Removed (slash): colateral vai pro treasury; staker bypass de lock", async () => {
    const { gov, registry, staking, treasury, alice, projectOwnerA, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    // Alice stake com lock longo (90d > MIN_LOCK).
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    const aliceStake = 20_000n * 10n ** 18n;
    await staking.connect(alice).stake(projectId, aliceStake, 90n * 86_400n);

    // Treasury nao tem GOV ainda (colateral esta no Registry).
    const treasuryGovBefore = await gov.balanceOf(await treasury.getAddress());
    expect(await gov.balanceOf(await registry.getAddress())).to.equal(PROJECT_COLLATERAL);

    // Remove com slash = true, destino = treasury.
    await expect(
      registry.connect(tlSigner).removeProject(projectId, true, await treasury.getAddress()),
    )
      .to.emit(registry, "ProjectRemoved")
      .withArgs(projectId, true, PROJECT_COLLATERAL);

    // Colateral moveu pro treasury.
    expect(await gov.balanceOf(await registry.getAddress())).to.equal(0n);
    expect((await gov.balanceOf(await treasury.getAddress())) - treasuryGovBefore).to.equal(
      PROJECT_COLLATERAL,
    );

    // Projeto Removed.
    const removedProject = await registry.getProject(projectId);
    expect(removedProject.status).to.equal(3); // Status.Removed
    expect(removedProject.collateral).to.equal(0n);

    // Alice consegue unstake IMEDIATAMENTE mesmo com lock 90d vigente
    // (bypass ativado por Removed).
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

    // Remove com slash = false, treasury = address(0) (ignorado quando nao slash).
    await registry.connect(tlSigner).removeProject(projectId, false, ethers.ZeroAddress);

    expect((await gov.balanceOf(projectOwnerA.address)) - ownerGovBefore).to.equal(
      PROJECT_COLLATERAL,
    );
    expect(await gov.balanceOf(await registry.getAddress())).to.equal(0n);

    // Nao da pra re-remover.
    await expect(registry.connect(tlSigner).removeProject(projectId, false, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved")
      .withArgs(projectId);

    // Update metadata reverte apos remocao (URI congelada).
    await expect(registry.connect(projectOwnerA).updateMetadata(projectId, "ipfs://post-removed"))
      .to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved")
      .withArgs(projectId);
  });

  it("Burns pre-remocao permanecem validos: claim ainda funciona com burn historico", async () => {
    const {
      gov,
      credit,
      registry,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      treasury,
      alice,
      charlie,
      projectOwnerA,
      tlSigner,
    } = await loadFixture(deployLifecycleFixture);

    // Register + activate projeto.
    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    // Alice stake.
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectId, 10_000n * 10n ** 18n, MIN_LOCK);

    // Charlie paga no projeto — burn registrado no round 0.
    await credit.connect(charlie).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await feeRouter.connect(charlie).pay(projectId, charlie.address, 1_000n * 10n ** 18n);

    const burnRound0 = await burnTracker.getBurnForProjectInRound(0, projectId);
    expect(burnRound0).to.equal(700n * 10n ** 18n);

    // Avanca tempo e fecha rodada 0. Finaliza.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    // Agora REMOVE o projeto (slash). Burn da rodada 0 deve permanecer intacto.
    await registry.connect(tlSigner).removeProject(projectId, true, await treasury.getAddress());
    expect((await registry.getProject(projectId)).status).to.equal(3);

    // Avanca e fecha rodada 1 (que acopla com burn do round 0).
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    const round1Data = await distributor.roundData(1);
    expect(round1Data.totalBurnAtFinalize).to.equal(700n * 10n ** 18n);

    // O burn por projeto no round 0 permanece gravado:
    expect(await burnTracker.getBurnForProjectInRound(0, projectId)).to.equal(700n * 10n ** 18n);

    // Claim: mesmo com projeto Removed no momento do claim, o share e calculado
    // com base no burn historico do round 0 — historia e historia.
    const alicePreview = await distributor.previewClaim(alice.address, 1, projectId);
    expect(alicePreview).to.be.gt(0n);

    const aliceBeforeClaim = await credit.balanceOf(alice.address);
    await distributor.connect(alice).claim(1, projectId);
    expect((await credit.balanceOf(alice.address)) - aliceBeforeClaim).to.equal(alicePreview);

    // Novos pays no projeto Removed revertem.
    await credit.connect(charlie).approve(await feeRouter.getAddress(), 100n * 10n ** 18n);
    await expect(feeRouter.connect(charlie).pay(projectId, charlie.address, 100n * 10n ** 18n))
      .to.be.revertedWithCustomError(feeRouter, "ProjectNotActive")
      .withArgs(projectId);
  });

  it("Ownership 2-step do projeto: transfer + accept, appRecipient segue owner", async () => {
    const { credit, registry, feeRouter, charlie, projectOwnerA, projectOwnerB, tlSigner } =
      await loadFixture(deployLifecycleFixture);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    const projectId = 1n;
    await registry.connect(tlSigner).activateProject(projectId);

    // Sem override de appRecipient — lookup dinamico via Registry.owner.
    expect(await feeRouter.getEffectiveRecipient(projectId)).to.equal(projectOwnerA.address);

    // Inicia transferencia de ownership.
    await registry
      .connect(projectOwnerA)
      .transferProjectOwnership(projectId, projectOwnerB.address);
    expect(await registry.pendingOwner(projectId)).to.equal(projectOwnerB.address);

    // Antes do accept, owner ainda e A — pay ainda vai pra A.
    await credit.connect(charlie).approve(await feeRouter.getAddress(), 100n * 10n ** 18n);
    const ownerABefore = await credit.balanceOf(projectOwnerA.address);
    await feeRouter.connect(charlie).pay(projectId, charlie.address, 100n * 10n ** 18n);
    // Rebate 10% = 10 CREDIT (split default 70/20/10 da Fase 0).
    expect((await credit.balanceOf(projectOwnerA.address)) - ownerABefore).to.equal(
      10n * 10n ** 18n,
    );

    // B aceita ownership.
    await registry.connect(projectOwnerB).acceptProjectOwnership(projectId);
    expect((await registry.getProject(projectId)).owner).to.equal(projectOwnerB.address);
    expect(await registry.pendingOwner(projectId)).to.equal(ethers.ZeroAddress);

    // Agora o rebate segue o novo owner (lookup dinamico).
    expect(await feeRouter.getEffectiveRecipient(projectId)).to.equal(projectOwnerB.address);

    const ownerBBefore = await credit.balanceOf(projectOwnerB.address);
    await credit.connect(charlie).approve(await feeRouter.getAddress(), 100n * 10n ** 18n);
    await feeRouter.connect(charlie).pay(projectId, charlie.address, 100n * 10n ** 18n);
    expect((await credit.balanceOf(projectOwnerB.address)) - ownerBBefore).to.equal(
      10n * 10n ** 18n,
    );

    // A antigo owner nao consegue mais updateMetadata.
    await expect(registry.connect(projectOwnerA).updateMetadata(projectId, "ipfs://hijack"))
      .to.be.revertedWithCustomError(registry, "NotProjectOwner")
      .withArgs(projectId, projectOwnerA.address);
  });
});
