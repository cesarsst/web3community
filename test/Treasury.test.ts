import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Treasury test suite.
 *
 * Cobre:
 *  - Construção (role grants, zero-address).
 *  - transfer (happy, guards, role, custódia exata, evento).
 *  - batchTransfer (happy, mismatch, empty, zero args, role, custódia).
 *  - payRebates (happy, mismatch, empty, zero args, role, evento com round).
 *  - executeBuyback (stub: só emite evento, não move saldo; role; guards).
 *  - receive() ETH (fallback, evento ETHReceived).
 *  - sweepETH (happy, falha, guards, role, evento).
 *  - balanceOf (multi-token).
 *  - Access control: TODAS funções governance-gated revertem para non-role.
 *  - Reentrância: ERC20 malicioso tenta reentrar em transfer/batchTransfer/
 *    payRebates/sweepETH — todas revertem com ReentrancyGuardReentrantCall.
 *  - Custódia passiva: qualquer ERC20 pode ser enviado diretamente ao
 *    treasury; balanceOf reflete.
 */
describe("Treasury", function () {
  const INITIAL_USDC = 1_000_000n * 10n ** 6n; // 1M USDC (6 decimais)
  const INITIAL_GOV_MINT = 10_000_000n * 10n ** 18n; // 10M GOV
  const TRANSFER_AMOUNT = 1_000n * 10n ** 6n; // 1k USDC

  async function deployFixture() {
    const [admin, governance, recipient1, recipient2, recipient3, other, ethFunder] =
      await ethers.getSigners();

    // Stablecoin mock (6 decimais — como USDC — é irrelevante para a lógica)
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    const usdt = await ERC20Mock.deploy("Mock USDT", "USDT");
    await usdt.waitForDeployment();

    // GOV para buyback
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy("Web3Community Governance", "GOV", admin.address);
    await gov.waitForDeployment();

    // CREDIT (necessario para o 3o arg do constructor; nao consumido neste suite).
    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("Credit", "CREDIT", admin.address);
    await credit.waitForDeployment();

    // Treasury: admin inicial = signer[0] (em prod seria o Timelock).
    // 3-arg constructor (Fase 1.1 do pivot CLP): (admin, creditToken, usdcToken).
    // USDC = ZeroAddress aceito (buyback FFP fica desativado por construcao —
    // este suite nao exercita buyback real, apenas verifica access control e
    // guards das funcoes existentes; o teste dedicado a FFP esta em
    // test/Treasury.buyback.test.ts).
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      admin.address,
      await credit.getAddress(),
      ethers.ZeroAddress,
    );
    await treasury.waitForDeployment();

    const DEFAULT_ADMIN_ROLE = await treasury.DEFAULT_ADMIN_ROLE();
    const GOVERNANCE_ROLE = await treasury.GOVERNANCE_ROLE();

    // Admin concede GOVERNANCE_ROLE ao signer "governance" (simulação do Timelock).
    await treasury.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

    // Seed: treasury recebe USDC passivamente.
    await usdc.mint(await treasury.getAddress(), INITIAL_USDC);
    await usdt.mint(await treasury.getAddress(), INITIAL_USDC);
    await gov.connect(admin).mint(await treasury.getAddress(), INITIAL_GOV_MINT, "seed:treasury");

    return {
      treasury,
      usdc,
      usdt,
      gov,
      admin,
      governance,
      recipient1,
      recipient2,
      recipient3,
      other,
      ethFunder,
      DEFAULT_ADMIN_ROLE,
      GOVERNANCE_ROLE,
    };
  }

  describe("construction", function () {
    it("grants DEFAULT_ADMIN_ROLE and GOVERNANCE_ROLE to the admin", async function () {
      const { treasury, admin, DEFAULT_ADMIN_ROLE, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      expect(await treasury.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await treasury.hasRole(GOVERNANCE_ROLE, admin.address)).to.equal(true);
    });

    it("exposes GOVERNANCE_ROLE matching the documented keccak hash", async function () {
      const { treasury } = await loadFixture(deployFixture);
      expect(await treasury.GOVERNANCE_ROLE()).to.equal(ethers.id("GOVERNANCE_ROLE"));
    });

    it("reverts when admin is zero address", async function () {
      const { gov } = await loadFixture(deployFixture);
      const Treasury = await ethers.getContractFactory("Treasury");
      await expect(
        Treasury.deploy(ethers.ZeroAddress, await gov.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(Treasury, "ZeroAddress");
    });

    it("reverts when creditToken is zero address", async function () {
      const [admin] = await ethers.getSigners();
      const Treasury = await ethers.getContractFactory("Treasury");
      await expect(
        Treasury.deploy(admin.address, ethers.ZeroAddress, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(Treasury, "ZeroAddress");
    });

    it("supports IAccessControl interface", async function () {
      const { treasury } = await loadFixture(deployFixture);
      expect(await treasury.supportsInterface("0x7965db0b")).to.equal(true);
      expect(await treasury.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await treasury.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("passive custody", function () {
    it("reflects direct ERC20 transfers via balanceOf(token)", async function () {
      const { treasury, usdc, usdt, gov } = await loadFixture(deployFixture);
      expect(await treasury.balanceOf(await usdc.getAddress())).to.equal(INITIAL_USDC);
      expect(await treasury.balanceOf(await usdt.getAddress())).to.equal(INITIAL_USDC);
      expect(await treasury.balanceOf(await gov.getAddress())).to.equal(INITIAL_GOV_MINT);
    });

    it("receives any ERC20 without explicit deposit function", async function () {
      const { treasury, usdc, recipient1 } = await loadFixture(deployFixture);
      const extra = 500n * 10n ** 6n;
      await usdc.mint(recipient1.address, extra);
      await usdc.connect(recipient1).transfer(await treasury.getAddress(), extra);
      expect(await treasury.balanceOf(await usdc.getAddress())).to.equal(INITIAL_USDC + extra);
    });
  });

  describe("transfer", function () {
    it("transfers tokens to recipient and emits Transferred", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();

      await expect(
        treasury.connect(governance).transfer(tokenAddr, recipient1.address, TRANSFER_AMOUNT),
      )
        .to.emit(treasury, "Transferred")
        .withArgs(tokenAddr, recipient1.address, TRANSFER_AMOUNT);

      expect(await usdc.balanceOf(recipient1.address)).to.equal(TRANSFER_AMOUNT);
      expect(await treasury.balanceOf(tokenAddr)).to.equal(INITIAL_USDC - TRANSFER_AMOUNT);
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, usdc, other, recipient1, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(other)
          .transfer(await usdc.getAddress(), recipient1.address, TRANSFER_AMOUNT),
      )
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts on zero recipient", async function () {
      const { treasury, usdc, governance } = await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .transfer(await usdc.getAddress(), ethers.ZeroAddress, TRANSFER_AMOUNT),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts on zero token", async function () {
      const { treasury, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .transfer(ethers.ZeroAddress, recipient1.address, TRANSFER_AMOUNT),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts on zero amount", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).transfer(await usdc.getAddress(), recipient1.address, 0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts on insufficient balance", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      const huge = INITIAL_USDC + 1n;
      await expect(
        treasury.connect(governance).transfer(await usdc.getAddress(), recipient1.address, huge),
      )
        .to.be.revertedWithCustomError(treasury, "InsufficientBalance")
        .withArgs(await usdc.getAddress(), huge, INITIAL_USDC);
    });
  });

  describe("batchTransfer", function () {
    it("transfers to multiple recipients and emits BatchTransferred", async function () {
      const { treasury, usdc, governance, recipient1, recipient2, recipient3 } =
        await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();
      const recipients = [recipient1.address, recipient2.address, recipient3.address];
      const amounts = [100n * 10n ** 6n, 200n * 10n ** 6n, 300n * 10n ** 6n];
      const total = amounts.reduce((a, b) => a + b, 0n);

      await expect(treasury.connect(governance).batchTransfer(tokenAddr, recipients, amounts))
        .to.emit(treasury, "BatchTransferred")
        .withArgs(tokenAddr, total, 3n);

      expect(await usdc.balanceOf(recipient1.address)).to.equal(amounts[0]);
      expect(await usdc.balanceOf(recipient2.address)).to.equal(amounts[1]);
      expect(await usdc.balanceOf(recipient3.address)).to.equal(amounts[2]);
      expect(await treasury.balanceOf(tokenAddr)).to.equal(INITIAL_USDC - total);
    });

    it("emits one Transferred per recipient", async function () {
      const { treasury, usdc, governance, recipient1, recipient2 } =
        await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();
      const recipients = [recipient1.address, recipient2.address];
      const amounts = [100n * 10n ** 6n, 200n * 10n ** 6n];

      const tx = await treasury.connect(governance).batchTransfer(tokenAddr, recipients, amounts);
      await expect(tx)
        .to.emit(treasury, "Transferred")
        .withArgs(tokenAddr, recipient1.address, amounts[0]);
      await expect(tx)
        .to.emit(treasury, "Transferred")
        .withArgs(tokenAddr, recipient2.address, amounts[1]);
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, usdc, other, recipient1, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await expect(
        treasury.connect(other).batchTransfer(await usdc.getAddress(), [recipient1.address], [1n]),
      )
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts on array length mismatch", async function () {
      const { treasury, usdc, governance, recipient1, recipient2 } =
        await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .batchTransfer(await usdc.getAddress(), [recipient1.address, recipient2.address], [1n]),
      ).to.be.revertedWithCustomError(treasury, "ArrayLengthMismatch");
    });

    it("reverts on empty batch", async function () {
      const { treasury, usdc, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).batchTransfer(await usdc.getAddress(), [], []),
      ).to.be.revertedWithCustomError(treasury, "EmptyBatch");
    });

    it("reverts on zero token", async function () {
      const { treasury, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).batchTransfer(ethers.ZeroAddress, [recipient1.address], [1n]),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts when any recipient is zero", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .batchTransfer(
            await usdc.getAddress(),
            [recipient1.address, ethers.ZeroAddress],
            [1n, 1n],
          ),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts when any amount is zero", async function () {
      const { treasury, usdc, governance, recipient1, recipient2 } =
        await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .batchTransfer(
            await usdc.getAddress(),
            [recipient1.address, recipient2.address],
            [1n, 0n],
          ),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts on insufficient balance for total", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();
      const huge = INITIAL_USDC + 1n;
      await expect(
        treasury.connect(governance).batchTransfer(tokenAddr, [recipient1.address], [huge]),
      )
        .to.be.revertedWithCustomError(treasury, "InsufficientBalance")
        .withArgs(tokenAddr, huge, INITIAL_USDC);
    });
  });

  describe("payRebates", function () {
    const ROUND = 42n;

    it("pays rebates and emits RebatesPaid with round", async function () {
      const { treasury, usdc, governance, recipient1, recipient2 } =
        await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();
      const apps = [recipient1.address, recipient2.address];
      const amounts = [500n * 10n ** 6n, 700n * 10n ** 6n];
      const total = amounts.reduce((a, b) => a + b, 0n);

      await expect(treasury.connect(governance).payRebates(tokenAddr, apps, amounts, ROUND))
        .to.emit(treasury, "RebatesPaid")
        .withArgs(tokenAddr, ROUND, total, 2n);

      expect(await usdc.balanceOf(recipient1.address)).to.equal(amounts[0]);
      expect(await usdc.balanceOf(recipient2.address)).to.equal(amounts[1]);
      expect(await treasury.balanceOf(tokenAddr)).to.equal(INITIAL_USDC - total);
    });

    it("emits Transferred per recipient in payRebates too", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();
      const amounts = [123n * 10n ** 6n];

      await expect(
        treasury.connect(governance).payRebates(tokenAddr, [recipient1.address], amounts, ROUND),
      )
        .to.emit(treasury, "Transferred")
        .withArgs(tokenAddr, recipient1.address, amounts[0]);
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, usdc, other, recipient1, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(other)
          .payRebates(await usdc.getAddress(), [recipient1.address], [1n], ROUND),
      )
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts on mismatch", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .payRebates(await usdc.getAddress(), [recipient1.address], [1n, 2n], ROUND),
      ).to.be.revertedWithCustomError(treasury, "ArrayLengthMismatch");
    });

    it("reverts on empty batch", async function () {
      const { treasury, usdc, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).payRebates(await usdc.getAddress(), [], [], ROUND),
      ).to.be.revertedWithCustomError(treasury, "EmptyBatch");
    });

    it("reverts on zero token", async function () {
      const { treasury, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .payRebates(ethers.ZeroAddress, [recipient1.address], [1n], ROUND),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts when any app is zero", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .payRebates(
            await usdc.getAddress(),
            [recipient1.address, ethers.ZeroAddress],
            [1n, 1n],
            ROUND,
          ),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("reverts when any amount is zero", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury
          .connect(governance)
          .payRebates(await usdc.getAddress(), [recipient1.address], [0n], ROUND),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts on insufficient balance", async function () {
      const { treasury, usdc, governance, recipient1 } = await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();
      const huge = INITIAL_USDC + 1n;
      await expect(
        treasury.connect(governance).payRebates(tokenAddr, [recipient1.address], [huge], ROUND),
      )
        .to.be.revertedWithCustomError(treasury, "InsufficientBalance")
        .withArgs(tokenAddr, huge, INITIAL_USDC);
    });
  });

  // Suite de `executeBuyback` (Fase 1.1 do pivot CLP — modelo FFP) vive em
  // test/Treasury.buyback.test.ts. O stub v1 foi substituido por uma
  // implementacao real (swap USDC->CREDIT + burn), com pre-condicoes
  // numericas (floor, breach 24h, Chainlink sanity, caps). Manter os
  // testes do FFP em arquivo separado evita inflar este suite com mocks
  // de Uniswap/Chainlink usados so la.

  describe("ETH handling", function () {
    it("accepts ETH via receive() and emits ETHReceived", async function () {
      const { treasury, ethFunder } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");

      await expect(ethFunder.sendTransaction({ to: await treasury.getAddress(), value: amount }))
        .to.emit(treasury, "ETHReceived")
        .withArgs(ethFunder.address, amount);

      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(amount);
    });

    it("sweepETH transfers ETH and emits ETHSwept", async function () {
      const { treasury, governance, recipient1, ethFunder } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("2");
      await ethFunder.sendTransaction({ to: await treasury.getAddress(), value: amount });

      const balBefore = await ethers.provider.getBalance(recipient1.address);

      await expect(treasury.connect(governance).sweepETH(recipient1.address, amount))
        .to.emit(treasury, "ETHSwept")
        .withArgs(recipient1.address, amount);

      expect(await ethers.provider.getBalance(recipient1.address)).to.equal(balBefore + amount);
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(0n);
    });

    it("sweepETH reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, other, recipient1, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(treasury.connect(other).sweepETH(recipient1.address, 1n))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("sweepETH reverts on zero recipient", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).sweepETH(ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("sweepETH reverts on zero amount", async function () {
      const { treasury, governance, recipient1 } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).sweepETH(recipient1.address, 0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("sweepETH reverts on insufficient ETH balance", async function () {
      const { treasury, governance, recipient1 } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");
      await expect(treasury.connect(governance).sweepETH(recipient1.address, amount))
        .to.be.revertedWithCustomError(treasury, "InsufficientBalance")
        .withArgs(ethers.ZeroAddress, amount, 0n);
    });

    it("sweepETH reverts with ETHTransferFailed when recipient rejects", async function () {
      // Deploy a contract that rejects ETH: Treasury itself does NOT reject
      // (has receive), so use Governance contract which has no receive — use
      // the GovernanceToken contract (no receive/fallback).
      const { treasury, governance, gov, ethFunder } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");
      await ethFunder.sendTransaction({ to: await treasury.getAddress(), value: amount });

      await expect(
        treasury.connect(governance).sweepETH(await gov.getAddress(), amount),
      ).to.be.revertedWithCustomError(treasury, "ETHTransferFailed");
    });
  });

  describe("access control matrix (I4)", function () {
    it("no governance-gated function is callable by non-role account", async function () {
      const { treasury, usdc, other, recipient1, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      const tokenAddr = await usdc.getAddress();

      const cases = [
        () => treasury.connect(other).transfer(tokenAddr, recipient1.address, 1n),
        () => treasury.connect(other).batchTransfer(tokenAddr, [recipient1.address], [1n]),
        () => treasury.connect(other).payRebates(tokenAddr, [recipient1.address], [1n], 1n),
        () => treasury.connect(other).executeBuyback(1n, 1n),
        () => treasury.connect(other).sweepETH(recipient1.address, 1n),
      ];

      for (const call of cases) {
        await expect(call())
          .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
          .withArgs(other.address, GOVERNANCE_ROLE);
      }
    });
  });

  describe("reentrancy guard", function () {
    async function deployReentrantFixture() {
      const base = await deployFixture();
      const ReentrantERC20Mock = await ethers.getContractFactory("ReentrantERC20Mock");
      const evil = await ReentrantERC20Mock.deploy("Evil", "EVL");
      await evil.waitForDeployment();

      // Seed treasury with evil tokens (passive custody).
      await evil.mint(await base.treasury.getAddress(), 10_000n);

      // Concede GOVERNANCE_ROLE ao mock — o teste isola o `nonReentrant`
      // da camada de access control. Sem o role, a reentrada falharia
      // antes com AccessControlUnauthorizedAccount (o que tambem bloqueia
      // o ataque, mas nao testa o guard especifico).
      await base.treasury
        .connect(base.admin)
        .grantRole(base.GOVERNANCE_ROLE, await evil.getAddress());

      return { ...base, evil };
    }

    it("blocks reentrant call into transfer", async function () {
      const { treasury, evil, governance, recipient1 } = await loadFixture(deployReentrantFixture);
      const evilAddr = await evil.getAddress();

      // Arm: during evil.transfer triggered by treasury, call back into treasury.transfer.
      await evil.armAttack(await treasury.getAddress(), evilAddr, recipient1.address, 1n);

      await expect(
        treasury.connect(governance).transfer(evilAddr, recipient1.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrant call into batchTransfer", async function () {
      const { treasury, evil, governance, recipient1 } = await loadFixture(deployReentrantFixture);
      const evilAddr = await evil.getAddress();

      await evil.armAttack(await treasury.getAddress(), evilAddr, recipient1.address, 1n);

      await expect(
        treasury.connect(governance).batchTransfer(evilAddr, [recipient1.address], [1n]),
      ).to.be.revertedWithCustomError(treasury, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrant call into payRebates", async function () {
      const { treasury, evil, governance, recipient1 } = await loadFixture(deployReentrantFixture);
      const evilAddr = await evil.getAddress();

      await evil.armAttack(await treasury.getAddress(), evilAddr, recipient1.address, 1n);

      await expect(
        treasury.connect(governance).payRebates(evilAddr, [recipient1.address], [1n], 1n),
      ).to.be.revertedWithCustomError(treasury, "ReentrancyGuardReentrantCall");
    });

    // Os testes acima armam reentrada sobre a funcao `transfer` — exercem o
    // guard da linha 192, mas nao marcam o branch `nonReentrant` das outras
    // funcoes (batchTransfer, payRebates, executeBuyback) como cobertos,
    // porque istanbul/solidity-coverage emite o branch por ponto-de-declaracao
    // do modifier. Os testes abaixo usam o `ReentrantCallMock` para reentrar
    // *especificamente* em batchTransfer / payRebates / executeBuyback durante
    // um `transfer` em execucao, forcando o revert-path do guard dessas
    // funcoes a ser visitado. Como `_status` do `ReentrancyGuard` e
    // compartilhado entre todas as funcoes `nonReentrant`, reentrar numa
    // funcao diferente ainda dispara o guard.

    async function deployCrossFnFixture() {
      const base = await deployFixture();
      const Mock = await ethers.getContractFactory("ReentrantCallMock");
      const mock = await Mock.deploy("Cross", "CRX");
      await mock.waitForDeployment();

      // Saldo do mock no treasury para que `transfer` encontre fundos.
      await mock.mint(await base.treasury.getAddress(), 10_000n);

      // Concede GOVERNANCE_ROLE ao mock — reentrada deve passar access control
      // para entao bater no guard (senao veriamos AccessControl revert).
      await base.treasury
        .connect(base.admin)
        .grantRole(base.GOVERNANCE_ROLE, await mock.getAddress());

      return { ...base, mock };
    }

    it("blocks cross-function reentry into batchTransfer", async function () {
      const { treasury, mock, governance, recipient1 } = await loadFixture(deployCrossFnFixture);
      const mockAddr = await mock.getAddress();

      // Durante treasury.transfer -> mock._update, o mock chama
      // treasury.batchTransfer(...). O guard de batchTransfer (linha 214)
      // deve reverter porque _status == ENTERED.
      const reentryData = treasury.interface.encodeFunctionData("batchTransfer", [
        mockAddr,
        [recipient1.address],
        [1n],
      ]);
      await mock.armCall(
        await treasury.getAddress(),
        reentryData,
        await treasury.getAddress(),
        ethers.ZeroAddress,
      );

      await expect(
        treasury.connect(governance).transfer(mockAddr, recipient1.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "ReentrancyGuardReentrantCall");
    });

    it("blocks cross-function reentry into payRebates", async function () {
      const { treasury, mock, governance, recipient1 } = await loadFixture(deployCrossFnFixture);
      const mockAddr = await mock.getAddress();

      const reentryData = treasury.interface.encodeFunctionData("payRebates", [
        mockAddr,
        [recipient1.address],
        [1n],
        42n,
      ]);
      await mock.armCall(
        await treasury.getAddress(),
        reentryData,
        await treasury.getAddress(),
        ethers.ZeroAddress,
      );

      await expect(
        treasury.connect(governance).transfer(mockAddr, recipient1.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "ReentrancyGuardReentrantCall");
    });

    it("blocks cross-function reentry into executeBuyback", async function () {
      const { treasury, mock, governance, recipient1 } = await loadFixture(deployCrossFnFixture);
      const mockAddr = await mock.getAddress();

      // executeBuyback faz call externo (oracle/router/burn), mas seu guard
      // compartilha o flag com os demais `nonReentrant`. Chamar durante
      // `transfer` em execucao deve reverter no entry-check do guard *antes*
      // de qualquer leitura de oracle. Assinatura nova (Fase 1.1):
      // (uint256 usdcAmount, uint256 minCreditOut).
      const reentryData = treasury.interface.encodeFunctionData("executeBuyback", [100n, 1n]);
      await mock.armCall(
        await treasury.getAddress(),
        reentryData,
        await treasury.getAddress(),
        ethers.ZeroAddress,
      );

      await expect(
        treasury.connect(governance).transfer(mockAddr, recipient1.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrant call into sweepETH via receive-hook attacker", async function () {
      const { treasury, admin, governance, ethFunder, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);

      const amount = ethers.parseEther("1");
      await ethFunder.sendTransaction({ to: await treasury.getAddress(), value: amount });

      const Attacker = await ethers.getContractFactory("ReentrantETHReceiver");
      const attacker = await Attacker.deploy(await treasury.getAddress(), amount);
      await attacker.waitForDeployment();

      // Concede GOVERNANCE_ROLE ao attacker para que o revert seja do guard
      // (nao de AccessControl) durante a reentrada no receive().
      await treasury.connect(admin).grantRole(GOVERNANCE_ROLE, await attacker.getAddress());

      // A chamada externa deve reverter porque o receive() do attacker tenta
      // reentrar em sweepETH. `call{value:}` falha (reverts internos nao
      // bubble pelo call), entao o treasury reverte com ETHTransferFailed —
      // que e a consequencia correta de um `call` falho. Aceitamos ambos os
      // caminhos (o importante e que nao ocorre drain: saldo nao muda).
      const balBefore = await ethers.provider.getBalance(await treasury.getAddress());
      await expect(
        treasury.connect(governance).sweepETH(await attacker.getAddress(), amount),
      ).to.be.revertedWithCustomError(treasury, "ETHTransferFailed");
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(balBefore);
    });
  });
});
