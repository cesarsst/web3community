// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IChainlinkAggregator (subset)
 * @notice Subset minimo da `AggregatorV3Interface` da Chainlink usada pelo
 *         {Treasury} para sanity-check do preco USDC/USD. Apenas
 *         {latestRoundData} e {decimals} sao consumidos.
 * @dev Por que NAO importar `@chainlink/contracts`: dependencia adicional
 *      pesada (todo o pacote para usar 1 metodo). Interface congelada e mais
 *      auditavel e desacopla do versionamento do pacote oficial.
 *      Referencia: https://docs.chain.link/data-feeds/api-reference
 */
interface IChainlinkAggregator {
    /**
     * @notice Retorna o estado da round mais recente.
     * @return roundId Identificador (uint80) da round (cresce monotonicamente
     *                 dentro de uma fase do agregador).
     * @return answer Preco em precisao definida por {decimals}. Para USDC/USD
     *                a precisao Chainlink padrao e 8 (e.g. `1.00 USD` = 1e8).
     * @return startedAt Timestamp UNIX em que a round comecou.
     * @return updatedAt Timestamp UNIX da ultima atualizacao. O {Treasury} usa
     *                   este campo para detectar staleness.
     * @return answeredInRound Round em que a resposta foi originalmente
     *                   computada (pode diferir de `roundId` em forks de fase).
     */
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    /**
     * @notice Numero de casas decimais da resposta de {latestRoundData}.
     * @return Decimals do feed (USDC/USD = 8 em produção).
     */
    function decimals() external view returns (uint8);
}
