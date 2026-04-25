// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from "../interfaces/INonfungiblePositionManager.sol";

/**
 * @title NonfungiblePositionManagerMock
 * @notice Mock minimo do Uniswap V3 NonfungiblePositionManager para testes
 *         da Fase 1.2 do pivot CLP (POL). Foco: comportamento contabil
 *         observavel — nao reproduz a math real de tick/sqrtPrice (nao e o
 *         escopo dos testes do Treasury).
 *
 * @dev Decisoes do mock:
 *      - {mint} cunha um tokenId monotonico (`_nextTokenId`), debita
 *        `amount0Desired`/`amount1Desired` do caller via `transferFrom`,
 *        e armazena uma "Position" com a liquidez nominal igual ao L
 *        agregado calculado de forma simplificada como
 *        `liquidity = amount0Desired + amount1Desired` (suficiente para
 *        os asserts dos testes; nao e a formula real do V3, mas e
 *        deterministica e auditavel).
 *      - {increaseLiquidity} segue a mesma regra somando aos campos.
 *      - {decreaseLiquidity} apenas debita liquidity e MOVE valores para o
 *        bookkeeping `tokensOwed0/1` proporcionalmente. Nao transfere
 *        tokens — espelha o comportamento real (decrease "registra" o
 *        debito; transferencia acontece em {collect}).
 *      - {collect} transfere `min(tokensOwed, amountMax)` para `recipient`
 *        e zera o owed correspondente.
 *      - Slippage: se `amount0Min`/`amount1Min` nao for satisfeito (via
 *        override de slippage configurado no mock), revert com a mesma
 *        mensagem usada pelo NPM canonico ("Price slippage check").
 *      - Fees acumulados: helper `accrueFees(tokenId, fee0, fee1)` permite
 *        ao teste injetar fees pendentes na posicao para exercitar
 *        {collect}/{collectPOLFees}.
 *      - Token transfers: `mint`/`increaseLiquidity` usam `transferFrom`
 *        do caller (espelha o NPM real, que exige approve previo).
 *        Os tokens recebidos ficam custodiados no proprio mock; em
 *        decrease/collect, o mock transfere de volta usando seu saldo
 *        proprio.
 */
contract NonfungiblePositionManagerMock is INonfungiblePositionManager {
    /// @dev Estrutura interna espelhando os campos retornados por {positions}.
    struct StoredPosition {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
        // amounts0/1 acumulados (principal "fisicamente" depositado no mock).
        // Servem para distribuir proporcionalmente em {decreaseLiquidity}.
        uint256 deposited0;
        uint256 deposited1;
    }

    /// @notice Proximo NFT id a ser cunhado em {mint}.
    uint256 private _nextTokenId = 1;

    /// @notice Estado por tokenId.
    mapping(uint256 => StoredPosition) public storedPositions;

    /// @notice Quando true, mint/increase/decrease revertem com a mensagem do
    ///         NPM real ("Price slippage check") ignorando os valores reais.
    bool public forceSlippageRevert;

    /// @notice Quando true, mint/increase devolvem `amount0/1` exatamente
    ///         iguais ao desired (sem ajuste). Default true — o mock nao
    ///         simula curva de preco real.
    bool public consumeAllDesired = true;

    /// @notice Forca o output de `amount0`/`amount1` em mint/increase.
    ///         Quando > 0, ignora `consumeAllDesired`. Util para simular
    ///         pool com price impact (consumo parcial dos desired).
    uint256 public overrideAmount0;
    uint256 public overrideAmount1;

    // ------------------------------------------------------------------
    // Test helpers (nao fazem parte da interface real)
    // ------------------------------------------------------------------

    /// @notice Acumula `fee0`/`fee1` nos tokensOwed da posicao. Pre-condicao:
    ///         o caller (teste) ja transferiu o saldo correspondente para
    ///         este mock. Util para exercitar {collect}.
    function accrueFees(uint256 tokenId, uint128 fee0, uint128 fee1) external {
        StoredPosition storage p = storedPositions[tokenId];
        require(p.liquidity > 0 || p.tokensOwed0 > 0 || p.tokensOwed1 > 0, "POSITION_UNKNOWN");
        p.tokensOwed0 += fee0;
        p.tokensOwed1 += fee1;
    }

    function setForceSlippageRevert(bool flag) external {
        forceSlippageRevert = flag;
    }

    function setConsumeAllDesired(bool flag) external {
        consumeAllDesired = flag;
    }

    function setOverrideAmounts(uint256 a0, uint256 a1) external {
        overrideAmount0 = a0;
        overrideAmount1 = a1;
    }

    // ------------------------------------------------------------------
    // INonfungiblePositionManager
    // ------------------------------------------------------------------

    function mint(
        MintParams calldata params
    ) external payable override returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        if (forceSlippageRevert) {
            revert("Price slippage check");
        }

        (amount0, amount1) = _resolveAmounts(params.amount0Desired, params.amount1Desired);

        if (amount0 < params.amount0Min || amount1 < params.amount1Min) {
            revert("Price slippage check");
        }

        // Pull dos tokens.
        if (amount0 > 0) {
            IERC20(params.token0).transferFrom(msg.sender, address(this), amount0);
        }
        if (amount1 > 0) {
            IERC20(params.token1).transferFrom(msg.sender, address(this), amount1);
        }

        liquidity = uint128(amount0 + amount1);
        tokenId = _nextTokenId++;
        storedPositions[tokenId] = StoredPosition({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0,
            deposited0: amount0,
            deposited1: amount1
        });
        // recipient e ignorado pelo mock (NFT nao e ERC-721 de verdade aqui),
        // mas a leitura do params.recipient garante que o teste forneca um
        // endereco coerente. Em producao o NPM real cunha ERC-721 para esse
        // address; como nao testamos ownership de NFT aqui, basta validar
        // que o Treasury passou `address(this)` (verificavel via decoded
        // calldata; nao instrumentado neste mock).
        return (tokenId, liquidity, amount0, amount1);
    }

    function increaseLiquidity(
        IncreaseLiquidityParams calldata params
    ) external payable override returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        if (forceSlippageRevert) {
            revert("Price slippage check");
        }

        StoredPosition storage p = storedPositions[params.tokenId];
        require(p.token0 != address(0), "POSITION_UNKNOWN");

        (amount0, amount1) = _resolveAmounts(params.amount0Desired, params.amount1Desired);

        if (amount0 < params.amount0Min || amount1 < params.amount1Min) {
            revert("Price slippage check");
        }

        if (amount0 > 0) {
            IERC20(p.token0).transferFrom(msg.sender, address(this), amount0);
        }
        if (amount1 > 0) {
            IERC20(p.token1).transferFrom(msg.sender, address(this), amount1);
        }

        liquidity = uint128(amount0 + amount1);
        p.liquidity += liquidity;
        p.deposited0 += amount0;
        p.deposited1 += amount1;
        return (liquidity, amount0, amount1);
    }

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external payable override returns (uint256 amount0, uint256 amount1) {
        if (forceSlippageRevert) {
            revert("Price slippage check");
        }

        StoredPosition storage p = storedPositions[params.tokenId];
        require(p.token0 != address(0), "POSITION_UNKNOWN");
        require(p.liquidity >= params.liquidity, "INSUFFICIENT_LIQUIDITY");

        // Distribui proporcionalmente do principal depositado.
        uint256 totalLiquidity = uint256(p.liquidity);
        amount0 = (uint256(p.deposited0) * params.liquidity) / totalLiquidity;
        amount1 = (uint256(p.deposited1) * params.liquidity) / totalLiquidity;

        if (amount0 < params.amount0Min || amount1 < params.amount1Min) {
            revert("Price slippage check");
        }

        // Atualiza estado.
        p.deposited0 -= amount0;
        p.deposited1 -= amount1;
        p.liquidity -= params.liquidity;
        p.tokensOwed0 += uint128(amount0);
        p.tokensOwed1 += uint128(amount1);

        return (amount0, amount1);
    }

    function collect(
        CollectParams calldata params
    ) external payable override returns (uint256 amount0, uint256 amount1) {
        StoredPosition storage p = storedPositions[params.tokenId];
        require(p.token0 != address(0), "POSITION_UNKNOWN");

        amount0 = p.tokensOwed0 < params.amount0Max ? p.tokensOwed0 : params.amount0Max;
        amount1 = p.tokensOwed1 < params.amount1Max ? p.tokensOwed1 : params.amount1Max;

        p.tokensOwed0 -= uint128(amount0);
        p.tokensOwed1 -= uint128(amount1);

        if (amount0 > 0) {
            IERC20(p.token0).transfer(params.recipient, amount0);
        }
        if (amount1 > 0) {
            IERC20(p.token1).transfer(params.recipient, amount1);
        }

        return (amount0, amount1);
    }

    function positions(
        uint256 tokenId
    )
        external
        view
        override
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        StoredPosition storage p = storedPositions[tokenId];
        return (
            0, // nonce
            address(0), // operator
            p.token0,
            p.token1,
            p.fee,
            p.tickLower,
            p.tickUpper,
            p.liquidity,
            0, // feeGrowthInside0LastX128 — irrelevante no mock
            0, // feeGrowthInside1LastX128
            p.tokensOwed0,
            p.tokensOwed1
        );
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _resolveAmounts(uint256 desired0, uint256 desired1) private view returns (uint256 a0, uint256 a1) {
        if (overrideAmount0 > 0 || overrideAmount1 > 0) {
            return (overrideAmount0, overrideAmount1);
        }
        if (consumeAllDesired) {
            return (desired0, desired1);
        }
        // Caso `consumeAllDesired = false` e sem override: simula consumo de
        // 50% dos desired (price impact ficticio).
        return (desired0 / 2, desired1 / 2);
    }
}
