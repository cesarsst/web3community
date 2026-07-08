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
 * E2E — StakingRewards
 *
 * Cobertura: ciclo economico de staking direcionado + emissao de rewards
 * proporcional ao peso de stake e ao burn do projeto. Complementa
 * `FullLifecycle.test.ts` explorando edge cases cross-contract entre
 * Staking / BurnTracker / RewardDistributor:
 *
 *   1. Multi-staker num mesmo projeto: share proporcional ao peso (amount *
 *      multiplier).
 *   2. Multi-projeto para o mesmo staker: claim independente por projeto.
 *   3. Consolidacao de stake (Opcao B): amount soma, lockDuration =
 *      max(remaining, newLockDuration), lockStartAt resetado.
 *   4. increaseStake vs stake: increaseStake NAO reseta lockStartAt; stake reseta.
 *   5. extendLock nao encurta, aumenta peso proporcional.
 *   6. Snapshot anti-flash-stake: stake depois do snapshotBlock NAO conta
 *      para o claim. Valida invariante I5.
 *   7. Claim com peso 0 retorna 0 (no-op silencioso — nao consome slot de claim).
 *   8. Double-claim reverte com AlreadyClaimed.
 *   9. Bootstrap (rodada sem burn anterior): share do projeto via
 *      globalWeight/projectWeight do Staking.
 *  10. Probation penalty: share dividido por 4 quando projeto em probation
 *      inicial por tempo.
 *  11. previewClaim(user, round, projectId) == claim real.
 *  12. previewEmission(forRound) consulta burn da rodada anterior (live).
 *  13. claimMany agrega corretamente rounds+projects para o mesmo user.
 *
 * Todos os cenarios usam impersonate do Timelock (padrao documentado no
 * FullLifecycle). Proposta real via Governor fica em governanceFlow.e2e.test.ts.
 */
describe("E2E: StakingRewards — peso, share, snapshot e claim multi-actor", function () {
  this.timeout(180_000);

  const DEV_ROUND_DURATION = 86_400n; // 1d
  const MIN_LOCK = 14n * 86_400n;
  const MAX_LOCK = 365n * 86_400n;

  const ALICE_GOV = 200_000n * 10n ** 18n;
  const BOB_GOV = 100_000n * 10n ** 18n;
  const CAROL_GOV = 50_000n * 10n ** 18n;
  const PROJECT_COLLATERAL = 5_000n * 10n ** 18n;
  const USER_CREDIT = 20_000n * 10n ** 18n;

  async function deployStakingFixture() {
    const deployed = await hre.ignition.deploy(CommunityDAOModule);

    const [deployer, alice, bob, carol, payer, projectOwnerA, projectOwnerB, projectOwnerC] =
      await ethers.getSigners();

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

    // Impersonate Timelock.
    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    const tlSigner = await ethers.getSigner(tlAddr);
    await setBalance(tlSigner.address, ethers.parseEther("100"));
    await gov.connect(tlSigner).acceptOwnership();

    // Mint GOV pros stakers + owners.
    await gov.connect(tlSigner).mint(alice.address, ALICE_GOV, "e2e:alice");
    await gov.connect(tlSigner).mint(bob.address, BOB_GOV, "e2e:bob");
    await gov.connect(tlSigner).mint(carol.address, CAROL_GOV, "e2e:carol");
    for (const owner of [projectOwnerA, projectOwnerB, projectOwnerC]) {
      await gov.connect(tlSigner).mint(owner.address, PROJECT_COLLATERAL, "e2e:project:collateral");
      await gov.connect(owner).approve(await registry.getAddress(), PROJECT_COLLATERAL);
    }

    // Distribui CREDIT pro payer usar em pagamentos.
    await treasury
      .connect(tlSigner)
      .transfer(await credit.getAddress(), payer.address, USER_CREDIT);

    // Registra + ativa 3 projetos.
    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerA.address, "ipfs://projA", PROJECT_COLLATERAL);
    await registry.connect(tlSigner).activateProject(1n);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerB.address, "ipfs://projB", PROJECT_COLLATERAL);
    await registry.connect(tlSigner).activateProject(2n);

    await registry
      .connect(tlSigner)
      .registerProject(projectOwnerC.address, "ipfs://projC", PROJECT_COLLATERAL);
    await registry.connect(tlSigner).activateProject(3n);

    // Avanca tempo alem de probationDuration (1d DEV) para que claims nao sofram
    // penalty de probation por tempo. Rodada 0 vai acumular burns dentro desta
    // janela, mas como os claims ocorrem nas rodadas >=1 apos mais tempo
    // avancado, a probation por tempo ja tera expirado.
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
      carol,
      payer,
      projectOwnerA,
      projectOwnerB,
      projectOwnerC,
      tlSigner,
      projectA: 1n,
      projectB: 2n,
      projectC: 3n,
    };
  }

  it("Multi-staker num projeto: share proporcional ao peso de cada um", async () => {
    const {
      gov,
      credit,
      registry,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      bob,
      payer,
      tlSigner,
      projectA,
    } = await loadFixture(deployStakingFixture);

    // Alice e Bob stakeiam no MESMO projeto A com o MESMO lockDuration —
    // share deve ser puramente proporcional a amount.
    const aliceAmount = 100_000n * 10n ** 18n;
    const bobAmount = 50_000n * 10n ** 18n;
    const lockDuration = MIN_LOCK + 86_400n * 30n; // 44d

    await gov.connect(alice).approve(await staking.getAddress(), aliceAmount);
    await staking.connect(alice).stake(projectA, aliceAmount, lockDuration);

    await gov.connect(bob).approve(await staking.getAddress(), bobAmount);
    await staking.connect(bob).stake(projectA, bobAmount, lockDuration);

    // Payer paga no projeto A.
    await credit.connect(payer).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectA, payer.address, 1_000n * 10n ** 18n);

    // Avanca 2 rodadas: rodada 0 (closeRound -> finalize) acumulou burn,
    // rodada 1 e a que acopla com o burn do round 0.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    // Probation por tempo ja expirou (passaram ~2d, probation = 1d).
    expect(await registry.isInProbation(projectA)).to.be.false;

    // Claim ambos.
    const alicePreview = await distributor.previewClaim(alice.address, 1, projectA);
    const bobPreview = await distributor.previewClaim(bob.address, 1, projectA);

    expect(alicePreview).to.be.gt(0n);
    expect(bobPreview).to.be.gt(0n);

    // Peso(Alice) / Peso(Bob) == 100k / 50k == 2. Mesmo multiplier (mesmo lock).
    // Share segue mesma proporcao com tolerancia de +/- 0.5% para rounding.
    expect(alicePreview * 1_000n).to.be.gte(bobPreview * 1_990n);
    expect(alicePreview * 1_000n).to.be.lte(bobPreview * 2_010n);

    // Soma <= emissao do projeto.
    const projEmission = await distributor.getProjectEmission(1n, projectA);
    expect(alicePreview + bobPreview).to.be.lte(projEmission);
  });

  it("Multi-projeto para o mesmo staker: claim independente por projeto", async () => {
    const {
      gov,
      credit,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      payer,
      tlSigner,
      projectA,
      projectB,
    } = await loadFixture(deployStakingFixture);

    // Alice stakeia em A e B com amounts diferentes.
    const stakeA = 80_000n * 10n ** 18n;
    const stakeB = 40_000n * 10n ** 18n;

    await gov.connect(alice).approve(await staking.getAddress(), stakeA + stakeB);
    await staking.connect(alice).stake(projectA, stakeA, MIN_LOCK);
    await staking.connect(alice).stake(projectB, stakeB, MIN_LOCK);

    // Burns em ambos projetos.
    await credit.connect(payer).approve(await feeRouter.getAddress(), 3_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectA, payer.address, 2_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectB, payer.address, 1_000n * 10n ** 18n);

    // Avanca rodada 0 e 1.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    // Claim independente por projeto — Alice e a unica staker em cada um,
    // entao recebe 100% do share do projeto em ambos.
    const previewA = await distributor.previewClaim(alice.address, 1, projectA);
    const previewB = await distributor.previewClaim(alice.address, 1, projectB);
    expect(previewA).to.be.gt(0n);
    expect(previewB).to.be.gt(0n);

    // Share A / Share B ~ burn A / burn B = 1400 / 700 = 2 (70% de 2000 / 70% de 1000,
    // split default 70/20/10 da Fase 0).
    expect(previewA * 1_000n).to.be.gte(previewB * 1_990n);
    expect(previewA * 1_000n).to.be.lte(previewB * 2_010n);

    // Executa os 2 claims — nao interferem um no outro.
    await distributor.connect(alice).claim(1, projectA);
    await distributor.connect(alice).claim(1, projectB);

    // claim em A nao mata claim em B (independentes).
    await expect(distributor.connect(alice).claim(1, projectA))
      .to.be.revertedWithCustomError(distributor, "AlreadyClaimed")
      .withArgs(1, projectA, alice.address);
    await expect(distributor.connect(alice).claim(1, projectB))
      .to.be.revertedWithCustomError(distributor, "AlreadyClaimed")
      .withArgs(1, projectB, alice.address);
  });

  it("Consolidacao de stake (Opcao B): amount soma, lockDuration = max(rem, new), lockStartAt reseta", async () => {
    const { gov, staking, alice, tlSigner, projectA } = await loadFixture(deployStakingFixture);

    void tlSigner; // Timelock ja usado na fixture.

    const firstAmount = 50_000n * 10n ** 18n;
    const firstLock = 30n * 86_400n; // 30d > MIN_LOCK
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectA, firstAmount, firstLock);
    const pos1 = await staking.getPosition(alice.address, projectA);
    const firstStartAt = pos1.lockStartAt;

    // Avanca 5d (lock ainda vigente, remaining = 25d).
    await time.increase(5n * 86_400n);

    // Segundo stake: lockDuration = 20d (menor que remaining 25d).
    // Esperado: newAmount = 100k, newLockDuration = max(25d, 20d) = 25d,
    // lockStartAt = now (reset).
    const secondAmount = 50_000n * 10n ** 18n;
    const secondLock = 20n * 86_400n;
    // Pequeno problema: secondLock < MIN_LOCK (14d) seria revert — 20d > 14d, ok.
    await staking.connect(alice).stake(projectA, secondAmount, secondLock);

    const pos2 = await staking.getPosition(alice.address, projectA);
    expect(pos2.amount).to.equal(firstAmount + secondAmount);

    // lockStartAt resetou (> firstStartAt).
    expect(pos2.lockStartAt).to.be.gt(firstStartAt);

    // lockDuration = max(remaining, secondLock). Remaining ~ 25d; secondLock 20d.
    // Deve ficar ~25d (pode ter alguns segundos a menos por timing do bloco).
    // Checamos que foi consolidado com o max (i.e. >= 25d - slack).
    expect(pos2.lockDuration).to.be.gte(25n * 86_400n - 10n);
    expect(pos2.lockDuration).to.be.lt(30n * 86_400n);
  });

  it("increaseStake: amount aumenta, lockStartAt/lockDuration NAO reseta", async () => {
    const { gov, staking, alice, projectA } = await loadFixture(deployStakingFixture);

    const firstAmount = 50_000n * 10n ** 18n;
    const firstLock = 60n * 86_400n;
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectA, firstAmount, firstLock);
    const pos1 = await staking.getPosition(alice.address, projectA);

    await time.increase(10n * 86_400n); // 10d

    const addAmount = 20_000n * 10n ** 18n;
    await staking.connect(alice).increaseStake(projectA, addAmount);

    const pos2 = await staking.getPosition(alice.address, projectA);
    expect(pos2.amount).to.equal(firstAmount + addAmount);
    // lockStartAt PRESERVADO — increaseStake nao reseta.
    expect(pos2.lockStartAt).to.equal(pos1.lockStartAt);
    expect(pos2.lockDuration).to.equal(pos1.lockDuration);

    // Peso cresceu proporcional.
    const w1 = (firstAmount * (await staking.multiplier(firstLock))) / 10n ** 18n;
    const w2 = await staking.getWeight(alice.address, projectA);
    const expectedW2 =
      ((firstAmount + addAmount) * (await staking.multiplier(firstLock))) / 10n ** 18n;
    expect(w2).to.equal(expectedW2);
    expect(w2).to.be.gt(w1);
  });

  it("extendLock: aumenta lockDuration, aumenta peso; nao encurta", async () => {
    const { gov, staking, alice, projectA } = await loadFixture(deployStakingFixture);

    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectA, 50_000n * 10n ** 18n, MIN_LOCK);

    const wBefore = await staking.getWeight(alice.address, projectA);

    // Estende de MIN_LOCK para MAX_LOCK (satura no multiplier 4x).
    await staking.connect(alice).extendLock(projectA, MAX_LOCK);

    const wAfter = await staking.getWeight(alice.address, projectA);
    // Peso em MIN_LOCK = 50k * 1x = 50k. Em MAX_LOCK = 50k * 4x = 200k.
    expect(wAfter).to.equal(wBefore * 4n);

    // Nao encurta.
    await expect(staking.connect(alice).extendLock(projectA, MIN_LOCK))
      .to.be.revertedWithCustomError(staking, "CannotShortenLock")
      .withArgs(MAX_LOCK, MIN_LOCK);
  });

  it("Snapshot anti-flash-stake (I5): stake apos snapshotBlock NAO conta no claim", async () => {
    const {
      gov,
      credit,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      carol,
      payer,
      tlSigner,
      projectA,
    } = await loadFixture(deployStakingFixture);

    // Alice stake ANTES do finalize (contara).
    await gov.connect(alice).approve(await staking.getAddress(), 100_000n * 10n ** 18n);
    await staking.connect(alice).stake(projectA, 100_000n * 10n ** 18n, MIN_LOCK);

    // Payer queima no projeto A (rodada 0).
    await credit.connect(payer).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectA, payer.address, 1_000n * 10n ** 18n);

    // Avanca rodada, fecha e finaliza rodada 0.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    // Avanca e fecha rodada 1. Finalize rodada 1 — snapshotBlock e gravado aqui.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    // Carol tenta flash-stake APOS snapshotBlock — nao deve contar.
    await gov.connect(carol).approve(await staking.getAddress(), CAROL_GOV);
    await staking.connect(carol).stake(projectA, CAROL_GOV, MIN_LOCK);

    // Carol previewClaim = 0 (peso no snapshotBlock era 0).
    const carolPreview = await distributor.previewClaim(carol.address, 1, projectA);
    expect(carolPreview).to.equal(0n);

    // Alice claim = share cheio do projeto A na rodada 1.
    const alicePreview = await distributor.previewClaim(alice.address, 1, projectA);
    expect(alicePreview).to.be.gt(0n);
    const projEmission = await distributor.getProjectEmission(1n, projectA);
    // Alice e unica staker no snapshot -> recebe 100% do share do projeto.
    expect(alicePreview).to.equal(projEmission);

    // Carol .claim() executa silenciosamente com amount 0 (nao marca claimed,
    // nao reverte — decisao documentada no RewardDistributor.sol).
    const carolBefore = await credit.balanceOf(carol.address);
    await distributor.connect(carol).claim(1, projectA);
    expect(await credit.balanceOf(carol.address)).to.equal(carolBefore);
    // Como nao marcou, uma nova tentativa ainda retorna 0 (sem revert).
    await expect(distributor.connect(carol).claim(1, projectA)).to.not.be.reverted;
  });

  it("Claim duplicado reverte; preview == claim real", async () => {
    const {
      gov,
      credit,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      payer,
      tlSigner,
      projectA,
    } = await loadFixture(deployStakingFixture);

    await gov.connect(alice).approve(await staking.getAddress(), 50_000n * 10n ** 18n);
    await staking.connect(alice).stake(projectA, 50_000n * 10n ** 18n, MIN_LOCK);

    await credit.connect(payer).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectA, payer.address, 1_000n * 10n ** 18n);

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    const preview = await distributor.previewClaim(alice.address, 1, projectA);
    expect(preview).to.be.gt(0n);

    const before = await credit.balanceOf(alice.address);
    const tx = await distributor.connect(alice).claim(1, projectA);
    await expect(tx).to.emit(distributor, "Claimed").withArgs(alice.address, 1, projectA, preview);
    const after = await credit.balanceOf(alice.address);
    expect(after - before).to.equal(preview);

    // Preview pos-claim = 0 (ja claimado).
    expect(await distributor.previewClaim(alice.address, 1, projectA)).to.equal(0n);

    // Claim duplicado reverte.
    await expect(distributor.connect(alice).claim(1, projectA))
      .to.be.revertedWithCustomError(distributor, "AlreadyClaimed")
      .withArgs(1, projectA, alice.address);
  });

  it("Bootstrap (rodada 0 sem burn prev): share via globalWeight do Staking", async () => {
    const {
      gov,
      credit,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      bob,
      payer,
      tlSigner,
      projectA,
      projectB,
    } = await loadFixture(deployStakingFixture);

    // Stakers em A e B ANTES de qualquer burn — rodada 0 e pura bootstrap
    // (nao ha burn na rodada -1).
    await gov.connect(alice).approve(await staking.getAddress(), 80_000n * 10n ** 18n);
    await staking.connect(alice).stake(projectA, 80_000n * 10n ** 18n, MIN_LOCK);

    await gov.connect(bob).approve(await staking.getAddress(), 40_000n * 10n ** 18n);
    await staking.connect(bob).stake(projectB, 40_000n * 10n ** 18n, MIN_LOCK);

    // Payer nao paga NADA na rodada 0 — totalBurnPrev = 0 para rodada 1
    // quando finalizarmos. Mesmo assim, rodada 1 tera emissao = floor[1]
    // e o share sera distribuido proporcional ao peso global.

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    // Rodada 0 tambem usa floor[0] (sem burn prev). Alice e Bob deveriam poder
    // claim rodada 0. Peso Alice em A = 80k * 1x = 80k. Peso Bob em B = 40k * 1x = 40k.
    // GlobalWeight no snapshot = 120k. ShareA = emissao * 80k / 120k = 2/3.
    // ShareB = 1/3. Alice recebe 100% do shareA, Bob 100% do shareB.
    const alicePreview0 = await distributor.previewClaim(alice.address, 0, projectA);
    const bobPreview0 = await distributor.previewClaim(bob.address, 0, projectB);
    expect(alicePreview0).to.be.gt(0n);
    expect(bobPreview0).to.be.gt(0n);

    // Alice / Bob = 80k / 40k = 2.
    expect(alicePreview0 * 1_000n).to.be.gte(bobPreview0 * 1_990n);
    expect(alicePreview0 * 1_000n).to.be.lte(bobPreview0 * 2_010n);

    // Executa claims.
    const aliceBefore = await credit.balanceOf(alice.address);
    const bobBefore = await credit.balanceOf(bob.address);
    await distributor.connect(alice).claim(0, projectA);
    await distributor.connect(bob).claim(0, projectB);
    expect((await credit.balanceOf(alice.address)) - aliceBefore).to.equal(alicePreview0);
    expect((await credit.balanceOf(bob.address)) - bobBefore).to.equal(bobPreview0);

    // Sanity: FeeRouter foi importado mas nao usado aqui — evita warning.
    void feeRouter;
    void payer;
  });

  it("Probation penalty: share dividido por 4 se projeto em probation por tempo", async () => {
    const {
      gov,
      credit,
      registry,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      bob,
      payer,
      tlSigner,
    } = await loadFixture(deployStakingFixture);

    // Estrategia: usamos dois projetos IGUALMENTE populados (mesmo stake, mesmo
    // burn), mas um deles com probationDuration longa para continuar em
    // probation no momento do claim. Isto exige um novo projeto registrado
    // APOS setProbationDuration (por design, setProbationDuration so afeta
    // ativacoes futuras).
    //
    // Passos:
    //   1. setProbationDuration(10d). Projetos existentes (A, B, C criados na
    //      fixture com probation 1d) nao sao afetados.
    //   2. Registra + ativa projeto F com probation 10d. F fica em probation
    //      por muito tempo.
    //   3. Alice stake em F, Bob stake em F tambem? Nao — para comparacao clean,
    //      Alice stake em F (probation) e Alice stake em A (sem probation, pois
    //      projeto A foi ativado na fixture com probation 1d, ja expirou apos
    //      2 rodadas).
    //   4. Mesmo burn em A e em F. Finalize round 0 + round 1.
    //   5. Comparar preview(1, A) x preview(1, F) — F deve ser ~A/4.

    await registry.connect(tlSigner).setProbationDuration(10n * 86_400n);

    // Mint GOV pro novo owner (alem dos da fixture).
    const [, , , , , , , , extraOwner] = await ethers.getSigners();
    await gov.connect(tlSigner).mint(extraOwner.address, PROJECT_COLLATERAL, "e2e:projF");
    await gov.connect(extraOwner).approve(await registry.getAddress(), PROJECT_COLLATERAL);

    await registry
      .connect(tlSigner)
      .registerProject(extraOwner.address, "ipfs://projF", PROJECT_COLLATERAL);
    const projectF = 4n;
    await registry.connect(tlSigner).activateProject(projectF);
    expect(await registry.isInProbation(projectF)).to.be.true;

    // Alice stake identico em A (ja fora da probation) e em F (em probation
    // longa). Mesmos amounts/lock — peso identico.
    const stakeAmount = 50_000n * 10n ** 18n;
    await gov.connect(alice).approve(await staking.getAddress(), stakeAmount * 2n);
    await staking.connect(alice).stake(1n, stakeAmount, MIN_LOCK);
    await staking.connect(alice).stake(projectF, stakeAmount, MIN_LOCK);

    // Bob e "noise" — nao stakeia; existe apenas para consumir slot.
    void bob;

    // Burns IGUAIS em A e F no round 0. (70% de 1000 = 700 queimados em cada).
    await credit.connect(payer).approve(await feeRouter.getAddress(), 2_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(1n, payer.address, 1_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectF, payer.address, 1_000n * 10n ** 18n);

    expect(await burnTracker.getBurnForProjectInRound(0, 1n)).to.equal(700n * 10n ** 18n);
    expect(await burnTracker.getBurnForProjectInRound(0, projectF)).to.equal(700n * 10n ** 18n);

    // Round 0 close + finalize (usa bootstrap: sem burn prev, usa globalWeight).
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    // Round 1 close + finalize — usa burn do round 0 (caminho burn-proporcional).
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    // No momento do claim (agora), probation de F ainda ativa (10d > 2d).
    expect(await registry.isInProbation(projectF)).to.be.true;
    expect(await registry.isInProbation(1n)).to.be.false;

    const aliceOnA = await distributor.previewClaim(alice.address, 1, 1n);
    const aliceOnF = await distributor.previewClaim(alice.address, 1, projectF);

    expect(aliceOnA).to.be.gt(0n);
    expect(aliceOnF).to.be.gt(0n);
    // aliceOnF deve ser ~= aliceOnA / 4 (penalty de probation).
    // Tolerancia +/- 1% para rounding de divisao por 4.
    expect(aliceOnF * 1000n).to.be.gte((aliceOnA / 4n) * 990n);
    expect(aliceOnF * 1000n).to.be.lte((aliceOnA / 4n) * 1010n);
  });

  it("previewEmission(forRound) consulta burn da rodada anterior em tempo real", async () => {
    const {
      gov,
      credit,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      payer,
      tlSigner,
      projectA,
    } = await loadFixture(deployStakingFixture);

    await gov.connect(alice).approve(await staking.getAddress(), 50_000n * 10n ** 18n);
    await staking.connect(alice).stake(projectA, 50_000n * 10n ** 18n, MIN_LOCK);

    // Sem burn ainda — previewEmission(1) = min(max(alpha*0, floor[1]), capMax) = floor[1].
    const FLOOR_INITIAL = 400_000n * 10n ** 18n;
    const FLOOR_STEP = FLOOR_INITIAL / 24n;
    const floor1 = FLOOR_INITIAL - FLOOR_STEP * 1n;
    expect(await distributor.previewEmission(1n)).to.equal(floor1);

    // Payer paga 1000 CREDIT — totalBurn round 0 = 950 CREDIT.
    await credit.connect(payer).approve(await feeRouter.getAddress(), 1_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectA, payer.address, 1_000n * 10n ** 18n);

    // previewEmission(1) sobe se alpha * burn > floor1. Nao sobe (alpha*950 << floor1),
    // ainda = floor1. Vamos validar.
    expect(await distributor.previewEmission(1n)).to.equal(floor1);

    // Agora fecha round 0 e finaliza — preview passa a retornar o valor imutavel.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    // Como alpha * 0 = 0 < floor[0] = 400k: round 0 emission = floor[0].
    const floor0 = FLOOR_INITIAL;
    expect(await distributor.previewEmission(0n)).to.equal(floor0);
    const round0 = await distributor.roundData(0);
    expect(round0.totalEmission).to.equal(floor0);

    // Sanity
    void tlSigner;
  });

  it("claimMany agrega rounds+projects para o mesmo user", async () => {
    const {
      gov,
      credit,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      payer,
      tlSigner,
      projectA,
      projectB,
    } = await loadFixture(deployStakingFixture);

    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectA, 50_000n * 10n ** 18n, MIN_LOCK);
    await staking.connect(alice).stake(projectB, 50_000n * 10n ** 18n, MIN_LOCK);

    await credit.connect(payer).approve(await feeRouter.getAddress(), 2_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectA, payer.address, 1_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectB, payer.address, 1_000n * 10n ** 18n);

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    const previewA = await distributor.previewClaim(alice.address, 1, projectA);
    const previewB = await distributor.previewClaim(alice.address, 1, projectB);

    // ArrayLengthMismatch
    await expect(
      distributor.connect(alice).claimMany([1n], [projectA, projectB]),
    ).to.be.revertedWithCustomError(distributor, "ArrayLengthMismatch");
    // EmptyBatch
    await expect(distributor.connect(alice).claimMany([], [])).to.be.revertedWithCustomError(
      distributor,
      "EmptyBatch",
    );

    const balBefore = await credit.balanceOf(alice.address);
    await distributor.connect(alice).claimMany([1n, 1n], [projectA, projectB]);
    const balAfter = await credit.balanceOf(alice.address);
    expect(balAfter - balBefore).to.equal(previewA + previewB);

    // Um segundo claimMany com os mesmos pares reverte em AlreadyClaimed
    // (primeira entrada ja claimed).
    await expect(distributor.connect(alice).claimMany([1n, 1n], [projectA, projectB]))
      .to.be.revertedWithCustomError(distributor, "AlreadyClaimed")
      .withArgs(1, projectA, alice.address);
  });

  it("Conservacao de GOV e CREDIT apos multiplos stakes/unstakes/claims", async () => {
    const {
      gov,
      credit,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      bob,
      payer,
      tlSigner,
      projectA,
      projectB,
    } = await loadFixture(deployStakingFixture);

    // Baseline supplies.
    const creditSupply0 = await credit.totalSupply();
    // GOV total mintado na fixture: alice+bob+carol + 3*collateral =
    // 200k + 100k + 50k + 3*5k = 365k GOV.

    // Alice e Bob stakeiam.
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_GOV);
    await staking.connect(alice).stake(projectA, 50_000n * 10n ** 18n, MIN_LOCK);

    await gov.connect(bob).approve(await staking.getAddress(), BOB_GOV);
    await staking.connect(bob).stake(projectB, 30_000n * 10n ** 18n, MIN_LOCK);

    // Payer queima CREDIT.
    await credit.connect(payer).approve(await feeRouter.getAddress(), 2_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectA, payer.address, 1_000n * 10n ** 18n);
    await feeRouter.connect(payer).pay(projectB, payer.address, 1_000n * 10n ** 18n);

    // burn round 0 total = 1400 (700 + 700 — split 70/20/10).
    const burnTotal = 1_400n * 10n ** 18n;

    // 2 rodadas: finalize 0 + 1.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(0);

    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    await distributor.connect(alice).finalizeRound(1);

    // Claims.
    await distributor.connect(alice).claim(1, projectA);
    await distributor.connect(bob).claim(1, projectB);

    // Unstake apos lock.
    await time.increase(MIN_LOCK + 1n);
    await staking.connect(alice).unstakeAll(projectA);
    await staking.connect(bob).unstakeAll(projectB);

    // Conservacao CREDIT: supplyFinal = supply0 - totalBurned + totalMinted.
    const aliceRewards = await credit.balanceOf(alice.address);
    const bobRewards = await credit.balanceOf(bob.address);
    const creditSupplyFinal = await credit.totalSupply();
    expect(creditSupplyFinal).to.equal(creditSupply0 - burnTotal + aliceRewards + bobRewards);

    // Conservacao GOV: stakers recuperaram o que stakearam, Staking esta zerado
    // de GOV apos unstake de todas as posicoes.
    expect(await gov.balanceOf(await staking.getAddress())).to.equal(0n);
    expect(await gov.balanceOf(alice.address)).to.equal(ALICE_GOV);
    expect(await gov.balanceOf(bob.address)).to.equal(BOB_GOV);

    // FeeRouter nunca custodia CREDIT entre chamadas.
    expect(await credit.balanceOf(await feeRouter.getAddress())).to.equal(0n);
  });
});
