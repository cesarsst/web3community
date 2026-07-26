// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ERC20DecimalsMock
 * @notice Mock de ERC-20 com `decimals` configuravel no constructor (o
 *         {ERC20Mock} legado fixa 18). Inclui {mint} publico, sem controle
 *         de acesso. NAO deploy em producao.
 * @dev Usado em test/Remodel.test.ts / test/CreditPSM para simular o USDC com 6
 *      decimais reais (a conversao 6 -> 18 dec e parte do contrato sob
 *      teste) e tokens com decimals invalidos (> 18).
 */
contract ERC20DecimalsMock is ERC20 {
    uint8 private immutable _CUSTOM_DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _CUSTOM_DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _CUSTOM_DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
