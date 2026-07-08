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
 * E2E — FullLifecycle
 *
 * Cenario: simula o ciclo economico completo da Web3Community passando por
 * TODOS os 10 contratos em uso coordenado. A fixture:
 *   1. Deploya via Ignition (perfil DEV — defaults).
 *   2. `impersonateAccount(timelock)` para `acceptOwnership` do GovernanceToken
 *      e para mintar GOV para os atores do teste (opcao B do briefing — teste
 *      controlado, sem modificar o Ignition que ficaria impuro).
 *   3. Registra dois projetos ("Chat App" e "Game App") via impersonate do
 *      Timelock, ativa ambos.
 *   4. Transfere CREDIT do Treasury para usuarios finais (simulacao da
 *      distribuicao do genesis via proposta aprovada — novamente via
 *      impersonate para teste controlado).
 *
 * O teste nao usa o Governor para cada acao — isso ja e coberto em
 * `test/ignition/Dao.test.ts` (smoke test). Aqui validamos as invariantes
 * economicas ponta-a-ponta assumindo governanca ja ratificou o necessario.
 *
 * Fluxo E2E testado:
 *   - Alice stake em Chat App com lock 30d.
 *   - Bob stake em Game App com lock 90d.
 *   - Charlie paga 1000 CREDIT em Chat App (70/20/10 — 700 burn, 200
 *     treasury, 100 rebate; split default da Fase 0 do pivot CLP).
 *   - David paga 500 CREDIT em Game App (70/20/10 — 350 burn, 100 treasury,
 *     50 rebate).
 *   - Avanca tempo > roundDuration.
 *   - Timelock fecha rodada 0 via BurnTracker.closeRound().
 *   - Qualquer um finaliza rodada 0 via RewardDistributor.finalizeRound(0).
 *   - Alice e Bob claim seus rewards.
 *   - Alice tenta unstake cedo — revert (lock 30d).
 *   - Avanca tempo > 30d. Alice unstake — sucesso.
 *   - Checa invariantes globais: soma de balanceOf(CREDIT) == totalSupply,
 *     nenhum contrato vazou valor, etc.
 *
 * Asserções chave:
 *   - CREDIT.totalSupply() diminuiu em exatamente (700 + 350) = 1050 pelos
 *     burns, e subiu em (aliceReward + bobReward) pelos mints do finalize.
 *   - BurnTracker.totalBurnByRound[0] == 1050.
 *   - Alice claim > 0 e Bob claim > 0, ambos <= totalEmission da rodada.
 *   - Lock de Alice bloqueou unstake cedo e liberou apos 30d.
 */
describe("E2E: FullLifecycle — ciclo economico completo passando por todos os contratos", function () {
  // Fluxo tem muitos transacoes — bumpa timeout pra CI mais lenta.
  this.timeout(180_000);

  const DEV_ROUND_DURATION = 86_400n; // 1d

  // Montantes do cenario (em wei).
  const ALICE_GOV_AMOUNT = 100_000n * 10n ** 18n; // 100k GOV
  const BOB_GOV_AMOUNT = 50_000n * 10n ** 18n; // 50k GOV
  const PROJECT_OWNER_COLLATERAL = 5_000n * 10n ** 18n; // 5k GOV (>= minCollateral)

  const ALICE_STAKE_AMOUNT = 80_000n * 10n ** 18n;
  const BOB_STAKE_AMOUNT = 40_000n * 10n ** 18n;

  const ALICE_LOCK_30D = 30n * 86_400n; // 30 dias em seg (>= MIN_LOCK 14d)
  const BOB_LOCK_90D = 90n * 86_400n;

  const CHARLIE_CREDIT = 10_000n * 10n ** 18n; // saldo inicial de CREDIT
  const DAVID_CREDIT = 5_000n * 10n ** 18n;
  const CHARLIE_PAYMENT = 1_000n * 10n ** 18n; // gasta 1000 CREDIT no Chat App
  const DAVID_PAYMENT = 500n * 10n ** 18n; // gasta 500 CREDIT no Game App

  async function deployFullEcosystemFixture() {
    const deployed = await hre.ignition.deploy(CommunityDAOModule);

    const [deployer, alice, bob, charlie, david, chatAppOwner, gameAppOwner] =
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

    // Impersonate Timelock — o unico owner/admin pos-deploy.
    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    const tlSigner = await ethers.getSigner(tlAddr);
    await setBalance(tlSigner.address, ethers.parseEther("100"));

    // Bootstrap 1: Timelock aceita ownership do GOV (necessario pra mintar).
    await gov.connect(tlSigner).acceptOwnership();

    // Bootstrap 2: Mint GOV para atores do teste.
    // Total minted: alice + bob + chat + game = 100k + 50k + 5k + 5k = 160k GOV
    // (longe do cap 100M, sem risco de CapExceeded).
    await gov.connect(tlSigner).mint(alice.address, ALICE_GOV_AMOUNT, "e2e:alice");
    await gov.connect(tlSigner).mint(bob.address, BOB_GOV_AMOUNT, "e2e:bob");
    await gov
      .connect(tlSigner)
      .mint(chatAppOwner.address, PROJECT_OWNER_COLLATERAL, "e2e:chatApp:collateral");
    await gov
      .connect(tlSigner)
      .mint(gameAppOwner.address, PROJECT_OWNER_COLLATERAL, "e2e:gameApp:collateral");

    // Bootstrap 3: Treasury transfere CREDIT do genesis pra Charlie e David
    // (simulando venda direta / distribuicao via proposta).
    await treasury
      .connect(tlSigner)
      .transfer(await credit.getAddress(), charlie.address, CHARLIE_CREDIT);
    await treasury
      .connect(tlSigner)
      .transfer(await credit.getAddress(), david.address, DAVID_CREDIT);

    // Bootstrap 4: Owners dos projetos aprovam o Registry para transferir
    // o colateral no registerProject.
    await gov.connect(chatAppOwner).approve(await registry.getAddress(), PROJECT_OWNER_COLLATERAL);
    await gov.connect(gameAppOwner).approve(await registry.getAddress(), PROJECT_OWNER_COLLATERAL);

    // Bootstrap 5: Timelock registra + ativa os dois projetos.
    await registry
      .connect(tlSigner)
      .registerProject(chatAppOwner.address, "ipfs://chat-app-metadata", PROJECT_OWNER_COLLATERAL);
    const chatAppId = 1n;
    await registry.connect(tlSigner).activateProject(chatAppId);

    await registry
      .connect(tlSigner)
      .registerProject(gameAppOwner.address, "ipfs://game-app-metadata", PROJECT_OWNER_COLLATERAL);
    const gameAppId = 2n;
    await registry.connect(tlSigner).activateProject(gameAppId);

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
      alice,
      bob,
      charlie,
      david,
      chatAppOwner,
      gameAppOwner,
      tlSigner,
      chatAppId,
      gameAppId,
    };
  }

  it("executa o ciclo economico completo: stake -> pay -> closeRound -> finalize -> claim -> unstake", async () => {
    const {
      gov,
      credit,
      treasury,
      registry,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      alice,
      bob,
      charlie,
      david,
      chatAppOwner,
      gameAppOwner,
      tlSigner,
      chatAppId,
      gameAppId,
    } = await loadFixture(deployFullEcosystemFixture);

    const stakingAddr = await staking.getAddress();
    const feeRouterAddr = await feeRouter.getAddress();
    const treasuryAddr = await treasury.getAddress();

    // Snapshot economico inicial — invariantes globais cobram zerar no fim.
    const supplyAtStart = await credit.totalSupply();
    expect(supplyAtStart).to.equal(10_000_000n * 10n ** 18n); // genesis 10M

    // ---------------- Passo 1: Alice stake em Chat App ----------------
    await gov.connect(alice).approve(stakingAddr, ALICE_STAKE_AMOUNT);
    await staking.connect(alice).stake(chatAppId, ALICE_STAKE_AMOUNT, ALICE_LOCK_30D);

    const alicePosition = await staking.getPosition(alice.address, chatAppId);
    expect(alicePosition.amount).to.equal(ALICE_STAKE_AMOUNT);
    expect(alicePosition.lockDuration).to.equal(ALICE_LOCK_30D);

    // Peso = amount * multiplier(30d). 30d = MIN_LOCK + 16d — multiplier um
    // pouco acima de 1x. Assertamos positivo; valor exato eh irrelevante pro E2E.
    const aliceWeight = await staking.getWeight(alice.address, chatAppId);
    expect(aliceWeight).to.be.gt(0n);

    // ---------------- Passo 2: Bob stake em Game App ------------------
    await gov.connect(bob).approve(stakingAddr, BOB_STAKE_AMOUNT);
    await staking.connect(bob).stake(gameAppId, BOB_STAKE_AMOUNT, BOB_LOCK_90D);

    const bobPosition = await staking.getPosition(bob.address, gameAppId);
    expect(bobPosition.amount).to.equal(BOB_STAKE_AMOUNT);

    const bobWeight = await staking.getWeight(bob.address, gameAppId);
    expect(bobWeight).to.be.gt(0n);

    // ---------------- Passo 3: Charlie paga no Chat App ----------------
    await credit.connect(charlie).approve(feeRouterAddr, CHARLIE_PAYMENT);
    const chatAppOwnerCreditBefore = await credit.balanceOf(chatAppOwner.address);
    const supplyBeforeCharlie = await credit.totalSupply();

    const chatPayTx = await feeRouter
      .connect(charlie)
      .pay(chatAppId, charlie.address, CHARLIE_PAYMENT);
    await chatPayTx.wait();

    // Split 70/20/10 — 700 burned, 200 treasury, 100 rebate.
    const chatAppOwnerCreditAfter = await credit.balanceOf(chatAppOwner.address);
    expect(chatAppOwnerCreditAfter - chatAppOwnerCreditBefore).to.equal(100n * 10n ** 18n);
    const supplyAfterCharlie = await credit.totalSupply();
    expect(supplyBeforeCharlie - supplyAfterCharlie).to.equal(700n * 10n ** 18n);

    // BurnTracker deve ter registrado o burn.
    const burnChatRound0 = await burnTracker.getBurnForProjectInRound(0, chatAppId);
    expect(burnChatRound0).to.equal(700n * 10n ** 18n);

    // ---------------- Passo 4: David paga no Game App ------------------
    await credit.connect(david).approve(feeRouterAddr, DAVID_PAYMENT);
    const gameAppOwnerCreditBefore = await credit.balanceOf(gameAppOwner.address);
    const supplyBeforeDavid = await credit.totalSupply();

    await feeRouter.connect(david).pay(gameAppId, david.address, DAVID_PAYMENT);

    const gameAppOwnerCreditAfter = await credit.balanceOf(gameAppOwner.address);
    expect(gameAppOwnerCreditAfter - gameAppOwnerCreditBefore).to.equal(50n * 10n ** 18n);
    const supplyAfterDavid = await credit.totalSupply();
    expect(supplyBeforeDavid - supplyAfterDavid).to.equal(350n * 10n ** 18n);

    // Total burnado na rodada 0 = 1050 CREDIT.
    const totalBurnRound0 = await burnTracker.getTotalBurnForRound(0);
    expect(totalBurnRound0).to.equal(1_050n * 10n ** 18n);
    const burnGameRound0 = await burnTracker.getBurnForProjectInRound(0, gameAppId);
    expect(burnGameRound0).to.equal(350n * 10n ** 18n);

    // Supply diminuiu em 1050 CREDIT total desde o inicio.
    expect(supplyAtStart - (await credit.totalSupply())).to.equal(1_050n * 10n ** 18n);

    // ---------------- Passo 5: Avanca tempo > roundDuration ------------
    await time.increase(DEV_ROUND_DURATION + 1n);
    expect(await burnTracker.isRoundReadyToClose()).to.be.true;

    // ---------------- Passo 6: Timelock fecha rodada 0 ------------------
    // Em prod seria via proposta Governor; aqui impersonate direto conforme
    // decisao B do briefing.
    await burnTracker.connect(tlSigner).closeRound();
    expect(await burnTracker.currentRound()).to.equal(1n);

    // ---------------- Passo 7: Finalize rodada 0 (permissionless) ------
    // Qualquer um pode chamar — Alice mesmo.
    const finalizeTx = await distributor.connect(alice).finalizeRound(0);
    await finalizeTx.wait();

    const round0Data = await distributor.roundData(0);
    expect(round0Data.finalized).to.be.true;
    // Round 0: totalBurnPrev = 0 (nao ha round -1), entao emissao vem do floor[0].
    // floor[0] = 400_000e18. totalEmission deve ser exatamente isso
    // (capMax = 1M, floor[0] < capMax, alphaBurn = 0).
    const expectedFloor0 = 400_000n * 10n ** 18n;
    expect(round0Data.totalEmission).to.equal(expectedFloor0);
    expect(round0Data.totalBurnAtFinalize).to.equal(0n);

    // ---------------- Passo 8: Fecha rodada 1 + finalize 1 --------------
    // Rodada 1 e a que efetivamente acopla com o burn de 1050 CREDIT da rodada 0.
    // Precisamos avancar tempo, fechar rodada 1, e finalizar. Sem isso, claim
    // nao reflete o burn que os apps registraram.
    await time.increase(DEV_ROUND_DURATION + 1n);
    await burnTracker.connect(tlSigner).closeRound();
    expect(await burnTracker.currentRound()).to.equal(2n);

    await distributor.connect(alice).finalizeRound(1);
    const round1Data = await distributor.roundData(1);
    expect(round1Data.finalized).to.be.true;
    // emissao = min(max(alpha * 1050e18, floor[1]), capMax)
    //         = max(0.95 * 1050e18, ~383_333e18) = floor[1] (muito maior).
    // floor[1] = 400_000e18 - 400_000e18/24 = ~383_333e18.
    const expectedFloor1 = 400_000n * 10n ** 18n - (400_000n * 10n ** 18n) / 24n;
    expect(round1Data.totalEmission).to.equal(expectedFloor1);
    expect(round1Data.totalBurnAtFinalize).to.equal(1_050n * 10n ** 18n);

    // ---------------- Passo 9: Alice e Bob claim rodada 1 ---------------
    // Round 1 usa burn do round 0 (Chat + Game tiveram burn). Probation inicial
    // por tempo NAO deve ainda ter acabado (probationDuration = 86_400s = 1d;
    // ja avancamos 2 * DEV_ROUND_DURATION = 2d desde activate). Entao probation
    // POR TEMPO deve ter expirado e nao ha penalty.
    //
    // Alice tem peso em Chat App; Bob tem peso em Game App. Ambos recebem
    // share proporcional ao burn do projeto.

    const aliceCreditBeforeClaim = await credit.balanceOf(alice.address);
    const bobCreditBeforeClaim = await credit.balanceOf(bob.address);

    const alicePreview = await distributor.previewClaim(alice.address, 1, chatAppId);
    const bobPreview = await distributor.previewClaim(bob.address, 1, gameAppId);
    expect(alicePreview).to.be.gt(0n);
    expect(bobPreview).to.be.gt(0n);

    await distributor.connect(alice).claim(1, chatAppId);
    await distributor.connect(bob).claim(1, gameAppId);

    const aliceCreditAfterClaim = await credit.balanceOf(alice.address);
    const bobCreditAfterClaim = await credit.balanceOf(bob.address);

    const aliceReward = aliceCreditAfterClaim - aliceCreditBeforeClaim;
    const bobReward = bobCreditAfterClaim - bobCreditBeforeClaim;

    expect(aliceReward).to.equal(alicePreview);
    expect(bobReward).to.equal(bobPreview);

    // Soma dos rewards <= totalEmission da rodada.
    expect(aliceReward + bobReward).to.be.lte(round1Data.totalEmission);

    // Share Chat App = emissao * 700 / 1050 = ~66.66% de 383_333e18 ≈ 255_555e18.
    // Como Alice e a unica staker no Chat, recebe 100% do share do projeto.
    // Vamos validar proporcionalidade: shareChatApp / shareGameApp ≈ 700/350 = 2.
    // Pequena diferença por divisoes inteiras é esperada.
    // aliceReward / bobReward ≈ 2 (ambas 100% do share do proprio projeto).
    expect(aliceReward * 1_000n).to.be.gte(bobReward * 1_990n);
    expect(aliceReward * 1_000n).to.be.lte(bobReward * 2_010n);

    // Claim duplo reverte.
    await expect(distributor.connect(alice).claim(1, chatAppId)).to.be.revertedWithCustomError(
      distributor,
      "AlreadyClaimed",
    );

    // ---------------- Passo 10: Alice tenta unstake cedo (revert) -------
    // Alice lockou 30d no passo 1. Ja passamos ~2d de tempo — lock vigente.
    await expect(staking.connect(alice).unstakeAll(chatAppId)).to.be.revertedWithCustomError(
      staking,
      "LockNotExpired",
    );

    // ---------------- Passo 11: Avanca tempo + 30d, Alice unstake -------
    // Ja se passaram ~2 * roundDuration = 2d desde stake. Avanca 30d mais
    // (folga ao lock de 30d).
    await time.increase(30n * 86_400n);

    const aliceGovBeforeUnstake = await gov.balanceOf(alice.address);
    await staking.connect(alice).unstakeAll(chatAppId);
    const aliceGovAfterUnstake = await gov.balanceOf(alice.address);

    expect(aliceGovAfterUnstake - aliceGovBeforeUnstake).to.equal(ALICE_STAKE_AMOUNT);
    // Posicao zerada.
    const alicePosAfter = await staking.getPosition(alice.address, chatAppId);
    expect(alicePosAfter.amount).to.equal(0n);

    // ---------------- Invariantes globais finais ------------------------

    // Conservacao de CREDIT:
    // supplyFinal = supplyAtStart - totalBurned + totalMinted(rewards).
    const supplyFinal = await credit.totalSupply();
    const totalBurned = 1_050n * 10n ** 18n;
    const totalMinted = aliceReward + bobReward;
    expect(supplyFinal).to.equal(supplyAtStart - totalBurned + totalMinted);

    // Conservacao de GOV:
    // Alice recebeu todo stake de volta; Bob ainda tem stake travado no Staking.
    const stakingGovBalance = await gov.balanceOf(stakingAddr);
    expect(stakingGovBalance).to.equal(BOB_STAKE_AMOUNT);

    // Nenhum CREDIT deveria ter ficado preso no FeeRouter (deve ficar zerado
    // apos cada pay — sem custodia).
    expect(await credit.balanceOf(feeRouterAddr)).to.equal(0n);

    // Treasury: saldo apos as transferencias iniciais MAIS a fatia de 20%
    // (treasuryBps do split 70/20/10) dos pagamentos de Charlie (200) e
    // David (100):
    // genesisAmount - CHARLIE_CREDIT - DAVID_CREDIT + 20% * (pagamentos).
    const treasuryFeeShare = ((CHARLIE_PAYMENT + DAVID_PAYMENT) * 2_000n) / 10_000n;
    const expectedTreasuryCredit =
      10_000_000n * 10n ** 18n - CHARLIE_CREDIT - DAVID_CREDIT + treasuryFeeShare;
    expect(await credit.balanceOf(treasuryAddr)).to.equal(expectedTreasuryCredit);

    // Conservacao de GOV: soma das posicoes de todos os atores + contratos
    // custodiadores == total mintado nos bootstraps.
    const registryAddr = await registry.getAddress();
    const totalGovHeld =
      (await gov.balanceOf(alice.address)) +
      (await gov.balanceOf(bob.address)) +
      (await gov.balanceOf(chatAppOwner.address)) +
      (await gov.balanceOf(gameAppOwner.address)) +
      (await gov.balanceOf(stakingAddr)) +
      (await gov.balanceOf(feeRouterAddr)) +
      (await gov.balanceOf(treasuryAddr)) +
      (await gov.balanceOf(registryAddr));
    // Total mintado via bootstrap: alice + bob + 2 * collateral = 160k GOV.
    // Registry detem 2 * collateral dos apps (10k GOV).
    // Distribuicao final: alice recebeu de volta (100k), bob ainda lockado no
    // staking (40k) + resto (10k nao stakeado), owners 0 (deram collateral),
    // registry 10k. Total = 100k + 10k + 40k + 10k = 160k. Match com mint.
    const expectedTotalGov = ALICE_GOV_AMOUNT + BOB_GOV_AMOUNT + 2n * PROJECT_OWNER_COLLATERAL;
    expect(totalGovHeld).to.equal(expectedTotalGov);
  });

  it("rejeita wash-burn catastrofico (SanityCapExceeded) — projeto malicioso", async () => {
    // Cenario de guarda: projeto tenta queimar acima do sanityCap
    // (maxBurnPerRoundPerProject = 1M CREDIT no DEV). FeeRouter recebe o
    // valor total, tenta queimar via BurnTracker, e BurnTracker reverte.
    //
    // Isso valida que o limite protege o modelo economico de ataques de
    // inflacao de share (quebra a invariante I3 da distribuicao proporcional
    // se nao for barrado).
    const { credit, feeRouter, burnTracker, treasury, tlSigner, chatAppId } = await loadFixture(
      deployFullEcosystemFixture,
    );

    // Precisa de um saldo grande de CREDIT para tentar burn > sanityCap.
    // sanityCap DEV = 1M CREDIT. Vamos tentar queimar 2M (acima do cap,
    // dentro da limitacao de 70/20/10 — burn nominal ~ 1.4M).
    //
    // Primeiro o Treasury manda 2M pro charlie (via impersonate do Timelock).
    const [, , , charlie] = await ethers.getSigners();
    const ATTACK_AMOUNT = 2_000_000n * 10n ** 18n;
    await treasury
      .connect(tlSigner)
      .transfer(await credit.getAddress(), charlie.address, ATTACK_AMOUNT);

    // Charlie aprova e tenta pagar.
    await credit.connect(charlie).approve(await feeRouter.getAddress(), ATTACK_AMOUNT);
    await expect(
      feeRouter.connect(charlie).pay(chatAppId, charlie.address, ATTACK_AMOUNT),
    ).to.be.revertedWithCustomError(burnTracker, "SanityCapExceeded");

    // Agregado da rodada nao foi corrompido — burn 0.
    expect(await burnTracker.getBurnForProjectInRound(0, chatAppId)).to.equal(0n);
    expect(await burnTracker.getTotalBurnForRound(0)).to.equal(0n);
  });
});
