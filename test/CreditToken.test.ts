import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * CreditToken (CREDIT) test suite.
 *
 * Cobre:
 *  - Construção (metadata, admin inicial, supply zero, roles configuradas).
 *  - mintGenesis one-shot (segunda chamada reverte com GenesisAlreadyMinted).
 *  - MINTER_ROLE mint (happy + unauthorized + zero guards).
 *  - ERC20Burnable self-burn (holder queima o próprio saldo).
 *  - ERC20Burnable burnFrom (terceiros queimam com allowance — fluxo padrão).
 *  - BURNER_ROLE burnByRole sem allowance (flow atomico para BurnTracker — I2).
 *  - Supply elastico (sem cap: cunha acima de 10B sem reverter).
 *  - Access control (grant/revoke, adminRole, unauthorized paths).
 *  - Eventos com args esperados.
 *  - supportsInterface (ERC165 / IAccessControl).
 */
describe("CreditToken", function () {
  const NAME = "Web3Community Credit";
  const SYMBOL = "CREDIT";
  const GENESIS_AMOUNT = 10_000_000n * 10n ** 18n; // 10M

  async function deployFixture() {
    const [admin, minter, burner, treasury, alice, bob, carol, dave] = await ethers.getSigners();

    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy(NAME, SYMBOL, admin.address);
    await credit.waitForDeployment();

    const DEFAULT_ADMIN_ROLE = await credit.DEFAULT_ADMIN_ROLE();
    const MINTER_ROLE = await credit.MINTER_ROLE();
    const BURNER_ROLE = await credit.BURNER_ROLE();

    return {
      credit,
      admin,
      minter,
      burner,
      treasury,
      alice,
      bob,
      carol,
      dave,
      DEFAULT_ADMIN_ROLE,
      MINTER_ROLE,
      BURNER_ROLE,
    };
  }

  describe("construction", function () {
    it("sets name, symbol and decimals", async function () {
      const { credit } = await loadFixture(deployFixture);
      expect(await credit.name()).to.equal(NAME);
      expect(await credit.symbol()).to.equal(SYMBOL);
      expect(await credit.decimals()).to.equal(18);
    });

    it("starts with zero total supply (genesis not yet minted)", async function () {
      const { credit } = await loadFixture(deployFixture);
      expect(await credit.totalSupply()).to.equal(0n);
      expect(await credit.genesisMinted()).to.equal(false);
    });

    it("grants DEFAULT_ADMIN_ROLE to the initial admin", async function () {
      const { credit, admin, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);
      expect(await credit.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    });

    it("does not grant MINTER_ROLE or BURNER_ROLE to anyone by default", async function () {
      const { credit, admin, MINTER_ROLE, BURNER_ROLE } = await loadFixture(deployFixture);
      expect(await credit.hasRole(MINTER_ROLE, admin.address)).to.equal(false);
      expect(await credit.hasRole(BURNER_ROLE, admin.address)).to.equal(false);
    });

    it("exposes role identifiers matching the documented keccak hashes", async function () {
      const { credit } = await loadFixture(deployFixture);
      expect(await credit.MINTER_ROLE()).to.equal(ethers.id("MINTER_ROLE"));
      expect(await credit.BURNER_ROLE()).to.equal(ethers.id("BURNER_ROLE"));
    });

    it("reverts when deployed with zero address as initial admin", async function () {
      const CreditToken = await ethers.getContractFactory("CreditToken");
      await expect(
        CreditToken.deploy(NAME, SYMBOL, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(CreditToken, "ZeroAddress");
    });

    it("supports IAccessControl and IERC165 interfaces", async function () {
      const { credit } = await loadFixture(deployFixture);
      // IAccessControl interfaceId
      expect(await credit.supportsInterface("0x7965db0b")).to.equal(true);
      // IERC165 interfaceId
      expect(await credit.supportsInterface("0x01ffc9a7")).to.equal(true);
      // Random interfaceId -> false
      expect(await credit.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("mintGenesis (one-shot)", function () {
    it("admin can mint the genesis supply and flips the flag", async function () {
      const { credit, admin, treasury } = await loadFixture(deployFixture);

      await expect(credit.connect(admin).mintGenesis(treasury.address, GENESIS_AMOUNT))
        .to.emit(credit, "GenesisMinted")
        .withArgs(treasury.address, GENESIS_AMOUNT);

      expect(await credit.balanceOf(treasury.address)).to.equal(GENESIS_AMOUNT);
      expect(await credit.totalSupply()).to.equal(GENESIS_AMOUNT);
      expect(await credit.genesisMinted()).to.equal(true);
    });

    it("reverts on second call with GenesisAlreadyMinted", async function () {
      const { credit, admin, treasury } = await loadFixture(deployFixture);

      await credit.connect(admin).mintGenesis(treasury.address, GENESIS_AMOUNT);

      await expect(
        credit.connect(admin).mintGenesis(treasury.address, 1n),
      ).to.be.revertedWithCustomError(credit, "GenesisAlreadyMinted");
    });

    it("reverts when non-admin calls mintGenesis", async function () {
      const { credit, alice, treasury, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);

      await expect(credit.connect(alice).mintGenesis(treasury.address, GENESIS_AMOUNT))
        .to.be.revertedWithCustomError(credit, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, DEFAULT_ADMIN_ROLE);
    });

    it("reverts when genesis recipient is zero address", async function () {
      const { credit, admin } = await loadFixture(deployFixture);

      await expect(
        credit.connect(admin).mintGenesis(ethers.ZeroAddress, GENESIS_AMOUNT),
      ).to.be.revertedWithCustomError(credit, "ZeroAddress");
    });

    it("reverts when genesis amount is zero", async function () {
      const { credit, admin, treasury } = await loadFixture(deployFixture);

      await expect(
        credit.connect(admin).mintGenesis(treasury.address, 0n),
      ).to.be.revertedWithCustomError(credit, "ZeroAmount");
    });
  });

  describe("mint (MINTER_ROLE)", function () {
    it("MINTER_ROLE holder can mint and emits Minted", async function () {
      const { credit, admin, minter, alice, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);

      const amount = 1_000n * 10n ** 18n;
      await expect(credit.connect(minter).mint(alice.address, amount, "rewardRound:1"))
        .to.emit(credit, "Minted")
        .withArgs(alice.address, amount, "rewardRound:1");

      expect(await credit.balanceOf(alice.address)).to.equal(amount);
      expect(await credit.totalSupply()).to.equal(amount);
    });

    it("reverts when non-minter tries to mint", async function () {
      const { credit, alice, bob, MINTER_ROLE } = await loadFixture(deployFixture);

      await expect(credit.connect(alice).mint(bob.address, 1n, "rogue"))
        .to.be.revertedWithCustomError(credit, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, MINTER_ROLE);
    });

    it("admin without MINTER_ROLE cannot mint", async function () {
      const { credit, admin, alice, MINTER_ROLE } = await loadFixture(deployFixture);

      await expect(credit.connect(admin).mint(alice.address, 1n, "admin"))
        .to.be.revertedWithCustomError(credit, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, MINTER_ROLE);
    });

    it("reverts when minting to zero address", async function () {
      const { credit, admin, minter, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);

      await expect(
        credit.connect(minter).mint(ethers.ZeroAddress, 1n, "tag"),
      ).to.be.revertedWithCustomError(credit, "ZeroAddress");
    });

    it("reverts when minting zero amount", async function () {
      const { credit, admin, minter, alice, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);

      await expect(
        credit.connect(minter).mint(alice.address, 0n, "tag"),
      ).to.be.revertedWithCustomError(credit, "ZeroAmount");
    });

    it("supports elastic supply: can mint far beyond any fixed cap", async function () {
      const { credit, admin, minter, alice, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);

      // 10 bilhoes de CREDIT — muito acima de qualquer genesis pre-cunhado.
      const huge = 10_000_000_000n * 10n ** 18n;
      await credit.connect(minter).mint(alice.address, huge, "stress");

      expect(await credit.totalSupply()).to.equal(huge);
      expect(await credit.balanceOf(alice.address)).to.equal(huge);
    });
  });

  describe("ERC20Burnable self-burn (I2: burn no consumo)", function () {
    it("holder can burn its own balance via burn()", async function () {
      const { credit, admin, minter, alice, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      const amount = 1_000n * 10n ** 18n;
      await credit.connect(minter).mint(alice.address, amount, "seed");

      await credit.connect(alice).burn(amount / 2n);

      expect(await credit.balanceOf(alice.address)).to.equal(amount / 2n);
      expect(await credit.totalSupply()).to.equal(amount / 2n);
    });

    it("third party can burn via burnFrom with allowance", async function () {
      const { credit, admin, minter, alice, bob, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      const amount = 1_000n * 10n ** 18n;
      await credit.connect(minter).mint(alice.address, amount, "seed");

      await credit.connect(alice).approve(bob.address, amount);
      await credit.connect(bob).burnFrom(alice.address, amount);

      expect(await credit.balanceOf(alice.address)).to.equal(0n);
      expect(await credit.allowance(alice.address, bob.address)).to.equal(0n);
      expect(await credit.totalSupply()).to.equal(0n);
    });

    it("burnFrom reverts if allowance is insufficient", async function () {
      const { credit, admin, minter, alice, bob, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      const amount = 1_000n * 10n ** 18n;
      await credit.connect(minter).mint(alice.address, amount, "seed");

      await expect(credit.connect(bob).burnFrom(alice.address, amount))
        .to.be.revertedWithCustomError(credit, "ERC20InsufficientAllowance")
        .withArgs(bob.address, 0n, amount);
    });

    it("burn reverts when holder balance is insufficient", async function () {
      const { credit, alice } = await loadFixture(deployFixture);
      await expect(credit.connect(alice).burn(1n))
        .to.be.revertedWithCustomError(credit, "ERC20InsufficientBalance")
        .withArgs(alice.address, 0n, 1n);
    });
  });

  describe("burnByRole (BURNER_ROLE, sem allowance)", function () {
    it("BURNER_ROLE holder burns a user balance without allowance and emits BurnedByRole", async function () {
      const { credit, admin, minter, burner, alice, MINTER_ROLE, BURNER_ROLE } =
        await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      await credit.connect(admin).grantRole(BURNER_ROLE, burner.address);

      const amount = 500n * 10n ** 18n;
      await credit.connect(minter).mint(alice.address, amount, "seed");

      await expect(credit.connect(burner).burnByRole(alice.address, amount, "feeRouter:pay"))
        .to.emit(credit, "BurnedByRole")
        .withArgs(burner.address, alice.address, amount, "feeRouter:pay");

      expect(await credit.balanceOf(alice.address)).to.equal(0n);
      expect(await credit.totalSupply()).to.equal(0n);
    });

    it("does not consume allowance (by design — atomic consumption path)", async function () {
      const { credit, admin, minter, burner, alice, MINTER_ROLE, BURNER_ROLE } =
        await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      await credit.connect(admin).grantRole(BURNER_ROLE, burner.address);
      const amount = 100n * 10n ** 18n;
      await credit.connect(minter).mint(alice.address, amount, "seed");

      // Alice concede allowance pro burner mesmo assim — verificamos que NAO e consumida.
      await credit.connect(alice).approve(burner.address, amount);
      const before = await credit.allowance(alice.address, burner.address);

      await credit.connect(burner).burnByRole(alice.address, amount, "tag");

      const after = await credit.allowance(alice.address, burner.address);
      expect(before).to.equal(amount);
      expect(after).to.equal(amount); // inalterada
    });

    it("reverts when caller lacks BURNER_ROLE", async function () {
      const { credit, admin, minter, alice, bob, MINTER_ROLE, BURNER_ROLE } =
        await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      await credit.connect(minter).mint(alice.address, 1n, "seed");

      await expect(credit.connect(bob).burnByRole(alice.address, 1n, "rogue"))
        .to.be.revertedWithCustomError(credit, "AccessControlUnauthorizedAccount")
        .withArgs(bob.address, BURNER_ROLE);
    });

    it("reverts when target has insufficient balance", async function () {
      const { credit, admin, burner, alice, BURNER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(BURNER_ROLE, burner.address);

      await expect(credit.connect(burner).burnByRole(alice.address, 1n, "tag"))
        .to.be.revertedWithCustomError(credit, "ERC20InsufficientBalance")
        .withArgs(alice.address, 0n, 1n);
    });

    it("reverts on zero-address target", async function () {
      const { credit, admin, burner, BURNER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(BURNER_ROLE, burner.address);

      await expect(
        credit.connect(burner).burnByRole(ethers.ZeroAddress, 1n, "tag"),
      ).to.be.revertedWithCustomError(credit, "ZeroAddress");
    });

    it("reverts on zero amount", async function () {
      const { credit, admin, burner, alice, BURNER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(BURNER_ROLE, burner.address);

      await expect(
        credit.connect(burner).burnByRole(alice.address, 0n, "tag"),
      ).to.be.revertedWithCustomError(credit, "ZeroAmount");
    });
  });

  describe("AccessControl plumbing", function () {
    it("DEFAULT_ADMIN_ROLE is admin of MINTER_ROLE and BURNER_ROLE", async function () {
      const { credit, MINTER_ROLE, BURNER_ROLE, DEFAULT_ADMIN_ROLE } =
        await loadFixture(deployFixture);
      expect(await credit.getRoleAdmin(MINTER_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await credit.getRoleAdmin(BURNER_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
    });

    it("admin can revoke MINTER_ROLE and revoked account cannot mint anymore", async function () {
      const { credit, admin, minter, alice, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      await credit.connect(minter).mint(alice.address, 1n, "pre");

      await credit.connect(admin).revokeRole(MINTER_ROLE, minter.address);

      await expect(credit.connect(minter).mint(alice.address, 1n, "post"))
        .to.be.revertedWithCustomError(credit, "AccessControlUnauthorizedAccount")
        .withArgs(minter.address, MINTER_ROLE);
    });

    it("non-admin cannot grant roles", async function () {
      const { credit, alice, bob, MINTER_ROLE, DEFAULT_ADMIN_ROLE } =
        await loadFixture(deployFixture);
      await expect(credit.connect(alice).grantRole(MINTER_ROLE, bob.address))
        .to.be.revertedWithCustomError(credit, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, DEFAULT_ADMIN_ROLE);
    });

    it("account can renounce its own role", async function () {
      const { credit, admin, minter, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);

      await credit.connect(minter).renounceRole(MINTER_ROLE, minter.address);
      expect(await credit.hasRole(MINTER_ROLE, minter.address)).to.equal(false);
    });
  });

  describe("ERC20 transfers", function () {
    it("transfers between users update balances", async function () {
      const { credit, admin, minter, alice, bob, MINTER_ROLE } = await loadFixture(deployFixture);
      await credit.connect(admin).grantRole(MINTER_ROLE, minter.address);
      await credit.connect(minter).mint(alice.address, 1_000n * 10n ** 18n, "seed");

      await credit.connect(alice).transfer(bob.address, 250n * 10n ** 18n);

      expect(await credit.balanceOf(alice.address)).to.equal(750n * 10n ** 18n);
      expect(await credit.balanceOf(bob.address)).to.equal(250n * 10n ** 18n);
    });
  });
});
