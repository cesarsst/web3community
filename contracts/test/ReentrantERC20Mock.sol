// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Interface minima do alvo reentrante. Evita import circular com
 *         {Treasury} e mantem o mock independente da ABI exata do contrato.
 */
interface IReentrancyTarget {
    function transfer(address token, address to, uint256 amount) external;
}

/**
 * @title ReentrantERC20Mock
 * @notice ERC-20 malicioso que tenta reentrar no alvo configurado durante a
 *         transferencia (hook pre-{_update}), simulando o comportamento de um
 *         token com callback (ex.: ERC-777) ou um ERC-20 malicioso customizado.
 * @dev Exclusivamente para testes de `ReentrancyGuard` na {Treasury}. NAO
 *      deploy em producao.
 */
contract ReentrantERC20Mock is ERC20 {
    IReentrancyTarget public attackTarget;
    address public targetToken;
    address public attackTo;
    uint256 public attackAmount;
    bool public attackArmed;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Configura a tentativa de reentrancia. Ao proximo transfer/
     *         transferFrom disparado pelo alvo, o mock chama
     *         `attackTarget.transfer(targetToken, attackTo, attackAmount)`
     *         antes de completar a transferencia.
     */
    function armAttack(address target_, address targetToken_, address attackTo_, uint256 attackAmount_) external {
        attackTarget = IReentrancyTarget(target_);
        targetToken = targetToken_;
        attackTo = attackTo_;
        attackAmount = attackAmount_;
        attackArmed = true;
    }

    function disarmAttack() external {
        attackArmed = false;
    }

    /**
     * @dev Hook de transferencia do OZ 5. Quando `from == attackTarget`
     *      (Treasury executando uma saida), dispara a reentrancia no alvo.
     *      O ataque so arma uma vez: auto-desarma apos o primeiro disparo
     *      para evitar loop infinito caso a reentrancia seja erroneamente
     *      permitida.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (attackArmed && from == address(attackTarget)) {
            attackArmed = false;
            attackTarget.transfer(targetToken, attackTo, attackAmount);
        }
        super._update(from, to, value);
    }
}
