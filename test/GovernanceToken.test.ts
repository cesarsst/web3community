import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";

/**
 * GovernanceToken (GOV) test suite.
 *
 * Cobre:
 *  - Construção (parâmetros do constructor, metadata ERC20, cap imutável).
 *  - mint onlyOwner + cap enforcement (invariante econômica I1).
 *  - Ownable2Step (2-step transfer: proteção contra envio para endereço errado).
 *  - ERC20Votes (delegate, snapshot via getPastVotes — invariante I5).
 *  - ERC20Permit (EIP-2612 signature-based approval).
 *  - Custom errors com args esperados.
 *  - Events com args esperados.
 */
describe("GovernanceToken", function () {
  const CAP = 100_000_000n * 10n ** 18n; // 100M * 1e18
  const NAME = "Web3Community Governance";
  const SYMBOL = "GOV";

  async function deployFixture() {
    const [owner, treasury, team, publicSale, community, liquidity, alice, bob, carol] =
      await ethers.getSigners();

    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy(NAME, SYMBOL, owner.address);
    await gov.waitForDeployment();

    return {
      gov,
      owner,
      treasury,
      team,
      publicSale,
      community,
      liquidity,
      alice,
      bob,
      carol,
    };
  }

  describe("construction", function () {
    it("sets name, symbol, decimals and owner", async function () {
      const { gov, owner } = await loadFixture(deployFixture);
      expect(await gov.name()).to.equal(NAME);
      expect(await gov.symbol()).to.equal(SYMBOL);
      expect(await gov.decimals()).to.equal(18);
      expect(await gov.owner()).to.equal(owner.address);
    });

    it("exposes the hardcoded cap of 100M * 1e18", async function () {
      const { gov } = await loadFixture(deployFixture);
      expect(await gov.cap()).to.equal(CAP);
    });

    it("starts with zero total supply (no pre-mint)", async function () {
      const { gov } = await loadFixture(deployFixture);
      expect(await gov.totalSupply()).to.equal(0n);
    });

    it("reverts if deployed with zero address as initial owner", async function () {
      const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
      await expect(GovernanceToken.deploy(NAME, SYMBOL, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(GovernanceToken, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });
  });

  describe("mint", function () {
    it("owner can mint within the cap and emits Minted", async function () {
      const { gov, owner, treasury } = await loadFixture(deployFixture);
      const amount = 30_000_000n * 10n ** 18n; // 30M = treasury bucket

      await expect(gov.connect(owner).mint(treasury.address, amount, "treasury"))
        .to.emit(gov, "Minted")
        .withArgs(treasury.address, amount, "treasury");

      expect(await gov.balanceOf(treasury.address)).to.equal(amount);
      expect(await gov.totalSupply()).to.equal(amount);
    });

    it("owner can mint multiple buckets up to the cap", async function () {
      const { gov, owner, treasury, team, publicSale, community, liquidity } =
        await loadFixture(deployFixture);

      const buckets: [string, bigint, string][] = [
        [treasury.address, 30_000_000n * 10n ** 18n, "treasury"],
        [team.address, 25_000_000n * 10n ** 18n, "team"],
        [publicSale.address, 20_000_000n * 10n ** 18n, "publicSale"],
        [community.address, 15_000_000n * 10n ** 18n, "community"],
        [liquidity.address, 10_000_000n * 10n ** 18n, "liquidity"],
      ];

      for (const [to, amount, tag] of buckets) {
        await gov.connect(owner).mint(to, amount, tag);
      }

      expect(await gov.totalSupply()).to.equal(CAP);
      expect(await gov.balanceOf(treasury.address)).to.equal(30_000_000n * 10n ** 18n);
    });

    it("reverts when exceeding the cap (I1)", async function () {
      const { gov, owner, treasury } = await loadFixture(deployFixture);

      await gov.connect(owner).mint(treasury.address, CAP, "treasury");

      await expect(gov.connect(owner).mint(treasury.address, 1n, "over"))
        .to.be.revertedWithCustomError(gov, "CapExceeded")
        .withArgs(CAP + 1n, CAP);
    });

    it("reverts when a single mint alone exceeds the cap (I1)", async function () {
      const { gov, owner, treasury } = await loadFixture(deployFixture);

      await expect(gov.connect(owner).mint(treasury.address, CAP + 1n, "overflow"))
        .to.be.revertedWithCustomError(gov, "CapExceeded")
        .withArgs(CAP + 1n, CAP);
    });

    it("reverts when mint amount is zero", async function () {
      const { gov, owner, treasury } = await loadFixture(deployFixture);
      await expect(
        gov.connect(owner).mint(treasury.address, 0n, "treasury"),
      ).to.be.revertedWithCustomError(gov, "ZeroAmount");
    });

    it("reverts when mint recipient is zero address", async function () {
      const { gov, owner } = await loadFixture(deployFixture);
      await expect(gov.connect(owner).mint(ethers.ZeroAddress, 1n, "treasury"))
        .to.be.revertedWithCustomError(gov, "ZeroAddress")
        .withArgs();
    });

    it("reverts when non-owner tries to mint", async function () {
      const { gov, alice, bob } = await loadFixture(deployFixture);
      await expect(gov.connect(alice).mint(bob.address, 1n, "rogue"))
        .to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });
  });

  describe("ERC20 transfers", function () {
    it("transfers between users and updates balances", async function () {
      const { gov, owner, alice, bob } = await loadFixture(deployFixture);

      await gov.connect(owner).mint(alice.address, 1_000n * 10n ** 18n, "test");
      await gov.connect(alice).transfer(bob.address, 250n * 10n ** 18n);

      expect(await gov.balanceOf(alice.address)).to.equal(750n * 10n ** 18n);
      expect(await gov.balanceOf(bob.address)).to.equal(250n * 10n ** 18n);
    });
  });

  describe("Ownable2Step", function () {
    it("transferOwnership starts a pending transfer (not immediate)", async function () {
      const { gov, owner, alice } = await loadFixture(deployFixture);

      await expect(gov.connect(owner).transferOwnership(alice.address))
        .to.emit(gov, "OwnershipTransferStarted")
        .withArgs(owner.address, alice.address);

      expect(await gov.owner()).to.equal(owner.address);
      expect(await gov.pendingOwner()).to.equal(alice.address);
    });

    it("acceptOwnership must be called by pending owner", async function () {
      const { gov, owner, alice, bob } = await loadFixture(deployFixture);
      await gov.connect(owner).transferOwnership(alice.address);

      await expect(gov.connect(bob).acceptOwnership())
        .to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);

      await expect(gov.connect(alice).acceptOwnership())
        .to.emit(gov, "OwnershipTransferred")
        .withArgs(owner.address, alice.address);

      expect(await gov.owner()).to.equal(alice.address);
      expect(await gov.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it("old owner can no longer mint after successful transfer", async function () {
      const { gov, owner, alice, bob } = await loadFixture(deployFixture);
      await gov.connect(owner).transferOwnership(alice.address);
      await gov.connect(alice).acceptOwnership();

      await expect(gov.connect(owner).mint(bob.address, 1n, "rogue"))
        .to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
    });
  });

  describe("ERC20Votes (I5: snapshot-based voting power)", function () {
    it("balance does not grant voting power until delegation", async function () {
      const { gov, owner, alice } = await loadFixture(deployFixture);
      await gov.connect(owner).mint(alice.address, 1_000n * 10n ** 18n, "test");
      expect(await gov.getVotes(alice.address)).to.equal(0n);
    });

    it("self-delegation activates voting power", async function () {
      const { gov, owner, alice } = await loadFixture(deployFixture);
      await gov.connect(owner).mint(alice.address, 1_000n * 10n ** 18n, "test");

      await gov.connect(alice).delegate(alice.address);
      expect(await gov.getVotes(alice.address)).to.equal(1_000n * 10n ** 18n);
    });

    it("getPastVotes returns the snapshot at a past timepoint (flash-loan safety)", async function () {
      const { gov, owner, alice, bob } = await loadFixture(deployFixture);
      await gov.connect(owner).mint(alice.address, 1_000n * 10n ** 18n, "test");
      await gov.connect(alice).delegate(alice.address);
      await mine(); // checkpoint committed; advance so clock() > snapshot

      const snapshotBlock = (await ethers.provider.getBlockNumber()) - 1;

      // Alice moves tokens to Bob AFTER the snapshot.
      await gov.connect(alice).transfer(bob.address, 1_000n * 10n ** 18n);
      await mine();

      // Past snapshot still reflects Alice's voting power, not the live balance.
      expect(await gov.getPastVotes(alice.address, snapshotBlock)).to.equal(1_000n * 10n ** 18n);
      expect(await gov.getVotes(alice.address)).to.equal(0n);
    });

    it("uses block-number clock mode by default", async function () {
      const { gov } = await loadFixture(deployFixture);
      const currentBlock = BigInt(await ethers.provider.getBlockNumber());
      expect(await gov.clock()).to.equal(currentBlock);
      expect(await gov.CLOCK_MODE()).to.equal("mode=blocknumber&from=default");
    });

    it("delegation can be moved to another account", async function () {
      const { gov, owner, alice, bob } = await loadFixture(deployFixture);
      await gov.connect(owner).mint(alice.address, 500n * 10n ** 18n, "test");
      await gov.connect(alice).delegate(bob.address);
      expect(await gov.getVotes(bob.address)).to.equal(500n * 10n ** 18n);
      expect(await gov.getVotes(alice.address)).to.equal(0n);
    });

    it("numCheckpoints grows with voting-unit transfers", async function () {
      const { gov, owner, alice, bob } = await loadFixture(deployFixture);
      await gov.connect(owner).mint(alice.address, 1_000n * 10n ** 18n, "test");
      await gov.connect(alice).delegate(alice.address);
      const c1 = await gov.numCheckpoints(alice.address);
      await gov.connect(alice).transfer(bob.address, 100n * 10n ** 18n);
      const c2 = await gov.numCheckpoints(alice.address);
      expect(c2).to.equal(c1 + 1n);
    });
  });

  describe("ERC20Permit (EIP-2612)", function () {
    it("approves via signed permit", async function () {
      const { gov, owner, alice, bob } = await loadFixture(deployFixture);
      await gov.connect(owner).mint(alice.address, 1_000n * 10n ** 18n, "test");

      const value = 500n * 10n ** 18n;
      const deadline = (await time.latest()) + 3600;
      const nonce = await gov.nonces(alice.address);
      const domain = {
        name: NAME,
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await gov.getAddress(),
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const message = {
        owner: alice.address,
        spender: bob.address,
        value,
        nonce,
        deadline,
      };

      const sig = await alice.signTypedData(domain, types, message);
      const { v, r, s } = ethers.Signature.from(sig);

      await gov.permit(alice.address, bob.address, value, deadline, v, r, s);

      expect(await gov.allowance(alice.address, bob.address)).to.equal(value);
      expect(await gov.nonces(alice.address)).to.equal(nonce + 1n);
    });

    it("reverts on expired permit deadline", async function () {
      const { gov, alice, bob } = await loadFixture(deployFixture);

      const value = 1n;
      const deadline = 0; // far in the past
      const nonce = await gov.nonces(alice.address);
      const domain = {
        name: NAME,
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await gov.getAddress(),
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const sig = await alice.signTypedData(domain, types, {
        owner: alice.address,
        spender: bob.address,
        value,
        nonce,
        deadline,
      });
      const { v, r, s } = ethers.Signature.from(sig);

      await expect(
        gov.permit(alice.address, bob.address, value, deadline, v, r, s),
      ).to.be.revertedWithCustomError(gov, "ERC2612ExpiredSignature");
    });

    it("exposes DOMAIN_SEPARATOR matching EIP-712 domain", async function () {
      const { gov } = await loadFixture(deployFixture);
      const ds = await gov.DOMAIN_SEPARATOR();
      expect(ds).to.match(/^0x[0-9a-fA-F]{64}$/);
    });
  });
});
