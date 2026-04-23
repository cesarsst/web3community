/**
 * propose-subsidy-campaign.ts
 *
 * Cria uma proposta no `CommunityGovernor` que abre UMA campanha de
 * subsidio no `UserSubsidy` pre-deployado. Dois alvos em um
 * TimelockBatch atomico:
 *
 *   [0] Treasury.transfer(credit, userSubsidy, budget)
 *         → funda o contrato com exatamente `maxClaims * amountPerUser`
 *           de CREDIT.
 *   [1] UserSubsidy.createCampaign(merkleRoot, amountPerUser, maxClaims, deadline)
 *         → abre a janela de claims.
 *
 * A atomicidade e importante: garante que nenhuma campanha existe sem
 * orcamento correspondente, e que nenhum orcamento fica ocioso sem
 * campanha aberta.
 *
 * Config (default: `./configs/subsidyCampaign.example.json`):
 *   - appName:         string identificadora (so vai na description, off-chain)
 *   - merkleRoot:      bytes32 (string hex 0x...) com a raiz da lista
 *                      off-chain de usuarios elegiveis. Leaves no formato
 *                      keccak256(bytes.concat(keccak256(abi.encode(user)))).
 *   - amountPerUserWei: CREDIT por claim (wei, 1e18 precision)
 *   - maxClaims:       numero maximo de claims exerciveis (uint32)
 *   - deadlineUnix:    timestamp Unix ate quando {claim} e permitido
 *
 * Budget e derivado = maxClaims * amountPerUserWei.
 *
 * Uso:
 *   PROPOSAL_CONFIG=./configs/subsidyCampaign.chatapp-launch.json \
 *   npx hardhat run scripts/proposals/propose-subsidy-campaign.ts --network localhost
 *
 * Pre-requisitos:
 *   - Core DAO deployado + `acceptOwnership` do GOV executado.
 *   - `UserSubsidy` deployado via `deploy-user-subsidy.ts`.
 *   - Treasury tem saldo suficiente de CREDIT (>= budget).
 *   - Chamador tem >= proposalThreshold GOV delegado.
 */
import { ethers } from "hardhat";
import {
  loadCoreAddresses,
  loadModuleAddress,
  submitProposal,
  printProposalSummary,
  loadConfig,
  getChainId,
} from "./_shared";

type Config = {
  appName: string;
  merkleRoot: string;
  amountPerUserWei: string;
  maxClaims: number;
  deadlineUnix: string;
};

async function main() {
  const config = loadConfig<Config>("./configs/subsidyCampaign.example.json");

  // Validacao
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.merkleRoot)) {
    throw new Error(`merkleRoot invalido: ${config.merkleRoot}`);
  }
  if (config.merkleRoot === ethers.ZeroHash) {
    throw new Error(`merkleRoot == ZeroHash — o contrato rejeita no createCampaign.`);
  }
  if (BigInt(config.amountPerUserWei) === 0n) {
    throw new Error(`amountPerUserWei == 0.`);
  }
  if (config.maxClaims <= 0) {
    throw new Error(`maxClaims deve ser > 0.`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(config.deadlineUnix) <= BigInt(now)) {
    throw new Error(
      `deadlineUnix ${config.deadlineUnix} <= agora ${now}. Escolha um deadline futuro.`,
    );
  }

  const core = await loadCoreAddresses();
  const chainId = await getChainId();
  const subsidyAddr = loadModuleAddress(chainId, "UserSubsidyModule", "UserSubsidy");
  if (!subsidyAddr) {
    throw new Error(
      `UserSubsidy nao deployado. Rode antes:\n  npx hardhat run scripts/proposals/deploy-user-subsidy.ts --network <rede>`,
    );
  }

  const amountPerUser = BigInt(config.amountPerUserWei);
  const maxClaims = BigInt(config.maxClaims);
  const budget = amountPerUser * maxClaims;
  const deadline = BigInt(config.deadlineUnix);

  // Sanity check: Treasury tem CREDIT suficiente?
  const credit = await ethers.getContractAt("CreditToken", core.credit);
  const treasuryBal: bigint = await credit.balanceOf(core.treasury);
  if (treasuryBal < budget) {
    throw new Error(
      `Treasury tem apenas ${ethers.formatEther(treasuryBal)} CREDIT, precisa de ${ethers.formatEther(budget)} pra fundar a campanha.`,
    );
  }

  // ---------- Codifica as duas chamadas ----------
  const treasury = await ethers.getContractAt("Treasury", core.treasury);
  const userSubsidy = await ethers.getContractAt("UserSubsidy", subsidyAddr);

  const transferCalldata = treasury.interface.encodeFunctionData("transfer", [
    core.credit,
    subsidyAddr,
    budget,
  ]);

  const createCalldata = userSubsidy.interface.encodeFunctionData("createCampaign", [
    config.merkleRoot,
    amountPerUser,
    maxClaims,
    deadline,
  ]);

  const description =
    `# Campanha de subsidio: '${config.appName}'\n\n` +
    `Abre uma campanha no UserSubsidy (${subsidyAddr}) com ` +
    `${config.maxClaims} claims de ${ethers.formatEther(amountPerUser)} CREDIT.\n\n` +
    `- Merkle root: ${config.merkleRoot}\n` +
    `- Budget total: ${ethers.formatEther(budget)} CREDIT (transferido do Treasury)\n` +
    `- Deadline: ${config.deadlineUnix} (unix)\n\n` +
    `A proposta e batch atomica:\n` +
    `  [0] Treasury.transfer(CREDIT, UserSubsidy, budget)\n` +
    `  [1] UserSubsidy.createCampaign(root, amount, maxClaims, deadline)\n`;

  const targets = [core.treasury, subsidyAddr];
  const values = [0n, 0n];
  const calldatas = [transferCalldata, createCalldata];

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

  console.log(`\nBudget total da campanha = ${ethers.formatEther(budget)} CREDIT`);
  console.log(`Deadline = ${new Date(Number(deadline) * 1000).toISOString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
