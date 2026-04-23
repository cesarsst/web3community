import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Staking test suite.
 *
 * Cobre as 16 invariantes descritas na spec da fase 3:
 *   1. Lock minimo (<14d revert).
 *   2. Lock maximo (>365d sem revert; multiplier saturado em 4x).
 *   3. Multiplier linear (14d=1x, 189d~2.5x, 365d=4x).
 *   4. Peso = amount * multiplier / 1e18.
 *   5. Agregados corretos (totalStakedByProject, totalWeightByProject, totalStaked).
 *   6. Consolidacao Opcao B.
 *   7. extendLock so aumenta.
 *   8. extendLock preserva lockStartAt.
 *   9. increaseStake preserva lock (start + duration).
 *  10. unstake respeita lock.
 *  11. unstake bypass em Removed.
 *  12. unstake NAO bypass em Probation (so Removed).
 *  13. stake bloqueado em Probation/Removed.
 *  14. Snapshot historico (getWeightAt / getTotalWeightAt).
 *  15. Reentrancia (ERC20 malicioso reentra em stake e unstake).
 *  16. Guards (ZeroAmount, ZeroAddress, InsufficientStake, PositionNotFound).
 *
 * Alem disso, cobertura completa de acesso, views, eventos e erros customizados.
 */
describe("Staking", function () {
  const GOV_NAME = "Web3Community Governance";
  const GOV_SYMBOL = "GOV";
  const MIN_COLLATERAL = 10_000n * 10n ** 18n; // 10k GOV
  const PROBATION_DURATION = 30n * 24n * 60n * 60n; // 30 dias
  const METADATA_URI = "ipfs://QmStakingTestProject";

  // Parametros economicos do Staking.
  const MIN_LOCK = 14n * 24n * 60n * 60n; // 14d
  const MAX_LOCK = 365n * 24n * 60n * 60n; // 365d
  const PRECISION = 10n ** 18n;
  const MAX_MULT = 4n * PRECISION;

  // Amount padrao usado em muitos testes.
  const AMOUNT = 1_000n * 10n ** 18n; // 1k GOV

  async function deployFixture() {
    const [admin, governance, alice, bob, carol, dave, projOwner, other] =
      await ethers.getSigners();

    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy(GOV_NAME, GOV_SYMBOL, admin.address);
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

    const Staking = await ethers.getContractFactory("Staking");
    const staking = await Staking.deploy(await gov.getAddress(), await registry.getAddress());
    await staking.waitForDeployment();

    // Seed: alice/bob/carol recebem GOV para stake. projOwner recebe para colateral.
    const seed = 1_000_000n * 10n ** 18n;
    for (const s of [alice, bob, carol, dave, projOwner]) {
      await gov.connect(admin).mint(s.address, seed, "seed");
    }

    // Registra e ativa projeto 1 (Active). projOwner aprova colateral ao registry.
    await gov.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL * 3n);
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI, MIN_COLLATERAL);
    await registry.connect(governance).activateProject(1);

    // Projeto 2: ativo tambem (para testes multi-projeto).
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-2", MIN_COLLATERAL);
    await registry.connect(governance).activateProject(2);

    // Projeto 3: registrado mas nao ativado (status = Pending).
    await registry
      .connect(governance)
      .registerProject(projOwner.address, METADATA_URI + "-3", MIN_COLLATERAL);

    // Aprovacoes amplas dos stakers para o Staking.
    const stakingAddr = await staking.getAddress();
    for (const s of [alice, bob, carol, dave]) {
      await gov.connect(s).approve(stakingAddr, seed);
    }

    return {
      gov,
      registry,
      staking,
      admin,
      governance,
      alice,
      bob,
      carol,
      dave,
      projOwner,
      other,
    };
  }

  /** Helper: calcula multiplier (JS mirror da logica on-chain). */
  function mult(duration: bigint): bigint {
    if (duration < MIN_LOCK) throw new Error("duration < MIN_LOCK in helper");
    if (duration >= MAX_LOCK) return MAX_MULT;
    const delta = duration - MIN_LOCK;
    const slope = MAX_MULT - PRECISION;
    return PRECISION + (delta * slope) / (MAX_LOCK - MIN_LOCK);
  }

  /** Helper: peso esperado = amount * multiplier / 1e18. */
  function weight(amount: bigint, duration: bigint): bigint {
    return (amount * mult(duration)) / PRECISION;
  }

  // ------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------

  describe("construction", function () {
    it("sets immutables and initial state", async function () {
      const { staking, gov, registry } = await loadFixture(deployFixture);
      expect(await staking.GOV_TOKEN()).to.equal(await gov.getAddress());
      expect(await staking.REGISTRY()).to.equal(await registry.getAddress());
      expect(await staking.totalStaked()).to.equal(0n);
      expect(await staking.MIN_LOCK()).to.equal(MIN_LOCK);
      expect(await staking.MAX_LOCK()).to.equal(MAX_LOCK);
      expect(await staking.MULTIPLIER_PRECISION()).to.equal(PRECISION);
      expect(await staking.MAX_MULTIPLIER()).to.equal(MAX_MULT);
    });

    it("reverts when gov token is zero", async function () {
      const { registry } = await loadFixture(deployFixture);
      const Staking = await ethers.getContractFactory("Staking");
      await expect(
        Staking.deploy(ethers.ZeroAddress, await registry.getAddress()),
      ).to.be.revertedWithCustomError(Staking, "ZeroAddress");
    });

    it("reverts when registry is zero", async function () {
      const { gov } = await loadFixture(deployFixture);
      const Staking = await ethers.getContractFactory("Staking");
      await expect(
        Staking.deploy(await gov.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(Staking, "ZeroAddress");
    });
  });

  // ------------------------------------------------------------------
  // multiplier() pure fn — Invariantes 1, 2, 3
  // ------------------------------------------------------------------

  describe("multiplier (pure)", function () {
    it("reverts for lockDuration < MIN_LOCK (I1)", async function () {
      const { staking } = await loadFixture(deployFixture);
      await expect(staking.multiplier(MIN_LOCK - 1n))
        .to.be.revertedWithCustomError(staking, "LockTooShort")
        .withArgs(MIN_LOCK - 1n, MIN_LOCK);
    });

    it("returns 1x at MIN_LOCK (I3)", async function () {
      const { staking } = await loadFixture(deployFixture);
      expect(await staking.multiplier(MIN_LOCK)).to.equal(PRECISION);
    });

    it("returns 4x at MAX_LOCK (I3)", async function () {
      const { staking } = await loadFixture(deployFixture);
      expect(await staking.multiplier(MAX_LOCK)).to.equal(MAX_MULT);
    });

    it("saturates at MAX_MULTIPLIER for duration > MAX_LOCK (I2)", async function () {
      const { staking } = await loadFixture(deployFixture);
      expect(await staking.multiplier(MAX_LOCK + 1n)).to.equal(MAX_MULT);
      expect(await staking.multiplier(MAX_LOCK * 2n)).to.equal(MAX_MULT);
    });

    it("is linear in between (I3 — midpoint)", async function () {
      const { staking } = await loadFixture(deployFixture);
      const midpoint = (MIN_LOCK + MAX_LOCK) / 2n;
      // Esperado: PRECISION + slope/2 = 1e18 + (3e18)/2 = 2.5e18
      const expected = PRECISION + (MAX_MULT - PRECISION) / 2n;
      expect(await staking.multiplier(midpoint)).to.equal(expected);
    });

    it("linear at 189 days ~ 2.5x", async function () {
      const { staking } = await loadFixture(deployFixture);
      const d = 189n * 24n * 60n * 60n;
      expect(await staking.multiplier(d)).to.equal(mult(d));
    });
  });

  // ------------------------------------------------------------------
  // stake() — happy + consolidation + guards
  // ------------------------------------------------------------------

  describe("stake", function () {
    it("creates new position with Staked event and correct weight (I4)", async function () {
      const { staking, gov, alice } = await loadFixture(deployFixture);
      const duration = MAX_LOCK; // 4x multiplier

      const tx = await staking.connect(alice).stake(1, AMOUNT, duration);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const nowTs = BigInt(block!.timestamp);
      const expectedWeight = weight(AMOUNT, duration);

      await expect(tx)
        .to.emit(staking, "Staked")
        .withArgs(alice.address, 1, AMOUNT, duration, nowTs, expectedWeight);

      const pos = await staking.getPosition(alice.address, 1);
      expect(pos.amount).to.equal(AMOUNT);
      expect(pos.lockDuration).to.equal(duration);
      expect(pos.lockStartAt).to.equal(nowTs);

      expect(await staking.getWeight(alice.address, 1)).to.equal(expectedWeight);
      expect(await staking.getTotalWeight(1)).to.equal(expectedWeight);
      expect(await staking.totalStakedByProject(1)).to.equal(AMOUNT);
      expect(await staking.totalStaked()).to.equal(AMOUNT);
      expect(await gov.balanceOf(await staking.getAddress())).to.equal(AMOUNT);
    });

    it("reverts on zero amount", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).stake(1, 0n, MIN_LOCK)).to.be.revertedWithCustomError(
        staking,
        "ZeroAmount",
      );
    });

    it("reverts when lockDuration < MIN_LOCK (I1)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).stake(1, AMOUNT, MIN_LOCK - 1n))
        .to.be.revertedWithCustomError(staking, "LockTooShort")
        .withArgs(MIN_LOCK - 1n, MIN_LOCK);
    });

    it("accepts lockDuration > MAX_LOCK; multiplier saturates (I2)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      const longDuration = MAX_LOCK + 30n * 24n * 60n * 60n; // 395 dias
      await staking.connect(alice).stake(1, AMOUNT, longDuration);
      const expectedWeight = weight(AMOUNT, longDuration); // = weight at MAX_LOCK (4x)
      expect(await staking.getWeight(alice.address, 1)).to.equal(expectedWeight);
      const pos = await staking.getPosition(alice.address, 1);
      // Duracao preservada literalmente (nao truncada).
      expect(pos.lockDuration).to.equal(longDuration);
    });

    it("reverts when project is Pending (I13)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      // project 3 = Pending (nunca ativado no fixture)
      await expect(staking.connect(alice).stake(3, AMOUNT, MIN_LOCK))
        .to.be.revertedWithCustomError(staking, "ProjectNotActive")
        .withArgs(3);
    });

    it("reverts when project is Probation (I13)", async function () {
      const { staking, registry, governance, alice } = await loadFixture(deployFixture);
      await registry.connect(governance).setProbation(1);
      await expect(staking.connect(alice).stake(1, AMOUNT, MIN_LOCK))
        .to.be.revertedWithCustomError(staking, "ProjectNotActive")
        .withArgs(1);
    });

    it("reverts when project is Removed (I13)", async function () {
      const { staking, registry, governance, alice, admin } = await loadFixture(deployFixture);
      await registry.connect(governance).removeProject(1, false, admin.address);
      await expect(staking.connect(alice).stake(1, AMOUNT, MIN_LOCK))
        .to.be.revertedWithCustomError(staking, "ProjectNotActive")
        .withArgs(1);
    });

    it("reverts when project does not exist", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).stake(9999, AMOUNT, MIN_LOCK))
        .to.be.revertedWithCustomError(staking, "ProjectNotActive")
        .withArgs(9999);
    });

    it("consolidates existing position with Opcao B (I6 — max, reset start)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      // Primeiro stake: 1k GOV, 60d.
      const firstDuration = 60n * 24n * 60n * 60n;
      await staking.connect(alice).stake(1, AMOUNT, firstDuration);
      const posA = await staking.getPosition(alice.address, 1);
      const firstStart = posA.lockStartAt;

      // Avanca 10 dias. Remaining = 50d.
      await time.increase(10 * 24 * 60 * 60);

      // Segundo stake: adiciona 500 GOV com novo lock de 30d (< remaining 50d).
      const addAmount = 500n * 10n ** 18n;
      const addDuration = 30n * 24n * 60n * 60n;

      const tx = await staking.connect(alice).stake(1, addAmount, addDuration);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const nowTs = BigInt(block!.timestamp);

      // Remaining esperado = firstStart + firstDuration - now
      const remaining = firstStart + firstDuration - nowTs;
      const expectedNewLock = remaining; // max(remaining, 30d) = remaining (> 30d)

      const pos = await staking.getPosition(alice.address, 1);
      expect(pos.amount).to.equal(AMOUNT + addAmount);
      expect(pos.lockStartAt).to.equal(nowTs); // reset para now
      expect(pos.lockDuration).to.equal(expectedNewLock);

      const expectedWeight = weight(pos.amount, expectedNewLock);
      expect(await staking.getWeight(alice.address, 1)).to.equal(expectedWeight);
    });

    it("consolidation picks newLockDuration when greater than remaining", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK); // lock de 14d
      await time.increase(5 * 24 * 60 * 60); // 5d passados; remaining = 9d

      // Novo stake com 30d — deve vencer o max.
      const newLock = 30n * 24n * 60n * 60n;
      await staking.connect(alice).stake(1, AMOUNT, newLock);
      const pos = await staking.getPosition(alice.address, 1);
      expect(pos.lockDuration).to.equal(newLock);
    });

    it("consolidation with expired lock: remaining is 0, adopts newLockDuration", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK); // 14d
      await time.increase(20 * 24 * 60 * 60); // 20d — lock expirou

      await staking.connect(alice).stake(1, AMOUNT, 30n * 24n * 60n * 60n);
      const pos = await staking.getPosition(alice.address, 1);
      expect(pos.lockDuration).to.equal(30n * 24n * 60n * 60n);
    });

    it("supports stake in multiple projects simultaneously (independent positions)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await staking.connect(alice).stake(2, AMOUNT * 2n, MAX_LOCK);

      const p1 = await staking.getPosition(alice.address, 1);
      const p2 = await staking.getPosition(alice.address, 2);
      expect(p1.amount).to.equal(AMOUNT);
      expect(p2.amount).to.equal(AMOUNT * 2n);
      expect(p1.lockDuration).to.equal(MIN_LOCK);
      expect(p2.lockDuration).to.equal(MAX_LOCK);
      expect(await staking.totalStaked()).to.equal(AMOUNT + AMOUNT * 2n);
    });

    it("aggregates correctly across multiple stakers (I5)", async function () {
      const { staking, alice, bob, carol } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await staking.connect(bob).stake(1, AMOUNT * 2n, MAX_LOCK);
      await staking.connect(carol).stake(1, AMOUNT * 3n, (MIN_LOCK + MAX_LOCK) / 2n);

      const expectedTotal = AMOUNT + AMOUNT * 2n + AMOUNT * 3n;
      const expectedWeight =
        weight(AMOUNT, MIN_LOCK) +
        weight(AMOUNT * 2n, MAX_LOCK) +
        weight(AMOUNT * 3n, (MIN_LOCK + MAX_LOCK) / 2n);

      expect(await staking.totalStakedByProject(1)).to.equal(expectedTotal);
      expect(await staking.totalStaked()).to.equal(expectedTotal);
      expect(await staking.getTotalWeight(1)).to.equal(expectedWeight);
    });
  });

  // ------------------------------------------------------------------
  // increaseStake — I9
  // ------------------------------------------------------------------

  describe("increaseStake", function () {
    it("adds amount preserving lockStartAt and lockDuration (I9)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      const posBefore = await staking.getPosition(alice.address, 1);

      await time.increase(5 * 24 * 60 * 60);

      const add = 500n * 10n ** 18n;
      const tx = await staking.connect(alice).increaseStake(1, add);
      const newAmount = AMOUNT + add;
      const expectedWeight = weight(newAmount, MAX_LOCK);
      await expect(tx)
        .to.emit(staking, "StakeIncreased")
        .withArgs(alice.address, 1, add, newAmount, expectedWeight);

      const posAfter = await staking.getPosition(alice.address, 1);
      expect(posAfter.amount).to.equal(newAmount);
      expect(posAfter.lockStartAt).to.equal(posBefore.lockStartAt); // preservado
      expect(posAfter.lockDuration).to.equal(posBefore.lockDuration); // preservado
      expect(await staking.totalStakedByProject(1)).to.equal(newAmount);
      expect(await staking.totalStaked()).to.equal(newAmount);
    });

    it("reverts on zero amount", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      await expect(staking.connect(alice).increaseStake(1, 0n)).to.be.revertedWithCustomError(
        staking,
        "ZeroAmount",
      );
    });

    it("reverts when position does not exist", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).increaseStake(1, AMOUNT))
        .to.be.revertedWithCustomError(staking, "PositionNotFound")
        .withArgs(alice.address, 1);
    });

    it("reverts when project is no longer Active (I13)", async function () {
      const { staking, registry, governance, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      await registry.connect(governance).setProbation(1);
      await expect(staking.connect(alice).increaseStake(1, AMOUNT))
        .to.be.revertedWithCustomError(staking, "ProjectNotActive")
        .withArgs(1);
    });

    it("does not re-open an expired lock (semantics: use stake() to reset start)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      // Stake com MIN_LOCK.
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      const posBefore = await staking.getPosition(alice.address, 1);

      // Avanca alem do lock — posicao ja unlocked.
      await time.increase(Number(MIN_LOCK) + 60);
      expect(await staking.isUnlocked(alice.address, 1)).to.equal(true);

      // increaseStake preserva lockStartAt e lockDuration; nao reabre o lock.
      await staking.connect(alice).increaseStake(1, AMOUNT);
      const posAfter = await staking.getPosition(alice.address, 1);
      expect(posAfter.lockStartAt).to.equal(posBefore.lockStartAt);
      expect(posAfter.lockDuration).to.equal(posBefore.lockDuration);
      // Posicao continua unlocked (usuario pode unstake imediatamente).
      expect(await staking.isUnlocked(alice.address, 1)).to.equal(true);
    });
  });

  // ------------------------------------------------------------------
  // extendLock — I7, I8
  // ------------------------------------------------------------------

  describe("extendLock", function () {
    it("increases lockDuration preserving lockStartAt (I8)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      const firstDuration = 30n * 24n * 60n * 60n;
      await staking.connect(alice).stake(1, AMOUNT, firstDuration);
      const posBefore = await staking.getPosition(alice.address, 1);

      const newDuration = 60n * 24n * 60n * 60n;
      const expectedWeight = weight(AMOUNT, newDuration);
      await expect(staking.connect(alice).extendLock(1, newDuration))
        .to.emit(staking, "LockExtended")
        .withArgs(alice.address, 1, newDuration, expectedWeight);

      const posAfter = await staking.getPosition(alice.address, 1);
      expect(posAfter.lockDuration).to.equal(newDuration);
      expect(posAfter.lockStartAt).to.equal(posBefore.lockStartAt);
      expect(posAfter.amount).to.equal(AMOUNT);
    });

    it("reverts when shortening (I7 — new <= current)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, 60n * 24n * 60n * 60n);
      // Mesma duracao — reverte.
      await expect(staking.connect(alice).extendLock(1, 60n * 24n * 60n * 60n))
        .to.be.revertedWithCustomError(staking, "CannotShortenLock")
        .withArgs(60n * 24n * 60n * 60n, 60n * 24n * 60n * 60n);
      // Menor — reverte.
      await expect(staking.connect(alice).extendLock(1, 30n * 24n * 60n * 60n))
        .to.be.revertedWithCustomError(staking, "CannotShortenLock")
        .withArgs(60n * 24n * 60n * 60n, 30n * 24n * 60n * 60n);
    });

    it("reverts when position does not exist", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).extendLock(1, MAX_LOCK))
        .to.be.revertedWithCustomError(staking, "PositionNotFound")
        .withArgs(alice.address, 1);
    });

    it("re-activates an expired lock when extended past now", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      // Avanca alem do lock — posicao expirou.
      await time.increase(Number(MIN_LOCK) + 60);
      expect(await staking.isUnlocked(alice.address, 1)).to.equal(true);

      // Extend para MAX_LOCK — unlockAt = lockStartAt + MAX_LOCK, que fica
      // no futuro (MAX_LOCK >> MIN_LOCK + 60s).
      await staking.connect(alice).extendLock(1, MAX_LOCK);
      expect(await staking.isUnlocked(alice.address, 1)).to.equal(false);

      // unstake agora deve bloquear com LockNotExpired.
      await expect(staking.connect(alice).unstake(1, AMOUNT)).to.be.revertedWithCustomError(
        staking,
        "LockNotExpired",
      );
    });
  });

  // ------------------------------------------------------------------
  // unstake / unstakeAll — I10, I11, I12, I16
  // ------------------------------------------------------------------

  describe("unstake", function () {
    it("reverts while lock is active (I10)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await expect(staking.connect(alice).unstake(1, AMOUNT)).to.be.revertedWithCustomError(
        staking,
        "LockNotExpired",
      );
    });

    it("allows partial unstake after lock expiry, keeps position", async function () {
      const { staking, gov, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));

      const half = AMOUNT / 2n;
      const expectedWeight = weight(half, MIN_LOCK);
      const aliceBalBefore = await gov.balanceOf(alice.address);

      await expect(staking.connect(alice).unstake(1, half))
        .to.emit(staking, "Unstaked")
        .withArgs(alice.address, 1, half, AMOUNT - half, expectedWeight);

      const pos = await staking.getPosition(alice.address, 1);
      expect(pos.amount).to.equal(AMOUNT - half);
      expect(await staking.totalStakedByProject(1)).to.equal(AMOUNT - half);
      expect(await staking.totalStaked()).to.equal(AMOUNT - half);
      expect(await gov.balanceOf(alice.address)).to.equal(aliceBalBefore + half);
    });

    it("deletes position when unstaking full amount", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));

      await expect(staking.connect(alice).unstake(1, AMOUNT))
        .to.emit(staking, "Unstaked")
        .withArgs(alice.address, 1, AMOUNT, 0n, 0n);

      const pos = await staking.getPosition(alice.address, 1);
      expect(pos.amount).to.equal(0n);
      expect(pos.lockStartAt).to.equal(0n);
      expect(pos.lockDuration).to.equal(0n);
      expect(await staking.getWeight(alice.address, 1)).to.equal(0n);
      expect(await staking.getTotalWeight(1)).to.equal(0n);
    });

    it("reverts on zero amount", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));
      await expect(staking.connect(alice).unstake(1, 0n)).to.be.revertedWithCustomError(
        staking,
        "ZeroAmount",
      );
    });

    it("reverts on amount > position (I16)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));
      await expect(staking.connect(alice).unstake(1, AMOUNT + 1n))
        .to.be.revertedWithCustomError(staking, "InsufficientStake")
        .withArgs(AMOUNT + 1n, AMOUNT);
    });

    it("reverts when position does not exist (I16)", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).unstake(1, AMOUNT))
        .to.be.revertedWithCustomError(staking, "PositionNotFound")
        .withArgs(alice.address, 1);
    });

    it("respects Probation — lock still enforced (I12)", async function () {
      const { staking, registry, governance, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      await registry.connect(governance).setProbation(1);
      // Probation NAO bypassa lock.
      await expect(staking.connect(alice).unstake(1, AMOUNT)).to.be.revertedWithCustomError(
        staking,
        "LockNotExpired",
      );
    });

    it("allows unstake after Probation once lock expires", async function () {
      const { staking, registry, governance, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await registry.connect(governance).setProbation(1);
      await time.increase(Number(MIN_LOCK));
      await expect(staking.connect(alice).unstake(1, AMOUNT)).to.emit(staking, "Unstaked");
    });

    it("bypasses lock when project is Removed (I11)", async function () {
      const { staking, registry, governance, alice, admin, gov } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      // Lock ainda vigente — mas projeto e removido.
      await registry.connect(governance).removeProject(1, false, admin.address);

      const balBefore = await gov.balanceOf(alice.address);
      const tx = await staking.connect(alice).unstake(1, AMOUNT);
      await expect(tx).to.emit(staking, "EarlyUnstakeAllowed").withArgs(alice.address, 1, AMOUNT);
      await expect(tx).to.emit(staking, "Unstaked").withArgs(alice.address, 1, AMOUNT, 0n, 0n);

      expect(await gov.balanceOf(alice.address)).to.equal(balBefore + AMOUNT);
      const pos = await staking.getPosition(alice.address, 1);
      expect(pos.amount).to.equal(0n);
    });

    it("Removed bypass is independent of lock expiry (works after expiry too)", async function () {
      const { staking, registry, governance, alice, admin } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));
      await registry.connect(governance).removeProject(1, false, admin.address);
      await expect(staking.connect(alice).unstake(1, AMOUNT)).to.emit(
        staking,
        "EarlyUnstakeAllowed",
      );
    });
  });

  describe("unstakeAll", function () {
    it("unstakes the full position", async function () {
      const { staking, gov, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));
      const balBefore = await gov.balanceOf(alice.address);

      await expect(staking.connect(alice).unstakeAll(1))
        .to.emit(staking, "Unstaked")
        .withArgs(alice.address, 1, AMOUNT, 0n, 0n);

      expect(await gov.balanceOf(alice.address)).to.equal(balBefore + AMOUNT);
      expect((await staking.getPosition(alice.address, 1)).amount).to.equal(0n);
    });

    it("reverts when position does not exist", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await expect(staking.connect(alice).unstakeAll(1))
        .to.be.revertedWithCustomError(staking, "PositionNotFound")
        .withArgs(alice.address, 1);
    });

    it("reverts while lock is active and project is not Removed", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await expect(staking.connect(alice).unstakeAll(1)).to.be.revertedWithCustomError(
        staking,
        "LockNotExpired",
      );
    });
  });

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------

  describe("views", function () {
    it("getLockEnd returns 0 when no position", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      expect(await staking.getLockEnd(alice.address, 1)).to.equal(0n);
    });

    it("getLockEnd returns lockStartAt + lockDuration", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      const tx = await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const nowTs = BigInt(block!.timestamp);
      expect(await staking.getLockEnd(alice.address, 1)).to.equal(nowTs + MAX_LOCK);
    });

    it("isUnlocked returns true when no position", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      expect(await staking.isUnlocked(alice.address, 1)).to.equal(true);
    });

    it("isUnlocked returns false during lock, true after expiry", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      expect(await staking.isUnlocked(alice.address, 1)).to.equal(false);
      await time.increase(Number(MIN_LOCK));
      expect(await staking.isUnlocked(alice.address, 1)).to.equal(true);
    });

    it("getWeight returns 0 when no position", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      expect(await staking.getWeight(alice.address, 1)).to.equal(0n);
    });

    it("getPosition returns zeroed struct when none", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      const p = await staking.getPosition(alice.address, 1);
      expect(p.amount).to.equal(0n);
      expect(p.lockStartAt).to.equal(0n);
      expect(p.lockDuration).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  // Snapshots — I14 (historic queries)
  // ------------------------------------------------------------------

  describe("checkpoints / snapshots (I14)", function () {
    it("getWeightAt returns historic weight at a past block", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      // Stake no bloco N1.
      const tx1 = await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      const n1 = tx1.blockNumber!;
      const w1 = weight(AMOUNT, MAX_LOCK);

      // Avanca alguns blocos.
      await mine(5);

      // Lock expira — unstake total.
      await time.increase(Number(MAX_LOCK));
      const tx2 = await staking.connect(alice).unstake(1, AMOUNT);
      const n2 = tx2.blockNumber!;

      // Avanca um pouco mais para a query nao ser do bloco mais recente.
      await mine(2);

      // Peso atual = 0. Peso no bloco N1 = w1.
      expect(await staking.getWeightAt(alice.address, 1, n1)).to.equal(w1);
      expect(await staking.getWeightAt(alice.address, 1, n1 + 1)).to.equal(w1);
      expect(await staking.getWeightAt(alice.address, 1, n2)).to.equal(0n);
      expect(await staking.getWeight(alice.address, 1)).to.equal(0n);
    });

    it("getTotalWeightAt aggregates correctly across multiple stakers over time", async function () {
      const { staking, alice, bob } = await loadFixture(deployFixture);
      const tx1 = await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      const n1 = tx1.blockNumber!;
      const w1 = weight(AMOUNT, MAX_LOCK);

      await mine(3);

      const tx2 = await staking.connect(bob).stake(1, AMOUNT * 2n, MIN_LOCK);
      const n2 = tx2.blockNumber!;
      const w2 = weight(AMOUNT * 2n, MIN_LOCK);

      await mine(3);

      expect(await staking.getTotalWeightAt(1, n1)).to.equal(w1);
      expect(await staking.getTotalWeightAt(1, n1 + 1)).to.equal(w1);
      expect(await staking.getTotalWeightAt(1, n2)).to.equal(w1 + w2);
      expect(await staking.getTotalWeight(1)).to.equal(w1 + w2);
    });

    it("returns 0 for queries before any checkpoint", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await mine(2);
      const block = await ethers.provider.getBlockNumber();
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      // Query de bloco anterior ao stake.
      expect(await staking.getWeightAt(alice.address, 1, block - 1)).to.equal(0n);
      expect(await staking.getTotalWeightAt(1, block - 1)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  // Global weight checkpoints (novo trilho para RewardDistributor)
  // ------------------------------------------------------------------

  describe("global weight", function () {
    it("starts at zero and returns zero for any past block before any stake", async function () {
      const { staking } = await loadFixture(deployFixture);
      expect(await staking.getGlobalWeight()).to.equal(0n);
      const b = await ethers.provider.getBlockNumber();
      expect(await staking.getGlobalWeightAt(b)).to.equal(0n);
    });

    it("equals the single-staker weight after a single stake", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      const w = weight(AMOUNT, MAX_LOCK);
      expect(await staking.getGlobalWeight()).to.equal(w);
    });

    it("aggregates across projects in O(1) (sum invariant)", async function () {
      const { staking, alice, bob, carol } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      await staking.connect(bob).stake(1, AMOUNT * 2n, MIN_LOCK);
      await staking.connect(carol).stake(2, AMOUNT * 3n, (MIN_LOCK + MAX_LOCK) / 2n);

      const expected =
        weight(AMOUNT, MAX_LOCK) +
        weight(AMOUNT * 2n, MIN_LOCK) +
        weight(AMOUNT * 3n, (MIN_LOCK + MAX_LOCK) / 2n);

      expect(await staking.getGlobalWeight()).to.equal(expected);
      // Soma dos projetos deve bater com global (invariante).
      const p1 = await staking.getTotalWeight(1);
      const p2 = await staking.getTotalWeight(2);
      expect(p1 + p2).to.equal(expected);
    });

    it("decrements on unstake and returns to zero on full unwind", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      const wBefore = weight(AMOUNT, MIN_LOCK);
      expect(await staking.getGlobalWeight()).to.equal(wBefore);

      await time.increase(Number(MIN_LOCK));
      await staking.connect(alice).unstakeAll(1);
      expect(await staking.getGlobalWeight()).to.equal(0n);
    });

    it("getGlobalWeightAt returns historic values (anti flash-stake)", async function () {
      const { staking, alice, bob } = await loadFixture(deployFixture);
      const tx1 = await staking.connect(alice).stake(1, AMOUNT, MAX_LOCK);
      const n1 = tx1.blockNumber!;
      const w1 = weight(AMOUNT, MAX_LOCK);

      await mine(3);

      const tx2 = await staking.connect(bob).stake(2, AMOUNT * 2n, MIN_LOCK);
      const n2 = tx2.blockNumber!;
      const w2 = weight(AMOUNT * 2n, MIN_LOCK);

      await mine(3);

      // No bloco n1 so havia a alice.
      expect(await staking.getGlobalWeightAt(n1)).to.equal(w1);
      // Apos n2 soma bob.
      expect(await staking.getGlobalWeightAt(n2)).to.equal(w1 + w2);
      // Atual bate com os dois.
      expect(await staking.getGlobalWeight()).to.equal(w1 + w2);
    });

    it("remains consistent under increaseStake and extendLock", async function () {
      const { staking, alice } = await loadFixture(deployFixture);
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      const w0 = weight(AMOUNT, MIN_LOCK);
      expect(await staking.getGlobalWeight()).to.equal(w0);

      const add = 500n * 10n ** 18n;
      await staking.connect(alice).increaseStake(1, add);
      const w1 = weight(AMOUNT + add, MIN_LOCK);
      expect(await staking.getGlobalWeight()).to.equal(w1);

      const newLock = MIN_LOCK + 60n * 24n * 60n * 60n;
      await staking.connect(alice).extendLock(1, newLock);
      const w2 = weight(AMOUNT + add, newLock);
      expect(await staking.getGlobalWeight()).to.equal(w2);
    });
  });

  // ------------------------------------------------------------------
  // Reentrancy — I15
  // ------------------------------------------------------------------

  describe("reentrancy (I15)", function () {
    async function reentrancyFixture() {
      const [admin, governance, alice, projOwner] = await ethers.getSigners();

      // Deploy mock ERC20 como o "GOV" do Staking.
      const Reentrant = await ethers.getContractFactory("ReentrantStakingERC20Mock");
      const token = await Reentrant.deploy("Reentrant", "RE");
      await token.waitForDeployment();

      // ProjectRegistry usa o proprio token como colateral (para simplificar).
      const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
      const registry = await ProjectRegistry.deploy(
        await token.getAddress(),
        admin.address,
        MIN_COLLATERAL,
        PROBATION_DURATION,
      );
      await registry.waitForDeployment();
      const GOVERNANCE_ROLE = await registry.GOVERNANCE_ROLE();
      await registry.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

      // Seed tokens.
      await token.mint(alice.address, 1_000_000n * 10n ** 18n);
      await token.mint(projOwner.address, MIN_COLLATERAL);

      // Registra projeto 1.
      await token.connect(projOwner).approve(await registry.getAddress(), MIN_COLLATERAL);
      await registry
        .connect(governance)
        .registerProject(projOwner.address, METADATA_URI, MIN_COLLATERAL);
      await registry.connect(governance).activateProject(1);

      const Staking = await ethers.getContractFactory("Staking");
      const staking = await Staking.deploy(await token.getAddress(), await registry.getAddress());
      await staking.waitForDeployment();
      await token.connect(alice).approve(await staking.getAddress(), 1_000_000n * 10n ** 18n);

      return { staking, token, registry, alice };
    }

    it("blocks reentrant stake via malicious token callback", async function () {
      const { staking, token, alice } = await reentrancyFixture();
      await token.armStakeReentry(await staking.getAddress(), 1, 100n * 10n ** 18n, MIN_LOCK);
      await expect(
        staking.connect(alice).stake(1, 100n * 10n ** 18n, MIN_LOCK),
      ).to.be.revertedWithCustomError(staking, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrant unstake via malicious token callback", async function () {
      const { staking, token, alice } = await reentrancyFixture();
      // Primeiro stake normal (mock desarmado).
      await token.disarm();
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));
      // Arma ataque de reentry via unstake.
      await token.armUnstakeReentry(await staking.getAddress(), 1, AMOUNT / 4n);
      await expect(staking.connect(alice).unstake(1, AMOUNT / 2n)).to.be.revertedWithCustomError(
        staking,
        "ReentrancyGuardReentrantCall",
      );
    });

    it("blocks reentrant increaseStake via malicious token callback", async function () {
      const { staking, token, alice } = await reentrancyFixture();
      // Primeiro stake normal.
      await token.disarm();
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      // Arma ataque de reentry via increaseStake.
      await token.armIncreaseStakeReentry(await staking.getAddress(), 1, 100n * 10n ** 18n);
      await expect(
        staking.connect(alice).increaseStake(1, 100n * 10n ** 18n),
      ).to.be.revertedWithCustomError(staking, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrant unstakeAll via malicious token callback", async function () {
      const { staking, token, alice } = await reentrancyFixture();
      await token.disarm();
      await staking.connect(alice).stake(1, AMOUNT, MIN_LOCK);
      await time.increase(Number(MIN_LOCK));
      // Arma ataque de reentry via unstakeAll.
      await token.armUnstakeAllReentry(await staking.getAddress(), 1);
      await expect(staking.connect(alice).unstakeAll(1)).to.be.revertedWithCustomError(
        staking,
        "ReentrancyGuardReentrantCall",
      );
    });
  });
});
