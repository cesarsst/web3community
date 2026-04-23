// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title CreditToken (CREDIT)
 * @notice Token utilitario ERC-20 da Web3Community. Queimado no consumo dentro da
 *         plataforma (pagamentos de features, fees dos apps) e cunhado pelo
 *         `RewardDistributor` em rodadas. Sem supply cap hardcoded: a inflacao
 *         e controlada economicamente por quem detem `MINTER_ROLE` (o distributor,
 *         que por sua vez aplica cap por rodada — invariante I3 vive la, nao aqui).
 * @dev Invariantes atendidas nesta unidade:
 *      - I2: Burn no consumo e suportado em 3 caminhos complementares:
 *            (a) {burn}            — holder queima o proprio saldo;
 *            (b) {burnFrom}        — terceiros queimam com allowance (ERC20Burnable);
 *            (c) {burnByRole}      — portadores de {BURNER_ROLE} queimam SEM allowance.
 *            O caminho (c) existe para permitir que o futuro `BurnTracker` execute
 *            `burnAndRecord` atomicamente em um unico tx, no contexto de um app
 *            pago pelo usuario (UX: usuario assina 1 tx no app, nao um approve + burn).
 *            Ele e seguro porque `BURNER_ROLE` so e concedido via TimelockController
 *            apos proposta aprovada na DAO (invariante I7 do registry), e a role
 *            pode ser revogada pelo admin (eventualmente o proprio Timelock) a
 *            qualquer momento.
 *      - Supply elastico: nao ha cap. Mints adicionais sao sempre possiveis desde
 *            que quem chama tenha `MINTER_ROLE`. O cap por rodada e do distributor.
 *      Nao herda {ERC20Votes}: CREDIT nao vota (so GOV vota). Nao herda
 *      {ERC20Permit}: no v1 optamos por superficie minima. Consumo via
 *      `FeeRouter.pay()` usa ou (1) allowance + `burnFrom`, ou (2) `burnByRole`
 *      atomico pelo `BurnTracker`. Se permit virar necessario em v2, basta
 *      adicionar a extensao mantendo storage layout.
 *      Genesis de 10M pre-cunhado NAO acontece no constructor. Em vez disso
 *      expomos {mintGenesis}, chamada uma unica vez pelo admin durante o deploy
 *      (flag {genesisMinted} one-shot). Isso mantem o constructor puro, permite
 *      que o deploy script escolha o destinatario (tesouraria) sem hardcode e
 *      deixa o contrato auditavel sem depender de parametros de construtor.
 * @custom:security-contact security@web3community.example
 */
contract CreditToken is ERC20, ERC20Burnable, AccessControl {
    /// @notice Role autorizada a cunhar CREDIT via {mint}. Concedida pelo admin
    ///         ao `RewardDistributor` na fase 4 do deploy.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role autorizada a queimar CREDIT de qualquer holder via
    ///         {burnByRole} SEM consumir allowance. Concedida pelo admin
    ///         (idealmente o Timelock) ao `BurnTracker` / `FeeRouter` da fase 3.
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
    ///            (ex.: "rewardRound:42", "retroActive:q2", "airdrop:launch").
    event Minted(address indexed to, uint256 amount, string tag);

    /// @notice Emitido em todo {burnByRole} bem-sucedido.
    /// @param operator Endereco com `BURNER_ROLE` que executou a queima.
    /// @param from Endereco cujo saldo foi queimado (usuario final).
    /// @param amount Quantidade queimada.
    /// @param tag Rotulo off-chain para rastreio (ex.: "feeRouter:pay",
    ///            "subscription:renew").
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
     * @dev Em producao o unico endereco com `MINTER_ROLE` e o `RewardDistributor`,
     *      que aplica cap por rodada antes de chamar. Este contrato NAO valida
     *      cap — supply elastico por design (invariante I3 fica no distributor).
     *      O parametro `tag` e so registro off-chain (via evento) e serve para
     *      auditar a origem economica de cada mint (ex.: id da rodada, nome do
     *      airdrop). Nao afeta contabilidade on-chain.
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
     * @dev *Por que nao usar {burnFrom} com allowance aqui?* Porque o consumo
     *      dentro da plataforma acontece em um unico tx disparado pelo app
     *      (ex.: `FeeRouter.pay()` que chama `BurnTracker.burnAndRecord()` que
     *      chama `CreditToken.burnByRole()`). Exigir approve previo quebraria
     *      atomicidade (2 txs do usuario) e criaria janela de front-run entre
     *      approve e burn. A mitigacao desta escolha e o gating por role:
     *      `BURNER_ROLE` so e concedido a contratos especificos apos proposta
     *      aprovada na DAO (via Timelock), e a role pode ser revogada a
     *      qualquer momento se um contrato com a role for descoberto
     *      comprometido. Usuarios que quiserem o fluxo "consinto queima
     *      explicitamente" usam {burnFrom} com allowance — esse caminho
     *      continua disponivel via ERC20Burnable.
     *      CEI aplicada: checagens primeiro, efeito (_burn) depois, sem
     *      interacoes externas. `_burn` do ERC-20 ja decrementa balance e
     *      totalSupply, e reverte com {ERC20InsufficientBalance} se o saldo
     *      for menor que `amount`.
     * @param from Endereco cujo saldo sera queimado.
     * @param amount Quantidade a queimar.
     * @param tag Rotulo off-chain (ex.: "feeRouter:pay", "sub:monthly").
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
