import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * RewardDistributor test suite.
 *
 * Cobre as 21 invariantes descritas na spec da fase 4 parte 1 + coverage >= 95%:
 *   1.  finalizeRound happy path (apos closeRound).
 *   2.  finalize antes de closeRound -> RoundNotClosed.
 *   3.  finalize out-of-order -> OutOfOrderFinalize.
 *   4.  finalize duplo -> RoundAlreadyFinalized.
 *   5.  Formula emissao = min(max(alpha*burn, floor), cap) -> 3 cenarios.
 *   6.  alpha = 0.95 em round "limpo".
 *   7.  Claim happy path — peso proporcional ao stake.
 *   8.  Claim sem stake -> 0, sem mint.
 *   9.  Claim duplicate -> AlreadyClaimed.
 *  10.  Claim em round nao finalizado -> RoundNotFinalized.
 *  11.  claimMany -> retorna total correto.
 *  12.  claimMany length mismatch -> ArrayLengthMismatch.
 *  13.  claimMany empty -> EmptyBatch.
 *  14.  Probation penalty -> projeto recebe 25%, 75% queimado (nao redistribuido).
 *  15.  Split por burn -> 2 projetos com burn 70/30 -> share 70/30.
 *  16.  Bootstrap (totalBurnPrev == 0) -> split via global weight.
 *  17.  previewClaim espelha claim sem side effects.
 *  18.  setAlpha / setCapMax -> gating + bounds.
 *  19.  Reentrancy guard presente em claim / claimMany.
 *  20.  Emissao zero apos floor exaurido + sem burn.
 *  21.  Integracao end-to-end (stake -> burn -> closeRound -> finalize -> claim).
 */
describe("RewardDistributor", function () {
  const CREDIT_NAME = "Web3Community Credit";
  const CREDIT_SYMBOL = "CREDIT";
  const GOV_NAME = "Web3Community Governance";
  const GOV_SYMBOL = "GOV";

  const MIN_COLLATERAL = 10_000n * 10n ** 18n;
  const PROBATION_DURATION = 30n * 24n * 60n * 60n; // 30 dias
  const METADATA_URI = "ipfs://QmRewardDistributorTest";

  const ROUND_DURATION = 7n * 24n * 60n * 60n; // 7 dias
  const SANITY_CAP = 100_000_000n * 10n ** 18n; // grande o bastante para nao enforce em testes

  const MIN_LOCK = 14n * 24n * 60n * 60n;
  const MAX_LOCK = 365n * 24n * 60n * 60n;
  const PRECISION = 10n ** 18n;
  const MAX_MULT = 4n * PRECISION;

  const ALPHA = 95n * 10n ** 16n; // 0.95e18
  const CAP_MAX = 5_000_000n * 10n ** 18n; // 5M CREDIT
  const GENESIS_FLOOR_0 = 417_000n * 10n ** 18n; // ~10M / 24 no round 0

  // Schedule linear-ish decrescente para 24 rodadas (valor simples para teste).
  function buildFloorSchedule(): bigint[] {
    const n = 24;
    const out: bigint[] = [];
    for (let i = 0; i < n; i++) {
      // Decrescimento linear de GENESIS_FLOOR_0 até 0 em 24 rodadas.
      const v = (GENESIS_FLOOR_0 * BigInt(n - i)) / BigInt(n);
      out.push(v);
    }
    return out;
  }

  const FLOOR_SCHEDULE = buildFloorSchedule();

  const SEED_CREDIT = 1_000_000n * 10n ** 18n; // 1M CREDIT por staker
  const SEED_GOV = 1_000_000n * 10n ** 18n;

  const STAKE_AMOUNT = 1_000n * 10n ** 18n;

  async function deployFixture() {
    const [admin, governance, app1, app2, app3, alice, bob, carol, dave, projOwner, other] =
      await ethers.getSigners();

    // GOV, CREDIT, Registry, Staking, BurnTracker, RewardDistributor.
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

    // BurnTracker precisa de BURNER_ROLE no CREDIT.
    const BURNER_ROLE = await credit.BURNER_ROLE();
    await credit.connect(admin).grantRole(BURNER_ROLE, await tracker.getAddress());

    // Admin vira minter temporario para seed.
    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);

    // Seed CREDIT para stakers (pra fazer burns via tracker).
    for (const s of [alice, bob, carol, dave]) {
      await credit.connect(admin).mint(s.address, SEED_CREDIT, "seed");
    }

    // Seed GOV.
    for (const s of [alice, bob, carol, dave]) {
      await gov.connect(admin).mint(s.address, SEED_GOV, "seed");
    }
    await gov.connect(admin).mint(projOwner.address, MIN_COLLATERAL * 10n, "projOwner-seed");

    // Recorders para apps.
    await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);
    await tracker.connect(admin).grantRole(RECORDER_ROLE, app2.address);
    await tracker.connect(admin).grantRole(RECORDER_ROLE, app3.address);

    // Registra 3 projetos. Projeto 1,2 ativados; projeto 3 Pending por default.
    await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL * 10n);
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-1", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(1);

    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-2", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(2);

    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-3", MIN_COLLATERAL);
    // Fica Pending.

    // Staker approves no Staking.
    const stakingAddr = await staking.getAddress();
    for (const s of [alice, bob, carol, dave]) {
      await gov.connect(s).approve(stakingAddr, SEED_GOV);
    }

    // Deploy RewardDistributor.
    const RewardDistributor = await ethers.getContractFactory("RewardDistributor");
    const distributor = await RewardDistributor.deploy(
      admin.address,
      await credit.getAddress(),
      await staking.getAddress(),
      await tracker.getAddress(),
      await registry.getAddress(),
      ALPHA,
      CAP_MAX,
      FLOOR_SCHEDULE,
    );
    await distributor.waitForDeployment();

    // Concede MINTER_ROLE ao distributor.
    await credit.connect(admin).grantRole(MINTER_ROLE, await distributor.getAddress());

    // Concede GOVERNANCE_ROLE no distributor ao signer `governance` (por analogia).
    const DIST_GOV_ROLE = await distributor.GOVERNANCE_ROLE();
    await distributor.connect(admin).grantRole(DIST_GOV_ROLE, governance.address);

    return {
      gov,
      credit,
      registry,
      staking,
      tracker,
      distributor,
      admin,
      governance,
      app1,
      app2,
      app3,
      alice,
      bob,
      carol,
      dave,
      projOwner,
      other,
      REG_GOV_ROLE,
      BT_GOV_ROLE,
      RECORDER_ROLE,
      BURNER_ROLE,
      MINTER_ROLE,
      DIST_GOV_ROLE,
    };
  }

  // Helper: expected weight (JS mirror da logica do Staking).
  function mult(duration: bigint): bigint {
    if (duration < MIN_LOCK) throw new Error("duration < MIN_LOCK in helper");
    if (duration >= MAX_LOCK) return MAX_MULT;
    const delta = duration - MIN_LOCK;
    const slope = MAX_MULT - PRECISION;
    return PRECISION + (delta * slope) / (MAX_LOCK - MIN_LOCK);
  }
  function weight(amount: bigint, duration: bigint): bigint {
    return (amount * mult(duration)) / PRECISION;
  }

  // ------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------

  describe("construction", function () {
    it("sets immutables and initial state", async function () {
      const { distributor, credit, staking, tracker, registry } = await loadFixture(deployFixture);
      expect(await distributor.CREDIT()).to.equal(await credit.getAddress());
      expect(await distributor.STAKING()).to.equal(await staking.getAddress());
      expect(await distributor.BURN_TRACKER()).to.equal(await tracker.getAddress());
      expect(await distributor.REGISTRY()).to.equal(await registry.getAddress());
      expect(await distributor.alpha()).to.equal(ALPHA);
      expect(await distributor.capMax()).to.equal(CAP_MAX);
      expect(await distributor.lastFinalizedRound()).to.equal(0n);
      expect(await distributor.isFirstRoundFinalized()).to.equal(false);

      for (let i = 0; i < 24; i++) {
        expect(await distributor.floorSchedule(i)).to.equal(FLOOR_SCHEDULE[i]);
      }
    });

    it("reverts on zero admin", async function () {
      const { credit, staking, tracker, registry } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributor");
      await expect(
        F.deploy(
          ethers.ZeroAddress,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          ALPHA,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on zero credit", async function () {
      const { admin, staking, tracker, registry } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributor");
      await expect(
        F.deploy(
          admin.address,
          ethers.ZeroAddress,
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          ALPHA,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on zero staking", async function () {
      const { admin, credit, tracker, registry } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributor");
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          ethers.ZeroAddress,
          await tracker.getAddress(),
          await registry.getAddress(),
          ALPHA,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on zero burnTracker", async function () {
      const { admin, credit, staking, registry } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributor");
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          ethers.ZeroAddress,
          await registry.getAddress(),
          ALPHA,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on zero registry", async function () {
      const { admin, credit, staking, tracker } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributor");
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          ethers.ZeroAddress,
          ALPHA,
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("reverts on alpha out of bounds", async function () {
      const { admin, credit, staking, tracker, registry } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributor");
      // Muito baixo.
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          1n * 10n ** 17n, // 0.1e18 (<0.5e18)
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "InvalidAlpha");
      // Muito alto. MAX_ALPHA foi reduzido de 1.1e18 para 0.99e18 por
      // decisao economica (audit/economist/2026-04-22-consistency-audit.md
      // C2) — qualquer valor >= 1e18 agora reverte.
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          1n * 10n ** 18n, // 1.0e18 (>0.99e18)
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "InvalidAlpha");
      // Caso historicamente valido em [0.5, 1.1] mas agora acima de 0.99 —
      // deve reverter por MAX_ALPHA.
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          11n * 10n ** 17n, // 1.1e18
          CAP_MAX,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "InvalidAlpha");
    });

    it("reverts on capMax out of bounds", async function () {
      const { admin, credit, staking, tracker, registry } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("RewardDistributor");
      // Zero capMax.
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          ALPHA,
          0n,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "InvalidCapMax");
      // Capmax acima de 100M*1e18.
      await expect(
        F.deploy(
          admin.address,
          await credit.getAddress(),
          await staking.getAddress(),
          await tracker.getAddress(),
          await registry.getAddress(),
          ALPHA,
          200_000_000n * 10n ** 18n,
          FLOOR_SCHEDULE,
        ),
      ).to.be.revertedWithCustomError(F, "InvalidCapMax");
    });
  });

  // ------------------------------------------------------------------
  // finalizeRound — I1..I6
  // ------------------------------------------------------------------

  describe("finalizeRound", function () {
    it("reverts when round not closed yet (I2)", async function () {
      const { distributor } = await loadFixture(deployFixture);
      // currentRound = 0 no tracker. Tentar finalizar round 0 ainda aberto.
      await expect(distributor.finalizeRound(0))
        .to.be.revertedWithCustomError(distributor, "RoundNotClosed")
        .withArgs(0);
    });

    it("finalizes round 0 with floor only (bootstrap, no burn prev)", async function () {
      const { distributor, tracker, governance, alice, staking } = await loadFixture(deployFixture);

      // Alice faz stake em projeto 1 pra ter peso global no snapshot.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);

      // Fecha round 0 (permite finalizar).
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      // Finalize. Deve usar floor[0].
      const tx = await distributor.finalizeRound(0);
      const receipt = await tx.wait();
      const snapBlock = receipt!.blockNumber;

      const roundData = await distributor.roundData(0);
      expect(roundData.finalized).to.equal(true);
      expect(roundData.totalEmission).to.equal(FLOOR_SCHEDULE[0]);
      expect(roundData.totalBurnAtFinalize).to.equal(0n);
      expect(roundData.snapshotBlock).to.equal(BigInt(snapBlock));

      await expect(tx)
        .to.emit(distributor, "RoundFinalized")
        .withArgs(0, FLOOR_SCHEDULE[0], 0n, BigInt(snapBlock));

      expect(await distributor.lastFinalizedRound()).to.equal(0n);
      expect(await distributor.isFirstRoundFinalized()).to.equal(true);
    });

    it("reverts on out-of-order (skip) (I3)", async function () {
      const { distributor, tracker, governance } = await loadFixture(deployFixture);
      // closeRound 0.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      // closeRound 1.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      // Tentar finalizar round 1 sem ter finalizado round 0.
      await expect(distributor.finalizeRound(1))
        .to.be.revertedWithCustomError(distributor, "OutOfOrderFinalize")
        .withArgs(0, 1);
    });

    it("reverts on double finalize (I4)", async function () {
      const { distributor, tracker, governance } = await loadFixture(deployFixture);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);
      await expect(distributor.finalizeRound(0))
        .to.be.revertedWithCustomError(distributor, "RoundAlreadyFinalized")
        .withArgs(0);
    });

    it("formula: alpha*burn when > floor and < cap (I5, I6)", async function () {
      const { distributor, tracker, governance, app1, alice } = await loadFixture(deployFixture);

      // Round 0: seed burns de alice em projeto 1. Burn total = 1,000,000 * 1e18
      // (1M CREDIT). Isso deixa alpha*burn = 950,000 * 1e18 = 950k.
      // Floor[1] = floor(24-1 / 24 * 417k) = 23/24 * 417k ≈ 399,625.
      // capMax = 5M. Esperado emissao = alpha*burn = 950k.
      const burnAmt = 1_000_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnAmt);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound(); // round 0 -> 1
      await distributor.finalizeRound(0);

      // Round 1: sem burn, apenas finalizar.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound(); // round 1 -> 2

      const expected = (burnAmt * ALPHA) / PRECISION;
      const floor1 = FLOOR_SCHEDULE[1];
      expect(expected).to.be.gt(floor1); // precondicao do teste
      expect(expected).to.be.lt(CAP_MAX);

      const tx = await distributor.finalizeRound(1);
      const rd = await distributor.roundData(1);
      expect(rd.totalEmission).to.equal(expected);
      expect(rd.totalBurnAtFinalize).to.equal(burnAmt);
      await expect(tx)
        .to.emit(distributor, "RoundFinalized")
        .withArgs(1, expected, burnAmt, rd.snapshotBlock);
    });

    it("formula: floor when > alpha*burn (I5)", async function () {
      const { distributor, tracker, governance, app1, alice } = await loadFixture(deployFixture);

      // Round 0: burn pequeno (1k CREDIT). alpha*burn = 950 * 1e18, muito < floor[1].
      const burnAmt = 1_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnAmt);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      await distributor.finalizeRound(1);
      const rd = await distributor.roundData(1);
      expect(rd.totalEmission).to.equal(FLOOR_SCHEDULE[1]);
    });

    it("formula: cap when alpha*burn > capMax (I5)", async function () {
      // Cap=5M. Burn de 6M => alpha*burn = 5.7M > cap => emissao = cap.
      // Alice precisa de saldo extra (seed padrao e 1M).
      const { distributor, tracker, credit, admin, governance, app1, alice } =
        await loadFixture(deployFixture);
      await credit.connect(admin).mint(alice.address, 10_000_000n * 10n ** 18n, "big");

      const burnAmt = 6_000_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnAmt);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();

      const alphaBurn = (burnAmt * ALPHA) / PRECISION;
      expect(alphaBurn).to.be.gt(CAP_MAX);
      await distributor.finalizeRound(1);
      const rd = await distributor.roundData(1);
      expect(rd.totalEmission).to.equal(CAP_MAX);
    });
  });

  // ------------------------------------------------------------------
  // claim — I7..I15
  // ------------------------------------------------------------------

  describe("claim", function () {
    it("reverts when round not finalized (I10)", async function () {
      const { distributor, alice } = await loadFixture(deployFixture);
      await expect(distributor.connect(alice).claim(0, 1))
        .to.be.revertedWithCustomError(distributor, "RoundNotFinalized")
        .withArgs(0);
    });

    it("claim happy path with single staker in bootstrap round (I7, I16)", async function () {
      const { distributor, credit, staking, tracker, governance, alice } =
        await loadFixture(deployFixture);

      // Alice stake em projeto 1 com MAX_LOCK.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);

      // Fecha round 0 (sem burn).
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      // Projeto 1 estava em probation inicial por tempo (30d). Ainda esta em probation.
      // Share dele = 25% de floor[0], pois totalBurnPrev = 0, projeto 2 tb tem stake=0,
      // portanto projeto 1 tem 100% do global weight => 100% do pool.
      // Mas probation: 25% de floor[0].
      const floor0 = FLOOR_SCHEDULE[0];
      const expectedProjectShare = floor0 / 4n;

      const balBefore = await credit.balanceOf(alice.address);
      const tx = await distributor.connect(alice).claim(0, 1);
      const balAfter = await credit.balanceOf(alice.address);
      const claimed = balAfter - balBefore;
      expect(claimed).to.equal(expectedProjectShare);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, 0, 1, expectedProjectShare);
      expect(await distributor.claimed(0, 1, alice.address)).to.equal(true);
    });

    it("claim without stake returns 0 (I8)", async function () {
      const { distributor, credit, tracker, governance, alice, staking, bob } =
        await loadFixture(deployFixture);

      // Bob stake para o snapshot ter peso. Alice nao stake.
      await staking.connect(bob).stake(1, STAKE_AMOUNT, MIN_LOCK);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      const balBefore = await credit.balanceOf(alice.address);
      const tx = await distributor.connect(alice).claim(0, 1);
      const balAfter = await credit.balanceOf(alice.address);
      expect(balAfter).to.equal(balBefore);

      // Ainda marca como claimed? Nao — se amount==0, nao cunha e nao emite.
      // Design explicitly: claim nao muta estado quando amount=0.
      expect(await distributor.claimed(0, 1, alice.address)).to.equal(false);
      await expect(tx).to.not.emit(distributor, "Claimed");
    });

    it("duplicate claim reverts (I9)", async function () {
      const { distributor, staking, tracker, governance, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      await distributor.connect(alice).claim(0, 1);
      await expect(distributor.connect(alice).claim(0, 1))
        .to.be.revertedWithCustomError(distributor, "AlreadyClaimed")
        .withArgs(0, 1, alice.address);
    });

    it("split por burn: 70/30 entre 2 projetos (I15)", async function () {
      const {
        distributor,
        credit,
        staking,
        tracker,
        registry,
        governance,
        app1,
        app2,
        alice,
        bob,
      } = await loadFixture(deployFixture);

      // Sai da probation inicial para nao ter penalty. 30d >= probation.
      await time.increase(Number(PROBATION_DURATION) + 1);
      expect(await registry.isInProbation(1)).to.equal(false);
      expect(await registry.isInProbation(2)).to.equal(false);

      // Alice stake em projeto 1, Bob em projeto 2. Mesmo peso => 50/50 dentro
      // do projeto, mas split project-vs-project = 70/30 por burn.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await staking.connect(bob).stake(2, STAKE_AMOUNT, MAX_LOCK);

      // Burn round 0: projeto 1 = 70k, projeto 2 = 30k.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 70_000n * 10n ** 18n);
      await tracker.connect(app2).burnAndRecord(2, bob.address, 30_000n * 10n ** 18n);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      // Round 1: sem burn. Finaliza usando burn de round 0.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(1);

      const rd = await distributor.roundData(1);
      const totalEmission = rd.totalEmission;
      // Share esperado: projeto 1 = 70% do totalEmission; projeto 2 = 30%.
      const expectedP1 = (totalEmission * 70_000n * 10n ** 18n) / (100_000n * 10n ** 18n);
      const expectedP2 = (totalEmission * 30_000n * 10n ** 18n) / (100_000n * 10n ** 18n);

      // Como so tem 1 staker por projeto, cada um recebe 100% do share.
      // Sem probation (time travel), share completo.
      const bal1Before = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(1, 1);
      const bal1After = await credit.balanceOf(alice.address);
      expect(bal1After - bal1Before).to.equal(expectedP1);

      const bal2Before = await credit.balanceOf(bob.address);
      await distributor.connect(bob).claim(1, 2);
      const bal2After = await credit.balanceOf(bob.address);
      expect(bal2After - bal2Before).to.equal(expectedP2);
    });

    it("probation penalty: projeto probation recebe 25% (I14)", async function () {
      const {
        distributor,
        credit,
        staking,
        tracker,
        registry,
        governance,
        app1,
        app2,
        alice,
        bob,
      } = await loadFixture(deployFixture);

      // Projeto 1 em probation inicial (30d). Projeto 2 sai da probation: fazemos
      // time travel so depois dos burns pra variar — na verdade a checagem de
      // probation acontece no momento do claim. Precisamos projeto 1 probation
      // ativa; projeto 2 sem probation. Difícil porque ambos foram ativados
      // proximos. Estrategia: fazer tudo no mesmo round 0 — probation ativa
      // para ambos porque PROBATION_DURATION = 30d e ROUND_DURATION = 7d.
      // Usa burns iguais e verifica que ambos recebem 25%.

      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await staking.connect(bob).stake(2, STAKE_AMOUNT, MAX_LOCK);

      // Burns iguais.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 50_000n * 10n ** 18n);
      await tracker.connect(app2).burnAndRecord(2, bob.address, 50_000n * 10n ** 18n);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(1);

      // Ambos em probation ainda — cada um tem 50% do emission, reduzido a 25% =
      // 12.5% do total.
      const rd = await distributor.roundData(1);
      const totalEmission = rd.totalEmission;
      const rawShare = totalEmission / 2n;
      const expected = rawShare / 4n;

      expect(await registry.isInProbation(1)).to.equal(true);
      expect(await registry.isInProbation(2)).to.equal(true);

      const b1 = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(1, 1);
      const a1 = await credit.balanceOf(alice.address);
      expect(a1 - b1).to.equal(expected);

      const b2 = await credit.balanceOf(bob.address);
      await distributor.connect(bob).claim(1, 2);
      const a2 = await credit.balanceOf(bob.address);
      expect(a2 - b2).to.equal(expected);

      // Events emitted with wasProbation=true not available ate aqui — o flag e
      // emitido em ProjectEmissionSet (emitido no claim sob demanda).
    });

    it("bootstrap (totalBurnPrev==0) split via global weight (I16)", async function () {
      const { distributor, credit, staking, tracker, governance, alice, bob } =
        await loadFixture(deployFixture);

      // Stake: alice em projeto 1 com peso 1x, bob em projeto 2 com peso 4x.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MIN_LOCK); // 1x
      await staking.connect(bob).stake(2, STAKE_AMOUNT, MAX_LOCK); // 4x

      // Close round 0 sem burn.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      const tx = await distributor.finalizeRound(0);
      const snapBlock = (await tx.wait())!.blockNumber;

      // Projeto 1 weight = 1k*1e18, projeto 2 weight = 4k*1e18, global = 5k*1e18.
      const w1 = weight(STAKE_AMOUNT, MIN_LOCK);
      const w2 = weight(STAKE_AMOUNT, MAX_LOCK);
      const globalW = w1 + w2;
      expect(await staking.getGlobalWeightAt(snapBlock)).to.equal(globalW);

      const totalEmission = FLOOR_SCHEDULE[0];
      // share projeto1 = totalEmission * w1 / globalW; probation inicial ativa
      // => share * 0.25.
      const share1Raw = (totalEmission * w1) / globalW;
      const share2Raw = (totalEmission * w2) / globalW;
      const share1 = share1Raw / 4n;
      const share2 = share2Raw / 4n;

      const balBefore1 = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(0, 1);
      expect((await credit.balanceOf(alice.address)) - balBefore1).to.equal(share1);

      const balBefore2 = await credit.balanceOf(bob.address);
      await distributor.connect(bob).claim(0, 2);
      expect((await credit.balanceOf(bob.address)) - balBefore2).to.equal(share2);
    });

    it("previewClaim mirrors claim without side effects (I17)", async function () {
      const { distributor, credit, staking, tracker, governance, alice } =
        await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      const expected = await distributor.previewClaim(alice.address, 0, 1);
      expect(expected).to.be.gt(0n);

      const balBefore = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(0, 1);
      const balAfter = await credit.balanceOf(alice.address);
      expect(balAfter - balBefore).to.equal(expected);

      // Apos claim, preview returna 0.
      expect(await distributor.previewClaim(alice.address, 0, 1)).to.equal(0n);
    });

    it("previewClaim returns 0 for unfinalized round", async function () {
      const { distributor, alice } = await loadFixture(deployFixture);
      expect(await distributor.previewClaim(alice.address, 5, 1)).to.equal(0n);
    });

    it("claim on project with no stake at snapshot returns 0", async function () {
      const { distributor, credit, staking, tracker, governance, alice } =
        await loadFixture(deployFixture);
      // Alice stake em projeto 1. Mas tenta claimar em projeto 2.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      // Projeto 2 teve zero peso no snapshot => totalWeight=0, amount=0.
      const balBefore = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(0, 2);
      expect(await credit.balanceOf(alice.address)).to.equal(balBefore);
      expect(await distributor.claimed(0, 2, alice.address)).to.equal(false);
    });

    it("claim in bootstrap with totally empty state returns 0 (no global weight)", async function () {
      const { distributor, credit, tracker, governance, alice } = await loadFixture(deployFixture);
      // Ninguem staka nada. Finaliza mesmo assim.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);
      const balBefore = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(0, 1);
      expect(await credit.balanceOf(alice.address)).to.equal(balBefore);
    });

    it("claim on project without burn while other projects burned returns 0", async function () {
      // Cobre o ramo `burnPrev==0 && totalBurnPrev>0` em _projectShare.
      const { distributor, credit, staking, tracker, governance, app1, alice } =
        await loadFixture(deployFixture);

      // Alice stake em projeto 2 (sem burn). Burn e em projeto 1.
      await staking.connect(alice).stake(2, STAKE_AMOUNT, MAX_LOCK);
      await tracker.connect(app1).burnAndRecord(1, alice.address, 50_000n * 10n ** 18n);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(1);

      // Alice tenta claim em projeto 2 no round 1: totalBurnPrev=50k mas
      // burnPrev(projeto 2)=0 => share=0 => amount=0.
      const balBefore = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(1, 2);
      expect(await credit.balanceOf(alice.address)).to.equal(balBefore);
      expect(await distributor.claimed(1, 2, alice.address)).to.equal(false);
      expect(await distributor.getProjectEmission(1, 2)).to.equal(0n);
    });

    it("claim on round with zero emission (beyond floor) returns 0", async function () {
      // Cobre o ramo `totalEmission == 0` em _projectShare.
      const { distributor, credit, tracker, governance, alice, staking } =
        await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      // Fecha e finaliza 25 rounds sem burn.
      for (let r = 0; r < 25; r++) {
        await time.increase(Number(ROUND_DURATION));
        await tracker.connect(governance).closeRound();
        await distributor.finalizeRound(r);
      }
      // Round 24 tem totalEmission=0. claim -> 0, preview -> 0.
      expect(await distributor.getEmission(24)).to.equal(0n);
      expect(await distributor.previewClaim(alice.address, 24, 1)).to.equal(0n);
      const balBefore = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(24, 1);
      expect(await credit.balanceOf(alice.address)).to.equal(balBefore);
    });

    it("getEmission / getProjectEmission / isFinalized views", async function () {
      const { distributor, staking, tracker, governance, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      expect(await distributor.isFinalized(0)).to.equal(true);
      expect(await distributor.isFinalized(1)).to.equal(false);
      expect(await distributor.getEmission(0)).to.equal(FLOOR_SCHEDULE[0]);
      // Sem burn anterior, bootstrap. Projeto 1 tem 100% do global => share raw
      // = floor[0]. Probation => /4.
      const expected = FLOOR_SCHEDULE[0] / 4n;
      expect(await distributor.getProjectEmission(0, 1)).to.equal(expected);
      // getProjectEmission para round nao finalizado retorna 0.
      expect(await distributor.getProjectEmission(999, 1)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  // claimMany — I11..I13
  // ------------------------------------------------------------------

  describe("claimMany", function () {
    it("batches claims across rounds and projects (I11)", async function () {
      const { distributor, credit, staking, tracker, registry, governance, app1, app2, alice } =
        await loadFixture(deployFixture);

      await time.increase(Number(PROBATION_DURATION) + 1);
      expect(await registry.isInProbation(1)).to.equal(false);
      expect(await registry.isInProbation(2)).to.equal(false);

      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await staking.connect(alice).stake(2, STAKE_AMOUNT, MAX_LOCK);

      // Round 0: burn de alice em 1 e 2.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 40_000n * 10n ** 18n);
      await tracker.connect(app2).burnAndRecord(2, alice.address, 60_000n * 10n ** 18n);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(1);

      // Alice pode claim round 0 (bootstrap - 100% dela) e round 1 (split por burn).
      const balBefore = await credit.balanceOf(alice.address);
      const tx = await distributor.connect(alice).claimMany([0, 0, 1, 1], [1, 2, 1, 2]);
      await tx.wait();
      const balAfter = await credit.balanceOf(alice.address);
      expect(balAfter - balBefore).to.be.gt(0n);

      // Todos marcados.
      for (const [r, p] of [
        [0, 1],
        [0, 2],
        [1, 1],
        [1, 2],
      ]) {
        expect(await distributor.claimed(r, p, alice.address)).to.equal(true);
      }
    });

    it("reverts on array length mismatch (I12)", async function () {
      const { distributor, alice } = await loadFixture(deployFixture);
      await expect(distributor.connect(alice).claimMany([0, 1], [1])).to.be.revertedWithCustomError(
        distributor,
        "ArrayLengthMismatch",
      );
    });

    it("reverts on empty batch (I13)", async function () {
      const { distributor, alice } = await loadFixture(deployFixture);
      await expect(distributor.connect(alice).claimMany([], [])).to.be.revertedWithCustomError(
        distributor,
        "EmptyBatch",
      );
    });

    it("skips entries with amount=0 but continues batch", async function () {
      const { distributor, credit, staking, tracker, governance, alice } =
        await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      // [round 0, projeto 1] -> amount > 0; [round 0, projeto 2] -> amount == 0
      const balBefore = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claimMany([0, 0], [1, 2]);
      const balAfter = await credit.balanceOf(alice.address);
      expect(balAfter - balBefore).to.be.gt(0n);
      expect(await distributor.claimed(0, 1, alice.address)).to.equal(true);
      expect(await distributor.claimed(0, 2, alice.address)).to.equal(false);
    });

    it("reverts when one of the batch items is already claimed", async function () {
      const { distributor, staking, tracker, governance, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);
      await distributor.connect(alice).claim(0, 1);
      await expect(distributor.connect(alice).claimMany([0], [1])).to.be.revertedWithCustomError(
        distributor,
        "AlreadyClaimed",
      );
    });

    it("reverts when any batch item round not finalized", async function () {
      const { distributor, alice } = await loadFixture(deployFixture);
      await expect(distributor.connect(alice).claimMany([0], [1])).to.be.revertedWithCustomError(
        distributor,
        "RoundNotFinalized",
      );
    });
  });

  // ------------------------------------------------------------------
  // governance-tunable params — I18
  // ------------------------------------------------------------------

  describe("setAlpha / setCapMax (I18)", function () {
    it("setAlpha within bounds updates value and emits", async function () {
      const { distributor, governance } = await loadFixture(deployFixture);
      // Valor valido proximo do novo teto (0.99e18). Antes testavamos 1.0e18
      // (valido na faixa antiga [0.5, 1.1]); agora o teto e < 1 por
      // construcao (IE1 — ver audit/economist C2).
      const newAlpha = 99n * 10n ** 16n; // 0.99e18
      await expect(distributor.connect(governance).setAlpha(newAlpha))
        .to.emit(distributor, "AlphaUpdated")
        .withArgs(ALPHA, newAlpha);
      expect(await distributor.alpha()).to.equal(newAlpha);
    });

    it("setAlpha out of bounds reverts", async function () {
      const { distributor, governance } = await loadFixture(deployFixture);
      // Abaixo do piso (0.5e18).
      await expect(
        distributor.connect(governance).setAlpha(4n * 10n ** 17n),
      ).to.be.revertedWithCustomError(distributor, "InvalidAlpha");
      // Acima do novo teto (0.99e18) — 1.0e18 agora reverte.
      await expect(
        distributor.connect(governance).setAlpha(1n * 10n ** 18n),
      ).to.be.revertedWithCustomError(distributor, "InvalidAlpha");
      // Valor que antes era valido (1.1e18) agora reverte — documenta a
      // reducao de MAX_ALPHA como hardening da invariante IE1.
      await expect(
        distributor.connect(governance).setAlpha(11n * 10n ** 17n),
      ).to.be.revertedWithCustomError(distributor, "InvalidAlpha");
      // Muito acima, mantem o comportamento esperado.
      await expect(
        distributor.connect(governance).setAlpha(15n * 10n ** 17n),
      ).to.be.revertedWithCustomError(distributor, "InvalidAlpha");
    });

    it("setAlpha without role reverts", async function () {
      const { distributor, alice } = await loadFixture(deployFixture);
      await expect(
        distributor.connect(alice).setAlpha(9n * 10n ** 17n), // 0.9e18 (valor valido)
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("setCapMax within bounds updates value and emits", async function () {
      const { distributor, governance } = await loadFixture(deployFixture);
      const newCap = 10_000_000n * 10n ** 18n;
      await expect(distributor.connect(governance).setCapMax(newCap))
        .to.emit(distributor, "CapMaxUpdated")
        .withArgs(CAP_MAX, newCap);
      expect(await distributor.capMax()).to.equal(newCap);
    });

    it("setCapMax out of bounds reverts", async function () {
      const { distributor, governance } = await loadFixture(deployFixture);
      await expect(distributor.connect(governance).setCapMax(0n)).to.be.revertedWithCustomError(
        distributor,
        "InvalidCapMax",
      );
      await expect(
        distributor.connect(governance).setCapMax(200_000_000n * 10n ** 18n),
      ).to.be.revertedWithCustomError(distributor, "InvalidCapMax");
    });

    it("setCapMax without role reverts", async function () {
      const { distributor, alice } = await loadFixture(deployFixture);
      await expect(
        distributor.connect(alice).setCapMax(5_000_000n * 10n ** 18n),
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------------------------
  // previewEmission — auxiliary
  // ------------------------------------------------------------------

  describe("previewEmission", function () {
    it("returns floor for round 0 without prev burn", async function () {
      const { distributor } = await loadFixture(deployFixture);
      expect(await distributor.previewEmission(0)).to.equal(FLOOR_SCHEDULE[0]);
    });

    it("returns 0 beyond floor schedule when no prev burn", async function () {
      const { distributor } = await loadFixture(deployFixture);
      expect(await distributor.previewEmission(24)).to.equal(0n);
      expect(await distributor.previewEmission(100)).to.equal(0n);
    });

    it("returns finalized emission for a finalized round", async function () {
      const { distributor, tracker, governance } = await loadFixture(deployFixture);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);
      // Apos finalize, previewEmission(0) retorna o totalEmission gravado.
      const rd = await distributor.roundData(0);
      expect(await distributor.previewEmission(0)).to.equal(rd.totalEmission);
      expect(await distributor.previewEmission(0)).to.equal(FLOOR_SCHEDULE[0]);
    });

    it("returns alpha*burn when alpha*burn > floor and < cap", async function () {
      const { distributor, tracker, governance, app1, alice } = await loadFixture(deployFixture);
      const burnAmt = 1_000_000n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnAmt);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);
      // Round 1: preview antes de finalizar.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      const expected = (burnAmt * ALPHA) / PRECISION;
      expect(await distributor.previewEmission(1)).to.equal(expected);
    });

    it("clamps to capMax when alpha*burn exceeds cap (unfinalized round)", async function () {
      // Cobre o branch `rawEmission > capMax ? capMax : rawEmission` em
      // previewEmission para round NAO finalizado. Setup: reduzir capMax
      // para um valor bem abaixo do alpha*burn esperado, disparar burn na
      // rodada 0, fechar (sem finalize), e consultar previewEmission(1).
      const { distributor, tracker, governance, app1, alice } = await loadFixture(deployFixture);
      const smallCap = 100_000n * 10n ** 18n;
      await distributor.connect(governance).setCapMax(smallCap);

      const burnAmt = 1_000_000n * 10n ** 18n; // alpha*burn = 950_000e18 >> smallCap
      await tracker.connect(app1).burnAndRecord(1, alice.address, burnAmt);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      // NAO finaliza a rodada 0 para forcar o caminho nao-finalized de previewEmission(1).
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      expect(await distributor.previewEmission(1)).to.equal(smallCap);
    });
  });

  // ------------------------------------------------------------------
  // Reentrancy — I19
  // ------------------------------------------------------------------

  describe("reentrancy (I19)", function () {
    // CREDIT é nosso e seguro (burnByRole nao callback). Testamos simplesmente
    // que as funcoes state-changing tem o guard via storage slot de
    // ReentrancyGuard — aqui confirmamos que existe via erro custom esperado
    // quando o guard dispara. Tecnica: tornar o contrato chamar a si mesmo via
    // claimMany com rounds arrayados repetindo, mas o guard so protege contra
    // reentrancia externa. Se CREDIT.mint pudesse reentrar, o guard bloqueia.
    // Como CREDIT.mint nao tem callback, nao temos como forcar re-entrance
    // natural — o teste de presenca do guard e static (codigo contem modifier).
    // Teste funcional:
    it("claim guard fires as nonReentrant (no natural path triggers it)", async function () {
      const { distributor, staking, tracker, governance, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);
      // Simplesmente executa claim normalmente — se o guard interfere no
      // caminho feliz, quebra o teste; se nao, claim passa.
      await expect(distributor.connect(alice).claim(0, 1)).to.not.be.reverted;
    });

    // Os dois testes abaixo substituem o {CreditToken} por um mock
    // (`ReentrantCreditMock`) que implementa apenas a ABI de `mint` e,
    // durante o mint, tenta reentrar no distributor. O objetivo e cobrir
    // a branch de revert do modifier `nonReentrant` em {claim} e
    // {claimMany} (linhas 389 e 408) — que nao sao exercidas no caminho
    // feliz porque o CREDIT real nao possui hook.

    async function deployReentrantFixture() {
      const [admin, governance, alice, bob, projOwner, app1] = await ethers.getSigners();

      // Stack minima: GOV + Registry + Staking + BurnTracker (apontando
      // para um CREDIT real, para que o tracker funcione), distributor
      // com CREDIT mockado.
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
      await registry.connect(admin).grantRole(await registry.GOVERNANCE_ROLE(), governance.address);

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
      await tracker.connect(admin).grantRole(await tracker.GOVERNANCE_ROLE(), governance.address);

      // CREDIT mock no lugar do real.
      const Mock = await ethers.getContractFactory("ReentrantCreditMock");
      const evilCredit = await Mock.deploy();
      await evilCredit.waitForDeployment();

      const RewardDistributor = await ethers.getContractFactory("RewardDistributor");
      const distributor = await RewardDistributor.deploy(
        admin.address,
        await evilCredit.getAddress(),
        await staking.getAddress(),
        await tracker.getAddress(),
        await registry.getAddress(),
        ALPHA,
        CAP_MAX,
        FLOOR_SCHEDULE,
      );
      await distributor.waitForDeployment();

      // Setup minimo: 1 projeto ativo, alice com stake suficiente.
      await gov.connect(admin).mint(projOwner.address, MIN_COLLATERAL * 2n, "seed");
      await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL);
      await registry
        .connect(governance)
        .registerProject(projOwner.address, METADATA_URI, MIN_COLLATERAL);
      await registry.connect(governance).activateProject(1);
      await time.increase(Number(PROBATION_DURATION) + 1);

      await gov.connect(admin).mint(alice.address, SEED_GOV, "seed");
      await gov.connect(alice).approve(await staking.getAddress(), SEED_GOV);
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK);

      // Fecha e finaliza round 0 (usa floor[0], nao precisa de burn).
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);

      return { distributor, evilCredit, alice, bob, app1, governance };
    }

    it("blocks reentrant call into claim via hostile credit mint()", async function () {
      const { distributor, evilCredit, alice } = await loadFixture(deployReentrantFixture);

      // Durante CREDIT.mint, o mock chama distributor.claim(0, 1) de novo.
      const reentryData = distributor.interface.encodeFunctionData("claim", [0, 1]);
      await evilCredit.armCall(await distributor.getAddress(), reentryData);

      await expect(distributor.connect(alice).claim(0, 1)).to.be.revertedWithCustomError(
        distributor,
        "ReentrancyGuardReentrantCall",
      );
    });

    it("blocks reentrant call into claimMany via hostile credit mint()", async function () {
      const { distributor, evilCredit, alice } = await loadFixture(deployReentrantFixture);

      // Durante o mint do primeiro item do batch, o mock tenta chamar
      // claimMany de novo — guard compartilhado bloqueia.
      const reentryData = distributor.interface.encodeFunctionData("claimMany", [[0], [1]]);
      await evilCredit.armCall(await distributor.getAddress(), reentryData);

      await expect(distributor.connect(alice).claimMany([0], [1])).to.be.revertedWithCustomError(
        distributor,
        "ReentrancyGuardReentrantCall",
      );
    });
  });

  // ------------------------------------------------------------------
  // Floor exhausted — I20
  // ------------------------------------------------------------------

  describe("emission zero after floor exhausted (I20)", function () {
    it("round 24+ with no prev burn -> emission = 0", async function () {
      const { distributor, tracker, governance } = await loadFixture(deployFixture);
      // Fecha e finaliza 25 rounds sem burn.
      for (let r = 0; r < 25; r++) {
        await time.increase(Number(ROUND_DURATION));
        await tracker.connect(governance).closeRound();
        await distributor.finalizeRound(r);
      }
      const rd = await distributor.roundData(24);
      expect(rd.totalEmission).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  // End-to-end — I21
  // ------------------------------------------------------------------

  describe("end-to-end integration (I21)", function () {
    it("stake -> burn -> close -> finalize -> claim updates CREDIT balance", async function () {
      const { distributor, credit, staking, tracker, registry, governance, app1, alice, bob } =
        await loadFixture(deployFixture);

      // Passa probation de ambos.
      await time.increase(Number(PROBATION_DURATION) + 1);
      expect(await registry.isInProbation(1)).to.equal(false);

      // Alice + Bob em projeto 1, pesos diferentes.
      await staking.connect(alice).stake(1, STAKE_AMOUNT, MAX_LOCK); // 4x
      await staking.connect(bob).stake(1, STAKE_AMOUNT, MIN_LOCK); // 1x

      // Burn de alice e bob.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 10_000n * 10n ** 18n);
      await tracker.connect(app1).burnAndRecord(1, bob.address, 10_000n * 10n ** 18n);

      // Fecha round 0 e finaliza.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(0);
      // Fecha round 1.
      await time.increase(Number(ROUND_DURATION));
      await tracker.connect(governance).closeRound();
      await distributor.finalizeRound(1);

      // Alice e Bob reivindicam round 1 (burns do round 0 geraram emissao).
      const rd = await distributor.roundData(1);
      const totalEmission = rd.totalEmission;
      const projectShare = totalEmission; // 1 projeto so, 100% do burn.

      const w1 = weight(STAKE_AMOUNT, MAX_LOCK);
      const w2 = weight(STAKE_AMOUNT, MIN_LOCK);
      const expectedAlice = (projectShare * w1) / (w1 + w2);
      const expectedBob = (projectShare * w2) / (w1 + w2);

      const balAliceBefore = await credit.balanceOf(alice.address);
      await distributor.connect(alice).claim(1, 1);
      expect((await credit.balanceOf(alice.address)) - balAliceBefore).to.equal(expectedAlice);

      const balBobBefore = await credit.balanceOf(bob.address);
      await distributor.connect(bob).claim(1, 1);
      expect((await credit.balanceOf(bob.address)) - balBobBefore).to.equal(expectedBob);

      // Sum doesnt exceed emission (rounding could leave a wei).
      expect(expectedAlice + expectedBob).to.be.lte(totalEmission);
    });
  });
});
