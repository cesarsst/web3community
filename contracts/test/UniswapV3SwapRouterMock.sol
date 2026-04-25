// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3SwapRouter} from "../interfaces/IUniswapV3SwapRouter.sol";

// Sem interface IMintable necessaria: o mock transfere tokenOut do proprio
// saldo, pre-funded pelo teste antes do swap. Isso desacopla o mock da
// ABI especifica do tokenOut (CreditToken usa `mint(addr, amt, tag)` com
// MINTER_ROLE; ERC20Mock generico usa `mint(addr, amt)`).

/**
 * @title UniswapV3SwapRouterMock
 * @notice Mock minimo do `SwapRouter` Uniswap V3 usado em
 *         test/Treasury.buyback.test.ts. Recebe `tokenIn`, "queima"
 *         localmente (mantem custodiado neste mock), e ENTREGA `tokenOut`
 *         cunhando-o no recipient via {IMintableMock.mint}. Isso evita
 *         pre-funding do mock antes de cada teste e mantem o swap puramente
 *         determinístico via `mockRate`.
 * @dev `mockRate` e a quantidade de `tokenOut` por unidade de `tokenIn`
 *      (em precisao de tokenOut). Default 1:1 (em wei).
 *      Para forcar slippage abaixo do `amountOutMinimum`, o teste seta
 *      `mockOutOverride > 0` — o mock devolve esse valor independente de
 *      `mockRate`. {exactInputSingle} entao reverte com SLIPPAGE quando
 *      `mockOutOverride < amountOutMinimum`.
 */
contract UniswapV3SwapRouterMock is IUniswapV3SwapRouter {
    /// @notice Preco em formato "1 tokenIn = mockRate tokenOut" (precisao
    ///         do tokenOut). Default 1e18 (1:1 em 18 decimais).
    uint256 public mockRate = 1e18;

    /// @notice Override absoluto do output (em unidades de `tokenOut`).
    ///         Quando > 0, usado em vez do calculo `amountIn * rate`.
    uint256 public mockOutOverride;

    /// @notice Forcar revert generico em {exactInputSingle}.
    bool public revertOnSwap;

    function setRate(uint256 rate_) external {
        mockRate = rate_;
    }

    function setOutOverride(uint256 amountOut_) external {
        mockOutOverride = amountOut_;
    }

    function setRevertOnSwap(bool flag) external {
        revertOnSwap = flag;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        if (revertOnSwap) {
            revert("SWAP_FAILED");
        }
        // Pull tokenIn (assume aprovacao previa).
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = mockOutOverride > 0 ? mockOutOverride : (params.amountIn * mockRate) / 1e18;
        if (amountOut < params.amountOutMinimum) {
            revert("Too little received");
        }
        // Transfere tokenOut do saldo proprio (pre-funded pelo teste).
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
