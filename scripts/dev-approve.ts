/**
 * dev-approve.ts
 *
 * Helper pra conceder ERC20 allowance. Usado antes de `registerProject`
 * (dono do projeto precisa aprovar o Registry pra puxar o colateral em GOV).
 *
 * Uso:
 *   npx hardhat run scripts/dev-approve.ts --network localhost            # defaults
 *   TOKEN=GovernanceToken SPENDER=ProjectRegistry AMOUNT=1000 \
 *     npx hardhat run scripts/dev-approve.ts --network localhost
 *
 * Defaults: aprova Registry pra gastar 1000 GOV do Account #0.
 */
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const [owner] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const addrs = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        "..",
        "ignition",
        "deployments",
        `chain-${chainId}`,
        "deployed_addresses.json",
      ),
      "utf8",
    ),
  ) as Record<string, string>;

  const tokenName = process.env.TOKEN || "GovernanceToken";
  const spenderName = process.env.SPENDER || "ProjectRegistry";
  const amountWhole = BigInt(process.env.AMOUNT || "1000");

  const tokenAddr = addrs[`CommunityDAOModule#phaseA_${tokenName}`];
  const spenderAddr = addrs[`CommunityDAOModule#phaseA_${spenderName}`];
  if (!tokenAddr || !spenderAddr) {
    throw new Error(`addresses nao encontrados: token=${tokenAddr} spender=${spenderAddr}`);
  }

  const token = await ethers.getContractAt(tokenName, tokenAddr);
  const amountWei = amountWhole * 10n ** 18n;

  console.log(`${owner.address} approves`);
  console.log(`  spender: ${spenderName} @ ${spenderAddr}`);
  console.log(`  amount:  ${amountWhole} ${tokenName} (${amountWei} wei)`);

  const tx = await token.approve(spenderAddr, amountWei);
  await tx.wait();

  const allowance: bigint = await token.allowance(owner.address, spenderAddr);
  console.log(`\nallowance agora = ${ethers.formatEther(allowance)} ${tokenName}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
