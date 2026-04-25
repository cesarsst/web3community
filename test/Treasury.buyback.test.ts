import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Treasury.buyback (FFP — Fase 1.1 do pivot CLP) test suite.
 *
 * Cobertura mandatoria conforme spec do user (audit/economist/2026-04-24-credit-peg.md):
 *  - Happy path: floor breach 24h + execute -> swap + burn + ledger atualizado.
 *  - Caminho 1: spot acima do floor -> SpotAboveFloor.
 *  - Caminho 2: breach < 24h -> BreachDurationInsufficient.
 *  - Caminho 3: Chainlink USDC fora de 0.99-1.01 -> UsdcDepegDetected.
 *  - Caminho 4: cap por evento estourado -> CapPerEventExceeded.
 *  - Caminho 5: cap mensal estourado -> CapMonthlyExceeded.
 *  - Caminho 6: slippage > 1% (output abaixo de minCreditOut) -> revert do router.
 *  - Caminho 7: caller sem GOVERNANCE_ROLE -> AccessControlUnauthorizedAccount.
 *  - recordDailyPrice cooldown.
 *  - Rollover de mes (reset implicito de monthlySpent quando monthIdx muda).
 *  - Setters governance-gated com bounds.
 *
 * Mocks:
 *  - UniswapV3PoolMock: implementa ICreditPriceOracle (peekTwapPrice).
 *  - UniswapV3SwapRouterMock: 1:1 USDC->CREDIT em wei (com slippage override).
 *  - ChainlinkAggregatorMock: feed USDC/USD setavel.
 *  - ERC20Mock para USDC (mint publico).
 *  - CreditToken real (BURNER_ROLE concedido ao Treasury para queima).
 */
describe("Treasury — FFP buyback (Fase 1.1)", function () {
  const ONE_USD_18 = 10n ** 18n; // 1.00 USD com 18 decimais
  const FLOOR_ABS = 10n ** 17n; // $0.10 com 18 decimais (default floorAbsoluteUsd)
  const USDC_DECIMALS = 6n;
  const ONE_USDC = 10n ** USDC_DECIMALS;
  const TREASURY_USDC_INITIAL = 1_000_000n * ONE_USDC; // 1M USDC

  async function deployFixture() {
    const [admin, governance, keeper, other] = await ethers.getSigners();

    // CREDIT real (precisa do BURNER_ROLE para o Treasury queimar).
    const CreditToken = await ethers.getContractFactory("CreditToken");
    const credit = await CreditToken.deploy("Web3Community Credit", "CREDIT", admin.address);
    await credit.waitForDeployment();

    // USDC mock (mint publico).
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // Oracle (TWAP) + Router + Chainlink feed.
    const PoolMock = await ethers.getContractFactory("UniswapV3PoolMock");
    const oracle = await PoolMock.deploy();
    await oracle.waitForDeployment();
    await oracle.setPrice(ONE_USD_18); // $1.00 inicial

    const RouterMock = await ethers.getContractFactory("UniswapV3SwapRouterMock");
    const router = await RouterMock.deploy();
    await router.waitForDeployment();

    const FeedMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
    const feed = await FeedMock.deploy();
    await feed.waitForDeployment();
    // Feed comeca em $1.00 com timestamp atual.
    await feed.setUpdatedAt(await time.latest());

    // Treasury: admin = signer[0], CREDIT real, USDC mock.
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      admin.address,
      await credit.getAddress(),
      await usdc.getAddress(),
    );
    await treasury.waitForDeployment();

    const GOVERNANCE_ROLE = await treasury.GOVERNANCE_ROLE();
    await treasury.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);

    // Configura infra do FFP.
    await treasury.connect(governance).setPriceOracle(await oracle.getAddress());
    await treasury.connect(governance).setSwapRouter(await router.getAddress());
    await treasury.connect(governance).setChainlinkFeed(await feed.getAddress());

    // BURNER_ROLE para o Treasury no CREDIT (pre-condicao operacional).
    const BURNER_ROLE = await credit.BURNER_ROLE();
    await credit.connect(admin).grantRole(BURNER_ROLE, await treasury.getAddress());

    // MINTER_ROLE para o admin (apenas para pre-fundar o router mock com
    // CREDIT — o router transfere tokenOut do proprio saldo).
    const MINTER_ROLE = await credit.MINTER_ROLE();
    await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
    // Pre-fund router com 100M CREDIT (suficiente para todos os swaps do suite).
    await credit
      .connect(admin)
      .mint(await router.getAddress(), 100_000_000n * 10n ** 18n, "router-mock-prefund");

    // Seed Treasury com USDC.
    await usdc.mint(await treasury.getAddress(), TREASURY_USDC_INITIAL);

    return {
      admin,
      governance,
      keeper,
      other,
      credit,
      usdc,
      oracle,
      router,
      feed,
      treasury,
      GOVERNANCE_ROLE,
    };
  }

  /**
   * Bootstrappa a MA90 chamando recordDailyPrice 90x com price=ONE_USD_18.
   * Apos esta chamada, MA90 == $1.00 e floor == max(0.5*$1.00, $0.10) = $0.50.
   * Tipos `unknown` usados deliberadamente: o suite usa TypeChain dinamico
   * (factory generica) e tipos exatos mudariam com a regeracao das ABIs;
   * `unknown` + casts pontuais e mais resiliente que tipar contra
   * `Treasury` / `UniswapV3PoolMock` / etc explicitamente.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  async function bootstrapMa90(
    treasury: any,
    oracle: any,
    feed: any,
    keeper: any,
    priceUsd18: bigint,
  ) {
    /* eslint-enable @typescript-eslint/no-explicit-any */
    await oracle.setPrice(priceUsd18);
    for (let i = 0; i < 90; i++) {
      await time.increase(22 * 60 * 60 + 60); // cooldown + 1min
      // Mantem feed Chainlink fresco a cada iteracao (nao usado em
      // recordDailyPrice, mas evita ChainlinkStale apos o bootstrap longo).
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
    }
  }

  // ---------------------------------------------------------------- 1. setup
  describe("constructor + infra", function () {
    it("immutable CREDIT_TOKEN and USDC_TOKEN are set", async function () {
      const { treasury, credit, usdc } = await loadFixture(deployFixture);
      expect(await treasury.CREDIT_TOKEN()).to.equal(await credit.getAddress());
      expect(await treasury.USDC_TOKEN()).to.equal(await usdc.getAddress());
    });

    it("infra setters are governance-gated", async function () {
      const { treasury, other, GOVERNANCE_ROLE } = await loadFixture(deployFixture);
      await expect(treasury.connect(other).setPriceOracle(other.address))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
      await expect(treasury.connect(other).setSwapRouter(other.address))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
      await expect(treasury.connect(other).setChainlinkFeed(other.address))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
      await expect(treasury.connect(other).setSwapFeeTier(3000))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("setSwapFeeTier rejects zero", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(treasury.connect(governance).setSwapFeeTier(0)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAmount",
      );
    });

    it("emits BuybackInfraUpdated on infra set", async function () {
      const { treasury, governance, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(governance).setPriceOracle(other.address))
        .to.emit(treasury, "BuybackInfraUpdated")
        .withArgs(ethers.encodeBytes32String("priceOracle"), other.address, 0n);
      await expect(treasury.connect(governance).setSwapFeeTier(500))
        .to.emit(treasury, "BuybackInfraUpdated")
        .withArgs(ethers.encodeBytes32String("swapFeeTier"), ethers.ZeroAddress, 500n);
    });
  });

  // ---------------------------------------------------------------- 2. setters bounds
  describe("FFP param setters bounds", function () {
    it("setFloorMultiplierBps enforces [3000, 8000]", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).setFloorMultiplierBps(2999),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setFloorMultiplierBps(8001),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(treasury.connect(governance).setFloorMultiplierBps(3000))
        .to.emit(treasury, "BuybackParamsUpdated")
        .withArgs(ethers.encodeBytes32String("floorMultiplierBps"), 3000n);
      await treasury.connect(governance).setFloorMultiplierBps(8000);
      expect(await treasury.floorMultiplierBps()).to.equal(8000n);
    });

    it("setFloorAbsoluteUsd enforces [1e16, 1e19]", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).setFloorAbsoluteUsd(10n ** 15n),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setFloorAbsoluteUsd(10n ** 20n),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await treasury.connect(governance).setFloorAbsoluteUsd(10n ** 17n);
      expect(await treasury.floorAbsoluteUsd()).to.equal(10n ** 17n);
    });

    it("setTriggerDurationSecs enforces [1h, 7d]", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).setTriggerDurationSecs(60),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setTriggerDurationSecs(8 * 24 * 60 * 60),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await treasury.connect(governance).setTriggerDurationSecs(48 * 60 * 60);
      expect(await treasury.triggerDurationSecs()).to.equal(48n * 60n * 60n);
    });

    it("setTwapWindowSecs enforces [5min, 2h]", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).setTwapWindowSecs(60),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setTwapWindowSecs(3 * 60 * 60),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await treasury.connect(governance).setTwapWindowSecs(60 * 60);
      expect(await treasury.twapWindowSecs()).to.equal(60n * 60n);
    });

    it("setChainlinkSanityLowBps / HighBps enforce ranges", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).setChainlinkSanityLowBps(8999),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setChainlinkSanityLowBps(10000),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setChainlinkSanityHighBps(10000),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setChainlinkSanityHighBps(11001),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
    });

    it("setCapPerEventBps / setCapMonthlyBps / setSlippageMaxBps enforce ranges", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);
      await expect(
        treasury.connect(governance).setCapPerEventBps(99),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setCapPerEventBps(5001),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(
        treasury.connect(governance).setCapMonthlyBps(7001),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
      await expect(treasury.connect(governance).setSlippageMaxBps(9)).to.be.revertedWithCustomError(
        treasury,
        "ParamOutOfBounds",
      );
      await expect(
        treasury.connect(governance).setSlippageMaxBps(501),
      ).to.be.revertedWithCustomError(treasury, "ParamOutOfBounds");
    });

    it("happy-path setters update storage and emit BuybackParamsUpdated", async function () {
      const { treasury, governance } = await loadFixture(deployFixture);

      await expect(treasury.connect(governance).setCapPerEventBps(2500))
        .to.emit(treasury, "BuybackParamsUpdated")
        .withArgs(ethers.encodeBytes32String("capPerEventBps"), 2500n);
      expect(await treasury.capPerEventBps()).to.equal(2500n);

      await expect(treasury.connect(governance).setCapMonthlyBps(4000))
        .to.emit(treasury, "BuybackParamsUpdated")
        .withArgs(ethers.encodeBytes32String("capMonthlyBps"), 4000n);
      expect(await treasury.capMonthlyBps()).to.equal(4000n);

      await expect(treasury.connect(governance).setSlippageMaxBps(150))
        .to.emit(treasury, "BuybackParamsUpdated")
        .withArgs(ethers.encodeBytes32String("slippageMaxBps"), 150n);
      expect(await treasury.slippageMaxBps()).to.equal(150n);

      await expect(treasury.connect(governance).setChainlinkSanityLowBps(9500))
        .to.emit(treasury, "BuybackParamsUpdated")
        .withArgs(ethers.encodeBytes32String("chainlinkSanityLowBps"), 9500n);
      expect(await treasury.chainlinkSanityLowBps()).to.equal(9500n);

      await expect(treasury.connect(governance).setChainlinkSanityHighBps(10500))
        .to.emit(treasury, "BuybackParamsUpdated")
        .withArgs(ethers.encodeBytes32String("chainlinkSanityHighBps"), 10500n);
      expect(await treasury.chainlinkSanityHighBps()).to.equal(10500n);
    });
  });

  // ---------------------------------------------------------------- 3. recordDailyPrice
  describe("recordDailyPrice", function () {
    it("reverts BuybackInfraMissing if priceOracle not set", async function () {
      const { admin, credit, usdc, keeper } = await loadFixture(deployFixture);
      // Deploy fresh treasury sem oracle.
      const Treasury = await ethers.getContractFactory("Treasury");
      const t2 = await Treasury.deploy(
        admin.address,
        await credit.getAddress(),
        await usdc.getAddress(),
      );
      await t2.waitForDeployment();
      await expect(t2.connect(keeper).recordDailyPrice()).to.be.revertedWithCustomError(
        t2,
        "BuybackInfraMissing",
      );
    });

    it("first call records price; subsequent within 22h reverts cooldown", async function () {
      const { treasury, oracle, keeper } = await loadFixture(deployFixture);
      await oracle.setPrice(ONE_USD_18);
      await treasury.connect(keeper).recordDailyPrice();
      expect(await treasury.dailyPriceCount()).to.equal(1);

      await expect(treasury.connect(keeper).recordDailyPrice()).to.be.revertedWithCustomError(
        treasury,
        "RecordCooldownActive",
      );
    });

    it("emits DailyPriceRecorded with sample count", async function () {
      const { treasury, oracle, keeper } = await loadFixture(deployFixture);
      await oracle.setPrice(ONE_USD_18);
      await expect(treasury.connect(keeper).recordDailyPrice())
        .to.emit(treasury, "DailyPriceRecorded")
        .withArgs(keeper.address, ONE_USD_18, 0n, 1n); // ma90 = 0 ate 90 amostras
    });

    it("ma90Price is zero before bootstrap, > 0 after", async function () {
      const { treasury, oracle, feed, keeper } = await loadFixture(deployFixture);
      expect(await treasury.ma90Price()).to.equal(0n);
      await bootstrapMa90(treasury, oracle, feed, keeper, ONE_USD_18);
      expect(await treasury.ma90Price()).to.equal(ONE_USD_18);
    });

    it("currentFloorPrice = floorAbsolute pre-bootstrap; = max(0.5*MA, abs) post", async function () {
      const { treasury, oracle, feed, keeper } = await loadFixture(deployFixture);
      // Pre: somente floor absoluto $0.10.
      expect(await treasury.currentFloorPrice()).to.equal(FLOOR_ABS);

      // Post bootstrap a $1.00: floor = max(0.5 * $1.00, $0.10) = $0.50.
      await bootstrapMa90(treasury, oracle, feed, keeper, ONE_USD_18);
      expect(await treasury.currentFloorPrice()).to.equal(ONE_USD_18 / 2n);

      // Se MA fosse muito baixa, floor cai para o absoluto. Simulamos
      // sobrescrevendo todo o ring buffer com $0.10 (50 dias adicionais —
      // suficiente para "diluir" a media). Em vez disso, usamos um teste
      // direto: verificar que floor >= floorAbsoluteUsd sempre.
      const absolute = await treasury.floorAbsoluteUsd();
      const current = await treasury.currentFloorPrice();
      expect(current).to.be.gte(absolute);
    });

    it("breach checkpoint sets when spot < floor; resets when spot >= floor", async function () {
      const { treasury, oracle, feed, keeper } = await loadFixture(deployFixture);
      await bootstrapMa90(treasury, oracle, feed, keeper, ONE_USD_18);

      // Floor = $0.50. Setamos spot = $0.40 (abaixo).
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      expect(await treasury.lastFloorBreachTimestamp()).to.be.gt(0n);

      // Recovery: spot = $0.60 (acima). Reset.
      await oracle.setPrice(6n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      expect(await treasury.lastFloorBreachTimestamp()).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------- 4. executeBuyback
  describe("executeBuyback — happy path", function () {
    it("swaps USDC->CREDIT and burns; emits BuybackExecuted; updates ledger", async function () {
      const { treasury, oracle, feed, governance, keeper, usdc, credit } =
        await loadFixture(deployFixture);
      await bootstrapMa90(treasury, oracle, feed, keeper, ONE_USD_18);

      // Spot abaixo do floor. Floor = $0.50; spot = $0.40.
      const spotLow = 4n * 10n ** 17n;
      await oracle.setPrice(spotLow);

      // Marca breach e avanca 24h+.
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      // Reservas USDC = 1M. Cap por evento default 20% = 200k USDC.
      const usdcAmount = 100_000n * ONE_USDC; // 100k USDC (dentro do cap)
      const minCreditOut = 1n; // permissivo (router 1:1 wei -> wei)

      const monthIdx = await treasury.currentMonthIndex();
      const usdcBefore = await usdc.balanceOf(await treasury.getAddress());
      const creditSupplyBefore = await credit.totalSupply();
      // Floor depende da MA90 atualizada pos-record do spotLow (89 amostras
      // a $1.00 + 1 amostra a $0.40, depois reset). Lemos do contrato.
      const floorAtExec = await treasury.currentFloorPrice();

      const tx = await treasury.connect(governance).executeBuyback(usdcAmount, minCreditOut);

      // Router 1:1 wei -> wei: 100_000 USDC * 1e6 = 100_000_000_000 unidades USDC
      // saem; mesmo numero entra como CREDIT. CREDIT eh queimado integralmente.
      const expectedCredit = usdcAmount; // 1:1 (mockRate = 1e18 default, wei->wei)
      await expect(tx)
        .to.emit(treasury, "BuybackExecuted")
        .withArgs(usdcAmount, expectedCredit, floorAtExec, spotLow, monthIdx);

      // Saldo USDC do treasury caiu pelo amount.
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(usdcBefore - usdcAmount);
      // Treasury NAO segura CREDIT (foi queimado).
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(0n);
      // totalSupply diminuiu pelo `expectedCredit` (router transferiu de seu
      // saldo pre-funded; Treasury queimou via burnByRole, reduzindo o supply).
      expect(await credit.totalSupply()).to.equal(creditSupplyBefore - expectedCredit);

      // Ledger atualizado.
      expect(await treasury.monthlySpent(monthIdx)).to.equal(usdcAmount);
      expect(await treasury.monthlyReservesSnapshot(monthIdx)).to.equal(usdcBefore);
    });
  });

  describe("executeBuyback — pre-conditions", function () {
    async function readyFixture() {
      const f = await deployFixture();
      await bootstrapMa90(f.treasury, f.oracle, f.feed, f.keeper, ONE_USD_18);
      return f;
    }

    it("reverts ZeroAmount on usdcAmount = 0 or minCreditOut = 0", async function () {
      const { treasury, governance } = await loadFixture(readyFixture);
      await expect(
        treasury.connect(governance).executeBuyback(0n, 1n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
      await expect(
        treasury.connect(governance).executeBuyback(1n, 0n),
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("reverts SpotAboveFloor when spot >= floor", async function () {
      const { treasury, oracle, governance } = await loadFixture(readyFixture);
      // Floor = $0.50. Spot = $0.60.
      await oracle.setPrice(6n * 10n ** 17n);
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "SpotAboveFloor");
    });

    it("reverts BreachDurationInsufficient when breach < 24h", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(readyFixture);
      // Spot abaixo, mas SEM avanco de 24h apos marcar.
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      // Avanca apenas 1h (breach so 1h, exigido 24h).
      await time.increase(60 * 60);
      await feed.setUpdatedAt(await time.latest());
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "BreachDurationInsufficient");
    });

    it("reverts BreachDurationInsufficient when breach never marked", async function () {
      const { treasury, oracle, governance } = await loadFixture(readyFixture);
      // Spot abaixo agora, mas recordDailyPrice nunca chamado para marcar.
      // lastFloorBreachTimestamp ainda 0.
      await oracle.setPrice(4n * 10n ** 17n);
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "BreachDurationInsufficient");
    });

    it("reverts UsdcDepegDetected when Chainlink answer outside band", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(readyFixture);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      // USDC despegou (Chainlink reporta $0.95, fora de [0.99, 1.01]).
      await feed.setAnswer(95_000_000n); // 0.95 com 8 decimais
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "UsdcDepegDetected");

      // Acima da banda tambem reverte.
      await feed.setAnswer(105_000_000n); // 1.05
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "UsdcDepegDetected");
    });

    it("reverts ChainlinkStale when feed older than 6h", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(readyFixture);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      // NAO atualiza feed.updatedAt — ficou stale (>6h).
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "ChainlinkStale");
    });

    it("reverts InvalidChainlinkAnswer when answer <= 0", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(readyFixture);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await feed.setAnswer(0n);
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "InvalidChainlinkAnswer");
      await feed.setAnswer(-1n);
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "InvalidChainlinkAnswer");
    });

    it("reverts CapPerEventExceeded when usdcAmount > 20% reserves", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(readyFixture);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      // Reservas = 1M USDC. Cap = 20% = 200k. Pedimos 200_001.
      const tooMuch = 200_001n * ONE_USDC;
      await expect(
        treasury.connect(governance).executeBuyback(tooMuch, 1n),
      ).to.be.revertedWithCustomError(treasury, "CapPerEventExceeded");
    });

    it("reverts CapMonthlyExceeded across multiple events", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(readyFixture);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      // Reservas = 1M. Cap mensal = 30% = 300k. Cap por evento = 20% = 200k.
      // Primeiro evento: 200k USDC (dentro do cap por evento; abaixo do cap mensal).
      await treasury.connect(governance).executeBuyback(200_000n * ONE_USDC, 1n);

      // Segundo evento: 100_001 USDC -> total 300_001 > 300_000 mensal.
      // Mas: cap por evento agora e 20% das *reservas atuais* (800k -> 160k).
      // Pra isolar o cap mensal, ajustamos cap por evento para 50% (governance).
      await treasury.connect(governance).setCapPerEventBps(5000);
      await feed.setUpdatedAt(await time.latest());
      await expect(
        treasury.connect(governance).executeBuyback(100_001n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "CapMonthlyExceeded");
    });

    it("reverts when caller lacks GOVERNANCE_ROLE", async function () {
      const { treasury, other, GOVERNANCE_ROLE } = await loadFixture(readyFixture);
      await expect(treasury.connect(other).executeBuyback(1n * ONE_USDC, 1n))
        .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, GOVERNANCE_ROLE);
    });

    it("reverts when slippage forces output below minCreditOut (router revert)", async function () {
      const { treasury, oracle, feed, router, governance, keeper } =
        await loadFixture(readyFixture);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      // Forca o router a retornar apenas 1 wei de CREDIT, abaixo do minCreditOut.
      await router.setOutOverride(1n);
      const usdcAmount = 100n * ONE_USDC;
      const minCreditOut = 99n * 10n ** 18n; // muito acima do 1 wei retornado
      await expect(
        treasury.connect(governance).executeBuyback(usdcAmount, minCreditOut),
      ).to.be.revertedWith("Too little received");
    });

    it("reverts BuybackInfraMissing when oracle/router/feed not set", async function () {
      const { admin, credit, usdc } = await loadFixture(deployFixture);
      const Treasury = await ethers.getContractFactory("Treasury");
      const t2 = await Treasury.deploy(
        admin.address,
        await credit.getAddress(),
        await usdc.getAddress(),
      );
      await t2.waitForDeployment();
      // Sem setar oracle/router/feed.
      await expect(t2.connect(admin).executeBuyback(1n, 1n)).to.be.revertedWithCustomError(
        t2,
        "BuybackInfraMissing",
      );
    });

    it("reverts BuybackInfraMissing when USDC_TOKEN is zero", async function () {
      const { admin, credit, governance } = await loadFixture(deployFixture);
      const Treasury = await ethers.getContractFactory("Treasury");
      // USDC = ZeroAddress no construtor (aceito).
      const t2 = await Treasury.deploy(
        admin.address,
        await credit.getAddress(),
        ethers.ZeroAddress,
      );
      await t2.waitForDeployment();
      const role = await t2.GOVERNANCE_ROLE();
      await t2.connect(admin).grantRole(role, governance.address);
      await expect(t2.connect(governance).executeBuyback(1n, 1n)).to.be.revertedWithCustomError(
        t2,
        "BuybackInfraMissing",
      );
    });

    it("reverts InvalidOraclePrice when oracle returns 0 in executeBuyback", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(readyFixture);
      // Marca breach com spot abaixo, depois zera o oracle pra forcar revert.
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await oracle.setPrice(0n);
      await expect(
        treasury.connect(governance).executeBuyback(1n * ONE_USDC, 1n),
      ).to.be.revertedWithCustomError(treasury, "InvalidOraclePrice");
    });

    it("reverts InvalidOraclePrice in recordDailyPrice when oracle returns 0", async function () {
      const { treasury, oracle, keeper } = await loadFixture(deployFixture);
      await oracle.setPrice(0n);
      await expect(treasury.connect(keeper).recordDailyPrice()).to.be.revertedWithCustomError(
        treasury,
        "InvalidOraclePrice",
      );
    });

    it("reverts InsufficientBalance when usdcAmount > usdc reserves", async function () {
      const { treasury, oracle, feed, governance, keeper, usdc } = await loadFixture(readyFixture);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      const reserves = await usdc.balanceOf(await treasury.getAddress());
      // Cap por evento subido para 100% nao e aceito (max 5000bps); usamos
      // 5000 (50%) e pedimos `reserves + 1` para forcar InsufficientBalance
      // ANTES de CapPerEventExceeded (a checagem de saldo vem primeiro).
      await treasury.connect(governance).setCapPerEventBps(5000);
      await expect(
        treasury.connect(governance).executeBuyback(reserves + 1n, 1n),
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });
  });

  // ---------------------------------------------------------------- 5. monthly rollover
  describe("monthly rollover", function () {
    it("monthlySpent resets implicitly on month change", async function () {
      const { treasury, oracle, feed, governance, keeper } = await loadFixture(deployFixture);
      await bootstrapMa90(treasury, oracle, feed, keeper, ONE_USD_18);
      await oracle.setPrice(4n * 10n ** 17n);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      const monthIdx1 = await treasury.currentMonthIndex();
      await treasury.connect(governance).executeBuyback(50_000n * ONE_USDC, 1n);
      expect(await treasury.monthlySpent(monthIdx1)).to.equal(50_000n * ONE_USDC);

      // Avanca 30 dias para mudar `monthIndex`.
      await time.increase(30 * 24 * 60 * 60);
      await feed.setUpdatedAt(await time.latest());

      // Re-record para manter spot abaixo do floor — mas isso reseta breach.
      // Em vez disso, marcamos breach novamente e avancamos 24h.
      // Tecnicamente, o teste quer mostrar que monthIdx2 nao herda o gasto.
      // Para simplificar, observamos `monthlySpent[monthIdx2]` antes do
      // proximo buyback — deve ser 0.
      const monthIdx2 = await treasury.currentMonthIndex();
      expect(monthIdx2).to.not.equal(monthIdx1);
      expect(await treasury.monthlySpent(monthIdx2)).to.equal(0n);

      // Para executar de novo: spot ainda abaixo e breach ainda valido (>24h).
      await treasury.connect(governance).executeBuyback(50_000n * ONE_USDC, 1n);
      expect(await treasury.monthlySpent(monthIdx2)).to.equal(50_000n * ONE_USDC);
      expect(await treasury.monthlySpent(monthIdx1)).to.equal(50_000n * ONE_USDC); // intocado
    });
  });
});
