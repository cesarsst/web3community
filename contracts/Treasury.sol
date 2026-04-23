// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Treasury
 * @notice Custodia multi-ativo da DAO Web3Community. Recebe passivamente
 *         qualquer ERC-20 (USDC/USDT como stables primarios, GOV via buyback,
 *         outros tokens que a DAO aceite como fee de subscription ou protocol
 *         fee). Unica via de saida e via {GOVERNANCE_ROLE}, concedida em
 *         producao apenas ao `TimelockController` — nenhum admin pode drenar
 *         fundos fora do ciclo de governanca (invariante I4).
 * @dev Invariantes atendidas nesta unidade:
 *      - I4: Todas as funcoes state-changing que movem fundos sao gated por
 *        {GOVERNANCE_ROLE} (sem escape via DEFAULT_ADMIN_ROLE). O admin
 *        inicial apenas detem poder de conceder/revogar roles (padrao OZ
 *        {AccessControl}), e em producao essa role tambem deve ser
 *        transferida para o Timelock apos bootstrap.
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
 *      - {executeBuyback} E STUB no v1. Emite {BuybackRequested} com os
 *        parametros propostos (stable, amountIn, minGovOut, swapData) mas
 *        NAO executa swap. A integracao real com DEX (Uniswap v3 ou Balancer)
 *        ficara numa fase subsequente, quando o modelo de slippage, TWAP e
 *        frontrunning estiver validado. Ate la, o evento documenta a intencao
 *        on-chain e permite off-chain workers detectarem propostas aprovadas.
 *      - {ReentrancyGuard} aplicado em TODAS as saidas de fundos (transfer,
 *        batchTransfer, payRebates, executeBuyback, sweepETH). Justificativa:
 *        Treasury aceita qualquer ERC-20 passivamente, incluindo tokens com
 *        callbacks (ERC-777 legacy) ou ERC-20 customizados maliciosos com
 *        hooks em `_update`. O guard e barato (~2k gas por chamada no
 *        caminho feliz) e blinda contra vetores que CEI sozinho nao cobre
 *        quando o token externo e arbitrario.
 *      - Custom errors para todas as falhas. Eventos com `indexed` em todos
 *        os enderecos e IDs pra indexacao off-chain.
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
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido em cada transferencia de ERC-20 saida do treasury
    ///         (inclusive as individuais dentro de {batchTransfer} e
    ///         {payRebates}).
    /// @param token Endereco do ERC-20 transferido.
    /// @param to Destinatario.
    /// @param amount Quantidade enviada.
    event Transferred(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitido ao final de um {batchTransfer}.
    /// @param token Endereco do ERC-20.
    /// @param totalAmount Soma de todas as saidas do batch.
    /// @param recipientCount Numero de destinatarios.
    event BatchTransferred(address indexed token, uint256 totalAmount, uint256 recipientCount);

    /// @notice Emitido ao final de um {payRebates}. Mesma mecanica do
    ///         {BatchTransferred} mas com semantica explicita de "pagamento
    ///         de rebate da rodada X" para consumidores off-chain.
    /// @param token Endereco do ERC-20 usado para pagamento.
    /// @param round Identificador da rodada de rebate.
    /// @param totalAmount Soma de todos os pagamentos do batch.
    /// @param appCount Numero de apps pagos.
    event RebatesPaid(address indexed token, uint256 indexed round, uint256 totalAmount, uint256 appCount);

    /// @notice Emitido em {executeBuyback} (stub v1). Registra a intencao de
    ///         buyback aprovada via governance. NENHUM swap e executado no
    ///         v1 — off-chain workers ou futuros contratos de DEX integration
    ///         observam este evento para processar a requisicao.
    /// @param stable Endereco do stablecoin de origem.
    /// @param amountIn Quantidade de stable a ser convertida em GOV.
    /// @param minGovOut Slippage minimo aceitavel em GOV.
    /// @param swapData Payload opaco (ex.: route de DEX, parametros de Uniswap)
    ///                 que sera consumido pela integracao futura.
    event BuybackRequested(address indexed stable, uint256 amountIn, uint256 minGovOut, bytes swapData);

    /// @notice Emitido quando o treasury recebe ETH via {receive}.
    /// @param from Endereco que enviou o ETH.
    /// @param amount Quantidade recebida (wei).
    event ETHReceived(address indexed from, uint256 amount);

    /// @notice Emitido em {sweepETH}.
    /// @param to Destinatario do sweep.
    /// @param amount Quantidade enviada (wei).
    event ETHSwept(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Valor zero nao e permitido em operacoes que exigem > 0.
    error ZeroAmount();

    /// @notice Arrays de destinatarios e amounts tem tamanhos diferentes.
    error ArrayLengthMismatch();

    /// @notice Batch vazio (arrays de tamanho 0).
    error EmptyBatch();

    /// @notice Saldo insuficiente do ativo solicitado.
    /// @param token Endereco do ativo (address(0) para ETH).
    /// @param requested Quantidade requerida.
    /// @param available Saldo atual do treasury no ativo.
    error InsufficientBalance(address token, uint256 requested, uint256 available);

    /// @notice Transferencia de ETH via `call` falhou (destinatario rejeitou).
    error ETHTransferFailed();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Cria o treasury concedendo {DEFAULT_ADMIN_ROLE} e
     *         {GOVERNANCE_ROLE} ao `admin`.
     * @dev Em producao, `admin` deve ser o `TimelockController`. Em testnet
     *      local e aceitavel uma EOA, desde que o script de deploy transfira
     *      ambas as roles ao Timelock antes de qualquer uso real.
     *      Nao aceita aceitar ETH durante a construcao (sem `payable`) — o
     *      construtor nao tem razao de receber ETH e permitir abriria vetor
     *      de griefing no deploy.
     * @param admin Endereco que recebe ambas as roles. Revertido se 0.
     */
    constructor(address admin) {
        if (admin == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Saldo do treasury no token `token`.
     * @dev Wrapper simples sobre {IERC20.balanceOf}, exposto para consumo
     *      uniforme por off-chain indexers e contratos consumidores sem
     *      exigir conhecimento do endereco do treasury.
     * @param token Endereco do ERC-20.
     * @return Saldo em unidades minimas do token.
     */
    function balanceOf(IERC20 token) external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ------------------------------------------------------------------
    // Governance-gated state changes — ERC-20
    // ------------------------------------------------------------------

    /**
     * @notice Transfere `amount` de `token` do treasury para `to`.
     * @dev Restrito a {GOVERNANCE_ROLE}. Usa {SafeERC20} para tolerar tokens
     *      nao-standard (ex.: USDC historico). Nao reverta com erro generico
     *      em saldo insuficiente — cheque explicito produz {InsufficientBalance}
     *      com contexto de auditoria.
     *      CEI: checks -> (sem effects de storage) -> interaction.
     *      `nonReentrant` e pago aqui porque `token` e arbitrario e pode ter
     *      hooks de callback (ver NatSpec contract-level).
     * @param token ERC-20 a enviar.
     * @param to Destinatario.
     * @param amount Quantidade.
     */
    function transfer(IERC20 token, address to, uint256 amount) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        _transfer(token, to, amount);
    }

    /**
     * @notice Transfere `amounts[i]` de `token` para `recipients[i]`, para
     *         todo i in [0, recipients.length).
     * @dev Restrito a {GOVERNANCE_ROLE}. Usa sempre o mesmo `token` — para
     *      multiplos tokens numa proposta, o Governor agenda multiplas
     *      chamadas na mesma `TimelockBatch`.
     *      Reverte com {ArrayLengthMismatch} se tamanhos divergem,
     *      {EmptyBatch} se arrays vazios. Zero amount / zero address em
     *      qualquer posicao revertem — mantem invariante de que nenhum
     *      evento {Transferred} jamais registra saida lixo.
     * @param token ERC-20 a enviar.
     * @param recipients Destinatarios (>= 1).
     * @param amounts Quantidades alinhadas com `recipients`.
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
     * @dev Restrito a {GOVERNANCE_ROLE}. Identico a {batchTransfer} na
     *      mecanica; distinto no evento final {RebatesPaid}, que inclui
     *      `round` para consumidores off-chain reconciliarem pagamentos
     *      com a proposta original do Governor.
     * @param token ERC-20 a pagar.
     * @param apps Enderecos dos apps.
     * @param amounts Quantidades alinhadas com `apps`.
     * @param round Identificador da rodada de rebate (off-chain).
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
    // Governance-gated state changes — Buyback (stub)
    // ------------------------------------------------------------------

    /**
     * @notice Registra uma intencao de buyback de GOV usando `stable` como
     *         origem. Stub v1: NAO executa swap.
     * @dev Restrito a {GOVERNANCE_ROLE}. A integracao real com DEX sera feita
     *      em fase posterior (Uniswap v3 / Balancer) — `swapData` e um
     *      payload opaco que a implementacao futura interpretara (route,
     *      deadline, etc). Nenhum token e movido do treasury nesta chamada:
     *      apenas {BuybackRequested} e emitido, para que off-chain workers
     *      detectem propostas aprovadas e processem o buyback em outro fluxo
     *      (ou aguardem a fase que integrara DEX de fato).
     *      `nonReentrant` aplicado defensivamente — a integracao futura
     *      chamara routers externos e queremos que o marcador ja esteja em
     *      lugar para evitar regressao quando o stub for substituido.
     *      Guards: stable != 0, amountIn > 0, minGovOut > 0 (minGovOut == 0
     *      significaria slippage ilimitado; exigimos que o Governor declare
     *      um slippage maximo explicitamente).
     * @param stable Endereco do stablecoin.
     * @param amountIn Quantidade de stable a converter.
     * @param minGovOut Quantidade minima de GOV aceitavel (anti-slippage).
     * @param swapData Payload opaco para a futura integracao de DEX.
     */
    function executeBuyback(
        address stable,
        uint256 amountIn,
        uint256 minGovOut,
        bytes calldata swapData
    ) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (stable == address(0)) {
            revert ZeroAddress();
        }
        if (amountIn == 0 || minGovOut == 0) {
            revert ZeroAmount();
        }
        emit BuybackRequested(stable, amountIn, minGovOut, swapData);
    }

    // ------------------------------------------------------------------
    // Governance-gated state changes — ETH
    // ------------------------------------------------------------------

    /**
     * @notice Transfere `amount` de ETH do treasury para `to`.
     * @dev Restrito a {GOVERNANCE_ROLE}. O treasury aceita ETH apenas por
     *      cortesia (ver {receive}); preferencia e operar em ERC-20. Usa
     *      `call{value: ...}("")` (2300-gas-stipend seria insuficiente para
     *      contratos de destino); se o destino rejeitar, reverte com
     *      {ETHTransferFailed}.
     * @param to Destinatario. Deve ser payable (contratos sem receive
     *           rejeitam e provocam revert).
     * @param amount Quantidade em wei.
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

    // ------------------------------------------------------------------
    // ETH fallback
    // ------------------------------------------------------------------

    /**
     * @notice Aceita ETH enviado diretamente. Emite {ETHReceived} para
     *         rastreabilidade off-chain.
     * @dev Deliberadamente nao exigimos autorizacao — qualquer remetente
     *      pode doar ETH. Remocao requer {sweepETH}, que e governance-gated.
     */
    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * @dev Executa um transfer unitario com todos os guards e emite
     *      {Transferred}. Usado diretamente por {transfer} e indiretamente
     *      por {_batchTransfer}.
     */
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

    /**
     * @dev Executa um batch de transfers com guards comuns. Retorna a soma
     *      total enviada para ser usada no evento agregado pelo chamador
     *      ({batchTransfer} ou {payRebates}).
     *      Loop com `unchecked` no incremento — `i` e limitado pelo tamanho
     *      do array (bounded por calldata; impossivel overflow em pratica).
     *      Cheque de saldo e feito UMA vez no inicio (soma total) para evitar
     *      N chamadas redundantes a `balanceOf` e reduzir gas — falha
     *      antecipada com {InsufficientBalance} mesmo se as saidas
     *      individuais caberiam.
     */
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
}
