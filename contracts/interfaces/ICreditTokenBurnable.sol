// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ICreditTokenBurnable
 * @notice Interface minima do {CreditToken} usada pelo {Treasury} para
 *         queimar CREDIT comprado em buyback. Apenas {burnByRole} (gated
 *         por `BURNER_ROLE`) e exposto.
 * @dev Justificativa de uso de {burnByRole} e nao {burnFrom}+approve:
 *      - O Treasury detem o CREDIT comprado (output do swap recebido em
 *        `params.recipient = address(this)`); poderia chamar `_burn` se
 *        herdasse de ERC20Burnable, mas nao herda.
 *      - Alternativa: Treasury chama `IERC20Burnable.burn(amount)` (queima
 *        do proprio saldo). Nao usado porque o caminho `burnByRole` ja
 *        existe e e o canal canonico de queima protocolar; reutilizar
 *        mantem auditoria centralizada de burns no evento {BurnedByRole}.
 *      Pre-requisito operacional: Treasury PRECISA receber `BURNER_ROLE`
 *      no {CreditToken} antes do primeiro buyback executar. Documentado
 *      em `docs/governance/fase1-1-buyback-ffp.md`.
 */
interface ICreditTokenBurnable {
    /**
     * @notice Queima `amount` tokens de `from` SEM consumir allowance.
     *         Restrita a holders de `BURNER_ROLE` no {CreditToken}.
     * @param from Endereco cujo saldo sera queimado (Treasury usa
     *             `address(this)` apos receber CREDIT do swap).
     * @param amount Quantidade a queimar (precisao do CREDIT = 18 decimais).
     * @param tag Rotulo off-chain (ex.: "treasury:buyback").
     */
    function burnByRole(address from, uint256 amount, string calldata tag) external;
}
