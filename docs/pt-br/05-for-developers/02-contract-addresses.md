# Endereços dos contratos

**Para quem é:** dev integrando via ABI + endereço on-chain.
**Pré-requisitos:** nenhum.

## Endereços por rede

### Localhost (hardhat node)

Deploy via `npx hardhat ignition deploy ./ignition/modules/Dao.ts --parameters ignition/parameters/dev.json --network localhost`. Endereços são determinísticos conforme a ordem de deploy do Ignition, mas variam conforme o nonce do deployer. Use o output do deploy.

Os contratos do remodel (CreditPSM, FeeRouterV2, ProjectFunding) + mocks dev são deployados por `scripts/deploy-remodel.ts` e ficam em:

```
ignition/deployments/chain-31337/dev_addresses.json
```

> ⚠️ **Dev only — muda a cada deploy.** O hardhat node é in-memory: cada restart zera a chain e cada redeploy gera endereços novos. Nunca hardcode; leia sempre do JSON (ou do `/config.json` servido pelo frontend). Chaves atuais: `USDC` (mock), `DevSwapPool`, `CreditPriceOracle`, `DevFaucet`, `CreditPSM`, `ProjectFunding`, `FeeRouterV2`.

### Sepolia (testnet)

```
TBA — endereços publicados em ignition/deployments/ após deploy em rede pública.
```

Verifique `ignition/deployments/chain-11155111/deployed_addresses.json` no repositório para a lista atualizada.

### Mainnet

```
TBA — deploy em mainnet requer auditoria externa concluída.
```

## ABIs

ABIs são geradas pelo Hardhat em `artifacts/contracts/*.sol/*.json`. Cada JSON contém o campo `abi`.

Para TypeScript/Vue apps, use o script `sync-contracts.ts` do frontend (já integrado em `/home/ubuntu/web3community-frontend/`) que copia ABIs + typechain types.

## Lista canônica de contratos

A ordem neste índice corresponde à ordem numérica em `08-contracts-reference/`:

| # | Contrato | Arquivo .sol |
|---|---|---|
| 01 | `GovernanceToken` | `contracts/GovernanceToken.sol` |
| 02 | `CreditToken` | `contracts/CreditToken.sol` |
| 03 | `ProjectRegistry` | `contracts/ProjectRegistry.sol` |
| 04 | `Treasury` | `contracts/Treasury.sol` |
| 05 | `Staking` | `contracts/Staking.sol` |
| 06 | `BurnTracker` | `contracts/BurnTracker.sol` |
| 07 | `RewardDistributor` | `contracts/RewardDistributor.sol` |
| 07b | `RewardDistributorV2` | `contracts/RewardDistributorV2.sol` |
| 08 | `FeeRouter` (legado) | `contracts/FeeRouter.sol` |
| 08b | `FeeRouterV2` | `contracts/FeeRouterV2.sol` |
| 09 | `CommunityTimelock` | `contracts/CommunityTimelock.sol` |
| 10 | `CommunityGovernor` | `contracts/CommunityGovernor.sol` |
| 11 | `TeamVesting` | `contracts/TeamVesting.sol` |
| 12 | `UserSubsidy` | `contracts/UserSubsidy.sol` |
| 13 | `LiquidityGauge` | `contracts/LiquidityGauge.sol` |
| 14 | `CreditPriceOracle` | `contracts/CreditPriceOracle.sol` |
| 15 | `CreditPSM` | `contracts/CreditPSM.sol` |
| 16 | `ProjectFunding` | `contracts/ProjectFunding.sol` |

São **18 contratos de produção** no total (os três últimos — remodel 2026-07-08 — são o trilho vigente; `FeeRouter` V1, `BurnTracker` e `RewardDistributor` V1/V2 são legado deployado). Doc detalhada por contrato em [`08-contracts-reference/`](../08-contracts-reference/).

## Versões de dependências

- **Solidity**: `0.8.24`
- **OpenZeppelin Contracts**: `5.0.2` (pinado exato)
- **Hardhat**: versão conforme `package.json` do repo de contratos.
- **Ignition**: `@nomicfoundation/hardhat-ignition`.

## Endereços dos tokens (após deploy)

Para descobrir endereços de GOV e CREDIT após deploy:

```typescript
const deployed = require('./ignition/deployments/chain-<chainId>/deployed_addresses.json');
const GOV    = deployed['CommunityDAOModule#GovernanceToken'];
const CREDIT = deployed['CommunityDAOModule#CreditToken'];
const TREASURY = deployed['CommunityDAOModule#Treasury'];
const REGISTRY = deployed['CommunityDAOModule#ProjectRegistry'];
const STAKING = deployed['CommunityDAOModule#Staking'];
const BURN_TRACKER = deployed['CommunityDAOModule#BurnTracker'];
const REWARD_DISTRIBUTOR = deployed['CommunityDAOModule#RewardDistributor'];
const FEE_ROUTER = deployed['CommunityDAOModule#FeeRouter'];
const TIMELOCK = deployed['CommunityDAOModule#CommunityTimelock'];
const GOVERNOR = deployed['CommunityDAOModule#CommunityGovernor'];
```

Para os contratos do remodel em rede local (dev, muda a cada deploy):

```typescript
const dev = require('./ignition/deployments/chain-31337/dev_addresses.json');
const PSM         = dev['CreditPSM'];
const FEE_ROUTER_V2 = dev['FeeRouterV2'];
const FUNDING     = dev['ProjectFunding'];
const USDC_MOCK   = dev['USDC'];
```

## Contratos não deployados pelo módulo principal

`TeamVesting` e `UserSubsidy` têm módulos Ignition separados (`ignition/modules/TeamVesting.ts` e `ignition/modules/UserSubsidy.ts`) — deployados sob demanda via proposta da DAO, não no bootstrap.

Cada `TeamVesting` é uma instância separada (um por beneficiário). Seus endereços ficam em deployments dedicados.

`RewardDistributorV2`, `LiquidityGauge` e `CreditPriceOracle` são deployáveis opcionalmente pelo próprio `Dao.ts` (Fase F) via env vars:

- `DEPLOY_CLP_PHASE1=true` → `LiquidityGauge` + `RewardDistributorV2` (futures `CommunityDAOModule#phaseF_LiquidityGauge` / `#phaseF_RewardDistributorV2`).
- `DEPLOY_CLP_ORACLE=true` → `CreditPriceOracle` (future `CommunityDAOModule#phaseF_CreditPriceOracle`).

O módulo **não concede nenhuma role** a esses contratos — a migração V1 → V2 (MINTER_ROLE do CREDIT), whitelist de pools no gauge e `Treasury.setPriceOracle(oracle)` são atos de governança via proposta.

## Verificação on-chain

Após deploy em rede pública:

```bash
npx hardhat verify --network sepolia <contract_address> <constructor_args>
```

Os constructor args podem ser extraídos de `ignition/parameters/production.json` + derivações automatizadas do módulo.

---

**Próximo →** [Submeter um projeto](03-submitting-a-project.md)
