// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Interface minima do alvo (Staking) para evitar import circular.
 */
interface IReentrantStakingTarget {
    function stake(uint256 projectId, uint256 amount, uint64 lockDuration) external;

    function unstake(uint256 projectId, uint256 amount) external;

    function increaseStake(uint256 projectId, uint256 amount) external;

    function unstakeAll(uint256 projectId) external;
}

/**
 * @title ReentrantStakingERC20Mock
 * @notice ERC-20 malicioso que tenta reentrar no {Staking} durante a
 *         `transfer`/`transferFrom`, simulando token com callback. Usado
 *         para validar o `ReentrancyGuard` no Staking.
 * @dev NAO deploy em producao. Duas modalidades de ataque:
 *        - `attackOnPull` (from == attackerEOA): dispara quando o usuario
 *          chama stake e o mock faz um re-stake no meio.
 *        - `attackOnPush` (from == staking): dispara quando o Staking faz
 *          `safeTransfer` no unstake e o mock tenta chamar unstake de novo.
 */
contract ReentrantStakingERC20Mock is ERC20 {
    IReentrantStakingTarget public attackTarget;
    uint256 public projectId;
    uint256 public attackAmount;
    uint64 public attackLockDuration;
    // 0 = disarm
    // 1 = attack-on-pull via stake() reentry
    // 2 = attack-on-push via unstake() reentry
    // 3 = attack-on-pull via increaseStake() reentry
    // 4 = attack-on-push via unstakeAll() reentry
    uint8 public mode;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function armStakeReentry(address target_, uint256 projectId_, uint256 amount_, uint64 lockDuration_) external {
        attackTarget = IReentrantStakingTarget(target_);
        projectId = projectId_;
        attackAmount = amount_;
        attackLockDuration = lockDuration_;
        mode = 1;
    }

    function armUnstakeReentry(address target_, uint256 projectId_, uint256 amount_) external {
        attackTarget = IReentrantStakingTarget(target_);
        projectId = projectId_;
        attackAmount = amount_;
        mode = 2;
    }

    function armIncreaseStakeReentry(address target_, uint256 projectId_, uint256 amount_) external {
        attackTarget = IReentrantStakingTarget(target_);
        projectId = projectId_;
        attackAmount = amount_;
        mode = 3;
    }

    function armUnstakeAllReentry(address target_, uint256 projectId_) external {
        attackTarget = IReentrantStakingTarget(target_);
        projectId = projectId_;
        mode = 4;
    }

    function disarm() external {
        mode = 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        uint8 m = mode;
        // Auto-disarm apos o primeiro disparo para evitar loop infinito.
        if (m == 1 && to == address(attackTarget)) {
            mode = 0;
            attackTarget.stake(projectId, attackAmount, attackLockDuration);
        } else if (m == 2 && from == address(attackTarget)) {
            mode = 0;
            attackTarget.unstake(projectId, attackAmount);
        } else if (m == 3 && to == address(attackTarget)) {
            mode = 0;
            attackTarget.increaseStake(projectId, attackAmount);
        } else if (m == 4 && from == address(attackTarget)) {
            mode = 0;
            attackTarget.unstakeAll(projectId);
        }
        super._update(from, to, value);
    }
}
