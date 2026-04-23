/**
 * deploy-user-subsidy.ts
 *
 * Deploya o singleton `UserSubsidy` via o modulo Ignition standalone
 * `ignition/modules/UserSubsidy.ts`, apontando o admin (DEFAULT_ADMIN_ROLE
 * + GOVERNANCE_ROLE) direto pro CommunityTimelock. Como a unica operacao
 * neste momento e o deploy do contrato (nao ha mint nem transfer), NAO e
 * necessaria uma proposta do Governor — apenas rodar este script uma vez.
 *
 * Se quiser reexecutar o deploy (ex.: redeploy em testnet), apague o
 * `ignition/deployments/chain-<id>/deployed_addresses.json` ou passe
 * `--deployment-id` distinto para o ignition CLI.
 *
 * Uso:
 *   npx hardhat run scripts/proposals/deploy-user-subsidy.ts --network localhost
 *
 * Pre-requisitos:
 *   - Core DAO ja deployado (deployed_addresses.json existe).
 */
import { ethers } from "hardhat";
import UserSubsidyModule from "../../ignition/modules/UserSubsidy";
import { loadCoreAddresses, loadModuleAddress, getChainId, hre } from "./_shared";

async function main() {
  const core = await loadCoreAddresses();
  const chainId = await getChainId();

  const existing = loadModuleAddress(chainId, "UserSubsidyModule", "UserSubsidy");
  if (existing) {
    const code = await ethers.provider.getCode(existing);
    if (code !== "0x") {
      console.log(`UserSubsidy ja deployado em ${existing}. Skip.`);
      return;
    }
  }

  console.log("deployando UserSubsidy via Ignition…");
  console.log(`  creditAddress = ${core.credit}`);
  console.log(`  adminAddress  = ${core.timelock}  (CommunityTimelock)`);

  const { userSubsidy } = await hre.ignition.deploy(UserSubsidyModule, {
    parameters: {
      UserSubsidyModule: {
        creditAddress: core.credit,
        adminAddress: core.timelock,
      },
    },
  });

  const addr = await userSubsidy.getAddress();
  console.log(`\nUserSubsidy = ${addr}`);
  console.log(`\nproximo passo: criar a primeira campanha via`);
  console.log(`  npx hardhat run scripts/proposals/propose-subsidy-campaign.ts --network <rede>`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
