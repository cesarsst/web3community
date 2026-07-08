// SPDX-License-Identifier: GPL-2.0-or-later
// Este arquivo contem um port do algoritmo `getSqrtRatioAtTick` do TickMath
// da Uniswap V3 (v3-core, licenca GPL-2.0-or-later), adaptado a Solidity
// 0.8.24. Por derivacao, o arquivo inteiro e licenciado GPL-2.0-or-later
// (diferente do restante do repo, MIT).
pragma solidity 0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICreditPriceOracle} from "./interfaces/ICreditPriceOracle.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";
import {IChainlinkAggregator} from "./interfaces/IChainlinkAggregator.sol";

/**
 * @title CreditPriceOracle
 * @notice Adapter de producao do {ICreditPriceOracle}: deriva o TWAP do
 *         CREDIT em USD (18 decimais) a partir da pool Uniswap V3
 *         CREDIT/USDC, convertendo USDC -> USD via feed Chainlink USDC/USD.
 *
 *         Pipeline por chamada de {peekTwapPrice}:
 *         1. `pool.observe([secondsAgo, 0])` -> tickCumulatives.
 *         2. tick medio aritmetico = delta / janela (arredondado para -inf,
 *            mesma convencao do `OracleLibrary` da Uniswap).
 *         3. tick -> sqrtPriceX96 via port do `TickMath.getSqrtRatioAtTick`
 *            (exponenciacao binaria de 1.0001^tick em Q128, ver rodape).
 *         4. Cotacao de 1 CREDIT inteiro em unidades brutas de USDC
 *            (tratando ambas as ordens token0/token1 — a ordem e detectada
 *            no constructor via `pool.token0()`).
 *         5. Escala USDC (6 dec em producao) -> 18 dec.
 *         6. Multiplica pelo preco Chainlink USDC/USD (staleness max 6h +
 *            banda de sanidade 0.99-1.01, mesmos valores do {Treasury}),
 *            para que o retorno seja USD real e nao USDC nominal.
 *            Fallback explicito: se o feed for `address(0)` no deploy, o
 *            adapter assume 1 USDC = 1 USD (modo sem Chainlink, para
 *            ambientes onde o feed nao existe — documentado e deliberado).
 *
 * @dev Desenho deliberado ("adapter burro e deterministico"):
 *      - SEM owner, SEM setters, SEM storage mutavel — toda a configuracao e
 *        imutavel no constructor. Se qualquer parametro precisar mudar
 *        (pool, feed, banda), deploya-se outro adapter e a governanca
 *        aponta o novo endereco via {Treasury.setPriceOracle}.
 *      - A janela TWAP e parametro da chamada: o {Treasury} passa o seu
 *        `twapWindowSecs` — o adapter nao opina sobre o tamanho da janela
 *        (apenas rejeita zero).
 *      - {peekTwapPrice} e implementada como `view` (restricao valida da
 *        mutability nao-view da interface): nenhum estado interno e
 *        atualizado — o "pode atualizar contagens" previsto na interface e
 *        um no-op neste adapter, como documentado la.
 *      - A banda de sanidade do feed e FIXA em [9900, 10100] bps, espelhando
 *        os defaults do {Treasury}. O {Treasury} ja aplica a propria banda
 *        (configuravel) em {executeBuyback}; a checagem aqui e defesa em
 *        profundidade para {recordDailyPrice}, que nao passa pelo
 *        `_enforceChainlinkSanity` do Treasury.
 *
 *      Nota de licenca: {_getSqrtRatioAtTick} e um port fiel do
 *      `TickMath.getSqrtRatioAtTick` da Uniswap V3 (v3-core @ 0.7.6,
 *      GPL-2.0-or-later) para 0.8.24 — a unica adaptacao e o bloco
 *      `unchecked` (o algoritmo depende de wrap-around controlado que o
 *      0.8.x checaria) e o custom error no lugar de `require(..., 'T')`.
 *      {_quoteAtTick} segue o `OracleLibrary.getQuoteAtTick` da
 *      v3-periphery, usando `Math.mulDiv` do OpenZeppelin (512 bits) no
 *      lugar do `FullMath` da Uniswap.
 */
contract CreditPriceOracle is ICreditPriceOracle {
    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Denominador de basis points (10000 = 100.00%).
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Idade maxima aceita para a resposta do feed Chainlink
    ///         USDC/USD (mesmo valor do {Treasury.CHAINLINK_MAX_STALENESS}).
    uint256 public constant CHAINLINK_MAX_STALENESS = 6 hours;

    /// @notice Banda inferior de sanidade do feed USDC/USD: 0.99.
    ///         Fixa por desenho (adapter sem setters); espelha o default do
    ///         {Treasury}. Banda diferente => novo deploy.
    uint16 public constant CHAINLINK_SANITY_LOW_BPS = 9900;

    /// @notice Banda superior de sanidade do feed USDC/USD: 1.01.
    uint16 public constant CHAINLINK_SANITY_HIGH_BPS = 10_100;

    /// @notice Tick minimo suportado pela Uniswap V3 (TickMath.MIN_TICK).
    int24 public constant MIN_TICK = -887272;

    /// @notice Tick maximo suportado pela Uniswap V3 (TickMath.MAX_TICK).
    int24 public constant MAX_TICK = 887272;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    /// @notice Pool Uniswap V3 CREDIT/USDC fonte do TWAP.
    IUniswapV3Pool public immutable POOL;

    /// @notice Token CREDIT (base da cotacao).
    address public immutable CREDIT_TOKEN;

    /// @notice Token USDC (quote da cotacao).
    address public immutable USDC_TOKEN;

    /// @notice Feed Chainlink USDC/USD. `address(0)` = modo sem Chainlink:
    ///         o adapter assume 1 USDC = 1 USD (fallback explicito).
    IChainlinkAggregator public immutable CHAINLINK_USDC_FEED;

    /// @notice `true` se CREDIT e o token0 da pool (detectado no constructor
    ///         via `pool.token0()`); `false` se e o token1.
    bool public immutable CREDIT_IS_TOKEN0;

    /// @notice 1 CREDIT inteiro em unidades brutas (10^decimals do CREDIT).
    ///         Base da cotacao em {_quoteAtTick}.
    uint128 public immutable CREDIT_UNIT;

    /// @notice Fator de escala das unidades brutas de USDC para 18 decimais
    ///         (10^(18 - decimals do USDC); USDC de producao: 10^12).
    uint256 public immutable USDC_TO_USD18_SCALE;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero passado para pool/credit/usdc no constructor.
    error ZeroAddress();

    /// @notice O par (token0, token1) da pool nao corresponde a {CREDIT_TOKEN}
    ///         e {USDC_TOKEN} (em qualquer ordem).
    error PoolTokenMismatch(address token0, address token1);

    /// @notice Token com mais de 18 decimais nao e suportado.
    error UnsupportedDecimals(uint8 decimals);

    /// @notice Janela TWAP zero (o Treasury nunca envia zero — bounds
    ///         [5min, 2h] — mas o adapter e defensivo por contrato).
    error ZeroTwapWindow();

    /// @notice `pool.observe` reverteu (ex.: "OLD" quando a cardinality do
    ///         ring buffer de observacoes e insuficiente para a janela).
    /// @param reason Bytes crus do revert da pool (diagnostico).
    error ObserveFailed(bytes reason);

    /// @notice Tick medio derivado dos acumuladores fora de
    ///         [{MIN_TICK}, {MAX_TICK}] — pool corrompida ou mock invalido.
    error InvalidTick(int256 tick);

    /// @notice Feed Chainlink retorna dado stale (updatedAt muito antigo).
    error ChainlinkStale(uint256 updatedAt, uint256 maxStaleness);

    /// @notice Feed Chainlink retorna preco <= 0 (corrupcao/feed quebrado).
    error InvalidChainlinkAnswer(int256 answer);

    /// @notice Feed Chainlink USDC/USD esta fora da banda de sanidade fixa.
    error UsdcDepegDetected(int256 reportedAnswer, uint256 lowBound, uint256 highBound);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Deploya o adapter apontando para a pool CREDIT/USDC e o feed
     *         Chainlink USDC/USD.
     * @dev Valida que a pool realmente contem o par {credit, usdc} (em
     *      qualquer ordem) e detecta a ordem via `pool.token0()`. Le os
     *      decimals de ambos os tokens UMA vez e congela os fatores de
     *      escala — decimals de ERC-20 sao imutaveis na pratica; se um
     *      token migrar, deploya-se outro adapter.
     * @param pool_ Pool Uniswap V3 CREDIT/USDC.
     * @param credit_ Endereco do token CREDIT.
     * @param usdc_ Endereco do token USDC.
     * @param chainlinkUsdcFeed_ Feed Chainlink USDC/USD. `address(0)` ativa o
     *        fallback 1 USDC = 1 USD (sem checagem de staleness/banda —
     *        usar apenas em redes sem o feed, decisao explicita de deploy).
     */
    constructor(address pool_, address credit_, address usdc_, address chainlinkUsdcFeed_) {
        if (pool_ == address(0) || credit_ == address(0) || usdc_ == address(0)) {
            revert ZeroAddress();
        }

        address t0 = IUniswapV3Pool(pool_).token0();
        address t1 = IUniswapV3Pool(pool_).token1();
        bool creditIsToken0 = (t0 == credit_ && t1 == usdc_);
        if (!creditIsToken0 && !(t0 == usdc_ && t1 == credit_)) {
            revert PoolTokenMismatch(t0, t1);
        }

        uint8 creditDecimals = IERC20Metadata(credit_).decimals();
        if (creditDecimals > 18) {
            revert UnsupportedDecimals(creditDecimals);
        }
        uint8 usdcDecimals = IERC20Metadata(usdc_).decimals();
        if (usdcDecimals > 18) {
            revert UnsupportedDecimals(usdcDecimals);
        }

        POOL = IUniswapV3Pool(pool_);
        CREDIT_TOKEN = credit_;
        USDC_TOKEN = usdc_;
        CHAINLINK_USDC_FEED = IChainlinkAggregator(chainlinkUsdcFeed_);
        CREDIT_IS_TOKEN0 = creditIsToken0;
        CREDIT_UNIT = uint128(10 ** creditDecimals);
        USDC_TO_USD18_SCALE = 10 ** (18 - usdcDecimals);
    }

    // ------------------------------------------------------------------
    // ICreditPriceOracle
    // ------------------------------------------------------------------

    /**
     * @notice Retorna o TWAP do CREDIT em USD com 18 decimais para a janela
     *         `secondsAgo` mais recente.
     * @dev Implementada como `view` (restricao permitida da interface
     *      nao-view): este adapter nao mantem estado. O {Treasury} chama via
     *      CALL normal — funciona identicamente.
     *
     *      Reverts:
     *      - {ZeroTwapWindow} se `secondsAgo == 0`.
     *      - {ObserveFailed} se a pool reverter no `observe` (ex.: "OLD").
     *      - {InvalidTick} se o tick medio sair de [{MIN_TICK}, {MAX_TICK}].
     *      - {InvalidChainlinkAnswer} / {ChainlinkStale} / {UsdcDepegDetected}
     *        conforme o estado do feed (apenas quando feed configurado).
     * @param secondsAgo Tamanho da janela TWAP em segundos (Treasury passa
     *        `twapWindowSecs`, default 1800).
     * @return priceUsd18 Preco do CREDIT em USD com 18 decimais.
     */
    function peekTwapPrice(uint32 secondsAgo) external view returns (uint256 priceUsd18) {
        if (secondsAgo == 0) {
            revert ZeroTwapWindow();
        }

        int24 arithMeanTick = _twapTick(secondsAgo);

        // Cotacao de 1 CREDIT inteiro em unidades brutas de USDC, tratando a
        // ordem do par detectada no constructor.
        uint256 usdcRawPerCredit = _quoteAtTick(arithMeanTick, CREDIT_UNIT, CREDIT_IS_TOKEN0);

        // USDC bruto (6 dec em producao) -> USDC nominal com 18 decimais.
        uint256 priceUsdc18 = usdcRawPerCredit * USDC_TO_USD18_SCALE;

        // USDC nominal -> USD real via Chainlink (ou fallback 1:1).
        priceUsd18 = _usdcToUsd(priceUsdc18);
    }

    // ------------------------------------------------------------------
    // Internal — TWAP
    // ------------------------------------------------------------------

    /**
     * @dev Le os acumuladores de tick da pool em [secondsAgo, 0] e deriva o
     *      tick medio aritmetico da janela, arredondando para -infinito em
     *      deltas negativos nao-divisiveis (convencao `OracleLibrary` da
     *      Uniswap — sem isso o preco seria enviesado para cima em janelas
     *      com tick negativo).
     */
    function _twapTick(uint32 secondsAgo) private view returns (int24 arithMeanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo; // ponto mais antigo
        secondsAgos[1] = 0; // agora

        int56[] memory tickCumulatives;
        try POOL.observe(secondsAgos) returns (int56[] memory ticks, uint160[] memory) {
            tickCumulatives = ticks;
        } catch (bytes memory reason) {
            revert ObserveFailed(reason);
        }

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(secondsAgo));
        int56 meanTick = delta / window;
        // Arredonda para -infinito (divisao inteira do Solidity trunca em
        // direcao a zero).
        if (delta < 0 && (delta % window != 0)) {
            meanTick--;
        }
        if (meanTick < MIN_TICK || meanTick > MAX_TICK) {
            revert InvalidTick(meanTick);
        }
        arithMeanTick = int24(meanTick);
    }

    // ------------------------------------------------------------------
    // Internal — Chainlink USDC/USD
    // ------------------------------------------------------------------

    /**
     * @dev Converte um valor nominal em USDC (18 dec) para USD real (18 dec)
     *      multiplicando pelo preco Chainlink USDC/USD, com checagem de
     *      staleness (max {CHAINLINK_MAX_STALENESS}) e banda de sanidade
     *      fixa [{CHAINLINK_SANITY_LOW_BPS}, {CHAINLINK_SANITY_HIGH_BPS}].
     *      Fallback explicito: feed `address(0)` => assume 1 USDC = 1 USD.
     */
    function _usdcToUsd(uint256 priceUsdc18) private view returns (uint256) {
        IChainlinkAggregator feed = CHAINLINK_USDC_FEED;
        if (address(feed) == address(0)) {
            // Modo sem Chainlink (decisao explicita de deploy): USDC nominal
            // e tratado como USD 1:1.
            return priceUsdc18;
        }

        (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
        if (answer <= 0) {
            revert InvalidChainlinkAnswer(answer);
        }
        if (block.timestamp - updatedAt > CHAINLINK_MAX_STALENESS) {
            revert ChainlinkStale(updatedAt, CHAINLINK_MAX_STALENESS);
        }

        // Normaliza para bps e valida banda (mesma mecanica do
        // {Treasury._enforceChainlinkSanity}; `decimals()` lido a cada
        // chamada para tolerar proxies de agregador que troquem de fase).
        uint256 unit = 10 ** uint256(feed.decimals());
        uint256 bps = (uint256(answer) * BPS_DENOMINATOR) / unit;
        if (bps < CHAINLINK_SANITY_LOW_BPS || bps > CHAINLINK_SANITY_HIGH_BPS) {
            revert UsdcDepegDetected(answer, CHAINLINK_SANITY_LOW_BPS, CHAINLINK_SANITY_HIGH_BPS);
        }

        return Math.mulDiv(priceUsdc18, uint256(answer), unit);
    }

    // ------------------------------------------------------------------
    // Internal — TickMath port (GPL-2.0-or-later, Uniswap V3)
    // ------------------------------------------------------------------

    /**
     * @dev Cota `baseAmount` do token base no token quote ao tick dado.
     *      Port do `OracleLibrary.getQuoteAtTick` (v3-periphery):
     *      - ratioX192 = sqrtRatioX96^2; preco token1/token0 = ratioX192/2^192.
     *      - base == token0: quote = ratioX192 * baseAmount / 2^192.
     *      - base == token1: quote = 2^192 * baseAmount / ratioX192.
     *      Para sqrtRatioX96 > uint128.max, usa a variante em Q128 para nao
     *      estourar o quadrado em 256 bits (mesmo desvio da lib original).
     *      `Math.mulDiv` (OpenZeppelin) da a precisao 512-bit intermediaria
     *      que o `FullMath` da Uniswap dava.
     */
    function _quoteAtTick(
        int24 tick,
        uint128 baseAmount,
        bool baseIsToken0
    ) private pure returns (uint256 quoteAmount) {
        uint160 sqrtRatioX96 = _getSqrtRatioAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseIsToken0
                ? Math.mulDiv(ratioX192, baseAmount, 1 << 192)
                : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseIsToken0
                ? Math.mulDiv(ratioX128, baseAmount, 1 << 128)
                : Math.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    /**
     * @dev sqrt(1.0001^tick) * 2^96, via exponenciacao binaria com as
     *      constantes pre-computadas sqrt(1.0001)^(-2^i) em Q128.
     *      Port fiel do `TickMath.getSqrtRatioAtTick` (v3-core @ 0.7.6,
     *      GPL-2.0-or-later) para 0.8.24: bloco `unchecked` preserva a
     *      aritmetica modular original (os produtos intermediarios em Q128
     *      nunca estouram de fato para |tick| <= MAX_TICK — o unchecked
     *      apenas evita os checks 0.8.x redundantes) e o `require(..., 'T')`
     *      vira {InvalidTick}.
     */
    function _getSqrtRatioAtTick(int24 tick) private pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) {
                revert InvalidTick(tick);
            }

            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            // Q128.128 -> Q64.96, arredondando para cima (convencao TickMath:
            // garante que getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t).
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
