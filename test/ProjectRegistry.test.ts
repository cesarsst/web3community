import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * ProjectRegistry test suite.
 *
 * Cobre:
 *  - Construção (params iniciais, roles, zero-address checks).
 *  - registerProject (happy, allowance insuficiente, guards, custódia exata, ID incremental).
 *  - State machine completa: Pending → Active; Active → Probation; Probation → Active;
 *    Active/Probation → Removed. Transições inválidas revertem com InvalidStatus.
 *  - Probation por tempo (probationDuration após activate, `isInProbation`).
 *  - removeProject: slash=true (collateral -> treasury) e slash=false (collateral -> owner).
 *  - updateMetadata: somente owner do projeto. Status Removed bloqueia.
 *  - Ownership transfer 2-step: initiate + accept; transferência só efetiva após accept.
 *  - Params governance-tunable: setMinCollateral, setProbationDuration (eventos + role).
 *  - Views: getProject, isActive, isInProbation, totalProjects, pendingOwner.
 *  - Access control: toda função state-changing gated por role ou owner.
 *  - Eventos com args esperados.
 *  - Invariantes I7 e custódia de collateral.
 */
describe("ProjectRegistry", function () {
  const NAME = "Web3Community Governance";
  const SYMBOL = "GOV";
  const MIN_COLLATERAL = 10_000n * 10n ** 18n; // 10k GOV
  const PROBATION_DURATION = 30n * 24n * 60n * 60n; // 30 dias em segundos
  const METADATA_URI = "ipfs://QmProjectMetadataExample";

  async function deployFixture() {
    const [admin, governance, treasury, proj1, proj2, proj3, proj4, other] =
      await ethers.getSigners();

    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy(NAME, SYMBOL, admin.address);
    await gov.waitForDeployment();

    const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
    const registry = await ProjectRegistry.deploy(
      await gov.getAddress(),
      admin.address,
      MIN_COLLATERAL,
      PROBATION_DURATION,
    );
    await registry.waitForDeployment();

    const DEFAULT_ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
    const GOVERNANCE_ROLE = await registry.GOVERNANCE_ROLE();

    // Admin concede GOVERNANCE_ROLE ao signer "governance" (simulação do Timelock).
    await registry.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

    // Admin minta GOV suficiente para todos os project owners + testes de colateral grande.
    const seed = 1_000_000n * 10n ** 18n; // 1M GOV cada
    for (const signer of [proj1, proj2, proj3, proj4]) {
      await gov.connect(admin).mint(signer.address, seed, "seed:projectOwner");
    }

    return {
      gov,
      registry,
      admin,
      governance,
      treasury,
      proj1,
      proj2,
      proj3,
      proj4,
      other,
      DEFAULT_ADMIN_ROLE,
      GOVERNANCE_ROLE,
    };
  }

  /** Helper: registra um projeto Pending usando allowance + registerProject. */
  async function registerOne(
    registry: Awaited<ReturnType<typeof deployFixture>>["registry"],
    gov: Awaited<ReturnType<typeof deployFixture>>["gov"],
    governance: Awaited<ReturnType<typeof deployFixture>>["governance"],
    owner: Awaited<ReturnType<typeof deployFixture>>["proj1"],
    collateral: bigint = MIN_COLLATERAL,
    uri: string = METADATA_URI,
  ) {
    await gov.connect(owner).approve(await registry.getAddress(), collateral);
    const tx = await registry.connect(governance).registerProject(owner.address, uri, collateral);
    await tx.wait();
  }

  describe("construction", function () {
    it("sets token address, initial params and roles", async function () {
      const { registry, gov, admin, DEFAULT_ADMIN_ROLE, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);

      expect(await registry.govToken()).to.equal(await gov.getAddress());
      expect(await registry.minCollateral()).to.equal(MIN_COLLATERAL);
      expect(await registry.probationDuration()).to.equal(PROBATION_DURATION);
      expect(await registry.totalProjects()).to.equal(0n);

      expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await registry.hasRole(GOVERNANCE_ROLE, admin.address)).to.equal(true);
    });

    it("exposes GOVERNANCE_ROLE matching the documented keccak hash", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.GOVERNANCE_ROLE()).to.equal(ethers.id("GOVERNANCE_ROLE"));
    });

    it("reverts when gov token is zero address", async function () {
      const { admin } = await loadFixture(deployFixture);
      const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
      await expect(
        ProjectRegistry.deploy(
          ethers.ZeroAddress,
          admin.address,
          MIN_COLLATERAL,
          PROBATION_DURATION,
        ),
      ).to.be.revertedWithCustomError(ProjectRegistry, "ZeroAddress");
    });

    it("reverts when initial admin is zero address", async function () {
      const { gov } = await loadFixture(deployFixture);
      const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
      await expect(
        ProjectRegistry.deploy(
          await gov.getAddress(),
          ethers.ZeroAddress,
          MIN_COLLATERAL,
          PROBATION_DURATION,
        ),
      ).to.be.revertedWithCustomError(ProjectRegistry, "ZeroAddress");
    });

    it("supports IAccessControl interface", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.supportsInterface("0x7965db0b")).to.equal(true);
      expect(await registry.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await registry.supportsInterface("0xffffffff")).to.equal(false);
    });

    it("reverts when initialMinCollateral is zero", async function () {
      const { gov, admin } = await loadFixture(deployFixture);
      const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
      await expect(
        ProjectRegistry.deploy(await gov.getAddress(), admin.address, 0n, PROBATION_DURATION),
      ).to.be.revertedWithCustomError(ProjectRegistry, "ZeroAmount");
    });

    it("reverts when initialProbationDuration is zero", async function () {
      const { gov, admin } = await loadFixture(deployFixture);
      const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
      await expect(
        ProjectRegistry.deploy(await gov.getAddress(), admin.address, MIN_COLLATERAL, 0n),
      ).to.be.revertedWithCustomError(ProjectRegistry, "ZeroAmount");
    });
  });

  describe("registerProject", function () {
    it("registers a project in Pending status and emits ProjectRegistered", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await gov.connect(proj1).approve(await registry.getAddress(), MIN_COLLATERAL);

      await expect(
        registry.connect(governance).registerProject(proj1.address, METADATA_URI, MIN_COLLATERAL),
      )
        .to.emit(registry, "ProjectRegistered")
        .withArgs(1n, proj1.address, MIN_COLLATERAL, METADATA_URI);

      expect(await registry.totalProjects()).to.equal(1n);

      const project = await registry.getProject(1n);
      expect(project.owner).to.equal(proj1.address);
      expect(project.collateral).to.equal(MIN_COLLATERAL);
      expect(project.status).to.equal(0n); // Pending
      expect(project.activatedAt).to.equal(0n);
      expect(project.probationEndsAt).to.equal(0n);
      expect(project.metadataURI).to.equal(METADATA_URI);
    });

    it("transfers exactly the declared collateral from owner to registry", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      const balanceBefore = await gov.balanceOf(proj1.address);
      const registryBalanceBefore = await gov.balanceOf(await registry.getAddress());

      await registerOne(registry, gov, governance, proj1, MIN_COLLATERAL);

      expect(await gov.balanceOf(proj1.address)).to.equal(balanceBefore - MIN_COLLATERAL);
      expect(await gov.balanceOf(await registry.getAddress())).to.equal(
        registryBalanceBefore + MIN_COLLATERAL,
      );
    });

    it("increments project IDs starting at 1 (zero = invalid)", async function () {
      const { registry, gov, governance, proj1, proj2, proj3 } = await loadFixture(deployFixture);

      await registerOne(registry, gov, governance, proj1);
      await registerOne(registry, gov, governance, proj2);
      await registerOne(registry, gov, governance, proj3);

      expect(await registry.totalProjects()).to.equal(3n);
      expect((await registry.getProject(1n)).owner).to.equal(proj1.address);
      expect((await registry.getProject(2n)).owner).to.equal(proj2.address);
      expect((await registry.getProject(3n)).owner).to.equal(proj3.address);
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { registry, gov, other, proj1, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await gov.connect(proj1).approve(await registry.getAddress(), MIN_COLLATERAL);

      await expect(
        registry.connect(other).registerProject(proj1.address, METADATA_URI, MIN_COLLATERAL),
      )
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts when owner is zero address", async function () {
      const { registry, governance } = await loadFixture(deployFixture);
      await expect(
        registry
          .connect(governance)
          .registerProject(ethers.ZeroAddress, METADATA_URI, MIN_COLLATERAL),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts when metadataURI is empty", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await gov.connect(proj1).approve(await registry.getAddress(), MIN_COLLATERAL);

      await expect(
        registry.connect(governance).registerProject(proj1.address, "", MIN_COLLATERAL),
      ).to.be.revertedWithCustomError(registry, "EmptyMetadataURI");
    });

    it("reverts when collateral is below minCollateral", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      const low = MIN_COLLATERAL - 1n;
      await gov.connect(proj1).approve(await registry.getAddress(), low);

      await expect(registry.connect(governance).registerProject(proj1.address, METADATA_URI, low))
        .to.be.revertedWithCustomError(registry, "InsufficientCollateral")
        .withArgs(low, MIN_COLLATERAL);
    });

    it("reverts with InsufficientAllowance when owner did not approve enough", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await gov.connect(proj1).approve(await registry.getAddress(), MIN_COLLATERAL - 1n);

      await expect(
        registry.connect(governance).registerProject(proj1.address, METADATA_URI, MIN_COLLATERAL),
      )
        .to.be.revertedWithCustomError(registry, "InsufficientAllowance")
        .withArgs(MIN_COLLATERAL - 1n, MIN_COLLATERAL);
    });

    it("allows collateral above minCollateral", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      const big = MIN_COLLATERAL * 3n;
      await gov.connect(proj1).approve(await registry.getAddress(), big);

      await registry.connect(governance).registerProject(proj1.address, METADATA_URI, big);
      expect((await registry.getProject(1n)).collateral).to.equal(big);
    });
  });

  describe("activateProject (Pending → Active)", function () {
    it("activates a Pending project and sets activatedAt + probationEndsAt", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      const tx = await registry.connect(governance).activateProject(1n);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const ts = BigInt(block!.timestamp);

      await expect(tx)
        .to.emit(registry, "ProjectActivated")
        .withArgs(1n, ts, ts + PROBATION_DURATION);

      const project = await registry.getProject(1n);
      expect(project.status).to.equal(1n); // Active
      expect(project.activatedAt).to.equal(ts);
      expect(project.probationEndsAt).to.equal(ts + PROBATION_DURATION);
    });

    it("isInProbation returns true during probationDuration, false after", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      expect(await registry.isInProbation(1n)).to.equal(true);
      expect(await registry.isActive(1n)).to.equal(true);

      await time.increase(Number(PROBATION_DURATION) + 1);
      expect(await registry.isInProbation(1n)).to.equal(false);
      expect(await registry.isActive(1n)).to.equal(true);
    });

    it("reverts when non-governance calls activateProject", async function () {
      const { registry, gov, governance, proj1, other, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(other).activateProject(1n))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts when project does not exist", async function () {
      const { registry, governance } = await loadFixture(deployFixture);
      await expect(registry.connect(governance).activateProject(42n))
        .to.be.revertedWithCustomError(registry, "ProjectNotFound")
        .withArgs(42n);
    });

    it("reverts when project is already Active (InvalidStatus)", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      await expect(registry.connect(governance).activateProject(1n))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(1n, 1n, 0n); // projectId, current=Active(1), expected=Pending(0)
    });
  });

  describe("setProbation (Active → Probation)", function () {
    it("moves Active project to Probation and emits ProjectProbation", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      await expect(registry.connect(governance).setProbation(1n))
        .to.emit(registry, "ProjectProbation")
        .withArgs(1n);

      const project = await registry.getProject(1n);
      expect(project.status).to.equal(2n); // Probation
      expect(await registry.isActive(1n)).to.equal(false);
    });

    it("does not modify activatedAt when moving to Probation", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      const before = await registry.getProject(1n);
      await time.increase(60 * 60);
      await registry.connect(governance).setProbation(1n);
      const after = await registry.getProject(1n);

      expect(after.activatedAt).to.equal(before.activatedAt);
      expect(after.probationEndsAt).to.equal(before.probationEndsAt);
    });

    it("reverts when trying to set probation on a Pending project", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(governance).setProbation(1n))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(1n, 0n, 1n); // current=Pending, expected=Active
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { registry, gov, governance, proj1, other, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      await expect(registry.connect(other).setProbation(1n))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });
  });

  describe("reactivate (Probation → Active)", function () {
    it("moves a Probation project back to Active and emits ProjectReactivated", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);
      await registry.connect(governance).setProbation(1n);

      await expect(registry.connect(governance).reactivate(1n))
        .to.emit(registry, "ProjectReactivated")
        .withArgs(1n);

      const project = await registry.getProject(1n);
      expect(project.status).to.equal(1n); // Active
    });

    it("reverts when project is not in Probation", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      await expect(registry.connect(governance).reactivate(1n))
        .to.be.revertedWithCustomError(registry, "InvalidStatus")
        .withArgs(1n, 1n, 2n); // current=Active, expected=Probation
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { registry, gov, governance, proj1, other, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);
      await registry.connect(governance).setProbation(1n);

      await expect(registry.connect(other).reactivate(1n))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });
  });

  describe("removeProject (terminal)", function () {
    it("removes an Active project with slash=false and returns full collateral to owner", async function () {
      const { registry, gov, governance, treasury, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      const ownerBefore = await gov.balanceOf(proj1.address);
      const treasuryBefore = await gov.balanceOf(treasury.address);

      await expect(registry.connect(governance).removeProject(1n, false, treasury.address))
        .to.emit(registry, "ProjectRemoved")
        .withArgs(1n, false, MIN_COLLATERAL);

      expect(await gov.balanceOf(proj1.address)).to.equal(ownerBefore + MIN_COLLATERAL);
      expect(await gov.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect((await registry.getProject(1n)).status).to.equal(3n); // Removed
      expect((await registry.getProject(1n)).collateral).to.equal(0n);
    });

    it("removes with slash=true and transfers collateral to treasury", async function () {
      const { registry, gov, governance, treasury, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      const ownerBefore = await gov.balanceOf(proj1.address);
      const treasuryBefore = await gov.balanceOf(treasury.address);

      await expect(registry.connect(governance).removeProject(1n, true, treasury.address))
        .to.emit(registry, "ProjectRemoved")
        .withArgs(1n, true, MIN_COLLATERAL);

      expect(await gov.balanceOf(proj1.address)).to.equal(ownerBefore);
      expect(await gov.balanceOf(treasury.address)).to.equal(treasuryBefore + MIN_COLLATERAL);
      expect((await registry.getProject(1n)).status).to.equal(3n); // Removed
      expect((await registry.getProject(1n)).collateral).to.equal(0n);
    });

    it("can remove a Pending project", async function () {
      const { registry, gov, governance, treasury, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await registry.connect(governance).removeProject(1n, false, treasury.address);
      expect((await registry.getProject(1n)).status).to.equal(3n);
    });

    it("can remove a Probation project", async function () {
      const { registry, gov, governance, treasury, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);
      await registry.connect(governance).setProbation(1n);

      await registry.connect(governance).removeProject(1n, true, treasury.address);
      expect((await registry.getProject(1n)).status).to.equal(3n);
    });

    it("reverts when project is already Removed (terminal)", async function () {
      const { registry, gov, governance, treasury, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).removeProject(1n, false, treasury.address);

      await expect(registry.connect(governance).removeProject(1n, false, treasury.address))
        .to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved")
        .withArgs(1n);
    });

    it("reverts when treasury is zero address on slash=true", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      await expect(
        registry.connect(governance).removeProject(1n, true, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { registry, gov, governance, proj1, other, treasury, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(other).removeProject(1n, false, treasury.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts for unknown project", async function () {
      const { registry, governance, treasury } = await loadFixture(deployFixture);
      await expect(registry.connect(governance).removeProject(99n, false, treasury.address))
        .to.be.revertedWithCustomError(registry, "ProjectNotFound")
        .withArgs(99n);
    });

    it("isInProbation and isActive return false after removal", async function () {
      const { registry, gov, governance, treasury, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);
      await registry.connect(governance).removeProject(1n, false, treasury.address);

      expect(await registry.isActive(1n)).to.equal(false);
      expect(await registry.isInProbation(1n)).to.equal(false);
    });

    it("removal clears any pending ownership transfer", async function () {
      const { registry, gov, governance, treasury, proj1, proj2 } =
        await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(proj1).transferProjectOwnership(1n, proj2.address);
      expect(await registry.pendingOwner(1n)).to.equal(proj2.address);

      await registry.connect(governance).removeProject(1n, false, treasury.address);
      expect(await registry.pendingOwner(1n)).to.equal(ethers.ZeroAddress);

      // pending owner não pode aceitar um projeto removido
      await expect(registry.connect(proj2).acceptProjectOwnership(1n))
        .to.be.revertedWithCustomError(registry, "NotPendingOwner")
        .withArgs(1n, proj2.address);
    });
  });

  describe("updateMetadata (owner-gated)", function () {
    it("project owner can update metadata URI", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      const newUri = "ipfs://QmUpdatedMetadata";
      await expect(registry.connect(proj1).updateMetadata(1n, newUri))
        .to.emit(registry, "MetadataUpdated")
        .withArgs(1n, newUri);

      expect((await registry.getProject(1n)).metadataURI).to.equal(newUri);
    });

    it("reverts when non-owner attempts update", async function () {
      const { registry, gov, governance, proj1, other } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(other).updateMetadata(1n, "ipfs://hacker"))
        .to.be.revertedWithCustomError(registry, "NotProjectOwner")
        .withArgs(1n, other.address);
    });

    it("reverts for empty URI", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(proj1).updateMetadata(1n, "")).to.be.revertedWithCustomError(
        registry,
        "EmptyMetadataURI",
      );
    });

    it("reverts after project removal", async function () {
      const { registry, gov, governance, treasury, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).removeProject(1n, false, treasury.address);

      await expect(registry.connect(proj1).updateMetadata(1n, "ipfs://x"))
        .to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved")
        .withArgs(1n);
    });

    it("reverts for unknown project", async function () {
      const { registry, proj1 } = await loadFixture(deployFixture);
      await expect(registry.connect(proj1).updateMetadata(42n, "ipfs://x"))
        .to.be.revertedWithCustomError(registry, "ProjectNotFound")
        .withArgs(42n);
    });
  });

  describe("transferProjectOwnership (2-step)", function () {
    it("initiates transfer and sets pending owner without touching current owner", async function () {
      const { registry, gov, governance, proj1, proj2 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(proj1).transferProjectOwnership(1n, proj2.address))
        .to.emit(registry, "OwnershipTransferInitiated")
        .withArgs(1n, proj1.address, proj2.address);

      expect(await registry.pendingOwner(1n)).to.equal(proj2.address);
      expect((await registry.getProject(1n)).owner).to.equal(proj1.address);
    });

    it("pending owner can accept and becomes the new owner", async function () {
      const { registry, gov, governance, proj1, proj2 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(proj1).transferProjectOwnership(1n, proj2.address);

      await expect(registry.connect(proj2).acceptProjectOwnership(1n))
        .to.emit(registry, "OwnershipTransferAccepted")
        .withArgs(1n, proj1.address, proj2.address);

      expect((await registry.getProject(1n)).owner).to.equal(proj2.address);
      expect(await registry.pendingOwner(1n)).to.equal(ethers.ZeroAddress);
    });

    it("new owner can then update metadata, previous owner cannot", async function () {
      const { registry, gov, governance, proj1, proj2 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(proj1).transferProjectOwnership(1n, proj2.address);
      await registry.connect(proj2).acceptProjectOwnership(1n);

      await expect(registry.connect(proj1).updateMetadata(1n, "ipfs://rogue"))
        .to.be.revertedWithCustomError(registry, "NotProjectOwner")
        .withArgs(1n, proj1.address);

      await registry.connect(proj2).updateMetadata(1n, "ipfs://new-owner-uri");
      expect((await registry.getProject(1n)).metadataURI).to.equal("ipfs://new-owner-uri");
    });

    it("reverts when non-owner initiates transfer", async function () {
      const { registry, gov, governance, proj1, proj2, other } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(other).transferProjectOwnership(1n, proj2.address))
        .to.be.revertedWithCustomError(registry, "NotProjectOwner")
        .withArgs(1n, other.address);
    });

    it("reverts on transfer to zero address", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(
        registry.connect(proj1).transferProjectOwnership(1n, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts when non-pending-owner tries to accept", async function () {
      const { registry, gov, governance, proj1, proj2, other } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(proj1).transferProjectOwnership(1n, proj2.address);

      await expect(registry.connect(other).acceptProjectOwnership(1n))
        .to.be.revertedWithCustomError(registry, "NotPendingOwner")
        .withArgs(1n, other.address);
    });

    it("reverts accept when no pending transfer exists", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await expect(registry.connect(proj1).acceptProjectOwnership(1n))
        .to.be.revertedWithCustomError(registry, "NotPendingOwner")
        .withArgs(1n, proj1.address);
    });

    it("initiating a new transfer overwrites the pending owner", async function () {
      const { registry, gov, governance, proj1, proj2, proj3 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);

      await registry.connect(proj1).transferProjectOwnership(1n, proj2.address);
      await registry.connect(proj1).transferProjectOwnership(1n, proj3.address);

      expect(await registry.pendingOwner(1n)).to.equal(proj3.address);

      await expect(registry.connect(proj2).acceptProjectOwnership(1n))
        .to.be.revertedWithCustomError(registry, "NotPendingOwner")
        .withArgs(1n, proj2.address);

      await registry.connect(proj3).acceptProjectOwnership(1n);
      expect((await registry.getProject(1n)).owner).to.equal(proj3.address);
    });

    it("reverts transfer on removed project", async function () {
      const { registry, gov, governance, treasury, proj1, proj2 } =
        await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).removeProject(1n, false, treasury.address);

      await expect(registry.connect(proj1).transferProjectOwnership(1n, proj2.address))
        .to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved")
        .withArgs(1n);
    });
  });

  describe("setMinCollateral (governance-tunable)", function () {
    it("updates minCollateral and emits event", async function () {
      const { registry, governance } = await loadFixture(deployFixture);
      const newMin = 5_000n * 10n ** 18n;

      await expect(registry.connect(governance).setMinCollateral(newMin))
        .to.emit(registry, "MinCollateralUpdated")
        .withArgs(MIN_COLLATERAL, newMin);

      expect(await registry.minCollateral()).to.equal(newMin);
    });

    it("new minCollateral affects future registrations only", async function () {
      const { registry, gov, governance, proj1, proj2 } = await loadFixture(deployFixture);
      // proj1 registra no min original
      await registerOne(registry, gov, governance, proj1, MIN_COLLATERAL);

      // governance dobra o minimo
      const newMin = MIN_COLLATERAL * 2n;
      await registry.connect(governance).setMinCollateral(newMin);

      // proj2 nao pode com o antigo minimo
      await gov.connect(proj2).approve(await registry.getAddress(), MIN_COLLATERAL);
      await expect(
        registry.connect(governance).registerProject(proj2.address, METADATA_URI, MIN_COLLATERAL),
      )
        .to.be.revertedWithCustomError(registry, "InsufficientCollateral")
        .withArgs(MIN_COLLATERAL, newMin);
    });

    it("reverts when minCollateral set to zero", async function () {
      const { registry, governance } = await loadFixture(deployFixture);
      await expect(registry.connect(governance).setMinCollateral(0n)).to.be.revertedWithCustomError(
        registry,
        "ZeroAmount",
      );
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { registry, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(registry.connect(other).setMinCollateral(1n))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });
  });

  describe("setProbationDuration (governance-tunable)", function () {
    it("updates probationDuration and emits event", async function () {
      const { registry, governance } = await loadFixture(deployFixture);
      const newDuration = 14n * 24n * 60n * 60n;

      await expect(registry.connect(governance).setProbationDuration(newDuration))
        .to.emit(registry, "ProbationDurationUpdated")
        .withArgs(PROBATION_DURATION, newDuration);

      expect(await registry.probationDuration()).to.equal(newDuration);
    });

    it("new probationDuration only affects projects activated after the change", async function () {
      const { registry, gov, governance, proj1, proj2 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);
      const p1 = await registry.getProject(1n);

      const newDuration = 7n * 24n * 60n * 60n;
      await registry.connect(governance).setProbationDuration(newDuration);

      await registerOne(registry, gov, governance, proj2);
      await registry.connect(governance).activateProject(2n);
      const p2 = await registry.getProject(2n);

      expect(p1.probationEndsAt - p1.activatedAt).to.equal(PROBATION_DURATION);
      expect(p2.probationEndsAt - p2.activatedAt).to.equal(newDuration);
    });

    it("reverts when setting duration to zero", async function () {
      const { registry, governance } = await loadFixture(deployFixture);
      await expect(
        registry.connect(governance).setProbationDuration(0n),
      ).to.be.revertedWithCustomError(registry, "ZeroAmount");
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { registry, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(registry.connect(other).setProbationDuration(1n))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });
  });

  describe("views", function () {
    it("getProject reverts for unknown project", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.getProject(0n))
        .to.be.revertedWithCustomError(registry, "ProjectNotFound")
        .withArgs(0n);

      await expect(registry.getProject(99n))
        .to.be.revertedWithCustomError(registry, "ProjectNotFound")
        .withArgs(99n);
    });

    it("isActive returns false for Pending, Probation and Removed; true only for Active", async function () {
      const { registry, gov, governance, treasury, proj1, proj2, proj3, proj4 } =
        await loadFixture(deployFixture);

      // P1: Pending
      await registerOne(registry, gov, governance, proj1);
      // P2: Active
      await registerOne(registry, gov, governance, proj2);
      await registry.connect(governance).activateProject(2n);
      // P3: Probation (via setProbation)
      await registerOne(registry, gov, governance, proj3);
      await registry.connect(governance).activateProject(3n);
      await registry.connect(governance).setProbation(3n);
      // P4: Removed
      await registerOne(registry, gov, governance, proj4);
      await registry.connect(governance).removeProject(4n, false, treasury.address);

      expect(await registry.isActive(1n)).to.equal(false);
      expect(await registry.isActive(2n)).to.equal(true);
      expect(await registry.isActive(3n)).to.equal(false);
      expect(await registry.isActive(4n)).to.equal(false);
    });

    it("isInProbation returns false for non-Active projects even within the time window", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      // Pending
      expect(await registry.isInProbation(1n)).to.equal(false);
      // Active, within window
      await registry.connect(governance).activateProject(1n);
      expect(await registry.isInProbation(1n)).to.equal(true);
      // Moved to punitive Probation: isInProbation (time-based) returns false because status != Active
      await registry.connect(governance).setProbation(1n);
      expect(await registry.isInProbation(1n)).to.equal(false);
    });

    it("isInProbation and isActive return false for unknown projects", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.isActive(0n)).to.equal(false);
      expect(await registry.isActive(99n)).to.equal(false);
      expect(await registry.isInProbation(0n)).to.equal(false);
      expect(await registry.isInProbation(99n)).to.equal(false);
    });

    it("pendingOwner returns zero for unknown or non-transferring projects", async function () {
      const { registry, gov, governance, proj1 } = await loadFixture(deployFixture);
      expect(await registry.pendingOwner(99n)).to.equal(ethers.ZeroAddress);

      await registerOne(registry, gov, governance, proj1);
      expect(await registry.pendingOwner(1n)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("invariants I7 and custody", function () {
    it("I7: no state-changing status function is callable by a non-governance account", async function () {
      const { registry, gov, governance, treasury, proj1, other, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1);
      await registry.connect(governance).activateProject(1n);

      for (const call of [
        () => registry.connect(other).activateProject(1n),
        () => registry.connect(other).setProbation(1n),
        () => registry.connect(other).reactivate(1n),
        () => registry.connect(other).removeProject(1n, false, treasury.address),
        () => registry.connect(other).setMinCollateral(1n),
        () => registry.connect(other).setProbationDuration(1n),
        () => registry.connect(other).registerProject(other.address, "ipfs://x", MIN_COLLATERAL),
      ]) {
        await expect(call())
          .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
          .withArgs(other.address, GOVERNANCE_ROLE);
      }
    });

    it("collateral custody is exact: registry balance matches sum of live collaterals", async function () {
      const { registry, gov, governance, proj1, proj2, proj3 } = await loadFixture(deployFixture);
      await registerOne(registry, gov, governance, proj1, MIN_COLLATERAL);
      await registerOne(registry, gov, governance, proj2, MIN_COLLATERAL * 2n);
      await registerOne(registry, gov, governance, proj3, MIN_COLLATERAL * 3n);

      const total = MIN_COLLATERAL + MIN_COLLATERAL * 2n + MIN_COLLATERAL * 3n;
      expect(await gov.balanceOf(await registry.getAddress())).to.equal(total);
    });
  });
});
