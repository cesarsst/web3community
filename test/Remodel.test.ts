import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * Remodel 2026-07-08 — payment rail + funding por rev-share.
 *
 * Cobertura:
 *  1. CreditPSM: buy/sell 1:1 (6<->18 decimais), lastro integral, dust,
 *     resgate acima do lastro.
 *  2. ProjectFunding: openRound (gates/bounds), invest (gate de GOV staked,
 *     alvo, auto-fund), rodada expirada + refund, notifyRevenue (role),
 *     claim pro-rata com exigencia de stake.
 *  3. FeeRouterV2: pay com fee 2,5% (split 40/40/20) + rev-share + resto pro
 *     app; projeto sem funding (rev-share 0); setters com bounds; preview.
 */
describe("Remodel (PSM + ProjectFunding + FeeRouterV2)", function () {
  const MIN_COLLATERAL = 10_000n * 10n ** 18n;
  const PROBATION_DURATION = 30n * 24n * 60n * 60n;
  const MAX_LOCK = 365n * 24n * 60n * 60n;

  const SEED_GOV = 1_000_000n * 10n ** 18n;
  const STAKE = 1_000n * 10n ** 18n;

  const E18 = 10n ** 18n;
  const E6 = 10n ** 6n;
  const SCALE = 10n ** 12n;

  const FEE_BPS = 250n; // 2,5%
  const SPLIT = { treasuryBps: 4000, buybackBps: 4000, grantsBps: 2000 };
  const REV_SHARE_BPS = 800; // 8%
  const TARGET = 50_000n * E18;
  const ROUND_DURATION = 30n * 24n * 60n * 60n;

  async function deployFixture() {
    const [admin, governance, projOwner, alice, bob, payer, treasuryEoa, buybackEoa, grantsEoa] =
      await ethers.getSigners();

    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy("GOV", "GOV", admin.address);

    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("CREDIT", "CREDIT", admin.address);

    const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
    const registry = await ProjectRegistry.deploy(
      await gov.getAddress(),
      admin.address,
      MIN_COLLATERAL,
      PROBATION_DURATION,
    );
    await registry.grantRole(await registry.GOVERNANCE_ROLE(), governance.address);

    const Staking = await ethers.getContractFactory("Staking");
    const staking = await Staking.deploy(await gov.getAddress(), await registry.getAddress());

    const Usdc = await ethers.getContractFactory("ERC20DecimalsMock");
    const usdc = await Usdc.deploy("Mock USDC", "USDC", 6);

    // ---- contratos novos
    const CreditPSM = await ethers.getContractFactory("CreditPSM");
    const psm = await CreditPSM.deploy(await credit.getAddress(), await usdc.getAddress());

    const ProjectFunding = await ethers.getContractFactory("ProjectFunding");
    const funding = await ProjectFunding.deploy(
      admin.address,
      await credit.getAddress(),
      await registry.getAddress(),
      await staking.getAddress(),
    );

    const FeeRouterV2 = await ethers.getContractFactory("FeeRouterV2");
    const router = await FeeRouterV2.deploy(
      admin.address,
      await credit.getAddress(),
      await registry.getAddress(),
      await funding.getAddress(),
      treasuryEoa.address,
      buybackEoa.address,
      grantsEoa.address,
      FEE_BPS,
      SPLIT,
    );

    // roles
    await credit.grantRole(await credit.MINTER_ROLE(), await psm.getAddress());
    await credit.grantRole(await credit.BURNER_ROLE(), await psm.getAddress());
    await funding.grantRole(await funding.REVENUE_NOTIFIER_ROLE(), await router.getAddress());

    // seeds
    await usdc.mint(alice.address, 1_000_000n * E6);
    await usdc.mint(bob.address, 1_000_000n * E6);
    await usdc.mint(payer.address, 1_000_000n * E6);
    for (const s of [alice, bob, payer]) {
      await usdc.connect(s).approve(await psm.getAddress(), ethers.MaxUint256);
      await gov.mint(s.address, SEED_GOV, "seed");
      await gov.connect(s).approve(await staking.getAddress(), ethers.MaxUint256);
    }

    // projeto #1 ativo
    await gov.mint(projOwner.address, MIN_COLLATERAL, "collateral");
    await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL);
    await registry.connect(governance).registerProject(projOwner.address, "ipfs://p1", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(1);
    await time.increase(Number(PROBATION_DURATION) + 1);

    return { admin, governance, projOwner, alice, bob, payer, treasuryEoa, buybackEoa, grantsEoa,
      gov, credit, registry, staking, usdc, psm, funding, router };
  }

  /** Fixture estendida: alice/bob stakeados, rodada financiada 60/40. */
  async function fundedFixture() {
    const ctx = await deployFixture();
    const { alice, bob, projOwner, staking, psm, funding } = ctx;

    await staking.connect(alice).stake(1, STAKE, MAX_LOCK);
    await staking.connect(bob).stake(1, STAKE, MAX_LOCK);

    await psm.connect(alice).buy(100_000n * E6);
    await psm.connect(bob).buy(100_000n * E6);

    await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
    await ctx.credit.connect(alice).approve(await funding.getAddress(), ethers.MaxUint256);
    await ctx.credit.connect(bob).approve(await funding.getAddress(), ethers.MaxUint256);
    await funding.connect(alice).invest(1, (TARGET * 60n) / 100n);
    await funding.connect(bob).invest(1, (TARGET * 40n) / 100n); // completa -> Funded

    return ctx;
  }

  // ==================================================================
  // CreditPSM
  // ==================================================================
  describe("CreditPSM", function () {
    it("buy minta 1:1 com escala 6->18 e retem lastro", async function () {
      const { alice, usdc, credit, psm } = await loadFixture(deployFixture);
      const usdcIn = 1_234n * E6;
      await expect(psm.connect(alice).buy(usdcIn))
        .to.emit(psm, "Bought")
        .withArgs(alice.address, usdcIn, usdcIn * SCALE);
      expect(await credit.balanceOf(alice.address)).to.equal(usdcIn * SCALE);
      expect(await psm.backing()).to.equal(usdcIn);
      expect(await psm.mintedOutstanding()).to.equal(usdcIn * SCALE);
      expect(await psm.backingNormalized()).to.equal(await psm.mintedOutstanding());
    });

    it("sell queima e devolve USDC 1:1", async function () {
      const { alice, usdc, credit, psm } = await loadFixture(deployFixture);
      await psm.connect(alice).buy(1_000n * E6);
      const balBefore = await usdc.balanceOf(alice.address);
      await credit.connect(alice).approve(await psm.getAddress(), ethers.MaxUint256);
      await expect(psm.connect(alice).sell(400n * E18))
        .to.emit(psm, "Sold")
        .withArgs(alice.address, 400n * E18, 400n * E6);
      expect(await usdc.balanceOf(alice.address)).to.equal(balBefore + 400n * E6);
      expect(await credit.totalSupply()).to.equal(600n * E18);
      expect(await psm.mintedOutstanding()).to.equal(600n * E18);
    });

    it("sell reverte com poeira abaixo de 1e-6 USDC", async function () {
      const { alice, credit, psm } = await loadFixture(deployFixture);
      await psm.connect(alice).buy(10n * E6);
      await credit.connect(alice).approve(await psm.getAddress(), ethers.MaxUint256);
      await expect(psm.connect(alice).sell(SCALE + 1n)).to.be.revertedWithCustomError(psm, "DustAmount");
    });

    it("sell acima do lastro reverte (CREDIT de origem externa)", async function () {
      const { admin, alice, credit, psm } = await loadFixture(deployFixture);
      // CREDIT vindo de fora do PSM (genesis) — sem lastro correspondente.
      await credit.connect(admin).mintGenesis(alice.address, 1_000n * E18);
      await credit.connect(alice).approve(await psm.getAddress(), ethers.MaxUint256);
      await expect(psm.connect(alice).sell(1_000n * E18)).to.be.revertedWithCustomError(
        psm,
        "InsufficientBacking",
      );
    });
  });

  // ==================================================================
  // ProjectFunding
  // ==================================================================
  describe("ProjectFunding", function () {
    it("openRound: so dono, bounds de revShare/target/duration, rodada unica", async function () {
      const { projOwner, alice, funding } = await loadFixture(deployFixture);
      await expect(
        funding.connect(alice).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(funding, "NotProjectOwner");
      await expect(
        funding.connect(projOwner).openRound(1, TARGET, 50, ROUND_DURATION),
      ).to.be.revertedWithCustomError(funding, "RevShareOutOfBounds");
      await expect(
        funding.connect(projOwner).openRound(1, 1n * E18, REV_SHARE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(funding, "TargetOutOfBounds");
      await expect(
        funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, 60n * 60n),
      ).to.be.revertedWithCustomError(funding, "DurationOutOfBounds");

      await expect(funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION))
        .to.emit(funding, "RoundOpened");
      await expect(
        funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(funding, "RoundAlreadyExists");
    });

    it("invest: exige peso de stake >= minInvestWeight no projeto e respeita o alvo", async function () {
      const { projOwner, alice, staking, psm, credit, funding } = await loadFixture(deployFixture);
      await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
      await psm.connect(alice).buy(100_000n * E6);
      await credit.connect(alice).approve(await funding.getAddress(), ethers.MaxUint256);

      // sem stake -> peso 0 < minInvestWeight -> InsufficientStakeWeight (D3)
      await expect(funding.connect(alice).invest(1, 1_000n * E18)).to.be.revertedWithCustomError(
        funding,
        "InsufficientStakeWeight",
      );
      await staking.connect(alice).stake(1, STAKE, MAX_LOCK);
      await expect(funding.connect(alice).invest(1, TARGET + 1n)).to.be.revertedWithCustomError(
        funding,
        "ExceedsTarget",
      );
      await funding.connect(alice).invest(1, 1_000n * E18);
      expect(await funding.sharesOf(1, alice.address)).to.equal(1_000n * E18);
    });

    it("D3: invest com peso ABAIXO/EXATO/ACIMA do piso minInvestWeight", async function () {
      const { projOwner, alice, staking, psm, credit, funding } = await loadFixture(deployFixture);
      await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
      await psm.connect(alice).buy(100_000n * E6);
      await credit.connect(alice).approve(await funding.getAddress(), ethers.MaxUint256);

      // Piso default = 100e18 (100 GOV no lock minimo, multiplier 1x).
      const minWeight = await funding.minInvestWeight();
      expect(minWeight).to.equal(100n * E18);

      // MIN_LOCK do Staking = multiplier 1x -> peso == amount stakeado.
      const MIN_LOCK = await staking.MIN_LOCK();

      // (a) ABAIXO do piso: stake 99 GOV no lock minimo -> peso 99e18 < 100e18.
      await staking.connect(alice).stake(1, 99n * E18, MIN_LOCK);
      expect(await staking.getWeight(alice.address, 1)).to.equal(99n * E18);
      await expect(funding.connect(alice).invest(1, 1_000n * E18))
        .to.be.revertedWithCustomError(funding, "InsufficientStakeWeight")
        .withArgs(1, alice.address, 99n * E18, 100n * E18);

      // (b) EXATAMENTE no piso: acrescenta 1 GOV -> peso 100e18 == piso -> passa.
      await staking.connect(alice).increaseStake(1, 1n * E18);
      expect(await staking.getWeight(alice.address, 1)).to.equal(100n * E18);
      await funding.connect(alice).invest(1, 1_000n * E18);
      expect(await funding.sharesOf(1, alice.address)).to.equal(1_000n * E18);

      // (c) ACIMA do piso: mais stake -> peso > piso -> passa.
      await staking.connect(alice).increaseStake(1, 500n * E18);
      expect(await staking.getWeight(alice.address, 1)).to.be.greaterThan(100n * E18);
      await funding.connect(alice).invest(1, 1_000n * E18);
      expect(await funding.sharesOf(1, alice.address)).to.equal(2_000n * E18);
    });

    it("D3: claim NAO recebe o piso — investidor que reduziu stake (mas > 0) ainda saca", async function () {
      // Prova a decisao de desenho: minInvestWeight e barreira de ENTRADA,
      // nao de saida. Investidor entra com peso >= piso, depois reduz o stake
      // abaixo do piso (mas mantem algum) e continua podendo claim.
      const { governance, admin, projOwner, alice, bob, payer, staking, psm, credit, funding, router } =
        await loadFixture(deployFixture);

      // Sobe o piso p/ um valor alto o suficiente p/ que uma reducao caia abaixo.
      // Piso = 3_000e18. Alice stakea 1_000 GOV no lock maximo (4x) -> peso 4_000e18.
      await funding.connect(admin).setMinInvestWeight(3_000n * E18);

      await staking.connect(alice).stake(1, STAKE, MAX_LOCK); // peso 4_000e18 >= 3_000e18
      await staking.connect(bob).stake(1, STAKE, MAX_LOCK);
      await psm.connect(alice).buy(100_000n * E6);
      await psm.connect(bob).buy(100_000n * E6);

      await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
      await credit.connect(alice).approve(await funding.getAddress(), ethers.MaxUint256);
      await credit.connect(bob).approve(await funding.getAddress(), ethers.MaxUint256);
      await funding.connect(alice).invest(1, (TARGET * 60n) / 100n);
      await funding.connect(bob).invest(1, (TARGET * 40n) / 100n); // -> Funded

      // gera rev-share
      await psm.connect(payer).buy(10_000n * E6);
      await credit.connect(payer).approve(await router.getAddress(), ethers.MaxUint256);
      await router.connect(payer).pay(1, 10_000n * E18);

      // Alice reduz o stake: desfaz o lock e re-stakea POUCO no lock minimo,
      // ficando com peso 100e18 (> 0, mas << piso 3_000e18).
      await time.increase(Number(MAX_LOCK) + 1);
      await staking.connect(alice).unstakeAll(1);
      const MIN_LOCK = await staking.MIN_LOCK();
      await staking.connect(alice).stake(1, 100n * E18, MIN_LOCK);
      const aliceWeight = await staking.getWeight(alice.address, 1);
      expect(aliceWeight).to.equal(100n * E18);
      expect(aliceWeight).to.be.lessThan(await funding.minInvestWeight());

      // Com peso < piso, um NOVO invest reverteria...
      await expect(funding.connect(alice).invest(1, 1n * E18)).to.be.revertedWithCustomError(
        funding,
        "RoundNotOpen", // rodada ja Funded; mas o ponto e que o gate de peso nao barra o claim
      );

      // ...mas o claim do que ela JA conquistou passa normalmente (gate peso > 0).
      const expectedPool = (10_000n * E18 * BigInt(REV_SHARE_BPS)) / 10_000n;
      const before = await credit.balanceOf(alice.address);
      await funding.connect(alice).claim(1);
      expect(await credit.balanceOf(alice.address)).to.equal(before + (expectedPool * 60n) / 100n);
    });

    it("alvo batido -> Funded, dono recebe o captado, revShareBpsOf ativa", async function () {
      const { projOwner, credit, funding } = await loadFixture(fundedFixture);
      expect((await funding.rounds(1)).status).to.equal(2n); // Funded
      expect(await credit.balanceOf(projOwner.address)).to.equal(TARGET);
      expect(await funding.revShareBpsOf(1)).to.equal(REV_SHARE_BPS);
    });

    it("rodada expirada sem alvo -> Failed, refund integral", async function () {
      const { projOwner, alice, staking, psm, credit, funding } = await loadFixture(deployFixture);
      await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
      await staking.connect(alice).stake(1, STAKE, MAX_LOCK);
      await psm.connect(alice).buy(10_000n * E6);
      await credit.connect(alice).approve(await funding.getAddress(), ethers.MaxUint256);
      await funding.connect(alice).invest(1, 5_000n * E18);

      await expect(funding.closeExpiredRound(1)).to.be.revertedWithCustomError(
        funding,
        "RoundStillOpen",
      );
      await time.increase(Number(ROUND_DURATION) + 1);
      await expect(funding.connect(alice).invest(1, 1n * E18)).to.be.revertedWithCustomError(
        funding,
        "RoundNotOpen",
      );
      await funding.closeExpiredRound(1);

      const before = await credit.balanceOf(alice.address);
      await funding.connect(alice).refund(1);
      expect(await credit.balanceOf(alice.address)).to.equal(before + 5_000n * E18);
      expect(await funding.revShareBpsOf(1)).to.equal(0);
    });

    it("notifyRevenue: so REVENUE_NOTIFIER_ROLE e so com rodada Funded", async function () {
      const { alice, funding } = await loadFixture(fundedFixture);
      await expect(funding.connect(alice).notifyRevenue(1, 100n)).to.be.reverted;
    });

    it("claim: pro-rata 60/40, exige stake, acumula sem expirar", async function () {
      const { admin, alice, bob, payer, staking, psm, credit, funding, router } =
        await loadFixture(fundedFixture);

      // payer compra CREDIT e paga 10k pro projeto via router.
      await psm.connect(payer).buy(10_000n * E6);
      await credit.connect(payer).approve(await router.getAddress(), ethers.MaxUint256);
      await router.connect(payer).pay(1, 10_000n * E18);

      const expectedPool = (10_000n * E18 * BigInt(REV_SHARE_BPS)) / 10_000n; // 800
      expect(await funding.pendingRevenue(1, alice.address)).to.equal((expectedPool * 60n) / 100n);
      expect(await funding.pendingRevenue(1, bob.address)).to.equal((expectedPool * 40n) / 100n);

      // alice saca
      const before = await credit.balanceOf(alice.address);
      await funding.connect(alice).claim(1);
      expect(await credit.balanceOf(alice.address)).to.equal(before + (expectedPool * 60n) / 100n);
      await expect(funding.connect(alice).claim(1)).to.be.revertedWithCustomError(
        funding,
        "NothingToClaim",
      );

      // bob sem stake nao saca; valor fica acruado
      await time.increase(Number(MAX_LOCK) + 1);
      await staking.connect(bob).unstakeAll(1);
      await expect(funding.connect(bob).claim(1)).to.be.revertedWithCustomError(
        funding,
        "NoGovStaked",
      );
      expect(await funding.pendingRevenue(1, bob.address)).to.equal((expectedPool * 40n) / 100n);
      await staking.connect(bob).stake(1, STAKE, MAX_LOCK);
      await funding.connect(bob).claim(1);
      expect(await funding.pendingRevenue(1, bob.address)).to.equal(0n);
    });
  });

  // ==================================================================
  // FeeRouterV2
  // ==================================================================
  describe("FeeRouterV2", function () {
    it("pay: fee 2,5% split 40/40/20 + rev-share 8% + resto pro app", async function () {
      const { projOwner, payer, treasuryEoa, buybackEoa, grantsEoa, psm, credit, funding, router } =
        await loadFixture(fundedFixture);

      await psm.connect(payer).buy(100n * E6);
      await credit.connect(payer).approve(await router.getAddress(), ethers.MaxUint256);

      const amount = 100n * E18;
      const fee = (amount * FEE_BPS) / 10_000n; // 2.5
      const toTreasury = (fee * 4000n) / 10_000n; // 1.0
      const toBuyback = (fee * 4000n) / 10_000n; // 1.0
      const toGrants = fee - toTreasury - toBuyback; // 0.5
      const revShare = (amount * BigInt(REV_SHARE_BPS)) / 10_000n; // 8.0
      const toApp = amount - fee - revShare; // 89.5

      const ownerBefore = await credit.balanceOf(projOwner.address);
      await expect(router.connect(payer).pay(1, amount))
        .to.emit(router, "PaymentRouted")
        .withArgs(1, payer.address, amount, toTreasury, toBuyback, toGrants, revShare, toApp, false);

      expect(await credit.balanceOf(treasuryEoa.address)).to.equal(toTreasury);
      expect(await credit.balanceOf(buybackEoa.address)).to.equal(toBuyback);
      expect(await credit.balanceOf(grantsEoa.address)).to.equal(toGrants);
      expect(await credit.balanceOf(projOwner.address)).to.equal(ownerBefore + toApp);
      expect(await router.grossVolumeOf(1)).to.equal(amount);
      // pagamento de terceiro (payer != owner/appRecipient): conta como sinal.
      expect(await router.uniquePayersOf(1)).to.equal(1n);

      const [pFee, pRev, pApp] = await router.previewPay(1, amount);
      expect(pFee).to.equal(fee);
      expect(pRev).to.equal(revShare);
      expect(pApp).to.equal(toApp);
    });

    it("pay sem rodada financiada: rev-share zero, app recebe 97,5%", async function () {
      const { projOwner, payer, psm, credit, router } = await loadFixture(deployFixture);
      await psm.connect(payer).buy(100n * E6);
      await credit.connect(payer).approve(await router.getAddress(), ethers.MaxUint256);
      const amount = 100n * E18;
      await router.connect(payer).pay(1, amount);
      expect(await credit.balanceOf(projOwner.address)).to.equal((amount * 9750n) / 10_000n);
    });

    it("pay em projeto inativo reverte", async function () {
      const { payer, router } = await loadFixture(deployFixture);
      await expect(router.connect(payer).pay(99, 1n * E18)).to.be.revertedWithCustomError(
        router,
        "ProjectNotActive",
      );
    });

    // ---------------------------------------------------------------
    // D1 — guarda anti-self-payment + D2 — pagadores unicos
    // (parecer 2026-07-10-wash-signal-integrity.md §6)
    // ---------------------------------------------------------------

    it("self-payment (owner paga o proprio app): split intacto, sinal NAO conta", async function () {
      // projOwner e o appRecipient default (fallback do Registry). Ele mesmo paga.
      const { projOwner, treasuryEoa, buybackEoa, grantsEoa, gov, usdc, staking, psm, credit, funding, router } =
        await loadFixture(deployFixture);

      // projOwner precisa de USDC (o fixture so semeia alice/bob/payer) p/ comprar CREDIT.
      await usdc.mint(projOwner.address, 1_000_000n * E6);
      await usdc.connect(projOwner).approve(await psm.getAddress(), ethers.MaxUint256);

      // Abre e financia a rodada com o proprio owner p/ ativar rev-share (8%).
      await gov.mint(projOwner.address, SEED_GOV, "self");
      await gov.connect(projOwner).approve(await staking.getAddress(), ethers.MaxUint256);
      await staking.connect(projOwner).stake(1, STAKE, MAX_LOCK);
      await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
      await psm.connect(projOwner).buy(200_000n * E6); // USDC->CREDIT p/ investir e pagar
      await credit.connect(projOwner).approve(await funding.getAddress(), ethers.MaxUint256);
      await funding.connect(projOwner).invest(1, TARGET); // completa -> Funded, devolve raised ao owner
      expect(await funding.revShareBpsOf(1)).to.equal(REV_SHARE_BPS);

      await credit.connect(projOwner).approve(await router.getAddress(), ethers.MaxUint256);

      const amount = 100n * E18;
      const fee = (amount * FEE_BPS) / 10_000n;
      const toTreasury = (fee * 4000n) / 10_000n;
      const toBuyback = (fee * 4000n) / 10_000n;
      const toGrants = fee - toTreasury - toBuyback;
      const revShare = (amount * BigInt(REV_SHARE_BPS)) / 10_000n;
      const toApp = amount - fee - revShare;

      const tBefore = await credit.balanceOf(treasuryEoa.address);
      const bBefore = await credit.balanceOf(buybackEoa.address);
      const gBefore = await credit.balanceOf(grantsEoa.address);
      const ownerBefore = await credit.balanceOf(projOwner.address);
      const fundingBefore = await credit.balanceOf(await funding.getAddress());

      // selfPayment = true no evento.
      await expect(router.connect(projOwner).pay(1, amount))
        .to.emit(router, "PaymentRouted")
        .withArgs(1, projOwner.address, amount, toTreasury, toBuyback, toGrants, revShare, toApp, true);

      // Split de VALOR ocorre normalmente (conservacao intacta).
      expect((await credit.balanceOf(treasuryEoa.address)) - tBefore).to.equal(toTreasury);
      expect((await credit.balanceOf(buybackEoa.address)) - bBefore).to.equal(toBuyback);
      expect((await credit.balanceOf(grantsEoa.address)) - gBefore).to.equal(toGrants);
      expect((await credit.balanceOf(await funding.getAddress())) - fundingBefore).to.equal(revShare);
      // owner e o appRecipient: paga `amount` e recebe `toApp` de volta.
      expect(ownerBefore - (await credit.balanceOf(projOwner.address))).to.equal(amount - toApp);

      // Conservacao: as parcelas somam o amount.
      expect(toTreasury + toBuyback + toGrants + revShare + toApp).to.equal(amount);

      // Mas os CONTADORES DE SINAL nao se movem.
      expect(await router.grossVolumeOf(1)).to.equal(0n);
      expect(await router.uniquePayersOf(1)).to.equal(0n);
      expect(await router.hasPaid(1, projOwner.address)).to.equal(false);
    });

    it("self-payment via appRecipient rotacionado: sinal NAO conta", async function () {
      // owner aponta o recipient p/ `alice`; quando ALICE paga, e self-payment.
      const { projOwner, alice, usdc, psm, credit, router } = await loadFixture(deployFixture);
      await router.connect(projOwner).setAppRecipient(1, alice.address);

      await psm.connect(alice).buy(1_000n * E6);
      await credit.connect(alice).approve(await router.getAddress(), ethers.MaxUint256);

      await expect(router.connect(alice).pay(1, 100n * E18))
        .to.emit(router, "PaymentRouted")
        .withArgs(1, alice.address, 100n * E18, anyValue, anyValue, anyValue, anyValue, anyValue, true);

      expect(await router.grossVolumeOf(1)).to.equal(0n);
      expect(await router.uniquePayersOf(1)).to.equal(0n);

      // owner tambem continua sendo self-payment mesmo apos rotacionar o recipient.
      await usdc.mint(projOwner.address, 1_000_000n * E6);
      await usdc.connect(projOwner).approve(await psm.getAddress(), ethers.MaxUint256);
      await psm.connect(projOwner).buy(1_000n * E6);
      await credit.connect(projOwner).approve(await router.getAddress(), ethers.MaxUint256);
      await expect(router.connect(projOwner).pay(1, 50n * E18))
        .to.emit(router, "PaymentRouted")
        .withArgs(1, projOwner.address, 50n * E18, anyValue, anyValue, anyValue, anyValue, anyValue, true);
      expect(await router.uniquePayersOf(1)).to.equal(0n);
    });

    it("D2: segundo pagamento do MESMO terceiro soma GMV mas nao move uniquePayers", async function () {
      const { payer, psm, credit, router } = await loadFixture(deployFixture);
      await psm.connect(payer).buy(1_000n * E6);
      await credit.connect(payer).approve(await router.getAddress(), ethers.MaxUint256);

      await router.connect(payer).pay(1, 100n * E18);
      expect(await router.grossVolumeOf(1)).to.equal(100n * E18);
      expect(await router.uniquePayersOf(1)).to.equal(1n);
      expect(await router.hasPaid(1, payer.address)).to.equal(true);

      // segundo pagamento do mesmo pagador: GMV soma, pagadores unicos NAO.
      await router.connect(payer).pay(1, 40n * E18);
      expect(await router.grossVolumeOf(1)).to.equal(140n * E18);
      expect(await router.uniquePayersOf(1)).to.equal(1n);
    });

    it("D2: dois terceiros distintos -> uniquePayersOf == 2", async function () {
      const { alice, bob, psm, credit, router } = await loadFixture(deployFixture);
      // alice/bob nao sao owner nem appRecipient do projeto #1 -> terceiros.
      for (const s of [alice, bob]) {
        await psm.connect(s).buy(1_000n * E6);
        await credit.connect(s).approve(await router.getAddress(), ethers.MaxUint256);
      }
      await router.connect(alice).pay(1, 100n * E18);
      await router.connect(bob).pay(1, 100n * E18);

      expect(await router.uniquePayersOf(1)).to.equal(2n);
      expect(await router.grossVolumeOf(1)).to.equal(200n * E18);
    });

    it("conservacao: soma das transferencias == amount (pagamento de terceiro)", async function () {
      const { projOwner, treasuryEoa, buybackEoa, grantsEoa, payer, psm, credit, funding, router } =
        await loadFixture(fundedFixture);
      await psm.connect(payer).buy(1_000n * E6);
      await credit.connect(payer).approve(await router.getAddress(), ethers.MaxUint256);

      const amount = 100n * E18;
      const routerAddr = await router.getAddress();
      const fundingAddr = await funding.getAddress();

      const before = {
        t: await credit.balanceOf(treasuryEoa.address),
        b: await credit.balanceOf(buybackEoa.address),
        g: await credit.balanceOf(grantsEoa.address),
        f: await credit.balanceOf(fundingAddr),
        o: await credit.balanceOf(projOwner.address),
        payer: await credit.balanceOf(payer.address),
        router: await credit.balanceOf(routerAddr),
      };

      await router.connect(payer).pay(1, amount);

      const dT = (await credit.balanceOf(treasuryEoa.address)) - before.t;
      const dB = (await credit.balanceOf(buybackEoa.address)) - before.b;
      const dG = (await credit.balanceOf(grantsEoa.address)) - before.g;
      const dF = (await credit.balanceOf(fundingAddr)) - before.f;
      const dO = (await credit.balanceOf(projOwner.address)) - before.o;
      const dPayer = before.payer - (await credit.balanceOf(payer.address));

      // tudo que saiu do pagador foi redistribuido, sem sobra no router.
      expect(dPayer).to.equal(amount);
      expect(dT + dB + dG + dF + dO).to.equal(amount);
      expect(await credit.balanceOf(routerAddr)).to.equal(before.router); // router nao retem
    });

    it("setFeeBps respeita teto duro; setFeeSplit valida soma; appRecipient owner-gated", async function () {
      const { admin, alice, projOwner, router } = await loadFixture(deployFixture);
      await expect(router.connect(admin).setFeeBps(501)).to.be.revertedWithCustomError(
        router,
        "FeeAboveCap",
      );
      await router.connect(admin).setFeeBps(300);
      expect(await router.feeBps()).to.equal(300);

      await expect(
        router.connect(admin).setFeeSplit({ treasuryBps: 5000, buybackBps: 4000, grantsBps: 2000 }),
      ).to.be.revertedWithCustomError(router, "SplitDoesNotSumTo10000");

      await expect(
        router.connect(alice).setAppRecipient(1, alice.address),
      ).to.be.revertedWithCustomError(router, "NotProjectOwner");
      await router.connect(projOwner).setAppRecipient(1, alice.address);
      expect(await router.appRecipientOf(1)).to.equal(alice.address);
    });

    it("setRecipients: governanca troca destinos; zero-address reverte", async function () {
      const { admin, alice, bob, payer, router } = await loadFixture(deployFixture);
      await expect(
        router.connect(admin).setRecipients(ethers.ZeroAddress, alice.address, bob.address),
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.connect(admin).setRecipients(alice.address, bob.address, payer.address))
        .to.emit(router, "RecipientsUpdated")
        .withArgs(alice.address, bob.address, payer.address);
      expect(await router.treasuryRecipient()).to.equal(alice.address);
    });

    it("pay com amount zero reverte", async function () {
      const { payer, router } = await loadFixture(deployFixture);
      await expect(router.connect(payer).pay(1, 0n)).to.be.revertedWithCustomError(router, "ZeroAmount");
    });

    it("setAppRecipient com zero-address reverte", async function () {
      const { projOwner, router } = await loadFixture(deployFixture);
      await expect(
        router.connect(projOwner).setAppRecipient(1, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
    });
  });

  // ==================================================================
  // Cobertura de branches (guards e caminhos de erro)
  // ==================================================================
  describe("branches — guards", function () {
    it("CreditPSM: buy/sell com zero revertem; constructor rejeita decimals > 18", async function () {
      const { psm, credit } = await loadFixture(deployFixture);
      await expect(psm.buy(0n)).to.be.revertedWithCustomError(psm, "ZeroAmount");
      await expect(psm.sell(0n)).to.be.revertedWithCustomError(psm, "ZeroAmount");
      const Usdc = await ethers.getContractFactory("ERC20DecimalsMock");
      const bad = await Usdc.deploy("Bad", "BAD", 19);
      const CreditPSM = await ethers.getContractFactory("CreditPSM");
      await expect(
        CreditPSM.deploy(await credit.getAddress(), await bad.getAddress()),
      ).to.be.revertedWithCustomError(psm, "InvalidDecimals");
    });

    it("ProjectFunding: invest zero, closeExpiredRound cedo, refund sem shares, setMinTarget gated", async function () {
      const { admin, alice, projOwner, staking, funding } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE, MAX_LOCK);
      await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
      await expect(funding.connect(alice).invest(1, 0n)).to.be.revertedWithCustomError(funding, "ZeroAmount");
      await expect(funding.closeExpiredRound(1)).to.be.revertedWithCustomError(funding, "RoundStillOpen");
      // refund exige rodada Failed
      await expect(funding.connect(alice).refund(1)).to.be.revertedWithCustomError(funding, "RoundNotFailed");
      // setMinTarget: só governança
      await expect(funding.connect(alice).setMinTarget(1n)).to.be.reverted;
      await expect(funding.connect(admin).setMinTarget(200n * E18))
        .to.emit(funding, "MinTargetUpdated")
        .withArgs(100n * E18, 200n * E18);
    });

    it("D3: setMinInvestWeight só GOVERNANCE_ROLE, emite MinInvestWeightUpdated", async function () {
      const { admin, alice, funding } = await loadFixture(deployFixture);
      // não-autorizado reverte
      await expect(funding.connect(alice).setMinInvestWeight(1n)).to.be.reverted;
      // governança ajusta e emite (previous == default 100e18)
      await expect(funding.connect(admin).setMinInvestWeight(500n * E18))
        .to.emit(funding, "MinInvestWeightUpdated")
        .withArgs(100n * E18, 500n * E18);
      expect(await funding.minInvestWeight()).to.equal(500n * E18);
    });

    it("ProjectFunding: openRound em projeto inativo reverte; rodada duplicada reverte", async function () {
      const { projOwner, funding } = await loadFixture(deployFixture);
      await expect(
        funding.connect(projOwner).openRound(99, TARGET, REV_SHARE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(funding, "ProjectNotActive");
      await funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION);
      await expect(
        funding.connect(projOwner).openRound(1, TARGET, REV_SHARE_BPS, ROUND_DURATION),
      ).to.be.revertedWithCustomError(funding, "RoundAlreadyExists");
    });

    it("FeeRouterV2.previewPay reflete fee + rev-share do projeto financiado", async function () {
      const { router } = await loadFixture(fundedFixture);
      const [fee, revShare, toApp] = await router.previewPay(1, 100n * E18);
      expect(fee).to.equal((100n * E18 * FEE_BPS) / 10_000n);
      expect(revShare).to.equal((100n * E18 * BigInt(REV_SHARE_BPS)) / 10_000n);
      expect(toApp).to.equal(100n * E18 - fee - revShare);
    });
  });
});
