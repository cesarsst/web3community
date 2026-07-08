import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * CreditPriceOracle (adapter TWAP real do FFP — desbloqueio do buyback) test suite.
 *
 * Cobertura:
 *  - Constructor: validacao de enderecos, deteccao de ordem token0/token1,
 *    decimals nao suportados, par errado na pool.
 *  - Preco: CREDIT como token0 e como token1, conversao de decimais
 *    (USDC 6 -> USD 18), arredondamento do tick medio para -infinito,
 *    tick fora de range.
 *  - Chainlink: multiplicacao pelo USDC/USD, staleness (6h), banda fixa
 *    [0.99, 1.01], answer <= 0, fallback explicito feed = address(0).
 *  - Guards: janela zero, observe revertendo ("OLD").
 *  - Integracao Treasury: setPriceOracle + recordDailyPrice + executeBuyback
 *    usando o adapter REAL (pool mock codifica o tick; adapter faz a
 *    matematica de producao).
 *
 * Verificacao numerica: as asserts de preco usam um espelho EXATO em
 * TypeScript (bigint) do TickMath.getSqrtRatioAtTick + OracleLibrary
 * .getQuoteAtTick portados no contrato — divisao inteira de bigint tem a
 * mesma semantica (floor) do Math.mulDiv, entao a igualdade e exata, nao
 * aproximada.
 */
describe("CreditPriceOracle", function () {
  const WINDOW = 1800; // 30 min — default twapWindowSecs do Treasury
  const CREDIT_UNIT = 10n ** 18n; // 1 CREDIT inteiro (18 dec)
  const USDC_SCALE = 10n ** 12n; // 6 dec -> 18 dec
  const FEED_UNIT = 10n ** 8n; // Chainlink USDC/USD com 8 dec
  const ONE_USD_18 = 10n ** 18n;

  // 1.0001^-276324 * 1e12 ~= 0.9977 => preco ~$1.00 com CREDIT(18)/USDC(6).
  const TICK_USD_1 = -276324;
  // ~$0.399 (abaixo do floor de $0.50 pos-bootstrap a ~$1.00).
  const TICK_USD_04 = -285488;

  // ------------------------------------------------------------------
  // Espelho TS do TickMath.getSqrtRatioAtTick (mesmas constantes Q128).
  // ------------------------------------------------------------------
  const TICK_RATIOS: Array<[bigint, bigint]> = [
    [0x1n, 0xfffcb933bd6fad37aa2d162d1a594001n],
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];

  function getSqrtRatioAtTick(tick: number): bigint {
    const absTick = BigInt(Math.abs(tick));
    let ratio = (absTick & 1n) !== 0n ? TICK_RATIOS[0][1] : 1n << 128n;
    for (let i = 1; i < TICK_RATIOS.length; i++) {
      if ((absTick & TICK_RATIOS[i][0]) !== 0n) {
        ratio = (ratio * TICK_RATIOS[i][1]) >> 128n;
      }
    }
    if (tick > 0) {
      ratio = ((1n << 256n) - 1n) / ratio;
    }
    return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
  }

  function quoteAtTick(tick: number, baseAmount: bigint, baseIsToken0: boolean): bigint {
    const sqrt = getSqrtRatioAtTick(tick);
    if (sqrt <= (1n << 128n) - 1n) {
      const ratioX192 = sqrt * sqrt;
      return baseIsToken0
        ? (ratioX192 * baseAmount) / (1n << 192n)
        : ((1n << 192n) * baseAmount) / ratioX192;
    }
    const ratioX128 = (sqrt * sqrt) / (1n << 64n);
    return baseIsToken0
      ? (ratioX128 * baseAmount) / (1n << 128n)
      : ((1n << 128n) * baseAmount) / ratioX128;
  }

  /** Preco esperado em USD 18 dec, replicando o pipeline do adapter. */
  function expectedPriceUsd18(
    tick: number,
    creditIsToken0: boolean,
    usdcScale: bigint = USDC_SCALE,
    feedAnswer: bigint | null = FEED_UNIT, // null = fallback sem Chainlink
  ): bigint {
    const usdc18 = quoteAtTick(tick, CREDIT_UNIT, creditIsToken0) * usdcScale;
    if (feedAnswer === null) {
      return usdc18;
    }
    return (usdc18 * feedAnswer) / FEED_UNIT;
  }

  // ------------------------------------------------------------------
  // Fixtures
  // ------------------------------------------------------------------
  async function deployFixture() {
    const ERC20Dec = await ethers.getContractFactory("ERC20DecimalsMock");
    const credit = await ERC20Dec.deploy("Mock CREDIT", "CREDIT", 18);
    await credit.waitForDeployment();
    const usdc = await ERC20Dec.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const PoolMock = await ethers.getContractFactory("UniswapV3PoolMock");
    const pool = await PoolMock.deploy();
    await pool.waitForDeployment();
    await pool.setTokens(await credit.getAddress(), await usdc.getAddress()); // CREDIT = token0

    const FeedMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
    const feed = await FeedMock.deploy();
    await feed.waitForDeployment();
    await feed.setUpdatedAt(await time.latest());

    const Oracle = await ethers.getContractFactory("CreditPriceOracle");
    const oracle = await Oracle.deploy(
      await pool.getAddress(),
      await credit.getAddress(),
      await usdc.getAddress(),
      await feed.getAddress(),
    );
    await oracle.waitForDeployment();

    return { credit, usdc, pool, feed, oracle, Oracle, ERC20Dec };
  }

  // ------------------------------------------------------------------ 1.
  describe("constructor", function () {
    it("reverts ZeroAddress for zero pool/credit/usdc", async function () {
      const { credit, usdc, pool, feed, Oracle } = await loadFixture(deployFixture);
      const [poolAddr, creditAddr, usdcAddr, feedAddr] = await Promise.all([
        pool.getAddress(),
        credit.getAddress(),
        usdc.getAddress(),
        feed.getAddress(),
      ]);
      await expect(
        Oracle.deploy(ethers.ZeroAddress, creditAddr, usdcAddr, feedAddr),
      ).to.be.revertedWithCustomError(Oracle, "ZeroAddress");
      await expect(
        Oracle.deploy(poolAddr, ethers.ZeroAddress, usdcAddr, feedAddr),
      ).to.be.revertedWithCustomError(Oracle, "ZeroAddress");
      await expect(
        Oracle.deploy(poolAddr, creditAddr, ethers.ZeroAddress, feedAddr),
      ).to.be.revertedWithCustomError(Oracle, "ZeroAddress");
    });

    it("accepts feed = address(0) (modo fallback sem Chainlink)", async function () {
      const { credit, usdc, pool, Oracle } = await loadFixture(deployFixture);
      const oracle = await Oracle.deploy(
        await pool.getAddress(),
        await credit.getAddress(),
        await usdc.getAddress(),
        ethers.ZeroAddress,
      );
      expect(await oracle.CHAINLINK_USDC_FEED()).to.equal(ethers.ZeroAddress);
    });

    it("reverts PoolTokenMismatch when pool pair does not match credit/usdc", async function () {
      const { credit, usdc, pool, feed, Oracle, ERC20Dec } = await loadFixture(deployFixture);
      const other = await ERC20Dec.deploy("Other", "OTH", 18);
      await other.waitForDeployment();

      // token1 da pool nao e o USDC informado.
      await pool.setTokens(await credit.getAddress(), await other.getAddress());
      await expect(
        Oracle.deploy(
          await pool.getAddress(),
          await credit.getAddress(),
          await usdc.getAddress(),
          await feed.getAddress(),
        ),
      ).to.be.revertedWithCustomError(Oracle, "PoolTokenMismatch");

      // Pool degenerada (credit, credit) tambem falha.
      await pool.setTokens(await credit.getAddress(), await credit.getAddress());
      await expect(
        Oracle.deploy(
          await pool.getAddress(),
          await credit.getAddress(),
          await usdc.getAddress(),
          await feed.getAddress(),
        ),
      ).to.be.revertedWithCustomError(Oracle, "PoolTokenMismatch");
    });

    it("reverts UnsupportedDecimals for tokens with more than 18 decimals", async function () {
      const { credit, pool, feed, Oracle, ERC20Dec } = await loadFixture(deployFixture);
      const weird = await ERC20Dec.deploy("Weird", "W19", 19);
      await weird.waitForDeployment();

      // USDC com 19 dec.
      await pool.setTokens(await credit.getAddress(), await weird.getAddress());
      await expect(
        Oracle.deploy(
          await pool.getAddress(),
          await credit.getAddress(),
          await weird.getAddress(),
          await feed.getAddress(),
        ),
      )
        .to.be.revertedWithCustomError(Oracle, "UnsupportedDecimals")
        .withArgs(19);

      // CREDIT com 19 dec.
      const usdc6 = await ERC20Dec.deploy("USDC", "USDC", 6);
      await usdc6.waitForDeployment();
      await pool.setTokens(await weird.getAddress(), await usdc6.getAddress());
      await expect(
        Oracle.deploy(
          await pool.getAddress(),
          await weird.getAddress(),
          await usdc6.getAddress(),
          await feed.getAddress(),
        ),
      )
        .to.be.revertedWithCustomError(Oracle, "UnsupportedDecimals")
        .withArgs(19);
    });

    it("detects CREDIT as token0 and stores immutables", async function () {
      const { credit, usdc, pool, feed, oracle } = await loadFixture(deployFixture);
      expect(await oracle.CREDIT_IS_TOKEN0()).to.equal(true);
      expect(await oracle.POOL()).to.equal(await pool.getAddress());
      expect(await oracle.CREDIT_TOKEN()).to.equal(await credit.getAddress());
      expect(await oracle.USDC_TOKEN()).to.equal(await usdc.getAddress());
      expect(await oracle.CHAINLINK_USDC_FEED()).to.equal(await feed.getAddress());
      expect(await oracle.CREDIT_UNIT()).to.equal(CREDIT_UNIT);
      expect(await oracle.USDC_TO_USD18_SCALE()).to.equal(USDC_SCALE);
    });

    it("detects CREDIT as token1", async function () {
      const { credit, usdc, pool, feed, Oracle } = await loadFixture(deployFixture);
      await pool.setTokens(await usdc.getAddress(), await credit.getAddress());
      const oracle = await Oracle.deploy(
        await pool.getAddress(),
        await credit.getAddress(),
        await usdc.getAddress(),
        await feed.getAddress(),
      );
      expect(await oracle.CREDIT_IS_TOKEN0()).to.equal(false);
    });
  });

  // ------------------------------------------------------------------ 2.
  describe("peekTwapPrice — matematica tick -> USD", function () {
    it("prices CREDIT as token0 (~$1.00, match exato com espelho TS)", async function () {
      const { pool, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      const price = await oracle.peekTwapPrice(WINDOW);
      expect(price).to.equal(expectedPriceUsd18(TICK_USD_1, true));
      // Interpretabilidade: tick escolhido corresponde a ~$1.00 (0.5% tol).
      expect(price).to.be.closeTo(ONE_USD_18, ONE_USD_18 / 200n);
    });

    it("prices CREDIT as token1 (tick espelhado, match exato)", async function () {
      const { credit, usdc, pool, feed, Oracle } = await loadFixture(deployFixture);
      await pool.setTokens(await usdc.getAddress(), await credit.getAddress());
      const oracle = await Oracle.deploy(
        await pool.getAddress(),
        await credit.getAddress(),
        await usdc.getAddress(),
        await feed.getAddress(),
      );
      // CREDIT como token1: preco token1/token0 = USDC_raw/CREDIT_raw =>
      // tick POSITIVO (+276324) para ~$1.00.
      await pool.setMeanTick(-TICK_USD_1);
      const price = await oracle.peekTwapPrice(WINDOW);
      expect(price).to.equal(expectedPriceUsd18(-TICK_USD_1, false));
      expect(price).to.be.closeTo(ONE_USD_18, ONE_USD_18 / 200n);
    });

    it("converts USDC raw (6 dec) -> USD 18 dec (escala 1e12 em tick 0)", async function () {
      const { pool, oracle } = await loadFixture(deployFixture);
      // tick 0: 1 raw CREDIT = 1 raw USDC => 1e18 raw USDC por CREDIT
      // inteiro => * 1e12 => 1e30 USD18. Preco absurdo de proposito: isola
      // exatamente o fator de escala de decimais.
      await pool.setMeanTick(0);
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(10n ** 30n);
    });

    it("no scaling when both tokens have 18 decimals (tick 0 => exactly $1)", async function () {
      const { credit, pool, feed, Oracle, ERC20Dec } = await loadFixture(deployFixture);
      const usdc18 = await ERC20Dec.deploy("USDC18", "USDC18", 18);
      await usdc18.waitForDeployment();
      await pool.setTokens(await credit.getAddress(), await usdc18.getAddress());
      const oracle = await Oracle.deploy(
        await pool.getAddress(),
        await credit.getAddress(),
        await usdc18.getAddress(),
        await feed.getAddress(),
      );
      await pool.setMeanTick(0);
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(ONE_USD_18);
    });

    it("rounds arithmetic mean tick toward -infinity (convencao OracleLibrary)", async function () {
      const { pool, oracle } = await loadFixture(deployFixture);
      // delta = -1 sobre janela de 1800s: truncar daria tick 0; a convencao
      // Uniswap arredonda para -inf => tick -1.
      await pool.setRawTickCumulatives(0, -1);
      const price = await oracle.peekTwapPrice(WINDOW);
      expect(price).to.equal(expectedPriceUsd18(-1, true, USDC_SCALE));
      expect(price).to.not.equal(expectedPriceUsd18(0, true, USDC_SCALE));
    });

    it("reverts InvalidTick when derived mean tick is out of range", async function () {
      const { pool, oracle } = await loadFixture(deployFixture);
      // meanTick = 887273 (> MAX_TICK 887272).
      await pool.setRawTickCumulatives(0, 887273n * BigInt(WINDOW));
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "InvalidTick")
        .withArgs(887273);
    });
  });

  // ------------------------------------------------------------------ 3.
  describe("peekTwapPrice — conversao Chainlink USDC/USD", function () {
    it("multiplies by the feed answer (USDC a $0.99 dentro da banda)", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      await feed.setAnswer(99_000_000n); // $0.99 (borda inferior aceita)
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(
        expectedPriceUsd18(TICK_USD_1, true, USDC_SCALE, 99_000_000n),
      );
    });

    it("accepts the upper band edge ($1.01)", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      await feed.setAnswer(101_000_000n);
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(
        expectedPriceUsd18(TICK_USD_1, true, USDC_SCALE, 101_000_000n),
      );
    });

    it("reverts UsdcDepegDetected outside the fixed band [0.99, 1.01]", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      await feed.setAnswer(98_000_000n); // $0.98
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "UsdcDepegDetected")
        .withArgs(98_000_000n, 9900n, 10100n);
      await feed.setAnswer(102_000_000n); // $1.02
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "UsdcDepegDetected")
        .withArgs(102_000_000n, 9900n, 10100n);
    });

    it("reverts ChainlinkStale when feed older than 6h", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      const updatedAt = await time.latest();
      await feed.setUpdatedAt(updatedAt);
      await time.increase(6 * 60 * 60 + 61);
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "ChainlinkStale")
        .withArgs(updatedAt, 6n * 60n * 60n);
    });

    it("still fresh at exactly the staleness boundary", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      await feed.setUpdatedAt(await time.latest());
      await time.increase(6 * 60 * 60 - 60); // < 6h
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(expectedPriceUsd18(TICK_USD_1, true));
    });

    it("reverts InvalidChainlinkAnswer for answer <= 0", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      await feed.setAnswer(0n);
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "InvalidChainlinkAnswer")
        .withArgs(0);
      await feed.setAnswer(-1n);
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "InvalidChainlinkAnswer")
        .withArgs(-1);
    });

    it("feed decimals = 18: answer 1e18 ($1.00) produz o MESMO preco do feed de 8 dec", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      // Baseline com o default (8 dec, 1e8).
      const price8 = await oracle.peekTwapPrice(WINDOW);

      // O adapter le `feed.decimals()` em RUNTIME (tolera proxies que
      // trocam de fase) — um feed de 18 dec com answer 1e18 e o mesmo
      // $1.00 e deve produzir preco e banda identicos.
      await feed.setDecimals(18);
      await feed.setAnswer(10n ** 18n);
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(price8);
      expect(price8).to.equal(expectedPriceUsd18(TICK_USD_1, true));
    });

    it("feed decimals = 6: answer 1e6 ($1.00) produz o MESMO preco", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      const price8 = await oracle.peekTwapPrice(WINDOW);

      await feed.setDecimals(6);
      await feed.setAnswer(10n ** 6n);
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(price8);
    });

    it("feed decimals != 8: multiplicacao exata dentro da banda ($0.99 em 18 dec)", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      await feed.setDecimals(18);
      await feed.setAnswer(99n * 10n ** 16n); // $0.99 em 18 dec
      // Math.mulDiv(priceUsdc18, answer, 1e18) — floor identico ao caso
      // 8 dec (numerador/denominador escalam pelo mesmo fator exato).
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(
        expectedPriceUsd18(TICK_USD_1, true, USDC_SCALE, 99_000_000n),
      );
    });

    it("feed decimals != 8: banda de sanidade normaliza em bps corretamente (depeg em 18 e 6 dec)", async function () {
      const { pool, feed, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);

      // $0.98 em 18 dec — fora da banda [9900, 10100] apos normalizacao.
      await feed.setDecimals(18);
      const low18 = 98n * 10n ** 16n;
      await feed.setAnswer(low18);
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "UsdcDepegDetected")
        .withArgs(low18, 9900n, 10100n);

      // $1.02 em 6 dec — idem no lado superior.
      await feed.setDecimals(6);
      const high6 = 1_020_000n;
      await feed.setAnswer(high6);
      await expect(oracle.peekTwapPrice(WINDOW))
        .to.be.revertedWithCustomError(oracle, "UsdcDepegDetected")
        .withArgs(high6, 9900n, 10100n);
    });

    it("feed = address(0): fallback explicito 1 USDC = 1 USD (sem checks)", async function () {
      const { credit, usdc, pool, Oracle } = await loadFixture(deployFixture);
      const oracle = await Oracle.deploy(
        await pool.getAddress(),
        await credit.getAddress(),
        await usdc.getAddress(),
        ethers.ZeroAddress,
      );
      await pool.setMeanTick(TICK_USD_1);
      // Sem feed nao ha staleness possivel — avancamos 1 dia para provar.
      await time.increase(24 * 60 * 60);
      expect(await oracle.peekTwapPrice(WINDOW)).to.equal(
        expectedPriceUsd18(TICK_USD_1, true, USDC_SCALE, null),
      );
    });
  });

  // ------------------------------------------------------------------ 4.
  describe("peekTwapPrice — guards", function () {
    it("reverts ZeroTwapWindow for secondsAgo = 0", async function () {
      const { oracle } = await loadFixture(deployFixture);
      await expect(oracle.peekTwapPrice(0)).to.be.revertedWithCustomError(oracle, "ZeroTwapWindow");
    });

    it("reverts ObserveFailed when pool.observe reverts (OLD)", async function () {
      const { pool, oracle } = await loadFixture(deployFixture);
      await pool.setMeanTick(TICK_USD_1);
      await pool.setRevertOnObserve(true);
      await expect(oracle.peekTwapPrice(WINDOW)).to.be.revertedWithCustomError(
        oracle,
        "ObserveFailed",
      );
    });
  });

  // ------------------------------------------------------------------ 5.
  describe("integracao Treasury (adapter real no caminho do buyback)", function () {
    const ONE_USDC = 10n ** 6n;
    const TREASURY_USDC_INITIAL = 1_000_000n * ONE_USDC;

    async function treasuryFixture() {
      const [admin, governance, keeper] = await ethers.getSigners();

      // CREDIT real (Treasury precisa de burnByRole no buyback).
      const CreditToken = await ethers.getContractFactory("CreditToken");
      const credit = await CreditToken.deploy("Web3Community Credit", "CREDIT", admin.address);
      await credit.waitForDeployment();

      // USDC com 6 decimais REAIS (diferente do suite legado, que usa
      // ERC20Mock de 18 dec — aqui a conversao de decimais e o ponto).
      const ERC20Dec = await ethers.getContractFactory("ERC20DecimalsMock");
      const usdc = await ERC20Dec.deploy("Mock USDC", "USDC", 6);
      await usdc.waitForDeployment();

      // Pool mock com par (CREDIT, USDC) e tick de ~$1.00.
      const PoolMock = await ethers.getContractFactory("UniswapV3PoolMock");
      const pool = await PoolMock.deploy();
      await pool.waitForDeployment();
      await pool.setTokens(await credit.getAddress(), await usdc.getAddress());
      await pool.setMeanTick(TICK_USD_1);

      const FeedMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
      const feed = await FeedMock.deploy();
      await feed.waitForDeployment();
      await feed.setUpdatedAt(await time.latest());

      // Adapter REAL sob teste.
      const Oracle = await ethers.getContractFactory("CreditPriceOracle");
      const oracle = await Oracle.deploy(
        await pool.getAddress(),
        await credit.getAddress(),
        await usdc.getAddress(),
        await feed.getAddress(),
      );
      await oracle.waitForDeployment();

      const RouterMock = await ethers.getContractFactory("UniswapV3SwapRouterMock");
      const router = await RouterMock.deploy();
      await router.waitForDeployment();

      const Treasury = await ethers.getContractFactory("Treasury");
      const treasury = await Treasury.deploy(
        admin.address,
        await credit.getAddress(),
        await usdc.getAddress(),
      );
      await treasury.waitForDeployment();

      const GOVERNANCE_ROLE = await treasury.GOVERNANCE_ROLE();
      await treasury.connect(admin).grantRole(GOVERNANCE_ROLE, governance.address);
      await treasury.connect(governance).setPriceOracle(await oracle.getAddress());
      await treasury.connect(governance).setSwapRouter(await router.getAddress());
      await treasury.connect(governance).setChainlinkFeed(await feed.getAddress());

      const BURNER_ROLE = await credit.BURNER_ROLE();
      await credit.connect(admin).grantRole(BURNER_ROLE, await treasury.getAddress());
      const MINTER_ROLE = await credit.MINTER_ROLE();
      await credit.connect(admin).grantRole(MINTER_ROLE, admin.address);
      await credit
        .connect(admin)
        .mint(await router.getAddress(), 100_000_000n * 10n ** 18n, "router-mock-prefund");

      await usdc.mint(await treasury.getAddress(), TREASURY_USDC_INITIAL);

      return { admin, governance, keeper, credit, usdc, pool, feed, oracle, router, treasury };
    }

    it("setPriceOracle points to the real adapter", async function () {
      const { treasury, oracle } = await loadFixture(treasuryFixture);
      expect(await treasury.priceOracle()).to.equal(await oracle.getAddress());
    });

    it("recordDailyPrice reads the exact adapter TWAP price", async function () {
      const { treasury, keeper } = await loadFixture(treasuryFixture);
      const expected = expectedPriceUsd18(TICK_USD_1, true);
      await expect(treasury.connect(keeper).recordDailyPrice())
        .to.emit(treasury, "DailyPriceRecorded")
        .withArgs(keeper.address, expected, 0n, 1n); // ma90 = 0 ate 90 amostras
    });

    it("recordDailyPrice bubbles adapter guards (ObserveFailed)", async function () {
      const { treasury, pool, oracle, keeper } = await loadFixture(treasuryFixture);
      await pool.setRevertOnObserve(true);
      await expect(treasury.connect(keeper).recordDailyPrice()).to.be.revertedWithCustomError(
        oracle,
        "ObserveFailed",
      );
    });

    it("full FFP path: bootstrap MA90 -> breach -> executeBuyback via real adapter", async function () {
      const { treasury, pool, feed, governance, keeper, usdc, credit } =
        await loadFixture(treasuryFixture);
      const priceUsd1 = expectedPriceUsd18(TICK_USD_1, true); // ~$0.9977
      const priceLow = expectedPriceUsd18(TICK_USD_04, true); // ~$0.399

      // Bootstrap MA90 em ~$1.00 (90 amostras via adapter real).
      for (let i = 0; i < 90; i++) {
        await time.increase(22 * 60 * 60 + 60);
        await feed.setUpdatedAt(await time.latest()); // adapter checa staleness
        await treasury.connect(keeper).recordDailyPrice();
      }
      expect(await treasury.ma90Price()).to.equal(priceUsd1);
      const floor = await treasury.currentFloorPrice();
      expect(floor).to.equal(priceUsd1 / 2n); // 0.5 * MA90 > $0.10 absoluto
      expect(priceLow).to.be.lt(floor);

      // Queda para ~$0.399: marca breach e espera 24h+.
      await pool.setMeanTick(TICK_USD_04);
      await time.increase(22 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());
      await treasury.connect(keeper).recordDailyPrice();
      expect(await treasury.lastFloorBreachTimestamp()).to.be.gt(0n);
      await time.increase(24 * 60 * 60 + 60);
      await feed.setUpdatedAt(await time.latest());

      const usdcAmount = 100_000n * ONE_USDC; // dentro do cap de 20%
      const expectedCredit = usdcAmount; // router mock 1:1 wei -> wei
      const monthIdx = await treasury.currentMonthIndex();
      const floorAtExec = await treasury.currentFloorPrice();
      const supplyBefore = await credit.totalSupply();

      await expect(treasury.connect(governance).executeBuyback(usdcAmount, 1n))
        .to.emit(treasury, "BuybackExecuted")
        .withArgs(usdcAmount, expectedCredit, floorAtExec, priceLow, monthIdx);

      // USDC gasto, CREDIT comprado e queimado integralmente.
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(
        TREASURY_USDC_INITIAL - usdcAmount,
      );
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(0n);
      expect(await credit.totalSupply()).to.equal(supplyBefore - expectedCredit);
      expect(await treasury.monthlySpent(monthIdx)).to.equal(usdcAmount);
    });
  });
});
