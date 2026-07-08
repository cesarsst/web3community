import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Treasury — Fase 1.4 (bucket bonders + gauge fallback) test suite.
 *
 * Cobertura:
 *  - depositPolRefill: gating, ZeroAmount, ledger acumula, evento.
 *  - addPOLFromRefill: bounds (PolRefillBucketInsufficient, BuybackInfraMissing,
 *    ZeroAmount), CEI (ledger debitado antes de NPM), evento, integracao com
 *    `_provisionLiquidity` (mint NFT + increaseLiquidity).
 *  - depositPendingGaugeRewards: gating, ZeroAmount, ledger acumula, evento.
 *  - flushPendingGaugeRewards: erros (LiquidityGaugeNotSet, LiquidityGaugePaused,
 *    NoPendingGaugeRewards), happy path com gauge mock, gating de role.
 *  - setLiquidityGauge: gating + evento.
 */
describe("Treasury — Fase 1.4 (bucket bonders + gauge fallback)", function () {
  const ONE_USDC = 10n ** 6n;
  const ONE_CREDIT = 10n ** 18n;
  const SEED_CREDIT = 1_000_000n * ONE_CREDIT;
  const SEED_USDC = 100_000n * ONE_USDC;
  const FAR_DEADLINE = 2n ** 32n - 1n;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function deployFixture() {
    const [admin, governance, distributor, other] = await ethers.getSigners();

    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("Web3Community Credit", "CREDIT", admin.address);
    await credit.waitForDeployment();

    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    // Garante CREDIT < USDC apenas para consistencia visual (nao critico para
    // os testes deste suite — POL e tocado uma vez via addPOLFromRefill).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let usdc: any = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();
    const creditAddr = await credit.getAddress();
    let attempts = 0;
    while (attempts < 200) {
      const usdcAddr = await usdc.getAddress();
      if (creditAddr.toLowerCase() < usdcAddr.toLowerCase()) {
        break;
      }
      usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
      await usdc.waitForDeployment();
      attempts += 1;
    }

    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      admin.address,
      await credit.getAddress(),
      await usdc.getAddress(),
    );
    await treasury.waitForDeployment();

    const GOVERNANCE_ROLE = await treasury.GOVERNANCE_ROLE();
    const POL_REFILL_DEPOSITOR_ROLE = await treasury.POL_REFILL_DEPOSITOR_ROLE();
    const GAUGE_FALLBACK_DEPOSITOR_ROLE = await treasury.GAUGE_FALLBACK_DEPOSITOR_ROLE();
    await treasury.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);
    await treasury.connect(admin).grantRole(POL_REFILL_DEPOSITOR_ROLE, distributor.address);
    await treasury.connect(admin).grantRole(GAUGE_FALLBACK_DEPOSITOR_ROLE, distributor.address);

    // NPM mock (POL).
    const NPMMock = await ethers.getContractFactory("NonfungiblePositionManagerMock");
    const npm = await NPMMock.deploy();
    await npm.waitForDeployment();

    // Gauge mock (Fase 1.4).
    const GaugeMock = await ethers.getContractFactory("LiquidityGaugeRewardsMock");
    const gauge = await GaugeMock.deploy(await credit.getAddress());
    await gauge.waitForDeployment();

    // Pre-fund Treasury com USDC (cap mensal/per event do FFP nao se aplica
    // a addPOLFromRefill — apenas saldo livre).
    await usdc.mint(await treasury.getAddress(), SEED_USDC * 10n);

    // Admin grants minter para si proprio para mint manual de CREDIT.
    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);

    return {
      admin,
      governance,
      distributor,
      other,
      credit,
      usdc,
      treasury,
      npm,
      gauge,
      GOVERNANCE_ROLE,
      POL_REFILL_DEPOSITOR_ROLE,
      GAUGE_FALLBACK_DEPOSITOR_ROLE,
      MINTER_ROLE,
    };
  }

  // ------------------------------------------------------------------
  // setLiquidityGauge
  // ------------------------------------------------------------------

  describe("setLiquidityGauge", function () {
    it("is governance-gated", async function () {
      const { treasury, gauge, other } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(other).setLiquidityGauge(await gauge.getAddress(), 1),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });

    it("emits LiquidityGaugeSet and persists", async function () {
      const { treasury, governance, gauge } = await loadFixture(deployFixture);
      const gaugeAddr = await gauge.getAddress();
      await expect(treasury.connect(governance).setLiquidityGauge(gaugeAddr, 7))
        .to.emit(treasury, "LiquidityGaugeSet")
        .withArgs(gaugeAddr, 7);
      expect(await treasury.liquidityGauge()).to.equal(gaugeAddr);
      expect(await treasury.liquidityGaugePoolId()).to.equal(7n);
    });

    it("can be reset to zero (disables flush)", async function () {
      const { treasury, governance, gauge } = await loadFixture(deployFixture);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 1);
      await treasury.connect(governance).setLiquidityGauge(ethers.ZeroAddress, 0);
      expect(await treasury.liquidityGauge()).to.equal(ethers.ZeroAddress);
    });
  });

  // ------------------------------------------------------------------
  // depositPolRefill
  // ------------------------------------------------------------------

  describe("depositPolRefill", function () {
    it("reverts when caller lacks POL_REFILL_DEPOSITOR_ROLE", async function () {
      const { treasury, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(other).depositPolRefill(100n)).to.be.revertedWithCustomError(
        treasury,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts on ZeroAmount", async function () {
      const { treasury, distributor } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(distributor).depositPolRefill(0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("accumulates ledger across multiple deposits and emits PolRefillDeposited", async function () {
      const { treasury, distributor, admin, credit } = await loadFixture(deployFixture);
      // Lastro real: o deposito exige CREDIT ja mintado para o Treasury
      // (invariante enforced tambem nas entradas — DepositExceedsCreditBalance).
      await credit.connect(admin).mint(await treasury.getAddress(), 350n, "test");
      await expect(treasury.connect(distributor).depositPolRefill(100n))
        .to.emit(treasury, "PolRefillDeposited")
        .withArgs(100n, 100n);
      expect(await treasury.polRefillBucket()).to.equal(100n);

      await expect(treasury.connect(distributor).depositPolRefill(250n))
        .to.emit(treasury, "PolRefillDeposited")
        .withArgs(250n, 350n);
      expect(await treasury.polRefillBucket()).to.equal(350n);
    });

    it("reverts DepositExceedsCreditBalance when ledger would exceed real balance", async function () {
      const { treasury, distributor, admin, credit } = await loadFixture(deployFixture);
      await credit.connect(admin).mint(await treasury.getAddress(), 100n, "test");
      await expect(treasury.connect(distributor).depositPolRefill(101n))
        .to.be.revertedWithCustomError(treasury, "DepositExceedsCreditBalance")
        .withArgs(101n, 100n);
    });
  });

  // ------------------------------------------------------------------
  // addPOLFromRefill
  // ------------------------------------------------------------------

  describe("addPOLFromRefill", function () {
    it("reverts when both amounts are zero", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).addPOLFromRefill(0n, 0n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts BuybackInfraMissing when positionManager not set", async function () {
      const { treasury, governance, distributor, admin, credit } = await loadFixture(deployFixture);
      // Acumula bucket.
      await credit.connect(admin).mint(await treasury.getAddress(), SEED_CREDIT, "test");
      await treasury.connect(distributor).depositPolRefill(SEED_CREDIT);
      // Sem positionManager.
      await expect(
        treasury.connect(governance).addPOLFromRefill(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "BuybackInfraMissing");
    });

    it("reverts PolRefillBucketInsufficient when creditAmount > bucket", async function () {
      const { treasury, governance, distributor, admin, credit, npm } =
        await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await credit.connect(admin).mint(await treasury.getAddress(), SEED_CREDIT, "test");
      await treasury.connect(distributor).depositPolRefill(SEED_CREDIT);
      await expect(
        treasury
          .connect(governance)
          .addPOLFromRefill(SEED_CREDIT + 1n, SEED_USDC, 0n, 0n, FAR_DEADLINE),
      )
        .to.be.revertedWithCustomError(treasury, "PolRefillBucketInsufficient")
        .withArgs(SEED_CREDIT + 1n, SEED_CREDIT);
    });

    it("happy path: debits bucket BEFORE call (CEI), provisions liquidity, emits both events", async function () {
      const { treasury, governance, distributor, admin, credit, usdc, npm } =
        await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      const refillCredit = 500_000n * ONE_CREDIT;
      const refillUsdc = 50_000n * ONE_USDC;
      // Mint CREDIT direto pro Treasury simulando o V2.
      await credit.connect(admin).mint(await treasury.getAddress(), refillCredit, "bonders");
      await treasury.connect(distributor).depositPolRefill(refillCredit);

      const tx = await treasury
        .connect(governance)
        .addPOLFromRefill(refillCredit, refillUsdc, 0n, 0n, FAR_DEADLINE);

      await expect(tx).to.emit(treasury, "POLAdded");
      await expect(tx).to.emit(treasury, "PolRefillUsed").withArgs(refillCredit, refillUsdc, 0n);

      // Bucket debitado.
      expect(await treasury.polRefillBucket()).to.equal(0n);
      // POL position criada.
      expect(await treasury.polTokenId()).to.equal(1n);
      // CREDIT e USDC saiu do treasury para o NPM mock.
      const npmAddr = await npm.getAddress();
      expect(await credit.balanceOf(npmAddr)).to.equal(refillCredit);
      expect(await usdc.balanceOf(npmAddr)).to.equal(refillUsdc);
    });

    it("subsequent call uses increaseLiquidity on same tokenId", async function () {
      const { treasury, governance, distributor, admin, credit, npm } =
        await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      // Primeira injecao via addPOL "tradicional" para criar a posicao.
      await credit.connect(admin).mint(await treasury.getAddress(), SEED_CREDIT, "bootstrap");
      await treasury
        .connect(governance)
        .addPOL(SEED_CREDIT / 2n, SEED_USDC / 2n, 0n, 0n, FAR_DEADLINE);
      const tokenId = await treasury.polTokenId();

      // Acumula bucket e refill.
      await treasury.connect(distributor).depositPolRefill(SEED_CREDIT / 2n);
      await treasury
        .connect(governance)
        .addPOLFromRefill(SEED_CREDIT / 2n, SEED_USDC / 2n, 0n, 0n, FAR_DEADLINE);

      // tokenId mantido.
      expect(await treasury.polTokenId()).to.equal(tokenId);
    });

    it("rejects unauthorized callers", async function () {
      const { treasury, other } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(other).addPOLFromRefill(1n, 1n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------------------------
  // depositPendingGaugeRewards
  // ------------------------------------------------------------------

  describe("depositPendingGaugeRewards", function () {
    it("reverts when caller lacks GAUGE_FALLBACK_DEPOSITOR_ROLE", async function () {
      const { treasury, other } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(other).depositPendingGaugeRewards(100n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });

    it("reverts on ZeroAmount", async function () {
      const { treasury, distributor } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(distributor).depositPendingGaugeRewards(0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("accumulates ledger and emits PendingGaugeDeposited", async function () {
      const { treasury, distributor, admin, credit } = await loadFixture(deployFixture);
      await credit.connect(admin).mint(await treasury.getAddress(), 150n, "test");
      await expect(treasury.connect(distributor).depositPendingGaugeRewards(100n))
        .to.emit(treasury, "PendingGaugeDeposited")
        .withArgs(100n, 100n);
      await expect(treasury.connect(distributor).depositPendingGaugeRewards(50n))
        .to.emit(treasury, "PendingGaugeDeposited")
        .withArgs(50n, 150n);
      expect(await treasury.pendingGaugeRewards()).to.equal(150n);
    });

    it("reverts DepositExceedsCreditBalance when ledger would exceed real balance", async function () {
      const { treasury, distributor, admin, credit } = await loadFixture(deployFixture);
      await credit.connect(admin).mint(await treasury.getAddress(), 100n, "test");
      await expect(treasury.connect(distributor).depositPendingGaugeRewards(101n))
        .to.be.revertedWithCustomError(treasury, "DepositExceedsCreditBalance")
        .withArgs(101n, 100n);
    });
  });

  // ------------------------------------------------------------------
  // flushPendingGaugeRewards
  // ------------------------------------------------------------------

  describe("flushPendingGaugeRewards", function () {
    const FLUSH_DURATION = 7 * 24 * 60 * 60;

    it("reverts LiquidityGaugeNotSet when gauge unconfigured", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).flushPendingGaugeRewards(0n, 0n, FLUSH_DURATION),
      ).to.be.revertedWithCustomError(treasury, "LiquidityGaugeNotSet");
    });

    it("reverts LiquidityGaugePaused when gauge.paused() == true", async function () {
      const { treasury, governance, gauge } = await loadFixture(deployFixture);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 1);
      await gauge.setPaused(true);
      await expect(
        treasury.connect(governance).flushPendingGaugeRewards(0n, 0n, FLUSH_DURATION),
      ).to.be.revertedWithCustomError(treasury, "LiquidityGaugePaused");
    });

    it("reverts NoPendingGaugeRewards when ledger == 0", async function () {
      const { treasury, governance, gauge } = await loadFixture(deployFixture);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 1);
      await expect(
        treasury.connect(governance).flushPendingGaugeRewards(0n, 0n, FLUSH_DURATION),
      ).to.be.revertedWithCustomError(treasury, "NoPendingGaugeRewards");
    });

    it("happy path (amount = 0 -> tudo; poolId = 0 -> default): drains ledger, approves gauge, notifies, emits", async function () {
      const { treasury, governance, distributor, admin, credit, gauge } =
        await loadFixture(deployFixture);
      const amount = 12_345n * ONE_CREDIT;
      await credit.connect(admin).mint(await treasury.getAddress(), amount, "fallback");
      await treasury.connect(distributor).depositPendingGaugeRewards(amount);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 3);

      await expect(treasury.connect(governance).flushPendingGaugeRewards(0n, 0n, FLUSH_DURATION))
        .to.emit(treasury, "PendingGaugeFlushed")
        .withArgs(amount, 3n, FLUSH_DURATION);

      expect(await treasury.pendingGaugeRewards()).to.equal(0n);
      expect(await gauge.notifyCount()).to.equal(1n);
      expect(await gauge.lastNotifyAmount()).to.equal(amount);
      expect(await gauge.lastPoolId()).to.equal(3n);
      expect(await gauge.lastDuration()).to.equal(FLUSH_DURATION);
      // Allowance resetada apos call.
      expect(
        await credit.allowance(await treasury.getAddress(), await gauge.getAddress()),
      ).to.equal(0n);
    });

    it("partial flush: drains only `amount`, remainder stays reserved in the ledger", async function () {
      const { treasury, governance, distributor, admin, credit, gauge } =
        await loadFixture(deployFixture);
      const total = 1_000n * ONE_CREDIT;
      const part = 400n * ONE_CREDIT;
      await credit.connect(admin).mint(await treasury.getAddress(), total, "fallback");
      await treasury.connect(distributor).depositPendingGaugeRewards(total);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 3);

      await expect(treasury.connect(governance).flushPendingGaugeRewards(part, 0n, FLUSH_DURATION))
        .to.emit(treasury, "PendingGaugeFlushed")
        .withArgs(part, 3n, FLUSH_DURATION);

      expect(await treasury.pendingGaugeRewards()).to.equal(total - part);
      expect(await gauge.lastNotifyAmount()).to.equal(part);
      // O restante permanece reservado (segregacao intacta).
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);
    });

    it("explicit poolId overrides the default (drena para outra pool sem re-apontar o gauge)", async function () {
      const { treasury, governance, distributor, admin, credit, gauge } =
        await loadFixture(deployFixture);
      const amount = 500n * ONE_CREDIT;
      await credit.connect(admin).mint(await treasury.getAddress(), amount, "fallback");
      await treasury.connect(distributor).depositPendingGaugeRewards(amount);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 3);

      // Cenario do freeze por IncentiveOverlap: a pool default (3) esta com
      // incentive ativa perpetuamente renovada; governance drena para a
      // pool 5 sem precisar de setLiquidityGauge.
      await expect(treasury.connect(governance).flushPendingGaugeRewards(0n, 5n, FLUSH_DURATION))
        .to.emit(treasury, "PendingGaugeFlushed")
        .withArgs(amount, 5n, FLUSH_DURATION);
      expect(await gauge.lastPoolId()).to.equal(5n);
      expect(await treasury.liquidityGaugePoolId()).to.equal(3n); // default intacto
    });

    it("reverts PendingGaugeRewardsInsufficient when amount > ledger", async function () {
      const { treasury, governance, distributor, admin, credit, gauge } =
        await loadFixture(deployFixture);
      const amount = 100n * ONE_CREDIT;
      await credit.connect(admin).mint(await treasury.getAddress(), amount, "fallback");
      await treasury.connect(distributor).depositPendingGaugeRewards(amount);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 1);

      await expect(
        treasury.connect(governance).flushPendingGaugeRewards(amount + 1n, 0n, FLUSH_DURATION),
      )
        .to.be.revertedWithCustomError(treasury, "PendingGaugeRewardsInsufficient")
        .withArgs(amount + 1n, amount);
    });

    it("rejects unauthorized callers", async function () {
      const { treasury, gauge, governance, other } = await loadFixture(deployFixture);
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 1);
      await expect(
        treasury.connect(other).flushPendingGaugeRewards(0n, 0n, FLUSH_DURATION),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });
  });
});
