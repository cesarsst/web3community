# Ambiente local

**Para quem é:** dev querendo rodar a web3community localmente para testar integrações.
**Pré-requisitos:** Node.js 18+, familiaridade com Hardhat.

## Setup

```bash
git clone <repo-url>
cd web3community
npm install
```

## Comandos essenciais

```bash
# Compilar
npx hardhat compile

# Rodar toda a suite de testes (462+ testes)
npm test

# Coverage
npm run coverage

# Simulação econômica 52 rodadas × 3 cenários
npm run sim

# Formatação
npm run format
npm run format:check
```

## Deploy local

Passo 1: em um terminal, suba o node:

```bash
npx hardhat node
```

Passo 2: em outro terminal, deploy via Ignition:

```bash
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost
```

O arquivo `dev.json` tem defaults para desenvolvimento (delays curtos, quorum baixo — fácil de testar):

- `timelockMinDelay: 3600` (1h em vez de 2d em produção)
- `votingDelay: 1` bloco
- `votingPeriod: 50` blocos
- `roundDuration: 86400` (1 dia)
- `minCollateral: 1000 GOV` (em vez de 10k em produção)
- `probationDuration: 86400` (1 dia em vez de 30d)

Os outros parâmetros econômicos (`alpha`, `capMax`, `floorSchedule`, split) são iguais à produção.

## Endereços pós-deploy

Veja `ignition/deployments/chain-31337/deployed_addresses.json` após o deploy local. Exemplo de conteúdo:

```json
{
  "CommunityDAOModule#GovernanceToken": "0x...",
  "CommunityDAOModule#CreditToken": "0x...",
  "CommunityDAOModule#ProjectRegistry": "0x...",
  ...
}
```

## Fluxo local típico de teste

### 1. Deploy

Como acima. Os contratos ficam com o deployer como admin inicial + Timelock como admin final. O script já faz o handoff automaticamente — o Timelock tem `GOVERNANCE_ROLE` em tudo, o GOV tem o Timelock como `pendingOwner`.

### 2. Aceitar ownership do GOV

Ainda não foi feito pelo deploy (o Timelock precisa chamar `acceptOwnership` via proposta). Em teste local:

```typescript
// Opção A: via hardhat impersonate
await hre.network.provider.request({
  method: "hardhat_impersonateAccount",
  params: [timelockAddress],
});
const timelock = await ethers.getSigner(timelockAddress);
await gov.connect(timelock).acceptOwnership();
```

Ou (mais fiel) via proposta no Governor. O repo tem helpers em `test/ignition/Dao.test.ts`.

### 3. Mintar GOV inicial para contas de teste

Você precisa propor pelo Governor (ou, em teste, impersonar o Timelock) para chamar:

```typescript
await gov.connect(timelock).mint(aliceAddress, ethers.parseEther("100000"), "test");
```

### 4. Listar um projeto de teste

```typescript
// impersona Timelock
await registry.connect(timelock).registerProject(projectOwnerAddr, "ipfs://test", ethers.parseEther("10000"));
await registry.connect(timelock).activateProject(1);
```

Importante: antes do `registerProject`, o `projectOwnerAddr` precisa ter `approve`ado o Registry por 10.000 GOV.

### 5. Staker entra

```typescript
await gov.connect(alice).approve(stakingAddr, ethers.parseEther("50000"));
await staking.connect(alice).stake(1, ethers.parseEther("50000"), 60 * 60 * 24 * 365);
```

### 6. Simular pagamento

```typescript
// admin da Treasury transfere CREDIT para charlie (como se ele tivesse comprado na DEX)
await treasury.connect(timelock).transfer(creditAddr, charlieAddr, ethers.parseEther("1000"));

// charlie paga no projeto 1
await credit.connect(charlie).approve(feeRouterAddr, ethers.parseEther("1000"));
await feeRouter.connect(charlie).pay(1, charlieAddr, ethers.parseEther("1000"));
```

### 7. Fechar rodada + finalize

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

## Flags úteis do Hardhat

```bash
# verbose gas
REPORT_GAS=true npm test

# rodar teste específico
npx hardhat test test/Staking.test.ts --grep "should not allow unstake before lock expires"

# console interativo contra node local
npx hardhat console --network localhost
```

## Slither (análise estática)

```bash
# instalar (uma vez)
pipx install slither-analyzer

# rodar contra um contrato
slither contracts/FeeRouter.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --solc-args "--optimize --optimize-runs 200 --evm-version paris"
```

Resultados completos em `audit/slither/<Contract>.txt` (versão completa) + `-projectonly.txt` (filtrada só para código do projeto).

## Simulação econômica

```bash
npm run sim
```

Roda `scripts/simulation/` — simula 52 rodadas × 3 cenários (uso constante, uso crescente, death spiral). Outputs em CSV + relatório Markdown em `scripts/simulation/output/`.

## Troubleshooting

**"Test timeout"** em teste que usa `time.increaseTo` — às vezes há drift de 1s entre bloco minerado e `eth_call`. Use o helper `mineAt(t)` que combina `setNextBlockTimestamp + mine`.

**"RoundNotFinalized"** ao tentar claim — você esqueceu de chamar `finalizeRound(round)` depois do `closeRound`.

**"ProjectNotActive"** em stake / pay — projeto não chegou a `Active` ainda. Confira `registry.getProject(projectId).status`.

**"LockNotExpired"** em unstake — lock ainda vigente e projeto não é `Removed`. Avance tempo com `evm_increaseTime`.

**"AlreadyFinalized"** — a rodada já foi finalizada. Verifique `rd.isFinalized(round)`.

---

**Próximo →** [Tokenomics](../06-for-investors/01-tokenomics.md)
