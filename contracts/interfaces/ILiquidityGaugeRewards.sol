// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ILiquidityGaugeRewards
 * @notice Interface slim consumida por `RewardDistributorV2` para notificar
 *         emissao do bucket LP via push direto. Mantida em arquivo proprio
 *         para evitar import do contrato completo (com herancas pesadas
 *         AccessControl/ReentrancyGuard/Pausable) onde so precisamos de
 *         duas funcoes.
 * @dev `notifyRewardAmount` exige que o caller tenha:
 *       (1) CREDIT em `address(this)` (caller) suficiente para `amount`;
 *       (2) approve previo do CREDIT para o gauge (modelo pull do gauge).
 *      `paused()` reflete o estado herdado de `Pausable` no LiquidityGauge.
 */
interface ILiquidityGaugeRewards {
    /// @notice Cria nova incentive na pool `poolId` com `amount` CREDIT
    ///         distribuidos ao longo de `duration` segundos.
    /// @return incentiveHash Hash da incentive criada (keccak256 da key).
    function notifyRewardAmount(
        uint256 poolId,
        uint256 amount,
        uint32 duration
    ) external returns (bytes32 incentiveHash);

    /// @notice `true` se o gauge esta pausado (do `Pausable` do OZ).
    function paused() external view returns (bool);
}
