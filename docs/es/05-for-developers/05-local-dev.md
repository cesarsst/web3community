# Entorno local

**Audiencia:** dev que quiere correr web3community localmente para testear integraciones.
**Requisitos previos:** Node.js 18+, familiaridad con Hardhat.

## Setup

```bash
git clone <repo-url>
cd web3community
npm install
```

## Comandos esenciales

```bash
# Compilar
npx hardhat compile

# Correr toda la suite de tests (858 tests)
npm test

# Coverage
npm run coverage

# Simulación económica 52 rondas × 3 escenarios
npm run sim

# Formato
npm run format
npm run format:check
```

## Deploy local

Paso 1: en una terminal, levanta el node:

```bash
npx hardhat node
```

Paso 2: en otra terminal, deploy vía Ignition:

```bash
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost
```

El archivo `dev.json` tiene defaults para desarrollo (delays cortos, quorum bajo — fácil de testear):

- `timelockMinDelay: 3600` (1h en vez de 2d en producción)
- `votingDelay: 1` bloque
- `votingPeriod: 50` bloques
- `roundDuration: 86400` (1 día)
- `minCollateral: 1000 GOV` (en vez de 10k en producción)
- `probationDuration: 86400` (1 día en vez de 30d)

Los parámetros económicos legados `alpha`, `floorSchedule` y el split del FeeRouter V1 (`7000/2000/1000`) son iguales a producción. En cambio `capMax` (1M en dev vs 5M en producción) y `sanityCap` (1M vs 10M) están reducidos en dev.

**Remodel 2026-07-08**: los contratos vigentes (`CreditPSM`, `FeeRouterV2`, `ProjectFunding`) se despliegan con un script separado, después del deploy base:

```bash
npx hardhat run scripts/deploy-remodel.ts --network localhost
```

Deploys opcionales de la Fase 1 del pivote CLP (apagados por default) vía env vars antes del comando de deploy:

```bash
# LiquidityGauge + RewardDistributorV2
DEPLOY_CLP_PHASE1=true npx hardhat ignition deploy ./ignition/modules/Dao.ts ...

# CreditPriceOracle (exige pool CREDIT/USDC y USDC reales en los parámetros)
DEPLOY_CLP_ORACLE=true npx hardhat ignition deploy ./ignition/modules/Dao.ts ...
```

El módulo no concede ninguna role a esos contratos — el wiring de roles es acto de gobernanza.

## Direcciones post-deploy

Ve `ignition/deployments/chain-31337/deployed_addresses.json` tras el deploy local. Ejemplo de contenido:

```json
{
  "CommunityDAOModule#GovernanceToken": "0x...",
  "CommunityDAOModule#CreditToken": "0x...",
  "CommunityDAOModule#ProjectRegistry": "0x...",
  ...
}
```

## Flujo local típico de prueba

### 1. Deploy

Como arriba. Los contratos quedan con el deployer como admin inicial + el Timelock como admin final. El script ya hace el handoff automáticamente — el Timelock tiene `GOVERNANCE_ROLE` en todo, el GOV tiene al Timelock como `pendingOwner`.

### 2. Aceptar ownership del GOV

Aún no fue hecho por el deploy (el Timelock necesita llamar a `acceptOwnership` vía propuesta). En test local:

```typescript
// Opcion A: via hardhat impersonate
await hre.network.provider.request({
  method: "hardhat_impersonateAccount",
  params: [timelockAddress],
});
const timelock = await ethers.getSigner(timelockAddress);
await gov.connect(timelock).acceptOwnership();
```

O (más fiel) vía propuesta en el Governor. El repo tiene helpers en `test/ignition/Dao.test.ts`.

### 3. Mintear GOV inicial a cuentas de prueba

Necesitas proponer por el Governor (o, en test, impersonar el Timelock) para llamar:

```typescript
await gov.connect(timelock).mint(aliceAddress, ethers.parseEther("100000"), "test");
```

### 4. Listar un proyecto de prueba

```typescript
// impersona Timelock
await registry.connect(timelock).registerProject(projectOwnerAddr, "ipfs://test", ethers.parseEther("10000"));
await registry.connect(timelock).activateProject(1);
```

Importante: antes del `registerProject`, el `projectOwnerAddr` necesita haber `approve`ado al Registry por 10.000 GOV.

### 5. El staker entra

```typescript
await gov.connect(alice).approve(stakingAddr, ethers.parseEther("50000"));
await staking.connect(alice).stake(1, ethers.parseEther("50000"), 60 * 60 * 24 * 365);
```

### 6. Simular pago

```typescript
// admin del Treasury transfiere CREDIT a charlie (como si lo hubiera comprado en DEX)
await treasury.connect(timelock).transfer(creditAddr, charlieAddr, ethers.parseEther("1000"));

// charlie paga en el proyecto 1
await credit.connect(charlie).approve(feeRouterAddr, ethers.parseEther("1000"));
await feeRouter.connect(charlie).pay(1, charlieAddr, ethers.parseEther("1000"));
```

### 7. Cerrar ronda + finalize

```typescript
// avanca tempo para passar roundDuration
await hre.network.provider.send("evm_increaseTime", [86400]);
await hre.network.provider.send("evm_mine");

await burnTracker.connect(timelock).closeRound();    // round 0 -> 1
await rewardDistributor.finalizeRound(0);            // qualquer um pode
```

### 8. Alice reclama

```typescript
const preview = await rewardDistributor.previewClaim(aliceAddr, 0, 1);
console.log(`Alice receberia ${ethers.formatEther(preview)} CREDIT`);

await rewardDistributor.connect(alice).claim(0, 1);
```

## Flags útiles de Hardhat

```bash
# verbose gas
REPORT_GAS=true npm test

# rodar teste específico
npx hardhat test test/Staking.test.ts --grep "should not allow unstake before lock expires"

# console interativo contra node local
npx hardhat console --network localhost
```

## Slither (análisis estático)

```bash
# instalar (uma vez)
pipx install slither-analyzer

# rodar contra um contrato
slither contracts/FeeRouter.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --solc-args "--optimize --optimize-runs 200 --evm-version paris"
```

Resultados completos en `audit/slither/<Contract>.txt` (versión completa) + `-projectonly.txt` (filtrada solo para código del proyecto).

## Simulación económica

```bash
npm run sim
```

Corre `scripts/simulation/` — simula 52 rondas × 3 escenarios (uso constante, uso creciente, death spiral). Outputs en CSV + reporte Markdown en `scripts/simulation/output/`.

## Troubleshooting

**"Test timeout"** en test que usa `time.increaseTo` — a veces hay drift de 1s entre bloque minado y `eth_call`. Usa el helper `mineAt(t)` que combina `setNextBlockTimestamp + mine`.

**"RoundNotFinalized"** al intentar claim — olvidaste llamar a `finalizeRound(round)` tras el `closeRound`.

**"ProjectNotActive"** en stake / pay — el proyecto no llegó a `Active` aún. Verifica `registry.getProject(projectId).status`.

**"LockNotExpired"** en unstake — lock aún vigente y el proyecto no es `Removed`. Avanza tiempo con `evm_increaseTime`.

**"AlreadyFinalized"** — la ronda ya fue finalizada. Verifica `rd.isFinalized(round)`.

---

**Siguiente →** [Tokenomics](../06-for-investors/01-tokenomics.md)
