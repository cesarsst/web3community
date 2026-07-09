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
 * Integration test for the CommunityDAO Ignition module (remodel 2026-07-08).
 *
 * Cobre:
 *  - Deploy dos 11 contratos core (GOV, CREDIT, Timelock, Registry, Treasury,
 *    Staking, USDC mock, CreditPSM, ProjectFunding, FeeRouterV2, Governor).
 *  - Roles funcionais corretas: PSM e MINTER+BURNER do CREDIT; FeeRouterV2 e
 *    REVENUE_NOTIFIER do ProjectFunding; Governor tem PROPOSER/CANCELLER no
 *    Timelock.
 *  - Roles de governanca cedidas ao Timelock em todos os contratos gated.
 *  - Deployer NAO retem nenhuma role (renunciou).
 *  - SEM genesis de CREDIT: totalSupply nasce 0 (supply so via PSM.buy).
 *  - GovernanceToken: pendingOwner = Timelock (acceptOwnership pendente).
 *  - Parametros economicos do Governor / Registry / FeeRouterV2 refletem o
 *    perfil DEV (defaults).
 *  - End-to-end: propose via Governor -> queue -> execute apos delay -> efeito
 *    observavel no Treasury (transfer de CREDIT). Valida a cadeia de
 *    governanca completa.
 *
 * Nota sobre USDC: o modulo Ignition deploya o USDC de lastro do PSM apenas
 * com a env flag `DEPLOY_USDC_MOCK=true` (limitacao do Ignition — ver NatSpec
 * do Dao.ts). Sem ela, o CreditPSM reverte no constructor
 * (IERC20Metadata(0).decimals()). Por isso a fixture seta a flag antes do
 * deploy e restaura o estado anterior depois.
 */
describe("Ignition: CommunityDAO module", function () {
  // O ciclo completo (propose + period + queue + delay + execute) demanda mais
  // que o default global do mocha em hardhat — bumpamos pra dar folga em CI.
  this.timeout(120_000);

  const DEV_TIMELOCK_DELAY = 3_600n; // 1h
  const DEV_VOTING_DELAY = 1n; // 1 block
  const DEV_VOTING_PERIOD = 50n; // 50 blocks
  const DEV_PROPOSAL_THRESHOLD = 10_000n * 10n ** 18n;
  const DEV_QUORUM = 4n;
  const DEV_MIN_COLLATERAL = 1_000n * 10n ** 18n;
  const DEV_PROBATION = 86_400n;

  const DEV_FEE_BPS = 250n; // 2,5%
  const DEV_FEE_TREASURY_BPS = 4000n;
  const DEV_FEE_BUYBACK_BPS = 4000n;
  const DEV_FEE_GRANTS_BPS = 2000n;

  const E6 = 10n ** 6n;
  const SCALE = 10n ** 12n; // 6 -> 18 decimais

  /**
   * Deploy do modulo com `DEPLOY_USDC_MOCK=true`. Restaura a env depois para
   * nao vazar estado entre suites.
   */
  async function ignitionDeployWithUsdcMock(opts?: Parameters<typeof hre.ignition.deploy>[1]) {
    const original = process.env.DEPLOY_USDC_MOCK;
    process.env.DEPLOY_USDC_MOCK = "true";
    try {
      // Reimporta o modulo sem cache para re-executar buildModule com a flag
      // (a flag e lida no build-time do modulo).
      const path = require.resolve("../../ignition/modules/Dao");
      delete require.cache[path];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../ignition/modules/Dao");
      return await hre.ignition.deploy(mod.default, opts);
    } finally {
      if (original === undefined) {
        delete process.env.DEPLOY_USDC_MOCK;
      } else {
        process.env.DEPLOY_USDC_MOCK = original;
      }
    }
  }

  async function deployDaoFixture() {
    const deployed = await ignitionDeployWithUsdcMock();

    const [deployer] = await ethers.getSigners();

    const [
      gov,
      credit,
      timelock,
      registry,
      treasury,
      staking,
      usdc,
      psm,
      funding,
      feeRouterV2,
      governor,
    ] = await Promise.all([
      ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress()),
      ethers.getContractAt("CreditToken", await deployed.credit.getAddress()),
      ethers.getContractAt("CommunityTimelock", await deployed.timelock.getAddress()),
      ethers.getContractAt("ProjectRegistry", await deployed.registry.getAddress()),
      ethers.getContractAt("Treasury", await deployed.treasury.getAddress()),
      ethers.getContractAt("Staking", await deployed.staking.getAddress()),
      ethers.getContractAt("ERC20DecimalsMock", await deployed.usdc.getAddress()),
      ethers.getContractAt("CreditPSM", await deployed.psm.getAddress()),
      ethers.getContractAt("ProjectFunding", await deployed.funding.getAddress()),
      ethers.getContractAt("FeeRouterV2", await deployed.feeRouterV2.getAddress()),
      ethers.getContractAt("CommunityGovernor", await deployed.governor.getAddress()),
    ]);

    return {
      gov,
      credit,
      timelock,
      registry,
      treasury,
      staking,
      usdc,
      psm,
      funding,
      feeRouterV2,
      governor,
      deployer,
    };
  }

  describe("Phase A — Deploy", () => {
    it("deploys all 11 contracts with non-zero, distinct addresses", async () => {
      const { gov, credit, timelock, registry, treasury, staking, usdc, psm, funding, feeRouterV2, governor } =
        await loadFixture(deployDaoFixture);

      const addresses = await Promise.all([
        gov.getAddress(),
        credit.getAddress(),
        timelock.getAddress(),
        registry.getAddress(),
        treasury.getAddress(),
        staking.getAddress(),
        usdc.getAddress(),
        psm.getAddress(),
        funding.getAddress(),
        feeRouterV2.getAddress(),
        governor.getAddress(),
      ]);

      const set = new Set(addresses);
      expect(set.size).to.equal(addresses.length);
      for (const addr of addresses) {
        expect(addr).to.not.equal(ethers.ZeroAddress);
      }
    });

    it("wires immutable references between contracts correctly", async () => {
      const { gov, credit, registry, staking, usdc, psm, funding, feeRouterV2, governor, timelock, treasury } =
        await loadFixture(deployDaoFixture);

      // Staking aponta pra GOV + Registry
      expect(await staking.GOV_TOKEN()).to.equal(await gov.getAddress());
      expect(await staking.REGISTRY()).to.equal(await registry.getAddress());

      // Registry aponta pra GOV
      expect(await registry.govToken()).to.equal(await gov.getAddress());

      // CreditPSM aponta pra CREDIT + USDC, escala 1e12 (6 -> 18)
      expect(await psm.CREDIT()).to.equal(await credit.getAddress());
      expect(await psm.USDC()).to.equal(await usdc.getAddress());
      expect(await psm.SCALE()).to.equal(SCALE);

      // ProjectFunding aponta pra CREDIT + Registry + Staking
      expect(await funding.CREDIT()).to.equal(await credit.getAddress());
      expect(await funding.REGISTRY()).to.equal(await registry.getAddress());
      expect(await funding.STAKING()).to.equal(await staking.getAddress());

      // FeeRouterV2 aponta pra CREDIT + Registry + Funding
      expect(await feeRouterV2.CREDIT()).to.equal(await credit.getAddress());
      expect(await feeRouterV2.REGISTRY()).to.equal(await registry.getAddress());
      expect(await feeRouterV2.FUNDING()).to.equal(await funding.getAddress());
      // Recipients iniciais = Treasury para as tres parcelas.
      const treasuryAddr = await treasury.getAddress();
      expect(await feeRouterV2.treasuryRecipient()).to.equal(treasuryAddr);
      expect(await feeRouterV2.buybackRecipient()).to.equal(treasuryAddr);
      expect(await feeRouterV2.grantsRecipient()).to.equal(treasuryAddr);

      // Governor aponta pra GOV + Timelock
      expect(await governor.token()).to.equal(await gov.getAddress());
      expect(await governor.timelock()).to.equal(await timelock.getAddress());
    });
  });

  describe("Phase B — Functional role grants", () => {
    it("grants MINTER_ROLE and BURNER_ROLE on CreditToken to CreditPSM", async () => {
      const { credit, psm } = await loadFixture(deployDaoFixture);
      const MINTER_ROLE = await credit.MINTER_ROLE();
      const BURNER_ROLE = await credit.BURNER_ROLE();
      const psmAddr = await psm.getAddress();
      expect(await credit.hasRole(MINTER_ROLE, psmAddr)).to.be.true;
      expect(await credit.hasRole(BURNER_ROLE, psmAddr)).to.be.true;
    });

    it("grants REVENUE_NOTIFIER_ROLE on ProjectFunding to FeeRouterV2", async () => {
      const { funding, feeRouterV2 } = await loadFixture(deployDaoFixture);
      const NOTIFIER_ROLE = await funding.REVENUE_NOTIFIER_ROLE();
      expect(await funding.hasRole(NOTIFIER_ROLE, await feeRouterV2.getAddress())).to.be.true;
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
      expect(await timelock.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress)).to.be.true;
      expect(await timelock.hasRole(EXECUTOR_ROLE, await governor.getAddress())).to.be.false;
      expect(await timelock.hasRole(EXECUTOR_ROLE, deployer.address)).to.be.false;
    });

    it("does NOT perform any genesis mint of CREDIT (supply starts at zero)", async () => {
      const { credit, treasury } = await loadFixture(deployDaoFixture);
      // No modelo vigente todo CREDIT nasce no PSM contra deposito de USDC.
      expect(await credit.totalSupply()).to.equal(0n);
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(0n);
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

    it("transfers GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE on ProjectFunding to Timelock", async () => {
      const { funding, timelock } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await funding.GOVERNANCE_ROLE();
      const ADMIN_ROLE = await funding.DEFAULT_ADMIN_ROLE();
      const tlAddr = await timelock.getAddress();
      expect(await funding.hasRole(GOV_ROLE, tlAddr)).to.be.true;
      expect(await funding.hasRole(ADMIN_ROLE, tlAddr)).to.be.true;
    });

    it("transfers GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE on FeeRouterV2 to Timelock", async () => {
      const { feeRouterV2, timelock } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await feeRouterV2.GOVERNANCE_ROLE();
      const ADMIN_ROLE = await feeRouterV2.DEFAULT_ADMIN_ROLE();
      const tlAddr = await timelock.getAddress();
      expect(await feeRouterV2.hasRole(GOV_ROLE, tlAddr)).to.be.true;
      expect(await feeRouterV2.hasRole(ADMIN_ROLE, tlAddr)).to.be.true;
    });

    it("transfers DEFAULT_ADMIN_ROLE on CreditToken to Timelock", async () => {
      const { credit, timelock } = await loadFixture(deployDaoFixture);
      const ADMIN_ROLE = await credit.DEFAULT_ADMIN_ROLE();
      expect(await credit.hasRole(ADMIN_ROLE, await timelock.getAddress())).to.be.true;
    });

    it("initiates Ownable2Step transfer of GovernanceToken to Timelock (pendingOwner set)", async () => {
      const { gov, timelock, deployer } = await loadFixture(deployDaoFixture);
      expect(await gov.pendingOwner()).to.equal(await timelock.getAddress());
      expect(await gov.owner()).to.equal(deployer.address);
    });

    it("Timelock can complete acceptOwnership of GovernanceToken (simulated via impersonate)", async () => {
      const { gov, timelock } = await loadFixture(deployDaoFixture);
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
    it("deployer no longer holds GOVERNANCE_ROLE on any gated contract", async () => {
      const { registry, treasury, funding, feeRouterV2, deployer } =
        await loadFixture(deployDaoFixture);

      const contracts = [registry, treasury, funding, feeRouterV2];
      for (const c of contracts) {
        const role = await c.GOVERNANCE_ROLE();
        expect(await c.hasRole(role, deployer.address)).to.be.false;
      }
    });

    it("deployer no longer holds DEFAULT_ADMIN_ROLE on any contract", async () => {
      const { registry, treasury, funding, feeRouterV2, credit, timelock, deployer } =
        await loadFixture(deployDaoFixture);

      const contracts = [registry, treasury, funding, feeRouterV2, credit, timelock];
      for (const c of contracts) {
        const role = await c.DEFAULT_ADMIN_ROLE();
        expect(await c.hasRole(role, deployer.address)).to.be.false;
      }
    });

    it("deployer cannot grant roles anywhere (system fully governance-controlled)", async () => {
      const { registry, deployer } = await loadFixture(deployDaoFixture);
      const GOV_ROLE = await registry.GOVERNANCE_ROLE();
      await expect(
        registry.connect(deployer).grantRole(GOV_ROLE, deployer.address),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("deployer cannot register projects directly in Registry (only Timelock can, via Governor)", async () => {
      const { registry, deployer } = await loadFixture(deployDaoFixture);
      await expect(
        registry
          .connect(deployer)
          .registerProject(deployer.address, "ipfs://x", DEV_MIN_COLLATERAL),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("deployer cannot move funds from Treasury (only Timelock can, via Governor)", async () => {
      const { credit, treasury, deployer } = await loadFixture(deployDaoFixture);
      await expect(
        treasury.connect(deployer).transfer(await credit.getAddress(), deployer.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Configuration sanity checks", () => {
    it("FeeRouterV2 has 2,5% fee with 40/40/20 split (DEV defaults)", async () => {
      const { feeRouterV2 } = await loadFixture(deployDaoFixture);
      expect(await feeRouterV2.feeBps()).to.equal(DEV_FEE_BPS);
      const split = await feeRouterV2.feeSplit();
      expect(split.treasuryBps).to.equal(DEV_FEE_TREASURY_BPS);
      expect(split.buybackBps).to.equal(DEV_FEE_BUYBACK_BPS);
      expect(split.grantsBps).to.equal(DEV_FEE_GRANTS_BPS);
      // Teto duro da fee = 5%.
      expect(await feeRouterV2.FEE_BPS_CAP()).to.equal(500n);
    });

    it("CreditPSM converts USDC 6 -> CREDIT 18 at 1:1 (buy/sell roundtrip)", async () => {
      const { usdc, credit, psm, deployer } = await loadFixture(deployDaoFixture);
      const usdcIn = 1_000n * E6;
      await usdc.mint(deployer.address, usdcIn);
      await usdc.connect(deployer).approve(await psm.getAddress(), usdcIn);
      await psm.connect(deployer).buy(usdcIn);
      expect(await credit.balanceOf(deployer.address)).to.equal(usdcIn * SCALE);
      expect(await psm.backing()).to.equal(usdcIn);
      expect(await psm.mintedOutstanding()).to.equal(usdcIn * SCALE);
    });

    it("ProjectFunding has correct rev-share/duration bounds (contract constants)", async () => {
      const { funding } = await loadFixture(deployDaoFixture);
      expect(await funding.MIN_REV_SHARE_BPS()).to.equal(100n);
      expect(await funding.MAX_REV_SHARE_BPS()).to.equal(3000n);
      expect(await funding.MIN_ROUND_DURATION()).to.equal(86_400n); // 1d
      expect(await funding.MAX_ROUND_DURATION()).to.equal(90n * 86_400n); // 90d
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
      const { gov, treasury, governor, timelock, credit, usdc, psm, deployer } =
        await loadFixture(deployDaoFixture);

      // Bootstrap pos-deploy: Timelock aceita o ownership do GOV pra mintar
      // para o voter. Em prod isso vira proposta; aqui simulamos via impersonate.
      const tlAddr = await timelock.getAddress();
      await impersonateAccount(tlAddr);
      const tlSigner = await ethers.getSigner(tlAddr);
      await setBalance(tlSigner.address, ethers.parseEther("100"));
      await gov.connect(tlSigner).acceptOwnership();

      // Mint GOV para um voter (impersonate do Timelock, owner do GOV).
      const [, voter, recipient] = await ethers.getSigners();
      const voterPower = 50_000_000n * 10n ** 18n; // 50% do cap, garante quorum
      await gov.connect(tlSigner).mint(voter.address, voterPower, "test:voter");
      await gov.connect(voter).delegate(voter.address);
      await mine(1);

      // Sem genesis: financiamos o Treasury com CREDIT via PSM.buy + transfer.
      const transferAmount = 1_000n * 10n ** 18n;
      const usdcIn = 1_000n * E6; // vira 1000 CREDIT
      await usdc.mint(deployer.address, usdcIn);
      await usdc.connect(deployer).approve(await psm.getAddress(), usdcIn);
      await psm.connect(deployer).buy(usdcIn);
      await credit.connect(deployer).transfer(await treasury.getAddress(), transferAmount);
      expect(await credit.balanceOf(await treasury.getAddress())).to.equal(transferAmount);

      // Proposta: Treasury.transfer(CREDIT, recipient, 1_000e18).
      const calldata = treasury.interface.encodeFunctionData("transfer", [
        await credit.getAddress(),
        recipient.address,
        transferAmount,
      ]);

      const description = "Test proposal: transfer 1000 CREDIT from Treasury to recipient";
      const descriptionHash = ethers.id(description);

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

      await mine(2);
      await governor.connect(voter).castVote(proposalId, 1);
      await mine(Number(DEV_VOTING_PERIOD));

      await governor
        .connect(voter)
        .queue([await treasury.getAddress()], [0], [calldata], descriptionHash);

      await ethers.provider.send("evm_increaseTime", [Number(DEV_TIMELOCK_DELAY) + 1]);
      await mine(1);

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
  // Fase E — Deploy auxiliar opcional (TeamVesting)
  // ------------------------------------------------------------------
  //
  // A flag `DEPLOY_TEAM_VESTING` ativa o deploy opcional do TeamVesting no
  // mesmo modulo. Como e uma env var lida no build-time do modulo (limitacao
  // do Ignition — ver NatSpec do Dao.ts), o helper reimporta o modulo sem
  // cache. `DEPLOY_USDC_MOCK` continua necessario (PSM reverte sem lastro).
  describe("Phase E — Optional auxiliary deploy (TeamVesting)", () => {
    it("does NOT deploy TeamVesting by default", async () => {
      const original = process.env.DEPLOY_TEAM_VESTING;
      delete process.env.DEPLOY_TEAM_VESTING;
      try {
        const deployed = await ignitionDeployWithUsdcMock({
          deploymentId: `dao-flag-default-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        // Shape do retorno: apenas os 11 nucleares.
        expect(deployed).to.have.property("gov");
        expect(deployed).to.have.property("credit");
        expect(deployed).to.have.property("timelock");
        expect(deployed).to.have.property("registry");
        expect(deployed).to.have.property("treasury");
        expect(deployed).to.have.property("staking");
        expect(deployed).to.have.property("usdc");
        expect(deployed).to.have.property("psm");
        expect(deployed).to.have.property("funding");
        expect(deployed).to.have.property("feeRouterV2");
        expect(deployed).to.have.property("governor");
        expect(deployed).to.not.have.property("teamVesting");
      } finally {
        if (original === undefined) {
          delete process.env.DEPLOY_TEAM_VESTING;
        } else {
          process.env.DEPLOY_TEAM_VESTING = original;
        }
      }
    });

    it("deploys TeamVesting only when DEPLOY_TEAM_VESTING=true (requires valid beneficiary param)", async () => {
      const [deployer] = await ethers.getSigners();

      const parameters = {
        CommunityDAOModule: {
          teamVestingBeneficiary: deployer.address,
          teamVestingStart: "0",
          teamVestingCliff: "0",
          teamVestingDuration: "31536000", // 1 ano
        },
      };

      const original = process.env.DEPLOY_TEAM_VESTING;
      process.env.DEPLOY_TEAM_VESTING = "true";
      try {
        const deployed = (await ignitionDeployWithUsdcMock({
          parameters,
          deploymentId: `dao-flag-tv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })) as unknown as Record<string, { getAddress(): Promise<string> }>;

        expect(deployed).to.have.property("teamVesting");

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
        if (original === undefined) {
          delete process.env.DEPLOY_TEAM_VESTING;
        } else {
          process.env.DEPLOY_TEAM_VESTING = original;
        }
      }
    });
  });
});
