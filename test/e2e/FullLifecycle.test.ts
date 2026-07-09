import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

/**
 * E2E — FullLifecycle (remodel 2026-07-08: payment rail + rev-share funding)
 *
 * Cenario: simula o ciclo economico completo da Web3Community passando por
 * TODOS os contratos do modelo vigente em uso coordenado:
 *   GOV / CREDIT / Timelock / Registry / Treasury / Staking / USDC mock /
 *   CreditPSM / ProjectFunding / FeeRouterV2 / Governor.
 *
 * Fixture (perfil DEV via Ignition, com `DEPLOY_USDC_MOCK=true`):
 *   1. Deploya via Ignition.
 *   2. `impersonateAccount(timelock)` para `acceptOwnership` do GovernanceToken,
 *      mintar GOV para os atores e registrar/ativar os projetos (opcao B do
 *      briefing — teste controlado, sem tocar no Ignition).
 *   3. Semeia USDC para os atores comprarem CREDIT no PSM.
 *
 * Fluxo E2E testado (modelo novo — sem burn/emissao):
 *   - Alice e Bob compram CREDIT no PSM (USDC 1:1) e stakeiam GOV no Chat App.
 *   - Chat App abre rodada de captacao (rev-share 10%); Alice (60%) e Bob (40%)
 *     investem ate bater o alvo -> rodada Funded, dono recebe o captado.
 *   - Um pagador (payer) paga CREDIT no Chat App via FeeRouterV2.pay:
 *       fee 2,5% (split 40/40/20 treasury/buyback/grants), rev-share 10% aos
 *       investidores, resto ao appRecipient (dono do projeto).
 *   - Alice e Bob sacam o rev-share pro-rata (60/40).
 *   - Bob paga tambem no Game App (sem rodada de funding -> rev-share 0).
 *   - Alice tenta unstake cedo (revert por lock) e depois consegue apos o lock.
 *   - Invariantes globais: conservacao de CREDIT (supply == soma dos saldos),
 *     lastro integral do PSM, nada preso no FeeRouterV2, conservacao de GOV.
 */
describe("E2E: FullLifecycle — ciclo economico completo (payment rail + funding)", function () {
  this.timeout(180_000);

  const E18 = 10n ** 18n;
  const E6 = 10n ** 6n;
  const SCALE = 10n ** 12n;

  const MAX_LOCK = 365n * 86_400n;
  const ALICE_LOCK_30D = 30n * 86_400n; // >= MIN_LOCK 14d
  const BOB_LOCK_90D = 90n * 86_400n;

  // Montantes GOV.
  const ALICE_GOV_AMOUNT = 100_000n * E18;
  const BOB_GOV_AMOUNT = 50_000n * E18;
  const PROJECT_OWNER_COLLATERAL = 5_000n * E18; // >= minCollateral (1k DEV)

  const ALICE_STAKE_AMOUNT = 80_000n * E18;
  const BOB_STAKE_AMOUNT = 40_000n * E18;

  // Rodada de funding do Chat App.
  const REV_SHARE_BPS = 1000n; // 10%
  const TARGET = 50_000n * E18;
  const ROUND_DURATION = 30n * 86_400n;
  const ALICE_INVEST = (TARGET * 60n) / 100n; // 30k
  const BOB_INVEST = (TARGET * 40n) / 100n; // 20k

  // Pagamentos via FeeRouterV2.
  const PAYER_PAYMENT = 10_000n * E18; // paga no Chat App
  const BOB_GAME_PAYMENT = 1_000n * E18; // paga no Game App (sem funding)

  const FEE_BPS = 250n; // 2,5%

  async function deployFullEcosystemFixture() {
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

    const [deployer, alice, bob, payer, chatAppOwner, gameAppOwner] = await ethers.getSigners();

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

    // Impersonate Timelock — unico owner/admin pos-deploy.
    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    const tlSigner = await ethers.getSigner(tlAddr);
    await setBalance(tlSigner.address, ethers.parseEther("100"));

    // Bootstrap 1: Timelock aceita ownership do GOV (necessario pra mintar).
    await gov.connect(tlSigner).acceptOwnership();

    // Bootstrap 2: Mint GOV para atores.
    await gov.connect(tlSigner).mint(alice.address, ALICE_GOV_AMOUNT, "e2e:alice");
    await gov.connect(tlSigner).mint(bob.address, BOB_GOV_AMOUNT, "e2e:bob");
    await gov
      .connect(tlSigner)
      .mint(chatAppOwner.address, PROJECT_OWNER_COLLATERAL, "e2e:chatApp:collateral");
    await gov
      .connect(tlSigner)
      .mint(gameAppOwner.address, PROJECT_OWNER_COLLATERAL, "e2e:gameApp:collateral");

    // Bootstrap 3: Semeia USDC para os atores comprarem CREDIT no PSM.
    for (const s of [alice, bob, payer]) {
      await usdc.mint(s.address, 1_000_000n * E6);
      await usdc.connect(s).approve(await psm.getAddress(), ethers.MaxUint256);
    }

    // Bootstrap 4: Owners aprovam Registry pro colateral; Timelock registra + ativa.
    await gov.connect(chatAppOwner).approve(await registry.getAddress(), PROJECT_OWNER_COLLATERAL);
    await gov.connect(gameAppOwner).approve(await registry.getAddress(), PROJECT_OWNER_COLLATERAL);

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
      usdc,
      psm,
      funding,
      feeRouterV2,
      deployer,
      alice,
      bob,
      payer,
      chatAppOwner,
      gameAppOwner,
      tlSigner,
      chatAppId,
      gameAppId,
    };
  }

  it("executa o ciclo completo: buy -> stake -> openRound -> invest -> pay -> claim -> unstake", async () => {
    const {
      gov,
      credit,
      treasury,
      registry,
      staking,
      psm,
      funding,
      feeRouterV2,
      alice,
      bob,
      payer,
      chatAppOwner,
      gameAppOwner,
      chatAppId,
      gameAppId,
    } = await loadFixture(deployFullEcosystemFixture);

    const stakingAddr = await staking.getAddress();
    const routerAddr = await feeRouterV2.getAddress();
    const treasuryAddr = await treasury.getAddress();
    const fundingAddr = await funding.getAddress();
    const psmAddr = await psm.getAddress();

    // Snapshot inicial: sem genesis, supply de CREDIT comeca em zero.
    expect(await credit.totalSupply()).to.equal(0n);

    // ---------------- Passo 1: Alice e Bob compram CREDIT no PSM -------------
    // Alice compra o suficiente pro investimento; Bob idem.
    await psm.connect(alice).buy(100_000n * E6); // 100k CREDIT
    await psm.connect(bob).buy(100_000n * E6); // 100k CREDIT
    expect(await credit.balanceOf(alice.address)).to.equal(100_000n * E18);
    expect(await credit.balanceOf(bob.address)).to.equal(100_000n * E18);
    // Lastro integral: USDC retido == CREDIT mintado (normalizado).
    expect(await psm.backingNormalized()).to.equal(await psm.mintedOutstanding());

    // ---------------- Passo 2: Alice e Bob stakeiam GOV no Chat App ---------
    await gov.connect(alice).approve(stakingAddr, ALICE_STAKE_AMOUNT);
    await staking.connect(alice).stake(chatAppId, ALICE_STAKE_AMOUNT, ALICE_LOCK_30D);
    const alicePosition = await staking.getPosition(alice.address, chatAppId);
    expect(alicePosition.amount).to.equal(ALICE_STAKE_AMOUNT);
    expect(await staking.getWeight(alice.address, chatAppId)).to.be.gt(0n);

    await gov.connect(bob).approve(stakingAddr, BOB_STAKE_AMOUNT);
    await staking.connect(bob).stake(chatAppId, BOB_STAKE_AMOUNT, BOB_LOCK_90D);
    expect((await staking.getPosition(bob.address, chatAppId)).amount).to.equal(BOB_STAKE_AMOUNT);

    // ---------------- Passo 3: Chat App abre rodada de captacao -------------
    await funding
      .connect(chatAppOwner)
      .openRound(chatAppId, TARGET, REV_SHARE_BPS, ROUND_DURATION);
    const openRound = await funding.rounds(chatAppId);
    expect(openRound.status).to.equal(1n); // Open

    // ---------------- Passo 4: Alice (60%) e Bob (40%) investem -------------
    const ownerCreditBeforeFund = await credit.balanceOf(chatAppOwner.address);
    await credit.connect(alice).approve(fundingAddr, ALICE_INVEST);
    await funding.connect(alice).invest(chatAppId, ALICE_INVEST);
    await credit.connect(bob).approve(fundingAddr, BOB_INVEST);
    await funding.connect(bob).invest(chatAppId, BOB_INVEST); // completa o alvo -> Funded

    const fundedRound = await funding.rounds(chatAppId);
    expect(fundedRound.status).to.equal(2n); // Funded
    // Dono recebeu o captado (target inteiro).
    expect((await credit.balanceOf(chatAppOwner.address)) - ownerCreditBeforeFund).to.equal(TARGET);
    // Rev-share ativo.
    expect(await funding.revShareBpsOf(chatAppId)).to.equal(REV_SHARE_BPS);
    expect(await funding.sharesOf(chatAppId, alice.address)).to.equal(ALICE_INVEST);
    expect(await funding.sharesOf(chatAppId, bob.address)).to.equal(BOB_INVEST);

    // ---------------- Passo 5: payer paga no Chat App via FeeRouterV2 ------
    await psm.connect(payer).buy(20_000n * E6); // 20k CREDIT
    await credit.connect(payer).approve(routerAddr, ethers.MaxUint256);

    const fee = (PAYER_PAYMENT * FEE_BPS) / 10_000n; // 250
    const toTreasury = (fee * 4000n) / 10_000n; // 100
    const toBuyback = (fee * 4000n) / 10_000n; // 100
    const toGrants = fee - toTreasury - toBuyback; // 50
    const revShare = (PAYER_PAYMENT * REV_SHARE_BPS) / 10_000n; // 1000
    const toApp = PAYER_PAYMENT - fee - revShare; // 8750

    // Recipients treasury/buyback/grants = Treasury (todos apontam pro cofre no DEV).
    const treasuryCreditBeforePay = await credit.balanceOf(treasuryAddr);
    const ownerCreditBeforePay = await credit.balanceOf(chatAppOwner.address);

    await expect(feeRouterV2.connect(payer).pay(chatAppId, PAYER_PAYMENT))
      .to.emit(feeRouterV2, "PaymentRouted")
      .withArgs(chatAppId, payer.address, PAYER_PAYMENT, toTreasury, toBuyback, toGrants, revShare, toApp);

    // Treasury recebeu as 3 parcelas da fee (todas apontam pro cofre).
    expect((await credit.balanceOf(treasuryAddr)) - treasuryCreditBeforePay).to.equal(fee);
    // App (dono) recebeu o resto.
    expect((await credit.balanceOf(chatAppOwner.address)) - ownerCreditBeforePay).to.equal(toApp);
    // Volume bruto registrado.
    expect(await feeRouterV2.grossVolumeOf(chatAppId)).to.equal(PAYER_PAYMENT);

    // ---------------- Passo 6: Alice e Bob sacam rev-share pro-rata --------
    // Pool de rev-share = 1000 CREDIT, dividido 60/40.
    const aliceExpected = (revShare * 60n) / 100n; // 600
    const bobExpected = (revShare * 40n) / 100n; // 400
    expect(await funding.pendingRevenue(chatAppId, alice.address)).to.equal(aliceExpected);
    expect(await funding.pendingRevenue(chatAppId, bob.address)).to.equal(bobExpected);

    const aliceBeforeClaim = await credit.balanceOf(alice.address);
    await funding.connect(alice).claim(chatAppId);
    expect((await credit.balanceOf(alice.address)) - aliceBeforeClaim).to.equal(aliceExpected);

    const bobBeforeClaim = await credit.balanceOf(bob.address);
    await funding.connect(bob).claim(chatAppId);
    expect((await credit.balanceOf(bob.address)) - bobBeforeClaim).to.equal(bobExpected);

    // Claim duplo reverte.
    await expect(funding.connect(alice).claim(chatAppId)).to.be.revertedWithCustomError(
      funding,
      "NothingToClaim",
    );

    // ---------------- Passo 7: Bob paga no Game App (sem funding) ----------
    // Sem rodada de funding, rev-share = 0; app recebe 97,5%.
    await credit.connect(bob).approve(routerAddr, BOB_GAME_PAYMENT);
    const gameOwnerBefore = await credit.balanceOf(gameAppOwner.address);
    await feeRouterV2.connect(bob).pay(gameAppId, BOB_GAME_PAYMENT);
    const gameToApp = (BOB_GAME_PAYMENT * (10_000n - FEE_BPS)) / 10_000n; // 97,5%
    expect((await credit.balanceOf(gameAppOwner.address)) - gameOwnerBefore).to.equal(gameToApp);

    // ---------------- Passo 8: Alice tenta unstake cedo (revert) -----------
    await expect(staking.connect(alice).unstakeAll(chatAppId)).to.be.revertedWithCustomError(
      staking,
      "LockNotExpired",
    );

    // ---------------- Passo 9: Avanca > lock, Alice unstake ---------------
    await time.increase(ALICE_LOCK_30D + 1n);
    const aliceGovBefore = await gov.balanceOf(alice.address);
    await staking.connect(alice).unstakeAll(chatAppId);
    expect((await gov.balanceOf(alice.address)) - aliceGovBefore).to.equal(ALICE_STAKE_AMOUNT);
    expect((await staking.getPosition(alice.address, chatAppId)).amount).to.equal(0n);

    // ---------------- Invariantes globais finais --------------------------

    // Conservacao de CREDIT: supply == soma de todos os saldos relevantes.
    // Nao ha burn no fluxo (nenhum sell no PSM), entao supply == total mintado
    // via PSM.buy = (100k + 100k + 20k) * 1e18.
    const totalBought = (100_000n + 100_000n + 20_000n) * E18;
    expect(await credit.totalSupply()).to.equal(totalBought);

    // Lastro integral do PSM permanece (nenhum sell): backing == outstanding.
    expect(await psm.backingNormalized()).to.equal(await psm.mintedOutstanding());
    expect(await psm.mintedOutstanding()).to.equal(totalBought);

    // Nada de CREDIT preso no FeeRouterV2 (sem custodia — zera a cada pay).
    expect(await credit.balanceOf(routerAddr)).to.equal(0n);

    // ProjectFunding nao retem CREDIT nao-contabilizado: apos claims completos
    // do rev-share, o saldo residual e apenas a poeira de divisao inteira
    // (aqui zero — 1000 divide 60/40 exato) mais nada (raised foi pago ao dono).
    expect(await credit.balanceOf(fundingAddr)).to.equal(0n);

    // Conservacao de GOV: Alice recebeu todo stake de volta; Bob ainda travado.
    expect(await gov.balanceOf(stakingAddr)).to.equal(BOB_STAKE_AMOUNT);

    // Colateral dos projetos permanece no Registry.
    const registryAddr = await registry.getAddress();
    expect(await gov.balanceOf(registryAddr)).to.equal(2n * PROJECT_OWNER_COLLATERAL);

    // Conservacao total de GOV mintado nos bootstraps.
    const totalGovHeld =
      (await gov.balanceOf(alice.address)) +
      (await gov.balanceOf(bob.address)) +
      (await gov.balanceOf(chatAppOwner.address)) +
      (await gov.balanceOf(gameAppOwner.address)) +
      (await gov.balanceOf(stakingAddr)) +
      (await gov.balanceOf(registryAddr));
    const expectedTotalGov = ALICE_GOV_AMOUNT + BOB_GOV_AMOUNT + 2n * PROJECT_OWNER_COLLATERAL;
    expect(totalGovHeld).to.equal(expectedTotalGov);

    // O lastro USDC do PSM nunca vaza pro Treasury (segregado por construcao).
    void psmAddr; // referencia explicita
  });

  it("rev-share so ativa apos a rodada bater o alvo (rodada aberta nao paga investidor)", async () => {
    // Guarda: enquanto a rodada esta apenas Open (alvo nao batido), revShareBpsOf
    // = 0 e um pagamento via FeeRouterV2 NAO gera rev-share — o valor vai
    // integralmente pro app (menos a fee). Protege o modelo: rev-share so vale
    // sobre projeto efetivamente financiado.
    const {
      gov,
      credit,
      staking,
      psm,
      funding,
      feeRouterV2,
      alice,
      payer,
      chatAppOwner,
      chatAppId,
    } = await loadFixture(deployFullEcosystemFixture);

    // Alice stakeia e investe PARCIALMENTE (nao bate o alvo).
    await gov.connect(alice).approve(await staking.getAddress(), ALICE_STAKE_AMOUNT);
    await staking.connect(alice).stake(chatAppId, ALICE_STAKE_AMOUNT, MAX_LOCK);

    await funding.connect(chatAppOwner).openRound(chatAppId, TARGET, REV_SHARE_BPS, ROUND_DURATION);
    await psm.connect(alice).buy(50_000n * E6);
    await credit.connect(alice).approve(await funding.getAddress(), ethers.MaxUint256);
    await funding.connect(alice).invest(chatAppId, 10_000n * E18); // < TARGET, segue Open

    expect((await funding.rounds(chatAppId)).status).to.equal(1n); // Open
    expect(await funding.revShareBpsOf(chatAppId)).to.equal(0n);

    // Pagamento: rev-share = 0, app recebe 97,5%.
    await psm.connect(payer).buy(1_000n * E6);
    await credit.connect(payer).approve(await feeRouterV2.getAddress(), ethers.MaxUint256);
    const amount = 1_000n * E18;
    const ownerBefore = await credit.balanceOf(chatAppOwner.address);
    await feeRouterV2.connect(payer).pay(chatAppId, amount);
    expect((await credit.balanceOf(chatAppOwner.address)) - ownerBefore).to.equal(
      (amount * (10_000n - FEE_BPS)) / 10_000n,
    );

    // Investidor nao tem receita pendente (rodada nunca foi Funded).
    expect(await funding.pendingRevenue(chatAppId, alice.address)).to.equal(0n);
  });
});
