// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IChainlinkAggregator} from "../interfaces/IChainlinkAggregator.sol";

/**
 * @title ChainlinkAggregatorMock
 * @notice Mock determinístico do {IChainlinkAggregator} usado em
 *         test/Treasury.buyback.test.ts para simular o feed USDC/USD.
 * @dev Decimals fixos em 8 (mesma convenção do feed USDC/USD da Chainlink).
 *      `answer` e `updatedAt` sao setaveis pelo teste; demais campos
 *      retornados por {latestRoundData} são valores constantes "OK".
 */
contract ChainlinkAggregatorMock is IChainlinkAggregator {
    int256 public mockAnswer;
    uint256 public mockUpdatedAt;
    uint8 public constant DECIMALS = 8;

    constructor() {
        // Default: USDC pegged em $1 (8 decimais => 1e8) e atualizado agora.
        mockAnswer = 1e8;
        mockUpdatedAt = block.timestamp;
    }

    function setAnswer(int256 answer_) external {
        mockAnswer = answer_;
    }

    function setUpdatedAt(uint256 ts) external {
        mockUpdatedAt = ts;
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, mockAnswer, mockUpdatedAt, mockUpdatedAt, 1);
    }
}
