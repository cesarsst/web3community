// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ITreasurySweep {
    function sweepETH(address payable to, uint256 amount) external;
}

/**
 * @title ReentrantETHReceiver
 * @notice Contrato que, ao receber ETH via {receive}, tenta reentrar em
 *         {Treasury.sweepETH}. Usado exclusivamente para validar o
 *         `ReentrancyGuard` em caminhos que saem ETH.
 * @dev NAO deploy em producao.
 */
contract ReentrantETHReceiver {
    ITreasurySweep public immutable TREASURY;
    uint256 public immutable REENTER_AMOUNT;

    constructor(address treasury_, uint256 reenterAmount_) {
        TREASURY = ITreasurySweep(treasury_);
        REENTER_AMOUNT = reenterAmount_;
    }

    receive() external payable {
        // Tenta chamar de volta — se o guard estiver correto, reverte.
        TREASURY.sweepETH(payable(address(this)), REENTER_AMOUNT);
    }
}
