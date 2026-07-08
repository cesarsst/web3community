// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IUniswapV3Pool (subset)
 * @notice Subset minimo da ABI da pool Uniswap V3 usado pelo {Treasury} para
 *         derivar TWAP de 30 minutos do par CREDIT/USDC. Apenas {observe},
 *         {slot0}, {token0} e {token1} sao consumidos — qualquer chamada
 *         adicional fica fora do escopo de Fase 1.1 do pivot CLP.
 *         ({token0}/{token1} adicionados para o {CreditPriceOracle} detectar
 *         a ordem CREDIT/USDC do par no constructor.)
 * @dev Por que NAO importar `@uniswap/v3-core`:
 *      1. Dependency hell — `v3-core` exige Solidity 0.7.6 (incompativel com
 *         o pragma 0.8.24 deste projeto). O wrapper oficial `v3-periphery`
 *         tem mesmas restricoes.
 *      2. Auditabilidade — interface enxuta congelada permite inspecao
 *         visual completa em ~30 linhas; a interface oficial expoe ~30
 *         metodos dos quais usariamos 2.
 *      3. Storage / layout — Treasury nao herda do pool; chamadas sao via
 *         `staticcall`-friendly externals (`view`).
 *      Caminho de upgrade: se em algum momento o pool ABI mudar (Uniswap V4
 *      ou variantes Curve), basta substituir esta interface; o {Treasury}
 *      depende apenas dos dois metodos abaixo.
 *      Referencia oficial: docs.uniswap.org/contracts/v3/reference/core/interfaces/pool/
 *      IUniswapV3PoolDerivedState
 */
interface IUniswapV3Pool {
    /**
     * @notice Primeiro token do par (o de endereco menor, convencao Uniswap V3).
     * @dev Usado pelo {CreditPriceOracle} para detectar se o CREDIT e token0
     *      ou token1 — a ordem determina a direcao da conversao tick -> preco.
     */
    function token0() external view returns (address);

    /**
     * @notice Segundo token do par (o de endereco maior, convencao Uniswap V3).
     */
    function token1() external view returns (address);

    /**
     * @notice Retorna acumuladores de tick e liquidez observados nos timestamps
     *         derivados de `secondsAgos`. Usado para construir TWAP via
     *         diferenca de acumuladores entre dois pontos no tempo.
     * @param secondsAgos Lista de "X segundos atras"; convencao Uniswap V3 e
     *                    `[older, newer]` — para TWAP de 30min usar
     *                    `[1800, 0]`. A pool reverte com `OLD` se historico
     *                    insuficiente (cardinality nao expandida).
     * @return tickCumulatives Acumulador de tick em cada timestamp (int56).
     * @return secondsPerLiquidityCumulativeX128 Acumulador de seconds/liquidity
     *                    em cada timestamp. NAO consumido pelo {Treasury},
     *                    mas faz parte da assinatura ABI obrigatoria.
     */
    function observe(
        uint32[] calldata secondsAgos
    ) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128);

    /**
     * @notice Estado atual da pool. Usado pelo {Treasury} apenas para leitura
     *         de `tick` instantaneo em diagnosticos / reverts informativos —
     *         decisoes de buyback usam SOMENTE o TWAP de {observe}.
     * @return sqrtPriceX96 Preco atual em formato Q64.96.
     * @return tick Tick instantaneo (preco em log).
     * @return observationIndex Indice atual no ring buffer de observacoes.
     * @return observationCardinality Tamanho atual do ring buffer.
     * @return observationCardinalityNext Tamanho proximo (apos `increaseObservationCardinalityNext`).
     * @return feeProtocol Fee do protocolo (ignorado pelo Treasury).
     * @return unlocked Flag de reentrancy do pool (ignorado pelo Treasury).
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
        );
}
