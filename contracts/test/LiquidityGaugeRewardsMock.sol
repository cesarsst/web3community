// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILiquidityGaugeRewards} from "../interfaces/ILiquidityGaugeRewards.sol";

/**
 * @title LiquidityGaugeRewardsMock
 * @notice Mock minimo da interface `ILiquidityGaugeRewards`. Para testes da
 *         Fase 1.4 que validam:
 *         - `Treasury.flushPendingGaugeRewards` empurra para o gauge;
 *         - `RewardDistributorV2._emitLpsBucket` decide push vs fallback;
 *         - bypass do gauge real (LiquidityGauge.sol) que tem dependencias
 *           pesadas (UniswapV3Staker, NPM canonico).
 * @dev Acumula em ledger interno e faz pull do CREDIT do caller via
 *      transferFrom. Nao distribui — testes verificam apenas o pull e o
 *      contador de chamadas.
 */
contract LiquidityGaugeRewardsMock is ILiquidityGaugeRewards {
    using SafeERC20 for IERC20;

    bool public override paused;
    IERC20 public immutable REWARD_TOKEN;

    /// @notice Eventos observados, contadores e ultimo argumento de cada chamada.
    uint256 public notifyCount;
    uint256 public lastNotifyAmount;
    uint256 public lastPoolId;
    uint32 public lastDuration;
    bytes32 public lastIncentiveHash;

    /// @notice Quando true, {notifyRewardAmount} reverte com mensagem custom
    ///         (testar fallback fora do paused — cenario adversarial onde gauge
    ///         nao esta paused mas mesmo assim falha).
    bool public failNotify;

    constructor(address rewardToken_) {
        REWARD_TOKEN = IERC20(rewardToken_);
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setFailNotify(bool v) external {
        failNotify = v;
    }

    function notifyRewardAmount(
        uint256 poolId,
        uint256 amount,
        uint32 duration
    ) external override returns (bytes32 incentiveHash) {
        require(!failNotify, "LiquidityGaugeRewardsMock: forced failure");
        REWARD_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        notifyCount += 1;
        lastNotifyAmount = amount;
        lastPoolId = poolId;
        lastDuration = duration;
        incentiveHash = keccak256(abi.encodePacked(poolId, amount, duration, block.timestamp));
        lastIncentiveHash = incentiveHash;
    }
}
