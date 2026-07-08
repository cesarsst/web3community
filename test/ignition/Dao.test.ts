import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  mine,
} from "@nomicfoundation/hardhat-network-helpers";

import CommunityDAOModule from "../../ignition/modules/Dao";

/**
 * Integration test for the CommunityDAO Ignition module.
 *
 * Cobre:
 *  - Deploy de todos os 10 contratos.
 *  - Roles funcionais corretas (MINTER -> distributor, BURNER -> tracker,
 *    RECORDER -> feeRouter, PROPOSER/CANCELLER -> governor).
 *  - Roles de governanca cedidas ao Timelock em todos os contratos economicos.
 *  - Deployer NAO retem nenhuma role (renunciou).
 *  - Genesis CREDIT (10M) creditado integralmente ao Treasury.
 *  - GovernanceToken: pendingOwner = Timelock (acceptOwnership ainda pendente,
 *    como documentado no header do modulo). Apos impersonate + accept do
 *    Timelock, owner == Timelock.
 *  - Floor schedule armazenado no RewardDistributor reflete os 24 valores
 *    esperados (decay linear).
 *  - Default split do FeeRouter = 70/20/10 (Fase 0 do pivot CLP,
 *    docs/governance/fase0-default-split.md).
 *  - Parametros economicos do Governor / BurnTracker / RewardDistributor
 *    refletem o perfil DEV (defaults).
 *  - End-to-end: propose via Governor -> queue -> execute apos delay -> efeito
 *    observavel no Treasury (transfer de USDC mock). Valida que toda a cadeia
 *    de governanca esta wired corretamente.
 */
describe("Ignition: CommunityDAO module", function () {
  // O ciclo completo (propose + period + queue + delay + execute) demanda mais
  // que o default global de 40s do mocha em hardhat — bumpamos pra dar
  // folga em maquinas de CI mais lentas.
  this.timeout(120_000);

  const DEV_TIMELOCK_DELAY = 3_600n; // 1h
  const DEV_VOTING_DELAY = 1n; // 1 block
  const DEV_VOTING_PERIOD = 50n; // 50 blocks
  const DEV_PROPOSAL_THRESHOLD = 10_000n * 10n ** 18n;
  const DEV_QUORUM = 4n;
  const DEV_GENESIS = 10_000_000n * 10n ** 18n;
  const DEV_MIN_COLLATERAL = 1_000n * 10n ** 18n;
  const DEV_PROBATION = 86_400n;
  const DEV_ROUND_DURATION = 86_400n;
  const DEV_SANITY_CAP = 1_000_000n * 10n ** 18n;
  const DEV_ALPHA = 950_000_000_000_000_000n;
  const DEV_CAPMAX = 1_000_000n * 10n ** 18n;

  const FLOOR_INITIAL = 400_000n * 10n ** 18n;
  const FLOOR_STEP = FLOOR_INITIAL / 24n;

  async function deployDaoFixture() {
    // hre.ignition.deploy retorna instancias `Contract` genericas (BaseContract
    // do ethers) — sem tipos TypeChain. Para ter intellisense + checagem de
    // tipos nos asserts, re-resolvemos cada contrato via `ethers.getContractAt`
    // usando o address retornado pelo Ignition. Isso da `TypedContract`
    // (typechain) sem refazer deploy.
    const deployed = await hre.ignition.deploy(CommunityDAOModule);

    const [deployer] = await ethers.getSigners();

    const [
      gov,
      credit,
      timelock,
      registry,
      treasury,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      governor,
    ] = await Promise.all([
      ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress()),
      ethers.getContractAt("CreditToken", await deployed.credit.getAddress()),
      ethers.getContractAt("CommunityTimelock", await deployed.timelock.getAddress()),
      ethers.getContractAt("ProjectRegistry", await deployed.registry.getAddress()),
      ethers.getContractAt("Treasury", await deployed.treasury.getAddress()),
      ethers.getContractAt("Staking", await deployed.staking.getAddress()),
      ethers.getContractAt("BurnTracker", await deployed.burnTracker.getAddress()),
      ethers.getContractAt("RewardDistributor", await deployed.distributor.getAddress()),
      ethers.getContractAt("FeeRouter", await deployed.feeRouter.getAddress()),
      ethers.getContractAt("CommunityGovernor", await deployed.governor.getAddress()),
    ]);

    return {
      gov,
      credit,
      timelock,
      registry,
      treasury,
      staking,
      burnTracker,
      distributor,
      feeRouter,
      governor,
      deployer,
    };
  }

  describe("Phase A — Deploy", () => {
    it("deploys all 10 contracts with non-zero addresses", async () => {
      const {
        gov,
        credit,
        timelock,
        registry,
        treasury,
        staking,
        burnTracker,
        distributor,
        feeRouter,
        governor,
      } = await loadFixture(deployDaoFixture);

      const addresses = await Promise.all([
        gov.getAddress(),
        credit.getAddress(),
        timelock.getAddress(),
        registry.getAddress(),
        treasury.getAddress(),
        staking.getAddress(),
        burnTracker.getAddress(),
        distributor.getAddress(),
        feeRouter.getAddress(),
        governor.getAddress(),
      ]);

      // Todos != zero, todos distintos.
      const set = new Set(addresses);
      expect(set.size).to.equal(addresses.length);
      for (const addr of addresses) {
        expect(addr).to.not.equal(ethers.ZeroAddress);
      }
    });

    it("wires immutable references between contracts correctly", async () => {
      const {
        gov,
        credit,
        registry,
        staking,
        burnTracker,
        distributor,
        feeRouter,
        treasury,
        governor,
        timelock,
      } = await loadFixture(deployDaoFixture);

      // Staking aponta pra GOV + Registry
      expect(await staking.GOV_TOKEN()).to.equal(await gov.getAddress());
      expect(await staking.REGISTRY()).to.equal(await registry.getAddress());

      // Registry aponta pra GOV
      expect(await registry.govToken()).to.equal(await gov.getAddress());

      // BurnTracker aponta pra CREDIT + Registry
      expect(await burnTracker.CREDIT_TOKEN()).to.equal(await credit.getAddress());
      expect(await burnTracker.REGISTRY()).to.equal(await registry.getAddress());

      // RewardDistributor aponta pra todos
      expect(await distributor.CREDIT()).to.equal(await credit.getAddress());
      expect(await distributor.STAKING()).to.equal(await staking.getAddress());
      expect(await distributor.BURN_TRACKER()).to.equal(await burnTracker.getAddress());
      expect(await distributor.REGISTRY()).to.equal(await registry.getAddress());

      // FeeRouter aponta pra todos
      expect(await feeRouter.CREDIT()).to.equal(await credit.getAddress());
      expect(await feeRouter.BURN_TRACKER()).to.equal(await burnTracker.getAddress());
      expect(await feeRouter.REGISTRY()).to.equal(await registry.getAddress());
      expect(await feeRouter.TREASURY()).to.equal(await treasury.getAddress());

      // Governor aponta pra GOV + Timelock
      expect(await governor.token()).to.equal(await gov.getAddress());
      expect(await governor.timelock()).to.equal(await timelock.getAddress());
    });
  });

  describe("Phase B — Functional role grants", () => {
    it("grants MINTER_ROLE on CreditToken to RewardDistributor", async () => {
      const { credit, distributor } = await loadFixture(deployDaoFixture);
      const MINTER_ROLE = await credit.MINTER_ROLE();
      expect(await credit.hasRole(MINTER_ROLE, await distributor.getAddress())).to.be.true;
    });

    it("grants BURNER_ROLE on CreditToken to BurnTracker", async () => {
      const { credit, burnTracker } = await loadFixture(deployDaoFixture);
      const BURNER_ROLE = await credit.BURNER_ROLE();
      expect(await credit.hasRole(BURNER_ROLE, await burnTracker.getAddress())).to.be.true;
    });

    it("grants RECORDER_ROLE on BurnTracker to FeeRouter", async () => {
      const { burnTracker, feeRouter } = await loadFixture(deployDaoFixture);
      const RECORDER_ROLE = await burnTracker.RECORDER_ROLE();
      expect(await burnTracker.hasRole(RECORDER_ROLE, await feeRouter.getAddress())).to.be.true;
    });

    it("grants PROPOSER_ROLE and CANCELLER_ROLE on Timelock to Governor", async () => {
      const { timelock, governor } = await loadFixture(deployDaoFixture);
      const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
      const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
      const govAddr = await governor.getAddress();
      expect(await timelock.hasRole(PROPOSER_ROLE, govAddr)).to.be.true;
      expect(await timelock.hasRole(CANCELLER_ROLE, govAddr)).to.be.true;
    });

    it("does NOT grant EXECUTOR_ROLE to anyone except address(0) (public execution)", async () => {
      const { timelock, governor, deployer } = await loadFixture(deployDaoFixture);
      const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
      // address(0) recebeu EXECUTOR_ROLE no constructor — verifica.
      expect(await timelock.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress)).to.be.true;
      // Governor e deployer NAO devem ter (so o address(0) sentinela detem).
      expect(await timelock.hasRole(EXECUTOR_ROLE, await governor.getAddress())).to.be.false;
      expect(await timelock.hasRole(EXECUTOR_ROLE, deployer.address)).to.be.false;
    });

    it("performs genesis mint: 10M CREDIT to Treasury", async () => {
      const { credit, treasury } = await loadFixture(deployDaoFixture);
      expect(await credit.genesisMinted()).to.be.true;
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(DEV_GENESIS);
      expect(await credit.totalSupply()).to.equal(DEV_GENESIS);
    });

    it("genesis cannot be re-minted after deploy", async () => {
      const { credit, treasury, timelock } = await loadFixture(deployDaoFixture);
      // Mesmo o Timelock, que detem DEFAULT_ADMIN_ROLE pos-fase-C, nao consegue
      // re-mintar genesis (flag one-shot). Simulamos via impersonate.
      await impersonateAccount(await timelock.getAddress());
      const tlSigner = await ethers.getSigner(await timelock.getAddress());
      await setBalance(tlSigner.address, ethers.parseEther("10"));
      await expect(
        credit.connect(tlSigner).mintGenesis(await treasury.getAddress(), 1n),
      ).to.be.revertedWithCustomError(credit, "GenesisAlreadyMinted");
    });
  });

  describe("Phase C — Governance roles transferred to Timelock", () => {
    it("transfers GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE on ProjectRegistry to Timelock", async () => {
      const { registry, timelock } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await registry.GOVERNANCE_ROLE();
      const ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
      const tlAddr = await timelock.getAddress();
      expect(await registry.hasRole(GOV_ROLE, tlAddr)).to.be.true;
      expect(await registry.hasRole(ADMIN_ROLE, tlAddr)).to.be.true;
    });

    it("transfers GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE on Treasury to Timelock", async () => {
      const { treasury, timelock } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await treasury.GOVERNANCE_ROLE();
      const ADMIN_ROLE = await treasury.DEFAULT_ADMIN_ROLE();
      const tlAddr = await timelock.getAddress();
      expect(await treasury.hasRole(GOV_ROLE, tlAddr)).to.be.true;
      expect(await treasury.hasRole(ADMIN_ROLE, tlAddr)).to.be.true;
    });

    it("transfers GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE on BurnTracker to Timelock", async () => {
      const { burnTracker, timelock } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await burnTracker.GOVERNANCE_ROLE();
      const ADMIN_ROLE = await burnTracker.DEFAULT_ADMIN_ROLE();
      const tlAddr = await timelock.getAddress();
      expect(await burnTracker.hasRole(GOV_ROLE, tlAddr)).to.be.true;
      expect(await burnTracker.hasRole(ADMIN_ROLE, tlAddr)).to.be.true;
    });

    it("transfers GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE on RewardDistributor to Timelock", async () => {
      const { distributor, timelock } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await distributor.GOVERNANCE_ROLE();
      const ADMIN_ROLE = await distributor.DEFAULT_ADMIN_ROLE();
      const tlAddr = await timelock.getAddress();
      expect(await distributor.hasRole(GOV_ROLE, tlAddr)).to.be.true;
      expect(await distributor.hasRole(ADMIN_ROLE, tlAddr)).to.be.true;
    });

    it("transfers GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE on FeeRouter to Timelock", async () => {
      const { feeRouter, timelock } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await feeRouter.GOVERNANCE_ROLE();
      const ADMIN_ROLE = await feeRouter.DEFAULT_ADMIN_ROLE();
      const tlAddr = await timelock.getAddress();
      expect(await feeRouter.hasRole(GOV_ROLE, tlAddr)).to.be.true;
      expect(await feeRouter.hasRole(ADMIN_ROLE, tlAddr)).to.be.true;
    });

    it("transfers DEFAULT_ADMIN_ROLE on CreditToken to Timelock", async () => {
      const { credit, timelock } = await loadFixture(deployDaoFixture);
      const ADMIN_ROLE = await credit.DEFAULT_ADMIN_ROLE();
      expect(await credit.hasRole(ADMIN_ROLE, await timelock.getAddress())).to.be.true;
    });

    it("initiates Ownable2Step transfer of GovernanceToken to Timelock (pendingOwner set)", async () => {
      const { gov, timelock, deployer } = await loadFixture(deployDaoFixture);
      // pendingOwner ja deve ser o Timelock; owner ainda e o deployer (accept
      // pendente — ver header do modulo).
      expect(await gov.pendingOwner()).to.equal(await timelock.getAddress());
      expect(await gov.owner()).to.equal(deployer.address);
    });

    it("Timelock can complete acceptOwnership of GovernanceToken (simulated via impersonate)", async () => {
      const { gov, timelock } = await loadFixture(deployDaoFixture);

      // Simulacao do bootstrap pos-deploy em DEV: impersonamos o Timelock e
      // chamamos acceptOwnership direto. Em PRODUCAO, isso precisa virar uma
      // proposta no Governor que ratifique o accept (ver decisao 4 do header
      // do modulo).
      const tlAddr = await timelock.getAddress();
      await impersonateAccount(tlAddr);
      const tlSigner = await ethers.getSigner(tlAddr);
      await setBalance(tlSigner.address, ethers.parseEther("10"));

      await gov.connect(tlSigner).acceptOwnership();

      expect(await gov.owner()).to.equal(tlAddr);
      expect(await gov.pendingOwner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Phase D — Deployer role renunciation", () => {
    it("deployer no longer holds GOVERNANCE_ROLE on any economic contract", async () => {
      const { registry, treasury, burnTracker, distributor, feeRouter, deployer } =
        await loadFixture(deployDaoFixture);

      const contracts = [registry, treasury, burnTracker, distributor, feeRouter];
      for (const c of contracts) {
        const role = await c.GOVERNANCE_ROLE();
        expect(await c.hasRole(role, deployer.address)).to.be.false;
      }
    });

    it("deployer no longer holds DEFAULT_ADMIN_ROLE on any contract", async () => {
      const {
        registry,
        treasury,
        burnTracker,
        distributor,
        feeRouter,
        credit,
        timelock,
        deployer,
      } = await loadFixture(deployDaoFixture);

      const contracts = [registry, treasury, burnTracker, distributor, feeRouter, credit, timelock];
      for (const c of contracts) {
        const role = await c.DEFAULT_ADMIN_ROLE();
        expect(await c.hasRole(role, deployer.address)).to.be.false;
      }
    });

    it("deployer cannot grant roles anywhere (system fully governance-controlled)", async () => {
      const { registry, deployer } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await registry.GOVERNANCE_ROLE();
      // Deployer perdeu DEFAULT_ADMIN_ROLE — qualquer grantRole reverte.
      await expect(
        registry.connect(deployer).grantRole(GOV_ROLE, deployer.address),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("deployer cannot register projects directly in Registry (only Timelock can, via Governor)", async () => {
      const { gov, registry, deployer } = await loadFixture(deployDaoFixture);
      // Deployer tem GOV (era owner do mint inicial?) — na verdade nao mintamos
      // GOV no module. So tentamos registerProject e esperamos AccessControl revert.
      await expect(
        registry
          .connect(deployer)
          .registerProject(deployer.address, "ipfs://x", DEV_MIN_COLLATERAL),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      // ETH/GOV nao envolvido — o revert e checado antes do transferFrom.
      void gov; // referencia explicita pra evitar warning de unused
    });

    it("deployer cannot move funds from Treasury (only Timelock can, via Governor)", async () => {
      const { credit, treasury, deployer } = await loadFixture(deployDaoFixture);
      // Treasury tem 10M CREDIT. Deployer tenta transferir e falha por role.
      await expect(
        treasury.connect(deployer).transfer(await credit.getAddress(), deployer.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Configuration sanity checks", () => {
    it("RewardDistributor stores the correct floor schedule (linear decay 24 entries)", async () => {
      const { distributor } = await loadFixture(deployDaoFixture);
      for (let i = 0; i < 24; i++) {
        const expected = FLOOR_INITIAL - FLOOR_STEP * BigInt(i);
        expect(await distributor.floorSchedule(i)).to.equal(expected);
      }
    });

    it("RewardDistributor has correct alpha and capMax (DEV defaults)", async () => {
      const { distributor } = await loadFixture(deployDaoFixture);
      expect(await distributor.alpha()).to.equal(DEV_ALPHA);
      expect(await distributor.capMax()).to.equal(DEV_CAPMAX);
    });

    it("FeeRouter has 70/20/10 default split (Fase 0 do pivot CLP)", async () => {
      const { feeRouter } = await loadFixture(deployDaoFixture);
      const split = await feeRouter.defaultSplit();
      expect(split.burnBps).to.equal(7000n);
      expect(split.treasuryBps).to.equal(2000n);
      expect(split.rebateBps).to.equal(1000n);
    });

    it("BurnTracker has correct roundDuration and sanityCap (DEV defaults)", async () => {
      const { burnTracker } = await loadFixture(deployDaoFixture);
      expect(await burnTracker.roundDuration()).to.equal(DEV_ROUND_DURATION);
      expect(await burnTracker.maxBurnPerRoundPerProject()).to.equal(DEV_SANITY_CAP);
      expect(await burnTracker.currentRound()).to.equal(0n);
    });

    it("CommunityTimelock has correct minDelay (DEV default = 1h)", async () => {
      const { timelock } = await loadFixture(deployDaoFixture);
      expect(await timelock.getMinDelay()).to.equal(DEV_TIMELOCK_DELAY);
    });

    it("CommunityGovernor has correct voting parameters (DEV defaults)", async () => {
      const { governor } = await loadFixture(deployDaoFixture);
      expect(await governor.votingDelay()).to.equal(DEV_VOTING_DELAY);
      expect(await governor.votingPeriod()).to.equal(DEV_VOTING_PERIOD);
      expect(await governor.proposalThreshold()).to.equal(DEV_PROPOSAL_THRESHOLD);
      // quorumNumerator() retorna o valor atual
      expect(await governor["quorumNumerator()"]()).to.equal(DEV_QUORUM);
    });

    it("ProjectRegistry has correct minCollateral and probationDuration (DEV defaults)", async () => {
      const { registry } = await loadFixture(deployDaoFixture);
      expect(await registry.minCollateral()).to.equal(DEV_MIN_COLLATERAL);
      expect(await registry.probationDuration()).to.equal(DEV_PROBATION);
    });

    it("GovernanceToken has correct cap (immutable 100M)", async () => {
      const { gov } = await loadFixture(deployDaoFixture);
      expect(await gov.cap()).to.equal(100_000_000n * 10n ** 18n);
    });
  });

  describe("End-to-end governance flow (smoke test)", () => {
    it("Governor proposes -> votes -> queues -> executes a Treasury transfer", async () => {
      const { gov, treasury, governor, timelock, credit, deployer } =
        await loadFixture(deployDaoFixture);

      // Bootstrap pos-deploy: o Timelock precisa aceitar o ownership do GOV
      // pra poder mintar para o voter. Em prod isso vira proposta; aqui
      // simulamos via impersonate.
      const tlAddr = await timelock.getAddress();
      await impersonateAccount(tlAddr);
      const tlSigner = await ethers.getSigner(tlAddr);
      await setBalance(tlSigner.address, ethers.parseEther("100"));
      await gov.connect(tlSigner).acceptOwnership();

      // Mint GOV para um voter via impersonate do Timelock (owner do GOV).
      // Em prod, isso seria o resultado da segunda proposta ratificada.
      const [, voter, recipient] = await ethers.getSigners();
      const voterPower = 50_000_000n * 10n ** 18n; // 50% do cap, garante quorum
      await gov.connect(tlSigner).mint(voter.address, voterPower, "test:voter");
      await gov.connect(voter).delegate(voter.address);

      // Mine 1 bloco pra que o snapshot do propose veja o delegate.
      await mine(1);

      // Construir proposta: Treasury.transfer(CREDIT, recipient, 1_000e18).
      const transferAmount = 1_000n * 10n ** 18n;
      const calldata = treasury.interface.encodeFunctionData("transfer", [
        await credit.getAddress(),
        recipient.address,
        transferAmount,
      ]);

      const description = "Test proposal: transfer 1000 CREDIT from Treasury to recipient";
      const descriptionHash = ethers.id(description);

      // Propose
      const proposeTx = await governor
        .connect(voter)
        .propose([await treasury.getAddress()], [0], [calldata], description);
      const proposeReceipt = await proposeTx.wait();
      const proposalId = (
        proposeReceipt!.logs as Array<{
          fragment?: { name: string };
          args?: { proposalId: bigint };
        }>
      )
        .filter((l) => l.fragment?.name === "ProposalCreated")
        .map((l) => l.args!.proposalId)[0];

      // votingDelay = 1 block. Mine 1 a mais para entrar Active.
      await mine(2);

      // Voto FOR (1)
      await governor.connect(voter).castVote(proposalId, 1);

      // Avancar o periodo de votacao
      await mine(Number(DEV_VOTING_PERIOD));

      // Queue (precisa do Timelock proposer role — ja concedido na fase B)
      await governor
        .connect(voter)
        .queue([await treasury.getAddress()], [0], [calldata], descriptionHash);

      // Avancar o delay do Timelock
      await ethers.provider.send("evm_increaseTime", [Number(DEV_TIMELOCK_DELAY) + 1]);
      await mine(1);

      // Execute: efeito observavel = saldo de CREDIT do recipient sobe em 1000e18
      const before = await credit.balanceOf(recipient.address);
      await governor
        .connect(voter)
        .execute([await treasury.getAddress()], [0], [calldata], descriptionHash);
      const after = await credit.balanceOf(recipient.address);

      expect(after - before).to.equal(transferAmount);

      // Sanity: deployer continua sem poder fazer o mesmo via direct call.
      await expect(
        treasury.connect(deployer).transfer(await credit.getAddress(), recipient.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------------------------
  // Fase E — Deploys auxiliares opcionais (TeamVesting / UserSubsidy)
  // ------------------------------------------------------------------
  //
  // Flags `DEPLOY_TEAM_VESTING` e `DEPLOY_USER_SUBSIDY` ativam deploys
  // opcionais de contratos auxiliares no mesmo modulo Ignition. Como as
  // flags sao env vars lidas no build-time do modulo (limitacao do Ignition
  // — ver NatSpec do Dao.ts), precisamos invalidar o cache de modulos do
  // Node entre testes com env vars diferentes. Cada teste desta secao faz
  // o ritual: seta env, apaga cache, re-importa o modulo, deploya.
  describe("Phase E — Optional auxiliary deploys", () => {
    /**
     * Helper: re-importa o modulo Ignition com as env vars atuais e roda
     * o deploy. Apaga o cache ANTES do require para garantir que o modulo
     * re-execute `buildModule(...)` com as flags correntes.
     */
    async function deployWithFlags(env: Record<string, string | undefined>) {
      const original: Record<string, string | undefined> = {};
      for (const k of Object.keys(env)) {
        original[k] = process.env[k];
        if (env[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = env[k];
        }
      }
      try {
        // Reimporta o modulo Dao sem cache para re-executar buildModule
        // com as env vars atuais. require-based para viabilizar delete de
        // cache (ESM loaders + import() nao garantem re-execucao).
        const path = require.resolve("../../ignition/modules/Dao");
        delete require.cache[path];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../../ignition/modules/Dao");
        const deployed = await hre.ignition.deploy(mod.default, {
          deploymentId: `dao-flag-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        return deployed;
      } finally {
        for (const k of Object.keys(original)) {
          if (original[k] === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = original[k];
          }
        }
      }
    }

    it("does NOT deploy TeamVesting/UserSubsidy by default", async () => {
      const deployed = await deployWithFlags({
        DEPLOY_TEAM_VESTING: undefined,
        DEPLOY_USER_SUBSIDY: undefined,
      });
      // Shape do retorno: apenas os 10 nucleares.
      expect(deployed).to.have.property("gov");
      expect(deployed).to.have.property("credit");
      expect(deployed).to.have.property("timelock");
      expect(deployed).to.have.property("registry");
      expect(deployed).to.have.property("treasury");
      expect(deployed).to.have.property("staking");
      expect(deployed).to.have.property("burnTracker");
      expect(deployed).to.have.property("distributor");
      expect(deployed).to.have.property("feeRouter");
      expect(deployed).to.have.property("governor");
      expect(deployed).to.not.have.property("teamVesting");
      expect(deployed).to.not.have.property("userSubsidy");
    });

    it("deploys UserSubsidy only when DEPLOY_USER_SUBSIDY=true", async () => {
      const deployed = (await deployWithFlags({
        DEPLOY_TEAM_VESTING: undefined,
        DEPLOY_USER_SUBSIDY: "true",
      })) as unknown as Record<string, { getAddress(): Promise<string> }>;
      expect(deployed).to.have.property("userSubsidy");
      expect(deployed).to.not.have.property("teamVesting");

      // Wiring: CREDIT correto, admin = Timelock.
      const userSubsidy = await ethers.getContractAt(
        "UserSubsidy",
        await deployed.userSubsidy.getAddress(),
      );
      const creditAddr = await deployed.credit.getAddress();
      const timelockAddr = await deployed.timelock.getAddress();
      expect(await userSubsidy.credit()).to.equal(creditAddr);
      const ADMIN_ROLE = await userSubsidy.DEFAULT_ADMIN_ROLE();
      const GOV_ROLE = await userSubsidy.GOVERNANCE_ROLE();
      expect(await userSubsidy.hasRole(ADMIN_ROLE, timelockAddr)).to.be.true;
      expect(await userSubsidy.hasRole(GOV_ROLE, timelockAddr)).to.be.true;
    });

    it("deploys TeamVesting only when DEPLOY_TEAM_VESTING=true (requires valid beneficiary param)", async () => {
      // Antes de carregar o modulo, precisamos do endereco do deployer para
      // passar como beneficiary placeholder (o construtor do TeamVesting
      // reverte com ZeroAddress se o beneficiario nao for setado).
      const [deployer] = await ethers.getSigners();

      // Parametros sao consumidos via `m.getParameter`. Usamos Ignition
      // `parameters` option — o Ignition aceita valores via JSON.parse.
      const parameters = {
        CommunityDAOModule: {
          teamVestingBeneficiary: deployer.address,
          teamVestingStart: "0",
          teamVestingCliff: "0",
          teamVestingDuration: "31536000", // 1 ano
        },
      };

      const original = {
        DEPLOY_TEAM_VESTING: process.env.DEPLOY_TEAM_VESTING,
        DEPLOY_USER_SUBSIDY: process.env.DEPLOY_USER_SUBSIDY,
      };
      process.env.DEPLOY_TEAM_VESTING = "true";
      delete process.env.DEPLOY_USER_SUBSIDY;

      try {
        const path = require.resolve("../../ignition/modules/Dao");
        delete require.cache[path];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../../ignition/modules/Dao");
        const deployed = (await hre.ignition.deploy(mod.default, {
          parameters,
          deploymentId: `dao-flag-tv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })) as unknown as Record<string, { getAddress(): Promise<string> }>;

        expect(deployed).to.have.property("teamVesting");
        expect(deployed).to.not.have.property("userSubsidy");

        const teamVesting = await ethers.getContractAt(
          "TeamVesting",
          await deployed.teamVesting.getAddress(),
        );
        const govAddr = await deployed.gov.getAddress();
        const timelockAddr = await deployed.timelock.getAddress();
        expect(await teamVesting.token()).to.equal(govAddr);
        expect(await teamVesting.beneficiary()).to.equal(deployer.address);
        expect(await teamVesting.owner()).to.equal(timelockAddr);
      } finally {
        if (original.DEPLOY_TEAM_VESTING === undefined) {
          delete process.env.DEPLOY_TEAM_VESTING;
        } else {
          process.env.DEPLOY_TEAM_VESTING = original.DEPLOY_TEAM_VESTING;
        }
        if (original.DEPLOY_USER_SUBSIDY === undefined) {
          delete process.env.DEPLOY_USER_SUBSIDY;
        } else {
          process.env.DEPLOY_USER_SUBSIDY = original.DEPLOY_USER_SUBSIDY;
        }
      }
    });
  });
});
