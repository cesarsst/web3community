// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  Treasury
 * @notice Cofre multi-ativo da DAO (remodel 2026-07-08). Recebe a fatia da
 *         fee do {FeeRouterV2} (40% da fee = 1% do GMV com os parametros
 *         default) e quaisquer outros ativos que a comunidade acumule.
 *         Unica via de saida e {GOVERNANCE_ROLE} — em producao, o
 *         TimelockController (toda saida passa por proposta aprovada).
 *
 * @dev - Sem oracle, sem POL, sem buyback interno: execucao de buyback de
 *        GOV e feita por governanca usando os fundos daqui, quando/como a
 *        DAO decidir. Mantem o cofre auditavel e sem superficie de ataque
 *        economica.
 *      - O lastro do {CreditPSM} NAO fica aqui — e segregado no proprio PSM
 *        por construcao.
 *      - `DEFAULT_ADMIN_ROLE` existe so pra gerir roles (padrao OZ); o
 *        deploy transfere ambos ao Timelock e o deployer renuncia.
 */
contract Treasury is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error EthTransferFailed(address to, uint256 amount);

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Unica role capaz de movimentar fundos. Producao: Timelock.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Saida de ERC20 aprovada por governanca.
    event TokenTransferred(address indexed token, address indexed to, uint256 amount);

    /// @notice Saida de ETH aprovada por governanca.
    event EthTransferred(address indexed to, uint256 amount);

    /// @notice ETH recebido.
    event EthReceived(address indexed from, uint256 amount);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(address admin) {
        if (admin == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Entradas
    // ------------------------------------------------------------------

    receive() external payable {
        emit EthReceived(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Saidas (so governanca)
    // ------------------------------------------------------------------

    /// @notice Transfere `amount` de `token` para `to`.
    function transfer(IERC20 token, address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        uint256 balance = token.balanceOf(address(this));
        if (amount > balance) {
            revert InsufficientBalance(amount, balance);
        }
        token.safeTransfer(to, amount);
        emit TokenTransferred(address(token), to, amount);
    }

    /// @notice Transfere `amount` de ETH para `to`.
    function transferETH(address payable to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (amount > address(this).balance) {
            revert InsufficientBalance(amount, address(this).balance);
        }
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) {
            revert EthTransferFailed(to, amount);
        }
        emit EthTransferred(to, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Saldo de um ERC20 no cofre.
    function balanceOf(IERC20 token) external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Saldo de ETH no cofre.
    function ethBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
