// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DevFaucet
 * @notice Faucet de desenvolvimento para a REDE LOCAL (hardhat): entrega em
 *         um unico claim ETH (gas) + USDC mock para qualquer carteira,
 *         permitindo que contas novas transacionem imediatamente. CREDIT
 *         nao sai daqui de proposito: compra-se 1:1 no {CreditPSM} com o
 *         USDC do proprio faucet — assim todo CREDIT em circulacao continua
 *         100% lastreado.
 *
 * @dev NAO DEPLOYAR EM PRODUCAO — o faucet e deliberadamente aberto:
 *      - {claimFor} e permissionless: qualquer conta ja financiada (ex.: as
 *        contas unlocked do hardhat node) pode acionar o drip para uma
 *        carteira nova que ainda nao tem ETH pra pagar o proprio gas —
 *        resolve o bootstrap "sem ETH nao ha como clamar ETH". O cooldown e
 *        contado por DESTINATARIO, entao o permissionless nao amplia o
 *        orcamento drenavel por carteira.
 *      - Cada perna entrega `min(drip, saldo disponivel)` em vez de
 *        reverter: o faucet continua util enquanto sobrar qualquer ativo.
 *        Reverte apenas se as duas pernas resultarem em zero.
 *      - Financiamento: ETH via {receive}; USDC mock mintado direto pelo
 *        script de provisionamento.
 * @custom:security-contact security@web3community.example
 */
contract DevFaucet is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Immutables / storage
    // ------------------------------------------------------------------

    /// @notice USDC mock entregue pelo faucet.
    IERC20 public immutable USDC;

    /// @notice ETH (wei) por claim.
    uint256 public dripEth;

    /// @notice USDC (unidades minimas, 6 dec no mock) por claim.
    uint256 public dripUsdc;

    /// @notice Intervalo minimo entre claims do MESMO destinatario.
    uint256 public cooldown;

    /// @notice Ultimo claim por destinatario (unix).
    mapping(address => uint256) public lastClaimAt;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido a cada claim. Quantias refletem o que foi de fato
    ///         entregue (podem ser menores que o drip se o saldo acabou).
    event Claimed(address indexed to, address indexed caller, uint256 eth, uint256 usdc);

    /// @notice Emitido quando o owner atualiza os parametros de drip.
    event DripConfigured(uint256 dripEth, uint256 dripUsdc, uint256 cooldown);

    /// @notice Emitido quando o faucet recebe ETH.
    event Funded(address indexed from, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Cooldown do destinatario ainda ativo.
    error CooldownActive(address to, uint256 availableAt);

    /// @notice Faucet sem saldo em nenhuma das pernas.
    error FaucetEmpty();

    /// @notice Envio de ETH falhou.
    error EthTransferFailed(address to);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @param usdc_ Endereco do USDC mock.
     * @param owner_ Conta que ajusta drips/cooldown (deployer em dev).
     * @param dripEth_ ETH (wei) por claim.
     * @param dripUsdc_ USDC (unidades minimas) por claim.
     * @param cooldown_ Intervalo minimo entre claims por destinatario.
     */
    constructor(
        address usdc_,
        address owner_,
        uint256 dripEth_,
        uint256 dripUsdc_,
        uint256 cooldown_
    ) Ownable(owner_) {
        if (usdc_ == address(0)) {
            revert ZeroAddress();
        }
        USDC = IERC20(usdc_);
        dripEth = dripEth_;
        dripUsdc = dripUsdc_;
        cooldown = cooldown_;
        emit DripConfigured(dripEth_, dripUsdc_, cooldown_);
    }

    // ------------------------------------------------------------------
    // Claims
    // ------------------------------------------------------------------

    /// @notice Claim para o proprio chamador.
    function claim() external {
        claimFor(msg.sender);
    }

    /**
     * @notice Executa o drip para `to`. Permissionless (ver racional no
     *         NatSpec do contrato); cooldown contado por destinatario.
     * @param to Carteira que recebe ETH + USDC.
     */
    function claimFor(address to) public nonReentrant {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        uint256 availableAt = lastClaimAt[to] + cooldown;
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < availableAt) {
            revert CooldownActive(to, availableAt);
        }

        (uint256 ethOut, uint256 usdcOut) = previewClaim();
        if (ethOut == 0 && usdcOut == 0) {
            revert FaucetEmpty();
        }

        // solhint-disable-next-line not-rely-on-time
        lastClaimAt[to] = block.timestamp;

        if (usdcOut > 0) {
            USDC.safeTransfer(to, usdcOut);
        }
        if (ethOut > 0) {
            (bool ok, ) = to.call{value: ethOut}("");
            if (!ok) {
                revert EthTransferFailed(to);
            }
        }

        emit Claimed(to, msg.sender, ethOut, usdcOut);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Quantias que um claim entregaria AGORA — `min(drip, saldo)`
     *         por perna.
     */
    function previewClaim() public view returns (uint256 ethOut, uint256 usdcOut) {
        uint256 ethBal = address(this).balance;
        uint256 usdcBal = USDC.balanceOf(address(this));
        ethOut = dripEth < ethBal ? dripEth : ethBal;
        usdcOut = dripUsdc < usdcBal ? dripUsdc : usdcBal;
    }

    /// @notice `true` se `to` pode clamar agora.
    function canClaim(address to) external view returns (bool) {
        // solhint-disable-next-line not-rely-on-time
        return block.timestamp >= lastClaimAt[to] + cooldown;
    }

    /// @notice Instante unix a partir do qual `to` pode clamar de novo.
    function nextClaimAt(address to) external view returns (uint256) {
        return lastClaimAt[to] + cooldown;
    }

    // ------------------------------------------------------------------
    // Admin (dev)
    // ------------------------------------------------------------------

    /**
     * @notice Ajusta drips e cooldown.
     */
    function setDrip(uint256 dripEth_, uint256 dripUsdc_, uint256 cooldown_) external onlyOwner {
        dripEth = dripEth_;
        dripUsdc = dripUsdc_;
        cooldown = cooldown_;
        emit DripConfigured(dripEth_, dripUsdc_, cooldown_);
    }

    /// @notice Financia o faucet com ETH.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }
}
