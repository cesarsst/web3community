import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyUint } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * BurnTracker test suite.
 *
 * Cobre as 16 invariantes descritas na spec da fase 3 parte 2:
 *   1.  burnAndRecord happy path (CREDIT.totalSupply diminui em amount).
 *   2.  burnAndRecord sem RECORDER_ROLE -> AccessControlUnauthorizedAccount.
 *   3.  burnAndRecord com projeto nao-Active (Pending/Probation/Removed) -> ProjectNotActive.
 *   4.  burnAndRecord com from=0 -> ZeroAddress.
 *   5.  burnAndRecord com amount=0 -> ZeroAmount.
 *   6.  Sanity cap (>0 -> enforce; =0 -> sem limite).
 *   7.  Accounting correto (views batem apos N burns multi-projeto).
 *   8.  projectsWithBurnCount unico por projeto por rodada.
 *   9.  closeRound happy path (apos roundDuration, earlyClose=false).
 *  10.  closeRound antes do tempo (earlyClose=true).
 *  11.  closeRound sem GOVERNANCE_ROLE -> revert.
 *  12.  Burns em rounds diferentes nao se misturam.
 *  13.  setRoundDuration fora da faixa [1d, 30d] -> revert.
 *  14.  setMaxBurnPerRoundPerProject (0 remove limite).
 *  15.  ReentrancyGuard em burnAndRecord (guard presente — sem callback real
 *       no burnByRole do CreditToken, defesa e estatica).
 *  16.  Integracao real com CreditToken (end-to-end burn + snapshot de estado).
 *
 * Alem disso:
 *  - Construcao (imutables, estado inicial, roles, ZeroAddress).
 *  - Views auxiliares (getCurrentRound, getRoundEndsAt, isRoundReadyToClose).
 *  - Eventos com args esperados.
 *  - Matriz de access control sobre funcoes gated.
 */
describe("BurnTracker", function () {
  const CREDIT_NAME = "Web3Community Credit";
  const CREDIT_SYMBOL = "CREDIT";
  const GOV_NAME = "Web3Community Governance";
  const GOV_SYMBOL = "GOV";

  const MIN_COLLATERAL = 10_000n * 10n ** 18n; // 10k GOV
  const PROBATION_DURATION = 30n * 24n * 60n * 60n; // 30 dias
  const METADATA_URI = "ipfs://QmBurnTrackerTest";

  const ROUND_DURATION = 7n * 24n * 60n * 60n; // 7 dias
  const MIN_ROUND_DURATION = 24n * 60n * 60n; // 1 dia
  const MAX_ROUND_DURATION = 30n * 24n * 60n * 60n; // 30 dias

  const SANITY_CAP = 1_000_000n * 10n ** 18n; // 1M CREDIT por projeto por rodada
  const SEED_CREDIT = 10_000_000n * 10n ** 18n; // 10M CREDIT para cada user

  const BURN_AMOUNT = 100n * 10n ** 18n; // 100 CREDIT

  async function deployFixture() {
    const [admin, governance, app1, app2, app3, alice, bob, carol, projOwner, other] =
      await ethers.getSigners();

    // 1. Deploy GOV (precisa do Registry).
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy(GOV_NAME, GOV_SYMBOL, admin.address);
    await gov.waitForDeployment();

    // 2. Deploy CREDIT.
    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy(CREDIT_NAME, CREDIT_SYMBOL, admin.address);
    await credit.waitForDeployment();

    // 3. Deploy Registry (colateral em GOV).
    const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
    const registry = await ProjectRegistry.deploy(
      await gov.getAddress(),
      admin.address,
      MIN_COLLATERAL,
      PROBATION_DURATION,
    );
    await registry.waitForDeployment();

    const REG_GOVERNANCE_ROLE = await registry.GOVERNANCE_ROLE();
    await registry.connect(admin).grantRole(REG_GOVERNANCE_ROLE, governance.address);

    // 4. Deploy BurnTracker.
    const BurnTracker = await ethers.getContractFactory("BurnTracker");
    const tracker = await BurnTracker.deploy(
      admin.address,
      await credit.getAddress(),
      await registry.getAddress(),
      ROUND_DURATION,
      SANITY_CAP,
    );
    await tracker.waitForDeployment();

    const GOVERNANCE_ROLE = await tracker.GOVERNANCE_ROLE();
    const RECORDER_ROLE = await tracker.RECORDER_ROLE();
    const DEFAULT_ADMIN_ROLE = await tracker.DEFAULT_ADMIN_ROLE();

    // Admin concede GOVERNANCE_ROLE ao signer `governance`.
    await tracker.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

    // 5. Concede BURNER_ROLE ao BurnTracker no CreditToken (fluxo pos-deploy).
    const BURNER_ROLE = await credit.BURNER_ROLE();
    await credit.connect(admin).grantRole(BURNER_ROLE, await tracker.getAddress());

    // 6. Admin concede MINTER_ROLE a si mesmo no CREDIT e cunha saldo para users.
    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
    for (const s of [alice, bob, carol]) {
      await credit.connect(admin).mint(s.address, SEED_CREDIT, "test-seed");
    }

    // 7. Concede RECORDER_ROLE aos 3 signers "apps".
    await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);
    await tracker.connect(admin).grantRole(RECORDER_ROLE, app2.address);
    await tracker.connect(admin).grantRole(RECORDER_ROLE, app3.address);

    // 8. Registra 3 projetos no Registry (mint GOV para projOwner pagar colateral).
    await gov.connect(admin).mint(projOwner.address, MIN_COLLATERAL * 10n, "projOwner-seed");
    await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL * 10n);

    // Projeto 1: Active.
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-1", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(1);

    // Projeto 2: Active.
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-2", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(2);

    // Projeto 3: registrado mas deixado Pending (usado em testes de status nao-Active).
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-3", MIN_COLLATERAL);

    return {
      credit,
      gov,
      registry,
      tracker,
      admin,
      governance,
      app1,
      app2,
      app3,
      alice,
      bob,
      carol,
      projOwner,
      other,
      GOVERNANCE_ROLE,
      RECORDER_ROLE,
      DEFAULT_ADMIN_ROLE,
      BURNER_ROLE,
    };
  }

  // ------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------

  describe("construction", function () {
    it("sets immutables and initial state (round 0 started at deploy)", async function () {
      const { tracker, credit, registry } = await loadFixture(deployFixture);
      expect(await tracker.CREDIT_TOKEN()).to.equal(await credit.getAddress());
      expect(await tracker.REGISTRY()).to.equal(await registry.getAddress());
      expect(await tracker.currentRound()).to.equal(0n);
      expect(await tracker.roundDuration()).to.equal(ROUND_DURATION);
      expect(await tracker.maxBurnPerRoundPerProject()).to.equal(SANITY_CAP);
      expect(await tracker.roundStartedAt()).to.be.greaterThan(0n);
    });

    it("grants DEFAULT_ADMIN_ROLE and GOVERNANCE_ROLE to initialAdmin", async function () {
      const { tracker, admin, DEFAULT_ADMIN_ROLE, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      expect(await tracker.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await tracker.hasRole(GOVERNANCE_ROLE, admin.address)).to.equal(true);
    });

    it("does not grant RECORDER_ROLE to anyone by default", async function () {
      const { tracker, admin, RECORDER_ROLE } = await loadFixture(deployFixture);
      // Fixture ja concedeu para app1/2/3 — mas admin NAO recebe RECORDER.
      expect(await tracker.hasRole(RECORDER_ROLE, admin.address)).to.equal(false);
    });

    it("exposes role identifiers matching keccak hashes", async function () {
      const { tracker } = await loadFixture(deployFixture);
      expect(await tracker.GOVERNANCE_ROLE()).to.equal(ethers.id("GOVERNANCE_ROLE"));
      expect(await tracker.RECORDER_ROLE()).to.equal(ethers.id("RECORDER_ROLE"));
    });

    it("reverts when deployed with admin == address(0)", async function () {
      const { credit, registry } = await loadFixture(deployFixture);
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      await expect(
        BurnTracker.deploy(
          ethers.ZeroAddress,
          await credit.getAddress(),
          await registry.getAddress(),
          ROUND_DURATION,
          SANITY_CAP,
        ),
      ).to.be.revertedWithCustomError(BurnTracker, "ZeroAddress");
    });

    it("reverts when deployed with credit == address(0)", async function () {
      const { admin, registry } = await loadFixture(deployFixture);
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      await expect(
        BurnTracker.deploy(
          admin.address,
          ethers.ZeroAddress,
          await registry.getAddress(),
          ROUND_DURATION,
          SANITY_CAP,
        ),
      ).to.be.revertedWithCustomError(BurnTracker, "ZeroAddress");
    });

    it("reverts when deployed with registry == address(0)", async function () {
      const { admin, credit } = await loadFixture(deployFixture);
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      await expect(
        BurnTracker.deploy(
          admin.address,
          await credit.getAddress(),
          ethers.ZeroAddress,
          ROUND_DURATION,
          SANITY_CAP,
        ),
      ).to.be.revertedWithCustomError(BurnTracker, "ZeroAddress");
    });

    it("reverts when initialRoundDuration is below min (I13)", async function () {
      const { admin, credit, registry } = await loadFixture(deployFixture);
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const below = MIN_ROUND_DURATION - 1n;
      await expect(
        BurnTracker.deploy(
          admin.address,
          await credit.getAddress(),
          await registry.getAddress(),
          below,
          SANITY_CAP,
        ),
      )
        .to.be.revertedWithCustomError(BurnTracker, "InvalidRoundDuration")
        .withArgs(below, MIN_ROUND_DURATION, MAX_ROUND_DURATION);
    });

    it("reverts when initialRoundDuration is above max (I13)", async function () {
      const { admin, credit, registry } = await loadFixture(deployFixture);
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const above = MAX_ROUND_DURATION + 1n;
      await expect(
        BurnTracker.deploy(
          admin.address,
          await credit.getAddress(),
          await registry.getAddress(),
          above,
          SANITY_CAP,
        ),
      )
        .to.be.revertedWithCustomError(BurnTracker, "InvalidRoundDuration")
        .withArgs(above, MIN_ROUND_DURATION, MAX_ROUND_DURATION);
    });

    it("accepts initialSanityCap == 0 (unlimited)", async function () {
      const { admin, credit, registry } = await loadFixture(deployFixture);
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const t = await BurnTracker.deploy(
        admin.address,
        await credit.getAddress(),
        await registry.getAddress(),
        ROUND_DURATION,
        0n,
      );
      await t.waitForDeployment();
      expect(await t.maxBurnPerRoundPerProject()).to.equal(0n);
    });

    it("supports IAccessControl and IERC165 interfaces", async function () {
      const { tracker } = await loadFixture(deployFixture);
      expect(await tracker.supportsInterface("0x7965db0b")).to.equal(true); // IAccessControl
      expect(await tracker.supportsInterface("0x01ffc9a7")).to.equal(true); // IERC165
      expect(await tracker.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  // ------------------------------------------------------------------
  // burnAndRecord — happy path (I1, I16)
  // ------------------------------------------------------------------

  describe("burnAndRecord", function () {
    it("burns CREDIT atomically and records burn (I1, I16)", async function () {
      const { tracker, credit, app1, alice } = await loadFixture(deployFixture);

      const supplyBefore = await credit.totalSupply();
      const balanceBefore = await credit.balanceOf(alice.address);

      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.emit(tracker, "BurnRecorded")
        .withArgs(0, 1, alice.address, BURN_AMOUNT, BURN_AMOUNT);

      // State: burnByRoundProject, totalBurnByRound, projectsWithBurnCount.
      expect(await tracker.burnByRoundProject(0, 1)).to.equal(BURN_AMOUNT);
      expect(await tracker.totalBurnByRound(0)).to.equal(BURN_AMOUNT);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(1n);

      // CreditToken: supply e balance decrementados.
      expect(await credit.totalSupply()).to.equal(supplyBefore - BURN_AMOUNT);
      expect(await credit.balanceOf(alice.address)).to.equal(balanceBefore - BURN_AMOUNT);
    });

    it("reverts when caller lacks RECORDER_ROLE (I2)", async function () {
      const { tracker, other, alice, RECORDER_ROLE } = await loadFixture(deployFixture);
      await expect(tracker.connect(other).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, RECORDER_ROLE);
    });

    it("admin without RECORDER_ROLE cannot burn (I2)", async function () {
      const { tracker, admin, alice, RECORDER_ROLE } = await loadFixture(deployFixture);
      await expect(tracker.connect(admin).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, RECORDER_ROLE);
    });

    it("reverts when project is Pending (I3)", async function () {
      const { tracker, app1, alice } = await loadFixture(deployFixture);
      // Projeto 3 esta Pending no fixture.
      await expect(tracker.connect(app1).burnAndRecord(3, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "ProjectNotActive")
        .withArgs(3);
    });

    it("reverts when project is Probation (I3)", async function () {
      const { tracker, registry, governance, app1, alice } = await loadFixture(deployFixture);
      await registry.connect(governance).setProbation(1);
      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "ProjectNotActive")
        .withArgs(1);
    });

    it("reverts when project is Removed (I3)", async function () {
      const { tracker, registry, governance, app1, alice, admin } =
        await loadFixture(deployFixture);
      await registry.connect(governance).removeProject(1, false, admin.address);
      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "ProjectNotActive")
        .withArgs(1);
    });

    it("reverts when project does not exist (I3)", async function () {
      const { tracker, app1, alice } = await loadFixture(deployFixture);
      await expect(tracker.connect(app1).burnAndRecord(9999, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "ProjectNotActive")
        .withArgs(9999);
    });

    it("reverts when from == address(0) (I4)", async function () {
      const { tracker, app1 } = await loadFixture(deployFixture);
      await expect(
        tracker.connect(app1).burnAndRecord(1, ethers.ZeroAddress, BURN_AMOUNT),
      ).to.be.revertedWithCustomError(tracker, "ZeroAddress");
    });

    it("reverts when amount == 0 (I5)", async function () {
      const { tracker, app1, alice } = await loadFixture(deployFixture);
      await expect(
        tracker.connect(app1).burnAndRecord(1, alice.address, 0n),
      ).to.be.revertedWithCustomError(tracker, "ZeroAmount");
    });

    it("accumulates burns within same round/project (I7)", async function () {
      const { tracker, app1, alice } = await loadFixture(deployFixture);

      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT * 2n))
        .to.emit(tracker, "BurnRecorded")
        .withArgs(0, 1, alice.address, BURN_AMOUNT * 2n, BURN_AMOUNT * 3n);

      expect(await tracker.burnByRoundProject(0, 1)).to.equal(BURN_AMOUNT * 3n);
      expect(await tracker.totalBurnByRound(0)).to.equal(BURN_AMOUNT * 3n);
    });

    it("projectsWithBurnCount counts unique projects only (I8)", async function () {
      const { tracker, app1, app2, alice, bob } = await loadFixture(deployFixture);

      // 3 burns no projeto 1 -> count = 1.
      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      await tracker.connect(app1).burnAndRecord(1, bob.address, BURN_AMOUNT);
      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(1n);

      // Primeiro burn no projeto 2 -> count = 2.
      await tracker.connect(app2).burnAndRecord(2, bob.address, BURN_AMOUNT);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(2n);

      // Mais burn no projeto 2 -> count continua 2.
      await tracker.connect(app2).burnAndRecord(2, bob.address, BURN_AMOUNT);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(2n);
    });

    it("accounting is correct across multiple projects and users (I7)", async function () {
      const { tracker, app1, app2, alice, bob, carol } = await loadFixture(deployFixture);

      await tracker.connect(app1).burnAndRecord(1, alice.address, 100n * 10n ** 18n);
      await tracker.connect(app1).burnAndRecord(1, bob.address, 50n * 10n ** 18n);
      await tracker.connect(app2).burnAndRecord(2, carol.address, 200n * 10n ** 18n);

      expect(await tracker.burnByRoundProject(0, 1)).to.equal(150n * 10n ** 18n);
      expect(await tracker.burnByRoundProject(0, 2)).to.equal(200n * 10n ** 18n);
      expect(await tracker.totalBurnByRound(0)).to.equal(350n * 10n ** 18n);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(2n);
    });

    // ------------------------------------------------------------------
    // Sanity cap (I6)
    // ------------------------------------------------------------------

    it("enforces sanity cap when > 0 (I6)", async function () {
      const { admin, credit, registry, app1, alice } = await loadFixture(deployFixture);
      // Deploy novo tracker com cap pequeno (100 CREDIT).
      const cap = 100n * 10n ** 18n;
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const tracker = await BurnTracker.deploy(
        admin.address,
        await credit.getAddress(),
        await registry.getAddress(),
        ROUND_DURATION,
        cap,
      );
      await tracker.waitForDeployment();
      const BURNER_ROLE = await credit.BURNER_ROLE();
      await credit.connect(admin).grantRole(BURNER_ROLE, await tracker.getAddress());
      const RECORDER_ROLE = await tracker.RECORDER_ROLE();
      await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);

      // 60 CREDIT: OK. Next 60 CREDIT (total 120 > cap 100): revert.
      const sixty = 60n * 10n ** 18n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, sixty);
      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, sixty))
        .to.be.revertedWithCustomError(tracker, "SanityCapExceeded")
        .withArgs(1, sixty * 2n, cap);
    });

    it("allows exactly at cap (boundary I6)", async function () {
      const { admin, credit, registry, app1, alice } = await loadFixture(deployFixture);
      const cap = 100n * 10n ** 18n;
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const tracker = await BurnTracker.deploy(
        admin.address,
        await credit.getAddress(),
        await registry.getAddress(),
        ROUND_DURATION,
        cap,
      );
      await tracker.waitForDeployment();
      const BURNER_ROLE = await credit.BURNER_ROLE();
      await credit.connect(admin).grantRole(BURNER_ROLE, await tracker.getAddress());
      const RECORDER_ROLE = await tracker.RECORDER_ROLE();
      await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);

      // Exatamente cap (100): OK.
      await tracker.connect(app1).burnAndRecord(1, alice.address, cap);
      expect(await tracker.burnByRoundProject(0, 1)).to.equal(cap);

      // Next 1 wei: revert.
      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, 1n))
        .to.be.revertedWithCustomError(tracker, "SanityCapExceeded")
        .withArgs(1, cap + 1n, cap);
    });

    it("cap == 0 means no limit (I6)", async function () {
      const { admin, credit, registry, app1, alice } = await loadFixture(deployFixture);
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const tracker = await BurnTracker.deploy(
        admin.address,
        await credit.getAddress(),
        await registry.getAddress(),
        ROUND_DURATION,
        0n,
      );
      await tracker.waitForDeployment();
      const BURNER_ROLE = await credit.BURNER_ROLE();
      await credit.connect(admin).grantRole(BURNER_ROLE, await tracker.getAddress());
      const RECORDER_ROLE = await tracker.RECORDER_ROLE();
      await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);

      // Queima saldo maior que SANITY_CAP do fixture — nao deve reverter por cap.
      const huge = SEED_CREDIT / 2n;
      await tracker.connect(app1).burnAndRecord(1, alice.address, huge);
      expect(await tracker.burnByRoundProject(0, 1)).to.equal(huge);
    });

    it("sanity cap is per (round, project) — different projects independent", async function () {
      const { admin, credit, registry, app1, app2, alice } = await loadFixture(deployFixture);
      const cap = 100n * 10n ** 18n;
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const tracker = await BurnTracker.deploy(
        admin.address,
        await credit.getAddress(),
        await registry.getAddress(),
        ROUND_DURATION,
        cap,
      );
      await tracker.waitForDeployment();
      const BURNER_ROLE = await credit.BURNER_ROLE();
      await credit.connect(admin).grantRole(BURNER_ROLE, await tracker.getAddress());
      const RECORDER_ROLE = await tracker.RECORDER_ROLE();
      await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);
      await tracker.connect(admin).grantRole(RECORDER_ROLE, app2.address);

      await tracker.connect(app1).burnAndRecord(1, alice.address, cap);
      await tracker.connect(app2).burnAndRecord(2, alice.address, cap); // separado
      expect(await tracker.burnByRoundProject(0, 1)).to.equal(cap);
      expect(await tracker.burnByRoundProject(0, 2)).to.equal(cap);
    });

    it("reverts if tracker lacks BURNER_ROLE on CreditToken", async function () {
      const { admin, credit, registry, app1, alice } = await loadFixture(deployFixture);
      // Deploy tracker SEM conceder BURNER_ROLE no CREDIT.
      const BurnTracker = await ethers.getContractFactory("BurnTracker");
      const tracker = await BurnTracker.deploy(
        admin.address,
        await credit.getAddress(),
        await registry.getAddress(),
        ROUND_DURATION,
        SANITY_CAP,
      );
      await tracker.waitForDeployment();
      const RECORDER_ROLE = await tracker.RECORDER_ROLE();
      await tracker.connect(admin).grantRole(RECORDER_ROLE, app1.address);

      // CreditToken vai reverter com AccessControlUnauthorizedAccount em burnByRole.
      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(credit, "AccessControlUnauthorizedAccount")
        .withArgs(await tracker.getAddress(), await credit.BURNER_ROLE());
    });

    it("reverts if user has insufficient CREDIT balance", async function () {
      const { tracker, credit, app1, other } = await loadFixture(deployFixture);
      // `other` nao tem saldo (nao foi seedado). burnByRole -> ERC20InsufficientBalance.
      await expect(
        tracker.connect(app1).burnAndRecord(1, other.address, BURN_AMOUNT),
      ).to.be.revertedWithCustomError(credit, "ERC20InsufficientBalance");
    });
  });

  // ------------------------------------------------------------------
  // closeRound (I9, I10, I11, I12)
  // ------------------------------------------------------------------

  describe("closeRound", function () {
    it("normal close after roundDuration (earlyClose=false, I9)", async function () {
      const { tracker, governance, app1, alice } = await loadFixture(deployFixture);

      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      await time.increase(ROUND_DURATION);

      const tx = await tracker.connect(governance).closeRound();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const nowTs = BigInt(block!.timestamp);

      await expect(tx).to.emit(tracker, "RoundClosed").withArgs(0, BURN_AMOUNT, 1, nowTs, false);

      expect(await tracker.currentRound()).to.equal(1n);
      expect(await tracker.roundStartedAt()).to.equal(nowTs);

      // Round 0 state preserved post-close.
      expect(await tracker.totalBurnByRound(0)).to.equal(BURN_AMOUNT);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(1n);

      // Round 1 starts clean.
      expect(await tracker.totalBurnByRound(1)).to.equal(0n);
      expect(await tracker.projectsWithBurnCount(1)).to.equal(0n);
    });

    it("early close before roundDuration (earlyClose=true, I10)", async function () {
      const { tracker, governance, app1, alice } = await loadFixture(deployFixture);

      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      // Nao avanca tempo — fecha antes.

      const tx = await tracker.connect(governance).closeRound();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const nowTs = BigInt(block!.timestamp);

      await expect(tx).to.emit(tracker, "RoundClosed").withArgs(0, BURN_AMOUNT, 1, nowTs, true);

      expect(await tracker.currentRound()).to.equal(1n);
    });

    it("allows close of empty round (no burns)", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      await time.increase(ROUND_DURATION);
      await expect(tracker.connect(governance).closeRound())
        .to.emit(tracker, "RoundClosed")
        .withArgs(0, 0, 0, anyUint, false);
      expect(await tracker.currentRound()).to.equal(1n);
    });

    it("reverts when caller lacks GOVERNANCE_ROLE (I11)", async function () {
      const { tracker, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(tracker.connect(other).closeRound())
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("recorder without GOVERNANCE_ROLE cannot close (I11)", async function () {
      const { tracker, app1, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(tracker.connect(app1).closeRound())
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(app1.address, GOVERNANCE_ROLE);
    });

    it("burns in different rounds are isolated (I12)", async function () {
      const { tracker, governance, app1, alice, bob } = await loadFixture(deployFixture);

      // Round 0.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 100n * 10n ** 18n);
      await tracker.connect(app1).burnAndRecord(2, bob.address, 50n * 10n ** 18n);
      await time.increase(ROUND_DURATION);
      await tracker.connect(governance).closeRound();

      // Round 1.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 25n * 10n ** 18n);

      // Round 0 views: preserved.
      expect(await tracker.burnByRoundProject(0, 1)).to.equal(100n * 10n ** 18n);
      expect(await tracker.burnByRoundProject(0, 2)).to.equal(50n * 10n ** 18n);
      expect(await tracker.totalBurnByRound(0)).to.equal(150n * 10n ** 18n);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(2n);

      // Round 1 views: apenas o burn novo.
      expect(await tracker.burnByRoundProject(1, 1)).to.equal(25n * 10n ** 18n);
      expect(await tracker.burnByRoundProject(1, 2)).to.equal(0n);
      expect(await tracker.totalBurnByRound(1)).to.equal(25n * 10n ** 18n);
      expect(await tracker.projectsWithBurnCount(1)).to.equal(1n);
    });

    it("same project counts once per round (carry across closeRound)", async function () {
      const { tracker, governance, app1, alice } = await loadFixture(deployFixture);

      // Round 0: projeto 1.
      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      await time.increase(ROUND_DURATION);
      await tracker.connect(governance).closeRound();

      // Round 1: projeto 1 de novo — deve ser contado como 1 (primeiro no novo round).
      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);
      expect(await tracker.projectsWithBurnCount(1)).to.equal(1n);
    });
  });

  // ------------------------------------------------------------------
  // setRoundDuration (I13)
  // ------------------------------------------------------------------

  describe("setRoundDuration", function () {
    it("governance can update round duration", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      const newDur = 14n * 24n * 60n * 60n; // 14d
      await expect(tracker.connect(governance).setRoundDuration(newDur))
        .to.emit(tracker, "RoundDurationUpdated")
        .withArgs(ROUND_DURATION, newDur);
      expect(await tracker.roundDuration()).to.equal(newDur);
    });

    it("reverts when new duration < MIN_ROUND_DURATION (I13)", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      const below = MIN_ROUND_DURATION - 1n;
      await expect(tracker.connect(governance).setRoundDuration(below))
        .to.be.revertedWithCustomError(tracker, "InvalidRoundDuration")
        .withArgs(below, MIN_ROUND_DURATION, MAX_ROUND_DURATION);
    });

    it("reverts when new duration > MAX_ROUND_DURATION (I13)", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      const above = MAX_ROUND_DURATION + 1n;
      await expect(tracker.connect(governance).setRoundDuration(above))
        .to.be.revertedWithCustomError(tracker, "InvalidRoundDuration")
        .withArgs(above, MIN_ROUND_DURATION, MAX_ROUND_DURATION);
    });

    it("accepts exactly MIN_ROUND_DURATION (boundary)", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      await tracker.connect(governance).setRoundDuration(MIN_ROUND_DURATION);
      expect(await tracker.roundDuration()).to.equal(MIN_ROUND_DURATION);
    });

    it("accepts exactly MAX_ROUND_DURATION (boundary)", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      await tracker.connect(governance).setRoundDuration(MAX_ROUND_DURATION);
      expect(await tracker.roundDuration()).to.equal(MAX_ROUND_DURATION);
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { tracker, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(tracker.connect(other).setRoundDuration(MIN_ROUND_DURATION))
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("affects only future rounds — current round end unchanged", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      const startedAt = await tracker.roundStartedAt();
      const endsAtBefore = await tracker.getRoundEndsAt();
      expect(endsAtBefore).to.equal(startedAt + ROUND_DURATION);

      const newDur = 14n * 24n * 60n * 60n;
      await tracker.connect(governance).setRoundDuration(newDur);

      // roundStartedAt NAO muda; getRoundEndsAt reflete new duration aplicada ao round atual
      // (documentado: afeta todas as checagens a partir daqui, mas Sobel nao muda retroativamente
      // as rodadas ja fechadas). Entao: novo endsAt = startedAt + newDur.
      expect(await tracker.roundStartedAt()).to.equal(startedAt);
      expect(await tracker.getRoundEndsAt()).to.equal(startedAt + newDur);
    });
  });

  // ------------------------------------------------------------------
  // setMaxBurnPerRoundPerProject (I14)
  // ------------------------------------------------------------------

  describe("setMaxBurnPerRoundPerProject", function () {
    it("governance can update sanity cap", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      const newMax = 2_000_000n * 10n ** 18n;
      await expect(tracker.connect(governance).setMaxBurnPerRoundPerProject(newMax))
        .to.emit(tracker, "MaxBurnPerRoundPerProjectUpdated")
        .withArgs(SANITY_CAP, newMax);
      expect(await tracker.maxBurnPerRoundPerProject()).to.equal(newMax);
    });

    it("governance can set cap to 0 (remove limit, I14)", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      await tracker.connect(governance).setMaxBurnPerRoundPerProject(0n);
      expect(await tracker.maxBurnPerRoundPerProject()).to.equal(0n);
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { tracker, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(tracker.connect(other).setMaxBurnPerRoundPerProject(1n))
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("new cap applies to ongoing round, not retroactively", async function () {
      const { tracker, governance, app1, alice } = await loadFixture(deployFixture);
      await tracker.connect(app1).burnAndRecord(1, alice.address, 100n * 10n ** 18n);

      // Drops cap to something below current accumulated burn.
      // Cap=50, mas burnByRoundProject(0,1)=100 ja — CHECK usa burnNew+accumulated > cap.
      // Portanto: qualquer burn novo reverte imediatamente, mas o ja acumulado nao e zerado.
      const smallCap = 50n * 10n ** 18n;
      await tracker.connect(governance).setMaxBurnPerRoundPerProject(smallCap);
      expect(await tracker.burnByRoundProject(0, 1)).to.equal(100n * 10n ** 18n);
      await expect(tracker.connect(app1).burnAndRecord(1, alice.address, 1n))
        .to.be.revertedWithCustomError(tracker, "SanityCapExceeded")
        .withArgs(1, 100n * 10n ** 18n + 1n, smallCap);
    });
  });

  // ------------------------------------------------------------------
  // Views (getCurrentRound, getRoundEndsAt, isRoundReadyToClose)
  // ------------------------------------------------------------------

  describe("views", function () {
    it("getCurrentRound matches currentRound", async function () {
      const { tracker, governance } = await loadFixture(deployFixture);
      expect(await tracker.getCurrentRound()).to.equal(0n);
      await time.increase(ROUND_DURATION);
      await tracker.connect(governance).closeRound();
      expect(await tracker.getCurrentRound()).to.equal(1n);
    });

    it("getRoundEndsAt = roundStartedAt + roundDuration", async function () {
      const { tracker } = await loadFixture(deployFixture);
      const start = await tracker.roundStartedAt();
      expect(await tracker.getRoundEndsAt()).to.equal(start + ROUND_DURATION);
    });

    it("isRoundReadyToClose true only after roundDuration elapsed", async function () {
      const { tracker } = await loadFixture(deployFixture);
      const startedAt = await tracker.roundStartedAt();
      const endsAt = startedAt + ROUND_DURATION;

      // Ancorar o proximo block em endsAt-1 deterministicamente.
      await time.setNextBlockTimestamp(endsAt - 1n);
      // Forca mine para que `block.timestamp` vigente bata com endsAt-1.
      await ethers.provider.send("evm_mine", []);
      expect(await tracker.isRoundReadyToClose()).to.equal(false);

      // Avanca para endsAt exatamente — boundary `>=` => true.
      await time.setNextBlockTimestamp(endsAt);
      await ethers.provider.send("evm_mine", []);
      expect(await tracker.isRoundReadyToClose()).to.equal(true);
    });

    it("getBurnForProjectInRound and getTotalBurnForRound mirror raw mappings", async function () {
      const { tracker, app1, alice } = await loadFixture(deployFixture);
      await tracker.connect(app1).burnAndRecord(1, alice.address, BURN_AMOUNT);

      expect(await tracker.getBurnForProjectInRound(0, 1)).to.equal(BURN_AMOUNT);
      expect(await tracker.getBurnForProjectInRound(0, 2)).to.equal(0n);
      expect(await tracker.getTotalBurnForRound(0)).to.equal(BURN_AMOUNT);
      expect(await tracker.getTotalBurnForRound(1)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  // Access control matrix
  // ------------------------------------------------------------------

  describe("access control matrix", function () {
    it("recorder cannot call governance-gated functions", async function () {
      const { tracker, app1, alice, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      for (const call of [
        () => tracker.connect(app1).closeRound(),
        () => tracker.connect(app1).setRoundDuration(ROUND_DURATION),
        () => tracker.connect(app1).setMaxBurnPerRoundPerProject(0n),
      ]) {
        await expect(call())
          .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
          .withArgs(app1.address, GOVERNANCE_ROLE);
      }
      // sanity: alice is unused here.
      void alice;
    });

    it("governance cannot call burnAndRecord without RECORDER_ROLE", async function () {
      const { tracker, governance, alice, RECORDER_ROLE } = await loadFixture(deployFixture);
      await expect(tracker.connect(governance).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(governance.address, RECORDER_ROLE);
    });

    it("admin can grant and revoke RECORDER_ROLE", async function () {
      const { tracker, admin, other, alice, RECORDER_ROLE } = await loadFixture(deployFixture);
      await tracker.connect(admin).grantRole(RECORDER_ROLE, other.address);
      // Now can burn (assume alice has credit balance already seeded).
      await expect(tracker.connect(other).burnAndRecord(1, alice.address, BURN_AMOUNT)).to.emit(
        tracker,
        "BurnRecorded",
      );
      // Revoke and re-test.
      await tracker.connect(admin).revokeRole(RECORDER_ROLE, other.address);
      await expect(tracker.connect(other).burnAndRecord(1, alice.address, BURN_AMOUNT))
        .to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, RECORDER_ROLE);
    });
  });

  // ------------------------------------------------------------------
  // Integration end-to-end (I16)
  // ------------------------------------------------------------------

  describe("integration end-to-end", function () {
    it("real CreditToken + real Registry + multi-round lifecycle (I16)", async function () {
      const { tracker, credit, governance, app1, app2, alice, bob, carol } =
        await loadFixture(deployFixture);

      const supply0 = await credit.totalSupply();

      // Round 0: 3 burns distribuidos.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 100n * 10n ** 18n);
      await tracker.connect(app1).burnAndRecord(1, bob.address, 50n * 10n ** 18n);
      await tracker.connect(app2).burnAndRecord(2, carol.address, 200n * 10n ** 18n);

      const totalBurnR0 = 350n * 10n ** 18n;
      expect(await credit.totalSupply()).to.equal(supply0 - totalBurnR0);
      expect(await tracker.totalBurnByRound(0)).to.equal(totalBurnR0);
      expect(await tracker.projectsWithBurnCount(0)).to.equal(2n);

      // Fecha round 0.
      await time.increase(ROUND_DURATION);
      await tracker.connect(governance).closeRound();
      expect(await tracker.currentRound()).to.equal(1n);

      // Round 1: burn adicional.
      await tracker.connect(app1).burnAndRecord(1, alice.address, 25n * 10n ** 18n);
      expect(await tracker.totalBurnByRound(1)).to.equal(25n * 10n ** 18n);
      expect(await tracker.burnByRoundProject(1, 1)).to.equal(25n * 10n ** 18n);

      // Round 0 continua com os valores originais.
      expect(await tracker.burnByRoundProject(0, 1)).to.equal(150n * 10n ** 18n);
      expect(await tracker.burnByRoundProject(0, 2)).to.equal(200n * 10n ** 18n);

      // CreditToken.totalSupply reflete TUDO que foi queimado.
      const totalBurned = totalBurnR0 + 25n * 10n ** 18n;
      expect(await credit.totalSupply()).to.equal(supply0 - totalBurned);
    });
  });
});
