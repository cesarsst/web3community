import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Treasury — segregacao on-chain dos buckets de CREDIT
 * (`polRefillBucket` + `pendingGaugeRewards`).
 *
 * Fecha o buraco em que transfer/batchTransfer/payRebates (governanca)
 * podiam drenar o CREDIT que lastreia os ledgers contabeis da Fase 1.4.
 * Cobertura:
 *  - unreservedCreditBalance() = balance - (polRefillBucket +
 *    pendingGaugeRewards), saturando em zero;
 *  - lado das ENTRADAS enforced: depositPolRefill /
 *    depositPendingGaugeRewards revertem (DepositExceedsCreditBalance)
 *    quando o ledger excederia o saldo real de CREDIT — um depositor
 *    comprometido nao consegue inflar a reserva e congelar TODAS as
 *    saidas genericas de CREDIT (DoS);
 *  - transfer de CREDIT bloqueado quando invadiria os buckets
 *    (TransferExceedsUnreservedCredit); permitido ate o nao-reservado;
 *  - batchTransfer/payRebates validam a SOMA das parcelas (nao cada uma);
 *  - transfer de OUTRO token (USDC) nao e afetado;
 *  - addPOL (saida generica de CREDIT) tambem respeita a segregacao;
 *  - addPOLFromRefill e flushPendingGaugeRewards continuam consumindo os
 *    buckets (mesmo com unreservado == 0) e liberam a reserva;
 *  - valvulas writeDownPolRefillBucket / writeDownPendingGaugeRewards
 *    liberam a reserva sem mover tokens (escape do freeze por
 *    IncentiveOverlap e reciclagem do bucket bonders).
 */
describe("Treasury — segregacao dos buckets de CREDIT", function () {
  const ONE_USDC = 10n ** 6n;
  const ONE_CREDIT = 10n ** 18n;
  const SEED_USDC = 100_000n * ONE_USDC;
  const FAR_DEADLINE = 2n ** 32n - 1n;
  const FLUSH_DURATION = 7 * 24 * 60 * 60;

  async function deployFixture() {
    const [admin, governance, distributor, other, other2] = await ethers.getSigners();

    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("Web3Community Credit", "CREDIT", admin.address);
    await credit.waitForDeployment();

    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      admin.address,
      await credit.getAddress(),
      await usdc.getAddress(),
    );
    await treasury.waitForDeployment();

    const GOVERNANCE_ROLE = await treasury.GOVERNANCE_ROLE();
    const POL_REFILL_DEPOSITOR_ROLE = await treasury.POL_REFILL_DEPOSITOR_ROLE();
    const GAUGE_FALLBACK_DEPOSITOR_ROLE = await treasury.GAUGE_FALLBACK_DEPOSITOR_ROLE();
    await treasury.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);
    await treasury.connect(admin).grantRole(POL_REFILL_DEPOSITOR_ROLE, distributor.address);
    await treasury.connect(admin).grantRole(GAUGE_FALLBACK_DEPOSITOR_ROLE, distributor.address);

    // NPM mock (POL) e gauge mock (flush).
    const NPMMock = await ethers.getContractFactory("NonfungiblePositionManagerMock");
    const npm = await NPMMock.deploy();
    await npm.waitForDeployment();

    const GaugeMock = await ethers.getContractFactory("LiquidityGaugeRewardsMock");
    const gauge = await GaugeMock.deploy(await credit.getAddress());
    await gauge.waitForDeployment();

    // Pre-fund Treasury com USDC (saldo livre para POL e transfers de controle).
    await usdc.mint(await treasury.getAddress(), SEED_USDC);

    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);

    return {
      admin,
      governance,
      distributor,
      other,
      other2,
      credit,
      usdc,
      treasury,
      npm,
      gauge,
    };
  }

  type Ctx = Awaited<ReturnType<typeof deployFixture>>;

  /** Minta `amount` CREDIT para o Treasury (simula V2/fees). */
  async function mintCredit(ctx: Ctx, amount: bigint): Promise<void> {
    await ctx.credit.connect(ctx.admin).mint(await ctx.treasury.getAddress(), amount, "test");
  }

  // ------------------------------------------------------------------
  // unreservedCreditBalance (view)
  // ------------------------------------------------------------------

  describe("unreservedCreditBalance", function () {
    it("equals balance minus (polRefillBucket + pendingGaugeRewards)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, distributor } = ctx;

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(1000n * ONE_CREDIT);

      await treasury.connect(distributor).depositPolRefill(600n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(400n * ONE_CREDIT);

      await treasury.connect(distributor).depositPendingGaugeRewards(300n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(100n * ONE_CREDIT);
    });

    it("ledger > balance e INALCANCAVEL: deposito sem lastro reverte (view satura em 0 por defesa)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, distributor } = ctx;
      // O estado "reserva > saldo real" (que congelaria toda saida generica
      // de CREDIT) nao pode mais ser criado pelos depositors — o lado das
      // entradas tambem e enforced. A saturacao da view permanece como
      // defesa em profundidade.
      await expect(treasury.connect(distributor).depositPolRefill(600n * ONE_CREDIT))
        .to.be.revertedWithCustomError(treasury, "DepositExceedsCreditBalance")
        .withArgs(600n * ONE_CREDIT, 0n);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);
      expect(await treasury.polRefillBucket()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  // Lado das entradas — ledger nunca excede o saldo real (anti-DoS)
  // ------------------------------------------------------------------

  describe("depositos — invariante enforced tambem nas ENTRADAS", function () {
    it("depositPolRefill reverts when it would push reserve above the CREDIT balance", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, distributor } = ctx;

      await mintCredit(ctx, 100n * ONE_CREDIT);
      // 150 > 100 de lastro -> revert com o total reservado pretendido.
      await expect(treasury.connect(distributor).depositPolRefill(150n * ONE_CREDIT))
        .to.be.revertedWithCustomError(treasury, "DepositExceedsCreditBalance")
        .withArgs(150n * ONE_CREDIT, 100n * ONE_CREDIT);

      // Ate o lastro exato passa; 1 wei alem reverte.
      await treasury.connect(distributor).depositPolRefill(100n * ONE_CREDIT);
      expect(await treasury.polRefillBucket()).to.equal(100n * ONE_CREDIT);
      await expect(treasury.connect(distributor).depositPolRefill(1n))
        .to.be.revertedWithCustomError(treasury, "DepositExceedsCreditBalance")
        .withArgs(100n * ONE_CREDIT + 1n, 100n * ONE_CREDIT);
    });

    it("depositPendingGaugeRewards contabiliza a reserva AGREGADA (ambos os ledgers)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, distributor } = ctx;

      await mintCredit(ctx, 100n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(60n * ONE_CREDIT);
      // 60 (polRefill) + 50 (pendingGauge) = 110 > 100 -> revert.
      await expect(treasury.connect(distributor).depositPendingGaugeRewards(50n * ONE_CREDIT))
        .to.be.revertedWithCustomError(treasury, "DepositExceedsCreditBalance")
        .withArgs(110n * ONE_CREDIT, 100n * ONE_CREDIT);
      // 40 fecha exatamente o lastro.
      await treasury.connect(distributor).depositPendingGaugeRewards(40n * ONE_CREDIT);
      expect(await treasury.pendingGaugeRewards()).to.equal(40n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);
    });

    it("consequencia bloqueada: sem inflacao de ledger, as saidas genericas nunca congelam alem do reservado real", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other } = ctx;

      await mintCredit(ctx, 100n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(100n * ONE_CREDIT);
      // Tentativa de over-count (DoS de todas as saidas) reverte...
      await expect(
        treasury.connect(distributor).depositPolRefill(1n),
      ).to.be.revertedWithCustomError(treasury, "DepositExceedsCreditBalance");
      // ...e CREDIT novo que chegar permanece 100% transferivel.
      await mintCredit(ctx, 30n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(30n * ONE_CREDIT);
      await treasury
        .connect(governance)
        .transfer(await credit.getAddress(), other.address, 30n * ONE_CREDIT);
      expect(await credit.balanceOf(other.address)).to.equal(30n * ONE_CREDIT);
    });
  });

  // ------------------------------------------------------------------
  // Write-down — valvulas governance de reducao dos ledgers
  // ------------------------------------------------------------------

  describe("writeDown — libera a reserva sem mover tokens", function () {
    it("writeDownPendingGaugeRewards frees the reserve for generic outflows (escape do freeze)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other } = ctx;

      await mintCredit(ctx, 500n * ONE_CREDIT);
      await treasury.connect(distributor).depositPendingGaugeRewards(500n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);
      await expect(
        treasury.connect(governance).transfer(await credit.getAddress(), other.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit");

      // Valvula: baixa parcial do ledger (ex.: flush inviavel por
      // IncentiveOverlap permanente no gauge).
      await expect(treasury.connect(governance).writeDownPendingGaugeRewards(200n * ONE_CREDIT))
        .to.emit(treasury, "PendingGaugeWrittenDown")
        .withArgs(200n * ONE_CREDIT, 300n * ONE_CREDIT);
      expect(await treasury.pendingGaugeRewards()).to.equal(300n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(200n * ONE_CREDIT);

      await treasury
        .connect(governance)
        .transfer(await credit.getAddress(), other.address, 200n * ONE_CREDIT);
      expect(await credit.balanceOf(other.address)).to.equal(200n * ONE_CREDIT);
    });

    it("writeDownPolRefillBucket recycles old bucket into free balance", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor } = ctx;

      await mintCredit(ctx, 400n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(400n * ONE_CREDIT);
      await expect(treasury.connect(governance).writeDownPolRefillBucket(400n * ONE_CREDIT))
        .to.emit(treasury, "PolRefillWrittenDown")
        .withArgs(400n * ONE_CREDIT, 0n);
      expect(await treasury.polRefillBucket()).to.equal(0n);
      expect(await treasury.unreservedCreditBalance()).to.equal(400n * ONE_CREDIT);
    });

    it("write-downs validate bounds and are governance-gated", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, other } = ctx;

      await mintCredit(ctx, 100n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(50n * ONE_CREDIT);
      await treasury.connect(distributor).depositPendingGaugeRewards(50n * ONE_CREDIT);

      await expect(
        treasury.connect(governance).writeDownPolRefillBucket(0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
      await expect(treasury.connect(governance).writeDownPolRefillBucket(51n * ONE_CREDIT))
        .to.be.revertedWithCustomError(treasury, "PolRefillBucketInsufficient")
        .withArgs(51n * ONE_CREDIT, 50n * ONE_CREDIT);
      await expect(
        treasury.connect(governance).writeDownPendingGaugeRewards(0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
      await expect(treasury.connect(governance).writeDownPendingGaugeRewards(51n * ONE_CREDIT))
        .to.be.revertedWithCustomError(treasury, "PendingGaugeRewardsInsufficient")
        .withArgs(51n * ONE_CREDIT, 50n * ONE_CREDIT);

      await expect(
        treasury.connect(other).writeDownPolRefillBucket(1n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
      await expect(
        treasury.connect(other).writeDownPendingGaugeRewards(1n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------------------------
  // transfer — CREDIT gated
  // ------------------------------------------------------------------

  describe("transfer — CREDIT limitado ao nao-reservado", function () {
    it("blocks transfer that would invade the buckets", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other } = ctx;

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(600n * ONE_CREDIT);
      await treasury.connect(distributor).depositPendingGaugeRewards(300n * ONE_CREDIT);

      await expect(
        treasury
          .connect(governance)
          .transfer(await credit.getAddress(), other.address, 101n * ONE_CREDIT),
      )
        .to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit")
        .withArgs(100n * ONE_CREDIT, 101n * ONE_CREDIT);
    });

    it("allows transfer up to exactly the unreserved amount; 1 wei more is blocked", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other } = ctx;

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(900n * ONE_CREDIT);

      await expect(
        treasury
          .connect(governance)
          .transfer(await credit.getAddress(), other.address, 100n * ONE_CREDIT),
      )
        .to.emit(treasury, "Transferred")
        .withArgs(await credit.getAddress(), other.address, 100n * ONE_CREDIT);
      expect(await credit.balanceOf(other.address)).to.equal(100n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);

      await expect(
        treasury.connect(governance).transfer(await credit.getAddress(), other.address, 1n),
      )
        .to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit")
        .withArgs(0n, 1n);
    });

    it("amount above balance still reverts InsufficientBalance (check order preserved)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other } = ctx;

      await mintCredit(ctx, 100n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(100n * ONE_CREDIT);

      await expect(
        treasury
          .connect(governance)
          .transfer(await credit.getAddress(), other.address, 150n * ONE_CREDIT),
      )
        .to.be.revertedWithCustomError(treasury, "InsufficientBalance")
        .withArgs(await credit.getAddress(), 150n * ONE_CREDIT, 100n * ONE_CREDIT);
    });

    it("transfer of ANOTHER token (USDC) is not affected by CREDIT buckets", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, usdc, other } = ctx;

      // CREDIT 100% reservado.
      await mintCredit(ctx, 500n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(500n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);

      // USDC sai integral sem gating.
      await treasury
        .connect(governance)
        .transfer(await usdc.getAddress(), other.address, SEED_USDC);
      expect(await usdc.balanceOf(other.address)).to.equal(SEED_USDC);
    });
  });

  // ------------------------------------------------------------------
  // batchTransfer / payRebates — soma das parcelas
  // ------------------------------------------------------------------

  describe("batchTransfer — valida a SOMA das parcelas de CREDIT", function () {
    it("blocks when each installment passes alone but the sum invades the buckets", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other, other2 } = ctx;

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(900n * ONE_CREDIT);
      // unreserved = 100; parcelas 60 e 50 passam isoladas, soma 110 nao.
      await expect(
        treasury
          .connect(governance)
          .batchTransfer(
            await credit.getAddress(),
            [other.address, other2.address],
            [60n * ONE_CREDIT, 50n * ONE_CREDIT],
          ),
      )
        .to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit")
        .withArgs(100n * ONE_CREDIT, 110n * ONE_CREDIT);
    });

    it("allows a batch whose sum equals the unreserved amount", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other, other2 } = ctx;

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(900n * ONE_CREDIT);

      await expect(
        treasury
          .connect(governance)
          .batchTransfer(
            await credit.getAddress(),
            [other.address, other2.address],
            [60n * ONE_CREDIT, 40n * ONE_CREDIT],
          ),
      )
        .to.emit(treasury, "BatchTransferred")
        .withArgs(await credit.getAddress(), 100n * ONE_CREDIT, 2n);
      expect(await credit.balanceOf(other.address)).to.equal(60n * ONE_CREDIT);
      expect(await credit.balanceOf(other2.address)).to.equal(40n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);
    });

    it("batch of ANOTHER token (USDC) is not affected", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, usdc, other, other2 } = ctx;

      await mintCredit(ctx, 500n * ONE_CREDIT);
      await treasury.connect(distributor).depositPendingGaugeRewards(500n * ONE_CREDIT);

      await treasury
        .connect(governance)
        .batchTransfer(
          await usdc.getAddress(),
          [other.address, other2.address],
          [SEED_USDC / 2n, SEED_USDC / 2n],
        );
      expect(await usdc.balanceOf(other.address)).to.equal(SEED_USDC / 2n);
      expect(await usdc.balanceOf(other2.address)).to.equal(SEED_USDC / 2n);
    });
  });

  describe("payRebates — mesma segregacao do batchTransfer", function () {
    it("blocks when the rebate sum invades the buckets", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other, other2 } = ctx;

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      await treasury.connect(distributor).depositPendingGaugeRewards(900n * ONE_CREDIT);

      await expect(
        treasury
          .connect(governance)
          .payRebates(
            await credit.getAddress(),
            [other.address, other2.address],
            [60n * ONE_CREDIT, 50n * ONE_CREDIT],
            1n,
          ),
      )
        .to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit")
        .withArgs(100n * ONE_CREDIT, 110n * ONE_CREDIT);
    });

    it("allows rebates within the unreserved amount", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, other } = ctx;

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      await treasury.connect(distributor).depositPendingGaugeRewards(900n * ONE_CREDIT);

      await expect(
        treasury
          .connect(governance)
          .payRebates(await credit.getAddress(), [other.address], [100n * ONE_CREDIT], 1n),
      )
        .to.emit(treasury, "RebatesPaid")
        .withArgs(await credit.getAddress(), 1n, 100n * ONE_CREDIT, 1n);
      expect(await credit.balanceOf(other.address)).to.equal(100n * ONE_CREDIT);
    });
  });

  // ------------------------------------------------------------------
  // addPOL — saida generica de CREDIT tambem gated
  // ------------------------------------------------------------------

  describe("addPOL — respeita a segregacao", function () {
    it("blocks addPOL whose creditAmount invades the buckets; allows within unreserved", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, npm } = ctx;
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      await mintCredit(ctx, 1000n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(900n * ONE_CREDIT);

      await expect(
        treasury
          .connect(governance)
          .addPOL(101n * ONE_CREDIT, 1000n * ONE_USDC, 0n, 0n, FAR_DEADLINE),
      )
        .to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit")
        .withArgs(100n * ONE_CREDIT, 101n * ONE_CREDIT);

      await treasury
        .connect(governance)
        .addPOL(100n * ONE_CREDIT, 1000n * ONE_USDC, 0n, 0n, FAR_DEADLINE);
      expect(await treasury.polTokenId()).to.equal(1n);
      // Bucket permanece integro (addPOL nao debita ledger).
      expect(await treasury.polRefillBucket()).to.equal(900n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  // Consumidores dos buckets seguem operacionais
  // ------------------------------------------------------------------

  describe("addPOLFromRefill — consome o bucket e libera a reserva", function () {
    it("works even with unreserved == 0 and decrements polRefillBucket", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, npm, other } = ctx;
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      await mintCredit(ctx, 500n * ONE_CREDIT);
      await treasury.connect(distributor).depositPolRefill(500n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(0n);

      // Saida generica bloqueada...
      await expect(
        treasury.connect(governance).transfer(await credit.getAddress(), other.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit");

      // ...mas o caminho dedicado do bucket funciona.
      await expect(
        treasury
          .connect(governance)
          .addPOLFromRefill(500n * ONE_CREDIT, 10_000n * ONE_USDC, 0n, 0n, FAR_DEADLINE),
      )
        .to.emit(treasury, "PolRefillUsed")
        .withArgs(500n * ONE_CREDIT, 10_000n * ONE_USDC, 0n);

      expect(await treasury.polRefillBucket()).to.equal(0n);
      // Reserva liberada: CREDIT novo que chegar volta a ser transferivel.
      await mintCredit(ctx, 50n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(50n * ONE_CREDIT);
      await treasury
        .connect(governance)
        .transfer(await credit.getAddress(), other.address, 50n * ONE_CREDIT);
      expect(await credit.balanceOf(other.address)).to.equal(50n * ONE_CREDIT);
    });
  });

  describe("flushPendingGaugeRewards — consome o bucket e libera a reserva", function () {
    it("works even with unreserved == 0, zeroes the ledger and frees the remainder", async function () {
      const ctx = await loadFixture(deployFixture);
      const { treasury, governance, distributor, credit, gauge, other } = ctx;
      await treasury.connect(governance).setLiquidityGauge(await gauge.getAddress(), 1);

      await mintCredit(ctx, 1200n * ONE_CREDIT);
      await treasury.connect(distributor).depositPendingGaugeRewards(1000n * ONE_CREDIT);
      expect(await treasury.unreservedCreditBalance()).to.equal(200n * ONE_CREDIT);

      // Transferir o balance INTEIRO de CREDIT esta bloqueado (invadiria o bucket).
      await expect(
        treasury
          .connect(governance)
          .transfer(await credit.getAddress(), other.address, 1200n * ONE_CREDIT),
      )
        .to.be.revertedWithCustomError(treasury, "TransferExceedsUnreservedCredit")
        .withArgs(200n * ONE_CREDIT, 1200n * ONE_CREDIT);

      // Flush segue operacional e drena o bucket para o gauge
      // (amount = 0 -> ledger inteiro; poolId = 0 -> default).
      await expect(treasury.connect(governance).flushPendingGaugeRewards(0n, 0n, FLUSH_DURATION))
        .to.emit(treasury, "PendingGaugeFlushed")
        .withArgs(1000n * ONE_CREDIT, 1n, FLUSH_DURATION);
      expect(await treasury.pendingGaugeRewards()).to.equal(0n);
      expect(await credit.balanceOf(await gauge.getAddress())).to.equal(1000n * ONE_CREDIT);

      // Reserva liberada: o restante (200) agora e 100% transferivel.
      expect(await treasury.unreservedCreditBalance()).to.equal(200n * ONE_CREDIT);
      await treasury
        .connect(governance)
        .transfer(await credit.getAddress(), other.address, 200n * ONE_CREDIT);
      expect(await credit.balanceOf(other.address)).to.equal(200n * ONE_CREDIT);
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(0n);
    });
  });
});
