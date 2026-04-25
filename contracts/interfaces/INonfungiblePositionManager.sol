// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title INonfungiblePositionManager (subset)
 * @notice Subset minimo da ABI do `NonfungiblePositionManager` (Uniswap V3
 *         periphery) usado pela Fase 1.2 do pivot CLP — Protocol Owned
 *         Liquidity (POL). Apenas as 5 entradas estritamente consumidas
 *         pelo {Treasury} estao expostas:
 *
 *         - {mint}             — primeira `addPOL` cria a posicao NFT.
 *         - {increaseLiquidity}— `addPOL` subsequentes injetam capital na
 *                               mesma posicao.
 *         - {decreaseLiquidity}— `removePOL` retira liquidez (sem queimar o NFT).
 *         - {collect}          — claim de fees (e tokens debitados via
 *                               {decreaseLiquidity}; o NPM separa "owed" de
 *                               "principal", mas ambos saem por aqui).
 *         - {positions}        — leitura on-chain do estado da posicao para
 *                               `polPosition()`.
 *
 * @dev *Por que nao importar `@uniswap/v3-periphery`?* A periphery oficial
 *      esta presa em pragma `0.7.6`, incompativel com 0.8.24. A interface
 *      enxuta replica EXATAMENTE os selectors e signatures que o
 *      `NonfungiblePositionManager` deployado na mainnet/sepolia/L2s
 *      expoe — auditavel via comparacao de 4-byte selector.
 *
 *      Referencia oficial:
 *      https://docs.uniswap.org/contracts/v3/reference/periphery/NonfungiblePositionManager
 *
 *      *Por que tornar `mint`/`increaseLiquidity`/`decreaseLiquidity`/`collect`
 *      payable?* O NPM real e payable porque aceita ETH em paths que
 *      envolvam WETH. O Treasury nunca enviara ETH neste fluxo (POL e
 *      CREDIT/USDC), mas a assinatura precisa bater 1:1 com o contrato
 *      deployado para o selector resolver corretamente. NaoSemchamadas com
 *      `value > 0` no Treasury — vide {Treasury.addPOL}.
 */
interface INonfungiblePositionManager {
    // ------------------------------------------------------------------
    // Structs
    // ------------------------------------------------------------------

    /**
     * @notice Parametros de {mint}.
     * @param token0 Endereco do token com menor address (Uniswap ordena).
     * @param token1 Endereco do token com maior address.
     * @param fee Tier (ex.: 3000 = 0.3%).
     * @param tickLower Tick inferior do range. Para full range no tier 0.3%
     *                  (tickSpacing 60), use -887220.
     * @param tickUpper Tick superior. Full range tier 0.3%: +887220.
     * @param amount0Desired Quantidade desejada de token0 (precisao do token).
     * @param amount1Desired Quantidade desejada de token1.
     * @param amount0Min Minimo aceito de token0 (slippage protection).
     * @param amount1Min Minimo aceito de token1.
     * @param recipient Quem recebe o NFT.
     * @param deadline Timestamp UNIX limite.
     */
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    /**
     * @notice Parametros de {increaseLiquidity}.
     * @param tokenId NFT id da posicao a incrementar.
     * @param amount0Desired Quantidade desejada de token0.
     * @param amount1Desired Quantidade desejada de token1.
     * @param amount0Min Slippage protection token0.
     * @param amount1Min Slippage protection token1.
     * @param deadline Timestamp UNIX limite.
     */
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /**
     * @notice Parametros de {decreaseLiquidity}.
     * @param tokenId NFT id da posicao a reduzir.
     * @param liquidity Quantidade de liquidez a remover (em unidades L do
     *                  Uniswap V3, retornadas por {mint}/{increaseLiquidity}).
     * @param amount0Min Slippage protection token0.
     * @param amount1Min Slippage protection token1.
     * @param deadline Timestamp UNIX limite.
     */
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /**
     * @notice Parametros de {collect}.
     * @param tokenId NFT id.
     * @param recipient Quem recebe os tokens (fees + principal liberado).
     * @param amount0Max Maximo aceito a coletar de token0 (use type(uint128).max
     *                   para "tudo o que estiver disponivel").
     * @param amount1Max Maximo aceito de token1.
     */
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    // ------------------------------------------------------------------
    // External writes
    // ------------------------------------------------------------------

    /**
     * @notice Cria uma nova posicao concentrada e cunha o NFT correspondente.
     * @param params Ver {MintParams}.
     * @return tokenId NFT id minted.
     * @return liquidity Liquidez efetivamente provisionada.
     * @return amount0 Quantidade real de token0 consumida.
     * @return amount1 Quantidade real de token1 consumida.
     */
    function mint(
        MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    /**
     * @notice Adiciona liquidez a uma posicao existente.
     * @param params Ver {IncreaseLiquidityParams}.
     * @return liquidity Liquidez adicional efetivamente provisionada.
     * @return amount0 Quantidade real de token0 consumida.
     * @return amount1 Quantidade real de token1 consumida.
     */
    function increaseLiquidity(
        IncreaseLiquidityParams calldata params
    ) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    /**
     * @notice Reduz a liquidez de uma posicao. Os tokens NAO sao transferidos
     *         neste call — ficam "owed" e devem ser sacados via {collect}.
     * @param params Ver {DecreaseLiquidityParams}.
     * @return amount0 Quantidade de token0 que ficou owed apos a reducao.
     * @return amount1 Quantidade de token1 que ficou owed apos a reducao.
     */
    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1);

    /**
     * @notice Coleta tokens "owed" da posicao (fees ja acumulados +
     *         principal liberado por {decreaseLiquidity}).
     * @param params Ver {CollectParams}.
     * @return amount0 Quantidade de token0 efetivamente transferida.
     * @return amount1 Quantidade de token1 efetivamente transferida.
     */
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    // ------------------------------------------------------------------
    // External views
    // ------------------------------------------------------------------

    /**
     * @notice Le o estado completo de uma posicao.
     * @dev Assinatura identica a do NPM canonico Uniswap V3. Campos:
     *      - nonce / operator: ERC-721 / approvals (nao usados pelo Treasury).
     *      - token0 / token1 / fee: identificadores do par.
     *      - tickLower / tickUpper: range.
     *      - liquidity: liquidez ativa atual.
     *      - feeGrowthInside0LastX128 / feeGrowthInside1LastX128: bookkeeping
     *        interno para calculo de fees pendentes.
     *      - tokensOwed0 / tokensOwed1: fees + principal liberados a coletar.
     * @param tokenId NFT id.
     */
    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}
