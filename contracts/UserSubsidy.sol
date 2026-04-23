// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title UserSubsidy
 * @notice Distribui CREDIT pre-financiado para os primeiros usuarios dos
 *         apps do ecossistema via Merkle drops com teto de claims. Usado
 *         para subsidiar DEMANDA (nao oferta) durante o bootstrap (~6
 *         meses), ate que o burn organico sustente a emissao via
 *         `RewardDistributor`.
 * @dev Fluxo completo:
 *        1. Um app monta off-chain a lista de `maxClaims` primeiros
 *           usuarios reais (ex.: Chat App identifica os 10.000 primeiros
 *           via suas proprias metricas).
 *        2. O app calcula o Merkle root dessa lista (leaves =
 *           `keccak256(keccak256(abi.encode(userAddress)))` — double-hash
 *           OZ standard, previne preimage collision com nos internos).
 *        3. O app submete proposta ao Governor pedindo:
 *             (a) `Treasury.transfer(credit, userSubsidy, maxClaims *
 *                  amountPerUser)` — funda o contrato.
 *             (b) `UserSubsidy.createCampaign(root, amountPerUser,
 *                  maxClaims, deadline)` — abre a janela.
 *        4. Usuarios elegiveis chamam {claim} com proof. Cada endereco
 *           so pode claim uma vez por campanha.
 *        5. Apos `deadline`, a DAO chama {closeCampaign} para devolver
 *           sobras ao Treasury.
 *
 *      Escolhas de design:
 *
 *      - Merkle (nao assinatura por app): mantem o app OFF-chain —
 *        qualquer seletor de "quem e usuario real" (wallets com
 *        interacao > X, tempo > Y) e computado fora da cadeia, e so
 *        a raiz compactada entra on-chain via proposta. A DAO
 *        aprova a raiz, nao a logica de selecao. Isso evita lock-in
 *        em um esquema de identidade on-chain que ainda nao temos.
 *
 *      - Merkle LEAVES sao double-hashed: leaf =
 *        `keccak256(bytes.concat(keccak256(abi.encode(user))))`.
 *        Esse e o padrao usado pela OZ em `MerkleProof.verify*` para
 *        prevenir second-preimage attack contra nos intermediarios
 *        (um no intermediario de 64 bytes poderia coincidir com um
 *        hash de leaf single-hash abi.encode(address)). Ver OZ docs
 *        de Merkle trees.
 *
 *      - `maxClaims` (cap de contagem), alem de `amountPerUser`:
 *        mesmo se a merkle root tiver 1M entradas, apenas os
 *        primeiros `maxClaims` a claim recebem. Dupla protecao:
 *        a root ja limita quem, o cap limita quantos efetivamente
 *        recebem. Protege orcamento em cenarios de erro humano na
 *        geracao da lista.
 *
 *      - Budget implicito: o contrato NAO reserva saldo por campanha
 *        separadamente. A DAO deve transferir
 *        `maxClaims * amountPerUser` para o contrato antes de
 *        criar/publicar a campanha. Se o saldo acabar (ex.: multiplas
 *        campanhas ativas compartilhando o pool e sub-funding), o
 *        {claim} reverte no `safeTransfer` — e a DAO precisa re-fundar.
 *        Nao tentamos enforçar budget per-campanha on-chain porque
 *        tokens sao fungiveis e o overhead de "reservar" nao traz
 *        garantia real contra mis-funding.
 *
 *      - {closeCampaign} pode ser chamado ANTES do deadline: cenarios
 *        de emergencia (merkle comprometido, lista sybil descoberta).
 *        E governance-gated + timelock-gated (2d), entao nao ha
 *        "congelar claims abruptamente" — usuarios tem 2 dias de
 *        aviso para claim antes do close efetivar.
 *
 *      - {ReentrancyGuard} em {claim} e {closeCampaign}: o token
 *        destino e sempre CREDIT (imutavel no constructor), mas aplicamos
 *        o guard defensivamente para uniformidade com Treasury e para
 *        blindar contra futuras alteracoes de CREDIT que adicionem
 *        hooks.
 *
 *      - `credit` e IMUTAVEL no constructor: simplifica o modelo mental
 *        (um UserSubsidy = um token) e remove vetor de swap-token-on-
 *        the-fly que poderia desviar fundos.
 * @custom:security-contact security@web3community.example
 */
contract UserSubsidy is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Role concedida ao `TimelockController` em producao.
    ///         Autoriza {createCampaign} e {closeCampaign}. Sem poder
    ///         de drenar fundos diretos (ver racional no Treasury).
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @notice Token distribuido (CREDIT).
    IERC20 public immutable credit;

    /// @notice Descreve uma campanha de subsidio.
    /// @dev Layout empacotado: (bytes32 root) + (uint128 amount + uint64
    ///      deadline + uint64 createdAt em um slot) + (uint32 maxClaims
    ///      + uint32 claimed + bool closed em um slot). Total: 3 slots.
    struct Campaign {
        bytes32 merkleRoot;
        uint128 amountPerUser;
        uint64 deadline;
        uint64 createdAt;
        uint32 maxClaims;
        uint32 claimed;
        bool closed;
    }

    /// @notice Contador monotonico de campanhas. Proximo ID a ser atribuido.
    uint256 public nextCampaignId;

    /// @notice campaignId => Campaign.
    mapping(uint256 => Campaign) public campaigns;

    /// @notice campaignId => user => claimed flag.
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitido em {createCampaign}.
    event CampaignCreated(
        uint256 indexed campaignId,
        bytes32 merkleRoot,
        uint256 amountPerUser,
        uint32 maxClaims,
        uint64 deadline
    );

    /// @notice Emitido em {claim}.
    event Claimed(uint256 indexed campaignId, address indexed user, uint256 amount);

    /// @notice Emitido em {closeCampaign}.
    /// @param unclaimedReturned Quantidade devolvida a `returnTo` (pode
    ///        ser zero se todas as claims foram exercidas).
    event CampaignClosed(uint256 indexed campaignId, address indexed returnedTo, uint256 unclaimedReturned);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice Endereco zero nao e valido.
    error ZeroAddress();

    /// @notice Valor zero nao e permitido.
    error ZeroAmount();

    /// @notice Merkle root zero nao faz sentido (nada a provar).
    error ZeroRoot();

    /// @notice Cap de claims zero nao faz sentido.
    error ZeroMaxClaims();

    /// @notice Deadline no passado ou igual ao bloco atual.
    error DeadlineInPast();

    /// @notice Campanha nao existe (nunca criada).
    error CampaignNotFound();

    /// @notice Campanha ja foi fechada.
    error CampaignAlreadyClosed();

    /// @notice Deadline ultrapassado.
    error CampaignExpired();

    /// @notice Usuario ja claim nessa campanha.
    error AlreadyClaimed();

    /// @notice Cap de claims da campanha atingido.
    error CapReached();

    /// @notice Merkle proof invalido para o leaf derivado.
    error InvalidProof();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Configura o distribuidor de subsidios.
     * @dev `admin` recebe `DEFAULT_ADMIN_ROLE` (gerencia outras roles)
     *      e `GOVERNANCE_ROLE` (cria/fecha campanhas). Em producao
     *      ambas devem ser transferidas ao Timelock; no deploy inicial
     *      o admin e o deployer e o script de deploy faz a transferencia
     *      via grantRole + renounceRole apos verificar o wiring.
     * @param credit_ Endereco do CreditToken (CREDIT).
     * @param admin Endereco que recebe ambas as roles.
     */
    constructor(address credit_, address admin) {
        if (credit_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        credit = IERC20(credit_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Governance-gated
    // ------------------------------------------------------------------

    /**
     * @notice Cria uma nova campanha de subsidio.
     * @dev Restrita a {GOVERNANCE_ROLE}. NAO move fundos aqui — a DAO
     *      deve transferir o orcamento (`maxClaims * amountPerUser`)
     *      para este contrato em uma chamada separada da mesma proposta
     *      (via `Treasury.transfer(credit, userSubsidy, budget)`).
     *      Campanhas sao criadas com IDs monotonicos; nao reusamos IDs
     *      mesmo apos close.
     * @param merkleRoot Raiz da arvore de usuarios elegiveis. Leaves
     *        devem ser `keccak256(bytes.concat(keccak256(abi.encode(user))))`.
     * @param amountPerUser Quantidade de CREDIT por claim (unidades
     *        minimas, 1e18 precision). uint128 e suficiente: cap de
     *        2^128-1 ≈ 3.4e38, muito alem de qualquer total supply
     *        realista de CREDIT.
     * @param maxClaims Numero maximo de claims exercitaveis. Se a
     *        merkle tree tiver > `maxClaims` leaves, os primeiros
     *        `maxClaims` a chamar {claim} recebem; os demais veem
     *        {CapReached}.
     * @param deadline Timestamp unix ate quando {claim} e permitido
     *        (inclusive).
     * @return campaignId ID atribuido a esta campanha.
     */
    function createCampaign(
        bytes32 merkleRoot,
        uint128 amountPerUser,
        uint32 maxClaims,
        uint64 deadline
    ) external onlyRole(GOVERNANCE_ROLE) returns (uint256 campaignId) {
        if (merkleRoot == bytes32(0)) {
            revert ZeroRoot();
        }
        if (amountPerUser == 0) {
            revert ZeroAmount();
        }
        if (maxClaims == 0) {
            revert ZeroMaxClaims();
        }
        if (deadline <= block.timestamp) {
            revert DeadlineInPast();
        }

        campaignId = nextCampaignId;
        unchecked {
            nextCampaignId = campaignId + 1;
        }

        campaigns[campaignId] = Campaign({
            merkleRoot: merkleRoot,
            amountPerUser: amountPerUser,
            deadline: deadline,
            createdAt: uint64(block.timestamp),
            maxClaims: maxClaims,
            claimed: 0,
            closed: false
        });

        emit CampaignCreated(campaignId, merkleRoot, amountPerUser, maxClaims, deadline);
    }

    /**
     * @notice Fecha uma campanha e devolve sobras ao `returnTo`
     *         (tipicamente Treasury).
     * @dev Restrita a {GOVERNANCE_ROLE}. Pode ser chamada antes OU
     *      depois do deadline — antes, serve como kill-switch de
     *      emergencia (merkle comprometido, lista sybil), apos, e
     *      rotina de "varredura" das sobras.
     *      Calcula o orçamento remanescente como
     *      `(maxClaims - claimed) * amountPerUser` e transfere para
     *      `returnTo`. Nao tenta sacar eventual "excess" que a DAO
     *      possa ter enviado a mais — se houver, fica no contrato
     *      e pode ser resgatado via proposta futura em nova campanha
     *      ou via upgrade (aqui nao temos upgrade, entao fica
     *      literalmente parado ate a proxima campanha consumir).
     * @param campaignId ID da campanha a fechar.
     * @param returnTo Destinatario das sobras.
     */
    function closeCampaign(uint256 campaignId, address returnTo) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        if (returnTo == address(0)) {
            revert ZeroAddress();
        }
        Campaign storage c = campaigns[campaignId];
        if (c.merkleRoot == bytes32(0)) {
            revert CampaignNotFound();
        }
        if (c.closed) {
            revert CampaignAlreadyClosed();
        }

        c.closed = true;
        uint256 remainingBudget = uint256(c.maxClaims - c.claimed) * uint256(c.amountPerUser);

        emit CampaignClosed(campaignId, returnTo, remainingBudget);
        if (remainingBudget > 0) {
            credit.safeTransfer(returnTo, remainingBudget);
        }
    }

    // ------------------------------------------------------------------
    // User-facing
    // ------------------------------------------------------------------

    /**
     * @notice Exerce claim de subsidio para o chamador.
     * @dev `msg.sender` e sempre o destinatario — nao ha parametro
     *      `to`. Isso impede o padrao "claim em nome de outro" que,
     *      combinado com listas grandes, viraria ferramenta para
     *      "saquear" claims de usuarios desatentos (ex.: sybil
     *      operator claim para 10k enderecos que ele controla e
     *      depois reclama no forum que "alguem claim antes deles").
     *      Se o usuario quer um gasless claim, basta relayer forjar
     *      tx via conta do usuario (EIP-3074 / AA) — mas o recipient
     *      sempre e a mesma conta que assinou.
     *      CEI: todas as checagens primeiro, effect (hasClaimed +
     *      claimed++), depois interaction (safeTransfer).
     * @param campaignId ID da campanha.
     * @param proof Merkle proof do leaf `keccak256(bytes.concat(
     *        keccak256(abi.encode(msg.sender))))` contra a root
     *        armazenada.
     */
    function claim(uint256 campaignId, bytes32[] calldata proof) external nonReentrant {
        Campaign storage c = campaigns[campaignId];
        if (c.merkleRoot == bytes32(0)) {
            revert CampaignNotFound();
        }
        if (c.closed) {
            revert CampaignAlreadyClosed();
        }
        if (block.timestamp > c.deadline) {
            revert CampaignExpired();
        }
        if (hasClaimed[campaignId][msg.sender]) {
            revert AlreadyClaimed();
        }
        if (c.claimed >= c.maxClaims) {
            revert CapReached();
        }

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
        if (!MerkleProof.verifyCalldata(proof, c.merkleRoot, leaf)) {
            revert InvalidProof();
        }

        hasClaimed[campaignId][msg.sender] = true;
        unchecked {
            c.claimed = c.claimed + 1;
        }
        uint256 amount = c.amountPerUser;

        emit Claimed(campaignId, msg.sender, amount);
        credit.safeTransfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @notice Verifica elegibilidade sem consumir a claim.
     * @dev Util para UIs mostrarem "voce pode receber X" antes do
     *      usuario assinar a tx. Retorna `true` se (campanha existe
     *      e nao fechada) + (dentro do deadline) + (nao claim ainda)
     *      + (cap nao atingido) + (proof valido).
     */
    function isEligible(uint256 campaignId, address user, bytes32[] calldata proof) external view returns (bool) {
        Campaign storage c = campaigns[campaignId];
        if (c.merkleRoot == bytes32(0)) return false;
        if (c.closed) return false;
        if (block.timestamp > c.deadline) return false;
        if (hasClaimed[campaignId][user]) return false;
        if (c.claimed >= c.maxClaims) return false;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user))));
        return MerkleProof.verifyCalldata(proof, c.merkleRoot, leaf);
    }
}
