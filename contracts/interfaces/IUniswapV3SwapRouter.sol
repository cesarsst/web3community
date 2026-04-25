// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IUniswapV3SwapRouter (subset)
 * @notice Subset minimo da ABI do `SwapRouter` (V3) usado pelo {Treasury} para
 *         executar buyback de CREDIT pago em USDC. Apenas {exactInputSingle}
 *         e exposto. {exactInput} (multi-hop), {exactOutputSingle},
 *         {exactOutput} ficam intencionalmente fora — buyback via FFP usa
 *         pool unica e quantidade exata de input.
 * @dev Mesma justificativa de `IUniswapV3Pool`: importar `v3-periphery`
 *      requereria pragma 0.7.6 (incompativel com 0.8.24). Interface enxuta
 *      e congelada.
 *      Referencia: https://docs.uniswap.org/contracts/v3/reference/periphery/SwapRouter
 */
interface IUniswapV3SwapRouter {
    /**
     * @notice Parametros do swap exact-input single-hop.
     * @param tokenIn Endereco do token consumido (USDC neste contexto).
     * @param tokenOut Endereco do token recebido (CREDIT neste contexto).
     * @param fee Tier de fee da pool (ex.: 3000 = 0.3%).
     * @param recipient Quem recebe `tokenOut` apos o swap.
     * @param deadline Timestamp UNIX ate o qual o swap e valido.
     * @param amountIn Quantidade exata de `tokenIn` a consumir.
     * @param amountOutMinimum Slippage cap — reverte se output for menor.
     * @param sqrtPriceLimitX96 Limite de preco; `0` desativa o limite.
     */
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Executa swap exact-input single-hop. Reverte se
     *         `amountOut < amountOutMinimum` (proteção de slippage). O
     *         caller deve ter aprovado `amountIn` de `tokenIn` ao router.
     * @param params Parametros agrupados (ver {ExactInputSingleParams}).
     * @return amountOut Quantidade de `tokenOut` recebida.
     */
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
