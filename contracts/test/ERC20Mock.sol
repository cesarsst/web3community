// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ERC20Mock
 * @notice Mock minimo de ERC-20 para testes (nao-standard: inclui {mint} publico,
 *         sem controle de acesso). NAO deploy em producao.
 * @dev Usado em test/Treasury.test.ts para simular stablecoin (USDC) e outros
 *      tokens passivamente aceitos pela Treasury.
 */
contract ERC20Mock is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
