/**
 * dev-bootstrap.ts
 *
 * Prepara a cadeia local pra exercitar o fluxo de governança:
 *   1. Minta GOV para um endereço (default: o próprio deployer, Account #0)
 *   2. Delega o voto desse endereço pra si mesmo (sem isso ERC20Votes não conta)
 *
 * Rode DEPOIS do Ignition deploy. Só funciona enquanto o deployer ainda for
 * `owner()` do GovernanceToken — que é o caso durante o bootstrap (até a
 * proposta `acceptOwnership` executar).
 *
 * Uso:
 *   MINT_TO=0x... MINT_AMOUNT=1000000 \
 *     npx hardhat run scripts/dev-bootstrap.ts --network localhost
 *
 * Defaults:
 *   MINT_TO     = deployer (Account #0, 0xf39Fd6…)
 *   MINT_AMOUNT = 1_000_000 (em GOV, não wei — o script multiplica por 1e18)
 */
import { ethers } from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  const deployFile = resolve(
    __dirname,
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json",
  );
  if (!existsSync(deployFile)) {
    throw new Error(`nao encontrei ${deployFile} — rode o Ignition primeiro`);
  }

  const addrs = JSON.parse(readFileSync(deployFile, "utf8")) as Record<string, string>;
  const govAddr = addrs["CommunityDAOModule#phaseA_GovernanceToken"];
  if (!govAddr) throw new Error("GovernanceToken nao encontrado no deployed_addresses.json");

  const gov = await ethers.getContractAt("GovernanceToken", govAddr);

  const owner = await gov.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `deployer nao e mais owner do GOV (owner=${owner}). Bootstrap so funciona antes do acceptOwnership.`,
    );
  }

  const mintTo = process.env.MINT_TO || deployer.address;
  const amountWhole = BigInt(process.env.MINT_AMOUNT || "1000000");
  const amountWei = amountWhole * 10n ** 18n;

  console.log(`minting ${amountWhole} GOV -> ${mintTo}`);
  const tx1 = await gov.mint(mintTo, amountWei, "dev-bootstrap");
  await tx1.wait();

  const balance: bigint = await gov.balanceOf(mintTo);
  console.log(`  balance = ${ethers.formatEther(balance)} GOV`);

  // Delega pra si mesmo SE o target for o próprio deployer OU SE MINT_TO
  // coincide com um signer que temos em mãos. Caso contrário, imprime
  // instrução: o destinatário tem que delegar na UI/hub.
  const signers = await ethers.getSigners();
  const targetSigner = signers.find((s) => s.address.toLowerCase() === mintTo.toLowerCase());

  if (targetSigner) {
    console.log(`delegating voting power: ${mintTo} -> self`);
    const govAsTarget = gov.connect(targetSigner);
    const tx2 = await govAsTarget.delegate(mintTo);
    await tx2.wait();
    const votes: bigint = await gov.getVotes(mintTo);
    console.log(`  voting power = ${ethers.formatEther(votes)} GOV`);
  } else {
    console.log(
      `(aviso) ${mintTo} nao e um signer local. Voce precisa chamar gov.delegate(self) na UI antes de votar.`,
    );
  }

  console.log(`\npronto. gov = ${govAddr}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
