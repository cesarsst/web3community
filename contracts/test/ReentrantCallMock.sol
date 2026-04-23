// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReentrantCallMock
 * @notice ERC-20 malicioso generico que, durante `_update`, executa um
 *         `call` arbitrario (endereco + calldata) contra um alvo — serve
 *         para testar o `ReentrancyGuard` de qualquer funcao `nonReentrant`
 *         que interaja com este token via `transfer`/`transferFrom`.
 * @dev Exclusivamente para testes. NAO deploy em producao.
 *
 *      Uso tipico:
 *       1. Deploy o mock e passe-o como o ERC-20 do contrato-alvo
 *          (ex.: `UserSubsidy(credit_)` recebe o mock).
 *       2. Seed o alvo com saldo do mock (`mint(target, amount)`).
 *       3. Arme o ataque via {armCall} apontando para a funcao
 *          `nonReentrant` que queremos reentrar, com o calldata apropriado.
 *       4. Dispare a transacao que provocara o transfer interno — o hook
 *          `_update` executara o `call` armado, que entrara novamente no
 *          guard e fara a chamada externa reverter com
 *          `ReentrancyGuardReentrantCall`.
 *
 *      Diferencas para {ReentrantERC20Mock}:
 *       - Suporta reentrada em *qualquer* funcao (calldata arbitrario),
 *         nao apenas em `transfer(address,address,uint256)` — necessario
 *         para cobrir `batchTransfer`, `payRebates`, `executeBuyback`,
 *         `claim`, `closeCampaign`, etc.
 *       - Filtro opcional por `triggerOnFrom` / `triggerOnTo`: dispara
 *         a reentrada apenas quando a transferencia envolve um dos
 *         enderecos configurados (evita loops quando o mock e movido
 *         entre varias contas durante o setup).
 */
contract ReentrantCallMock is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    address public triggerOnFrom;
    address public triggerOnTo;
    bool public attackArmed;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Minta livremente para seed em testes.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Arma a reentrada. Proximo `_update` que case o filtro
     *         executa `target.call(data)`.
     * @dev Setar `triggerOnFrom = address(0)` desliga o filtro por
     *      `from`; idem para `triggerOnTo`. Se ambos forem `address(0)`,
     *      dispara no primeiro `_update` — use com cuidado para nao
     *      pegar o `mint` de seed.
     */
    function armCall(address target, bytes calldata data, address fromFilter, address toFilter) external {
        attackTarget = target;
        attackCalldata = data;
        triggerOnFrom = fromFilter;
        triggerOnTo = toFilter;
        attackArmed = true;
    }

    function disarm() external {
        attackArmed = false;
    }

    /**
     * @dev Hook OZ 5.x. Auto-desarma apos o primeiro disparo para nao
     *      entrar em loop caso o guard do alvo seja — incorretamente —
     *      permissivo. O retorno do `call` e ignorado: o objetivo e
     *      apenas *disparar* o reentry; se o alvo reverter, o revert
     *      propaga para a transacao raiz via `safeTransfer` do caller,
     *      que e o comportamento esperado quando o guard esta presente.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (attackArmed) {
            bool fromOk = triggerOnFrom == address(0) || from == triggerOnFrom;
            bool toOk = triggerOnTo == address(0) || to == triggerOnTo;
            if (fromOk && toOk) {
                attackArmed = false;
                // Encaminha o revert do alvo para garantir que a
                // transacao raiz aborte — o `safeTransfer` do caller
                // ja faria isso, mas bubble-up explicito torna o teste
                // mais direto e o motivo do revert mais obvio.
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
        super._update(from, to, value);
    }
}
