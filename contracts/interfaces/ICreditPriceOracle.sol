// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ICreditPriceOracle
 * @notice Adapter de oracle TWAP que retorna o preco do CREDIT em USD com
 *         precisao de 18 decimais. Abstracao deliberada: o {Treasury} nao
 *         consome `IUniswapV3Pool.observe` direto porque a conversao
 *         `tick -> sqrtPrice -> token1/token0 -> USD` exige `TickMath` /
 *         `OracleLibrary` do Uniswap V3, codigo escrito em pragma `^0.7.6`
 *         e *incompativel* com o pragma `0.8.24` deste projeto.
 * @dev O adapter de producao e um contrato externo separado (`CreditTwapAdapter`)
 *      que internamente usa um TickMath portado para 0.8.x ou um oracle
 *      Chainlink dedicado (CREDIT/USDC custom feed). Nesta Fase 1.1 o
 *      contrato adapter ainda nao existe — o Treasury aceita o endereco como
 *      `address(0)` valido durante bootstrap (buyback fica desativado por
 *      construcao ate o adapter ser setado via {setPriceOracle}).
 *      Em testes, o `UniswapV3PoolMock` implementa este adapter diretamente,
 *      eliminando a necessidade de mockar TickMath.
 *
 *      Convencao numerica:
 *      - `peekTwapPrice` retorna preco em USD com 18 decimais
 *        (ex.: 1e18 = $1.00, 5e17 = $0.50).
 *      - Funcao NAO e `view` deliberadamente: o adapter pode atualizar
 *        contagens internas (ex.: cardinality monitoring). O Treasury chama
 *        dentro de `recordDailyPrice` (state-changing) e em `executeBuyback`
 *        (state-changing). Em adapters trivialmente view, isso e um no-op.
 */
interface ICreditPriceOracle {
    /**
     * @notice Retorna o TWAP do CREDIT em USD com 18 decimais para a janela
     *         `secondsAgo` mais recente.
     * @param secondsAgo Tamanho da janela TWAP em segundos (ex.: 1800 = 30 min).
     *                   O Treasury sempre passa o mesmo valor configurado em
     *                   {Treasury.twapWindowSecs}.
     * @return priceUsd18 Preco do CREDIT em USD com 18 decimais.
     */
    function peekTwapPrice(uint32 secondsAgo) external returns (uint256 priceUsd18);
}
