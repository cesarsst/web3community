# Direcciones de los contratos

**Audiencia:** dev integrando vía ABI + dirección on-chain.
**Requisitos previos:** ninguno.

## Direcciones por red

### Localhost (hardhat node)

Deploy vía `npx hardhat ignition deploy ./ignition/modules/Dao.ts --parameters ignition/parameters/dev.json --network localhost`. Las direcciones son determinísticas según el orden de deploy de Ignition, pero varían según el nonce del deployer. Usa el output del deploy.

### Sepolia (testnet)

```
TBA — direcciones publicadas en ignition/deployments/ tras deploy en red pública.
```

Verifica `ignition/deployments/chain-11155111/deployed_addresses.json` en el repositorio para la lista actualizada.

### Mainnet

```
TBA — deploy em mainnet requer auditoria externa concluída.
```

## ABIs

Las ABIs son generadas por Hardhat en `artifacts/contracts/*.sol/*.json`. Cada JSON contiene el campo `abi`.

Para apps TypeScript/Vue, usa el script `sync-contracts.ts` del frontend (ya integrado en `/home/ubuntu/web3community-frontend/`) que copia ABIs + typechain types.

## Lista canónica de contratos

El orden en este índice corresponde al orden numérico en `08-contracts-reference/`:

| # | Contrato | Archivo .sol |
|---|---|---|
| 01 | `GovernanceToken` | `contracts/GovernanceToken.sol` |
| 02 | `CreditToken` | `contracts/CreditToken.sol` |
| 03 | `ProjectRegistry` | `contracts/ProjectRegistry.sol` |
| 04 | `Treasury` | `contracts/Treasury.sol` |
| 05 | `Staking` | `contracts/Staking.sol` |
| 06 | `BurnTracker` | `contracts/BurnTracker.sol` |
| 07 | `RewardDistributor` | `contracts/RewardDistributor.sol` |
| 08 | `FeeRouter` | `contracts/FeeRouter.sol` |
| 09 | `CommunityTimelock` | `contracts/CommunityTimelock.sol` |
| 10 | `CommunityGovernor` | `contracts/CommunityGovernor.sol` |
| 11 | `TeamVesting` | `contracts/TeamVesting.sol` |
| 12 | `UserSubsidy` | `contracts/UserSubsidy.sol` |

Doc detallada por contrato en [`08-contracts-reference/`](../08-contracts-reference/).

## Versiones de dependencias

- **Solidity**: `0.8.24`
- **OpenZeppelin Contracts**: `5.0.2` (pinado exacto)
- **Hardhat**: versión según `package.json` del repo de contratos.
- **Ignition**: `@nomicfoundation/hardhat-ignition`.

## Direcciones de los tokens (tras deploy)

Para descubrir las direcciones de GOV y CREDIT tras el deploy:

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

## Contratos no deployados por el módulo principal

`TeamVesting` y `UserSubsidy` tienen módulos Ignition separados (`ignition/modules/TeamVesting.ts` y `ignition/modules/UserSubsidy.ts`) — deployados bajo demanda vía propuesta de la DAO, no en el bootstrap.

Cada `TeamVesting` es una instancia separada (uno por beneficiario). Sus direcciones quedan en deployments dedicados.

## Verificación on-chain

Tras deploy en red pública:

```bash
npx hardhat verify --network sepolia <contract_address> <constructor_args>
```

Los constructor args pueden extraerse de `ignition/parameters/production.json` + derivaciones automatizadas del módulo.

---

**Siguiente →** [Enviar un proyecto](03-submitting-a-project.md)
