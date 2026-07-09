// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title CommunityTimelock
 * @notice Wrapper identitario sobre {TimelockController} da OpenZeppelin 5.0.x
 *         que executa, com delay, todas as decisoes aprovadas pelo
 *         {CommunityGovernor} da DAO Web3Community. Em producao e o unico
 *         portador de {GOVERNANCE_ROLE} / {DEFAULT_ADMIN_ROLE} nos contratos
 *         economicos (Treasury, ProjectRegistry, Staking, CreditPSM,
 *         ProjectFunding, FeeRouterV2) e o unico `owner` do {GovernanceToken}
 *         apos o bootstrap de producao.
 * @dev O wrapper e propositalmente sem codigo adicional — herda {TimelockController}
 *      integralmente. A motivacao e manter identidade on-chain (nome do contrato
 *      no Etherscan = CommunityTimelock, ao inves de TimelockController generico)
 *      e concentrar NatSpec de deploy num unico lugar, sem introduzir superficie
 *      de bug extra. Alteracoes comportamentais futuras (ex.: blocklist de
 *      selectors, guarda de emergencia) devem vir como extensoes explicitas em
 *      contrato separado, nunca reescrevendo esta unidade.
 *
 *      Invariantes atendidas aqui (no par Timelock + Governor):
 *      - I4: contratos economicos cedem {GOVERNANCE_ROLE} / `owner` ao
 *        TimelockController; nenhuma EOA retem poder unilateral apos o wiring
 *        de producao.
 *      - I7: {ProjectRegistry} so aceita {GOVERNANCE_ROLE} nas funcoes de
 *        registro; so o Timelock (apos proposta aprovada) satisfaz o gate.
 *
 *      Estrategia de roles recomendada no deploy (via Ignition na parte 2/2):
 *      1. Deploy do CommunityTimelock com `proposers = []`, `executors = [0x0]`
 *         (qualquer um pode executar o que ja foi scheduled) e `admin = deployer`.
 *      2. Deploy do CommunityGovernor apontando para este Timelock.
 *      3. O deployer concede PROPOSER_ROLE e CANCELLER_ROLE ao Governor.
 *         (Nao concedemos EXECUTOR_ROLE explicitamente — {address(0)} no array
 *         de executors ja permite execucao publica apos o delay, reduzindo
 *         vetor de captura.)
 *      4. O deployer renuncia DEFAULT_ADMIN_ROLE em si mesmo. A partir dai o
 *         Timelock e self-administered e so pode ter roles alteradas por
 *         proposta do Governor — cumprindo o "Timelock e sua propria fonte de
 *         verdade".
 *
 *      Motivo de {address(0)} como executor: os parametros e targets da proposta
 *      ja sao imutaveis apos schedule, e o delay ja expirou quando alguem
 *      chama {executeBatch}. Exigir EXECUTOR_ROLE apenas adicionaria friccao
 *      operacional (precisariamos sempre ter um executor EOA ativo), sem
 *      ganho de seguranca real — qualquer parte pode clicar "execute" numa
 *      proposta vencida sem alterar o resultado.
 *
 *      CANCELLER_ROLE segue com o Governor porque {GovernorTimelockControl._cancel}
 *      invoca {TimelockController.cancel} ao cancelar uma proposta via governanca.
 *      NAO concedemos CANCELLER_ROLE a ninguem mais (nem multisig guardian no v1):
 *      um cancelador externo pode DoSar propostas validas, o que viola o
 *      principio "o voto e a fonte de verdade".
 *
 * @custom:security-contact security@web3community.example
 */
contract CommunityTimelock is TimelockController {
    /**
     * @notice Cria o CommunityTimelock com a configuracao inicial de roles.
     * @dev Repassa todos os parametros para o constructor do {TimelockController}
     *      da OpenZeppelin sem alteracao. Ver a NatSpec do contrato para a
     *      estrategia canonica de deploy recomendada pelo projeto.
     * @param minDelay Delay minimo (em segundos) entre schedule e execucao de
     *                 qualquer operacao. Valor de producao sugerido: 172800 (2
     *                 dias). Valor de dev/test sugerido: 3600 (1 hora).
     * @param proposers Enderecos iniciais com PROPOSER_ROLE e CANCELLER_ROLE.
     *                  No deploy recomendado: `[]` — o Governor recebe ambas
     *                  as roles apos seu deploy via {grantRole} executado pelo
     *                  admin temporario.
     * @param executors Enderecos iniciais com EXECUTOR_ROLE. Recomendado:
     *                  `[address(0)]`, o que autoriza qualquer remetente a
     *                  executar operacoes ja vencidas (o delay e o gate real).
     * @param admin Admin inicial com DEFAULT_ADMIN_ROLE; tipicamente o deployer,
     *              que renuncia a role ao final do bootstrap para que o
     *              Timelock passe a ser self-administered.
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
