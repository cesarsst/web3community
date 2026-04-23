/**
 * Helpers compartilhados pelos templates de propostas em `scripts/proposals/`.
 *
 * Centraliza: leitura do `deployed_addresses.json` do Ignition, resolucao
 * de enderecos dos contratos core, submissao da proposta e pretty-print
 * da saida auditavel.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import hre, { ethers } from "hardhat";

export type CoreAddresses = {
  gov: string;
  credit: string;
  timelock: string;
  treasury: string;
  governor: string;
  registry: string;
};

/**
 * Le o `deployed_addresses.json` do Ignition para o chain atual e
 * devolve os enderecos dos contratos core. Falha explicitamente se
 * o arquivo nao existir — em prod o operador deve ter deployado
 * o `Dao.ts` antes de rodar qualquer script de proposta.
 */
export async function loadCoreAddresses(): Promise<CoreAddresses> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployFile = resolve(
    __dirname,
    "..",
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json",
  );
  if (!existsSync(deployFile)) {
    throw new Error(
      `deployed_addresses.json nao encontrado em ${deployFile}.\n` +
        `Rode o deploy do core DAO primeiro: npx hardhat ignition deploy ./ignition/modules/Dao.ts --network <rede>`,
    );
  }
  const raw = JSON.parse(readFileSync(deployFile, "utf8")) as Record<string, string>;
  return {
    gov: raw["CommunityDAOModule#phaseA_GovernanceToken"],
    credit: raw["CommunityDAOModule#phaseA_CreditToken"],
    timelock: raw["CommunityDAOModule#phaseA_CommunityTimelock"],
    treasury: raw["CommunityDAOModule#phaseA_Treasury"],
    governor: raw["CommunityDAOModule#phaseA_CommunityGovernor"],
    registry: raw["CommunityDAOModule#phaseA_ProjectRegistry"],
  };
}

/**
 * Le o endereco de um modulo Ignition standalone (UserSubsidy,
 * TeamVesting). Retorna `undefined` se o deploy ainda nao existir.
 */
export function loadModuleAddress(
  chainId: number,
  moduleId: string,
  contractId: string,
): string | undefined {
  const deployFile = resolve(
    __dirname,
    "..",
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json",
  );
  if (!existsSync(deployFile)) return undefined;
  const raw = JSON.parse(readFileSync(deployFile, "utf8")) as Record<string, string>;
  return raw[`${moduleId}#${contractId}`];
}

/**
 * Submete uma proposta ao `CommunityGovernor` e imprime as
 * informacoes auditaveis necessarias para queue/execute futuros.
 *
 * O Governor exige que o chamador tenha >= proposalThreshold GOV
 * delegado no bloco anterior ao propose(). Em dev, o
 * deploy-dev.ts ja faz o delegate pro deployer.
 */
export async function submitProposal(
  governorAddress: string,
  targets: string[],
  values: bigint[],
  calldatas: string[],
  description: string,
): Promise<{ proposalId: bigint; descriptionHash: string }> {
  const governor = await ethers.getContractAt("CommunityGovernor", governorAddress);

  // Threshold check — falha rapido com mensagem clara.
  const [signer] = await ethers.getSigners();
  const threshold: bigint = await governor.proposalThreshold();
  const gov = await ethers.getContractAt("GovernanceToken", (await loadCoreAddresses()).gov);
  const votes: bigint = await gov.getVotes(signer.address);
  if (votes < threshold) {
    throw new Error(
      `voting power insuficiente pra propor: ${ethers.formatEther(votes)} GOV delegado, threshold = ${ethers.formatEther(threshold)}. Lembre-se de gov.delegate(self) e cunhar o suficiente.`,
    );
  }

  const tx = await governor.propose(targets, values, calldatas, description);
  const receipt = await tx.wait();
  const proposalId = (
    receipt!.logs as Array<{ fragment?: { name: string }; args?: { proposalId: bigint } }>
  )
    .filter((l) => l.fragment?.name === "ProposalCreated")
    .map((l) => l.args!.proposalId)[0];

  const descriptionHash = ethers.id(description);

  return { proposalId, descriptionHash };
}

/**
 * Imprime o "pacote auditavel" de uma proposta: todo o estado
 * necessario pra auditor externo reconstruir a chamada e pra
 * operador fechar o ciclo via `queue()`/`execute()`.
 */
export function printProposalSummary(args: {
  proposalId: bigint;
  descriptionHash: string;
  description: string;
  targets: string[];
  values: bigint[];
  calldatas: string[];
}): void {
  console.log("\n" + "=".repeat(72));
  console.log("PROPOSTA CRIADA");
  console.log("=".repeat(72));
  console.log(`proposalId       = ${args.proposalId}`);
  console.log(`descriptionHash  = ${args.descriptionHash}`);
  console.log(`\ndescription:\n${args.description}`);
  console.log("\ntargets:");
  args.targets.forEach((t, i) => console.log(`  [${i}] ${t}`));
  console.log("\nvalues (wei):");
  args.values.forEach((v, i) => console.log(`  [${i}] ${v}`));
  console.log("\ncalldatas:");
  args.calldatas.forEach((c, i) => console.log(`  [${i}] ${c}`));
  console.log("\npara executar o ciclo (apos votingDelay + votingPeriod):");
  console.log(`  governor.queue(targets, values, calldatas, descriptionHash)`);
  console.log(`  governor.execute(targets, values, calldatas, descriptionHash)`);
  console.log("=".repeat(72));
}

/**
 * Le um JSON de configuracao relativo ao diretorio `scripts/proposals/`.
 * Caminho passado via env `PROPOSAL_CONFIG=<path>` com fallback para um
 * default fornecido pelo chamador.
 */
export function loadConfig<T>(defaultPath: string): T {
  const configPath = resolve(__dirname, process.env.PROPOSAL_CONFIG ?? defaultPath);
  if (!existsSync(configPath)) {
    throw new Error(
      `config nao encontrada em ${configPath}.\n` +
        `Passe via PROPOSAL_CONFIG=<path> ou crie o arquivo default.`,
    );
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as T;
}

/**
 * Chain ID corrente (resolvido via provider).
 */
export async function getChainId(): Promise<number> {
  return Number((await ethers.provider.getNetwork()).chainId);
}

/**
 * Re-exporta `hre` para uso explicito em scripts que precisam de
 * `hre.ignition.deploy(...)`.
 */
export { hre };
