import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * RewardDistributorV2 — Fase 1.4 (bucket-aware split) test suite.
 *
 * Cobertura (foco em Fase 1.4 — V1 ja tem suite paralela):
 *  1. Construction: bounds, defaults, immutables.
 *  2. setBucketBps: bounds individuais (E.8), soma == 10000, eventos.
 *  3. finalizeRound: split correto entre 4 buckets, IE12 (lossless), apps
 *     mint para ownerRecipient, LPs push gauge ou fallback Treasury,
 *     bonders push Treasury.
 *  4. claim: usa apenas bucket stakers (nao toda emissao); probation penalty
 *     aplicado.
 *  5. Edge: bootstrap (totalBurnPrev == 0) -> bucket apps redistribui para
 *     bonders; gauge paused -> fallback; multiplos projetos com burn ->
 *     mints granulares para apps; setters de governance.
 */
describe("RewardDistributorV2 (Fase 1.4 bucket split)", function () {
  const CREDIT_NAME = "Web3Community Credit";
  const CREDIT_SYMBOL = "CREDIT";
  const GOV_NAME = "Web3Community Governance";
  const GOV_SYMBOL = "GOV";

  const MIN_COLLATERAL = 10_000n * 10n ** 18n;
  const PROBATION_DURATION = 30n * 24n * 60n * 60n;
  const ROUND_DURATION = 7n * 24n * 60n * 60n;
  const SANITY_CAP = 100_000_000n * 10n ** 18n;

  const ALPHA = 95n * 10n ** 16n;
  const CAP_MAX = 5_000_000n * 10n ** 18n;
  const GENESIS_FLOOR_0 = 417_000n * 10n ** 18n;

  const MIN_LOCK = 14n * 24n * 60n * 60n;
  const MAX_LOCK = 365n * 24n * 60n * 60n;
  const PRECISION = 10n ** 18n;
  const MAX_MULT = 4n * PRECISION;

  const SEED_CREDIT = 1_000_000n * 10n ** 18n;
  const SEED_GOV = 1_000_000n * 10n ** 18n;
  const STAKE_AMOUNT = 1_000n * 10n ** 18n;

  const BPS = 10_000n;
  const DEFAULT_STAKERS_BPS = 5500n;
  const DEFAULT_LPS_BPS = 2500n;
  const DEFAULT_APPS_BPS = 1500n;
  const DEFAULT_BONDERS_BPS = 500n;

  function buildFloorSchedule(): bigint[] {
    const n = 24;
    const out: bigint[] = [];
    for (let i = 0; i < n; i++) {
      out.push((GENESIS_FLOOR_0 * BigInt(n - i)) / BigInt(n));
    }
    return out;
  }
  const FLOOR_SCHEDULE = buildFloorSchedule();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function deployFixture() {
    const [
      admin,
      governance,
      distributor,
      app1,
      app2,
      alice,
      bob,
      projOwner,
      recipient1,
      recipient2,
      other,
    ] = await ethers.getSigners();

    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy(GOV_NAME, GOV_SYMBOL, admin.address);
    await gov.waitForDeployment();

    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy(CREDIT_NAME, CREDIT_SYMBOL, admin.address);
    await credit.waitForDeployment();

    const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
    const registry = await ProjectRegistry.deploy(
      await gov.getAddress(),
      admin.address,
      MIN_COLLATERAL,
      PROBATION_DURATION,
    );
    await registry.waitForDeployment();
    const REG_GOV_ROLE = await registry.GOVERNANCE_ROLE();
    await registry.connect(admin).grantRole(REG_GOV_ROLE, governance.address);

    const Staking = await ethers.getContractFactory("Staking");
    const staking = await Staking.deploy(await gov.getAddress(), await registry.getAddress());
    await staking.waitForDeployment();

    const BurnTracker = await ethers.getContractFactory("BurnTracker");
    const tracker = await BurnTracker.deploy(
      admin.address,
      await credit.getAddress(),
      await registry.getAddress(),
      ROUND_DURATION,
      SANITY_CAP,
    );
    await tracker.waitForDeployment();
    const BT_GOV_ROLE = await tracker.GOVERNANCE_ROLE();
    const RECORDER_ROLE = await tracker.RECORDER_ROLE();
    await tracker.connect(admin).grantRole(BT_GOV_ROLE, governance.address);

    const BURNER_ROLE = await credit.BURNER_ROLE();
    await credit.connect(admin).grantRole(BURNER_ROLE, await tracker.getAddress());

    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);

    for (const s of [alice, bob]) {
      await credit.connect(admin).mint(s.address, SEED_CREDIT, "seed");
      await gov.connect(admin).mint(s.address, SEED_GOV, "seed");
    }
    await gov.connect(admin).mint(projOwner.address, MIN_COLLATERAL * 10n, "projOwner-seed");

    await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);
    await tracker.connect(admin).grantRole(RECORDER_ROLE, app2.address);

    // Registra 2 projetos.
    await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL * 10n);
    await registry
      .connect(governance)
      .registerProject(projOwner.address, "ipfs://p1", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(1);
    await registry
      .connect(governance)
      .registerProject(projOwner.address, "ipfs://p2", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(2);
    // Avança além da probation para nao penalizar shares por default.
    await time.increase(Number(PROBATION_DURATION) + 1);

    // Alice e Bob aprovam o staking.
    const stakingAddr = await staking.getAddress();
    for (const s of [alice, bob]) {
      await gov.connect(s).approve(stakingAddr, SEED_GOV);
    }

    // Treasury (Fase 1.4 — precisamos de roles para o V2).
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      admin.address,
      await credit.getAddress(),
      await usdc.getAddress(),
    );
    await treasury.waitForDeployment();
    const TREAS_GOV_ROLE = await treasury.GOVERNANCE_ROLE();
    const POL_REFILL_DEPOSITOR_ROLE = await treasury.POL_REFILL_DEPOSITOR_ROLE();
    const GAUGE_FALLBACK_DEPOSITOR_ROLE = await treasury.GAUGE_FALLBACK_DEPOSITOR_ROLE();
    await treasury.connect(admin).grantRole(TREAS_GOV_ROLE, governance.address);

    // Gauge mock.
    const GaugeMock = await ethers.getContractFactory("LiquidityGaugeRewardsMock");
    const gauge = await GaugeMock.deploy(await credit.getAddress());
    await gauge.waitForDeployment();

    // Deploy V2.
    const RewardDistributorV2 = await ethers.getContractFactory("RewardDistributorV2");
    const v2 = await RewardDistributorV2.deploy(
      admin.address,
      await credit.getAddress(),
      await staking.getAddress(),
      await tracker.getAddress(),
      await registry.getAddress(),
      await gauge.getAddress(),
      await treasury.getAddress(),
      ALPHA,
      CAP_MAX,
      FLOOR_SCHEDULE,
    );
    await v2.waitForDeployment();

    // Roles para o V2.
    await credit.connect(admin).grantRole(MINTER_ROLE, await v2.getAddress());
    await treasury.connect(admin).grantRole(POL_REFILL_DEPOSITOR_ROLE, await v2.getAddress());
    await treasury.connect(admin).grantRole(GAUGE_FALLBACK_DEPOSITOR_ROLE, await v2.getAddress());

    const V2_GOV_ROLE = await v2.GOVERNANCE_ROLE();
    await v2.connect(admin).grantRole(V2_GOV_ROLE, governance.address);

    return {
      gov,
      credit,
      registry,
      staking,
      tracker,
      treasury,
      gauge,
      v2,
      admin,
      governance,
      distributor,
      app1,
      app2,
      alice,
      bob,
      projOwner,
      recipient1,
      recipient2,
      other,
      MINTER_ROLE,
      V2_GOV_ROLE,
      POL_REFILL_DEPOSITOR_ROLE,
      GAUGE_FALLBACK_DEPOSITOR_ROLE,
      RECORDER_ROLE,
    };
  }

  // Helper kept available for future weight-validation tests; no current
  // call site, mas mantido para paridade com o suite V1.
  function _mult(duration: bigint): bigint {
    if (duration < MIN_LOCK) throw new Error("duration < MIN_LOCK");
    if (duration >= MAX_LOCK) return MAX_MULT;
    const delta = duration - MIN_LOCK;
    const slope = MAX_MULT - PRECISION;
    return PRECISION + (delta * slope) / (MAX_LOCK - MIN_LOCK);
  }
  void _mult;

  // ------------------------------------------------------------------
  // 1. Construction
  // ------------------------------------------------------------------

  describe("construction", function () {
    it("sets immutables and default bucketBps", async function () {
      const { v2, credit, staking, tracker, registry, gauge, treasury } =
        await loadFixture(deployFixture);
      expect(await v2.CREDIT()).to.equal(await credit.getAddress());
      expect(await v2.STAKING()).to.equal(await staking.getAddress());
      expect(await v2.BURN_TRACKER()).to.equal(await tracker.getAddress());
      expect(await v2.REGISTRY()).to.equal(await registry.getAddress());
      expect(await v2.GAUGE()).to.equal(await gauge.getAddress());
      expect(await v2.TREASURY()).to.equal(await treasury.getAddress());
      expect(await v2.alpha()).to.equal(ALPHA);
      expect(await v2.capMax()).to.equal(CAP_MAX);

      const bps = await v2.getBucketBps();
      expect(bps[0]).to.equal(DEFAULT_STAKERS_BPS);
      expect(bps[1]).to.equal(DEFAULT_LPS_BPS);
      expect(bps[2]).to.equal(DEFAULT_APPS_BPS);
      expect(bps[3]).to.equal(DEFAULT_BONDERS_BPS);

      expect(await v2.gaugePoolId()).to.equal(1n);
      expect(await v2.gaugeIncentiveDuration()).to.equal(7 * 24 * 60 * 60);
    });

    it("reverts on InvalidAlpha out of bounds", async function () {
      const { admin, credit, staking, tracker, registry, gauge, treasury } =
        await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributorV2");
      // alpha = 1.0e18 (> MAX_ALPHA 0.99e18)
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          await gauge.getAddress(),
          await treasury.getAddress(),
          10n ** 18n,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "InvalidAlpha");
    });

    it("reverts on InvalidCapMax out of bounds", async function () {
      const { admin, credit, staking, tracker, registry, gauge, treasury } =
        await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributorV2");
      // capMax = 0
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          await gauge.getAddress(),
          await treasury.getAddress(),
          ALPHA,
          0n,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "InvalidCapMax");
    });

    it("reverts on zero gauge or treasury", async function () {
      const { admin, credit, staking, tracker, registry } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributorV2");
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          ethers.ZeroAddress,
          admin.address,
          ALPHA,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          admin.address,
          ethers.ZeroAddress,
          ALPHA,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });

  // ------------------------------------------------------------------
  // 2. setBucketBps
  // ------------------------------------------------------------------

  describe("setBucketBps", function () {
    it("happy path: emits BucketBpsUpdated and persists", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      const newBps = [4000, 3000, 2000, 1000] as [number, number, number, number];
      await expect(v2.connect(governance).setBucketBps(newBps))
        .to.emit(v2, "BucketBpsUpdated")
        .withArgs(
          [DEFAULT_STAKERS_BPS, DEFAULT_LPS_BPS, DEFAULT_APPS_BPS, DEFAULT_BONDERS_BPS],
          newBps,
        );
      const bps = await v2.getBucketBps();
      expect(bps[0]).to.equal(4000n);
      expect(bps[1]).to.equal(3000n);
      expect(bps[2]).to.equal(2000n);
      expect(bps[3]).to.equal(1000n);
    });

    it("reverts BucketBpsSumInvalid when sum != 10000", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      await expect(
        v2.connect(governance).setBucketBps([3000, 3000, 2000, 1000]),
      ).to.be.revertedWithCustomError(v2, "BucketBpsSumInvalid");
    });

    it("reverts BucketBpsOutOfBounds when stakers < 30%", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      // stakers = 2999, lps = 4501, apps = 2500, bonders = 0 -> sum 10000
      await expect(v2.connect(governance).setBucketBps([2999, 4501, 2500, 0]))
        .to.be.revertedWithCustomError(v2, "BucketBpsOutOfBounds")
        .withArgs(0, 2999, 3000, 10000);
    });

    it("reverts BucketBpsOutOfBounds when LPs < 5%", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      // stakers 7000, lps 499, apps 2500, bonders 1 -> sum 10000
      await expect(v2.connect(governance).setBucketBps([7000, 499, 2500, 1]))
        .to.be.revertedWithCustomError(v2, "BucketBpsOutOfBounds")
        .withArgs(1, 499, 500, 10000);
    });

    it("reverts BucketBpsOutOfBounds when apps > 25% (IE4b)", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      // apps = 2501 -> deve falhar
      await expect(v2.connect(governance).setBucketBps([3000, 1499, 2501, 3000]))
        .to.be.revertedWithCustomError(v2, "BucketBpsOutOfBounds")
        .withArgs(2, 2501, 0, 2500);
    });

    it("reverts BucketBpsOutOfBounds when bonders > 20%", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      // bonders = 2001
      await expect(v2.connect(governance).setBucketBps([3000, 2999, 2000, 2001]))
        .to.be.revertedWithCustomError(v2, "BucketBpsOutOfBounds")
        .withArgs(3, 2001, 0, 2000);
    });

    it("rejects unauthorized caller", async function () {
      const { v2, other } = await loadFixture(deployFixture);
      await expect(
        v2.connect(other).setBucketBps([3000, 2500, 2500, 2000]),
      ).to.be.revertedWithCustomError(v2, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------------------------
  // 3. finalizeRound — split logic
  // ------------------------------------------------------------------

  describe("finalizeRound — split", function () {
    it("round 0 (bootstrap, no burn prev): apps redistributes to bonders", async function () {
      const { v2, tracker, governance, alice, staking, credit, treasury, gauge } =
        await loadFixture(deployFixture);

      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      const totalEmission = FLOOR_SCHEDULE[0];
      const expectedStakers = (totalEmission * DEFAULT_STAKERS_BPS) / BPS;
      const expectedLps = (totalEmission * DEFAULT_LPS_BPS) / BPS;
      // Apps redistribuido para bonders pelo bootstrap (totalBurnPrev == 0).
      const expectedBonders = totalEmission - expectedStakers - expectedLps;

      // Treasury balance pre-finalize.
      const treasuryBefore = await credit.balanceOf(await treasury.getAddress());

      const tx = await v2.finalizeRound(0);
      await expect(tx)
        .to.emit(v2, "RoundFinalizedV2")
        .withArgs(0, totalEmission, expectedStakers, expectedLps, 0n, expectedBonders);

      // Bucket apps NAO deveria emitir — appsAmount foi para bonders.
      expect(await v2.getBucketEmission(0, 2)).to.equal(0n);
      expect(await v2.getBucketEmission(0, 3)).to.equal(expectedBonders);

      // Treasury recebeu bonders bucket.
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(
        treasuryBefore + expectedBonders,
      );
      expect(await treasury.polRefillBucket()).to.equal(expectedBonders);

      // Gauge recebeu LPs (push direto, gauge nao paused).
      expect(await gauge.notifyCount()).to.equal(1n);
      expect(await gauge.lastNotifyAmount()).to.equal(expectedLps);
      expect(await gauge.lastPoolId()).to.equal(1n);
      expect(await credit.balanceOf(await gauge.getAddress())).to.equal(expectedLps);
    });

    it("round 1 with burn prev: 4 buckets distribute according to bps; apps mints to ownerRecipient", async function () {
      const {
        v2,
        tracker,
        governance,
        app1,
        app2,
        alice,
        staking,
        credit,
        treasury,
        gauge,
        projOwner,
      } = await loadFixture(deployFixture);

      // Round 0: alice stake p1, burns em p1 e p2, fechar.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      const burnP1 = 600_000n * 10n ** 18n;
      const burnP2 = 400_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnP1);
      await tracker.connect(app2).burnAndRecord(2, alice.address, burnP2);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);

      // Round 1: nada de burn novo, apenas fechar e finalizar. Burn prev = burnP1+burnP2.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      const totalBurnPrev = burnP1 + burnP2;
      const expectedRaw = (totalBurnPrev * ALPHA) / PRECISION; // 950_000e18
      const totalEmission = expectedRaw < CAP_MAX ? expectedRaw : CAP_MAX;
      const stakers = (totalEmission * DEFAULT_STAKERS_BPS) / BPS;
      const lps = (totalEmission * DEFAULT_LPS_BPS) / BPS;
      const apps = (totalEmission * DEFAULT_APPS_BPS) / BPS;
      const bonders = totalEmission - stakers - lps - apps;

      const apps_p1 = (apps * burnP1) / totalBurnPrev;
      const apps_p2 = (apps * burnP2) / totalBurnPrev;

      const treasuryBefore = await credit.balanceOf(await treasury.getAddress());
      const projOwnerBefore = await credit.balanceOf(projOwner.address);

      const tx = await v2.finalizeRound(1);
      await expect(tx)
        .to.emit(v2, "RoundFinalizedV2")
        .withArgs(1, totalEmission, stakers, lps, apps, bonders);
      // Apps mintou para ownerRecipient (= projOwner por fallback).
      // Total recebido = apps_p1 + apps_p2.
      expect(await credit.balanceOf(projOwner.address)).to.equal(
        projOwnerBefore + apps_p1 + apps_p2,
      );
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(
        treasuryBefore + bonders,
      );
      expect(await treasury.polRefillBucket()).to.be.gte(bonders);

      // Gauge recebeu lps no round 1 (count = 2: round 0 + round 1).
      expect(await gauge.notifyCount()).to.equal(2n);
      expect(await gauge.lastNotifyAmount()).to.equal(lps);
    });

    it("apps mint per ownerRecipient: distinct recipients receive proportional shares", async function () {
      const {
        v2,
        tracker,
        registry,
        governance,
        app1,
        app2,
        alice,
        staking,
        credit,
        projOwner,
        recipient1,
        recipient2,
        other,
      } = await loadFixture(deployFixture);

      // Set explicit recipients per project.
      await registry.connect(projOwner).proposeOwnerRecipient(1, recipient1.address);
      await registry.connect(projOwner).proposeOwnerRecipient(2, recipient2.address);
      await time.increase(48 * 60 * 60 + 1);
      await registry.connect(other).applyOwnerRecipient(1);
      await registry.connect(other).applyOwnerRecipient(2);

      // Round 0 burns, round 1 finalize.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      const burnP1 = 700_000n * 10n ** 18n;
      const burnP2 = 300_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnP1);
      await tracker.connect(app2).burnAndRecord(2, alice.address, burnP2);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      const totalBurnPrev = burnP1 + burnP2;
      const totalEmission = (totalBurnPrev * ALPHA) / PRECISION;
      const apps = (totalEmission * DEFAULT_APPS_BPS) / BPS;
      const apps_p1 = (apps * burnP1) / totalBurnPrev;
      const apps_p2 = (apps * burnP2) / totalBurnPrev;

      const r1Before = await credit.balanceOf(recipient1.address);
      const r2Before = await credit.balanceOf(recipient2.address);
      await v2.finalizeRound(1);
      expect(await credit.balanceOf(recipient1.address)).to.equal(r1Before + apps_p1);
      expect(await credit.balanceOf(recipient2.address)).to.equal(r2Before + apps_p2);
    });

    it("gauge paused: lps falls back to Treasury.pendingGaugeRewards", async function () {
      const { v2, tracker, governance, alice, staking, credit, treasury, gauge } =
        await loadFixture(deployFixture);

      await gauge.setPaused(true);

      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      const totalEmission = FLOOR_SCHEDULE[0];
      const lps = (totalEmission * DEFAULT_LPS_BPS) / BPS;

      const tx = await v2.finalizeRound(0);
      await expect(tx).to.emit(v2, "GaugePauseFallback").withArgs(0, lps);
      // Gauge nao foi notify.
      expect(await gauge.notifyCount()).to.equal(0n);
      // Treasury contabiliza no ledger.
      expect(await treasury.pendingGaugeRewards()).to.equal(lps);
      // CREDIT real foi mintado pro Treasury (alem do bonders).
      const treasuryBalance = await credit.balanceOf(await treasury.getAddress());
      expect(treasuryBalance).to.be.gte(lps);
    });

    it("IE12: sum of emitted buckets == totalEmission (within tolerance)", async function () {
      const { v2, tracker, governance, app1, alice, staking } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      // Burns para alimentar round 1. Valor "feio" para forcar residuo de divisao
      // inteira nos shares. Limite ao saldo de alice (SEED_CREDIT = 1M CREDIT).
      const burnAmt = 987_653n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnAmt);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      // Nao reverte (caso revertesse, o teste falharia aqui em EmissionMismatch).
      await v2.finalizeRound(1);

      // Confirma que soma dos buckets mintados bate.
      const rd = await v2.roundData(1);
      const stakers = await v2.getBucketEmission(1, 0);
      const lps = await v2.getBucketEmission(1, 1);
      const apps = await v2.getBucketEmission(1, 2);
      const bonders = await v2.getBucketEmission(1, 3);
      const sum = stakers + lps + apps + bonders;
      expect(sum).to.equal(rd.totalEmission);
    });

    it("reverts RoundNotClosed when round still open", async function () {
      const { v2 } = await loadFixture(deployFixture);
      await expect(v2.finalizeRound(0))
        .to.be.revertedWithCustomError(v2, "RoundNotClosed")
        .withArgs(0);
    });

    it("reverts OutOfOrderFinalize when skipping rounds", async function () {
      const { v2, tracker, governance } = await loadFixture(deployFixture);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await expect(v2.finalizeRound(1))
        .to.be.revertedWithCustomError(v2, "OutOfOrderFinalize")
        .withArgs(0, 1);
    });

    it("reverts RoundAlreadyFinalized on double finalize", async function () {
      const { v2, tracker, governance } = await loadFixture(deployFixture);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await expect(v2.finalizeRound(0))
        .to.be.revertedWithCustomError(v2, "RoundAlreadyFinalized")
        .withArgs(0);
    });
  });

  // ------------------------------------------------------------------
  // 4. claim — bucket stakers only
  // ------------------------------------------------------------------

  describe("claim", function () {
    it("happy path: stakers split is the base, not totalEmission", async function () {
      const { v2, tracker, governance, app1, alice, bob, staking, credit } =
        await loadFixture(deployFixture);

      // Alice e Bob stakam em projeto 1 (50/50 weight).
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await staking.connect(bob).stake(1, STAKE_AMOUNT, MAX_LOCK);
      // Burn em p1.
      const burnAmt = 1_000_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnAmt);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(1);

      // Round 1 emissao = alpha * burnAmt = 950,000e18.
      // Bucket stakers = 55% = 522,500e18.
      // 100% do burn em p1, entao projectShare = 522,500e18.
      // Alice e Bob 50/50 -> cada um recebe 261,250e18.
      const expectedTotalEmission = (burnAmt * ALPHA) / PRECISION;
      const expectedStakersBucket = (expectedTotalEmission * DEFAULT_STAKERS_BPS) / BPS;
      const expectedAlice = expectedStakersBucket / 2n;

      const aliceBefore = await credit.balanceOf(alice.address);
      await v2.connect(alice).claim(1, 1);
      expect(await credit.balanceOf(alice.address)).to.equal(aliceBefore + expectedAlice);

      // Verifica que getProjectStakerEmission usa bucket stakers, nao totalEmission.
      expect(await v2.getProjectStakerEmission(1, 1)).to.equal(expectedStakersBucket);
    });

    it("reverts AlreadyClaimed on duplicate claim", async function () {
      const { v2, tracker, governance, app1, alice, staking } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await tracker.connect(app1).burnAndRecord(1, alice.address, 100_000n * 10n ** 18n);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(1);

      await v2.connect(alice).claim(1, 1);
      await expect(v2.connect(alice).claim(1, 1))
        .to.be.revertedWithCustomError(v2, "AlreadyClaimed")
        .withArgs(1, 1, alice.address);
    });

    it("reverts RoundNotFinalized", async function () {
      const { v2, alice } = await loadFixture(deployFixture);
      await expect(v2.connect(alice).claim(0, 1))
        .to.be.revertedWithCustomError(v2, "RoundNotFinalized")
        .withArgs(0);
    });

    it("returns 0 silently when user has no stake (no mint)", async function () {
      const { v2, tracker, governance, alice, credit } = await loadFixture(deployFixture);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      const before = await credit.balanceOf(alice.address);
      // Alice nao tem stake.
      const tx = await v2.connect(alice).claim(0, 1);
      await tx.wait();
      expect(await credit.balanceOf(alice.address)).to.equal(before);
    });

    it("claimMany: array length mismatch reverts", async function () {
      const { v2, alice } = await loadFixture(deployFixture);
      await expect(v2.connect(alice).claimMany([0n], [1n, 2n])).to.be.revertedWithCustomError(
        v2,
        "ArrayLengthMismatch",
      );
    });

    it("claimMany: empty batch reverts", async function () {
      const { v2, alice } = await loadFixture(deployFixture);
      await expect(v2.connect(alice).claimMany([], [])).to.be.revertedWithCustomError(
        v2,
        "EmptyBatch",
      );
    });

    it("claimMany: happy path mints from multiple rounds in a single call", async function () {
      const { v2, tracker, governance, app1, alice, staking, credit } =
        await loadFixture(deployFixture);

      // Round 0: stake + burn em p1.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      const burn0 = 100_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burn0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);

      // Round 1: novo burn em p1.
      const burn1 = 200_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burn1);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(1);

      // Round 2 fechado para finalizar 2 (so para ter 2 rounds claimaveis).
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(2);

      // ClaimMany rounds [1, 2] / projects [1, 1].
      const before = await credit.balanceOf(alice.address);
      const tx = await v2.connect(alice).claimMany([1n, 2n], [1n, 1n]);
      await tx.wait();
      const after = await credit.balanceOf(alice.address);
      expect(after).to.be.gt(before);
    });
  });

  // ------------------------------------------------------------------
  // 5. previewClaim / previewEmission
  // ------------------------------------------------------------------

  describe("previews", function () {
    it("previewClaim returns 0 for non-finalized round", async function () {
      const { v2, alice } = await loadFixture(deployFixture);
      expect(await v2.previewClaim(alice.address, 0, 1)).to.equal(0n);
    });

    it("previewClaim mirrors claim amount", async function () {
      const { v2, tracker, governance, app1, alice, staking } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await tracker.connect(app1).burnAndRecord(1, alice.address, 100_000n * 10n ** 18n);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(1);

      const preview = await v2.previewClaim(alice.address, 1, 1);
      expect(preview).to.be.gt(0n);
      const tx = await v2.connect(alice).claim(1, 1);
      const receipt = await tx.wait();
      // O `Claimed` event tem amount.
      const event = receipt!.logs
        .map((l) => {
          try {
            return v2.interface.parseLog({ topics: l.topics as string[], data: l.data });
          } catch {
            return null;
          }
        })
        .filter((l) => l && l.name === "Claimed")[0];
      expect(event!.args.amount).to.equal(preview);
    });

    it("previewEmission returns roundData totalEmission for finalized round", async function () {
      const { v2, tracker, governance } = await loadFixture(deployFixture);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      const rd = await v2.roundData(0);
      expect(await v2.previewEmission(0)).to.equal(rd.totalEmission);
    });

    it("getEmission and isFinalized track finalize state", async function () {
      const { v2, tracker, governance } = await loadFixture(deployFixture);
      expect(await v2.isFinalized(0)).to.equal(false);
      expect(await v2.getEmission(0)).to.equal(0n);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      expect(await v2.isFinalized(0)).to.equal(true);
      expect(await v2.getEmission(0)).to.equal(FLOOR_SCHEDULE[0]);
    });

    it("getProjectStakerEmission returns 0 for not-finalized round", async function () {
      const { v2 } = await loadFixture(deployFixture);
      expect(await v2.getProjectStakerEmission(0, 1)).to.equal(0n);
    });

    it("previewClaim returns 0 after claim (already claimed)", async function () {
      const { v2, tracker, governance, app1, alice, staking } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await tracker.connect(app1).burnAndRecord(1, alice.address, 100_000n * 10n ** 18n);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(1);
      await v2.connect(alice).claim(1, 1);
      // Apos claim, previewClaim retorna 0.
      expect(await v2.previewClaim(alice.address, 1, 1)).to.equal(0n);
    });

    it("previewEmission for not-yet-finalized round uses formula", async function () {
      const { v2, tracker, governance, app1, alice, staking } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      // Burn alto o suficiente para alpha*burn dominar o floor[1].
      // floor[1] = 23/24 * 417k ≈ 399_625e18; alpha*burn = 0.95 * burn.
      // burn = 600k -> alpha*burn = 570k, > floor.
      const burn = 600_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burn);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      // Round 1 ainda nao finalizado.
      const preview = await v2.previewEmission(1);
      const alphaBurn = (burn * ALPHA) / PRECISION;
      const floor1 = FLOOR_SCHEDULE[1];
      const expected = alphaBurn > floor1 ? alphaBurn : floor1;
      expect(preview).to.equal(expected);
    });
  });

  // ------------------------------------------------------------------
  // 6. Setters: alpha, capMax, gaugePoolId, gaugeIncentiveDuration
  // ------------------------------------------------------------------

  describe("governance setters", function () {
    it("setAlpha works and emits", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      await expect(v2.connect(governance).setAlpha(8n * 10n ** 17n))
        .to.emit(v2, "AlphaUpdated")
        .withArgs(ALPHA, 8n * 10n ** 17n);
    });

    it("setAlpha rejects out of bounds", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      await expect(v2.connect(governance).setAlpha(1n * 10n ** 18n)).to.be.revertedWithCustomError(
        v2,
        "InvalidAlpha",
      );
    });

    it("setCapMax works and emits", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      const newCap = 10_000_000n * 10n ** 18n;
      await expect(v2.connect(governance).setCapMax(newCap))
        .to.emit(v2, "CapMaxUpdated")
        .withArgs(CAP_MAX, newCap);
    });

    it("setCapMax rejects out of bounds", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      await expect(v2.connect(governance).setCapMax(0n)).to.be.revertedWithCustomError(
        v2,
        "InvalidCapMax",
      );
    });

    it("setGaugePoolId works", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      await expect(v2.connect(governance).setGaugePoolId(7))
        .to.emit(v2, "GaugePoolIdUpdated")
        .withArgs(1n, 7n);
    });

    it("setGaugeIncentiveDuration enforces bounds", async function () {
      const { v2, governance } = await loadFixture(deployFixture);
      await expect(
        v2.connect(governance).setGaugeIncentiveDuration(60),
      ).to.be.revertedWithCustomError(v2, "InvalidGaugeIncentiveDuration");
      await expect(v2.connect(governance).setGaugeIncentiveDuration(2 * 24 * 60 * 60))
        .to.emit(v2, "GaugeIncentiveDurationUpdated")
        .withArgs(7 * 24 * 60 * 60, 2 * 24 * 60 * 60);
    });
  });

  // ------------------------------------------------------------------
  // 7. Probation penalty no bucket stakers
  // ------------------------------------------------------------------

  describe("probation penalty in stakers bucket", function () {
    it("project in probation: stakers receive 25% of share (penalty / 4)", async function () {
      const {
        v2,
        tracker,
        registry,
        governance,
        app1,
        alice,
        staking,
        gov,
        credit,
        projOwner,
        admin,
      } = await loadFixture(deployFixture);

      // Registra projeto novo SEM passar probation.
      await gov.connect(admin).mint(projOwner.address, MIN_COLLATERAL, "extra");
      await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL);
      await registry
        .connect(governance)
        .registerProject(projOwner.address, "ipfs://p3", MIN_COLLATERAL);
      await registry.connect(governance).activateProject(3);

      // Concede recorder pra app1 ja tem; usa pra burn em p3.
      await staking.connect(alice).stake(3, STAKE_AMOUNT, MAX_LOCK);
      const burn = 1_000_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(3, alice.address, burn);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(0);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await v2.finalizeRound(1);

      // Nao avançou alem do probationDuration (~30d). Probation ainda ativa.
      expect(await registry.isInProbation(3)).to.be.true;

      const expectedTotalEmission = (burn * ALPHA) / PRECISION;
      const expectedStakersBucket = (expectedTotalEmission * DEFAULT_STAKERS_BPS) / BPS;
      // Probation: stakersBucket / 4 distribuido para alice (so ela em p3).
      const expectedAlice = expectedStakersBucket / 4n;
      const before = await credit.balanceOf(alice.address);
      await v2.connect(alice).claim(1, 3);
      expect(await credit.balanceOf(alice.address)).to.equal(before + expectedAlice);
    });
  });
});
