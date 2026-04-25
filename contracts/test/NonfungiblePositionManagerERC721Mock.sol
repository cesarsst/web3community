// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {INonfungiblePositionManager} from "../interfaces/INonfungiblePositionManager.sol";

/**
 * @title NonfungiblePositionManagerERC721Mock
 * @notice Mock do NPM Uniswap V3 que SE COMPORTA como ERC-721 real (herda
 *         OZ `ERC721`). Usado nos testes do {LiquidityGauge} para exercitar
 *         o fluxo de `safeTransferFrom` (user -> gauge -> staker) que
 *         envolve callbacks `onERC721Received`.
 *
 * @dev Em contraste com o `NonfungiblePositionManagerMock` (usado pelo
 *      Treasury POL test), este mock **e** ERC-721. NAO implementa a logica
 *      de positions/mint/decrease/etc. (irrelevante para o gauge — o gauge
 *      so faz custodia/transferencia). As funcoes de
 *      {INonfungiblePositionManager} ficam stubadas com revert para sinalizar
 *      uso indevido.
 *
 *      Fluxo de teste:
 *        1. `mintTo(user, tokenId)` cunha um NFT diretamente (helper).
 *        2. User chama `approve(gauge, tokenId)` ou `setApprovalForAll(gauge, true)`.
 *        3. User chama `gauge.stake(tokenId, poolId)`. Gauge faz pull via
 *           safeTransferFrom -> repassa para staker -> staker registra
 *           deposit.
 *        4. Em `gauge.unstake/emergencyUnstake`, staker chama
 *           safeTransferFrom para devolver ao user via `withdrawToken`.
 */
contract NonfungiblePositionManagerERC721Mock is ERC721, INonfungiblePositionManager {
    constructor() ERC721("Mock Uniswap V3 Positions NFT", "UNI-V3-POS") {}

    /// @notice Cunha um NFT direto para `to`. Helper de teste.
    function mintTo(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }

    // ------------------------------------------------------------------
    // INonfungiblePositionManager — stubs (gauge nao consome)
    // ------------------------------------------------------------------

    function mint(MintParams calldata) external payable override returns (uint256, uint128, uint256, uint256) {
        revert("NOT_IMPLEMENTED");
    }

    function increaseLiquidity(
        IncreaseLiquidityParams calldata
    ) external payable override returns (uint128, uint256, uint256) {
        revert("NOT_IMPLEMENTED");
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable override returns (uint256, uint256) {
        revert("NOT_IMPLEMENTED");
    }

    function collect(CollectParams calldata) external payable override returns (uint256, uint256) {
        revert("NOT_IMPLEMENTED");
    }

    function positions(
        uint256
    )
        external
        pure
        override
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        revert("NOT_IMPLEMENTED");
    }
}
