import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Helper determinístico: minera um bloco EXATAMENTE no timestamp `t`.
 *
 * Racional: `time.increaseTo(X)` minera um bloco em X, mas qualquer
 * operação subsequente (view call, tx) pode ser avaliada em `X + 1`
 * dependendo de como o node calcula o timestamp do próximo contexto
 * de execução. Isso causa drift de 1s em asserts que comparam o valor
 * linear `vested(t) = total * (t - start) / duration` — com DURATION de
 * 4 anos, 1s de drift vira ~198 unidades em TOTAL = 25M × 1e18. Forçar
 * `setNextBlockTimestamp` + `mine` garante que `block.timestamp` lido
 * na próxima view chamada seja exatamente `t` (Hardhat usa o timestamp
 * do bloco `latest` para `eth_call` sem pending state).
 */
async function mineAt(t: bigint): Promise<void> {
  await time.setNextBlockTimestamp(t);
  await mine();
}

/**
 * TeamVesting test suite.
 *
 * Cobre:
 *  - Construção (imutáveis, guards, Ownable2Step).
 *  - Cronograma linear com cliff (antes/no/após cliff, após duration).
 *  - Curva linear intermediária (checkpoints em 1/4, 1/2, 3/4 da duração).
 *  - release() pull-based (happy, NothingToRelease, saques cumulativos).
 *  - revoke() one-shot: (a) antes do cliff → devolve tudo; (b) meio do
 *    cronograma → devolve unvested, congela fronteira; (c) após duration
 *    → nada a devolver, só congela.
 *  - Após revoke: beneficiário ainda pode sacar vested-unreleased.
 *  - Após revoke: mais transfers para o contrato NÃO aumentam vested.
 *  - Ownable2Step transferOwnership funciona.
 *  - Access control: revoke só onlyOwner; todas outras funções são públicas
 *    (pull-based).
 */
describe("TeamVesting", function () {
  const TOTAL = 25_000_000n * 10n ** 18n; // 25M GOV (bucket do time)
  const ONE_YEAR = 365n * 24n * 60n * 60n;
  const CLIFF = ONE_YEAR; // 1 ano
  const DURATION = 4n * ONE_YEAR; // 4 anos totais (cliff 1a + 3a linear)

  async function deployFixture() {
    const [owner, beneficiary, treasury, other, newOwner] = await ethers.getSigners();

    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy("Web3Community Governance", "GOV", owner.address);
    await gov.waitForDeployment();

    const start = BigInt(await time.latest()) + 60n; // começa em 60s

    const TeamVesting = await ethers.getContractFactory("TeamVesting");
    const vesting = await TeamVesting.deploy(
      await gov.getAddress(),
      beneficiary.address,
      start,
      CLIFF,
      DURATION,
      owner.address,
    );
    await vesting.waitForDeployment();

    // Owner cunha GOV e transfere para o contrato (funda).
    await gov.connect(owner).mint(await vesting.getAddress(), TOTAL, "team:vesting");

    return { gov, vesting, owner, beneficiary, treasury, other, newOwner, start };
  }

  describe("construction", function () {
    it("sets immutables correctly", async function () {
      const { vesting, gov, beneficiary, owner, start } = await loadFixture(deployFixture);
      expect(await vesting.token()).to.equal(await gov.getAddress());
      expect(await vesting.beneficiary()).to.equal(beneficiary.address);
      expect(await vesting.start()).to.equal(start);
      expect(await vesting.cliff()).to.equal(CLIFF);
      expect(await vesting.duration()).to.equal(DURATION);
      expect(await vesting.owner()).to.equal(owner.address);
      expect(await vesting.released()).to.equal(0n);
      expect(await vesting.revoked()).to.equal(false);
    });

    it("reverts on zero token", async function () {
      const [owner, beneficiary] = await ethers.getSigners();
      const TeamVesting = await ethers.getContractFactory("TeamVesting");
      await expect(
        TeamVesting.deploy(ethers.ZeroAddress, beneficiary.address, 1, 1, 2, owner.address),
      ).to.be.revertedWithCustomError(TeamVesting, "ZeroAddress");
    });

    it("reverts on zero beneficiary", async function () {
      const [owner] = await ethers.getSigners();
      const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
      const gov = await GovernanceToken.deploy("X", "X", owner.address);
      const TeamVesting = await ethers.getContractFactory("TeamVesting");
      await expect(
        TeamVesting.deploy(await gov.getAddress(), ethers.ZeroAddress, 1, 1, 2, owner.address),
      ).to.be.revertedWithCustomError(TeamVesting, "ZeroAddress");
    });

    it("reverts on zero duration", async function () {
      const [owner, beneficiary] = await ethers.getSigners();
      const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
      const gov = await GovernanceToken.deploy("X", "X", owner.address);
      const TeamVesting = await ethers.getContractFactory("TeamVesting");
      await expect(
        TeamVesting.deploy(await gov.getAddress(), beneficiary.address, 1, 0, 0, owner.address),
      ).to.be.revertedWithCustomError(TeamVesting, "ZeroDuration");
    });

    it("reverts when cliff > duration", async function () {
      const [owner, beneficiary] = await ethers.getSigners();
      const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
      const gov = await GovernanceToken.deploy("X", "X", owner.address);
      const TeamVesting = await ethers.getContractFactory("TeamVesting");
      await expect(
        TeamVesting.deploy(await gov.getAddress(), beneficiary.address, 1, 100, 50, owner.address),
      ).to.be.revertedWithCustomError(TeamVesting, "CliffExceedsDuration");
    });
  });

  describe("vesting schedule", function () {
    it("releasable is zero before start", async function () {
      const { vesting } = await loadFixture(deployFixture);
      expect(await vesting.releasable()).to.equal(0n);
    });

    it("releasable is zero just before cliff ends", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      await mineAt(start + CLIFF - 10n);
      expect(await vesting.releasable()).to.equal(0n);
    });

    it("at cliff, releasable is cliff/duration share (hockey stick)", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      await mineAt(start + CLIFF);
      // Expected = TOTAL * CLIFF / DURATION = TOTAL * 1/4 (CLIFF=1y, DURATION=4y)
      const expected = (TOTAL * CLIFF) / DURATION;
      expect(await vesting.releasable()).to.equal(expected);
    });

    it("vests linearly between cliff and end", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      // 50% da duração
      const half = start + DURATION / 2n;
      await mineAt(half);
      const expected = TOTAL / 2n;
      expect(await vesting.vestedAmount(half)).to.equal(expected);
      expect(await vesting.releasable()).to.equal(expected);
    });

    it("vests 75% at three-quarters of duration", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      const threeQ = start + (DURATION * 3n) / 4n;
      await mineAt(threeQ);
      const expected = (TOTAL * 3n) / 4n;
      expect(await vesting.releasable()).to.equal(expected);
    });

    it("fully vested at start + duration", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      await mineAt(start + DURATION);
      expect(await vesting.releasable()).to.equal(TOTAL);
    });

    it("stays fully vested well after end", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      await mineAt(start + DURATION + ONE_YEAR);
      expect(await vesting.releasable()).to.equal(TOTAL);
    });
  });

  describe("release()", function () {
    it("reverts with NothingToRelease before cliff", async function () {
      const { vesting } = await loadFixture(deployFixture);
      await expect(vesting.release()).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    });

    it("transfers vested amount to beneficiary at cliff and emits Released", async function () {
      const { vesting, gov, beneficiary, start } = await loadFixture(deployFixture);
      const expected = (TOTAL * CLIFF) / DURATION;
      await time.setNextBlockTimestamp(start + CLIFF);
      await expect(vesting.release())
        .to.emit(vesting, "Released")
        .withArgs(beneficiary.address, expected);
      expect(await gov.balanceOf(beneficiary.address)).to.equal(expected);
      expect(await vesting.released()).to.equal(expected);
    });

    it("allows cumulative releases over time", async function () {
      const { vesting, gov, beneficiary, start } = await loadFixture(deployFixture);
      // Primeiro saque no cliff (~25%)
      await time.setNextBlockTimestamp(start + CLIFF);
      await vesting.release();
      const firstBalance = await gov.balanceOf(beneficiary.address);

      // Saque em 50% da duração (total 50%)
      await time.setNextBlockTimestamp(start + DURATION / 2n);
      await vesting.release();
      expect(await gov.balanceOf(beneficiary.address)).to.equal(TOTAL / 2n);
      expect((await gov.balanceOf(beneficiary.address)) - firstBalance).to.be.gt(0n);

      // Saque final
      await time.setNextBlockTimestamp(start + DURATION);
      await vesting.release();
      expect(await gov.balanceOf(beneficiary.address)).to.equal(TOTAL);
      expect(await vesting.released()).to.equal(TOTAL);
    });

    it("can be called by anyone — funds always go to beneficiary", async function () {
      const { vesting, gov, beneficiary, other, start } = await loadFixture(deployFixture);
      await time.setNextBlockTimestamp(start + CLIFF);
      await vesting.connect(other).release();
      expect(await gov.balanceOf(beneficiary.address)).to.be.gt(0n);
      expect(await gov.balanceOf(other.address)).to.equal(0n);
    });

    it("reverts if called twice after fully vested (nothing more to release)", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      await time.setNextBlockTimestamp(start + DURATION);
      await vesting.release();
      await expect(vesting.release()).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    });
  });

  describe("revoke()", function () {
    it("only owner can revoke", async function () {
      const { vesting, other, treasury } = await loadFixture(deployFixture);
      await expect(vesting.connect(other).revoke(treasury.address)).to.be.revertedWithCustomError(
        vesting,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts on zero returnTo", async function () {
      const { vesting, owner } = await loadFixture(deployFixture);
      await expect(vesting.connect(owner).revoke(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vesting,
        "ZeroAddress",
      );
    });

    it("before cliff: returns everything, freezes vested at 0", async function () {
      const { vesting, gov, owner, treasury } = await loadFixture(deployFixture);
      await expect(vesting.connect(owner).revoke(treasury.address))
        .to.emit(vesting, "Revoked")
        .withArgs(treasury.address, TOTAL, 0n);
      expect(await gov.balanceOf(treasury.address)).to.equal(TOTAL);
      expect(await gov.balanceOf(await vesting.getAddress())).to.equal(0n);
      expect(await vesting.revoked()).to.equal(true);
      expect(await vesting.totalAllocatedAtRevoke()).to.equal(0n);
      expect(await vesting.releasable()).to.equal(0n);
    });

    it("mid-schedule: returns unvested, freezes vested fronteira, beneficiary can still claim vested", async function () {
      const { vesting, gov, owner, beneficiary, treasury, start } =
        await loadFixture(deployFixture);
      const expectedVested = TOTAL / 2n;
      const expectedUnvested = TOTAL - expectedVested;

      await time.setNextBlockTimestamp(start + DURATION / 2n);
      await expect(vesting.connect(owner).revoke(treasury.address))
        .to.emit(vesting, "Revoked")
        .withArgs(treasury.address, expectedUnvested, expectedVested);

      expect(await gov.balanceOf(treasury.address)).to.equal(expectedUnvested);
      expect(await vesting.totalAllocatedAtRevoke()).to.equal(expectedVested);

      // Beneficiário ainda pode sacar o que estava vested no momento do revoke.
      expect(await vesting.releasable()).to.equal(expectedVested);
      await vesting.release();
      expect(await gov.balanceOf(beneficiary.address)).to.equal(expectedVested);
      expect(await gov.balanceOf(await vesting.getAddress())).to.equal(0n);
    });

    it("mid-schedule after partial release: correct split accounts for already-released", async function () {
      const { vesting, gov, owner, beneficiary, treasury, start } =
        await loadFixture(deployFixture);
      // Beneficiário saca no cliff (~25%)
      await time.setNextBlockTimestamp(start + CLIFF);
      await vesting.release();
      const releasedAtCliff = (TOTAL * CLIFF) / DURATION;
      expect(await gov.balanceOf(beneficiary.address)).to.equal(releasedAtCliff);

      // Avança para 50% da duração e revoga
      const expectedVested = TOTAL / 2n;
      const unvested = TOTAL - expectedVested;
      await time.setNextBlockTimestamp(start + DURATION / 2n);
      await vesting.connect(owner).revoke(treasury.address);
      expect(await gov.balanceOf(treasury.address)).to.equal(unvested);

      // Beneficiário pode sacar a diferença vested - released
      await vesting.release();
      expect(await gov.balanceOf(beneficiary.address)).to.equal(expectedVested);
      expect(await vesting.released()).to.equal(expectedVested);
    });

    it("after duration: nothing to return, just freezes", async function () {
      const { vesting, gov, owner, treasury, start } = await loadFixture(deployFixture);
      await time.setNextBlockTimestamp(start + DURATION);
      await expect(vesting.connect(owner).revoke(treasury.address))
        .to.emit(vesting, "Revoked")
        .withArgs(treasury.address, 0n, TOTAL);
      expect(await gov.balanceOf(treasury.address)).to.equal(0n);
      expect(await vesting.releasable()).to.equal(TOTAL);
    });

    it("is one-shot (second call reverts)", async function () {
      const { vesting, owner, treasury } = await loadFixture(deployFixture);
      await vesting.connect(owner).revoke(treasury.address);
      await expect(vesting.connect(owner).revoke(treasury.address)).to.be.revertedWithCustomError(
        vesting,
        "AlreadyRevoked",
      );
    });

    it("after revoke, extra tokens sent to contract do NOT increase vested", async function () {
      const { vesting, gov, owner, beneficiary, treasury, start } =
        await loadFixture(deployFixture);
      await time.setNextBlockTimestamp(start + DURATION / 2n);
      await vesting.connect(owner).revoke(treasury.address);
      const frozen = await vesting.totalAllocatedAtRevoke();

      // Alguém envia mais GOV por engano
      await gov.connect(owner).mint(await vesting.getAddress(), 1_000_000n * 10n ** 18n, "oops");
      expect(await vesting.totalAllocatedAtRevoke()).to.equal(frozen);
      expect(await vesting.releasable()).to.equal(frozen);

      // Beneficiário saca exatamente `frozen`, contrato ainda segura o excess.
      await vesting.release();
      expect(await gov.balanceOf(beneficiary.address)).to.equal(frozen);
      expect(await gov.balanceOf(await vesting.getAddress())).to.equal(1_000_000n * 10n ** 18n);
    });
  });

  describe("Ownable2Step", function () {
    it("allows two-step ownership transfer", async function () {
      const { vesting, owner, newOwner } = await loadFixture(deployFixture);
      await vesting.connect(owner).transferOwnership(newOwner.address);
      expect(await vesting.owner()).to.equal(owner.address);
      expect(await vesting.pendingOwner()).to.equal(newOwner.address);

      await vesting.connect(newOwner).acceptOwnership();
      expect(await vesting.owner()).to.equal(newOwner.address);
    });

    it("old owner cannot revoke after ownership transfer completes", async function () {
      const { vesting, owner, newOwner, treasury } = await loadFixture(deployFixture);
      await vesting.connect(owner).transferOwnership(newOwner.address);
      await vesting.connect(newOwner).acceptOwnership();
      await expect(vesting.connect(owner).revoke(treasury.address)).to.be.revertedWithCustomError(
        vesting,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("totalAllocation view", function () {
    it("returns balance + released before revoke", async function () {
      const { vesting, start } = await loadFixture(deployFixture);
      expect(await vesting.totalAllocation()).to.equal(TOTAL);
      await time.setNextBlockTimestamp(start + CLIFF);
      await vesting.release();
      expect(await vesting.totalAllocation()).to.equal(TOTAL);
    });

    it("returns frozen vested after revoke", async function () {
      const { vesting, owner, treasury, start } = await loadFixture(deployFixture);
      await time.setNextBlockTimestamp(start + DURATION / 2n);
      await vesting.connect(owner).revoke(treasury.address);
      expect(await vesting.totalAllocation()).to.equal(TOTAL / 2n);
    });
  });
});
