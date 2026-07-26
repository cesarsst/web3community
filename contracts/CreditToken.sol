// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title CreditToken (CREDIT)
 * @notice Moeda de pagamento ERC-20 da Web3Community (remodel 2026-07-08).
 *         CREDIT e ESTAVEL 1:1 com USDC: todo o supply em circulacao nasce e
 *         morre no {CreditPSM}, que minta contra deposito de USDC e queima
 *         contra resgate. No modelo vigente o PSM e o UNICO detentor
 *         operacional de `MINTER_ROLE` e `BURNER_ROLE` — logo o supply e
 *         sempre 100% lastreado por construcao.
 * @dev Invariantes atendidas nesta unidade:
 *      - Mint/burn gated por role: {mint} exige `MINTER_ROLE`, {burnByRole}
 *        exige `BURNER_ROLE` (queima SEM allowance, sempre sobre o saldo que
 *        o PSM ja recolheu no resgate). Em producao ambas as roles sao
 *        concedidas exclusivamente ao PSM; o admin (Timelock) pode
 *        revoga-las/reatribui-las se a governanca trocar o modulo de peg.
 *      - Caminhos de burn do holder: {burn} (proprio saldo) e {burnFrom}
 *        (com allowance) vem do {ERC20Burnable} e permanecem disponiveis,
 *        mas nao fazem parte do fluxo padrao (o usuario resgata via PSM.sell,
 *        que devolve USDC — em vez de queimar sem contrapartida).
 *      Nao herda {ERC20Votes}: CREDIT nao vota (so GOV vota). Nao herda
 *      {ERC20Permit}: superficie minima.
 *      {mintGenesis} existe como capacidade one-shot de bootstrap (flag
 *      {genesisMinted}) mas NAO e usada no deploy padrao — o peg exige que
 *      todo CREDIT tenha lastro, entao a via normal e o PSM. Mantida para
 *      cenarios de migracao/testes onde o admin precise semear um saldo
 *      controlado antes do PSM assumir.
 * @custom:security-contact security@web3community.example
 */
contract CreditToken is ERC20, ERC20Burnable, AccessControl {
    /// @notice Role autorizada a cunhar CREDIT via {mint}. Concedida pelo admin
    ///         ao {CreditPSM} na fase B do deploy (unico minter operacional).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role autorizada a queimar CREDIT via {burnByRole} SEM consumir
    ///         allowance. Concedida pelo admin ao {CreditPSM} (queima o saldo
    ///         recolhido no resgate). Revogavel pelo Timelock.
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice `true` apos a primeira execucao bem-sucedida de {mintGenesis}.
    ///         Flag one-shot que impede o admin de re-executar o genesis mint
    ///         mesmo que detenha `DEFAULT_ADMIN_ROLE`.
    bool public genesisMinted;

    /// @notice Emitido no mint inicial (genesis) pre-cunhado para a tesouraria.
    /// @param to Destinatario do genesis (geralmente a tesouraria da DAO).
    /// @param amount Quantidade cunhada (em unidades minimas, 1e18 precision).
    event GenesisMinted(address indexed to, uint256 amount);

    /// @notice Emitido em todo {mint} bem-sucedido feito por um `MINTER_ROLE`.
    /// @param to Destinatario dos tokens cunhados.
    /// @param amount Quantidade cunhada (em unidades minimas).
    /// @param tag Rotulo off-chain para rastrear a origem economica
    ///            (ex.: "psm:buy").
    event Minted(address indexed to, uint256 amount, string tag);

    /// @notice Emitido em todo {burnByRole} bem-sucedido.
    /// @param operator Endereco com `BURNER_ROLE` que executou a queima.
    /// @param from Endereco cujo saldo foi queimado (usuario final).
    /// @param amount Quantidade queimada.
    /// @param tag Rotulo off-chain para rastreio (ex.: "psm:sell",
    ///            "burn:manual").
    event BurnedByRole(address indexed operator, address indexed from, uint256 amount, string tag);

    /// @notice Endereco zero nao e valido como destinatario/alvo.
    error ZeroAddress();

    /// @notice Valor zero nao e permitido em operacoes que exigem amount > 0.
    error ZeroAmount();

    /// @notice {mintGenesis} so pode ser executado uma unica vez.
    error GenesisAlreadyMinted();

    /**
     * @notice Cria o token de credito da Web3Community.
     * @dev O admin inicial recebe `DEFAULT_ADMIN_ROLE` e pode conceder
     *      `MINTER_ROLE` / `BURNER_ROLE` posteriormente. Nenhum token e
     *      cunhado no constructor — `totalSupply()` comeca em 0. Para o
     *      genesis de 10M, o deploy script chama {mintGenesis} em seguida.
     *      O admin inicial deve ser o deployer em local/testnet e o
     *      TimelockController em producao (invariante I4 aplicada fora
     *      deste contrato, via `grantRole` + `renounceRole` no script de
     *      deploy).
     * @param name_ Nome ERC-20 legivel (ex.: "Web3Community Credit").
     * @param symbol_ Simbolo ERC-20 curto (ex.: "CREDIT").
     * @param initialAdmin Endereco que recebe `DEFAULT_ADMIN_ROLE`.
     */
    constructor(string memory name_, string memory symbol_, address initialAdmin) ERC20(name_, symbol_) {
        if (initialAdmin == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    /**
     * @notice Cunha o supply de genesis (10M) para `to`. Pode ser executado UMA
     *         UNICA VEZ; chamadas subsequentes revertem com {GenesisAlreadyMinted}.
     * @dev Restrita a `DEFAULT_ADMIN_ROLE`. Intencionalmente o amount e parametro
     *      (nao hardcoded) para que o script de deploy tenha controle explicito
     *      do numero exato e para facilitar auditoria em chain — a quantidade
     *      real e assinada no evento {GenesisMinted} e visivel off-chain antes
     *      de qualquer outra operacao do token.
     *      NAO consome `MINTER_ROLE` — o caminho do genesis e separado do
     *      caminho operacional para nao exigir que o admin tambem seja minter.
     * @param to Destinatario do genesis (tesouraria da DAO).
     * @param amount Quantidade a cunhar (em unidades minimas).
     */
    function mintGenesis(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (genesisMinted) {
            revert GenesisAlreadyMinted();
        }
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        genesisMinted = true;
        _mint(to, amount);
        emit GenesisMinted(to, amount);
    }

    /**
     * @notice Cunha `amount` tokens para `to`. Restrita a `MINTER_ROLE`.
     * @dev Em producao o unico endereco com `MINTER_ROLE` e o {CreditPSM},
     *      que so minta contra deposito de USDC de igual valor — o lastro
     *      integral e garantido no PSM, nao aqui. O parametro `tag` e so
     *      registro off-chain (via evento) para auditar a origem de cada mint
     *      (ex.: "psm:buy"). Nao afeta contabilidade on-chain.
     *      Reverte com {ZeroAddress} se `to == address(0)` e {ZeroAmount} se
     *      `amount == 0`.
     * @param to Destinatario dos tokens.
     * @param amount Quantidade a cunhar (em unidades minimas).
     * @param tag Rotulo descritivo (opcional; apenas evento).
     */
    function mint(address to, uint256 amount, string calldata tag) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        _mint(to, amount);
        emit Minted(to, amount, tag);
    }

    /**
     * @notice Queima `amount` tokens do saldo de `from` SEM consumir allowance.
     *         Restrita a `BURNER_ROLE`.
     * @dev *Por que nao usar {burnFrom} com allowance aqui?* Porque o resgate
     *      no {CreditPSM} acontece em um unico tx: o PSM ja recolheu o CREDIT
     *      do vendedor (safeTransferFrom) e queima do PROPRIO saldo — nunca de
     *      terceiro. Exigir approve interno quebraria atomicidade sem ganho de
     *      seguranca. A mitigacao e o gating por role: `BURNER_ROLE` so e
     *      concedido ao PSM (revogavel pelo Timelock). Usuarios que quiserem
     *      queimar sem contrapartida usam {burnFrom}/{burn} do ERC20Burnable —
     *      caminho disponivel, mas fora do fluxo padrao.
     *      CEI aplicada: checagens primeiro, efeito (_burn) depois, sem
     *      interacoes externas. `_burn` do ERC-20 ja decrementa balance e
     *      totalSupply, e reverte com {ERC20InsufficientBalance} se o saldo
     *      for menor que `amount`.
     * @param from Endereco cujo saldo sera queimado.
     * @param amount Quantidade a queimar.
     * @param tag Rotulo off-chain (ex.: "psm:sell").
     */
    function burnByRole(address from, uint256 amount, string calldata tag) external onlyRole(BURNER_ROLE) {
        if (from == address(0)) {
            revert ZeroAddress();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        _burn(from, amount);
        emit BurnedByRole(_msgSender(), from, amount, tag);
    }
}
