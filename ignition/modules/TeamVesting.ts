import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * TeamVestingModule — deploy template de `TeamVesting` para UM membro do time.
 *
 * Decisoes arquiteturais:
 *
 * 1) MODULO SEPARADO do `Dao.ts` e SINGLE-BENEFICIARY. O padrao recomendado
 *    e: uma instancia por membro do time (ou por grupo custodiado por um
 *    multi-sig). Isola revogacao — se alguem sai, a DAO revoga APENAS
 *    aquela instancia sem afetar os demais contratos. Para 5 membros no
 *    time, rodar este modulo 5 vezes com parametros diferentes.
 *
 * 2) Em producao, o deploy NAO deve rodar direto via este CLI — deve ser
 *    uma proposta no Governor que, via Timelock, executa o deploy +
 *    `gov.mint(vesting_addr, alloc, "team:<nome>")` em uma unica
 *    TimelockBatch. Este modulo existe principalmente para:
 *      (a) Testes locais e integracao (via hre.ignition.deploy).
 *      (b) Dev/testnet onde o deployer ainda e admin pode deploy
 *          rapidamente para validar wiring antes do handoff.
 *      (c) Servir de template/referencia para o calldata que a proposta
 *          do Governor precisa emitir.
 *
 * 3) Todos os parametros sao obrigatorios (sem defaults) — queremos que
 *    cada deploy seja explicito sobre beneficiario/cronograma, e um
 *    erro de default silencioso (ex.: deploy com `start=0`) seria
 *    catastrofico.
 *
 * 4) NAO funda o contrato com GOV aqui. O funding (`gov.mint(vesting,
 *    amount, "team:<nome>")`) ocorre na MESMA proposta que inclui este
 *    deploy — ver `TeamVesting.sol` NatSpec. Separacao mantida por
 *    clareza de responsabilidades.
 *
 * Exemplo de parametros (cliff 12m + linear 36m = 48m totais, iniciando
 * em um timestamp concreto):
 *   {
 *     "TeamVestingModule": {
 *       "tokenAddress": "0x...GOV",
 *       "beneficiary":  "0x...member",
 *       "start":        "1735689600",    // 2025-01-01 00:00 UTC, por exemplo
 *       "cliff":        "31536000",       // 365 days
 *       "duration":     "126144000",      // 4 * 365 days
 *       "ownerAddress": "0x...timelock"
 *     }
 *   }
 *
 * Uso:
 *   npx hardhat ignition deploy ./ignition/modules/TeamVesting.ts \
 *     --parameters ignition/parameters/teamVesting.example.json \
 *     --network localhost
 *
 * @custom:security-contact security@web3community.example
 */
const TeamVestingModule = buildModule("TeamVestingModule", (m) => {
  const tokenAddress = m.getParameter<string>("tokenAddress");
  const beneficiary = m.getParameter<string>("beneficiary");
  const start = m.getParameter<bigint>("start");
  const cliff = m.getParameter<bigint>("cliff");
  const duration = m.getParameter<bigint>("duration");
  const ownerAddress = m.getParameter<string>("ownerAddress");

  const teamVesting = m.contract(
    "TeamVesting",
    [tokenAddress, beneficiary, start, cliff, duration, ownerAddress],
    { id: "TeamVesting" },
  );

  return { teamVesting };
});

export default TeamVestingModule;
