// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";

/**
 * @title UniswapV3PoolMock
 * @notice Mock minimo da {IUniswapV3Pool} usado em test/Treasury.buyback.test.ts
 *         para emular o oracle TWAP usado pelo {Treasury}.
 * @dev O TWAP que o {Treasury} computa e:
 *          arithMeanTick = (cum[older] - cum[newer]) / windowSecs
 *          price         = 1.0001^arithMeanTick (mas calculado externamente
 *                          para o teste — internamente usamos preco "fake"
 *                          em USD com 18 decimais armazenado direto).
 *      Para SIMPLIFICAR a auditoria do contrato sob teste e evitar replicar
 *      `OracleLibrary.getQuoteAtTick` no mock (codigo do Uniswap em 0.7.6),
 *      o mock retorna `tickCumulatives` ja construidos a partir de um
 *      `mockPriceUsd18` que o teste seta diretamente. O {Treasury}
 *      converte `tickCumulatives` -> tick -> preco em USD usando uma
 *      tabela TickMath simplificada quando rodando em ambiente de teste.
 *
 *      Para evitar dependencia do TickMath (codigo OZ-incompativel) no
 *      caminho real, o {Treasury} expoe um helper `_priceFromObservations`
 *      *abstrato*: em producao usa `OracleLibrary` (off-chain ou via
 *      adapter); em teste, o mock simplesmente faz observe retornar
 *      acumuladores que decodificam de volta para o `mockPriceUsd18` via
 *      uma derivacao fixa (preco linear em log).
 *
 *      A abordagem pragmatica usada aqui: o {Treasury} aceita um endereco
 *      de "twap adapter" — em producao apontaria para um wrapper que
 *      implementa OracleLibrary via call externo; em teste, este mock
 *      _tambem_ implementa o adapter (`peekTwapPrice`). Logo, em teste o
 *      pool e o adapter sao o mesmo mock. O contrato sob teste nao distingue.
 */
contract UniswapV3PoolMock is IUniswapV3Pool {
    /// @notice Preco em USD com 18 decimais (1e18 = $1.00). Lido pelo
    ///         adapter de teste via {peekTwapPrice}.
    uint256 public mockPriceUsd18;

    /// @notice Forcar `observe` a reverter (simulando `OLD` quando
    ///         cardinality insuficiente).
    bool public revertOnObserve;

    /// @notice Setado por testes para verificar que o {Treasury} pediu o
    ///         tamanho de janela esperado (30 min = 1800).
    uint32 public lastSecondsAgoQueried;

    /// @notice token0 do par (setavel; usado pelo {CreditPriceOracle} para
    ///         detectar a ordem CREDIT/USDC no constructor).
    address public mockToken0;

    /// @notice token1 do par (setavel).
    address public mockToken1;

    /// @notice Tick medio "verdadeiro" que {observe} codifica nos
    ///         acumuladores retornados: cum[i] = -mockMeanTick * secondsAgos[i],
    ///         de modo que (cum[newer] - cum[older]) / janela == mockMeanTick
    ///         para qualquer janela. Default 0 (comportamento identico ao
    ///         stub anterior).
    int24 public mockMeanTick;

    /// @notice Quando true, {observe} ignora {mockMeanTick} e retorna os
    ///         acumuladores crus setados via {setRawTickCumulatives} — usado
    ///         para testar arredondamento (delta nao-divisivel) e ticks fora
    ///         de range no {CreditPriceOracle}.
    bool public useRawTickCumulatives;

    /// @notice Acumulador cru do ponto mais antigo (secondsAgos[0]).
    int56 public rawTickCumulativeOlder;

    /// @notice Acumulador cru do ponto mais recente (secondsAgos[1]).
    int56 public rawTickCumulativeNewer;

    function setPrice(uint256 priceUsd18_) external {
        mockPriceUsd18 = priceUsd18_;
    }

    function setRevertOnObserve(bool flag) external {
        revertOnObserve = flag;
    }

    function setTokens(address token0_, address token1_) external {
        mockToken0 = token0_;
        mockToken1 = token1_;
    }

    function setMeanTick(int24 meanTick_) external {
        mockMeanTick = meanTick_;
    }

    function setRawTickCumulatives(int56 older_, int56 newer_) external {
        useRawTickCumulatives = true;
        rawTickCumulativeOlder = older_;
        rawTickCumulativeNewer = newer_;
    }

    function token0() external view returns (address) {
        return mockToken0;
    }

    function token1() external view returns (address) {
        return mockToken1;
    }

    /**
     * @notice Adapter de TWAP usado pelo {Treasury} em testes. NAO faz parte
     *         da ABI oficial Uniswap — e um shortcut explicitamente de teste.
     * @param secondsAgo Janela em segundos (testado: 1800).
     */
    function peekTwapPrice(uint32 secondsAgo) external returns (uint256) {
        lastSecondsAgoQueried = secondsAgo;
        if (revertOnObserve) {
            revert("OLD");
        }
        return mockPriceUsd18;
    }

    function observe(
        uint32[] calldata secondsAgos
    ) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128) {
        // Usado pelo {CreditPriceOracle} (adapter real). Quando o teste nao
        // seta nada, retorna acumuladores zerados (mockMeanTick = 0), mesmo
        // comportamento do stub anterior — testes legados nao sao afetados.
        if (revertOnObserve) {
            // String revert intencional: replica o erro real "OLD" da pool
            // Uniswap v3 (que usa require com string, nao custom error).
            // solhint-disable-next-line gas-custom-errors
            revert("OLD");
        }
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128 = new uint160[](secondsAgos.length);
        if (useRawTickCumulatives && secondsAgos.length == 2) {
            tickCumulatives[0] = rawTickCumulativeOlder;
            tickCumulatives[1] = rawTickCumulativeNewer;
            return (tickCumulatives, secondsPerLiquidityCumulativeX128);
        }
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            // cum(t) = meanTick * t com t = -secondsAgo (referencia t=0 no
            // "agora"): a diferenca entre dois pontos decodifica de volta
            // para mockMeanTick para qualquer janela.
            tickCumulatives[i] = -int56(mockMeanTick) * int56(uint56(secondsAgos[i]));
        }
    }

    function slot0()
        external
        pure
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (0, 0, 0, 0, 0, 0, true);
    }
}
