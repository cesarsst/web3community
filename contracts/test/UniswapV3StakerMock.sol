// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {IUniswapV3Staker} from "../interfaces/IUniswapV3Staker.sol";

/**
 * @title UniswapV3StakerMock
 * @notice Mock minimo do `UniswapV3Staker` canonico para testes do
 *         {LiquidityGauge}. Foco em comportamento contabil observavel —
 *         NAO reproduz secondsInsideX128 / liquidity-weighted distribuicao;
 *         o mock acumula rewards via helper de teste {accrueRewards}.
 *
 * @dev Decisoes do mock:
 *      - {createIncentive}: pull de `reward` rewardToken do caller via
 *        `transferFrom`. Registra a incentive sob `keccak256(abi.encode(key))`.
 *      - {endIncentive}: zera o saldo nao-distribuido e devolve ao
 *        `key.refundee` via `transfer`. NAO permite end com NFTs ainda
 *        staked (espelha staker real, que reverte).
 *      - {stakeToken}: marca `tokenId` como staked sob `incentiveHash`.
 *        Reverte se ja staked ou se NFT nao foi previamente depositado.
 *      - {unstakeToken}: limpa stake. NAO acumula rewards automaticamente —
 *        helper `accrueRewards(owner, amount)` permite ao teste injetar
 *        ganhos atribuidos ao owner do deposito.
 *      - {claimReward}: transfer de `min(amountRequested or all, available)`
 *        do reward acumulado para `to`.
 *      - {rewards}: simples leitura do mapping interno.
 *      - {withdrawToken}: usa `safeTransferFrom` do NPM para devolver NFT.
 *      - {onERC721Received}: implementa o fluxo do staker real — recebe NFT,
 *        registra `deposits[tokenId] = from`, e se `data` decoder uma
 *        IncentiveKey, auto-stakeia no `incentiveHash` correspondente
 *        (mesmo padrao do staker oficial em mainnet).
 *      - Helpers de teste:
 *          - {accrueRewards}: simula auferimento de rewards.
 *          - {forceFailUnstake}: faz {unstakeToken} reverter (testar
 *            try/catch de {emergencyUnstake}).
 */
contract UniswapV3StakerMock is IUniswapV3Staker, IERC721Receiver {
    /// @dev Estado por incentiveHash.
    struct StoredIncentive {
        IERC20 rewardToken;
        address refundee;
        uint256 startTime;
        uint256 endTime;
        uint256 totalReward;
        uint256 numberOfStakes;
        bool ended;
    }

    /// @notice Storage de incentives.
    mapping(bytes32 incentiveHash => StoredIncentive) public incentivesStored;

    /// @notice Token id -> depositor (= owner do deposito no staker).
    mapping(uint256 tokenId => address depositor) public deposits;

    /// @notice Token id -> incentiveHash em que esta staked. `bytes32(0)`
    ///         significa "depositado mas nao staked".
    mapping(uint256 tokenId => bytes32 incentiveHash) public tokenStakedAt;

    /// @notice Saldo de rewards acumulados por (rewardToken, owner).
    mapping(address rewardToken => mapping(address owner => uint256 reward)) public rewardsByOwner;

    /// @notice NPM cujos NFTs sao aceitos. Configurado via {setPositionManager}
    ///         pelo teste antes de qualquer operacao.
    address public positionManager;

    /// @notice Quando true, {unstakeToken} reverte. Helper de teste para
    ///         exercitar try/catch no {emergencyUnstake} do gauge.
    bool public forceFailUnstake;

    // ------------------------------------------------------------------
    // Test helpers
    // ------------------------------------------------------------------

    function setPositionManager(address npm) external {
        positionManager = npm;
    }

    function accrueRewards(IERC20 rewardToken, address owner, uint256 amount) external {
        rewardsByOwner[address(rewardToken)][owner] += amount;
    }

    function setForceFailUnstake(bool flag) external {
        forceFailUnstake = flag;
    }

    // ------------------------------------------------------------------
    // IUniswapV3Staker
    // ------------------------------------------------------------------

    function createIncentive(IncentiveKey calldata key, uint256 reward) external override {
        require(reward > 0, "ZERO_REWARD");
        bytes32 incentiveHash = keccak256(abi.encode(key));
        StoredIncentive storage inc = incentivesStored[incentiveHash];
        require(inc.totalReward == 0, "INCENTIVE_EXISTS");

        // Pull reward do caller.
        require(key.rewardToken.transferFrom(msg.sender, address(this), reward), "TRANSFER_FAIL");

        inc.rewardToken = key.rewardToken;
        inc.refundee = key.refundee;
        inc.startTime = key.startTime;
        inc.endTime = key.endTime;
        inc.totalReward = reward;
        inc.numberOfStakes = 0;
        inc.ended = false;
    }

    function endIncentive(IncentiveKey calldata key) external override returns (uint256 refund) {
        bytes32 incentiveHash = keccak256(abi.encode(key));
        StoredIncentive storage inc = incentivesStored[incentiveHash];
        require(inc.totalReward > 0, "INCENTIVE_UNKNOWN");
        require(!inc.ended, "ALREADY_ENDED");
        require(block.timestamp >= inc.endTime, "NOT_EXPIRED");
        require(inc.numberOfStakes == 0, "STAKES_OUTSTANDING");

        // Mock simplificado: refund = todo o totalReward (assume nada
        // distribuido no mock; rewards acumulados via {accrueRewards} sao
        // tratados separadamente em rewardsByOwner). O caller (gauge)
        // recebera de volta todo o capital quando este caminho for usado em
        // testes de endIncentive.
        refund = inc.totalReward;
        inc.totalReward = 0;
        inc.ended = true;
        require(key.rewardToken.transfer(key.refundee, refund), "REFUND_FAIL");
    }

    function stakeToken(IncentiveKey calldata key, uint256 tokenId) external override {
        bytes32 incentiveHash = keccak256(abi.encode(key));
        require(deposits[tokenId] != address(0), "NOT_DEPOSITED");
        require(tokenStakedAt[tokenId] == bytes32(0), "ALREADY_STAKED");
        require(incentivesStored[incentiveHash].totalReward > 0, "INCENTIVE_UNKNOWN");

        tokenStakedAt[tokenId] = incentiveHash;
        incentivesStored[incentiveHash].numberOfStakes += 1;
    }

    function unstakeToken(IncentiveKey calldata key, uint256 tokenId) external override {
        require(!forceFailUnstake, "FORCE_FAIL");
        bytes32 incentiveHash = keccak256(abi.encode(key));
        require(tokenStakedAt[tokenId] == incentiveHash, "NOT_STAKED_HERE");

        tokenStakedAt[tokenId] = bytes32(0);
        StoredIncentive storage inc = incentivesStored[incentiveHash];
        if (inc.numberOfStakes > 0) {
            inc.numberOfStakes -= 1;
        }
    }

    function claimReward(
        IERC20 rewardToken,
        address to,
        uint256 amountRequested
    ) external override returns (uint256 reward) {
        uint256 available = rewardsByOwner[address(rewardToken)][msg.sender];
        if (amountRequested == 0 || amountRequested > available) {
            reward = available;
        } else {
            reward = amountRequested;
        }
        if (reward == 0) return 0;
        rewardsByOwner[address(rewardToken)][msg.sender] = available - reward;
        require(rewardToken.transfer(to, reward), "TRANSFER_FAIL");
    }

    function rewards(IERC20 rewardToken, address owner) external view override returns (uint256 reward) {
        return rewardsByOwner[address(rewardToken)][owner];
    }

    function withdrawToken(uint256 tokenId, address to, bytes calldata /* data */) external override {
        require(deposits[tokenId] == msg.sender, "NOT_DEPOSITOR");
        require(tokenStakedAt[tokenId] == bytes32(0), "STILL_STAKED");
        require(positionManager != address(0), "NPM_UNSET");

        deposits[tokenId] = address(0);
        // safeTransferFrom para devolver o NFT ao real owner (gauge -> user).
        IERC721Like(positionManager).safeTransferFrom(address(this), to, tokenId);
    }

    // ------------------------------------------------------------------
    // IERC721Receiver
    // ------------------------------------------------------------------

    /**
     * @dev Espelha o staker oficial: aceita NFT, registra deposit, e se
     *      `data` decoder uma IncentiveKey, auto-stakeia.
     */
    function onERC721Received(
        address /* operator */,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external override returns (bytes4) {
        require(msg.sender == positionManager, "NOT_NPM");
        deposits[tokenId] = from;

        if (data.length > 0) {
            IncentiveKey memory key = abi.decode(data, (IncentiveKey));
            bytes32 incentiveHash = keccak256(abi.encode(key));
            require(incentivesStored[incentiveHash].totalReward > 0, "INCENTIVE_UNKNOWN");
            tokenStakedAt[tokenId] = incentiveHash;
            incentivesStored[incentiveHash].numberOfStakes += 1;
        }

        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Subset minimo de ERC-721 para o mock chamar `safeTransferFrom` no NPM.
interface IERC721Like {
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}
