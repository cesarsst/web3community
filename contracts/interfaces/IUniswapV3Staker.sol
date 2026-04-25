// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "./IUniswapV3Pool.sol";

/**
 * @title IUniswapV3Staker (subset)
 * @notice Subset minimo da ABI do `UniswapV3Staker` canonico da Uniswap
 *         Foundation (mainnet `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`)
 *         consumido pela Fase 1.3 do pivot CLP — `LiquidityGauge`. Apenas as
 *         entradas estritamente usadas estao expostas:
 *
 *         - {createIncentive}   — abre uma incentive nova com `reward` CREDIT
 *                                 disponiveis para distribuir entre LPs in-range
 *                                 entre `startTime` e `endTime`.
 *         - {endIncentive}      — encerra incentive vencida, devolve `refund`
 *                                 ao `refundee`. Usado em rollover por governance.
 *         - {stakeToken}        — atrela um NFT depositado a uma incentive ativa.
 *                                 NAO consumido em fluxo principal (o gauge
 *                                 enviar o NFT com `data` ja faz auto-stake),
 *                                 mas exposto para flexibilidade futura.
 *         - {unstakeToken}      — desfaz o stake antes de retirar o NFT.
 *         - {claimReward}       — saca CREDIT acumulado para `to`.
 *         - {rewards}           — leitura de rewards pending por (token, owner).
 *         - {withdrawToken}     — devolve o NFT ao `to` (via safeTransferFrom).
 *
 * @dev *Por que nao importar `@uniswap/v3-staker`?* O staker oficial esta em
 *      pragma `0.7.6`, incompativel com 0.8.24. A interface enxuta replica
 *      EXATAMENTE os selectors que o staker deployado expoe — auditavel via
 *      comparacao de 4-byte selector.
 *
 *      Referencia oficial:
 *      https://github.com/Uniswap/v3-staker/blob/main/contracts/interfaces/IUniswapV3Staker.sol
 *
 *      O contrato real expoe ainda `multicall`, `deposits`, `incentives`, etc.
 *      Esses NAO sao consumidos pelo {LiquidityGauge}; manter a interface
 *      enxuta facilita auditoria e reduz superficie de erro no mock.
 */
interface IUniswapV3Staker {
    /**
     * @notice Identifica unicamente uma incentive. O staker hashea esta tupla
     *         com `keccak256(abi.encode(key))` para chave de storage.
     * @param rewardToken Token distribuido (no nosso caso, sempre CREDIT).
     * @param pool Pool Uniswap V3 alvo (CREDIT/USDC 0.3% no seed).
     * @param startTime Timestamp UNIX em que rewards comecam a acumular.
     * @param endTime Timestamp UNIX em que rewards param de acumular.
     * @param refundee Endereco que recebe rewards nao distribuidos via
     *                 {endIncentive} (no nosso caso, o proprio gauge).
     */
    struct IncentiveKey {
        IERC20 rewardToken;
        IUniswapV3Pool pool;
        uint256 startTime;
        uint256 endTime;
        address refundee;
    }

    /**
     * @notice Cria uma nova incentive, transferindo `reward` rewardToken do
     *         caller para o staker. Pre-condicao: caller deve ter aprovado
     *         `reward` para este contrato.
     * @param key Ver {IncentiveKey}.
     * @param reward Quantidade total a distribuir entre `startTime` e `endTime`.
     */
    function createIncentive(IncentiveKey calldata key, uint256 reward) external;

    /**
     * @notice Encerra incentive expirada e devolve rewards nao distribuidos
     *         ao `refundee`.
     * @param key Ver {IncentiveKey}.
     * @return refund Quantidade efetivamente devolvida.
     */
    function endIncentive(IncentiveKey calldata key) external returns (uint256 refund);

    /**
     * @notice Atrela um NFT ja depositado a uma incentive ativa. Equivalente a
     *         enviar o NFT com `data = abi.encode(key)` para o staker via
     *         `safeTransferFrom`.
     * @param key Ver {IncentiveKey}.
     * @param tokenId NFT id (Uniswap V3 NonfungiblePositionManager).
     */
    function stakeToken(IncentiveKey calldata key, uint256 tokenId) external;

    /**
     * @notice Desfaz o stake do NFT em `key`. Acumula rewards pendentes em
     *         {rewards}.
     * @param key Ver {IncentiveKey}.
     * @param tokenId NFT id.
     */
    function unstakeToken(IncentiveKey calldata key, uint256 tokenId) external;

    /**
     * @notice Transfere `amountRequested` (ou todo o saldo se for 0) de
     *         `rewardToken` para `to`.
     * @param rewardToken Token a sacar (CREDIT).
     * @param to Destinatario do reward.
     * @param amountRequested 0 = tudo disponivel; caso contrario o min entre
     *                        request e disponivel.
     * @return reward Quantidade efetivamente transferida.
     */
    function claimReward(IERC20 rewardToken, address to, uint256 amountRequested) external returns (uint256 reward);

    /**
     * @notice Saldo de rewards acumulados para `(rewardToken, owner)`.
     * @param rewardToken Token (CREDIT).
     * @param owner Endereco que detem o stake (no nosso caso, sempre o gauge).
     * @return reward Saldo acumulado pendente de claim.
     */
    function rewards(IERC20 rewardToken, address owner) external view returns (uint256 reward);

    /**
     * @notice Remove o NFT do staker e o transfere para `to`. So pode ser
     *         chamado pelo "owner" registrado no deposito (= o gauge, depois
     *         que o usuario depositou via safeTransferFrom).
     * @param tokenId NFT id.
     * @param to Destinatario.
     * @param data Calldata opcional repassada ao receiver.
     */
    function withdrawToken(uint256 tokenId, address to, bytes calldata data) external;
}
