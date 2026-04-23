/**
 * propose-team-vesting.ts
 *
 * Duas operacoes em sequencia:
 *
 *   1. Deploy de UMA instancia de `TeamVesting` via o modulo Ignition
 *      standalone `ignition/modules/TeamVesting.ts`, com `owner = Timelock`
 *      (para que revogacoes futuras passem pela DAO).
 *
 *   2. Criacao de uma proposta no `CommunityGovernor` chamando
 *      `GovernanceToken.mint(vesting_addr, allocation, "team:<nome>")`.
 *      Apos execute, o contrato de vesting fica funcional — beneficiario
 *      chama `release()` a partir do cliff.
 *
 * Por que dois passos? Timelock nao deploy contratos em uma proposta
 * atomica; ver `scripts/proposals/README.md`. Se a proposta reprovar, o
 * TeamVesting fica orfao (sem GOV) e pode ser ignorado ou reaproveitado
 * numa nova proposta.
 *
 * Config:
 *   Le um JSON (default: `./configs/teamVesting.example.json`) com:
 *     - name:         string identificadora (vai na tag do mint event)
 *     - beneficiary:  endereco do membro do time
 *     - startUnix:    timestamp Unix (segundos) do inicio do vesting
 *     - cliffSeconds: duracao do cliff em segundos (ex.: 31536000 = 1 ano)
 *     - durationSeconds: duracao total em segundos, inclui cliff
 *                       (ex.: 126144000 = 4 anos)
 *     - allocationWei: quantidade de GOV a mintar (em wei, 1e18 precision)
 *
 *   Troque o arquivo via PROPOSAL_CONFIG=<path>. Um arquivo por membro.
 *
 * Uso:
 *   PROPOSAL_CONFIG=./configs/teamVesting.alice.json \
 *   npx hardhat run scripts/proposals/propose-team-vesting.ts --network localhost
 */
import { ethers } from "hardhat";
import TeamVestingModule from "../../ignition/modules/TeamVesting";
import {
  loadCoreAddresses,
  submitProposal,
  printProposalSummary,
  loadConfig,
  hre,
} from "./_shared";

type Config = {
  name: string;
  beneficiary: string;
  startUnix: string;
  cliffSeconds: string;
  durationSeconds: string;
  allocationWei: string;
};

async function main() {
  const config = loadConfig<Config>("./configs/teamVesting.example.json");

  // Validacao minima — nunca deploy com defaults perigosos.
  if (!ethers.isAddress(config.beneficiary)) {
    throw new Error(`beneficiary invalido: ${config.beneficiary}`);
  }
  if (config.beneficiary === ethers.ZeroAddress) {
    throw new Error(`beneficiary == ZeroAddress no config — aborted.`);
  }
  if (BigInt(config.startUnix) === 0n) {
    throw new Error(`startUnix == 0 no config — deploy com start zero e erro fatal.`);
  }
  if (BigInt(config.durationSeconds) === 0n) {
    throw new Error(`durationSeconds == 0 — sem duracao o cronograma nao faz sentido.`);
  }
  if (BigInt(config.cliffSeconds) > BigInt(config.durationSeconds)) {
    throw new Error(`cliff > duration — o contrato recusa no constructor.`);
  }

  const core = await loadCoreAddresses();

  // ---------- Passo 1: deploy do TeamVesting ----------
  console.log(`deployando TeamVesting para '${config.name}' (${config.beneficiary})…`);

  // Cada membro precisa de um deployment unico — usamos o nome como
  // deploymentId pro Ignition pra evitar colisao quando re-rodamos.
  const deploymentId = `TeamVesting-${config.name}`;
  const { teamVesting } = await hre.ignition.deploy(TeamVestingModule, {
    deploymentId,
    parameters: {
      TeamVestingModule: {
        tokenAddress: core.gov,
        beneficiary: config.beneficiary,
        start: BigInt(config.startUnix),
        cliff: BigInt(config.cliffSeconds),
        duration: BigInt(config.durationSeconds),
        ownerAddress: core.timelock,
      },
    },
  });
  const vestingAddr = await teamVesting.getAddress();
  console.log(`  TeamVesting = ${vestingAddr}`);
  console.log(`  owner       = ${core.timelock} (Timelock)`);

  // ---------- Passo 2: proposta de mint ----------
  const gov = await ethers.getContractAt("GovernanceToken", core.gov);

  const allocation = BigInt(config.allocationWei);
  const tag = `team:${config.name}`;
  const mintCalldata = gov.interface.encodeFunctionData("mint", [vestingAddr, allocation, tag]);

  const description =
    `# Vesting do membro '${config.name}'\n\n` +
    `Mint de ${ethers.formatEther(allocation)} GOV pra o contrato de vesting ${vestingAddr}.\n\n` +
    `- Beneficiario: ${config.beneficiary}\n` +
    `- Start: ${config.startUnix} (unix)\n` +
    `- Cliff: ${config.cliffSeconds}s\n` +
    `- Duration total: ${config.durationSeconds}s\n` +
    `- Owner do vesting: Timelock (${core.timelock})\n\n` +
    `Apos execute, o beneficiario pode chamar \`release()\` a partir de (start + cliff).`;

  console.log(
    `\ncriando proposta pra mintar ${ethers.formatEther(allocation)} GOV -> ${vestingAddr}…`,
  );

  const targets = [core.gov];
  const values = [0n];
  const calldatas = [mintCalldata];

  const { proposalId, descriptionHash } = await submitProposal(
    core.governor,
    targets,
    values,
    calldatas,
    description,
  );

  printProposalSummary({
    proposalId,
    descriptionHash,
    description,
    targets,
    values,
    calldatas,
  });

  console.log(`\nteamVestingAddress = ${vestingAddr}`);
  console.log(`Salve este endereco — o beneficiario precisara dele pra chamar release().`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
