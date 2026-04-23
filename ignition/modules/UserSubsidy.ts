import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * UserSubsidyModule — deploy standalone do `UserSubsidy` (singleton).
 *
 * Decisoes arquiteturais:
 *
 * 1) MODULO SEPARADO do `Dao.ts`. O modulo principal (`CommunityDAOModule`)
 *    deliberadamente NAO deploya contratos de distribuicao — ver header do
 *    `Dao.ts`, decisao (2). A distribuicao (rewards de comunidade, vesting
 *    do time, subsidios de usuarios) acontece via propostas do Governor
 *    apos o bootstrap. Este modulo pode ser rodado independentemente, apos
 *    o core DAO ja existir na rede, passando os enderecos via parametros.
 *
 * 2) UserSubsidy e SINGLETON. Deploy uma unica vez; campanhas multiplas
 *    sao criadas dentro dele via `createCampaign(...)` por propostas do
 *    Governor. Nao faz sentido deploy-por-campanha — desperdica gas e
 *    fragmenta o indexing off-chain.
 *
 * 3) `adminAddress` DEVE ser o CommunityTimelock em producao. O modulo
 *    aceita qualquer endereco via parametro para facilitar dev/testnet,
 *    mas a auditoria do deploy precisa confirmar que em mainnet o admin
 *    efetivo e o Timelock (ou transferido imediatamente depois via um
 *    `grantRole(GOVERNANCE_ROLE, timelock)` + `renounceRole` do deployer).
 *
 * 4) NAO funda o contrato com CREDIT aqui. O funding ocorre na MESMA
 *    proposta que cria uma campanha — ver `UserSubsidy.sol` NatSpec:
 *    `Treasury.transfer(credit, userSubsidy, budget)` + `createCampaign(...)`
 *    em um `TimelockBatch`. Manter a camada de deploy separada da camada
 *    de funding simplifica a reentrada em caso de redeploy acidental.
 *
 * Uso:
 *   npx hardhat ignition deploy ./ignition/modules/UserSubsidy.ts \
 *     --parameters ignition/parameters/userSubsidy.dev.json \
 *     --network localhost
 *
 * @custom:security-contact security@web3community.example
 */
const UserSubsidyModule = buildModule("UserSubsidyModule", (m) => {
  // Endereco do CreditToken ja deployado (via Dao.ts). Obrigatorio.
  const creditAddress = m.getParameter<string>("creditAddress");

  // Endereco que recebe DEFAULT_ADMIN_ROLE + GOVERNANCE_ROLE. Em producao =
  // Timelock. Em dev/testnet pode ser o deployer ou um signer arbitrario
  // para permitir `createCampaign` direto durante testes locais.
  const adminAddress = m.getParameter<string>("adminAddress");

  const userSubsidy = m.contract("UserSubsidy", [creditAddress, adminAddress], {
    id: "UserSubsidy",
  });

  return { userSubsidy };
});

export default UserSubsidyModule;
