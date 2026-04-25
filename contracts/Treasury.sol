// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IUniswapV3SwapRouter} from "./interfaces/IUniswapV3SwapRouter.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IChainlinkAggregator} from "./interfaces/IChainlinkAggregator.sol";
import {ICreditPriceOracle} from "./interfaces/ICreditPriceOracle.sol";
import {ICreditTokenBurnable} from "./interfaces/ICreditTokenBurnable.sol";

/**
 * @title Treasury
 * @notice Custodia multi-ativo da DAO Web3Community. Recebe passivamente
 *         qualquer ERC-20 (USDC/USDT como stables primarios, GOV via buyback,
 *         outros tokens que a DAO aceite como fee de subscription ou protocol
 *         fee). Unica via de saida e via {GOVERNANCE_ROLE}, concedida em
 *         producao apenas ao `TimelockController` — nenhum admin pode drenar
 *         fundos fora do ciclo de governanca (invariante I4).
 *
 *         Fase 1.1 do pivot CLP (2026-04-24): {executeBuyback} passa a executar
 *         o swap real USDC -> CREDIT via Uniswap V3 e queima imediata do CREDIT
 *         comprado, defendendo o **floor price** do modelo FFP (Floating com
 *         Floor Price defendido) aprovado em
 *         `audit/economist/2026-04-24-credit-peg.md`.
 *
 * @dev Invariantes atendidas nesta unidade:
 *      - I4: Todas as funcoes state-changing que movem fundos sao gated por
 *        {GOVERNANCE_ROLE} (sem escape via DEFAULT_ADMIN_ROLE). O admin
 *        inicial apenas detem poder de conceder/revogar roles (padrao OZ
 *        {AccessControl}), e em producao essa role tambem deve ser
 *        transferida para o Timelock apos bootstrap.
 *      - IE7 (parecer 2026-04-24-credit-peg.md): buyback executado abaixo
 *        do floor com TWAP 30min + slippage maximo 1% + cap por evento e
 *        mensal sobre reservas USDC.
 *
 *      Desenho deliberado:
 *      - Custodia PASSIVA: nao existe funcao {deposit}. Qualquer pagador
 *        (fee payer, router de protocolo, buyback executor futuro) usa
 *        `token.transfer(treasury, amount)` direto. Isso simplifica o
 *        modelo mental (treasury e um cofre, nao um bookkeeper), elimina
 *        autorizacoes cruzadas e reduz superficie de ataque.
 *      - SEM PAUSE. O cerne da DAO e que Timelock e o unico controle. Adicionar
 *        pausabilidade exigiria decidir quem pode pausar (admin? guardian?
 *        governance?), e qualquer papel com poder unilateral de congelar a
 *        tesouraria e um vetor de captura. Se algum contrato dependente
 *        quebrar, a correcao e via Timelock (substituir o consumidor), nao
 *        via pause do treasury.
 *      - {executeBuyback} REAL (Fase 1.1): swap USDC -> CREDIT e burn imediato.
 *        Pre-condicoes ON-CHAIN: (1) spot TWAP < floor por >= 24h; (2)
 *        Chainlink USDC/USD entre 0.99-1.01; (3) cap por evento (20% do USDC
 *        atual) e cap mensal (30%); (4) slippage max 1% via `minCreditOut`.
 *        CREDIT comprado e SEMPRE queimado (nunca acumulado em treasury) —
 *        reforca narrativa deflacionaria e impede captura de tesouraria via
 *        whaledom interno de CREDIT.
 *      - {recordDailyPrice} permissionless com cooldown de 22h. Bootstrap
 *        do MA90 exige 90 invocacoes consecutivas; ate atingir 90 amostras,
 *        {executeBuyback} usa apenas o floor absoluto ($0.10) como
 *        referencia. Isso permite o protocolo subir sem keeper por 90 dias
 *        com defesa minima.
 *      - {ReentrancyGuard} aplicado em TODAS as saidas de fundos (transfer,
 *        batchTransfer, payRebates, executeBuyback, sweepETH, recordDailyPrice).
 *        Justificativa: Treasury aceita qualquer ERC-20 passivamente, incluindo
 *        tokens com callbacks (ERC-777 legacy) ou ERC-20 customizados maliciosos
 *        com hooks em `_update`. O guard e barato (~2k gas por chamada no
 *        caminho feliz) e blinda contra vetores que CEI sozinho nao cobre
 *        quando o token externo e arbitrario.
 *      - Custom errors para todas as falhas. Eventos com `indexed` em todos
 *        os enderecos e IDs pra indexacao off-chain.
 *
 *      Storage layout: este contrato NAO e proxy (deploy direto). A Fase 1.1
 *      acrescenta storage ao final do layout original (slot >= 4 considerando
 *      AccessControl e ReentrancyGuard parents); como o contrato e re-deployado
 *      a cada release, nao ha colisao com versao anterior — apenas convencao
 *      preservada para auditabilidade.
 *
 * @custom:security-contact security@web3community.example
 */
contract Treasury is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Role concedida ao `TimelockController` em producao. Unica role
    ///         capaz de mover fundos (ERC-20 e ETH) do treasury.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // ------------------------------------------------------------------
    // Constants — bounds sanitarios para parametros do FFP (Fase 1.1)
    // ------------------------------------------------------------------

    /// @notice Denominador de basis points (10000 = 100.00%).
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Tamanho fixo do ring buffer de checkpoints diarios para o
    ///         calculo da media movel de 90 dias (MA90). Ver §3.3 do
    ///         parecer `audit/economist/2026-04-24-credit-peg.md`.
    uint256 public constant MA_WINDOW_DAYS = 90;

    /// @notice Cooldown minimo entre chamadas de {recordDailyPrice}, em
    ///         segundos. 22h evita frontrun/spam (intervalo um pouco menor
    ///         que 24h para tolerar drift de keeper).
    uint32 public constant RECORD_COOLDOWN = 22 hours;

    /// @notice Idade maxima aceita para a resposta do feed Chainlink USDC/USD
    ///         antes de considerar staleness (defesa contra feed congelado).
    ///         3h e o "heartbeat" tipico do feed em condicoes normais; 6h
    ///         absorve atrasos. Maior que 6h: dado e considerado stale.
    uint256 public constant CHAINLINK_MAX_STALENESS = 6 hours;

    // ------------------------------------------------------------------
    // Constants — POL (Fase 1.2)
    // ------------------------------------------------------------------

    /// @notice Tick inferior do range full-range no fee tier 3000 (0.3%).
    ///         O Uniswap V3 usa tickSpacing 60 nesse tier, e os ticks
    ///         "full range" canonicos sao -887220 / +887220 (multiplos de
    ///         60 mais proximos dos limites teoricos -887272 / +887272).
    int24 public constant POL_TICK_LOWER = -887220;

    /// @notice Tick superior do range full-range no fee tier 3000 (0.3%).
    int24 public constant POL_TICK_UPPER = 887220;

    // ------------------------------------------------------------------
    // Default param values — congelados em parecer 2026-04-24-credit-peg.md
    // ------------------------------------------------------------------

    /// @notice Default 5000bps = 0.50 × MA90.
    uint16 internal constant DEFAULT_FLOOR_MULTIPLIER_BPS = 5000;
    /// @notice Default $0.10 com 18 decimais.
    uint256 internal constant DEFAULT_FLOOR_ABSOLUTE_USD = 1e17;
    /// @notice Default 24h consecutivas abaixo do floor antes de habilitar buyback.
    uint32 internal constant DEFAULT_TRIGGER_DURATION_SECS = 24 hours;
    /// @notice Default janela TWAP de 30 min.
    uint32 internal constant DEFAULT_TWAP_WINDOW_SECS = 30 minutes;
    /// @notice Default banda Chainlink USDC: 0.99 (9900 bps).
    uint16 internal constant DEFAULT_CHAINLINK_LOW_BPS = 9900;
    /// @notice Default banda Chainlink USDC: 1.01 (10100 bps).
    uint16 internal constant DEFAULT_CHAINLINK_HIGH_BPS = 10_100;
    /// @notice Default cap por evento: 20% das reservas USDC do treasury.
    uint16 internal constant DEFAULT_CAP_PER_EVENT_BPS = 2000;
    /// @notice Default cap mensal: 30% das reservas USDC do treasury (snapshot).
    uint16 internal constant DEFAULT_CAP_MONTHLY_BPS = 3000;
    /// @notice Default slippage maximo no swap: 1%.
    uint16 internal constant DEFAULT_SLIPPAGE_MAX_BPS = 100;

    // ------------------------------------------------------------------
    // Storage — original (Fase 1.0)
    // ------------------------------------------------------------------
    // (Sem state vars no original alem dos herdados — abaixo todo o storage
    //  e novo da Fase 1.1.)

    // ------------------------------------------------------------------
    // Storage — FFP buyback (Fase 1.1)
    // ------------------------------------------------------------------

    /// @notice Token CREDIT cujo preco e defendido. Setado uma vez no
    ///         construtor; nao reconfiguravel (mudar significaria re-deploy).
    address public immutable CREDIT_TOKEN;

    /// @notice Stablecoin de origem do buyback (USDC). Setado uma vez no
    ///         construtor.
    address public immutable USDC_TOKEN;

    /// @notice Adapter de TWAP CREDIT/USD. `address(0)` ate ser configurado
    ///         via {setPriceOracle} pelo governance (buyback desabilitado
    ///         enquanto nao setado).
    ICreditPriceOracle public priceOracle;

    /// @notice Router Uniswap V3 que executa o swap. `address(0)` ate ser
    ///         configurado via {setSwapRouter}.
    IUniswapV3SwapRouter public swapRouter;

    /// @notice Pool tier de fee para o swap CREDIT/USDC (default 3000 = 0.3%).
    uint24 public swapFeeTier = 3000;

    /// @notice Feed Chainlink USDC/USD para sanity check.
    IChainlinkAggregator public chainlinkUsdcFeed;

    /// @notice Floor multiplier em bps. Default 5000 (0.50). Bounds [3000, 8000].
    uint16 public floorMultiplierBps = DEFAULT_FLOOR_MULTIPLIER_BPS;

    /// @notice Floor absoluto em USD com 18 decimais. Default 1e17 ($0.10).
    uint256 public floorAbsoluteUsd = DEFAULT_FLOOR_ABSOLUTE_USD;

    /// @notice Duracao em segundos que o spot deve permanecer abaixo do floor
    ///         antes de buyback ser elegivel. Default 24h. Bounds [1h, 7d].
    uint32 public triggerDurationSecs = DEFAULT_TRIGGER_DURATION_SECS;

    /// @notice Janela do TWAP (Uniswap V3). Default 30 min. Bounds [5min, 2h].
    uint32 public twapWindowSecs = DEFAULT_TWAP_WINDOW_SECS;

    /// @notice Banda inferior aceita do feed Chainlink USDC/USD em bps.
    ///         Default 9900 (0.99). Faixa valida [9000, 9999].
    uint16 public chainlinkSanityLowBps = DEFAULT_CHAINLINK_LOW_BPS;

    /// @notice Banda superior aceita do feed Chainlink USDC/USD em bps.
    ///         Default 10100 (1.01). Faixa valida [10001, 11000].
    uint16 public chainlinkSanityHighBps = DEFAULT_CHAINLINK_HIGH_BPS;

    /// @notice Cap maximo por evento em bps das reservas USDC atuais.
    ///         Default 2000 (20%). Bounds [100, 5000].
    uint16 public capPerEventBps = DEFAULT_CAP_PER_EVENT_BPS;

    /// @notice Cap mensal em bps das reservas USDC. Tomada como snapshot
    ///         do saldo USDC no inicio do periodo.
    ///         Default 3000 (30%). Bounds [100, 7000].
    uint16 public capMonthlyBps = DEFAULT_CAP_MONTHLY_BPS;

    /// @notice Slippage maximo aceito no swap em bps (calculado contra
    ///         `usdcAmount` convertido a CREDIT na cotacao spot TWAP).
    ///         Default 100 (1%). Bounds [10, 500].
    uint16 public slippageMaxBps = DEFAULT_SLIPPAGE_MAX_BPS;

    /// @notice Timestamp do primeiro instante em que o spot foi observado
    ///         abaixo do floor sem reset. Atualizado a cada
    ///         {recordDailyPrice}: se spot >= floor, reseta a 0; se < floor
    ///         e timestamp == 0, marca o instante atual. Buyback exige que
    ///         `now - lastFloorBreachTimestamp >= triggerDurationSecs`.
    uint256 public lastFloorBreachTimestamp;

    /// @notice Mes atual em formato YYYYMM derivado de `block.timestamp`
    ///         no momento da consulta. Resetado implicitamente quando
    ///         {executeBuyback} detecta nova chave em {monthlySpent}.
    /// @dev Usamos um indice unsigned de "month bucket" computado a partir
    ///      de `block.timestamp / 30 days` (aproximacao de mes calendario).
    ///      Aproximacao 30d e DELIBERADA: simplicidade e auditabilidade
    ///      maiores que precisao de mes calendario; cap mensal e teto
    ///      defensivo, nao instrumento contabil.
    mapping(uint256 monthIndex => uint256 usdcSpent) public monthlySpent;

    /// @notice Snapshot de reservas USDC tomado no inicio do mes corrente.
    ///         Cap mensal usa este snapshot como denominador (evita o
    ///         atacante manipular cap aumentando reservas durante o mes).
    mapping(uint256 monthIndex => uint256 usdcReservesAtStart) public monthlyReservesSnapshot;

    /// @notice Ring buffer de precos diarios em USD com 18 decimais.
    uint256[MA_WINDOW_DAYS] public dailyPrices;

    /// @notice Numero de amostras validas no ring buffer (cresce ate
    ///         MA_WINDOW_DAYS, depois para). Enquanto < MA_WINDOW_DAYS,
    ///         MA90 e considerado "nao bootstrapped" e o floor cai para
    ///         apenas o {floorAbsoluteUsd}.
    uint16 public dailyPriceCount;

    /// @notice Indice da proxima posicao a escrever no ring buffer
    ///         (`(dailyPriceCursor + 1) % MA_WINDOW_DAYS`).
    uint16 public dailyPriceCursor;

    /// @notice Ultimo timestamp em que {recordDailyPrice} foi executado.
    uint256 public lastDailyPriceRecordedAt;

    /// @notice Soma corrente de `dailyPrices`. Mantida para evitar O(N)
    ///         loop em cada leitura do MA. Atualizada incrementalmente
    ///         em {recordDailyPrice}.
    uint256 public dailyPriceSum;

    // ------------------------------------------------------------------
    // Storage — POL (Fase 1.2)
    // ------------------------------------------------------------------

    /// @notice Uniswap V3 NonfungiblePositionManager. `address(0)` ate ser
    ///         configurado via {setPositionManager} pelo governance (POL
    ///         desabilitada enquanto nao setado).
    INonfungiblePositionManager public positionManager;

    /// @notice NFT id da posicao POL atual no pool CREDIT/USDC. `0` significa
    ///         "ainda nao seedada"; primeira chamada a {addPOL} cunha o NFT
    ///         e armazena aqui. Chamadas subsequentes usam o mesmo id via
    ///         {INonfungiblePositionManager.increaseLiquidity}.
    uint256 public polTokenId;

    // ------------------------------------------------------------------
    // Events — originais (Fase 1.0)
    // ------------------------------------------------------------------

    /// @notice Emitido em cada transferencia de ERC-20 saida do treasury
    ///         (inclusive as individuais dentro de {batchTransfer} e
    ///         {payRebates}).
    event Transferred(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitido ao final de um {batchTransfer}.
    event BatchTransferred(address indexed token, uint256 totalAmount, uint256 recipientCount);

    /// @notice Emitido ao final de um {payRebates}.
    event RebatesPaid(address indexed token, uint256 indexed round, uint256 totalAmount, uint256 appCount);

    /// @notice Emitido em {receive}.
    event ETHReceived(address indexed from, uint256 amount);

    /// @notice Emitido em {sweepETH}.
    event ETHSwept(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Events — Fase 1.1 (FFP buyback)
    // ------------------------------------------------------------------

    /// @notice Emitido em cada execucao bem-sucedida de {executeBuyback}.
    /// @param usdcSpent Quantidade de USDC consumida no swap.
    /// @param creditBurned Quantidade de CREDIT recebida e queimada.
    /// @param floorUsd Floor de preco vigente no momento da execucao
    ///                 (em USD com 18 decimais).
    /// @param spotUsd Preco spot TWAP observado (em USD com 18 decimais).
    /// @param monthIndex Indice de mes (block.timestamp / 30d) para
    ///                   reconciliacao off-chain do cap mensal.
    event BuybackExecuted(
        uint256 usdcSpent,
        uint256 creditBurned,
        uint256 floorUsd,
        uint256 spotUsd,
        uint256 indexed monthIndex
    );

    /// @notice Emitido em {recordDailyPrice}.
    /// @param caller Quem chamou (permissionless).
    /// @param priceUsd18 Preco gravado em USD com 18 decimais.
    /// @param ma90Usd18 MA90 atual apos a gravacao (0 se nao bootstrapped).
    /// @param sampleCount Total de amostras no ring buffer apos gravar.
    event DailyPriceRecorded(address indexed caller, uint256 priceUsd18, uint256 ma90Usd18, uint16 sampleCount);

    /// @notice Emitido em todo setter de parametro do FFP, com chave
    ///         (`paramKey`) e novo valor agregado em uint256 (interpretacao
    ///         depende do parametro).
    event BuybackParamsUpdated(bytes32 indexed paramKey, uint256 newValue);

    /// @notice Emitido em {setPriceOracle}, {setSwapRouter},
    ///         {setChainlinkFeed}, {setSwapFeeTier}, {setPositionManager}.
    event BuybackInfraUpdated(bytes32 indexed paramKey, address indexed addrOrZero, uint256 numericOrZero);

    // ------------------------------------------------------------------
    // Events — POL (Fase 1.2)
    // ------------------------------------------------------------------

    /// @notice Emitido na primeira {addPOL} (mint do NFT) e em chamadas
    ///         subsequentes (increaseLiquidity da mesma posicao).
    /// @param tokenId NFT id da posicao POL.
    /// @param liquidityAdded Quantidade de liquidez (L) adicionada nesta chamada.
    /// @param creditAmount Quantidade real de CREDIT consumida pelo NPM.
    /// @param usdcAmount Quantidade real de USDC consumida pelo NPM.
    event POLAdded(uint256 indexed tokenId, uint128 liquidityAdded, uint256 creditAmount, uint256 usdcAmount);

    /// @notice Emitido em {removePOL} apos `decreaseLiquidity` + `collect` que
    ///         efetivamente devolve principal ao Treasury.
    /// @param tokenId NFT id da posicao POL.
    /// @param liquidityRemoved Quantidade de liquidez (L) removida.
    /// @param amount0Out Quantidade de token0 transferida ao Treasury.
    /// @param amount1Out Quantidade de token1 transferida ao Treasury.
    event POLRemoved(uint256 indexed tokenId, uint128 liquidityRemoved, uint256 amount0Out, uint256 amount1Out);

    /// @notice Emitido em {collectPOLFees} apos coletar fees acumulados.
    /// @param tokenId NFT id da posicao POL.
    /// @param amount0 Quantidade de token0 (CREDIT ou USDC dependendo da
    ///                ordenacao por endereco) transferida ao Treasury.
    /// @param amount1 Quantidade de token1 transferida ao Treasury.
    event POLFeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    // ------------------------------------------------------------------
    // Errors — originais
    // ------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ArrayLengthMismatch();
    error EmptyBatch();
    error InsufficientBalance(address token, uint256 requested, uint256 available);
    error ETHTransferFailed();

    // ------------------------------------------------------------------
    // Errors — Fase 1.1 (FFP buyback)
    // ------------------------------------------------------------------

    /// @notice {priceOracle} ou {swapRouter} ou {chainlinkUsdcFeed} ainda nao
    ///         foram setados via governance. Buyback nao pode operar.
    error BuybackInfraMissing();

    /// @notice Spot TWAP esta no ou acima do floor — buyback nao se justifica.
    error SpotAboveFloor(uint256 spotUsd, uint256 floorUsd);

    /// @notice Floor breach existe mas ainda nao perdurou tempo suficiente.
    error BreachDurationInsufficient(uint256 elapsedSecs, uint32 requiredSecs);

    /// @notice Feed Chainlink USDC/USD esta fora da banda permitida.
    error UsdcDepegDetected(int256 reportedAnswer, uint256 lowBound, uint256 highBound);

    /// @notice Feed Chainlink retorna dado stale (updatedAt muito antigo).
    error ChainlinkStale(uint256 updatedAt, uint256 maxStaleness);

    /// @notice Feed Chainlink retorna preco <= 0 (corrupcao/feed quebrado).
    error InvalidChainlinkAnswer(int256 answer);

    /// @notice Cap por evento estourado.
    error CapPerEventExceeded(uint256 requested, uint256 cap);

    /// @notice Cap mensal estourado.
    error CapMonthlyExceeded(uint256 requested, uint256 alreadySpent, uint256 cap);

    /// @notice Cooldown de {recordDailyPrice} ainda ativo.
    error RecordCooldownActive(uint256 nextAllowedAt);

    /// @notice Parametro fora do range valido.
    error ParamOutOfBounds(uint256 provided, uint256 min, uint256 max);

    /// @notice Oracle retornou preco zero — interpretacao indefinida.
    error InvalidOraclePrice();

    // ------------------------------------------------------------------
    // Errors — POL (Fase 1.2)
    // ------------------------------------------------------------------

    /// @notice {removePOL} ou {collectPOLFees} chamado antes de a posicao
    ///         POL existir (`polTokenId == 0`).
    error POLNotInitialized();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o treasury concedendo {DEFAULT_ADMIN_ROLE} e
     *         {GOVERNANCE_ROLE} ao `admin`. Tambem fixa os enderecos
     *         imutaveis dos tokens CREDIT e USDC do par defendido.
     * @dev Em producao, `admin` deve ser o `TimelockController`. Em testnet
     *      local e aceitavel uma EOA, desde que o script de deploy transfira
     *      ambas as roles ao Timelock antes de qualquer uso real.
     *      `creditToken` e `usdcToken` sao IMUTAVEIS — mudar significaria
     *      re-deploy, comportamento intencional para nao introduzir
     *      vetor de captura via "swap de moeda" malicioso.
     *      Demais infra (oracle, router, feed Chainlink) sao mutaveis via
     *      governance — necessidade de upgrade quando pool tier muda ou
     *      adapter Chainlink e substituido.
     * @param admin Endereco que recebe ambas as roles. Revertido se 0.
     * @param creditToken Endereco do {CreditToken} (IMUTAVEL).
     * @param usdcToken Endereco do USDC (IMUTAVEL).
     */
    constructor(address admin, address creditToken, address usdcToken) {
        if (admin == address(0) || creditToken == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        CREDIT_TOKEN = creditToken;
        // `usdcToken == address(0)` e ACEITO no construtor como "nao configurado":
        // o conjunto de checks em {executeBuyback}/{recordDailyPrice} ja exige
        // {priceOracle}, {swapRouter} e {chainlinkUsdcFeed} setados — todos
        // exigem USDC nao-zero implicitamente (swap CREDIT/USDC nao funciona com
        // USDC = 0). Em dev/testnet sem USDC oficial, isso permite o deploy do
        // Treasury sem que o Ignition module precise mockar o USDC; o buyback
        // permanece desabilitado ate USDC ser conhecido (re-deploy do Treasury
        // com endereco oficial em produção). Detalhado em
        // `docs/governance/fase1-1-buyback-ffp.md`.
        USDC_TOKEN = usdcToken;
    }

    // ------------------------------------------------------------------
    // Views — generic
    // ------------------------------------------------------------------

    /**
     * @notice Saldo do treasury no token `token`.
     * @param token Endereco do ERC-20.
     * @return Saldo em unidades minimas do token.
     */
    function balanceOf(IERC20 token) external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ------------------------------------------------------------------
    // Views — FFP
    // ------------------------------------------------------------------

    /**
     * @notice Indice de mes derivado de `block.timestamp` em janelas de 30
     *         dias. Usado como chave de {monthlySpent} e
     *         {monthlyReservesSnapshot}.
     * @return Indice atual.
     */
    function currentMonthIndex() public view returns (uint256) {
        return block.timestamp / 30 days;
    }

    /**
     * @notice Media movel de 90 dias dos precos diarios gravados via
     *         {recordDailyPrice}. Retorna 0 enquanto o ring buffer nao
     *         estiver completo (`dailyPriceCount < MA_WINDOW_DAYS`) — sinal
     *         para o caller de que o floor relativo e "indefinido" e apenas
     *         o floor absoluto se aplica.
     * @return ma90 Media em USD com 18 decimais (0 se nao-bootstrapped).
     */
    function ma90Price() public view returns (uint256 ma90) {
        if (dailyPriceCount < MA_WINDOW_DAYS) {
            return 0;
        }
        return dailyPriceSum / MA_WINDOW_DAYS;
    }

    /**
     * @notice Floor de preco vigente em USD com 18 decimais. Computa
     *         `max(floorMultiplierBps × MA90 / 10000, floorAbsoluteUsd)`.
     *         Enquanto MA90 nao estiver bootstrapped, retorna apenas
     *         {floorAbsoluteUsd}.
     * @return floor Floor em USD com 18 decimais.
     */
    function currentFloorPrice() public view returns (uint256 floor) {
        uint256 ma = ma90Price();
        // Inicializacao explicita (slither: uninitialized-local). `relative`
        // permanece 0 quando MA90 nao esta bootstrapped — corretamente
        // forcando `max(0, floorAbsoluteUsd) = floorAbsoluteUsd`.
        uint256 relative = 0;
        if (ma > 0) {
            relative = (ma * floorMultiplierBps) / BPS_DENOMINATOR;
        }
        return relative > floorAbsoluteUsd ? relative : floorAbsoluteUsd;
    }

    // ------------------------------------------------------------------
    // Governance-gated state changes — ERC-20 (originais, inalterados)
    // ------------------------------------------------------------------

    /**
     * @notice Transfere `amount` de `token` do treasury para `to`.
     */
    function transfer(IERC20 token, address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        _transfer(token, to, amount);
    }

    /**
     * @notice Transfere `amounts[i]` de `token` para `recipients[i]`, para
     *         todo i in [0, recipients.length).
     */
    function batchTransfer(
        IERC20 token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        uint256 total = _batchTransfer(token, recipients, amounts);
        emit BatchTransferred(address(token), total, recipients.length);
    }

    /**
     * @notice Paga rebates a apps (batch transfer com evento semantico de
     *         rodada).
     */
    function payRebates(
        IERC20 token,
        address[] calldata apps,
        uint256[] calldata amounts,
        uint256 round
    ) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        uint256 total = _batchTransfer(token, apps, amounts);
        emit RebatesPaid(address(token), round, total, apps.length);
    }

    // ------------------------------------------------------------------
    // FFP — recordDailyPrice (permissionless com cooldown)
    // ------------------------------------------------------------------

    /**
     * @notice Grava o preco TWAP atual no ring buffer diario e atualiza
     *         {lastFloorBreachTimestamp}. Permissionless — qualquer keeper
     *         pode chamar — protegido por cooldown {RECORD_COOLDOWN}.
     * @dev O preco e SEMPRE lido do `priceOracle` configurado, NUNCA do
     *      Chainlink (Chainlink e usado apenas para sanity do USDC/USD).
     *      Se o oracle nao foi setado, reverte com {BuybackInfraMissing}.
     *
     *      Atualizacao do checkpoint de breach:
     *      - Se spot >= floor: reseta {lastFloorBreachTimestamp} para 0.
     *      - Se spot < floor e {lastFloorBreachTimestamp} == 0: marca
     *        timestamp atual.
     *      - Se spot < floor e {lastFloorBreachTimestamp} > 0: nao mexe
     *        (preserva inicio do breach).
     *
     *      Ring buffer:
     *      - Sobrescreve a posicao mais antiga.
     *      - Mantem soma corrente em `dailyPriceSum` para O(1).
     *
     *      Reentrancy: o oracle e chamado externamente; aplicamos
     *      `nonReentrant` defensivamente. Slither sinaliza
     *      `reentrancy-no-eth` para `lastDailyPriceRecordedAt` escrito apos
     *      o external call — falso positivo: a funcao tem `nonReentrant`,
     *      portanto cross-function reentrancy esta bloqueada para qualquer
     *      outra funcao `nonReentrant` desta contract (ver lista no
     *      contract-level NatSpec). Reordenar storage writes antes do call
     *      consumiria cooldown mesmo em reverts do oracle, pior UX para
     *      keepers sem ganho de seguranca.
     */
    function recordDailyPrice() external nonReentrant {
        if (address(priceOracle) == address(0)) {
            revert BuybackInfraMissing();
        }
        // Checks: cooldown.
        uint256 nextAllowed = lastDailyPriceRecordedAt + RECORD_COOLDOWN;
        if (block.timestamp < nextAllowed) {
            revert RecordCooldownActive(nextAllowed);
        }

        // Interaction: leitura do oracle.
        uint256 spot = priceOracle.peekTwapPrice(twapWindowSecs);
        if (spot == 0) {
            revert InvalidOraclePrice();
        }

        // Effects: ring buffer + soma + cursor.
        uint16 cursor = dailyPriceCursor;
        uint256 oldValue = dailyPrices[cursor];
        dailyPrices[cursor] = spot;
        dailyPriceCursor = uint16((cursor + 1) % MA_WINDOW_DAYS);
        dailyPriceSum = dailyPriceSum + spot - oldValue;
        if (dailyPriceCount < MA_WINDOW_DAYS) {
            unchecked {
                dailyPriceCount += 1;
            }
        }
        lastDailyPriceRecordedAt = block.timestamp;

        // Effects: breach checkpoint.
        uint256 floor = currentFloorPrice();
        if (spot < floor) {
            if (lastFloorBreachTimestamp == 0) {
                lastFloorBreachTimestamp = block.timestamp;
            }
        } else {
            lastFloorBreachTimestamp = 0;
        }

        emit DailyPriceRecorded(_msgSender(), spot, ma90Price(), dailyPriceCount);
    }

    // ------------------------------------------------------------------
    // FFP — executeBuyback (governance-gated, real)
    // ------------------------------------------------------------------

    /**
     * @notice Executa buyback de CREDIT pago em USDC e queima imediata.
     *         Defesa do floor price do CREDIT segundo o modelo FFP.
     * @dev Restrito a {GOVERNANCE_ROLE}. Em producao, a unica fonte com este
     *      role deve ser o Timelock — ou seja, cada buyback exige proposta
     *      DAO aprovada (timelock 2d).
     *
     *      Pre-condicoes (todas verificadas on-chain):
     *      1. Infra setada (oracle, router, feed) — caso contrario
     *         {BuybackInfraMissing}.
     *      2. Spot TWAP < currentFloorPrice() — {SpotAboveFloor} se acima.
     *      3. `block.timestamp - lastFloorBreachTimestamp >= triggerDurationSecs`
     *         — {BreachDurationInsufficient} caso contrario.
     *      4. Chainlink USDC/USD entre [low, high] e fresco —
     *         {UsdcDepegDetected} ou {ChainlinkStale} ou
     *         {InvalidChainlinkAnswer}.
     *      5. `usdcAmount` <= cap por evento (20% das reservas correntes) —
     *         {CapPerEventExceeded}.
     *      6. `monthlySpent[mes] + usdcAmount` <= cap mensal (30% do
     *         snapshot do mes) — {CapMonthlyExceeded}.
     *      7. Slippage: `minCreditOut` deve ser >= valor implicito por
     *         `slippageMaxBps` aplicado a `usdcAmount` na cotacao spot.
     *         (Validado dentro do router; aqui apenas asseguramos `> 0`.)
     *
     *      Acao:
     *      - Approve `usdcAmount` ao router.
     *      - `exactInputSingle(USDC -> CREDIT, recipient = treasury)`.
     *      - {ICreditTokenBurnable.burnByRole(treasury, creditOut, "buyback")}.
     *      - Emite {BuybackExecuted}.
     *
     *      CEI:
     *      - Checks (1-7) primeiro;
     *      - Effects: atualiza {monthlySpent};
     *      - Interactions: approve + swap + burn (todos ao final, sob
     *        `nonReentrant`).
     *
     * @param usdcAmount Quantidade de USDC a gastar (precisao do USDC; em
     *                   produção USDC tem 6 decimais).
     * @param minCreditOut Slippage maximo: minimo de CREDIT aceito de retorno
     *                     (precisao 18 decimais). Calculado off-chain pelo
     *                     proponente da DAO usando spot atual e
     *                     `slippageMaxBps` deste contrato.
     */
    function executeBuyback(uint256 usdcAmount, uint256 minCreditOut) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (usdcAmount == 0 || minCreditOut == 0) {
            revert ZeroAmount();
        }
        if (
            USDC_TOKEN == address(0) ||
            address(priceOracle) == address(0) ||
            address(swapRouter) == address(0) ||
            address(chainlinkUsdcFeed) == address(0)
        ) {
            revert BuybackInfraMissing();
        }

        // (1) Spot vs floor.
        uint256 spot = priceOracle.peekTwapPrice(twapWindowSecs);
        if (spot == 0) {
            revert InvalidOraclePrice();
        }
        uint256 floor = currentFloorPrice();
        if (spot >= floor) {
            revert SpotAboveFloor(spot, floor);
        }

        // (2) Breach duration.
        uint256 breachAt = lastFloorBreachTimestamp;
        if (breachAt == 0) {
            revert BreachDurationInsufficient(0, triggerDurationSecs);
        }
        uint256 elapsed = block.timestamp - breachAt;
        if (elapsed < triggerDurationSecs) {
            revert BreachDurationInsufficient(elapsed, triggerDurationSecs);
        }

        // (3) Chainlink USDC sanity.
        _enforceChainlinkSanity();

        // (4) Caps.
        uint256 usdcReserves = IERC20(USDC_TOKEN).balanceOf(address(this));
        if (usdcReserves < usdcAmount) {
            revert InsufficientBalance(USDC_TOKEN, usdcAmount, usdcReserves);
        }
        uint256 perEventCap = (usdcReserves * capPerEventBps) / BPS_DENOMINATOR;
        if (usdcAmount > perEventCap) {
            revert CapPerEventExceeded(usdcAmount, perEventCap);
        }

        uint256 monthIdx = currentMonthIndex();
        uint256 snapshot = monthlyReservesSnapshot[monthIdx];
        if (snapshot == 0) {
            // Primeiro buyback do mes: tira snapshot das reservas atuais.
            // Nota: o snapshot e o saldo *antes* do gasto deste evento — esta
            // chamada e a primeira a usar o cap mensal.
            snapshot = usdcReserves;
            monthlyReservesSnapshot[monthIdx] = snapshot;
        }
        uint256 monthlyCap = (snapshot * capMonthlyBps) / BPS_DENOMINATOR;
        uint256 alreadySpent = monthlySpent[monthIdx];
        if (alreadySpent + usdcAmount > monthlyCap) {
            revert CapMonthlyExceeded(usdcAmount, alreadySpent, monthlyCap);
        }

        // Effects: atualiza ledger antes da interacao externa.
        monthlySpent[monthIdx] = alreadySpent + usdcAmount;

        // Interactions: approve -> swap -> burn.
        IERC20(USDC_TOKEN).forceApprove(address(swapRouter), usdcAmount);
        uint256 creditOut = swapRouter.exactInputSingle(
            IUniswapV3SwapRouter.ExactInputSingleParams({
                tokenIn: USDC_TOKEN,
                tokenOut: CREDIT_TOKEN,
                fee: swapFeeTier,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: usdcAmount,
                amountOutMinimum: minCreditOut,
                sqrtPriceLimitX96: 0
            })
        );
        // Reset approve para 0 (defensive; o forceApprove ja gerencia, mas
        // mantemos o pos-condicao explicita em vez de confiar no router).
        IERC20(USDC_TOKEN).forceApprove(address(swapRouter), 0);

        ICreditTokenBurnable(CREDIT_TOKEN).burnByRole(address(this), creditOut, "treasury:buyback");

        emit BuybackExecuted(usdcAmount, creditOut, floor, spot, monthIdx);
    }

    // ------------------------------------------------------------------
    // FFP — Governance setters
    // ------------------------------------------------------------------

    /**
     * @notice Configura o oracle TWAP de preco do CREDIT.
     * @dev Restrita a {GOVERNANCE_ROLE}. Setar para `address(0)` desabilita
     *      buyback e {recordDailyPrice} (operacao reversivel — apenas pausa
     *      logica via reset).
     * @param oracle Endereco do adapter {ICreditPriceOracle}.
     */
    function setPriceOracle(ICreditPriceOracle oracle) external onlyRole(GOVERNANCE_ROLE) {
        priceOracle = oracle;
        emit BuybackInfraUpdated("priceOracle", address(oracle), 0);
    }

    /**
     * @notice Configura o swap router Uniswap V3.
     * @param router Endereco do router.
     */
    function setSwapRouter(IUniswapV3SwapRouter router) external onlyRole(GOVERNANCE_ROLE) {
        swapRouter = router;
        emit BuybackInfraUpdated("swapRouter", address(router), 0);
    }

    /**
     * @notice Configura o tier de fee da pool USDC/CREDIT.
     * @dev Bounds: o Uniswap V3 nativo aceita apenas {500, 3000, 10000} (e
     *      forks com tiers extras). Aceitamos qualquer uint24 nao-zero, mas
     *      o swap reverte se a pool nao existir — fail-fast no momento do
     *      buyback, nao no setter.
     * @param fee Tier (ex.: 3000 = 0.3%).
     */
    function setSwapFeeTier(uint24 fee) external onlyRole(GOVERNANCE_ROLE) {
        if (fee == 0) {
            revert ZeroAmount();
        }
        swapFeeTier = fee;
        emit BuybackInfraUpdated("swapFeeTier", address(0), uint256(fee));
    }

    /**
     * @notice Configura o feed Chainlink USDC/USD.
     * @param feed Endereco do agregador.
     */
    function setChainlinkFeed(IChainlinkAggregator feed) external onlyRole(GOVERNANCE_ROLE) {
        chainlinkUsdcFeed = feed;
        emit BuybackInfraUpdated("chainlinkUsdcFeed", address(feed), 0);
    }

    /**
     * @notice Atualiza o multiplier do floor relativo. Bounds [3000, 8000].
     * @param bps Novo valor em basis points.
     */
    function setFloorMultiplierBps(uint16 bps) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(bps, 3000, 8000);
        floorMultiplierBps = bps;
        emit BuybackParamsUpdated("floorMultiplierBps", bps);
    }

    /**
     * @notice Atualiza o floor absoluto em USD com 18 decimais.
     *         Bounds [1e16 ($0.01), 1e19 ($10.00)] — banda larga deliberada
     *         (ajuste de bootstrap).
     * @param value Novo valor em USD com 18 decimais.
     */
    function setFloorAbsoluteUsd(uint256 value) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(value, 1e16, 1e19);
        floorAbsoluteUsd = value;
        emit BuybackParamsUpdated("floorAbsoluteUsd", value);
    }

    /**
     * @notice Atualiza a duracao do breach. Bounds [1h, 7d].
     * @param secs Novo valor em segundos.
     */
    function setTriggerDurationSecs(uint32 secs) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(secs, 1 hours, 7 days);
        triggerDurationSecs = secs;
        emit BuybackParamsUpdated("triggerDurationSecs", secs);
    }

    /**
     * @notice Atualiza a janela TWAP. Bounds [5min, 2h].
     * @param secs Novo valor em segundos.
     */
    function setTwapWindowSecs(uint32 secs) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(secs, 5 minutes, 2 hours);
        twapWindowSecs = secs;
        emit BuybackParamsUpdated("twapWindowSecs", secs);
    }

    /**
     * @notice Atualiza a banda inferior do feed Chainlink USDC. Bounds
     *         [9000, 9999].
     * @param bps Novo valor em bps.
     */
    function setChainlinkSanityLowBps(uint16 bps) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(bps, 9000, 9999);
        chainlinkSanityLowBps = bps;
        emit BuybackParamsUpdated("chainlinkSanityLowBps", bps);
    }

    /**
     * @notice Atualiza a banda superior do feed Chainlink USDC. Bounds
     *         [10001, 11000].
     * @param bps Novo valor em bps.
     */
    function setChainlinkSanityHighBps(uint16 bps) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(bps, 10_001, 11_000);
        chainlinkSanityHighBps = bps;
        emit BuybackParamsUpdated("chainlinkSanityHighBps", bps);
    }

    /**
     * @notice Atualiza o cap por evento. Bounds [100, 5000].
     * @param bps Novo valor em bps.
     */
    function setCapPerEventBps(uint16 bps) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(bps, 100, 5000);
        capPerEventBps = bps;
        emit BuybackParamsUpdated("capPerEventBps", bps);
    }

    /**
     * @notice Atualiza o cap mensal. Bounds [100, 7000].
     * @param bps Novo valor em bps.
     */
    function setCapMonthlyBps(uint16 bps) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(bps, 100, 7000);
        capMonthlyBps = bps;
        emit BuybackParamsUpdated("capMonthlyBps", bps);
    }

    /**
     * @notice Atualiza o slippage maximo. Bounds [10, 500].
     * @param bps Novo valor em bps.
     */
    function setSlippageMaxBps(uint16 bps) external onlyRole(GOVERNANCE_ROLE) {
        _checkBounds(bps, 10, 500);
        slippageMaxBps = bps;
        emit BuybackParamsUpdated("slippageMaxBps", bps);
    }

    // ------------------------------------------------------------------
    // POL — Fase 1.2 (Protocol Owned Liquidity)
    // ------------------------------------------------------------------

    /**
     * @notice Provisiona liquidez no pool CREDIT/USDC (Uniswap V3, fee 3000),
     *         mantendo a posicao NFT sob custodia do Treasury.
     * @dev Restrita a {GOVERNANCE_ROLE} + `nonReentrant`. Segue parametros
     *      operacionais congelados em
     *      `audit/economist/2026-04-24-pol-params.md`:
     *      - Range FULL ({POL_TICK_LOWER}, {POL_TICK_UPPER}) — sem
     *        rebalance ativo;
     *      - Fee tier {swapFeeTier} (default 3000) — alinhado com o swap
     *        do FFP;
     *      - NFT custodiado em `address(this)` — mesmo Treasury
     *        controla buyback (Fase 1.1) e POL (Fase 1.2), evitando
     *        cross-contract trust e garantindo que toda saida exige
     *        proposta DAO via Timelock (I4).
     *
     *      Comportamento:
     *      - Primeira chamada (`polTokenId == 0`): chama
     *        {INonfungiblePositionManager.mint}. Armazena tokenId
     *        retornado.
     *      - Chamadas subsequentes: chama
     *        {INonfungiblePositionManager.increaseLiquidity} no mesmo
     *        tokenId. Nao reentra em `mint` — uma posicao POL unica
     *        para o pool CREDIT/USDC e o desenho deliberado (vide
     *        Decisao 1 do parecer §1).
     *
     *      *Pre-condicoes off-chain (proposta DAO):*
     *      1. {positionManager} ja setado via {setPositionManager}.
     *      2. {USDC_TOKEN} setado no construtor (se zero, reverte com
     *         {BuybackInfraMissing}).
     *      3. Treasury ja tem `creditAmount` e `usdcAmount` em saldo.
     *         Para o seed inicial, isso exige que a proposta DAO
     *         tambem mint CREDIT (Treasury com `MINTER_ROLE` temporario
     *         no `CreditToken`) e que o USDC chegue por bootstrap
     *         externo (vide Decisao 3 do parecer).
     *
     *      *Slippage*: caller passa `amount0Min`/`amount1Min` ja na ordem
     *      de tokens do POOL (token0 < token1). Helper {_orderTokens} eh
     *      consultado para ordenar `creditAmount`/`usdcAmount` antes do
     *      call. **Atencao do proponente da DAO**: a ordem dos mins deve
     *      casar com a ordem real `(token0, token1)` no pool — verificavel
     *      via {polTokensOrdered} (view).
     *
     *      *Token ordering*: Uniswap V3 ordena tokens por endereco
     *      ascendente. {_orderTokens} cuida disso: caller passa CREDIT e
     *      USDC nas suas variaveis nativas; o helper devolve `(token0,
     *      token1, amount0, amount1)` corretos para o NPM.
     *
     * @param creditAmount Quantidade de CREDIT a depositar (precisao 18 decimais).
     * @param usdcAmount Quantidade de USDC a depositar (precisao 6 decimais em prod).
     * @param amount0Min Slippage protection para `token0` (vide ordering acima).
     * @param amount1Min Slippage protection para `token1`.
     * @param deadline UNIX timestamp limite para o NPM aceitar a operacao.
     */
    function addPOL(
        uint256 creditAmount,
        uint256 usdcAmount,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (creditAmount == 0 && usdcAmount == 0) {
            revert ZeroAmount();
        }
        if (USDC_TOKEN == address(0) || address(positionManager) == address(0)) {
            revert BuybackInfraMissing();
        }

        (address token0, address token1, uint256 d0, uint256 d1) = _orderTokens(creditAmount, usdcAmount);
        _approveNPM(token0, token1, d0, d1);
        (uint256 currentTokenId, uint128 liq, uint256 a0, uint256 a1) = _provisionLiquidity(
            token0,
            token1,
            d0,
            d1,
            amount0Min,
            amount1Min,
            deadline
        );
        _approveNPM(token0, token1, 0, 0);

        // Reordena amounts efetivamente consumidos -> (creditConsumed, usdcConsumed).
        (uint256 cConsumed, uint256 uConsumed) = (CREDIT_TOKEN < USDC_TOKEN) ? (a0, a1) : (a1, a0);

        emit POLAdded(currentTokenId, liq, cConsumed, uConsumed);
    }

    /**
     * @notice Reduz a liquidez da posicao POL e devolve o principal ao
     *         Treasury (saldo livre, nao re-investido).
     * @dev Restrita a {GOVERNANCE_ROLE} + `nonReentrant`. NAO queima o NFT —
     *      a posicao permanece (com 0 liquidez se removida totalmente),
     *      e governance pode chamar {addPOL} novamente para reusa-la.
     *      Esta decisao reduz a complexidade contabil (sempre lemos o
     *      mesmo `polTokenId`) e elimina a necessidade de reset de
     *      `polTokenId` em casos extremos. O custo de manter um NFT vazio
     *      e desprezivel.
     *
     *      Tres etapas, espelhando o NPM:
     *      1. {INonfungiblePositionManager.decreaseLiquidity} — registra
     *         debito (sem transferir).
     *      2. {INonfungiblePositionManager.collect} — saca o debito + qualquer
     *         fee pendente, ambos para `address(this)`.
     *      3. Emite {POLRemoved}.
     *
     *      *Politica de exit (Decisao 5 do parecer)*: o gate de
     *      "supermaioria 75% para remocoes >25%" e implementado fora
     *      deste contrato — no `Governor` via proposal type, nao em
     *      Solidity aqui. Este contrato apenas exige {GOVERNANCE_ROLE}
     *      (ou seja, o Timelock executando proposta aprovada). O
     *      threshold 75% e responsabilidade do `CommunityGovernor`.
     *
     * @param liquidityAmount Quantidade de liquidez (L) a remover.
     * @param amount0Min Slippage protection para `token0`.
     * @param amount1Min Slippage protection para `token1`.
     * @param deadline UNIX timestamp limite.
     */
    function removePOL(
        uint128 liquidityAmount,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (liquidityAmount == 0) {
            revert ZeroAmount();
        }
        uint256 tokenId = polTokenId;
        if (tokenId == 0) {
            revert POLNotInitialized();
        }
        if (address(positionManager) == address(0)) {
            revert BuybackInfraMissing();
        }

        // `decreaseLiquidity` retorna (amount0, amount1) owed apos o decrease;
        // ignoramos esses valores deliberadamente pois o `collect` seguinte
        // devolve a soma `owed-by-decrease + fees-pendentes` em uma unica
        // chamada — slither: unused-return aceito.
        positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidityAmount,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            })
        );

        // Coleta tudo o que ficou owed (debito do decrease + qualquer fee
        // residual). type(uint128).max = "tudo disponivel".
        (uint256 amount0Out, uint256 amount1Out) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        emit POLRemoved(tokenId, liquidityAmount, amount0Out, amount1Out);
    }

    /**
     * @notice Coleta os fees acumulados pela posicao POL e os deposita no
     *         Treasury como saldo livre.
     * @dev Restrita a {GOVERNANCE_ROLE} (nao e permissionless intencionalmente
     *      — simetria com o restante do Treasury, e fees sao uma decisao
     *      governance: podem ir para buyback ammo, refill POL, etc., vide
     *      Decisao 4 do parecer §4). Como `recipient = address(this)`
     *      sempre e tokens vao direto pro Treasury (sem callback nem call
     *      externo arbitrario), o `nonReentrant` aqui e defensivo
     *      (alinhamento com o padrao do restante do contrato).
     *
     *      Sem auto-compound. Para reinvestir fees em LP, governance chama
     *      {collectPOLFees} -> {addPOL} em propostas separadas (ou em batch
     *      via `executeBatch` do Timelock).
     *
     * @param amount0Max Maximo aceito de token0 (use type(uint128).max para
     *                   "tudo disponivel"). Util para auto-rebalance off-chain
     *                   onde governance prefere coletar parcialmente.
     * @param amount1Max Maximo aceito de token1.
     */
    function collectPOLFees(uint128 amount0Max, uint128 amount1Max) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        uint256 tokenId = polTokenId;
        if (tokenId == 0) {
            revert POLNotInitialized();
        }
        if (address(positionManager) == address(0)) {
            revert BuybackInfraMissing();
        }

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: amount0Max,
                amount1Max: amount1Max
            })
        );

        emit POLFeesCollected(tokenId, amount0, amount1);
    }

    /**
     * @notice View que retorna o estado atual da posicao POL lido do NPM.
     * @dev Reverte com {POLNotInitialized} se ainda nao houve {addPOL}.
     *      Os campos sao um subset do retorno de
     *      {INonfungiblePositionManager.positions} — escolhidos pelo
     *      uso pratico off-chain (dashboards, propostas DAO).
     * @return tokenId NFT id da posicao.
     * @return liquidity Liquidez ativa atual (L).
     * @return tickLower Tick inferior do range.
     * @return tickUpper Tick superior do range.
     * @return tokensOwed0 Fees + principal owed nao coletado de `token0`.
     * @return tokensOwed1 Fees + principal owed nao coletado de `token1`.
     */
    function polPosition()
        external
        view
        returns (
            uint256 tokenId,
            uint128 liquidity,
            int24 tickLower,
            int24 tickUpper,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        tokenId = polTokenId;
        if (tokenId == 0) {
            revert POLNotInitialized();
        }
        // Ignoramos deliberadamente os campos nonce/operator/token0/token1/
        // fee/feeGrowthInside*LastX128 — irrelevantes para callers do view
        // (token0/token1/fee sao conhecidos via {polTokensOrdered} +
        // {swapFeeTier}; nonce/operator sao bookkeeping ERC-721;
        // feeGrowth* sao internos do NPM). Slither: unused-return aceito.
        (, , , , , int24 tl, int24 tu, uint128 liq, , , uint128 owed0, uint128 owed1) = positionManager.positions(
            tokenId
        );
        return (tokenId, liq, tl, tu, owed0, owed1);
    }

    /**
     * @notice Retorna a ordenacao Uniswap V3 dos tokens do par CREDIT/USDC.
     * @dev Util off-chain para o proponente da DAO calcular `amount0Min`
     *      e `amount1Min` na ordem correta antes de submeter a proposta
     *      de {addPOL} / {removePOL}.
     * @return token0 Endereco com menor address.
     * @return token1 Endereco com maior address.
     * @return creditIsToken0 `true` se CREDIT == token0.
     */
    function polTokensOrdered() external view returns (address token0, address token1, bool creditIsToken0) {
        if (CREDIT_TOKEN < USDC_TOKEN) {
            return (CREDIT_TOKEN, USDC_TOKEN, true);
        }
        return (USDC_TOKEN, CREDIT_TOKEN, false);
    }

    /**
     * @notice Configura o Uniswap V3 NonfungiblePositionManager.
     * @dev Restrita a {GOVERNANCE_ROLE}. Setar para `address(0)` desabilita
     *      todas as operacoes POL ({addPOL}/{removePOL}/{collectPOLFees}
     *      revertem com {BuybackInfraMissing}).
     * @param manager Endereco do NPM.
     */
    function setPositionManager(INonfungiblePositionManager manager) external onlyRole(GOVERNANCE_ROLE) {
        positionManager = manager;
        emit BuybackInfraUpdated("positionManager", address(manager), 0);
    }

    // ------------------------------------------------------------------
    // ETH (originais)
    // ------------------------------------------------------------------

    /**
     * @notice Transfere `amount` de ETH do treasury para `to`.
     */
    function sweepETH(address payable to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        uint256 bal = address(this).balance;
        if (bal < amount) {
            revert InsufficientBalance(address(0), amount, bal);
        }

        emit ETHSwept(to, amount);

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) {
            revert ETHTransferFailed();
        }
    }

    /**
     * @notice Aceita ETH enviado diretamente.
     */
    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Internal helpers — originais
    // ------------------------------------------------------------------

    function _transfer(IERC20 token, address to, uint256 amount) private {
        if (address(token) == address(0) || to == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        uint256 bal = token.balanceOf(address(this));
        if (bal < amount) {
            revert InsufficientBalance(address(token), amount, bal);
        }
        emit Transferred(address(token), to, amount);
        token.safeTransfer(to, amount);
    }

    function _batchTransfer(
        IERC20 token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) private returns (uint256 total) {
        if (address(token) == address(0)) {
            revert ZeroAddress();
        }
        uint256 len = recipients.length;
        if (len != amounts.length) {
            revert ArrayLengthMismatch();
        }
        if (len == 0) {
            revert EmptyBatch();
        }

        for (uint256 i = 0; i < len; ) {
            address to = recipients[i];
            uint256 amt = amounts[i];
            if (to == address(0)) {
                revert ZeroAddress();
            }
            if (amt == 0) {
                revert ZeroAmount();
            }
            total += amt;
            unchecked {
                ++i;
            }
        }

        uint256 bal = token.balanceOf(address(this));
        if (bal < total) {
            revert InsufficientBalance(address(token), total, bal);
        }

        for (uint256 i = 0; i < len; ) {
            address to = recipients[i];
            uint256 amt = amounts[i];
            emit Transferred(address(token), to, amt);
            token.safeTransfer(to, amt);
            unchecked {
                ++i;
            }
        }
    }

    // ------------------------------------------------------------------
    // Internal helpers — Fase 1.1
    // ------------------------------------------------------------------

    /**
     * @dev Aplica os checks de sanidade do feed Chainlink USDC/USD:
     *      `answer > 0`, `updatedAt` recente o suficiente, banda
     *      [chainlinkSanityLowBps, chainlinkSanityHighBps].
     */
    function _enforceChainlinkSanity() private view {
        (, int256 answer, , uint256 updatedAt, ) = chainlinkUsdcFeed.latestRoundData();
        if (answer <= 0) {
            revert InvalidChainlinkAnswer(answer);
        }
        if (block.timestamp - updatedAt > CHAINLINK_MAX_STALENESS) {
            revert ChainlinkStale(updatedAt, CHAINLINK_MAX_STALENESS);
        }
        // Normaliza answer para bps (precisao Chainlink USDC = 8 decimais
        // por padrao; usamos `decimals()` para tolerar feeds custom).
        uint8 dec = chainlinkUsdcFeed.decimals();
        uint256 unitAtDecimals = 10 ** uint256(dec); // 1.00 nesta precisao
        // bps = answer * 10000 / unit
        uint256 bps = (uint256(answer) * BPS_DENOMINATOR) / unitAtDecimals;
        uint256 low = chainlinkSanityLowBps;
        uint256 high = chainlinkSanityHighBps;
        if (bps < low || bps > high) {
            revert UsdcDepegDetected(answer, low, high);
        }
    }

    /**
     * @dev Valida que `value` esta em [min, max] inclusivo. Usado por
     *      todos os setters do FFP.
     */
    function _checkBounds(uint256 value, uint256 min, uint256 max) private pure {
        if (value < min || value > max) {
            revert ParamOutOfBounds(value, min, max);
        }
    }

    // ------------------------------------------------------------------
    // Internal helpers — POL (Fase 1.2)
    // ------------------------------------------------------------------

    /**
     * @dev Ordena CREDIT/USDC e seus respectivos amounts em (token0, token1,
     *      amount0, amount1) seguindo o padrao Uniswap V3 (`token0 < token1`
     *      por endereco). Helper crucial: a ordem real do par no pool
     *      depende dos enderecos deployados, NAO de qual token e
     *      "principal" do ponto de vista do protocolo.
     */
    function _orderTokens(
        uint256 creditAmount,
        uint256 usdcAmount
    ) private view returns (address token0, address token1, uint256 amount0, uint256 amount1) {
        if (CREDIT_TOKEN < USDC_TOKEN) {
            return (CREDIT_TOKEN, USDC_TOKEN, creditAmount, usdcAmount);
        }
        return (USDC_TOKEN, CREDIT_TOKEN, usdcAmount, creditAmount);
    }

    /**
     * @dev Aplica `forceApprove` em ambos os tokens da posicao POL ao
     *      `positionManager`. Usado em {addPOL} para set-and-reset:
     *      `_approveNPM(t0, t1, d0, d1)` antes do call,
     *      `_approveNPM(t0, t1, 0, 0)` depois. forceApprove ja e idempotente
     *      e seguro contra tokens "broken" (USDT mainnet) que requerem
     *      allowance == 0 antes de novo set.
     */
    function _approveNPM(address token0, address token1, uint256 amount0, uint256 amount1) private {
        IERC20(token0).forceApprove(address(positionManager), amount0);
        IERC20(token1).forceApprove(address(positionManager), amount1);
    }

    /**
     * @dev Despacha entre `mint` (primeira provisao) e `increaseLiquidity`
     *      (provisoes subsequentes) preservando os parametros do Uniswap V3.
     *      Atualiza {polTokenId} no caso de mint. Helper extraido apenas
     *      para manter {addPOL} sob o limite de 50 linhas (solhint
     *      function-max-lines); semantica idêntica a um if-else inline.
     *
     *      Slither sinaliza `reentrancy-no-eth` para a escrita
     *      `polTokenId = tokenId` apos o call externo `positionManager.mint`,
     *      apontando uso cross-function em {polPosition}. Falso positivo:
     *      (1) {addPOL} — unica funcao publica que invoca este helper — tem
     *      `nonReentrant`, bloqueando re-entrada em qualquer funcao
     *      `nonReentrant` deste contrato; (2) {polPosition} e `view` (nao
     *      muta estado, nao consegue iniciar reentrada); (3) inverter a
     *      ordem (set polTokenId antes do call) impede o uso do tokenId
     *      retornado pelo NPM e poluiria o storage com `tokenId == 0`
     *      reservado quando o mint reverter, dificultando rollback.
     *      Mesmo padrao usado em {recordDailyPrice} da Fase 1.1.
     */
    function _provisionLiquidity(
        address token0,
        address token1,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) private returns (uint256 tokenId, uint128 liquidityAdded, uint256 amount0, uint256 amount1) {
        uint256 currentTokenId = polTokenId;
        if (currentTokenId == 0) {
            (tokenId, liquidityAdded, amount0, amount1) = positionManager.mint(
                INonfungiblePositionManager.MintParams({
                    token0: token0,
                    token1: token1,
                    fee: swapFeeTier,
                    tickLower: POL_TICK_LOWER,
                    tickUpper: POL_TICK_UPPER,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    recipient: address(this),
                    deadline: deadline
                })
            );
            polTokenId = tokenId;
        } else {
            (liquidityAdded, amount0, amount1) = positionManager.increaseLiquidity(
                INonfungiblePositionManager.IncreaseLiquidityParams({
                    tokenId: currentTokenId,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    deadline: deadline
                })
            );
            tokenId = currentTokenId;
        }
    }
}
