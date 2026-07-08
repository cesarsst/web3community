import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";

/**
 * CommunityGovernor test suite.
 *
 * Cobre:
 *  - Construcao: parametros, clock mode via token ERC20Votes, binding com
 *    Timelock, name/version do EIP-712.
 *  - Threshold de proposta (proposer precisa ter delegated votes >= threshold).
 *  - Voting delay e period: voto antes revert, voto depois revert.
 *  - Counting For/Against/Abstain e state transitions (Pending, Active, Defeated,
 *    Succeeded, Queued, Executed, Canceled).
 *  - Quorum: proposta com < 4% Abstain/For apos period -> Defeated.
 *  - Full E2E: propose -> delay -> vote -> period -> queue -> timelock delay ->
 *    execute, com efeito observavel em Treasury (invariante I4).
 *  - Governance invariant I7: registrar projeto em ProjectRegistry via proposta.
 *  - onlyGovernance: setVotingDelay / setVotingPeriod / setProposalThreshold /
 *    updateQuorumNumerator direct-call revertem; via proposal funcionam.
 *  - Cancel flow (proposer cancela enquanto Pending).
 *  - View helpers: proposalVotes, proposalEta, hasVoted, proposalNeedsQueuing,
 *    proposalThreshold, quorum(timepoint), token(), timelock().
 */
describe("CommunityGovernor", function () {
  // Parametros de dev/teste
  const VOTING_DELAY = 1; // 1 block
  const VOTING_PERIOD = 50; // 50 blocks
  const PROPOSAL_THRESHOLD = 10_000n * 10n ** 18n;
  const QUORUM_NUMERATOR = 4n; // 4%
  const TIMELOCK_DELAY = 3600n; // 1h

  // Distribuicao de GOV (total = 30M, bem abaixo do cap de 100M)
  const GOV_VOTER_A = 6_000_000n * 10n ** 18n; // 20% do supply votante
  const GOV_VOTER_B = 4_000_000n * 10n ** 18n;
  const GOV_VOTER_C = 1_000_000n * 10n ** 18n;
  const GOV_PROPOSER = 20_000n * 10n ** 18n; // acima do threshold
  const GOV_SPAM = 100n * 10n ** 18n; // abaixo do threshold

  async function deployFixture() {
    const [admin, voterA, voterB, voterC, proposer, spammer, recipient] = await ethers.getSigners();

    // 1. GovernanceToken (admin = deployer)
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy("Web3Community Governance", "GOV", admin.address);
    await gov.waitForDeployment();

    // 2. CommunityTimelock (admin = deployer, proposers=[], executors=[0x0])
    const Timelock = await ethers.getContractFactory("CommunityTimelock");
    const timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [ethers.ZeroAddress], admin.address);
    await timelock.waitForDeployment();

    // 3. Treasury gated com GOVERNANCE_ROLE = Timelock (I4). Deployado ANTES
    //    do Governor porque o construtor do Governor agora recebe o endereco
    //    do Treasury (scan de proposal types / supermajority em removePOL).
    //    O 3o argumento (USDC) e zero — buyback FFP nao e exercido neste
    //    suite. Para satisfazer o construtor, fornecemos um CREDIT placeholder
    //    (qualquer endereco nao-zero) — usamos o GOV (mesmo ja deployado)
    //    apenas como sentinela; o FFP nao opera porque oracle/router/feed
    //    nao serao setados.
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      admin.address,
      await gov.getAddress(),
      ethers.ZeroAddress,
    );
    await treasury.waitForDeployment();
    const TREASURY_GOV_ROLE = await treasury.GOVERNANCE_ROLE();
    await treasury.connect(admin).grantRole(TREASURY_GOV_ROLE, await timelock.getAddress());
    // Admin renuncia sua propria GOVERNANCE_ROLE (simulacao de prod).
    await treasury.connect(admin).renounceRole(TREASURY_GOV_ROLE, admin.address);

    // 4. CommunityGovernor (recebe o Treasury para o scan de removePOL).
    const Governor = await ethers.getContractFactory("CommunityGovernor");
    const governor = await Governor.deploy(
      await gov.getAddress(),
      await timelock.getAddress(),
      await treasury.getAddress(),
      VOTING_DELAY,
      VOTING_PERIOD,
      PROPOSAL_THRESHOLD,
      QUORUM_NUMERATOR,
    );
    await governor.waitForDeployment();

    // 5. Wiring: Governor recebe PROPOSER_ROLE e CANCELLER_ROLE no Timelock.
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    const DEFAULT_ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();
    await timelock.connect(admin).grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.connect(admin).grantRole(CANCELLER_ROLE, await governor.getAddress());

    // 6. Mint GOV e delegate.
    await gov.connect(admin).mint(voterA.address, GOV_VOTER_A, "test:voterA");
    await gov.connect(admin).mint(voterB.address, GOV_VOTER_B, "test:voterB");
    await gov.connect(admin).mint(voterC.address, GOV_VOTER_C, "test:voterC");
    await gov.connect(admin).mint(proposer.address, GOV_PROPOSER, "test:proposer");
    await gov.connect(admin).mint(spammer.address, GOV_SPAM, "test:spam");

    // Self-delegate para ativar voting power (ERC20Votes exige delegate).
    await gov.connect(voterA).delegate(voterA.address);
    await gov.connect(voterB).delegate(voterB.address);
    await gov.connect(voterC).delegate(voterC.address);
    await gov.connect(proposer).delegate(proposer.address);
    await gov.connect(spammer).delegate(spammer.address);

    // 7. Treasury seed: recebe tokens USDC mock para o teste E2E.
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();
    await usdc.mint(await treasury.getAddress(), 10_000_000n);

    // 8. ProjectRegistry (I7). admin ainda tem GOVERNANCE_ROLE aqui pra facilitar
    //    bootstrap; renuncia para que apenas Timelock consiga registrar.
    const ProjectRegistry = await ethers.getContractFactory("ProjectRegistry");
    const registry = await ProjectRegistry.deploy(
      await gov.getAddress(),
      admin.address,
      1_000n * 10n ** 18n, // minCollateral
      30 * 24 * 3600, // probationDuration
    );
    await registry.waitForDeployment();
    const REGISTRY_GOV_ROLE = await registry.GOVERNANCE_ROLE();
    await registry.connect(admin).grantRole(REGISTRY_GOV_ROLE, await timelock.getAddress());
    await registry.connect(admin).renounceRole(REGISTRY_GOV_ROLE, admin.address);

    // 9. Mine 1 block para que o snapshot (currentBlock - 1) veja os delegates.
    await mine(1);

    return {
      gov,
      timelock,
      governor,
      treasury,
      registry,
      usdc,
      admin,
      voterA,
      voterB,
      voterC,
      proposer,
      spammer,
      recipient,
      PROPOSER_ROLE,
      CANCELLER_ROLE,
      DEFAULT_ADMIN_ROLE,
      TREASURY_GOV_ROLE,
    };
  }

  // Helper: monta os 4 args de proposal (targets, values, calldatas, description).
  async function buildTransferProposal(
    treasuryAddr: string,
    tokenAddr: string,
    to: string,
    amount: bigint,
    desc: string,
  ) {
    const treasury = await ethers.getContractAt("Treasury", treasuryAddr);
    const calldata = treasury.interface.encodeFunctionData("transfer", [tokenAddr, to, amount]);
    return {
      targets: [treasuryAddr],
      values: [0n],
      calldatas: [calldata],
      description: desc,
      descriptionHash: ethers.id(desc),
    };
  }

  describe("construction", function () {
    it("stores settings and references", async function () {
      const { governor, gov, timelock } = await loadFixture(deployFixture);
      expect(await governor.name()).to.equal("CommunityGovernor");
      expect(await governor.version()).to.equal("1");
      expect(await governor.votingDelay()).to.equal(VOTING_DELAY);
      expect(await governor.votingPeriod()).to.equal(VOTING_PERIOD);
      expect(await governor.proposalThreshold()).to.equal(PROPOSAL_THRESHOLD);
      expect(await governor["quorumNumerator()"]()).to.equal(QUORUM_NUMERATOR);
      expect(await governor.quorumDenominator()).to.equal(100n);
      expect(await governor.token()).to.equal(await gov.getAddress());
      expect(await governor.timelock()).to.equal(await timelock.getAddress());
    });

    it("clock mode defers to token (block number)", async function () {
      const { governor } = await loadFixture(deployFixture);
      expect(await governor.CLOCK_MODE()).to.equal("mode=blocknumber&from=default");
      const bn = await ethers.provider.getBlockNumber();
      expect(await governor.clock()).to.equal(BigInt(bn));
    });

    it("reverts with GovernorInvalidVotingPeriod when votingPeriod == 0", async function () {
      const [admin] = await ethers.getSigners();
      const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
      const gov = await GovernanceToken.deploy("GOV", "GOV", admin.address);
      const Timelock = await ethers.getContractFactory("CommunityTimelock");
      const tl = await Timelock.deploy(TIMELOCK_DELAY, [], [ethers.ZeroAddress], admin.address);
      const Governor = await ethers.getContractFactory("CommunityGovernor");
      await expect(
        Governor.deploy(
          await gov.getAddress(),
          await tl.getAddress(),
          ethers.ZeroAddress, // deploy dev sem treasury — scan de removePOL desativado
          VOTING_DELAY,
          0,
          PROPOSAL_THRESHOLD,
          QUORUM_NUMERATOR,
        ),
      ).to.be.revertedWithCustomError(Governor, "GovernorInvalidVotingPeriod");
    });

    it("reverts with GovernorInvalidQuorumFraction when numerator > 100", async function () {
      const [admin] = await ethers.getSigners();
      const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
      const gov = await GovernanceToken.deploy("GOV", "GOV", admin.address);
      const Timelock = await ethers.getContractFactory("CommunityTimelock");
      const tl = await Timelock.deploy(TIMELOCK_DELAY, [], [ethers.ZeroAddress], admin.address);
      const Governor = await ethers.getContractFactory("CommunityGovernor");
      await expect(
        Governor.deploy(
          await gov.getAddress(),
          await tl.getAddress(),
          ethers.ZeroAddress, // deploy dev sem treasury — scan de removePOL desativado
          VOTING_DELAY,
          VOTING_PERIOD,
          PROPOSAL_THRESHOLD,
          101,
        ),
      ).to.be.revertedWithCustomError(Governor, "GovernorInvalidQuorumFraction");
    });

    it("proposalNeedsQueuing returns true with timelock", async function () {
      const { governor } = await loadFixture(deployFixture);
      expect(await governor.proposalNeedsQueuing(0)).to.equal(true);
    });

    it("COUNTING_MODE identifies GovernorCountingSimple", async function () {
      const { governor } = await loadFixture(deployFixture);
      expect(await governor.COUNTING_MODE()).to.equal("support=bravo&quorum=for,abstain");
    });
  });

  describe("proposal threshold", function () {
    it("reverts propose when proposer has < threshold delegated votes", async function () {
      const { governor, treasury, usdc, spammer, recipient } = await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-spam",
      );
      await expect(
        governor.connect(spammer).propose(p.targets, p.values, p.calldatas, p.description),
      ).to.be.revertedWithCustomError(governor, "GovernorInsufficientProposerVotes");
    });

    it("allows propose for proposer exactly at threshold", async function () {
      const { governor, treasury, usdc, proposer, recipient } = await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-ok",
      );
      await expect(
        governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description),
      ).to.emit(governor, "ProposalCreated");
    });
  });

  describe("voting lifecycle (delay / period / counting)", function () {
    it("reverts cast before voting delay (Pending state)", async function () {
      const { governor, treasury, usdc, proposer, voterA, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-delay",
      );
      const tx = await governor
        .connect(proposer)
        .propose(p.targets, p.values, p.calldatas, p.description);
      const rcpt = await tx.wait();
      const pid = rcpt!.logs
        .map((l) => {
          try {
            return governor.interface.parseLog({ topics: [...l.topics], data: l.data });
          } catch {
            return null;
          }
        })
        .find((l) => l?.name === "ProposalCreated")!.args.proposalId;

      expect(await governor.state(pid)).to.equal(0n); // Pending
      await expect(governor.connect(voterA).castVote(pid, 1)).to.be.revertedWithCustomError(
        governor,
        "GovernorUnexpectedProposalState",
      );
    });

    it("reverts cast after voting period (Defeated/Succeeded state)", async function () {
      const { governor, treasury, usdc, proposer, voterA, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-late",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      await mine(VOTING_DELAY + VOTING_PERIOD + 1);
      await expect(governor.connect(voterA).castVote(pid, 1)).to.be.revertedWithCustomError(
        governor,
        "GovernorUnexpectedProposalState",
      );
    });

    it("counts For / Against / Abstain and exposes proposalVotes", async function () {
      const { governor, treasury, usdc, proposer, voterA, voterB, voterC, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-count",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      await mine(VOTING_DELAY + 1);

      await governor.connect(voterA).castVote(pid, 1); // For
      await governor.connect(voterB).castVote(pid, 0); // Against
      await governor.connect(voterC).castVoteWithReason(pid, 2, "abstain-because"); // Abstain

      const votes = await governor.proposalVotes(pid);
      expect(votes.againstVotes).to.equal(GOV_VOTER_B);
      expect(votes.forVotes).to.equal(GOV_VOTER_A);
      expect(votes.abstainVotes).to.equal(GOV_VOTER_C);

      expect(await governor.hasVoted(pid, voterA.address)).to.equal(true);
      expect(await governor.hasVoted(pid, voterB.address)).to.equal(true);
      expect(await governor.hasVoted(pid, voterC.address)).to.equal(true);
      expect(await governor.hasVoted(pid, proposer.address)).to.equal(false);
    });

    it("prevents double-voting (GovernorAlreadyCastVote)", async function () {
      const { governor, treasury, usdc, proposer, voterA, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-double",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      await mine(VOTING_DELAY + 1);
      await governor.connect(voterA).castVote(pid, 1);
      await expect(governor.connect(voterA).castVote(pid, 0)).to.be.revertedWithCustomError(
        governor,
        "GovernorAlreadyCastVote",
      );
    });

    it("quorum(timepoint) equals totalSupply * 4 / 100 at snapshot", async function () {
      const { governor, gov, treasury, usdc, proposer, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-quorum",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      const snap = await governor.proposalSnapshot(pid);
      const totalSupply = await gov.totalSupply();
      // Snapshot e no futuro (current + 1 = votingDelay) — avancamos blocos
      // ate passar do snapshot para permitir getPastTotalSupply.
      await mine(VOTING_DELAY + 1);
      expect(await governor.quorum(snap)).to.equal((totalSupply * QUORUM_NUMERATOR) / 100n);
    });

    it("proposta Defeated: quorum atingido mas Against > For", async function () {
      const { governor, treasury, usdc, proposer, voterA, voterB, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-defeated",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      await mine(VOTING_DELAY + 1);
      // VoterA = 6M For, VoterB = 4M Against -> For > Against, mas...
      // Inverter: VoterA Against, VoterB For -> Against > For -> Defeated
      await governor.connect(voterA).castVote(pid, 0); // Against
      await governor.connect(voterB).castVote(pid, 1); // For

      await mine(VOTING_PERIOD + 1);
      // 3 = Defeated
      expect(await governor.state(pid)).to.equal(3n);
    });
  });

  describe("full E2E: propose -> queue -> execute (invariante I4)", function () {
    it("transfers USDC via proposal ratified by voters", async function () {
      const { governor, timelock, treasury, usdc, proposer, voterA, voterB, recipient } =
        await loadFixture(deployFixture);

      const amount = 42_000n;
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        amount,
        "Transfer 42k USDC to recipient for milestone #1",
      );

      // Propose
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);

      // Pending -> Active
      await mine(VOTING_DELAY + 1);
      expect(await governor.state(pid)).to.equal(1n); // Active

      await governor.connect(voterA).castVote(pid, 1); // 6M For
      await governor.connect(voterB).castVote(pid, 1); // 4M For
      // Quorum = 4% de 31.02M = ~1.24M. 10M For cobre sobrando.

      // Espera o voting period
      await mine(VOTING_PERIOD + 1);
      expect(await governor.state(pid)).to.equal(4n); // Succeeded

      // Queue
      await expect(governor.queue(p.targets, p.values, p.calldatas, p.descriptionHash)).to.emit(
        timelock,
        "CallScheduled",
      );
      expect(await governor.state(pid)).to.equal(5n); // Queued

      // Execute antes do delay reverte
      await expect(
        governor.execute(p.targets, p.values, p.calldatas, p.descriptionHash),
      ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

      // Avanca o timelock delay e executa
      await time.increase(TIMELOCK_DELAY);
      await expect(governor.execute(p.targets, p.values, p.calldatas, p.descriptionHash))
        .to.emit(treasury, "Transferred")
        .withArgs(await usdc.getAddress(), recipient.address, amount);

      expect(await usdc.balanceOf(recipient.address)).to.equal(amount);
      expect(await governor.state(pid)).to.equal(7n); // Executed
    });

    it("Treasury.transfer direct call from non-timelock reverts (I4 neg-case)", async function () {
      const { treasury, usdc, admin, recipient } = await loadFixture(deployFixture);
      // Admin renunciou GOVERNANCE_ROLE na fixture; agora so Timelock pode.
      await expect(
        treasury.connect(admin).transfer(await usdc.getAddress(), recipient.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });
  });

  describe("full E2E: register project (invariante I7)", function () {
    it("only governance proposal can register a project", async function () {
      const { governor, registry, gov, proposer, voterA, voterB } =
        await loadFixture(deployFixture);

      const minColl = 1_000n * 10n ** 18n;
      // O colateral e puxado do `owner` (voterA), nao do Timelock. VoterA ja
      // tem GOV; precisa approve ao Registry antes da proposta executar.
      // Tipicamente isso aconteceria off-chain ("assine este approve antes
      // da votacao fechar"); aqui fazemos direto.
      const registryAddr = await registry.getAddress();
      await gov.connect(voterA).approve(registryAddr, minColl);

      const registerData = registry.interface.encodeFunctionData("registerProject", [
        voterA.address,
        "ipfs://project-a",
        minColl,
      ]);

      const targets = [registryAddr];
      const values = [0n];
      const calldatas = [registerData];
      const desc = "Register project A with minCollateral";
      const descHash = ethers.id(desc);

      await governor.connect(proposer).propose(targets, values, calldatas, desc);
      const pid = await governor.hashProposal(targets, values, calldatas, descHash);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voterA).castVote(pid, 1);
      await governor.connect(voterB).castVote(pid, 1);
      await mine(VOTING_PERIOD + 1);

      await governor.queue(targets, values, calldatas, descHash);
      await time.increase(TIMELOCK_DELAY);

      await expect(governor.execute(targets, values, calldatas, descHash)).to.emit(
        registry,
        "ProjectRegistered",
      );

      // Projeto existe e esta Pending.
      const project = await registry.getProject(1n);
      expect(project.owner).to.equal(voterA.address);
      expect(project.collateral).to.equal(minColl);
    });

    it("non-timelock direct call to registerProject reverts (I7 neg-case)", async function () {
      const { registry, admin, voterA } = await loadFixture(deployFixture);
      await expect(
        registry.connect(admin).registerProject(voterA.address, "ipfs://x", 1_000n * 10n ** 18n),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("onlyGovernance setters", function () {
    it("direct setVotingDelay reverts; via proposal succeeds", async function () {
      const { governor, proposer, voterA, voterB } = await loadFixture(deployFixture);
      // Direct
      await expect(governor.connect(proposer).setVotingDelay(2)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );

      // Via proposal
      const calldata = governor.interface.encodeFunctionData("setVotingDelay", [2]);
      const targets = [await governor.getAddress()];
      const values = [0n];
      const calldatas = [calldata];
      const desc = "bump voting delay";
      const descHash = ethers.id(desc);
      await governor.connect(proposer).propose(targets, values, calldatas, desc);
      const pid = await governor.hashProposal(targets, values, calldatas, descHash);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voterA).castVote(pid, 1);
      await governor.connect(voterB).castVote(pid, 1);
      await mine(VOTING_PERIOD + 1);

      await governor.queue(targets, values, calldatas, descHash);
      await time.increase(TIMELOCK_DELAY);
      await expect(governor.execute(targets, values, calldatas, descHash)).to.emit(
        governor,
        "VotingDelaySet",
      );
      expect(await governor.votingDelay()).to.equal(2n);
    });

    it("direct setVotingPeriod / setProposalThreshold / updateQuorumNumerator revert", async function () {
      const { governor, proposer } = await loadFixture(deployFixture);
      await expect(governor.connect(proposer).setVotingPeriod(100)).to.be.revertedWithCustomError(
        governor,
        "GovernorOnlyExecutor",
      );
      await expect(
        governor.connect(proposer).setProposalThreshold(1n),
      ).to.be.revertedWithCustomError(governor, "GovernorOnlyExecutor");
      await expect(
        governor.connect(proposer).updateQuorumNumerator(10),
      ).to.be.revertedWithCustomError(governor, "GovernorOnlyExecutor");
      await expect(
        governor
          .connect(proposer)
          .updateTimelock(await (await loadFixture(deployFixture)).timelock.getAddress()),
      ).to.be.revertedWithCustomError(governor, "GovernorOnlyExecutor");
    });
  });

  describe("cancel flow", function () {
    it("proposer cancels while Pending", async function () {
      const { governor, treasury, usdc, proposer, recipient } = await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-cancel",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      await expect(
        governor.connect(proposer).cancel(p.targets, p.values, p.calldatas, p.descriptionHash),
      ).to.emit(governor, "ProposalCanceled");
      expect(await governor.state(pid)).to.equal(2n); // Canceled
    });

    it("non-proposer cannot cancel Pending proposal", async function () {
      const { governor, treasury, usdc, proposer, voterA, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-cancel2",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      await expect(
        governor.connect(voterA).cancel(p.targets, p.values, p.calldatas, p.descriptionHash),
      ).to.be.revertedWithCustomError(governor, "GovernorOnlyProposer");
    });
  });

  describe("queue guards", function () {
    it("reverts queue when proposal not Succeeded", async function () {
      const { governor, treasury, usdc, proposer, recipient } = await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-unready",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      await expect(
        governor.queue(p.targets, p.values, p.calldatas, p.descriptionHash),
      ).to.be.revertedWithCustomError(governor, "GovernorUnexpectedProposalState");
    });

    it("proposalEta is 0 before queue, nonzero after", async function () {
      const { governor, treasury, usdc, proposer, voterA, voterB, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-eta",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      expect(await governor.proposalEta(pid)).to.equal(0n);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voterA).castVote(pid, 1);
      await governor.connect(voterB).castVote(pid, 1);
      await mine(VOTING_PERIOD + 1);

      await governor.queue(p.targets, p.values, p.calldatas, p.descriptionHash);
      expect(await governor.proposalEta(pid)).to.be.greaterThan(0n);
    });
  });

  describe("castVote variants", function () {
    it("castVoteWithReasonAndParams works", async function () {
      const { governor, treasury, usdc, proposer, voterA, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        100n,
        "p-reasonparams",
      );
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      await mine(VOTING_DELAY + 1);
      await expect(governor.connect(voterA).castVoteWithReasonAndParams(pid, 1, "reason", "0x"))
        .to.emit(governor, "VoteCast")
        .withArgs(voterA.address, pid, 1, GOV_VOTER_A, "reason");
    });
  });

  describe("supportsInterface", function () {
    it("reports IERC165 and IGovernor correctly", async function () {
      const { governor } = await loadFixture(deployFixture);
      expect(await governor.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC165
      expect(await governor.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("state transitions - defeated by lack of quorum", function () {
    it("returns Defeated when no voter reaches quorum", async function () {
      const { governor, treasury, usdc, proposer, spammer, recipient } =
        await loadFixture(deployFixture);
      const p = await buildTransferProposal(
        await treasury.getAddress(),
        await usdc.getAddress(),
        recipient.address,
        1n,
        "p-no-quorum",
      );
      // Proposer tem 20k, bem abaixo de 4% de ~31M = ~1.24M. Voto dele sozinho nao bate quorum.
      await governor.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      const pid = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      await mine(VOTING_DELAY + 1);
      await governor.connect(proposer).castVote(pid, 1);
      // spammer nao chega a 4% sozinho.
      await governor.connect(spammer).castVote(pid, 1);
      await mine(VOTING_PERIOD + 1);
      expect(await governor.state(pid)).to.equal(3n); // Defeated
    });
  });

  describe("relay guard", function () {
    it("relay reverts for non-governance caller", async function () {
      const { governor, voterA } = await loadFixture(deployFixture);
      await expect(
        governor.connect(voterA).relay(voterA.address, 0, "0x"),
      ).to.be.revertedWithCustomError(governor, "GovernorOnlyExecutor");
    });

    it("rejects plain ETH transfers (GovernorDisabledDeposit)", async function () {
      const { governor, voterA } = await loadFixture(deployFixture);
      await expect(
        voterA.sendTransaction({ to: await governor.getAddress(), value: 1n }),
      ).to.be.revertedWithCustomError(governor, "GovernorDisabledDeposit");
    });
  });
});
