# Local environment

**Audience:** dev wanting to run web3community locally to test integrations.
**Prerequisites:** Node.js 18+, familiarity with Hardhat.

## Setup

```bash
git clone <repo-url>
cd web3community
npm install
```

## Essential commands

```bash
# Compile
npx hardhat compile

# Run the full test suite (462+ tests)
npm test

# Coverage
npm run coverage

# Economic simulation 52 rounds × 3 scenarios
npm run sim

# Formatting
npm run format
npm run format:check
```

## Local deploy

Step 1: in one terminal, start the node:

```bash
npx hardhat node
```

Step 2: in another terminal, deploy via Ignition:

```bash
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost
```

The `dev.json` file has development defaults (short delays, low quorum — easy to test):

- `timelockMinDelay: 3600` (1h instead of 2d in production)
- `votingDelay: 1` block
- `votingPeriod: 50` blocks
- `roundDuration: 86400` (1 day)
- `minCollateral: 1000 GOV` (instead of 10k in production)
- `probationDuration: 86400` (1 day instead of 30d)

The other economic parameters (`alpha`, `capMax`, `floorSchedule`, split) are the same as production.

## Post-deploy addresses

See `ignition/deployments/chain-31337/deployed_addresses.json` after local deploy. Example contents:

```json
{
  "CommunityDAOModule#GovernanceToken": "0x...",
  "CommunityDAOModule#CreditToken": "0x...",
  "CommunityDAOModule#ProjectRegistry": "0x...",
  ...
}
```

## Typical local test flow

### 1. Deploy

As above. Contracts end up with the deployer as initial admin + Timelock as final admin. The script already does the handoff automatically — the Timelock holds `GOVERNANCE_ROLE` everywhere, and GOV has the Timelock as `pendingOwner`.

### 2. Accept GOV ownership

Not yet done by the deploy (the Timelock must call `acceptOwnership` via proposal). In local test:

```typescript
// Option A: via hardhat impersonate
await hre.network.provider.request({
  method: "hardhat_impersonateAccount",
  params: [timelockAddress],
});
const timelock = await ethers.getSigner(timelockAddress);
await gov.connect(timelock).acceptOwnership();
```

Or (more faithful) via proposal in the Governor. The repo has helpers in `test/ignition/Dao.test.ts`.

### 3. Mint initial GOV to test accounts

You need to propose through the Governor (or, in test, impersonate the Timelock) to call:

```typescript
await gov.connect(timelock).mint(aliceAddress, ethers.parseEther("100000"), "test");
```

### 4. List a test project

```typescript
// impersonates Timelock
await registry.connect(timelock).registerProject(projectOwnerAddr, "ipfs://test", ethers.parseEther("10000"));
await registry.connect(timelock).activateProject(1);
```

Important: before `registerProject`, `projectOwnerAddr` must have `approve`d the Registry for 10,000 GOV.

### 5. Staker enters

```typescript
await gov.connect(alice).approve(stakingAddr, ethers.parseEther("50000"));
await staking.connect(alice).stake(1, ethers.parseEther("50000"), 60 * 60 * 24 * 365);
```

### 6. Simulate payment

```typescript
// Treasury admin transfers CREDIT to charlie (as if he bought it on DEX)
await treasury.connect(timelock).transfer(creditAddr, charlieAddr, ethers.parseEther("1000"));

// charlie pays in project 1
await credit.connect(charlie).approve(feeRouterAddr, ethers.parseEther("1000"));
await feeRouter.connect(charlie).pay(1, charlieAddr, ethers.parseEther("1000"));
```

### 7. Close round + finalize

```typescript
// advance time to pass roundDuration
await hre.network.provider.send("evm_increaseTime", [86400]);
await hre.network.provider.send("evm_mine");

await burnTracker.connect(timelock).closeRound();    // round 0 -> 1
await rewardDistributor.finalizeRound(0);            // anyone can do it
```

### 8. Alice claims

```typescript
const preview = await rewardDistributor.previewClaim(aliceAddr, 0, 1);
console.log(`Alice would receive ${ethers.formatEther(preview)} CREDIT`);

await rewardDistributor.connect(alice).claim(0, 1);
```

## Useful Hardhat flags

```bash
# verbose gas
REPORT_GAS=true npm test

# run specific test
npx hardhat test test/Staking.test.ts --grep "should not allow unstake before lock expires"

# interactive console against local node
npx hardhat console --network localhost
```

## Slither (static analysis)

```bash
# install (once)
pipx install slither-analyzer

# run against a contract
slither contracts/FeeRouter.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --solc-args "--optimize --optimize-runs 200 --evm-version paris"
```

Full results in `audit/slither/<Contract>.txt` (full version) + `-projectonly.txt` (filtered to project code only).

## Economic simulation

```bash
npm run sim
```

Runs `scripts/simulation/` — simulates 52 rounds × 3 scenarios (constant usage, growing usage, death spiral). Outputs to CSV + Markdown report in `scripts/simulation/output/`.

## Troubleshooting

**"Test timeout"** in a test that uses `time.increaseTo` — sometimes there is a 1s drift between mined block and `eth_call`. Use the `mineAt(t)` helper that combines `setNextBlockTimestamp + mine`.

**"RoundNotFinalized"** when trying to claim — you forgot to call `finalizeRound(round)` after `closeRound`.

**"ProjectNotActive"** on stake / pay — project has not reached `Active` yet. Check `registry.getProject(projectId).status`.

**"LockNotExpired"** on unstake — lock still active and project is not `Removed`. Advance time with `evm_increaseTime`.

**"AlreadyFinalized"** — the round has already been finalized. Check `rd.isFinalized(round)`.

---

**Next →** [Tokenomics](../06-for-investors/01-tokenomics.md)
