// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ITreasuryRewards
 * @notice Interface slim consumida por `RewardDistributorV2` para empurrar
 *         os buckets "bonders" (refill POL) e "fallback gauge" (quando
 *         `LiquidityGauge` esta paused) para o {Treasury} sem criar
 *         dependencia circular de import (Treasury ja importa interfaces
 *         externas e este package nao deve importar contratos completos).
 * @dev As duas funcoes referenciadas exigem que o Treasury ja tenha CREDIT
 *      cunhado em `address(treasury)` antes do call — o V2 mint+call em
 *      sequencia, dentro da mesma `finalizeRound`. As roles que governam
 *      o acesso (`POL_REFILL_DEPOSITOR_ROLE`, `GAUGE_FALLBACK_DEPOSITOR_ROLE`)
 *      sao definidas no Treasury; este interface nao reflete granularidade
 *      de role intencionalmente para nao quebrar evolucao da implementacao.
 */
interface ITreasuryRewards {
    /// @notice Acumula `amount` no ledger interno `polRefillBucket`. Caller
    ///         deve ter cunhado o CREDIT no Treasury antes da chamada.
    function depositPolRefill(uint256 amount) external;

    /// @notice Acumula `amount` no ledger interno `pendingGaugeRewards`.
    ///         Usado pelo distributor V2 como fallback quando o gauge
    ///         esta paused no momento de `finalizeRound`.
    function depositPendingGaugeRewards(uint256 amount) external;
}
