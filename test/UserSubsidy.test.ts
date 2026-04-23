import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * UserSubsidy test suite.
 *
 * Cobre:
 *  - Construção (guards, roles).
 *  - createCampaign: happy, guards, governance-gated, ID monotônico.
 *  - claim: happy, proof inválido, deadline, already claimed, cap reached,
 *    double-hash leaf (padrão OZ), reentrancy-safe.
 *  - closeCampaign: happy (com/sem sobras), guards, governance-gated,
 *    antes e depois do deadline.
 *  - isEligible view: retorna corretamente em todos os estados.
 *  - Múltiplas campanhas coexistindo.
 */

/**
 * Constrói uma árvore de Merkle para endereços seguindo o padrão OZ:
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(addr))))
 *   nós internos pair-hashados com sort ascendente.
 */
function buildMerkleTree(addresses: string[]): {
  root: string;
  proofFor: (addr: string) => string[];
} {
  const leaves = addresses.map((addr) =>
    ethers.keccak256(
      ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr])),
    ),
  );

  // Níveis da árvore (layer 0 = leaves).
  const layers: string[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 === current.length) {
        // Nó ímpar sem par: promove (padrão OZ — o nó "solitário" sobe sem hash).
        next.push(current[i]);
      } else {
        const [a, b] =
          BigInt(current[i]) < BigInt(current[i + 1])
            ? [current[i], current[i + 1]]
            : [current[i + 1], current[i]];
        next.push(ethers.keccak256(ethers.concat([a, b])));
      }
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];

  return {
    root,
    proofFor: (addr: string) => {
      const leaf = ethers.keccak256(
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr])),
      );
      let index = leaves.indexOf(leaf);
      if (index < 0) throw new Error(`address ${addr} not in tree`);
      const proof: string[] = [];
      for (let lvl = 0; lvl < layers.length - 1; lvl++) {
        const layer = layers[lvl];
        const pairIndex = index ^ 1;
        if (pairIndex < layer.length) {
          proof.push(layer[pairIndex]);
        }
        index = Math.floor(index / 2);
      }
      return proof;
    },
  };
}

describe("UserSubsidy", function () {
  const AMOUNT_PER_USER = 100n * 10n ** 18n; // 100 CREDIT por claim
  const MAX_CLAIMS = 4;
  const DEADLINE_OFFSET = 30n * 24n * 60n * 60n; // 30 dias

  async function deployFixture() {
    const [admin, governance, treasury, u1, u2, u3, u4, outsider] = await ethers.getSigners();

    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("Web3Community Credit", "CREDIT", admin.address);
    await credit.waitForDeployment();

    // Genesis mint: 10M CREDIT pra "treasury" simulada (o signer treasury).
    await credit.connect(admin).mintGenesis(treasury.address, 10_000_000n * 10n ** 18n);

    const UserSubsidy = await ethers.getContractFactory("UserSubsidy");
    const subsidy = await UserSubsidy.deploy(await credit.getAddress(), admin.address);
    await subsidy.waitForDeployment();

    const GOVERNANCE_ROLE = await subsidy.GOVERNANCE_ROLE();
    const DEFAULT_ADMIN_ROLE = await subsidy.DEFAULT_ADMIN_ROLE();
    await subsidy.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

    // Funda o subsidy contract com orçamento da campanha de teste.
    const budget = BigInt(MAX_CLAIMS) * AMOUNT_PER_USER;
    await credit.connect(treasury).transfer(await subsidy.getAddress(), budget);

    // Árvore com 4 usuários elegíveis.
    const tree = buildMerkleTree([u1.address, u2.address, u3.address, u4.address]);

    return {
      credit,
      subsidy,
      admin,
      governance,
      treasury,
      u1,
      u2,
      u3,
      u4,
      outsider,
      tree,
      budget,
      GOVERNANCE_ROLE,
      DEFAULT_ADMIN_ROLE,
    };
  }

  async function futureDeadline(): Promise<bigint> {
    return BigInt(await time.latest()) + DEADLINE_OFFSET;
  }

  describe("construction", function () {
    it("sets credit token and grants roles to admin", async function () {
      const { subsidy, credit, admin, DEFAULT_ADMIN_ROLE, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      expect(await subsidy.credit()).to.equal(await credit.getAddress());
      expect(await subsidy.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await subsidy.hasRole(GOVERNANCE_ROLE, admin.address)).to.equal(true);
      expect(await subsidy.nextCampaignId()).to.equal(0n);
    });

    it("reverts on zero credit", async function () {
      const [admin] = await ethers.getSigners();
      const UserSubsidy = await ethers.getContractFactory("UserSubsidy");
      await expect(
        UserSubsidy.deploy(ethers.ZeroAddress, admin.address),
      ).to.be.revertedWithCustomError(UserSubsidy, "ZeroAddress");
    });

    it("reverts on zero admin", async function () {
      const [admin] = await ethers.getSigners();
      const CreditToken = await ethers.getContractFactory("CreditToken");
      const credit = await CreditToken.deploy("X", "X", admin.address);
      const UserSubsidy = await ethers.getContractFactory("UserSubsidy");
      await expect(
        UserSubsidy.deploy(await credit.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(UserSubsidy, "ZeroAddress");
    });
  });

  describe("createCampaign", function () {
    it("happy path: creates campaign, assigns monotonic ID, emits event", async function () {
      const { subsidy, governance, tree } = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await expect(
        subsidy
          .connect(governance)
          .createCampaign(tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline),
      )
        .to.emit(subsidy, "CampaignCreated")
        .withArgs(0n, tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);

      const c = await subsidy.campaigns(0);
      expect(c.merkleRoot).to.equal(tree.root);
      expect(c.amountPerUser).to.equal(AMOUNT_PER_USER);
      expect(c.maxClaims).to.equal(MAX_CLAIMS);
      expect(c.deadline).to.equal(deadline);
      expect(c.claimed).to.equal(0);
      expect(c.closed).to.equal(false);
      expect(await subsidy.nextCampaignId()).to.equal(1n);
    });

    it("creates multiple campaigns with incrementing IDs", async function () {
      const { subsidy, governance, tree } = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await subsidy
        .connect(governance)
        .createCampaign(tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);
      await subsidy
        .connect(governance)
        .createCampaign(tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);
      expect(await subsidy.nextCampaignId()).to.equal(2n);
    });

    it("only GOVERNANCE_ROLE can create", async function () {
      const { subsidy, outsider, tree } = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await expect(
        subsidy.connect(outsider).createCampaign(tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline),
      ).to.be.revertedWithCustomError(subsidy, "AccessControlUnauthorizedAccount");
    });

    it("reverts on zero root", async function () {
      const { subsidy, governance } = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await expect(
        subsidy
          .connect(governance)
          .createCampaign(ethers.ZeroHash, AMOUNT_PER_USER, MAX_CLAIMS, deadline),
      ).to.be.revertedWithCustomError(subsidy, "ZeroRoot");
    });

    it("reverts on zero amountPerUser", async function () {
      const { subsidy, governance, tree } = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await expect(
        subsidy.connect(governance).createCampaign(tree.root, 0, MAX_CLAIMS, deadline),
      ).to.be.revertedWithCustomError(subsidy, "ZeroAmount");
    });

    it("reverts on zero maxClaims", async function () {
      const { subsidy, governance, tree } = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await expect(
        subsidy.connect(governance).createCampaign(tree.root, AMOUNT_PER_USER, 0, deadline),
      ).to.be.revertedWithCustomError(subsidy, "ZeroMaxClaims");
    });

    it("reverts on deadline in past", async function () {
      const { subsidy, governance, tree } = await loadFixture(deployFixture);
      const past = BigInt(await time.latest()) - 1n;
      await expect(
        subsidy.connect(governance).createCampaign(tree.root, AMOUNT_PER_USER, MAX_CLAIMS, past),
      ).to.be.revertedWithCustomError(subsidy, "DeadlineInPast");
    });
  });

  describe("claim", function () {
    async function withCampaign() {
      const base = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await base.subsidy
        .connect(base.governance)
        .createCampaign(base.tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);
      return { ...base, campaignId: 0n, deadline };
    }

    it("happy path: transfers CREDIT, marks claimed, increments counter", async function () {
      const { subsidy, credit, u1, campaignId, tree } = await withCampaign();
      const proof = tree.proofFor(u1.address);

      await expect(subsidy.connect(u1).claim(campaignId, proof))
        .to.emit(subsidy, "Claimed")
        .withArgs(campaignId, u1.address, AMOUNT_PER_USER);

      expect(await credit.balanceOf(u1.address)).to.equal(AMOUNT_PER_USER);
      expect(await subsidy.hasClaimed(campaignId, u1.address)).to.equal(true);

      const c = await subsidy.campaigns(campaignId);
      expect(c.claimed).to.equal(1);
    });

    it("reverts on invalid proof (empty)", async function () {
      const { subsidy, u1, campaignId } = await withCampaign();
      await expect(subsidy.connect(u1).claim(campaignId, [])).to.be.revertedWithCustomError(
        subsidy,
        "InvalidProof",
      );
    });

    it("reverts on invalid proof (non-eligible caller with valid-user proof)", async function () {
      const { subsidy, outsider, u1, campaignId, tree } = await withCampaign();
      // Proof válido para u1, mas caller é outsider — leaf não bate.
      const proofForU1 = tree.proofFor(u1.address);
      await expect(
        subsidy.connect(outsider).claim(campaignId, proofForU1),
      ).to.be.revertedWithCustomError(subsidy, "InvalidProof");
    });

    it("reverts on already claimed", async function () {
      const { subsidy, u1, campaignId, tree } = await withCampaign();
      const proof = tree.proofFor(u1.address);
      await subsidy.connect(u1).claim(campaignId, proof);
      await expect(subsidy.connect(u1).claim(campaignId, proof)).to.be.revertedWithCustomError(
        subsidy,
        "AlreadyClaimed",
      );
    });

    it("reverts on expired campaign", async function () {
      const { subsidy, u1, campaignId, tree, deadline } = await withCampaign();
      await time.increaseTo(deadline + 1n);
      const proof = tree.proofFor(u1.address);
      await expect(subsidy.connect(u1).claim(campaignId, proof)).to.be.revertedWithCustomError(
        subsidy,
        "CampaignExpired",
      );
    });

    it("reverts on non-existent campaign", async function () {
      const { subsidy, u1, tree } = await loadFixture(deployFixture);
      const proof = tree.proofFor(u1.address);
      await expect(subsidy.connect(u1).claim(999, proof)).to.be.revertedWithCustomError(
        subsidy,
        "CampaignNotFound",
      );
    });

    it("reverts on closed campaign", async function () {
      const { subsidy, governance, treasury, u1, campaignId, tree } = await withCampaign();
      await subsidy.connect(governance).closeCampaign(campaignId, treasury.address);
      const proof = tree.proofFor(u1.address);
      await expect(subsidy.connect(u1).claim(campaignId, proof)).to.be.revertedWithCustomError(
        subsidy,
        "CampaignAlreadyClosed",
      );
    });

    it("enforces cap: when maxClaims reached, further claims revert", async function () {
      // Cria uma árvore com 4 elegíveis mas campanha com cap de 2.
      const base = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await base.subsidy
        .connect(base.governance)
        .createCampaign(base.tree.root, AMOUNT_PER_USER, 2, deadline);

      await base.subsidy.connect(base.u1).claim(0, base.tree.proofFor(base.u1.address));
      await base.subsidy.connect(base.u2).claim(0, base.tree.proofFor(base.u2.address));
      await expect(
        base.subsidy.connect(base.u3).claim(0, base.tree.proofFor(base.u3.address)),
      ).to.be.revertedWithCustomError(base.subsidy, "CapReached");
    });

    it("all eligible users can claim up to the cap", async function () {
      const { subsidy, credit, u1, u2, u3, u4, campaignId, tree } = await withCampaign();
      for (const u of [u1, u2, u3, u4]) {
        await subsidy.connect(u).claim(campaignId, tree.proofFor(u.address));
        expect(await credit.balanceOf(u.address)).to.equal(AMOUNT_PER_USER);
      }
      const c = await subsidy.campaigns(campaignId);
      expect(c.claimed).to.equal(4);
    });
  });

  describe("closeCampaign", function () {
    async function withCampaign() {
      const base = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await base.subsidy
        .connect(base.governance)
        .createCampaign(base.tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);
      return { ...base, campaignId: 0n, deadline };
    }

    it("returns full budget when no claims were exercised", async function () {
      const { subsidy, credit, governance, treasury, campaignId, budget } = await withCampaign();
      const treasuryBalBefore = await credit.balanceOf(treasury.address);

      await expect(subsidy.connect(governance).closeCampaign(campaignId, treasury.address))
        .to.emit(subsidy, "CampaignClosed")
        .withArgs(campaignId, treasury.address, budget);

      expect(await credit.balanceOf(treasury.address)).to.equal(treasuryBalBefore + budget);
      expect(await credit.balanceOf(await subsidy.getAddress())).to.equal(0n);

      const c = await subsidy.campaigns(campaignId);
      expect(c.closed).to.equal(true);
    });

    it("returns remaining budget when only partial claims", async function () {
      const { subsidy, credit, governance, treasury, u1, campaignId, tree } = await withCampaign();
      await subsidy.connect(u1).claim(campaignId, tree.proofFor(u1.address));

      const expectedRemaining = BigInt(MAX_CLAIMS - 1) * AMOUNT_PER_USER;
      await expect(subsidy.connect(governance).closeCampaign(campaignId, treasury.address))
        .to.emit(subsidy, "CampaignClosed")
        .withArgs(campaignId, treasury.address, expectedRemaining);

      // Treasury recebeu sobra; contrato zero.
      expect(await credit.balanceOf(await subsidy.getAddress())).to.equal(0n);
    });

    it("emits CampaignClosed with zero when all claims exercised", async function () {
      const { subsidy, governance, treasury, u1, u2, u3, u4, campaignId, tree } =
        await withCampaign();
      for (const u of [u1, u2, u3, u4]) {
        await subsidy.connect(u).claim(campaignId, tree.proofFor(u.address));
      }
      await expect(subsidy.connect(governance).closeCampaign(campaignId, treasury.address))
        .to.emit(subsidy, "CampaignClosed")
        .withArgs(campaignId, treasury.address, 0n);
    });

    it("can be called after deadline", async function () {
      const { subsidy, governance, treasury, campaignId, deadline } = await withCampaign();
      await time.increaseTo(deadline + 1n);
      await expect(subsidy.connect(governance).closeCampaign(campaignId, treasury.address)).to.not
        .be.reverted;
    });

    it("only GOVERNANCE_ROLE can close", async function () {
      const { subsidy, outsider, treasury, campaignId } = await withCampaign();
      await expect(
        subsidy.connect(outsider).closeCampaign(campaignId, treasury.address),
      ).to.be.revertedWithCustomError(subsidy, "AccessControlUnauthorizedAccount");
    });

    it("reverts on zero returnTo", async function () {
      const { subsidy, governance, campaignId } = await withCampaign();
      await expect(
        subsidy.connect(governance).closeCampaign(campaignId, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(subsidy, "ZeroAddress");
    });

    it("reverts on non-existent campaign", async function () {
      const { subsidy, governance, treasury } = await loadFixture(deployFixture);
      await expect(
        subsidy.connect(governance).closeCampaign(999, treasury.address),
      ).to.be.revertedWithCustomError(subsidy, "CampaignNotFound");
    });

    it("reverts if already closed", async function () {
      const { subsidy, governance, treasury, campaignId } = await withCampaign();
      await subsidy.connect(governance).closeCampaign(campaignId, treasury.address);
      await expect(
        subsidy.connect(governance).closeCampaign(campaignId, treasury.address),
      ).to.be.revertedWithCustomError(subsidy, "CampaignAlreadyClosed");
    });
  });

  describe("isEligible view", function () {
    async function withCampaign() {
      const base = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await base.subsidy
        .connect(base.governance)
        .createCampaign(base.tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);
      return { ...base, campaignId: 0n, deadline };
    }

    it("returns true for an eligible un-claimed user with valid proof", async function () {
      const { subsidy, u1, campaignId, tree } = await withCampaign();
      expect(await subsidy.isEligible(campaignId, u1.address, tree.proofFor(u1.address))).to.equal(
        true,
      );
    });

    it("returns false for non-existent campaign", async function () {
      const { subsidy, u1, tree } = await loadFixture(deployFixture);
      expect(await subsidy.isEligible(999, u1.address, tree.proofFor(u1.address))).to.equal(false);
    });

    it("returns false after user has claimed", async function () {
      const { subsidy, u1, campaignId, tree } = await withCampaign();
      await subsidy.connect(u1).claim(campaignId, tree.proofFor(u1.address));
      expect(await subsidy.isEligible(campaignId, u1.address, tree.proofFor(u1.address))).to.equal(
        false,
      );
    });

    it("returns false after deadline", async function () {
      const { subsidy, u1, campaignId, tree, deadline } = await withCampaign();
      await time.increaseTo(deadline + 1n);
      expect(await subsidy.isEligible(campaignId, u1.address, tree.proofFor(u1.address))).to.equal(
        false,
      );
    });

    it("returns false after campaign closed", async function () {
      const { subsidy, governance, treasury, u1, campaignId, tree } = await withCampaign();
      await subsidy.connect(governance).closeCampaign(campaignId, treasury.address);
      expect(await subsidy.isEligible(campaignId, u1.address, tree.proofFor(u1.address))).to.equal(
        false,
      );
    });

    it("returns false with invalid proof", async function () {
      const { subsidy, u1, campaignId } = await withCampaign();
      expect(await subsidy.isEligible(campaignId, u1.address, [])).to.equal(false);
    });

    it("returns false after cap reached (even with valid proof)", async function () {
      // Cobre o branch `c.claimed >= c.maxClaims` em isEligible — simetrico
      // ao CapReached da função claim. Cap de 1, u1 claim, u2 tenta isEligible
      // com proof valido mas cap ja atingido.
      const base = await loadFixture(deployFixture);
      const deadline = await futureDeadline();
      await base.subsidy
        .connect(base.governance)
        .createCampaign(base.tree.root, AMOUNT_PER_USER, 1, deadline);
      await base.subsidy.connect(base.u1).claim(0, base.tree.proofFor(base.u1.address));
      expect(
        await base.subsidy.isEligible(0, base.u2.address, base.tree.proofFor(base.u2.address)),
      ).to.equal(false);
    });
  });

  describe("multiple campaigns", function () {
    it("users can claim independently from different campaigns", async function () {
      const { subsidy, credit, governance, treasury, u1, u2, tree } =
        await loadFixture(deployFixture);
      const deadline = await futureDeadline();

      // Funda orçamento para uma segunda campanha também.
      const budget2 = BigInt(MAX_CLAIMS) * AMOUNT_PER_USER;
      await credit.connect(treasury).transfer(await subsidy.getAddress(), budget2);

      await subsidy
        .connect(governance)
        .createCampaign(tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);
      await subsidy
        .connect(governance)
        .createCampaign(tree.root, AMOUNT_PER_USER, MAX_CLAIMS, deadline);

      await subsidy.connect(u1).claim(0, tree.proofFor(u1.address));
      await subsidy.connect(u1).claim(1, tree.proofFor(u1.address));
      expect(await credit.balanceOf(u1.address)).to.equal(AMOUNT_PER_USER * 2n);
      expect(await subsidy.hasClaimed(0, u1.address)).to.equal(true);
      expect(await subsidy.hasClaimed(1, u1.address)).to.equal(true);

      // u2 também pode claim nas duas.
      await subsidy.connect(u2).claim(0, tree.proofFor(u2.address));
      await subsidy.connect(u2).claim(1, tree.proofFor(u2.address));
      expect(await credit.balanceOf(u2.address)).to.equal(AMOUNT_PER_USER * 2n);
    });
  });

  // --------------------------------------------------------------------
  // Reentrancy guard (defense-in-depth)
  // --------------------------------------------------------------------
  //
  // `credit` no UserSubsidy e imutavel e aponta para o CreditToken real em
  // producao, que NAO possui hooks reentrantes. O `nonReentrant` em
  // {claim} e {closeCampaign} e defensivo: blinda contra regressoes em
  // CREDIT ou contra deploys futuros que apontem o UserSubsidy para um
  // token com callback. Os testes abaixo instanciam um UserSubsidy com
  // um ERC-20 malicioso no lugar do CREDIT e confirmam que o guard revert
  // o ataque, cobrindo a branch de revert das linhas 288 e 331.
  describe("reentrancy guard (defense-in-depth)", function () {
    async function deployReentrantFixture() {
      const [admin, governance, u1] = await ethers.getSigners();

      const Mock = await ethers.getContractFactory("ReentrantCallMock");
      const evil = await Mock.deploy("Evil Credit", "ECR");
      await evil.waitForDeployment();

      const UserSubsidy = await ethers.getContractFactory("UserSubsidy");
      const subsidy = await UserSubsidy.deploy(await evil.getAddress(), admin.address);
      await subsidy.waitForDeployment();

      const GOVERNANCE_ROLE = await subsidy.GOVERNANCE_ROLE();
      await subsidy.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

      // Funda o subsidy com saldo suficiente para claims / closeCampaign
      // precisarem disparar safeTransfer.
      const tree = buildMerkleTree([u1.address, admin.address]);
      const amountPerUser = 100n * 10n ** 18n;
      const maxClaims = 2;
      const budget = BigInt(maxClaims) * amountPerUser;
      await evil.mint(await subsidy.getAddress(), budget);

      // Cria campanha.
      const deadline = BigInt(await time.latest()) + 7n * 24n * 60n * 60n;
      await subsidy
        .connect(governance)
        .createCampaign(tree.root, amountPerUser, maxClaims, deadline);

      return { subsidy, evil, admin, governance, u1, tree, amountPerUser };
    }

    it("blocks reentrant call into claim (defense-in-depth against hostile credit token)", async function () {
      const { subsidy, evil, u1, tree } = await loadFixture(deployReentrantFixture);
      const subsidyAddr = await subsidy.getAddress();

      // Durante safeTransfer ao u1 no claim, o mock tenta chamar claim de
      // novo no mesmo contrato. Filtro `triggerOnTo = u1` evita disparar
      // no seed/mint anterior.
      const proof = tree.proofFor(u1.address);
      const reentryData = subsidy.interface.encodeFunctionData("claim", [0, proof]);
      await evil.armCall(subsidyAddr, reentryData, subsidyAddr, u1.address);

      await expect(subsidy.connect(u1).claim(0, proof)).to.be.revertedWithCustomError(
        subsidy,
        "ReentrancyGuardReentrantCall",
      );
    });

    it("blocks cross-function reentry from claim into closeCampaign", async function () {
      const { subsidy, evil, admin, u1, tree } = await loadFixture(deployReentrantFixture);
      const subsidyAddr = await subsidy.getAddress();

      // Durante claim->safeTransfer, o mock tenta chamar closeCampaign.
      // Ataque parte de governance para passar access control. Usamos
      // msg.sender = governance na reentrada via call direto: o mock
      // executa `call` com o seu proprio msg.sender, que nao tem
      // GOVERNANCE_ROLE — para isolar *o guard*, concede o role ao mock.
      const GOVERNANCE_ROLE = await subsidy.GOVERNANCE_ROLE();
      await subsidy.connect(admin).grantRole(GOVERNANCE_ROLE, await evil.getAddress());

      const reentryData = subsidy.interface.encodeFunctionData("closeCampaign", [0, u1.address]);
      await evil.armCall(subsidyAddr, reentryData, subsidyAddr, u1.address);

      await expect(
        subsidy.connect(u1).claim(0, tree.proofFor(u1.address)),
      ).to.be.revertedWithCustomError(subsidy, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrant call into closeCampaign (defense-in-depth)", async function () {
      const { subsidy, evil, admin, governance, u1 } = await loadFixture(deployReentrantFixture);
      const subsidyAddr = await subsidy.getAddress();

      const GOVERNANCE_ROLE = await subsidy.GOVERNANCE_ROLE();
      await subsidy.connect(admin).grantRole(GOVERNANCE_ROLE, await evil.getAddress());

      // closeCampaign devolve sobras para `returnTo` = u1. Durante o
      // safeTransfer, o mock reentra na mesma closeCampaign.
      const reentryData = subsidy.interface.encodeFunctionData("closeCampaign", [0, u1.address]);
      await evil.armCall(subsidyAddr, reentryData, subsidyAddr, u1.address);

      await expect(
        subsidy.connect(governance).closeCampaign(0, u1.address),
      ).to.be.revertedWithCustomError(subsidy, "ReentrancyGuardReentrantCall");
    });
  });
});
