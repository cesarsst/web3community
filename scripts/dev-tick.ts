/**
 * dev-tick.ts
 *
 * Avança a cadeia local em N blocos e/ou K segundos. Útil pra passar:
 *   - `votingDelay` (1 bloco em dev) antes de votar
 *   - `votingPeriod` (50 blocos em dev) antes de `queue()`
 *   - `timelockMinDelay` (3600s em dev) antes de `execute()`
 *
 * Uso:
 *   BLOCKS=1 npx hardhat run scripts/dev-tick.ts --network localhost
 *   SECONDS=3700 BLOCKS=1 npx hardhat run scripts/dev-tick.ts --network localhost
 *   BLOCKS=60 npx hardhat run scripts/dev-tick.ts --network localhost
 *
 * Observações:
 *   - `evm_increaseTime` só aumenta o timestamp do PRÓXIMO bloco minerado.
 *     Por isso combine com BLOCKS>=1 quando quer que o tempo avance de fato.
 *   - `hardhat_mine(N)` minera N blocos num só passo (eficiente pra passar
 *     votingPeriod sem gerar dezenas de txs).
 */
import { ethers, network } from "hardhat";

async function main() {
  const blocks = Number(process.env.BLOCKS || 0);
  const seconds = Number(process.env.SECONDS || 0);

  if (seconds > 0) {
    await network.provider.send("evm_increaseTime", [seconds]);
    console.log(`+${seconds}s no próximo bloco`);
  }

  if (blocks > 0) {
    await network.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
    console.log(`+${blocks} bloco(s) minerados`);
  }

  const bn = await ethers.provider.getBlockNumber();
  const blk = await ethers.provider.getBlock(bn);
  console.log(`\nestado atual:`);
  console.log(`  block:     ${bn}`);
  console.log(
    `  timestamp: ${blk?.timestamp} (${new Date(Number(blk?.timestamp) * 1000).toISOString()})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
