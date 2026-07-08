// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CreditToken} from "./CreditToken.sol";

/**
 * @title  CreditPSM
 * @notice Peg Stability Module: converte USDC <-> CREDIT a 1:1, sem taxa.
 *         Pilar do remodel 2026-07-08 ("payment rail"): CREDIT deixa de ser
 *         ativo especulativo/deflacionario e vira trilho de pagamento
 *         estavel. Todo CREDIT mintado por aqui e 100% lastreado no USDC
 *         retido neste contrato.
 *
 *         Fluxos:
 *          - {buy}:  usuario deposita USDC, recebe CREDIT 1:1 (mint).
 *          - {sell}: usuario devolve CREDIT (queimado), recebe USDC 1:1.
 *
 * @dev Invariantes:
 *      - I-PSM1 (lastro integral): `USDC.balanceOf(this) >= mintedOutstanding`
 *        (em unidades normalizadas). Nao existe NENHUMA funcao de saque do
 *        lastro — nem para governanca. Se a DAO quiser gastar, gasta da fee
 *        do FeeRouterV2, nunca daqui.
 *      - I-PSM2 (conversao exata): USDC tem 6 decimais, CREDIT 18. buy()
 *        converte `usdc * 1e12`; sell() exige multiplo de 1e12 (poeira
 *        abaixo de 1e-6 USDC reverte em vez de ser confiscada).
 *      - Requer MINTER_ROLE e BURNER_ROLE no CreditToken. O burn e sempre
 *        sobre saldo do proprio PSM (apos transferFrom do vendedor) — a role
 *        de burn nunca toca saldo de terceiros.
 */
contract CreditPSM is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAmount();
    error DustAmount(uint256 amount, uint256 granularity);
    error InsufficientBacking(uint256 requested, uint256 available);
    error InvalidDecimals(uint8 decimals);

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice CREDIT comprado (USDC entrou, CREDIT mintado).
    event Bought(address indexed user, uint256 usdcIn, uint256 creditOut);

    /// @notice CREDIT resgatado (CREDIT queimado, USDC saiu).
    event Sold(address indexed user, uint256 creditIn, uint256 usdcOut);

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @notice Token CREDIT (18 decimais).
    // solhint-disable-next-line var-name-mixedcase
    CreditToken public immutable CREDIT;

    /// @notice Stablecoin de lastro (assumida 6 decimais, ex. USDC).
    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable USDC;

    /// @notice Fator de conversao de decimais (1e12 para USDC 6 -> CREDIT 18).
    uint256 public immutable SCALE;

    /// @notice CREDIT em circulacao mintado por este PSM (18 decimais).
    uint256 public mintedOutstanding;

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(address credit, address usdc) {
        CREDIT = CreditToken(credit);
        USDC = IERC20(usdc);
        uint8 usdcDecimals = IERC20Metadata(usdc).decimals();
        if (usdcDecimals > 18) {
            revert InvalidDecimals(usdcDecimals);
        }
        SCALE = 10 ** (18 - usdcDecimals);
    }

    // ------------------------------------------------------------------
    // Mutations
    // ------------------------------------------------------------------

    /**
     * @notice Compra CREDIT com USDC a 1:1.
     * @param usdcAmount Quantidade de USDC (6 decimais).
     * @return creditOut CREDIT mintado (18 decimais).
     */
    function buy(uint256 usdcAmount) external nonReentrant returns (uint256 creditOut) {
        if (usdcAmount == 0) {
            revert ZeroAmount();
        }
        creditOut = usdcAmount * SCALE;

        USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);
        mintedOutstanding += creditOut;
        CREDIT.mint(msg.sender, creditOut, "psm:buy");

        emit Bought(msg.sender, usdcAmount, creditOut);
    }

    /**
     * @notice Resgata USDC devolvendo CREDIT a 1:1. O CREDIT e queimado.
     * @param creditAmount Quantidade de CREDIT (18 decimais, multiplo de SCALE).
     * @return usdcOut USDC devolvido (6 decimais).
     */
    function sell(uint256 creditAmount) external nonReentrant returns (uint256 usdcOut) {
        if (creditAmount == 0) {
            revert ZeroAmount();
        }
        if (creditAmount % SCALE != 0) {
            revert DustAmount(creditAmount, SCALE);
        }
        usdcOut = creditAmount / SCALE;

        uint256 available = USDC.balanceOf(address(this));
        if (usdcOut > available) {
            revert InsufficientBacking(usdcOut, available);
        }

        // Puxa o CREDIT pro PSM e queima do proprio saldo — BURNER_ROLE nunca
        // encosta em saldo de terceiro.
        IERC20(address(CREDIT)).safeTransferFrom(msg.sender, address(this), creditAmount);
        CREDIT.burnByRole(address(this), creditAmount, "psm:sell");

        // mintedOutstanding pode ficar aquem se alguem resgatar CREDIT vindo
        // de outra origem (genesis/legado) — clamp em zero mantem o contador
        // como "melhor estimativa conservadora" sem reverter resgates.
        mintedOutstanding = mintedOutstanding > creditAmount ? mintedOutstanding - creditAmount : 0;

        USDC.safeTransfer(msg.sender, usdcOut);

        emit Sold(msg.sender, creditAmount, usdcOut);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Lastro USDC atual (6 decimais).
    function backing() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @notice Lastro normalizado em 18 decimais (comparavel a mintedOutstanding).
    function backingNormalized() external view returns (uint256) {
        return USDC.balanceOf(address(this)) * SCALE;
    }
}
