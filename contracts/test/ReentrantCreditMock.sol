// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ReentrantCreditMock
 * @notice Mock que imita a ABI minima de {CreditToken} esperada pelo
 *         {RewardDistributor} (`mint(address,uint256,string)`), e durante
 *         o `mint` tenta reentrar no alvo configurado. Serve para exercer
 *         a branch de revert do modifier `nonReentrant` em
 *         {RewardDistributor.claim} / {RewardDistributor.claimMany},
 *         que, no caminho feliz, nao tem callback natural (o CreditToken
 *         real nao possui hook).
 * @dev Exclusivamente para testes. NAO deploy em producao.
 *
 *      Passado ao constructor do RewardDistributor via `address(mock)`:
 *      o cast `CreditToken(credit_)` nao valida layout em runtime — basta
 *      o selector de `mint(address,uint256,string)` existir no runtime
 *      bytecode deste contrato.
 */
contract ReentrantCreditMock {
    address public attackTarget;
    bytes public attackCalldata;
    bool public attackArmed;

    uint256 public mintCalls;

    /// @notice Arma a reentrada. Proxima `mint` chama `target.call(data)`.
    function armCall(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
        attackArmed = true;
    }

    function disarm() external {
        attackArmed = false;
    }

    /**
     * @notice Imita `CreditToken.mint(address,uint256,string)`. Durante
     *         a execucao, se armado, chama `attackTarget.call(attackCalldata)`.
     *         O revert do alvo propaga via bubble-up para que o teste
     *         veja o `ReentrancyGuardReentrantCall` vindo do guard.
     * @dev Argumentos sao ignorados — o mock nao precisa cunhar nada
     *      para exercer o guard do caller.
     */
    function mint(address, uint256, string calldata) external {
        mintCalls += 1;
        if (attackArmed) {
            attackArmed = false;
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, bytes memory ret) = attackTarget.call(attackCalldata);
            if (!ok) {
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
