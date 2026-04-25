/**
 * execute-fase0-default-split.ts
 *
 * Fecha o ciclo da proposta criada por
 * `scripts/governance/propose-fase0-default-split.ts`. Verifica o estado da
 * proposta e, conforme o estado, executa a transicao apropriada:
 *
 *   Succeeded  -> queue() + (espera o timelock externamente) + execute()
 *   Queued     -> execute() (se timelock ja maturou)
 *   Executed   -> noop (idempotente)
 *
 * NAO espera ativamente o timelock: se a proposta acabou de entrar em queue,
 * informa o ETA e termina. O operador re-roda este mesmo script depois.
 *
 * Targets/values/calldatas sao reconstruidos com EXATAMENTE os mesmos bytes
 * usados em propose-fase0-default-split.ts — qualquer divergencia produz
 * `descriptionHash` diferente e o Governor reverte com `GovernorNonexistentProposal`.
 *
 * Uso:
 *   npx hardhat run scripts/governance/execute-fase0-default-split.ts --network localhost
 *
 * Pre-requisitos:
 *   - Proposta ja foi criada pelo script de propose.
 *   - Voting delay + voting period ja decorreram.
 *   - Quorum atingido com voto FOR (state == Succeeded ou Queued).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "hardhat";

import { loadCoreAddresses } from "../proposals/_shared";

// MESMAS constantes do script de propose. Mantidas duplicadas (em vez de
// importadas) para que o pacote do executor seja auto-contido — se alguem
// renomeia ou move o script de propose, este aqui continua funcional desde
// que os bytes batam.
const NEW_SPLIT = {
  burnBps: 7000,
  treasuryBps: 2000,
  rebateBps: 1000,
} as const;

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

// Espelha {OZ Governor.ProposalState}.
const STATE_NAMES = [
  "Pending", // 0
  "Active", // 1
  "Canceled", // 2
  "Defeated", // 3
  "Succeeded", // 4
  "Queued", // 5
  "Expired", // 6
  "Executed", // 7
] as const;

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
      `deployed_addresses.json nao encontrado em ${deployFile}. Rode o deploy do Dao.ts primeiro.`,
    );
  }
  const raw = JSON.parse(readFileSync(deployFile, "utf8")) as Record<string, string>;
  const feeRouter = raw["CommunityDAOModule#phaseA_FeeRouter"];
  if (!feeRouter) {
    throw new Error(`Chave CommunityDAOModule#phaseA_FeeRouter ausente em ${deployFile}.`);
  }
  return feeRouter;
}

async function main() {
  const core = await loadCoreAddresses();
  const feeRouterAddr = await loadFeeRouterAddress();

  const governor = await ethers.getContractAt("CommunityGovernor", core.governor);
  const feeRouter = await ethers.getContractAt("FeeRouter", feeRouterAddr);

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

  const proposalId: bigint = await governor.hashProposal(
    targets,
    values,
    calldatas,
    descriptionHash,
  );

  const stateNum: bigint = await governor.state(proposalId);
  const stateIdx = Number(stateNum);
  const stateName = STATE_NAMES[stateIdx] ?? `Unknown(${stateIdx})`;

  console.log("=".repeat(72));
  console.log("EXECUCAO — Fase 0 default split");
  console.log("=".repeat(72));
  console.log(`proposalId  = ${proposalId}`);
  console.log(`state       = ${stateName} (${stateIdx})`);
  console.log("=".repeat(72));

  if (stateIdx === 7) {
    // Executed
    console.log("Proposta JA EXECUTADA. Verificando estado on-chain do FeeRouter...");
    const split = await feeRouter.defaultSplit();
    console.log(
      `defaultSplit = burn=${split.burnBps} treasury=${split.treasuryBps} rebate=${split.rebateBps}`,
    );
    if (
      Number(split.burnBps) !== NEW_SPLIT.burnBps ||
      Number(split.treasuryBps) !== NEW_SPLIT.treasuryBps ||
      Number(split.rebateBps) !== NEW_SPLIT.rebateBps
    ) {
      throw new Error(
        `defaultSplit on-chain (${split.burnBps}/${split.treasuryBps}/${split.rebateBps}) ` +
          `nao bate com o esperado (${NEW_SPLIT.burnBps}/${NEW_SPLIT.treasuryBps}/${NEW_SPLIT.rebateBps}).`,
      );
    }
    console.log("OK — nada a fazer.");
    return;
  }

  if (stateIdx === 2 || stateIdx === 3 || stateIdx === 6) {
    // Canceled, Defeated, Expired — caminho morto.
    throw new Error(
      `Proposta em estado terminal NAO-Executed: ${stateName}. ` +
        `Recrie via propose-fase0-default-split.ts.`,
    );
  }

  if (stateIdx === 0 || stateIdx === 1) {
    // Pending, Active — voto ainda nao concluiu.
    throw new Error(
      `Proposta ainda nao terminou voto (estado=${stateName}). Aguarde votingDelay + ` +
        `votingPeriod e que voters tenham votado FOR o suficiente para atingir quorum.`,
    );
  }

  if (stateIdx === 4) {
    // Succeeded — precisa ser enfileirada antes do execute.
    console.log("State=Succeeded. Enfileirando no Timelock...");
    const tx = await governor.queue(targets, values, calldatas, descriptionHash);
    await tx.wait();
    const eta: bigint = await governor.proposalEta(proposalId);
    const etaDate = new Date(Number(eta) * 1000).toISOString();
    console.log(`Queued. ETA do Timelock: unix=${eta} (${etaDate}).`);
    console.log(`Aguarde o delay maturar e re-rode este mesmo script para chamar execute().`);
    return;
  }

  if (stateIdx === 5) {
    // Queued — verifica ETA antes de tentar execute.
    const eta: bigint = await governor.proposalEta(proposalId);
    const block = await ethers.provider.getBlock("latest");
    const now = BigInt(block!.timestamp);
    if (now < eta) {
      const remaining = Number(eta - now);
      throw new Error(
        `Timelock ainda nao maturou. ETA=${eta} (${new Date(Number(eta) * 1000).toISOString()}); ` +
          `faltam ${remaining}s. Re-rode quando passar.`,
      );
    }
    console.log("State=Queued e Timelock maturou. Executando...");
    const tx = await governor.execute(targets, values, calldatas, descriptionHash);
    const receipt = await tx.wait();
    console.log(`Execute OK em tx ${receipt!.hash}.`);

    const split = await feeRouter.defaultSplit();
    console.log(
      `defaultSplit pos-execute = burn=${split.burnBps} treasury=${split.treasuryBps} rebate=${split.rebateBps}`,
    );
    if (
      Number(split.burnBps) !== NEW_SPLIT.burnBps ||
      Number(split.treasuryBps) !== NEW_SPLIT.treasuryBps ||
      Number(split.rebateBps) !== NEW_SPLIT.rebateBps
    ) {
      throw new Error(
        `defaultSplit on-chain pos-execute nao bate com o esperado — investigar URGENTE.`,
      );
    }
    console.log(
      "Fase 0 CONCLUIDA. Atualize o CHANGELOG conforme docs/governance/fase0-default-split.md.",
    );
    return;
  }

  throw new Error(`State desconhecido (${stateIdx}). Atualize o script.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
