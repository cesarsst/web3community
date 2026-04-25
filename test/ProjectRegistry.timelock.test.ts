import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * ProjectRegistry — Fase 1.4 ownerRecipient timelock test suite.
 *
 * Cobertura:
 *  - ownerRecipient view: fallback para `owner`, retorna 0 para inexistente.
 *  - proposeOwnerRecipient: gating (only owner), Removed bloqueia, sobrescreve
 *    proposta previa, evento.
 *  - applyOwnerRecipient: revert antes do effectiveAt, sucesso depois,
 *    permissionless, no pending revert.
 *  - cancelOwnerRecipient: owner pode cancelar; governance pode cancelar;
 *    terceiro nao pode; idempotencia (apos cancel, novo cancel reverte).
 *  - Integracao: aplica + ownerRecipient retorna o novo recipient.
 */
describe("ProjectRegistry — Fase 1.4 ownerRecipient timelock", function () {
  const MIN_COLLATERAL = 10_000n * 10n ** 18n;
  const PROBATION_DURATION = 30n * 24n * 60n * 60n;
  const METADATA_URI = "ipfs://QmRecipientTest";
  const TIMELOCK_DELAY = 48n * 60n * 60n;

  async function deployFixture() {
    const [admin, governance, projOwner, newRecipient, other] = await ethers.getSigners();

    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy("Web3Community Governance", "GOV", admin.address);
    await gov.waitForDeployment();

    const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
    const registry = await ProjectRegistry.deploy(
      await gov.getAddress(),
      admin.address,
      MIN_COLLATERAL,
      PROBATION_DURATION,
    );
    await registry.waitForDeployment();
    const GOVERNANCE_ROLE = await registry.GOVERNANCE_ROLE();
    await registry.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

    // Seed GOV para o owner do projeto e aprova o registry como spender.
    await gov.connect(admin).mint(projOwner.address, MIN_COLLATERAL * 5n, "seed");
    await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL * 5n);

    // Registra projeto 1.
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI, MIN_COLLATERAL);
    await registry.connect(governance).activateProject(1);

    return {
      admin,
      governance,
      projOwner,
      newRecipient,
      other,
      gov,
      registry,
      GOVERNANCE_ROLE,
    };
  }

  // ------------------------------------------------------------------
  // ownerRecipient view
  // ------------------------------------------------------------------

  describe("ownerRecipient view", function () {
    it("returns project owner as fallback before any setter", async function () {
      const { registry, projOwner } = await loadFixture(deployFixture);
      expect(await registry.ownerRecipient(1)).to.equal(projOwner.address);
    });

    it("returns address(0) for non-existent project", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.ownerRecipient(999)).to.equal(ethers.ZeroAddress);
    });
  });

  // ------------------------------------------------------------------
  // proposeOwnerRecipient
  // ------------------------------------------------------------------

  describe("proposeOwnerRecipient", function () {
    it("reverts when caller is not the project owner", async function () {
      const { registry, other, newRecipient } = await loadFixture(deployFixture);
      await expect(registry.connect(other).proposeOwnerRecipient(1, newRecipient.address))
        .to.be.revertedWithCustomError(registry, "NotProjectOwner")
        .withArgs(1, other.address);
    });

    it("reverts on Removed project", async function () {
      const { registry, governance, projOwner, newRecipient } = await loadFixture(deployFixture);
      await registry.connect(governance).removeProject(1, false, ethers.ZeroAddress);
      await expect(
        registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address),
      ).to.be.revertedWithCustomError(registry, "ProjectAlreadyRemoved");
    });

    it("reverts on non-existent project", async function () {
      const { registry, projOwner } = await loadFixture(deployFixture);
      await expect(
        registry.connect(projOwner).proposeOwnerRecipient(999, projOwner.address),
      ).to.be.revertedWithCustomError(registry, "ProjectNotFound");
    });

    it("emits OwnerRecipientProposed and stores pending with 48h delay", async function () {
      const { registry, projOwner, newRecipient } = await loadFixture(deployFixture);
      const tx = await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      const block = await ethers.provider.getBlock(tx.blockNumber!);
      const expectedEffectiveAt = BigInt(block!.timestamp) + TIMELOCK_DELAY;
      await expect(tx)
        .to.emit(registry, "OwnerRecipientProposed")
        .withArgs(1, projOwner.address, newRecipient.address, expectedEffectiveAt);
      const pending = await registry.pendingOwnerRecipient(1);
      expect(pending.newRecipient).to.equal(newRecipient.address);
      expect(pending.effectiveAt).to.equal(expectedEffectiveAt);
    });

    it("overwrites previous pending proposal (clock resets)", async function () {
      const { registry, projOwner, newRecipient, other } = await loadFixture(deployFixture);
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      // Avanca metade do timelock.
      await time.increase(Number(TIMELOCK_DELAY) / 2);
      await registry.connect(projOwner).proposeOwnerRecipient(1, other.address);
      const pending = await registry.pendingOwnerRecipient(1);
      expect(pending.newRecipient).to.equal(other.address);
      // effectiveAt e novo (deve ser maior que o do primeiro).
      const blk = await ethers.provider.getBlock("latest");
      expect(pending.effectiveAt).to.equal(BigInt(blk!.timestamp) + TIMELOCK_DELAY);
    });
  });

  // ------------------------------------------------------------------
  // applyOwnerRecipient
  // ------------------------------------------------------------------

  describe("applyOwnerRecipient", function () {
    it("reverts NoPendingOwnerRecipient when no proposal exists", async function () {
      const { registry, other } = await loadFixture(deployFixture);
      await expect(registry.connect(other).applyOwnerRecipient(1)).to.be.revertedWithCustomError(
        registry,
        "NoPendingOwnerRecipient",
      );
    });

    it("reverts ProjectNotFound for non-existent project", async function () {
      const { registry, other } = await loadFixture(deployFixture);
      await expect(registry.connect(other).applyOwnerRecipient(999)).to.be.revertedWithCustomError(
        registry,
        "ProjectNotFound",
      );
    });

    it("reverts OwnerRecipientTimelockActive before effectiveAt", async function () {
      const { registry, projOwner, newRecipient, other } = await loadFixture(deployFixture);
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      // Avanca menos que o timelock.
      await time.increase(Number(TIMELOCK_DELAY) - 60);
      await expect(registry.connect(other).applyOwnerRecipient(1)).to.be.revertedWithCustomError(
        registry,
        "OwnerRecipientTimelockActive",
      );
    });

    it("happy path: permissionless apply after effectiveAt updates ownerRecipient and clears pending", async function () {
      const { registry, projOwner, newRecipient, other } = await loadFixture(deployFixture);
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      await time.increase(Number(TIMELOCK_DELAY) + 1);

      // Caller pode ser qualquer um.
      const tx = await registry.connect(other).applyOwnerRecipient(1);
      await expect(tx)
        .to.emit(registry, "OwnerRecipientApplied")
        .withArgs(1, ethers.ZeroAddress, newRecipient.address);
      // ownerRecipient agora retorna o novo.
      expect(await registry.ownerRecipient(1)).to.equal(newRecipient.address);
      // Pending limpo.
      const pending = await registry.pendingOwnerRecipient(1);
      expect(pending.effectiveAt).to.equal(0n);
      expect(pending.newRecipient).to.equal(ethers.ZeroAddress);
    });

    it("apply with proposed = address(0) resets to fallback (owner)", async function () {
      const { registry, projOwner, newRecipient, other } = await loadFixture(deployFixture);
      // Primeiro seta novo recipient.
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      await time.increase(Number(TIMELOCK_DELAY) + 1);
      await registry.connect(other).applyOwnerRecipient(1);
      expect(await registry.ownerRecipient(1)).to.equal(newRecipient.address);

      // Reset para fallback (proposta de address(0)).
      await registry.connect(projOwner).proposeOwnerRecipient(1, ethers.ZeroAddress);
      await time.increase(Number(TIMELOCK_DELAY) + 1);
      await registry.connect(other).applyOwnerRecipient(1);
      // Volta ao owner.
      expect(await registry.ownerRecipient(1)).to.equal(projOwner.address);
    });
  });

  // ------------------------------------------------------------------
  // cancelOwnerRecipient
  // ------------------------------------------------------------------

  describe("cancelOwnerRecipient", function () {
    it("reverts NoPendingOwnerRecipient when nothing to cancel", async function () {
      const { registry, projOwner } = await loadFixture(deployFixture);
      await expect(
        registry.connect(projOwner).cancelOwnerRecipient(1),
      ).to.be.revertedWithCustomError(registry, "NoPendingOwnerRecipient");
    });

    it("project owner can cancel pending", async function () {
      const { registry, projOwner, newRecipient } = await loadFixture(deployFixture);
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      await expect(registry.connect(projOwner).cancelOwnerRecipient(1))
        .to.emit(registry, "OwnerRecipientCancelled")
        .withArgs(1, projOwner.address);
      expect((await registry.pendingOwnerRecipient(1)).effectiveAt).to.equal(0n);
    });

    it("governance can cancel pending (escape hatch)", async function () {
      const { registry, governance, projOwner, newRecipient } = await loadFixture(deployFixture);
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      await expect(registry.connect(governance).cancelOwnerRecipient(1))
        .to.emit(registry, "OwnerRecipientCancelled")
        .withArgs(1, governance.address);
    });

    it("reverts when neither owner nor governance attempts to cancel", async function () {
      const { registry, projOwner, newRecipient, other } = await loadFixture(deployFixture);
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      await expect(registry.connect(other).cancelOwnerRecipient(1))
        .to.be.revertedWithCustomError(registry, "NotProjectOwner")
        .withArgs(1, other.address);
    });

    it("after cancel, applyOwnerRecipient reverts NoPendingOwnerRecipient", async function () {
      const { registry, projOwner, newRecipient, other } = await loadFixture(deployFixture);
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      await registry.connect(projOwner).cancelOwnerRecipient(1);
      await time.increase(Number(TIMELOCK_DELAY) + 1);
      await expect(registry.connect(other).applyOwnerRecipient(1)).to.be.revertedWithCustomError(
        registry,
        "NoPendingOwnerRecipient",
      );
    });
  });

  // ------------------------------------------------------------------
  // Integration with existing ownership transfer (no interaction)
  // ------------------------------------------------------------------

  describe("integration", function () {
    it("ownership transfer changes fallback owner; explicit recipient persists", async function () {
      const { registry, projOwner, newRecipient, other } = await loadFixture(deployFixture);
      // Seta explicit recipient.
      await registry.connect(projOwner).proposeOwnerRecipient(1, newRecipient.address);
      await time.increase(Number(TIMELOCK_DELAY) + 1);
      await registry.connect(other).applyOwnerRecipient(1);
      expect(await registry.ownerRecipient(1)).to.equal(newRecipient.address);

      // Owner transfere ownership para `other`.
      await registry.connect(projOwner).transferProjectOwnership(1, other.address);
      await registry.connect(other).acceptProjectOwnership(1);
      // Explicit recipient nao mudou.
      expect(await registry.ownerRecipient(1)).to.equal(newRecipient.address);
    });

    it("OWNER_RECIPIENT_TIMELOCK constant is 48h", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.OWNER_RECIPIENT_TIMELOCK()).to.equal(48n * 60n * 60n);
    });
  });
});
