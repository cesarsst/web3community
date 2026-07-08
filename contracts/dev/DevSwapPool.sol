// SPDX-License-Identifier: GPL-2.0-or-later
// Este arquivo contem um port do algoritmo `getSqrtRatioAtTick` do TickMath
// da Uniswap V3 (v3-core, licenca GPL-2.0-or-later) — o mesmo port ja usado
// em contracts/CreditPriceOracle.sol. Por derivacao, o arquivo inteiro e
// licenciado GPL-2.0-or-later (diferente do restante do repo, MIT).
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IUniswapV3SwapRouter} from "../interfaces/IUniswapV3SwapRouter.sol";

/**
 * @title DevSwapPool
 * @notice AMM constant-product (x*y=k) do par CREDIT/USDC EXCLUSIVO PARA A
 *         REDE LOCAL (hardhat). Simula, num unico contrato, as duas pecas de
 *         infraestrutura Uniswap V3 que o ecossistema consome em producao:
 *
 *          1. A POOL CREDIT/USDC como fonte de TWAP: implementa o subset
 *             {IUniswapV3Pool} que o {CreditPriceOracle} le (`token0`,
 *             `token1`, `observe`, `slot0`), mantendo checkpoints de tick
 *             cumulativo a cada swap — o TWAP derivado pelo oracle segue o
 *             preco real da pool, com janela historica correta.
 *          2. O SWAP ROUTER: implementa {IUniswapV3SwapRouter.exactInputSingle}
 *             para que o {Treasury.executeBuyback} funcione contra esta pool
 *             sem adaptacao.
 *
 *         Alem disso expoe um caminho de swap direto ({swapExactInput}) para
 *         o hub (compra/venda de CREDIT com USDC pelos usuarios da rede
 *         local) e uma semeadura permissionless de liquidez ({seed}).
 *
 * @dev NAO DEPLOYAR EM PRODUCAO. Diferencas deliberadas vs. Uniswap V3:
 *      - Curva x*y=k global (estilo V2), sem liquidez concentrada nem NFTs
 *        de posicao. O tick reportado e derivado do preco spot das reservas
 *        (`sqrt(reserve1/reserve0) * 2^96` -> tick), suficiente para o
 *        {CreditPriceOracle} — que so consome `observe`.
 *      - Sem LP shares: a liquidez semeada e doada a pool (dev-only; o
 *        script de deploy e a unica origem esperada). Fee de 0.30% por swap
 *        fica nas reservas.
 *      - Historico de observacoes ILIMITADO (um checkpoint por swap) — em
 *        dev o volume e minusculo; nao ha ring buffer/cardinality. `observe`
 *        nunca reverte com `OLD`: antes do primeiro checkpoint o tick e
 *        extrapolado flat (preco constante desde a semeadura), entao o TWAP
 *        e bem definido em qualquer janela desde o `seed`.
 *      - `exactInputSingle` ignora `fee`, `deadline == 0` e
 *        `sqrtPriceLimitX96` (parametros de roteamento V3 sem equivalente
 *        aqui); honra `tokenIn`/`tokenOut`, `amountIn`, `amountOutMinimum`
 *        e `recipient`.
 */
contract DevSwapPool is ReentrancyGuard, IUniswapV3SwapRouter {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Fee de swap em basis points (30 = 0.30%, tier classico V3).
    uint16 public constant FEE_BPS = 30;

    /// @dev Denominador de basis points.
    uint256 private constant _BPS = 10_000;

    /// @notice Tick minimo suportado (TickMath.MIN_TICK).
    int24 public constant MIN_TICK = -887272;

    /// @notice Tick maximo suportado (TickMath.MAX_TICK).
    int24 public constant MAX_TICK = 887272;

    // ------------------------------------------------------------------
    // Immutables / storage
    // ------------------------------------------------------------------

    /// @notice token0 do par (endereco menor, convencao Uniswap V3).
    address public immutable TOKEN0;

    /// @notice token1 do par (endereco maior).
    address public immutable TOKEN1;

    /// @notice Reserva corrente de token0 (contabilidade interna; doacoes
    ///         diretas de token nao entram na curva).
    uint256 public reserve0;

    /// @notice Reserva corrente de token1.
    uint256 public reserve1;

    /// @notice Checkpoint de tick cumulativo. `cumulative` e o acumulador
    ///         ate `blockTimestamp`; `tick` vigora de `blockTimestamp` ate o
    ///         proximo checkpoint (piecewise-constant, como na V3).
    struct Checkpoint {
        uint32 blockTimestamp;
        int56 tickCumulative;
        int24 tick;
    }

    /// @notice Historico de checkpoints (1 por swap/seed; sem ring buffer —
    ///         dev only).
    Checkpoint[] public checkpoints;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido em {seed}.
    event Seeded(address indexed from, uint256 amount0, uint256 amount1, int24 tick);

    /// @notice Emitido em todo swap bem-sucedido (inclui {exactInputSingle}).
    event DevSwap(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        int24 tick
    );

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Tokens do par devem ser distintos.
    error IdenticalTokens();

    /// @notice Valor zero nao e permitido.
    error ZeroAmount();

    /// @notice Token informado nao pertence ao par.
    error InvalidToken(address token);

    /// @notice Pool ainda sem liquidez (rode {seed} primeiro).
    error NoLiquidity();

    /// @notice Output abaixo do minimo exigido (protecao de slippage).
    error SlippageExceeded(uint256 amountOut, uint256 minimumOut);

    /// @notice Tick derivado fora de [MIN_TICK, MAX_TICK].
    error InvalidTick(int256 tick);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria a pool do par (ordenado por endereco, convencao V3).
     * @param tokenA Um lado do par (ex.: CREDIT).
     * @param tokenB Outro lado (ex.: USDC mock).
     */
    constructor(address tokenA, address tokenB) {
        if (tokenA == address(0) || tokenB == address(0)) {
            revert ZeroAddress();
        }
        if (tokenA == tokenB) {
            revert IdenticalTokens();
        }
        (TOKEN0, TOKEN1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    // ------------------------------------------------------------------
    // Liquidity (dev-only, sem LP shares)
    // ------------------------------------------------------------------

    /**
     * @notice Doa liquidez a pool (puxa via `transferFrom`; exige approve
     *         previo dos dois tokens). Permissionless — em dev quem semeia
     *         e o script de deploy.
     * @param amount0 Quantidade de {TOKEN0}.
     * @param amount1 Quantidade de {TOKEN1}.
     */
    function seed(uint256 amount0, uint256 amount1) external nonReentrant {
        if (amount0 == 0 || amount1 == 0) {
            revert ZeroAmount();
        }
        IERC20(TOKEN0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(TOKEN1).safeTransferFrom(msg.sender, address(this), amount1);
        reserve0 += amount0;
        reserve1 += amount1;

        int24 tick = _currentTickFromReserves();
        _checkpoint(tick);
        emit Seeded(msg.sender, amount0, amount1, tick);
    }

    // ------------------------------------------------------------------
    // Swap — caminho direto (hub)
    // ------------------------------------------------------------------

    /**
     * @notice Troca `amountIn` de `tokenIn` pelo outro token do par, enviando
     *         o output para `to`. Exige approve previo de `tokenIn`.
     * @param tokenIn Token de entrada ({TOKEN0} ou {TOKEN1}).
     * @param amountIn Quantidade de entrada (> 0).
     * @param minAmountOut Minimo aceito de output (protecao de slippage).
     * @param to Destinatario do output.
     * @return amountOut Quantidade efetivamente enviada.
     */
    function swapExactInput(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) public nonReentrant returns (uint256 amountOut) {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (amountIn == 0) {
            revert ZeroAmount();
        }
        bool zeroForOne = tokenIn == TOKEN0;
        if (!zeroForOne && tokenIn != TOKEN1) {
            revert InvalidToken(tokenIn);
        }
        if (reserve0 == 0 || reserve1 == 0) {
            revert NoLiquidity();
        }

        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < minAmountOut) {
            revert SlippageExceeded(amountOut, minAmountOut);
        }

        address tokenOut = zeroForOne ? TOKEN1 : TOKEN0;
        if (zeroForOne) {
            reserve0 += amountIn;
            reserve1 -= amountOut;
        } else {
            reserve1 += amountIn;
            reserve0 -= amountOut;
        }

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(to, amountOut);

        int24 tick = _currentTickFromReserves();
        _checkpoint(tick);
        emit DevSwap(msg.sender, to, tokenIn, amountIn, amountOut, tick);
    }

    /**
     * @notice Cota (sem side effects) o output de um {swapExactInput}.
     * @param tokenIn Token de entrada.
     * @param amountIn Quantidade de entrada.
     * @return amountOut Output previsto com a fee aplicada.
     */
    function quoteExactInput(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        if (amountIn == 0) {
            return 0;
        }
        bool zeroForOne = tokenIn == TOKEN0;
        if (!zeroForOne && tokenIn != TOKEN1) {
            revert InvalidToken(tokenIn);
        }
        if (reserve0 == 0 || reserve1 == 0) {
            revert NoLiquidity();
        }
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
    }

    // ------------------------------------------------------------------
    // Swap — compat IUniswapV3SwapRouter (Treasury.executeBuyback)
    // ------------------------------------------------------------------

    /**
     * @notice Implementacao do router V3 usado pelo {Treasury}. Delega ao
     *         mesmo motor de swap da pool.
     * @dev `fee` e `sqrtPriceLimitX96` sao ignorados (sem tiers/limite de
     *      preco nesta curva); `deadline` e honrado quando != 0.
     */
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        // solhint-disable-next-line not-rely-on-time
        require(params.deadline == 0 || params.deadline >= block.timestamp, "Transaction too old");
        address expectedOut = params.tokenIn == TOKEN0 ? TOKEN1 : TOKEN0;
        if (params.tokenOut != expectedOut) {
            revert InvalidToken(params.tokenOut);
        }
        amountOut = swapExactInput(params.tokenIn, params.amountIn, params.amountOutMinimum, params.recipient);
    }

    // ------------------------------------------------------------------
    // Subset IUniswapV3Pool (consumido pelo CreditPriceOracle)
    // ------------------------------------------------------------------

    /// @notice Primeiro token do par (endereco menor, convencao V3).
    function token0() external view returns (address) {
        return TOKEN0;
    }

    /// @notice Segundo token do par (endereco maior).
    function token1() external view returns (address) {
        return TOKEN1;
    }

    /**
     * @notice Acumuladores de tick nos instantes `now - secondsAgos[i]`,
     *         derivados dos checkpoints piecewise-constant.
     * @dev Nunca reverte com `OLD`: instantes anteriores ao primeiro
     *      checkpoint extrapolam flat com o tick inicial (preco constante
     *      antes da semeadura). `secondsPerLiquidityCumulativeX128` e
     *      retornado zerado — o {CreditPriceOracle} nao o consome.
     */
    function observe(
        uint32[] calldata secondsAgos
    ) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128) {
        if (checkpoints.length == 0) {
            revert NoLiquidity();
        }
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128 = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            // solhint-disable-next-line not-rely-on-time
            tickCumulatives[i] = _tickCumulativeAt(uint32(block.timestamp) - secondsAgos[i]);
        }
    }

    /**
     * @notice Estado atual da pool (subset V3): preco spot e tick derivados
     *         das reservas. Campos de cardinality/fee sao dummies.
     */
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        if (reserve0 == 0 || reserve1 == 0) {
            return (0, 0, 0, 0, 0, 0, true);
        }
        sqrtPriceX96 = _sqrtPriceX96FromReserves();
        tick = _tickFromSqrtRatio(sqrtPriceX96);
        return (sqrtPriceX96, tick, 0, 1, 1, 0, true);
    }

    /// @notice Numero de checkpoints registrados (diagnostico/UI).
    function checkpointCount() external view returns (uint256) {
        return checkpoints.length;
    }

    // ------------------------------------------------------------------
    // Internal — swap math
    // ------------------------------------------------------------------

    /// @dev Constant product com fee de {FEE_BPS} descontada da entrada:
    ///      out = reserveOut * inFee / (reserveIn + inFee).
    function _getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) private pure returns (uint256 amountOut) {
        uint256 amountInWithFee = amountIn * (_BPS - FEE_BPS);
        amountOut = (reserveOut * amountInWithFee) / (reserveIn * _BPS + amountInWithFee);
        if (amountOut == 0) {
            revert ZeroAmount();
        }
    }

    // ------------------------------------------------------------------
    // Internal — checkpoints / TWAP
    // ------------------------------------------------------------------

    /// @dev Registra o tick vigente a partir de agora. Mesmo timestamp =>
    ///      atualiza o ultimo checkpoint em vez de duplicar.
    function _checkpoint(int24 tick) private {
        // solhint-disable-next-line not-rely-on-time
        uint32 nowTs = uint32(block.timestamp);
        uint256 n = checkpoints.length;
        if (n == 0) {
            checkpoints.push(Checkpoint({blockTimestamp: nowTs, tickCumulative: 0, tick: tick}));
            return;
        }
        Checkpoint storage last = checkpoints[n - 1];
        if (last.blockTimestamp == nowTs) {
            last.tick = tick;
            return;
        }
        int56 cum = last.tickCumulative + int56(last.tick) * int56(uint56(nowTs - last.blockTimestamp));
        checkpoints.push(Checkpoint({blockTimestamp: nowTs, tickCumulative: cum, tick: tick}));
    }

    /// @dev Acumulador de tick no instante `targetTs` (piecewise-constant;
    ///      flat antes do primeiro checkpoint, tick corrente depois do
    ///      ultimo). Busca binaria pelo checkpoint imediatamente <= target.
    function _tickCumulativeAt(uint32 targetTs) private view returns (int56) {
        Checkpoint storage first = checkpoints[0];
        if (targetTs <= first.blockTimestamp) {
            // Extrapolacao flat pra tras com o tick inicial.
            return -int56(first.tick) * int56(uint56(first.blockTimestamp - targetTs));
        }
        uint256 lo = 0;
        uint256 hi = checkpoints.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (checkpoints[mid].blockTimestamp <= targetTs) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Checkpoint storage cp = checkpoints[lo];
        return cp.tickCumulative + int56(cp.tick) * int56(uint56(targetTs - cp.blockTimestamp));
    }

    // ------------------------------------------------------------------
    // Internal — preco/tick a partir das reservas
    // ------------------------------------------------------------------

    /// @dev sqrt(reserve1/reserve0) em Q64.96. `Math.mulDiv` da o headroom
    ///      512-bit pro produto reserve1 * 2^192.
    function _sqrtPriceX96FromReserves() private view returns (uint160) {
        uint256 ratioX192 = Math.mulDiv(reserve1, 1 << 192, reserve0);
        uint256 sqrtX96 = Math.sqrt(ratioX192);
        if (sqrtX96 > type(uint160).max) {
            revert InvalidTick(int256(sqrtX96));
        }
        return uint160(sqrtX96);
    }

    /// @dev Tick spot corrente derivado das reservas.
    function _currentTickFromReserves() private view returns (int24) {
        return _tickFromSqrtRatio(_sqrtPriceX96FromReserves());
    }

    /// @dev Inverso de {_getSqrtRatioAtTick} por busca binaria (~21
    ///      iteracoes): maior tick cujo sqrtRatio <= alvo. Equivale ao
    ///      `TickMath.getTickAtSqrtRatio` para os propositos do oracle
    ///      (floor do log_1.0001 do preco).
    function _tickFromSqrtRatio(uint160 sqrtPriceX96) private pure returns (int24) {
        if (sqrtPriceX96 < _getSqrtRatioAtTick(MIN_TICK) || sqrtPriceX96 > _getSqrtRatioAtTick(MAX_TICK)) {
            revert InvalidTick(int256(uint256(sqrtPriceX96)));
        }
        int24 lo = MIN_TICK;
        int24 hi = MAX_TICK;
        while (lo < hi) {
            int24 mid = int24((int256(lo) + int256(hi) + 1) / 2);
            if (_getSqrtRatioAtTick(mid) <= sqrtPriceX96) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo;
    }

    /**
     * @dev sqrt(1.0001^tick) * 2^96 — port fiel do
     *      `TickMath.getSqrtRatioAtTick` (Uniswap v3-core @ 0.7.6,
     *      GPL-2.0-or-later), identico ao usado no {CreditPriceOracle}.
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

            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
