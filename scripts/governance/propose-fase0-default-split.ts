/**
 * propose-fase0-default-split.ts
 *
 * Cria a proposta DAO da **Fase 0** do pivot Credit Liquidity Protocol (CLP),
 * que destrava o pre-requisito C4 (Treasury sem receita recorrente)
 * identificado em
 * `audit/economist/2026-04-24-clp-pivot.md`.
 *
 * Acao unica e atomica:
 *
 *   FeeRouter.setDefaultSplit({burnBps: 7000, treasuryBps: 2000, rebateBps: 1000})
 *
 * Efeito economico:
 *   - burn:     95% -> 70%  (mantem deflacao mas abre espaco para receita)
 *   - treasury:  0% -> 20%  (cria receita recorrente da DAO — destrava C4)
 *   - rebate:    5% -> 10%  (dobra incentivo a apps listados, alinhado a Fase 1)
 *
 * Invariantes economicas tocadas:
 *   - I2 (burn no consumo): permanece OK (burnBps = 7000 > 0).
 *   - I4 (governanca via Timelock): a propria proposta exercita o caminho.
 *
 * Modo dry-run:
 *   Setado via env var `DRY_RUN=true`. Nao submete a transacao — apenas
 *   imprime targets/values/calldatas + proposalId computado deterministicamente
 *   via {Governor.hashProposal(targets, values, calldatas, descriptionHash)}.
 *   Util para auditoria pre-on-chain e para gerar o pacote que sera anunciado
 *   off-chain (Discord, forum) antes de propose().
 *
 * Uso:
 *   # auditoria/preview, sem submeter:
 *   DRY_RUN=true npx hardhat run scripts/governance/propose-fase0-default-split.ts --network localhost
 *
 *   # submissao real:
 *   npx hardhat run scripts/governance/propose-fase0-default-split.ts --network localhost
 *
 * Pre-requisitos:
 *   - Core DAO deployado (`./ignition/modules/Dao.ts`).
 *   - GovernanceToken.acceptOwnership() ja executado pelo Timelock.
 *   - Em modo NAO-dry-run: o signer atual precisa de >= proposalThreshold GOV
 *     delegado (10_000 GOV em dev/prod por default).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "hardhat";

import { loadCoreAddresses, printProposalSummary, submitProposal } from "../proposals/_shared";

// ----------------------------------------------------------------------
// Constantes da proposta — congeladas pela decisao da Fase 0.
// ----------------------------------------------------------------------

/**
 * Split aprovado pelo user em 2026-04-24 com base em
 * `audit/economist/2026-04-24-clp-pivot.md` (alternativa B do bullet 5):
 *   70% burn / 20% treasury / 10% rebate.
 *
 * Soma == 10_000 (validado pelo {FeeRouter._requireValidSplit}).
 */
const NEW_SPLIT = {
  burnBps: 7000,
  treasuryBps: 2000,
  rebateBps: 1000,
} as const;

/**
 * Descricao canonica da proposta. O HASH desta string e parte do
 * proposalId — qualquer alteracao de byte aqui produz um proposal
 * distinto. Mantenha exatamente como esta ate execute().
 *
 * Convencao: cabecalho H1 + linhas em PT-BR, citando os pareceres
 * relevantes para auditabilidade off-chain.
 */
const DESCRIPTION = [
  "# Fase 0 do pivot CLP — atualizar split default do FeeRouter para 70/20/10",
  "",
  "Acao unica:",
  "  FeeRouter.setDefaultSplit({burnBps: 7000, treasuryBps: 2000, rebateBps: 1000})",
  "",
  "Motivacao economica (resolve C4 do parecer original):",
  "- 70% burn: mantem deflacao do CREDIT e o vinculo I2 (burn-no-consumo).",
  "- 20% treasury: cria receita recorrente da DAO; destrava o flywheel da Fase 1",
  "  (Treasury passa a acumular CREDIT proporcional ao uso real).",
  "- 10% rebate: dobra o revenue share dos apps listados, alinhado a estrategia",
  "  de incentivar listagens uteis na Fase 1.",
  "",
  "Pareceres de referencia:",
  "- audit/economist/2026-04-24-clp-pivot.md (Fase 0 hard gate, bullet 5 alt. B)",
  "- audit/economist/2026-04-24-credit-peg.md (modelo FFP — Floating com Floor",
  "  Price defendido; receita do treasury alimenta o buyback-and-burn defensivo)",
  "",
  "Invariantes:",
  "- I2 mantida: burnBps = 7000 > 0.",
  "- I4 exercitada: a propria proposta passa pelo Timelock (GOVERNANCE_ROLE).",
  "- Overrides por projeto (setProjectSplit) nao sao afetados.",
].join("\n");

// ----------------------------------------------------------------------
// Helper local: le o endereco do FeeRouter direto do
// `deployed_addresses.json` do Ignition. Nao usamos `loadCoreAddresses`
// pois ele nao expoe o feeRouter atualmente — evitamos modificar um
// helper compartilhado para esta unica adicao.
// ----------------------------------------------------------------------
async function loadFeeRouterAddress(): Promise<string> {
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
        `Rode antes: npx hardhat ignition deploy ./ignition/modules/Dao.ts --network <rede>`,
    );
  }
  const raw = JSON.parse(readFileSync(deployFile, "utf8")) as Record<string, string>;
  const feeRouter = raw["CommunityDAOModule#phaseA_FeeRouter"];
  if (!feeRouter) {
    throw new Error(
      `Chave CommunityDAOModule#phaseA_FeeRouter ausente em ${deployFile}.\n` +
        `Verifique se o deploy do Dao.ts foi concluido sem erros.`,
    );
  }
  return feeRouter;
}

async function main() {
  const dryRun = (process.env.DRY_RUN ?? "").toLowerCase() === "true";
  const core = await loadCoreAddresses();
  const feeRouterAddr = await loadFeeRouterAddress();

  // Sanity guard: o GOVERNANCE_ROLE do FeeRouter precisa estar com o Timelock.
  // Se ainda estiver com o deployer/admin (bootstrap incompleto), a proposta
  // executaria com sucesso mas via Timelock falharia o `onlyRole` no execute,
  // queimando 1 ciclo completo de governanca por nada. Falhar rapido aqui.
  const feeRouter = await ethers.getContractAt("FeeRouter", feeRouterAddr);
  const GOVERNANCE_ROLE = await feeRouter.GOVERNANCE_ROLE();
  const timelockHasRole: boolean = await feeRouter.hasRole(GOVERNANCE_ROLE, core.timelock);
  if (!timelockHasRole) {
    throw new Error(
      `Timelock (${core.timelock}) NAO detem GOVERNANCE_ROLE no FeeRouter ` +
        `(${feeRouterAddr}). Bootstrap incompleto — execute antes a proposta de ` +
        `transferencia de roles, ou rode o caminho de dev em deploy-dev.ts.`,
    );
  }

  // Codifica a calldata. O FeeRouter expoe `setDefaultSplit(Split calldata)`
  // como um unico arg struct; ethers v6 aceita o objeto literal posicional
  // diretamente desde que a ordem dos campos seja respeitada.
  const calldata = feeRouter.interface.encodeFunctionData("setDefaultSplit", [
    {
      burnBps: NEW_SPLIT.burnBps,
      treasuryBps: NEW_SPLIT.treasuryBps,
      rebateBps: NEW_SPLIT.rebateBps,
    },
  ]);

  const targets = [feeRouterAddr];
  const values = [0n];
  const calldatas = [calldata];
  const descriptionHash = ethers.id(DESCRIPTION);

  // proposalId determinstico — mesmo formato usado pelo Governor para
  // hashProposal: keccak(abi.encode(targets, values, calldatas, descriptionHash)).
  // Em ethers v6 o helper esta exposto via Governor.hashProposal, e replicamos
  // off-chain por simetria com o pacote auditavel printado.
  const governor = await ethers.getContractAt("CommunityGovernor", core.governor);
  const computedProposalId: bigint = await governor.hashProposal(
    targets,
    values,
    calldatas,
    descriptionHash,
  );

  console.log("=".repeat(72));
  console.log(dryRun ? "DRY-RUN (nao submete)" : "SUBMETENDO PROPOSTA");
  console.log("=".repeat(72));
  console.log(`network          = chainId ${(await ethers.provider.getNetwork()).chainId}`);
  console.log(`feeRouter        = ${feeRouterAddr}`);
  console.log(`governor         = ${core.governor}`);
  console.log(`timelock         = ${core.timelock}`);
  console.log(`split atual      = (lendo on-chain)`);
  const current = await feeRouter.defaultSplit();
  console.log(
    `                   burn=${current.burnBps} treasury=${current.treasuryBps} rebate=${current.rebateBps}`,
  );
  console.log(
    `split proposto   = burn=${NEW_SPLIT.burnBps} treasury=${NEW_SPLIT.treasuryBps} rebate=${NEW_SPLIT.rebateBps}`,
  );
  console.log(`proposalId hash  = ${computedProposalId}`);
  console.log(`descriptionHash  = ${descriptionHash}`);
  console.log(`calldata         = ${calldata}`);
  console.log("=".repeat(72));

  if (dryRun) {
    console.log("\nDRY-RUN: nada foi enviado on-chain.");
    console.log("Para submeter de fato, rode novamente sem DRY_RUN=true (ou com DRY_RUN=false).");
    return;
  }

  const { proposalId, descriptionHash: descHashFromSubmit } = await submitProposal(
    core.governor,
    targets,
    values,
    calldatas,
    DESCRIPTION,
  );

  // Sanity: o id retornado pelo evento deve bater com o computado.
  if (proposalId !== computedProposalId) {
    throw new Error(
      `proposalId divergente — submetido=${proposalId}, computado=${computedProposalId}. ` +
        `Isso indica algum desvio entre encodeFunctionData e o que o Governor recebeu. ` +
        `NAO prossiga com queue/execute sem investigar.`,
    );
  }
  if (descHashFromSubmit !== descriptionHash) {
    throw new Error(
      `descriptionHash divergente — algo alterou DESCRIPTION entre o calculo e o submit.`,
    );
  }

  printProposalSummary({
    proposalId,
    descriptionHash,
    description: DESCRIPTION,
    targets,
    values,
    calldatas,
  });

  console.log("\nFase 0 — proposta SUBMETIDA. Proximo passo:");
  console.log("  1. votingDelay (1 block dev / 7200 blocks prod)");
  console.log("  2. voters chamam castVote(proposalId, 1) durante o voting period");
  console.log("  3. governor.queue(...) -> aguardar timelockMinDelay");
  console.log("  4. rodar scripts/governance/execute-fase0-default-split.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
