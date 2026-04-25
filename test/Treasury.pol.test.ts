import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Treasury.pol (POL — Fase 1.2 do pivot CLP) test suite.
 *
 * Cobertura conforme spec do user (audit/economist/2026-04-24-pol-params.md):
 *  - Happy path: addPOL inicial -> addPOL incremento -> collectPOLFees
 *    -> removePOL parcial -> removePOL total.
 *  - Token ordering: testar com CREDIT < USDC E CREDIT > USDC.
 *  - Caminho 1: addPOL antes de positionManager setado -> revert
 *    `BuybackInfraMissing`.
 *  - Caminho 2: removePOL/collectPOLFees antes de polTokenId existir
 *    -> revert `POLNotInitialized`.
 *  - Caminho 3: caller sem GOVERNANCE_ROLE em todas as funcoes -> revert.
 *  - Caminho 4: ZeroAmount em addPOL/removePOL.
 *  - Caminho 5: slippage triggered (mock retorna menos que minOut)
 *    -> revert do NPM repassado.
 *  - Verifica eventos.
 *  - Verifica state apos cada operacao (polTokenId, balances, ownership).
 *
 * Mocks:
 *  - NonfungiblePositionManagerMock: mint/increase/decrease/collect/positions.
 *  - ERC20Mock para USDC e (em alguns testes) para forcar ordering CREDIT > USDC.
 */
describe("Treasury — POL (Fase 1.2)", function () {
  const ONE_USDC = 10n ** 6n;
  const ONE_CREDIT = 10n ** 18n;
  const SEED_CREDIT = 1_000_000n * ONE_CREDIT; // 1M CREDIT
  const SEED_USDC = 100_000n * ONE_USDC; // 100k USDC
  const FAR_DEADLINE = 2n ** 32n - 1n; // qualquer timestamp futuro suficiente

  /* eslint-disable @typescript-eslint/no-explicit-any */
  async function deployBaseFixture(creditFirst = true) {
    const [admin, governance, other] = await ethers.getSigners();

    // CREDIT real (BURNER_ROLE para qualquer scenario que precise; aqui POL
    // nao queima, mas mantemos o setup parecido com o suite de buyback).
    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("Web3Community Credit", "CREDIT", admin.address);
    await credit.waitForDeployment();

    // USDC mock — vamos deployar varios mocks ate obter ordering desejado.
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    let usdc: any = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();
    const creditAddr = await credit.getAddress();

    // Iterar deploys de USDC mock ate achar um endereco que respeite o
    // ordering desejado. Hardhat deriva enderecos via nonce do deployer,
    // entao deploys subsequentes movem o address — o `attempts` precisa
    // ser generoso pra cobrir o pior caso onde os primeiros N enderecos
    // saem todos do lado errado. 200 e suficiente na pratica
    // (probabilidade de cair no mesmo lado por mais de 200 deploys
    // consecutivos e ~6e-61).
    let attempts = 0;
    let satisfied = false;
    while (attempts <= 200) {
      const usdcAddr = await usdc.getAddress();
      const isCreditFirst = creditAddr.toLowerCase() < usdcAddr.toLowerCase();
      if (isCreditFirst === creditFirst) {
        satisfied = true;
        break;
      }
      usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
      await usdc.waitForDeployment();
      attempts++;
    }
    if (!satisfied) {
      throw new Error("Could not find USDC mock address with desired ordering");
    }

    // Treasury.
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      admin.address,
      await credit.getAddress(),
      await usdc.getAddress(),
    );
    await treasury.waitForDeployment();

    const GOVERNANCE_ROLE = await treasury.GOVERNANCE_ROLE();
    await treasury.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

    // NPM mock.
    const NPMMock = await ethers.getContractFactory("NonfungiblePositionManagerMock");
    const npm = await NPMMock.deploy();
    await npm.waitForDeployment();

    // Pre-fund Treasury com CREDIT e USDC para seed.
    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
    await credit
      .connect(admin)
      .mint(await treasury.getAddress(), SEED_CREDIT * 10n, "pol-test-seed");
    await usdc.mint(await treasury.getAddress(), SEED_USDC * 10n);

    return {
      admin,
      governance,
      other,
      credit,
      usdc,
      treasury,
      npm,
      GOVERNANCE_ROLE,
    };
  }

  async function deployFixture() {
    return deployBaseFixture(true);
  }

  async function deployFixtureCreditSecond() {
    return deployBaseFixture(false);
  }

  /* eslint-enable @typescript-eslint/no-explicit-any */

  // -------------------------------------------------------- 1. setter / infra
  describe("setPositionManager", function () {
    it("is governance-gated", async function () {
      const { treasury, other, npm, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(treasury.connect(other).setPositionManager(await npm.getAddress()))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("emits BuybackInfraUpdated with paramKey 'positionManager'", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await expect(treasury.connect(governance).setPositionManager(await npm.getAddress()))
        .to.emit(treasury, "BuybackInfraUpdated")
        .withArgs(ethers.encodeBytes32String("positionManager"), await npm.getAddress(), 0n);
      expect(await treasury.positionManager()).to.equal(await npm.getAddress());
    });

    it("can be reset to zero (disables POL)", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await treasury.connect(governance).setPositionManager(ethers.ZeroAddress);
      expect(await treasury.positionManager()).to.equal(ethers.ZeroAddress);
    });
  });

  // -------------------------------------------------------- 2. addPOL — guards
  describe("addPOL — pre-conditions", function () {
    it("reverts BuybackInfraMissing when positionManager not set", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "BuybackInfraMissing");
    });

    it("reverts BuybackInfraMissing when USDC_TOKEN is zero", async function () {
      const { admin, credit, governance, npm } = await loadFixture(deployFixture);
      const Treasury = await ethers.getContractFactory("Treasury");
      const t2 = await Treasury.deploy(
        admin.address,
        await credit.getAddress(),
        ethers.ZeroAddress,
      );
      await t2.waitForDeployment();
      const role = await t2.GOVERNANCE_ROLE();
      await t2.connect(admin).grantRole(role, governance.address);
      await t2.connect(governance).setPositionManager(await npm.getAddress());
      await expect(
        t2.connect(governance).addPOL(1n, 1n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(t2, "BuybackInfraMissing");
    });

    it("reverts ZeroAmount when both amounts are zero", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await expect(
        treasury.connect(governance).addPOL(0n, 0n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, other, npm, governance, GOVERNANCE_ROLE } =
        await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await expect(treasury.connect(other).addPOL(1n, 1n, 0n, 0n, FAR_DEADLINE))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts when slippage forces NPM revert (Price slippage check)", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await npm.setForceSlippageRevert(true);
      await expect(
        treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWith("Price slippage check");
    });
  });

  // -------------------------------------------------------- 3. addPOL — happy path
  describe("addPOL — happy path", function () {
    it("first call mints NFT, stores polTokenId, and emits POLAdded (CREDIT < USDC)", async function () {
      const { treasury, governance, credit, usdc, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      expect(await treasury.polTokenId()).to.equal(0n);

      const treasuryAddr = await treasury.getAddress();
      const creditBefore = await credit.balanceOf(treasuryAddr);
      const usdcBefore = await usdc.balanceOf(treasuryAddr);

      const tx = await treasury
        .connect(governance)
        .addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);

      // Mock cunha tokenId monotonico comecando em 1.
      const expectedTokenId = 1n;
      // Liquidity = a0 + a1 (formula simplificada do mock).
      const expectedLiquidity = SEED_CREDIT + SEED_USDC;

      await expect(tx)
        .to.emit(treasury, "POLAdded")
        .withArgs(expectedTokenId, expectedLiquidity, SEED_CREDIT, SEED_USDC);

      expect(await treasury.polTokenId()).to.equal(expectedTokenId);

      // Treasury debitado (CREDIT < USDC ordering: token0 = CREDIT).
      expect(await credit.balanceOf(treasuryAddr)).to.equal(creditBefore - SEED_CREDIT);
      expect(await usdc.balanceOf(treasuryAddr)).to.equal(usdcBefore - SEED_USDC);

      // NPM custodiou os tokens.
      const npmAddr = await npm.getAddress();
      expect(await credit.balanceOf(npmAddr)).to.equal(SEED_CREDIT);
      expect(await usdc.balanceOf(npmAddr)).to.equal(SEED_USDC);

      // Approve foi resetado (defensivo).
      expect(await credit.allowance(treasuryAddr, npmAddr)).to.equal(0n);
      expect(await usdc.allowance(treasuryAddr, npmAddr)).to.equal(0n);
    });

    it("second call hits increaseLiquidity on the same tokenId", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      // Primeira.
      await treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);
      const tokenId1 = await treasury.polTokenId();
      expect(tokenId1).to.equal(1n);

      // Segunda — mesmo tokenId, sem cunhar novo.
      const addAmount = SEED_CREDIT / 2n;
      const addUsdc = SEED_USDC / 2n;
      const tx = await treasury
        .connect(governance)
        .addPOL(addAmount, addUsdc, 0n, 0n, FAR_DEADLINE);

      await expect(tx)
        .to.emit(treasury, "POLAdded")
        .withArgs(tokenId1, addAmount + addUsdc, addAmount, addUsdc);

      // tokenId nao mudou.
      expect(await treasury.polTokenId()).to.equal(tokenId1);

      // Posicao acumulou.
      const pos = await treasury.polPosition();
      expect(pos.tokenId).to.equal(tokenId1);
      expect(pos.liquidity).to.equal(SEED_CREDIT + SEED_USDC + addAmount + addUsdc);
    });

    it("works with credit-only seed (usdcAmount = 0)", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await expect(treasury.connect(governance).addPOL(SEED_CREDIT, 0n, 0n, 0n, FAR_DEADLINE))
        .to.emit(treasury, "POLAdded")
        .withArgs(1n, SEED_CREDIT, SEED_CREDIT, 0n);
    });

    it("works with usdc-only seed (creditAmount = 0)", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await expect(treasury.connect(governance).addPOL(0n, SEED_USDC, 0n, 0n, FAR_DEADLINE))
        .to.emit(treasury, "POLAdded")
        .withArgs(1n, SEED_USDC, 0n, SEED_USDC);
    });
  });

  // -------------------------------------------------------- 4. token ordering
  describe("addPOL — token ordering", function () {
    it("CREDIT < USDC: token0 = CREDIT, token1 = USDC", async function () {
      const { treasury, credit, usdc } = await loadFixture(deployFixture);
      const ordered = await treasury.polTokensOrdered();
      const creditAddr = (await credit.getAddress()).toLowerCase();
      const usdcAddr = (await usdc.getAddress()).toLowerCase();
      expect(creditAddr < usdcAddr).to.be.true;
      expect(ordered.token0.toLowerCase()).to.equal(creditAddr);
      expect(ordered.token1.toLowerCase()).to.equal(usdcAddr);
      expect(ordered.creditIsToken0).to.be.true;
    });

    it("CREDIT > USDC: token0 = USDC, token1 = CREDIT", async function () {
      const { treasury, credit, usdc } = await loadFixture(deployFixtureCreditSecond);
      const ordered = await treasury.polTokensOrdered();
      const creditAddr = (await credit.getAddress()).toLowerCase();
      const usdcAddr = (await usdc.getAddress()).toLowerCase();
      expect(creditAddr > usdcAddr).to.be.true;
      expect(ordered.token0.toLowerCase()).to.equal(usdcAddr);
      expect(ordered.token1.toLowerCase()).to.equal(creditAddr);
      expect(ordered.creditIsToken0).to.be.false;
    });

    it("addPOL passes correctly ordered amounts to NPM (CREDIT > USDC)", async function () {
      const { treasury, governance, credit, usdc, npm } =
        await loadFixture(deployFixtureCreditSecond);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      const treasuryAddr = await treasury.getAddress();
      const creditBefore = await credit.balanceOf(treasuryAddr);
      const usdcBefore = await usdc.balanceOf(treasuryAddr);

      // Caller passa creditAmount/usdcAmount nas variaveis nativas; o
      // helper interno reordena para o NPM.
      await treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);

      // Treasury debitado em ambos.
      expect(await credit.balanceOf(treasuryAddr)).to.equal(creditBefore - SEED_CREDIT);
      expect(await usdc.balanceOf(treasuryAddr)).to.equal(usdcBefore - SEED_USDC);

      // Verifica via NPM (positions): token0 = USDC, token1 = CREDIT.
      const tokenId = await treasury.polTokenId();
      const pos = await npm.storedPositions(tokenId);
      expect(pos.token0.toLowerCase()).to.equal((await usdc.getAddress()).toLowerCase());
      expect(pos.token1.toLowerCase()).to.equal((await credit.getAddress()).toLowerCase());
      // deposited0 = USDC, deposited1 = CREDIT.
      expect(pos.deposited0).to.equal(SEED_USDC);
      expect(pos.deposited1).to.equal(SEED_CREDIT);
    });

    it("event POLAdded reports (creditConsumed, usdcConsumed) regardless of ordering", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixtureCreditSecond);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      // CREDIT > USDC, mas o evento ainda traz CREDIT no slot creditAmount.
      await expect(
        treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE),
      )
        .to.emit(treasury, "POLAdded")
        .withArgs(1n, SEED_CREDIT + SEED_USDC, SEED_CREDIT, SEED_USDC);
    });
  });

  // -------------------------------------------------------- 5. removePOL
  describe("removePOL", function () {
    async function readyFixture() {
      const f = await deployFixture();
      await f.treasury.connect(f.governance).setPositionManager(await f.npm.getAddress());
      await f.treasury.connect(f.governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);
      return f;
    }

    it("reverts POLNotInitialized when polTokenId == 0", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await expect(
        treasury.connect(governance).removePOL(1n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "POLNotInitialized");
    });

    it("reverts ZeroAmount when liquidityAmount is 0", async function () {
      const { treasury, governance } = await loadFixture(readyFixture);
      await expect(
        treasury.connect(governance).removePOL(0n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts BuybackInfraMissing if positionManager is reset to zero post-init", async function () {
      const { treasury, governance } = await loadFixture(readyFixture);
      await treasury.connect(governance).setPositionManager(ethers.ZeroAddress);
      await expect(
        treasury.connect(governance).removePOL(1n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(treasury, "BuybackInfraMissing");
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, other, GOVERNANCE_ROLE } = await loadFixture(readyFixture);
      await expect(treasury.connect(other).removePOL(1n, 0n, 0n, FAR_DEADLINE))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("partial remove: returns proportional principal to Treasury and emits POLRemoved", async function () {
      const { treasury, governance, credit, usdc } = await loadFixture(readyFixture);

      const treasuryAddr = await treasury.getAddress();
      const creditBefore = await credit.balanceOf(treasuryAddr);
      const usdcBefore = await usdc.balanceOf(treasuryAddr);

      const initialLiquidity = SEED_CREDIT + SEED_USDC;
      const removeLiq = initialLiquidity / 4n; // 25%

      const tokenId = await treasury.polTokenId();

      // Mock distribui proporcionalmente: amount0 = deposited0 * liq / totalLiq
      // CREDIT < USDC: deposited0 = CREDIT (SEED_CREDIT), deposited1 = USDC (SEED_USDC)
      const expectedAmount0 = (SEED_CREDIT * removeLiq) / initialLiquidity;
      const expectedAmount1 = (SEED_USDC * removeLiq) / initialLiquidity;

      await expect(treasury.connect(governance).removePOL(removeLiq, 0n, 0n, FAR_DEADLINE))
        .to.emit(treasury, "POLRemoved")
        .withArgs(tokenId, removeLiq, expectedAmount0, expectedAmount1);

      // Treasury creditado.
      expect(await credit.balanceOf(treasuryAddr)).to.equal(creditBefore + expectedAmount0);
      expect(await usdc.balanceOf(treasuryAddr)).to.equal(usdcBefore + expectedAmount1);

      // tokenId persiste, liquidez reduzida.
      expect(await treasury.polTokenId()).to.equal(tokenId);
      const pos = await treasury.polPosition();
      expect(pos.liquidity).to.equal(initialLiquidity - removeLiq);
    });

    it("full remove: zeroes liquidity but keeps polTokenId (does not burn NFT)", async function () {
      const { treasury, governance } = await loadFixture(readyFixture);
      const initialLiquidity = SEED_CREDIT + SEED_USDC;
      const tokenId = await treasury.polTokenId();

      await treasury.connect(governance).removePOL(BigInt(initialLiquidity), 0n, 0n, FAR_DEADLINE);

      // tokenId NAO foi zerado.
      expect(await treasury.polTokenId()).to.equal(tokenId);
      const pos = await treasury.polPosition();
      expect(pos.liquidity).to.equal(0n);

      // Pode reusar a posicao via addPOL incremento.
      await treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);
      expect(await treasury.polTokenId()).to.equal(tokenId);
    });

    it("reverts when slippage forces NPM revert during decreaseLiquidity", async function () {
      const { treasury, governance, npm } = await loadFixture(readyFixture);
      await npm.setForceSlippageRevert(true);
      await expect(
        treasury.connect(governance).removePOL(100n, 0n, 0n, FAR_DEADLINE),
      ).to.be.revertedWith("Price slippage check");
    });
  });

  // -------------------------------------------------------- 6. collectPOLFees
  describe("collectPOLFees", function () {
    async function readyFixture() {
      const f = await deployFixture();
      await f.treasury.connect(f.governance).setPositionManager(await f.npm.getAddress());
      await f.treasury.connect(f.governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);
      return f;
    }

    it("reverts POLNotInitialized when polTokenId == 0", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await expect(
        treasury.connect(governance).collectPOLFees(0n, 0n),
      ).to.be.revertedWithCustomError(treasury, "POLNotInitialized");
    });

    it("reverts BuybackInfraMissing if positionManager is reset post-init", async function () {
      const { treasury, governance } = await loadFixture(readyFixture);
      await treasury.connect(governance).setPositionManager(ethers.ZeroAddress);
      await expect(
        treasury.connect(governance).collectPOLFees(1n, 1n),
      ).to.be.revertedWithCustomError(treasury, "BuybackInfraMissing");
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, other, GOVERNANCE_ROLE } = await loadFixture(readyFixture);
      await expect(treasury.connect(other).collectPOLFees(1n, 1n))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("collects accrued fees and forwards to Treasury (CREDIT < USDC ordering)", async function () {
      const { treasury, governance, credit, usdc, npm, admin } = await loadFixture(readyFixture);

      const treasuryAddr = await treasury.getAddress();
      const tokenId = await treasury.polTokenId();

      // Pre-fund o NPM com saldo extra para ter de onde transferir os fees.
      const fee0 = 100n * ONE_CREDIT; // CREDIT (token0)
      const fee1 = 50n * ONE_USDC; // USDC (token1)
      // O mock acrueFees nao move tokens — precisamos enviar saldo manualmente
      // para o NPM antes de o `collect()` transferir de volta.
      const MINTER_ROLE = await credit.MINTER_ROLE();
      await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
      await credit.connect(admin).mint(await npm.getAddress(), fee0, "fee-prefund");
      await usdc.mint(await npm.getAddress(), fee1);

      // Acrue fees no mock.
      await npm.accrueFees(tokenId, fee0, fee1);

      const creditBefore = await credit.balanceOf(treasuryAddr);
      const usdcBefore = await usdc.balanceOf(treasuryAddr);

      // Coleta tudo (uint128.max).
      const MAX_U128 = 2n ** 128n - 1n;
      await expect(treasury.connect(governance).collectPOLFees(MAX_U128, MAX_U128))
        .to.emit(treasury, "POLFeesCollected")
        .withArgs(tokenId, fee0, fee1);

      expect(await credit.balanceOf(treasuryAddr)).to.equal(creditBefore + fee0);
      expect(await usdc.balanceOf(treasuryAddr)).to.equal(usdcBefore + fee1);
    });

    it("respects amount0Max / amount1Max caps (partial collect)", async function () {
      const { treasury, governance, credit, usdc, npm, admin } = await loadFixture(readyFixture);

      const tokenId = await treasury.polTokenId();
      const fee0 = 100n * ONE_CREDIT;
      const fee1 = 50n * ONE_USDC;
      const MINTER_ROLE = await credit.MINTER_ROLE();
      await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
      await credit.connect(admin).mint(await npm.getAddress(), fee0, "fee-prefund");
      await usdc.mint(await npm.getAddress(), fee1);
      await npm.accrueFees(tokenId, fee0, fee1);

      // Coleta apenas metade dos fees0 e nada de fees1.
      const half0 = fee0 / 2n;
      await expect(treasury.connect(governance).collectPOLFees(uint128(half0), 0n))
        .to.emit(treasury, "POLFeesCollected")
        .withArgs(tokenId, half0, 0n);

      // Restante ainda owed.
      const pos = await treasury.polPosition();
      expect(pos.tokensOwed0).to.equal(fee0 - half0);
      expect(pos.tokensOwed1).to.equal(fee1);
    });
  });

  // -------------------------------------------------------- 7. polPosition view
  describe("polPosition", function () {
    it("reverts POLNotInitialized before first addPOL", async function () {
      const { treasury } = await loadFixture(deployFixture);
      await expect(treasury.polPosition()).to.be.revertedWithCustomError(
        treasury,
        "POLNotInitialized",
      );
    });

    it("returns full position state after addPOL", async function () {
      const { treasury, governance, npm } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());
      await treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);
      const pos = await treasury.polPosition();
      expect(pos.tokenId).to.equal(1n);
      expect(pos.liquidity).to.equal(SEED_CREDIT + SEED_USDC);
      expect(pos.tickLower).to.equal(-887220n);
      expect(pos.tickUpper).to.equal(887220n);
      expect(pos.tokensOwed0).to.equal(0n);
      expect(pos.tokensOwed1).to.equal(0n);
    });
  });

  // -------------------------------------------------------- 8. full lifecycle
  describe("full lifecycle: add -> add -> collectFees -> remove partial -> remove total", function () {
    it("happy path end-to-end", async function () {
      const { treasury, governance, credit, usdc, npm, admin } = await loadFixture(deployFixture);
      await treasury.connect(governance).setPositionManager(await npm.getAddress());

      // (1) add inicial
      await treasury.connect(governance).addPOL(SEED_CREDIT, SEED_USDC, 0n, 0n, FAR_DEADLINE);
      const tokenId = await treasury.polTokenId();
      expect(tokenId).to.equal(1n);

      // (2) add incremental
      await treasury
        .connect(governance)
        .addPOL(SEED_CREDIT / 2n, SEED_USDC / 2n, 0n, 0n, FAR_DEADLINE);
      expect(await treasury.polTokenId()).to.equal(tokenId);
      let pos = await treasury.polPosition();
      const totalLiq = SEED_CREDIT + SEED_USDC + (SEED_CREDIT + SEED_USDC) / 2n;
      expect(pos.liquidity).to.equal(totalLiq);

      // (3) accrue fees + collect
      const fee0 = 10n * ONE_CREDIT;
      const fee1 = 5n * ONE_USDC;
      const MINTER_ROLE = await credit.MINTER_ROLE();
      await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
      await credit.connect(admin).mint(await npm.getAddress(), fee0, "fee");
      await usdc.mint(await npm.getAddress(), fee1);
      await npm.accrueFees(tokenId, fee0, fee1);
      const MAX_U128 = 2n ** 128n - 1n;
      await treasury.connect(governance).collectPOLFees(MAX_U128, MAX_U128);

      // (4) partial remove (50%)
      const halfLiq = totalLiq / 2n;
      await treasury.connect(governance).removePOL(halfLiq, 0n, 0n, FAR_DEADLINE);
      pos = await treasury.polPosition();
      expect(pos.liquidity).to.equal(totalLiq - halfLiq);

      // (5) total remove
      await treasury.connect(governance).removePOL(pos.liquidity, 0n, 0n, FAR_DEADLINE);
      pos = await treasury.polPosition();
      expect(pos.liquidity).to.equal(0n);

      // tokenId persiste.
      expect(await treasury.polTokenId()).to.equal(tokenId);
    });
  });
});

// Pequeno helper: ethers v6 nao aceita BigInt direto em `withArgs` de
// uint128 sem coercao explicita. Usamos `BigInt` comum (TypeScript bigint)
// para as comparacoes. Funcao utilitaria mantida para clareza visual.
function uint128(v: bigint): bigint {
  return v;
}
