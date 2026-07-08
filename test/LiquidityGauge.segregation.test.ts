import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * LiquidityGauge — segregacao de saldo (totalVestingLocked).
 *
 * Fecha o buraco em que {governanceRescueRewards} podia drenar CREDIT que
 * lastreia {VestingPosition}s ainda nao sacadas. Cobertura:
 *  - unstake incrementa `totalVestingLocked` pelo valor total da posicao;
 *  - rescue bloqueado quando invadiria vesting (RescueExceedsUnreserved);
 *  - rescue permitido no excedente nao-reservado (forfeit de
 *    emergencyUnstake, refund de endIncentive), inclusive via max sentinel;
 *  - harvest decrementa o contador (parcial e total) e mantem a invariante
 *    `balance - totalVestingLocked == getUnreservedBalance()`;
 *  - emergencyUnstake NAO altera o contador (vesting previo preservado,
 *    forfeit vira saldo nao-reservado);
 *  - compactacao swap-and-pop em harvest so remove positions totalmente
 *    sacadas — contador permanece exato.
 */
describe("LiquidityGauge — segregacao de saldo (totalVestingLocked)", function () {
  const ONE_CREDIT = 10n ** 18n;
  const VESTING_DEFAULT = 14n * 24n * 3600n;
  // Incentive longa para permitir stakes em momentos distintos (positions
  // com janelas de vesting defasadas).
  const INCENTIVE_DURATION = 30n * 24n * 3600n;

  async function deployFixture() {
    const [admin, governance, notifier, alice, bob, other] = await ethers.getSigners();

    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("Web3Community Credit", "CREDIT", admin.address);
    await credit.waitForDeployment();

    const NPMMock = await ethers.getContractFactory("NonfungiblePositionManagerERC721Mock");
    const npm = await NPMMock.deploy();
    await npm.waitForDeployment();

    const StakerMock = await ethers.getContractFactory("UniswapV3StakerMock");
    const staker = await StakerMock.deploy();
    await staker.waitForDeployment();
    await staker.setPositionManager(await npm.getAddress());

    const pool = ethers.getAddress("0x" + "11".repeat(20));

    const Gauge = await ethers.getContractFactory("LiquidityGauge");
    const gauge = await Gauge.deploy(
      admin.address,
      await credit.getAddress(),
      await staker.getAddress(),
      await npm.getAddress(),
    );
    await gauge.waitForDeployment();

    const GOVERNANCE_ROLE = await gauge.GOVERNANCE_ROLE();
    const REWARD_NOTIFIER_ROLE = await gauge.REWARD_NOTIFIER_ROLE();
    await gauge.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);
    await gauge.connect(admin).grantRole(REWARD_NOTIFIER_ROLE, notifier.address);

    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
    await credit
      .connect(admin)
      .mint(notifier.address, 10_000_000n * ONE_CREDIT, "test-seed-notifier");

    // Pool whitelisted + incentive ativa de 1M CREDIT por 30 dias.
    await gauge.connect(governance).addPool(pool);
    const poolId = 1n;
    const rewardAmount = 1_000_000n * ONE_CREDIT;
    await credit.connect(notifier).approve(await gauge.getAddress(), rewardAmount);
    await gauge.connect(notifier).notifyRewardAmount(poolId, rewardAmount, INCENTIVE_DURATION);

    // NFTs: alice possui 1 e 3, bob possui 2.
    await npm.mintTo(alice.address, 1n);
    await npm.mintTo(bob.address, 2n);
    await npm.mintTo(alice.address, 3n);
    await npm.connect(alice).setApprovalForAll(await gauge.getAddress(), true);
    await npm.connect(bob).setApprovalForAll(await gauge.getAddress(), true);

    return {
      admin,
      governance,
      notifier,
      alice,
      bob,
      other,
      credit,
      npm,
      staker,
      gauge,
      pool,
      poolId,
      rewardAmount,
    };
  }

  type Ctx = Awaited<ReturnType<typeof deployFixture>>;

  /** stake -> accrue -> unstake: cria VestingPosition de `amount` para `signer`. */
  async function createVesting(
    ctx: Ctx,
    signer: Ctx["alice"],
    tokenId: bigint,
    amount: bigint,
  ): Promise<void> {
    const { gauge, staker, credit, poolId } = ctx;
    await gauge.connect(signer).stake(tokenId, poolId);
    await staker.accrueRewards(await credit.getAddress(), await gauge.getAddress(), amount);
    await gauge.connect(signer).unstake(tokenId);
  }

  /** stake -> accrue -> emergencyUnstake: cria saldo ORFAO (nao-reservado). */
  async function createForfeit(
    ctx: Ctx,
    signer: Ctx["bob"],
    tokenId: bigint,
    amount: bigint,
  ): Promise<void> {
    const { gauge, staker, credit, poolId } = ctx;
    await gauge.connect(signer).stake(tokenId, poolId);
    await staker.accrueRewards(await credit.getAddress(), await gauge.getAddress(), amount);
    await gauge.connect(signer).emergencyUnstake(tokenId);
  }

  // ----------------------------------------------------------------- 1. contador no unstake
  describe("totalVestingLocked — incremento no unstake", function () {
    it("starts at zero with zero unreserved balance", async function () {
      const { gauge } = await loadFixture(deployFixture);
      expect(await gauge.totalVestingLocked()).to.equal(0n);
      expect(await gauge.getUnreservedBalance()).to.equal(0n);
    });

    it("increments by the full position amount on unstake; balance fully reserved", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, credit, bob } = ctx;

      await createVesting(ctx, ctx.alice, 1n, 100n * ONE_CREDIT);
      expect(await gauge.totalVestingLocked()).to.equal(100n * ONE_CREDIT);
      expect(await credit.balanceOf(await gauge.getAddress())).to.equal(100n * ONE_CREDIT);
      expect(await gauge.getUnreservedBalance()).to.equal(0n);

      // Segunda posicao (outro user) acumula no contador global.
      await createVesting(ctx, bob, 2n, 40n * ONE_CREDIT);
      expect(await gauge.totalVestingLocked()).to.equal(140n * ONE_CREDIT);
      expect(await gauge.getUnreservedBalance()).to.equal(0n);
    });
  });

  // ----------------------------------------------------------------- 2. rescue bloqueado
  describe("governanceRescueRewards — bloqueio de invasao de vesting", function () {
    it("reverts RescueExceedsUnreserved when rescue would invade vesting-backed CREDIT", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, governance, other } = ctx;
      await createVesting(ctx, ctx.alice, 1n, 100n * ONE_CREDIT);

      await expect(gauge.connect(governance).governanceRescueRewards(other.address, 1n))
        .to.be.revertedWithCustomError(gauge, "RescueExceedsUnreserved")
        .withArgs(0n, 1n);
    });

    it("amount above balance still reverts InsufficientBalance (check order preserved)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, governance, other } = ctx;
      await createVesting(ctx, ctx.alice, 1n, 100n * ONE_CREDIT);

      await expect(
        gauge.connect(governance).governanceRescueRewards(other.address, 200n * ONE_CREDIT),
      )
        .to.be.revertedWithCustomError(gauge, "InsufficientBalance")
        .withArgs(200n * ONE_CREDIT, 100n * ONE_CREDIT);
    });
  });

  // ----------------------------------------------------------------- 3. rescue no excedente
  describe("governanceRescueRewards — permitido no excedente", function () {
    it("allows rescue up to unreserved (forfeit), blocks 1 wei beyond, vesting intact", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, governance, credit, alice, bob, other } = ctx;

      await createVesting(ctx, alice, 1n, 100n * ONE_CREDIT);
      await createForfeit(ctx, bob, 2n, 50n * ONE_CREDIT);

      expect(await gauge.getUnreservedBalance()).to.equal(50n * ONE_CREDIT);

      await expect(
        gauge.connect(governance).governanceRescueRewards(other.address, 50n * ONE_CREDIT + 1n),
      )
        .to.be.revertedWithCustomError(gauge, "RescueExceedsUnreserved")
        .withArgs(50n * ONE_CREDIT, 50n * ONE_CREDIT + 1n);

      await expect(
        gauge.connect(governance).governanceRescueRewards(other.address, 50n * ONE_CREDIT),
      )
        .to.emit(gauge, "RewardsRescued")
        .withArgs(other.address, 50n * ONE_CREDIT);

      expect(await credit.balanceOf(other.address)).to.equal(50n * ONE_CREDIT);
      expect(await gauge.getUnreservedBalance()).to.equal(0n);
      // Backing do vesting intacto.
      expect(await credit.balanceOf(await gauge.getAddress())).to.equal(100n * ONE_CREDIT);

      // Alice ainda saca 100% do vesting.
      await time.increase(Number(VESTING_DEFAULT) + 10);
      await gauge.connect(alice).harvest(alice.address, ethers.MaxUint256);
      expect(await credit.balanceOf(alice.address)).to.equal(100n * ONE_CREDIT);
    });

    it("max sentinel rescues ONLY the unreserved balance", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, governance, credit, alice, bob, other } = ctx;

      await createVesting(ctx, alice, 1n, 100n * ONE_CREDIT);
      await createForfeit(ctx, bob, 2n, 50n * ONE_CREDIT);

      await gauge.connect(governance).governanceRescueRewards(other.address, ethers.MaxUint256);
      expect(await credit.balanceOf(other.address)).to.equal(50n * ONE_CREDIT);
      expect(await credit.balanceOf(await gauge.getAddress())).to.equal(100n * ONE_CREDIT);
      expect(await gauge.totalVestingLocked()).to.equal(100n * ONE_CREDIT);
    });

    it("endIncentive refund is unreserved and fully rescuable", async function () {
      const { gauge, governance, credit, other, poolId, rewardAmount } =
        await loadFixture(deployFixture);
      await time.increase(Number(INCENTIVE_DURATION) + 1);
      await gauge.connect(governance).endIncentive(poolId);

      expect(await gauge.totalVestingLocked()).to.equal(0n);
      expect(await gauge.getUnreservedBalance()).to.equal(rewardAmount);

      await gauge.connect(governance).governanceRescueRewards(other.address, ethers.MaxUint256);
      expect(await credit.balanceOf(other.address)).to.equal(rewardAmount);
    });
  });

  // ----------------------------------------------------------------- 4. harvest decrementa
  describe("harvest — decrementa e libera", function () {
    it("partial harvest decrements exactly by claimed; surplus stays rescuable", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, governance, credit, alice, bob, other } = ctx;
      const total = 140n * ONE_CREDIT;

      await createVesting(ctx, alice, 1n, total);
      await createForfeit(ctx, bob, 2n, 30n * ONE_CREDIT);
      expect(await gauge.getUnreservedBalance()).to.equal(30n * ONE_CREDIT);

      // t = 7d: ~50% vested.
      await time.increase(7 * 24 * 3600);
      const balBefore = await credit.balanceOf(alice.address);
      await gauge.connect(alice).harvest(alice.address, ethers.MaxUint256);
      const claimed = (await credit.balanceOf(alice.address)) - balBefore;
      expect(claimed).to.be.greaterThan(total / 2n - ONE_CREDIT);
      expect(claimed).to.be.lessThan(total / 2n + ONE_CREDIT);

      // Contador decrementado EXATAMENTE pelo sacado.
      expect(await gauge.totalVestingLocked()).to.equal(total - claimed);
      // Invariante: excedente continua exatamente 30 (harvest nao invade).
      expect(await gauge.getUnreservedBalance()).to.equal(30n * ONE_CREDIT);

      await expect(
        gauge.connect(governance).governanceRescueRewards(other.address, 31n * ONE_CREDIT),
      )
        .to.be.revertedWithCustomError(gauge, "RescueExceedsUnreserved")
        .withArgs(30n * ONE_CREDIT, 31n * ONE_CREDIT);
      await gauge.connect(governance).governanceRescueRewards(other.address, 30n * ONE_CREDIT);
      expect(await credit.balanceOf(other.address)).to.equal(30n * ONE_CREDIT);

      // t = 14d+: harvest total zera o contador e o gauge.
      await time.increase(7 * 24 * 3600 + 10);
      await gauge.connect(alice).harvest(alice.address, ethers.MaxUint256);
      expect(await credit.balanceOf(alice.address)).to.equal(total);
      expect(await gauge.totalVestingLocked()).to.equal(0n);
      expect(await credit.balanceOf(await gauge.getAddress())).to.equal(0n);
      expect(await gauge.getUnreservedBalance()).to.equal(0n);
    });
  });

  // ----------------------------------------------------------------- 5. emergencyUnstake
  describe("emergencyUnstake — contador intocado", function () {
    it("keeps totalVestingLocked (previous vesting preserved, forfeit unreserved)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, credit, alice } = ctx;

      await createVesting(ctx, alice, 1n, 60n * ONE_CREDIT);
      expect(await gauge.totalVestingLocked()).to.equal(60n * ONE_CREDIT);

      // Segundo ciclo termina em emergencyUnstake: NADA muda no contador.
      await createForfeit(ctx, alice, 3n, 30n * ONE_CREDIT);

      expect(await gauge.totalVestingLocked()).to.equal(60n * ONE_CREDIT);
      expect(await gauge.vestingCountOf(alice.address)).to.equal(1n);
      expect(await credit.balanceOf(await gauge.getAddress())).to.equal(90n * ONE_CREDIT);
      expect(await gauge.getUnreservedBalance()).to.equal(30n * ONE_CREDIT);
    });
  });

  // ----------------------------------------------------------------- 6. compactacao
  describe("harvest — compactacao swap-and-pop", function () {
    it("compaction only removes fully-claimed positions; counter stays exact", async function () {
      const ctx = await loadFixture(deployFixture);
      const { gauge, governance, credit, alice, other } = ctx;

      // Position A: 40 CREDIT em t0.
      await createVesting(ctx, alice, 1n, 40n * ONE_CREDIT);
      // Position B: 100 CREDIT em t0+7d (janela defasada).
      await time.increase(7 * 24 * 3600);
      await createVesting(ctx, alice, 3n, 100n * ONE_CREDIT);
      expect(await gauge.vestingCountOf(alice.address)).to.equal(2n);
      expect(await gauge.totalVestingLocked()).to.equal(140n * ONE_CREDIT);

      // t0+14d+: A 100% vested, B ~50%. Harvest max compacta A (swap-and-pop).
      await time.increase(7 * 24 * 3600 + 60);
      await gauge.connect(alice).harvest(alice.address, ethers.MaxUint256);

      expect(await gauge.vestingCountOf(alice.address)).to.equal(1n);
      const b = await gauge.vestingAt(alice.address, 0n);
      // B (swappada para o slot 0) e a unica remanescente.
      expect(b.totalAmount).to.equal(100n * ONE_CREDIT);
      // Contador == exatamente o nao-sacado da position viva.
      expect(await gauge.totalVestingLocked()).to.equal(b.totalAmount - b.claimedAmount);
      // Nada virou "excedente" com a compactacao — rescue segue bloqueado.
      expect(await gauge.getUnreservedBalance()).to.equal(0n);
      await expect(gauge.connect(governance).governanceRescueRewards(other.address, 1n))
        .to.be.revertedWithCustomError(gauge, "RescueExceedsUnreserved")
        .withArgs(0n, 1n);

      // t0+21d+: B completa. Harvest final zera contador e positions.
      await time.increase(7 * 24 * 3600 + 60);
      await gauge.connect(alice).harvest(alice.address, ethers.MaxUint256);
      expect(await gauge.vestingCountOf(alice.address)).to.equal(0n);
      expect(await gauge.totalVestingLocked()).to.equal(0n);
      expect(await credit.balanceOf(alice.address)).to.equal(140n * ONE_CREDIT);
    });
  });
});
