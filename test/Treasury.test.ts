import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Treasury (remodel 2026-07-08) — cofre multi-ativo simples.
 *
 * Cobertura:
 *  1. Construction: roles pro admin, admin zero reverte.
 *  2. transfer (ERC20): so GOVERNANCE_ROLE, bounds (zero addr/amount,
 *     saldo insuficiente), evento, custodia exata.
 *  3. transferETH: idem + destinatario que rejeita ETH.
 *  4. receive: aceita ETH e emite evento.
 *  5. Views: balanceOf / ethBalance.
 */
describe("Treasury (cofre multi-ativo)", function () {
  const AMOUNT = 1_000n * 10n ** 18n;

  async function deployFixture() {
    const [admin, governance, stranger, recipient] = await ethers.getSigners();

    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(admin.address);

    const GOVERNANCE_ROLE = await treasury.GOVERNANCE_ROLE();
    await treasury.grantRole(GOVERNANCE_ROLE, governance.address);

    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const token = await ERC20Mock.deploy("Token", "TKN");
    await token.mint(await treasury.getAddress(), AMOUNT);

    return { admin, governance, stranger, recipient, treasury, token, GOVERNANCE_ROLE };
  }

  describe("construction", function () {
    it("concede DEFAULT_ADMIN e GOVERNANCE_ROLE ao admin", async function () {
      const { admin, treasury, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      expect(await treasury.hasRole(await treasury.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await treasury.hasRole(GOVERNANCE_ROLE, admin.address)).to.equal(true);
    });

    it("admin zero reverte", async function () {
      const Treasury = await ethers.getContractFactory("Treasury");
      await expect(Treasury.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Treasury,
        "ZeroAddress",
      );
    });
  });

  describe("transfer (ERC20)", function () {
    it("governanca transfere e emite evento", async function () {
      const { governance, recipient, treasury, token } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).transfer(await token.getAddress(), recipient.address, AMOUNT / 2n),
      )
        .to.emit(treasury, "TokenTransferred")
        .withArgs(await token.getAddress(), recipient.address, AMOUNT / 2n);
      expect(await token.balanceOf(recipient.address)).to.equal(AMOUNT / 2n);
      expect(await token.balanceOf(await treasury.getAddress())).to.equal(AMOUNT / 2n);
    });

    it("sem role reverte", async function () {
      const { stranger, recipient, treasury, token } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(stranger).transfer(await token.getAddress(), recipient.address, 1n),
      ).to.be.reverted;
    });

    it("bounds: zero address, zero amount, saldo insuficiente", async function () {
      const { governance, recipient, treasury, token } = await loadFixture(deployFixture);
      const t = await token.getAddress();
      await expect(
        treasury.connect(governance).transfer(t, ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
      await expect(
        treasury.connect(governance).transfer(t, recipient.address, 0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
      await expect(
        treasury.connect(governance).transfer(t, recipient.address, AMOUNT + 1n),
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });
  });

  describe("transferETH", function () {
    it("governanca transfere ETH e emite evento", async function () {
      const { admin, governance, recipient, treasury } = await loadFixture(deployFixture);
      await admin.sendTransaction({ to: await treasury.getAddress(), value: AMOUNT });
      const before = await ethers.provider.getBalance(recipient.address);
      await expect(treasury.connect(governance).transferETH(recipient.address, AMOUNT / 4n))
        .to.emit(treasury, "EthTransferred")
        .withArgs(recipient.address, AMOUNT / 4n);
      expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + AMOUNT / 4n);
    });

    it("bounds e saldo insuficiente revertem", async function () {
      const { governance, recipient, treasury } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).transferETH(ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
      await expect(
        treasury.connect(governance).transferETH(recipient.address, 0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
      await expect(
        treasury.connect(governance).transferETH(recipient.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });

    it("destinatario que rejeita ETH reverte", async function () {
      const { admin, governance, treasury, token } = await loadFixture(deployFixture);
      await admin.sendTransaction({ to: await treasury.getAddress(), value: AMOUNT });
      // ERC20Mock nao tem receive() payable — rejeita ETH.
      await expect(
        treasury.connect(governance).transferETH(await token.getAddress(), 1n),
      ).to.be.revertedWithCustomError(treasury, "EthTransferFailed");
    });
  });

  describe("receive / views", function () {
    it("aceita ETH com evento e reporta saldos", async function () {
      const { admin, treasury, token } = await loadFixture(deployFixture);
      await expect(admin.sendTransaction({ to: await treasury.getAddress(), value: 123n }))
        .to.emit(treasury, "EthReceived")
        .withArgs(admin.address, 123n);
      expect(await treasury.ethBalance()).to.equal(123n);
      expect(await treasury.balanceOf(await token.getAddress())).to.equal(AMOUNT);
    });
  });
});
