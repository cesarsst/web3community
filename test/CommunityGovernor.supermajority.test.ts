import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * CommunityGovernor — proposal types (supermajority para gestao de roles).
 *
 * Cobre a regra on-chain "propostas de gestao de roles no Treasury/Timelock exigem
 * supermaioria 75%" (antes apenas norma cultural, docs/governance/
 * fase1-2-pol.md §5):
 *  - Regressao: proposta normal (target != treasury) passa com maioria
 *    simples mesmo com < 75% For.
 *  - gestao de roles: 74% For / 26% Against -> Defeated; 76% For / 24% Against ->
 *    Succeeded (threshold inclusivo em 75% dos votos decisivos For/Against).
 *  - Fronteira EXATA: 75/25 -> Succeeded (>= inclusivo); 1 wei abaixo de
 *    75% -> Defeated; supermaioria na razao mas abaixo do quorum ->
 *    Defeated; quorum atingido apenas com Abstain -> Defeated (guard
 *    `forVotes > 0`).
 *  - Anti-bypass de roles: grantRole/revokeRole/renounceRole com target no
 *    Treasury OU no Timelock sao classificadas Supermajority — fecha o
 *    vetor "proposta de maioria simples concede GOVERNANCE_ROLE do
 *    Treasury a um EOA que move o cofre direto". Fixture espelha a
 *    producao (Dao.ts fase C.2/D): Timelock detem DEFAULT_ADMIN_ROLE +
 *    GOVERNANCE_ROLE do Treasury, deployer renuncia.
 *  - Batch misto (gestao de roles + outra call) contamina a proposta inteira ->
 *    exige 75%.
 *  - Proposta para o treasury com OUTRO selector (transfer) -> maioria
 *    simples; grantRole em contrato TERCEIRO -> maioria simples.
 *  - Evento {ProposalTypeSet} emitido em todo propose (Standard e
 *    Supermajority) e getter {proposalRequiresSupermajority}.
 *
 * Estrategia de pesos: mints calibrados para que a MESMA razao 74/26 passe
 * na regra Standard (74 > 26) e falhe na Supermajority (74 < 3*26 = 78),
 * evidenciando que o tipo — e nao o placar — muda o resultado.
 */
describe("CommunityGovernor — supermajority proposal types", function () {
  // Parametros de dev/teste (mesmos do suite principal)
  const VOTING_DELAY = 1; // 1 block
  const VOTING_PERIOD = 50; // 50 blocks
  const PROPOSAL_THRESHOLD = 10_000n * 10n ** 18n;
  const QUORUM_NUMERATOR = 4n; // 4%
  const TIMELOCK_DELAY = 3600n; // 1h

  // Distribuicao de GOV — pares (74k, 26k), (76k, 24k) e (75k, 25k) para as
  // razoes 74%/26%, 76%/24% e a fronteira exata 75%/25%; voterEps tem
  // 75k - 1 wei (1 wei abaixo da fronteira contra 25k Against) e voterTiny
  // 1k (supermaioria na razao mas abaixo do quorum). Total ~= 396k; quorum
  // (4%) ~= 15.84k, coberto com folga nos cenarios de 100k votos e NAO
  // coberto pelo voterTiny (por design).
  const GOV_74 = 74_000n * 10n ** 18n;
  const GOV_26 = 26_000n * 10n ** 18n;
  const GOV_76 = 76_000n * 10n ** 18n;
  const GOV_24 = 24_000n * 10n ** 18n;
  const GOV_75 = 75_000n * 10n ** 18n;
  const GOV_25 = 25_000n * 10n ** 18n;
  const GOV_EPS = 75_000n * 10n ** 18n - 1n; // 1 wei abaixo de 3 * GOV_25
  const GOV_TINY = 1_000n * 10n ** 18n; // < quorum de ~15.84k
  const GOV_PROPOSER = 20_000n * 10n ** 18n; // acima do threshold

  // Estados do OZ Governor
  const STATE_DEFEATED = 3n;
  const STATE_SUCCEEDED = 4n;

  // ProposalType do CommunityGovernor
  const TYPE_STANDARD = 0n;
  const TYPE_SUPERMAJORITY = 1n;

  async function deployFixture() {
    const [
      admin,
      voter74,
      voter26,
      voter76,
      voter24,
      proposer,
      recipient,
      voter75,
      voter25,
      voterEps,
      voterTiny,
      attacker,
    ] = await ethers.getSigners();

    // 1. GovernanceToken (admin = deployer)
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const gov = await GovernanceToken.deploy("Web3Community Governance", "GOV", admin.address);
    await gov.waitForDeployment();

    // 2. CommunityTimelock (admin = deployer, proposers=[], executors=[0x0])
    const Timelock = await ethers.getContractFactory("CommunityTimelock");
    const timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [ethers.ZeroAddress], admin.address);
    await timelock.waitForDeployment();

    // 3. Treasury — deployado ANTES do Governor (o construtor do Governor
    //    recebe o endereco do Treasury para o scan de gestao de roles).
    //    placeholder = GOV; USDC = zero (FFP fora de escopo aqui).
    //    Wiring de roles ESPELHA a producao (Dao.ts fase C.2 + fase D): o
    //    Timelock recebe GOVERNANCE_ROLE E DEFAULT_ADMIN_ROLE, o deployer
    //    renuncia ambas — e exatamente o DEFAULT_ADMIN_ROLE no Timelock que
    //    habilita o vetor `grantRole` via proposta, coberto nos testes de
    //    anti-bypass abaixo.
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(admin.address);
    await treasury.waitForDeployment();
    const TREASURY_GOV_ROLE = await treasury.GOVERNANCE_ROLE();
    const TREASURY_ADMIN_ROLE = await treasury.DEFAULT_ADMIN_ROLE();
    await treasury.connect(admin).grantRole(TREASURY_GOV_ROLE, await timelock.getAddress());
    await treasury.connect(admin).grantRole(TREASURY_ADMIN_ROLE, await timelock.getAddress());
    await treasury.connect(admin).renounceRole(TREASURY_GOV_ROLE, admin.address);
    await treasury.connect(admin).renounceRole(TREASURY_ADMIN_ROLE, admin.address);

    // 4. CommunityGovernor com o Treasury imutavel.
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

    // 5. Wiring do Timelock (exercido nos testes de anti-bypass que fazem
    //    queue + execute; executors = [address(0)] permite execute por
    //    qualquer conta, fiel ao stack real).
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    await timelock.connect(admin).grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.connect(admin).grantRole(CANCELLER_ROLE, await governor.getAddress());

    // 6. Mint GOV e self-delegate (ERC20Votes exige delegate para ativar
    //    voting power).
    await gov.connect(admin).mint(voter74.address, GOV_74, "test:74");
    await gov.connect(admin).mint(voter26.address, GOV_26, "test:26");
    await gov.connect(admin).mint(voter76.address, GOV_76, "test:76");
    await gov.connect(admin).mint(voter24.address, GOV_24, "test:24");
    await gov.connect(admin).mint(voter75.address, GOV_75, "test:75");
    await gov.connect(admin).mint(voter25.address, GOV_25, "test:25");
    await gov.connect(admin).mint(voterEps.address, GOV_EPS, "test:eps");
    await gov.connect(admin).mint(voterTiny.address, GOV_TINY, "test:tiny");
    await gov.connect(admin).mint(proposer.address, GOV_PROPOSER, "test:proposer");
    await gov.connect(voter74).delegate(voter74.address);
    await gov.connect(voter26).delegate(voter26.address);
    await gov.connect(voter76).delegate(voter76.address);
    await gov.connect(voter24).delegate(voter24.address);
    await gov.connect(voter75).delegate(voter75.address);
    await gov.connect(voter25).delegate(voter25.address);
    await gov.connect(voterEps).delegate(voterEps.address);
    await gov.connect(voterTiny).delegate(voterTiny.address);
    await gov.connect(proposer).delegate(proposer.address);

    // 7. Mock USDC apenas para montar calldata de Treasury.transfer (as
    //    propostas nunca sao executadas nestes testes).
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20Mock.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // 8. Mine 1 block para o snapshot enxergar os delegates.
    await mine(1);

    return {
      gov,
      timelock,
      governor,
      treasury,
      usdc,
      admin,
      voter74,
      voter26,
      voter76,
      voter24,
      voter75,
      voter25,
      voterEps,
      voterTiny,
      attacker,
      proposer,
      recipient,
      TREASURY_GOV_ROLE,
      TREASURY_ADMIN_ROLE,
      PROPOSER_ROLE,
    };
  }

  /** Calldata de gestao de roles no Treasury (grantRole) — selector escaneado
   *  pelo Governor, dispara o gate de supermaioria. Nunca executada; so o
   *  selector + target importam para o scan de {propose}. */
  function roleGrantCalldata(treasury: { interface: any }): string {
    const role = ethers.id("GOVERNANCE_ROLE");
    return treasury.interface.encodeFunctionData("grantRole", [role, ethers.ZeroAddress]);
  }

  /** Calldata de Treasury.transfer (outro selector, mesmo target). */
  function transferCalldata(treasury: { interface: any }, token: string, to: string): string {
    return treasury.interface.encodeFunctionData("transfer", [token, to, 100n]);
  }

  /** Propoe e retorna o proposalId (hashProposal e puro — id deterministico). */
  async function propose(
    governor: any,
    proposer: any,
    targets: string[],
    calldatas: string[],
    desc: string,
  ): Promise<bigint> {
    const values = targets.map(() => 0n);
    await governor.connect(proposer).propose(targets, values, calldatas, desc);
    return governor.hashProposal(targets, values, calldatas, ethers.id(desc));
  }

  describe("regressao: proposta Standard mantem maioria simples", function () {
    it("proposta normal (target != treasury) com 74% For / 26% Against -> Succeeded", async function () {
      const { governor, proposer, voter74, voter26 } = await loadFixture(deployFixture);

      // Target = o proprio governor (setVotingDelay) — nao ha treasury no batch.
      const calldata = governor.interface.encodeFunctionData("setVotingDelay", [2]);
      const pid = await propose(
        governor,
        proposer,
        [await governor.getAddress()],
        [calldata],
        "standard: bump voting delay",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(false);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter74).castVote(pid, 1); // 74k For
      await governor.connect(voter26).castVote(pid, 0); // 26k Against
      await mine(VOTING_PERIOD + 1);

      // 74% < 75%, mas Standard exige apenas For > Against.
      expect(await governor.state(pid)).to.equal(STATE_SUCCEEDED);
    });
  });

  describe("gestao de roles no Treasury exige supermaioria 75%", function () {
    it("74% For / 26% Against -> Defeated (abaixo do threshold de 75%)", async function () {
      const { governor, treasury, proposer, voter74, voter26 } = await loadFixture(deployFixture);

      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [roleGrantCalldata(treasury)],
        "supermajority: remove POL (74/26)",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter74).castVote(pid, 1); // 74k For
      await governor.connect(voter26).castVote(pid, 0); // 26k Against
      await mine(VOTING_PERIOD + 1);

      // forVotes (74k) < 3 * againstVotes (78k) -> Defeated, apesar de
      // For > Against (que bastaria numa Standard — ver teste de regressao).
      expect(await governor.state(pid)).to.equal(STATE_DEFEATED);
    });

    it("76% For / 24% Against -> Succeeded (acima do threshold de 75%)", async function () {
      const { governor, treasury, proposer, voter76, voter24 } = await loadFixture(deployFixture);

      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [roleGrantCalldata(treasury)],
        "supermajority: remove POL (76/24)",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter76).castVote(pid, 1); // 76k For
      await governor.connect(voter24).castVote(pid, 0); // 24k Against
      await mine(VOTING_PERIOD + 1);

      // forVotes (76k) >= 3 * againstVotes (72k) -> Succeeded.
      expect(await governor.state(pid)).to.equal(STATE_SUCCEEDED);
    });
  });

  describe("fronteira exata de 75%", function () {
    it("75% For / 25% Against EXATOS -> Succeeded (threshold >= inclusivo)", async function () {
      const { governor, treasury, proposer, voter75, voter25 } = await loadFixture(deployFixture);

      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [roleGrantCalldata(treasury)],
        "supermajority: remove POL (75/25 exato)",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter75).castVote(pid, 1); // 75k For
      await governor.connect(voter25).castVote(pid, 0); // 25k Against
      await mine(VOTING_PERIOD + 1);

      // forVotes (75k) == 3 * againstVotes (75k): a igualdade decide — se o
      // `>=` do contrato virar `>` num refactor, este teste quebra.
      expect(await governor.state(pid)).to.equal(STATE_SUCCEEDED);
    });

    it("1 wei abaixo da fronteira (75k - 1 wei For / 25k Against) -> Defeated", async function () {
      const { governor, treasury, proposer, voterEps, voter25 } = await loadFixture(deployFixture);

      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [roleGrantCalldata(treasury)],
        "supermajority: remove POL (75k - 1 wei)",
      );

      await mine(VOTING_DELAY + 1);
      await governor.connect(voterEps).castVote(pid, 1); // 75k - 1 wei For
      await governor.connect(voter25).castVote(pid, 0); // 25k Against
      await mine(VOTING_PERIOD + 1);

      // forVotes (75k - 1) < 3 * againstVotes (75k) -> Defeated: o lado
      // estrito da fronteira.
      expect(await governor.state(pid)).to.equal(STATE_DEFEATED);
    });

    it("supermaioria na razao For/Against mas ABAIXO do quorum -> Defeated", async function () {
      const { governor, treasury, proposer, voterTiny } = await loadFixture(deployFixture);

      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [roleGrantCalldata(treasury)],
        "supermajority: remove POL (razao ok, quorum nao)",
      );

      await mine(VOTING_DELAY + 1);
      await governor.connect(voterTiny).castVote(pid, 1); // 1k For, 0 Against
      await mine(VOTING_PERIOD + 1);

      // A razao passa (1k >= 3 * 0 e For > 0), mas 1k < quorum (~15.84k):
      // o quorum e checado separadamente e tambem derruba a proposta.
      const snapshot = await governor.proposalSnapshot(pid);
      expect(await governor.quorum(snapshot)).to.be.gt(GOV_TINY);
      expect(await governor.state(pid)).to.equal(STATE_DEFEATED);
    });

    it("quorum atingido APENAS com Abstain (0 For / 0 Against) -> Defeated (guard forVotes > 0)", async function () {
      const { governor, treasury, proposer, voter74 } = await loadFixture(deployFixture);

      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [roleGrantCalldata(treasury)],
        "supermajority: remove POL (so Abstain)",
      );

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter74).castVote(pid, 2); // 74k Abstain
      await mine(VOTING_PERIOD + 1);

      // Quorum atingido (Abstain conta para quorum no CountingSimple), mas
      // sem o guard `forVotes > 0` a razao degeneraria em `0 >= 3 * 0` e a
      // supermaioria ficaria MAIS fraca que a maioria simples.
      const [againstVotes, forVotes, abstainVotes] = await governor.proposalVotes(pid);
      expect(forVotes).to.equal(0n);
      expect(againstVotes).to.equal(0n);
      expect(abstainVotes).to.equal(GOV_74);
      const snapshot = await governor.proposalSnapshot(pid);
      expect(abstainVotes).to.be.gte(await governor.quorum(snapshot));
      expect(await governor.state(pid)).to.equal(STATE_DEFEATED);
    });
  });

  describe("anti-bypass: gestao de roles do Treasury/Timelock exige supermaioria", function () {
    it("grantRole(GOVERNANCE_ROLE, attacker) no Treasury e Supermajority; 74/26 -> Defeated e role NAO concedida", async function () {
      const { governor, treasury, proposer, voter74, voter26, attacker, TREASURY_GOV_ROLE } =
        await loadFixture(deployFixture);

      // O vetor barato do finding: proposta "Standard" que re-autoriza um
      // EOA a mover o cofre direto. Com o scan de roles, ela e marcada
      // Supermajority e 74% For nao basta.
      const calldata = treasury.interface.encodeFunctionData("grantRole", [
        TREASURY_GOV_ROLE,
        attacker.address,
      ]);
      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [calldata],
        "bypass attempt: grant GOVERNANCE_ROLE to attacker",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter74).castVote(pid, 1);
      await governor.connect(voter26).castVote(pid, 0);
      await mine(VOTING_PERIOD + 1);

      expect(await governor.state(pid)).to.equal(STATE_DEFEATED);
      expect(await treasury.hasRole(TREASURY_GOV_ROLE, attacker.address)).to.equal(false);
      // Sem a role, o attacker segue barrado no AccessControl do Treasury
      // (transfer e onlyRole(GOVERNANCE_ROLE)).
      await expect(
        treasury.connect(attacker).transfer(ethers.ZeroAddress, attacker.address, 1n),
      ).to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount");
    });

    it("mesma proposta com 76/24 passa, executa via Timelock e concede a role (caminho legitimo)", async function () {
      const {
        governor,
        treasury,
        timelock,
        proposer,
        voter76,
        voter24,
        attacker,
        TREASURY_GOV_ROLE,
      } = await loadFixture(deployFixture);

      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [
        treasury.interface.encodeFunctionData("grantRole", [TREASURY_GOV_ROLE, attacker.address]),
      ];
      const desc = "supermajority grant: GOVERNANCE_ROLE to new operator";
      await governor.connect(proposer).propose(targets, values, calldatas, desc);
      const pid = await governor.hashProposal(targets, values, calldatas, ethers.id(desc));

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter76).castVote(pid, 1);
      await governor.connect(voter24).castVote(pid, 0);
      await mine(VOTING_PERIOD + 1);
      expect(await governor.state(pid)).to.equal(STATE_SUCCEEDED);

      // Exercita o wiring real: o Timelock (DEFAULT_ADMIN_ROLE do Treasury)
      // executa o grant — unico caminho legitimo, agora gated a 75%.
      await governor.connect(proposer).queue(targets, values, calldatas, ethers.id(desc));
      await time.increase(Number(TIMELOCK_DELAY) + 1);
      await governor.connect(proposer).execute(targets, values, calldatas, ethers.id(desc));

      expect(await treasury.hasRole(TREASURY_GOV_ROLE, attacker.address)).to.equal(true);
      expect(await timelock.getAddress()).to.not.equal(attacker.address); // sanity
    });

    it("revokeRole no Treasury tambem e Supermajority", async function () {
      const { governor, treasury, timelock, proposer, TREASURY_GOV_ROLE } =
        await loadFixture(deployFixture);
      const calldata = treasury.interface.encodeFunctionData("revokeRole", [
        TREASURY_GOV_ROLE,
        await timelock.getAddress(),
      ]);
      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [calldata],
        "role mgmt: revoke GOVERNANCE_ROLE",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);
    });

    it("renounceRole no Treasury tambem e Supermajority", async function () {
      const { governor, treasury, timelock, proposer, TREASURY_ADMIN_ROLE } =
        await loadFixture(deployFixture);
      const calldata = treasury.interface.encodeFunctionData("renounceRole", [
        TREASURY_ADMIN_ROLE,
        await timelock.getAddress(),
      ]);
      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [calldata],
        "role mgmt: renounce DEFAULT_ADMIN_ROLE",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);
    });

    it("grantRole(PROPOSER_ROLE, attacker) no TIMELOCK e Supermajority (bypass via schedule direto)", async function () {
      const { governor, timelock, proposer, attacker, PROPOSER_ROLE } =
        await loadFixture(deployFixture);
      // Conceder PROPOSER_ROLE do Timelock permitiria agendar acoes do cofre fora
      // do Governor (o Timelock e quem detem GOVERNANCE_ROLE do Treasury).
      const calldata = timelock.interface.encodeFunctionData("grantRole", [
        PROPOSER_ROLE,
        attacker.address,
      ]);
      const pid = await propose(
        governor,
        proposer,
        [await timelock.getAddress()],
        [calldata],
        "bypass attempt: grant PROPOSER_ROLE on timelock",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);
    });

    it("grantRole em contrato TERCEIRO permanece Standard (scan e target-scoped)", async function () {
      const { governor, gov, admin, proposer, attacker } = await loadFixture(deployFixture);
      // Outro Treasury qualquer, NAO wired ao Governor.
      const Treasury = await ethers.getContractFactory("Treasury");
      const otherTreasury = await Treasury.deploy(admin.address);
      await otherTreasury.waitForDeployment();

      const calldata = otherTreasury.interface.encodeFunctionData("grantRole", [
        await otherTreasury.GOVERNANCE_ROLE(),
        attacker.address,
      ]);
      const pid = await propose(
        governor,
        proposer,
        [await otherTreasury.getAddress()],
        [calldata],
        "role mgmt on unrelated contract",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(false);
    });
  });

  describe("batch misto (gestao de roles + outra call) contamina a proposta inteira", function () {
    it("74% For / 26% Against -> Defeated mesmo com gestao de roles fora da primeira posicao", async function () {
      const { governor, treasury, usdc, proposer, voter74, voter26, recipient } =
        await loadFixture(deployFixture);

      const treasuryAddr = await treasury.getAddress();
      // grantRole na SEGUNDA posicao — o scan cobre o batch inteiro.
      const pid = await propose(
        governor,
        proposer,
        [treasuryAddr, treasuryAddr],
        [
          transferCalldata(treasury, await usdc.getAddress(), recipient.address),
          roleGrantCalldata(treasury),
        ],
        "mixed batch: transfer + remove POL (74/26)",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter74).castVote(pid, 1);
      await governor.connect(voter26).castVote(pid, 0);
      await mine(VOTING_PERIOD + 1);

      expect(await governor.state(pid)).to.equal(STATE_DEFEATED);
    });

    it("mesmo batch misto com 76% For / 24% Against -> Succeeded", async function () {
      const { governor, treasury, usdc, proposer, voter76, voter24, recipient } =
        await loadFixture(deployFixture);

      const treasuryAddr = await treasury.getAddress();
      const pid = await propose(
        governor,
        proposer,
        [treasuryAddr, treasuryAddr],
        [
          transferCalldata(treasury, await usdc.getAddress(), recipient.address),
          roleGrantCalldata(treasury),
        ],
        "mixed batch: transfer + remove POL (76/24)",
      );
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(true);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter76).castVote(pid, 1);
      await governor.connect(voter24).castVote(pid, 0);
      await mine(VOTING_PERIOD + 1);

      expect(await governor.state(pid)).to.equal(STATE_SUCCEEDED);
    });
  });

  describe("treasury com outro selector permanece Standard", function () {
    it("Treasury.transfer com 74% For / 26% Against -> Succeeded (maioria simples)", async function () {
      const { governor, treasury, usdc, proposer, voter74, voter26, recipient } =
        await loadFixture(deployFixture);

      const pid = await propose(
        governor,
        proposer,
        [await treasury.getAddress()],
        [transferCalldata(treasury, await usdc.getAddress(), recipient.address)],
        "standard: treasury transfer (74/26)",
      );
      // Mesmo target == treasury, o selector nao e gestao de roles -> Standard.
      expect(await governor.proposalRequiresSupermajority(pid)).to.equal(false);

      await mine(VOTING_DELAY + 1);
      await governor.connect(voter74).castVote(pid, 1);
      await governor.connect(voter26).castVote(pid, 0);
      await mine(VOTING_PERIOD + 1);

      expect(await governor.state(pid)).to.equal(STATE_SUCCEEDED);
    });
  });

  describe("evento ProposalTypeSet", function () {
    it("emite Supermajority (1) para proposta de gestao de roles", async function () {
      const { governor, treasury, proposer } = await loadFixture(deployFixture);

      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [roleGrantCalldata(treasury)];
      const desc = "event: remove POL";
      const pid = await governor.hashProposal(targets, values, calldatas, ethers.id(desc));

      await expect(governor.connect(proposer).propose(targets, values, calldatas, desc))
        .to.emit(governor, "ProposalTypeSet")
        .withArgs(pid, TYPE_SUPERMAJORITY);
    });

    it("emite Standard (0) para proposta sem gestao de roles", async function () {
      const { governor, treasury, usdc, proposer, recipient } = await loadFixture(deployFixture);

      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [transferCalldata(treasury, await usdc.getAddress(), recipient.address)];
      const desc = "event: treasury transfer";
      const pid = await governor.hashProposal(targets, values, calldatas, ethers.id(desc));

      await expect(governor.connect(proposer).propose(targets, values, calldatas, desc))
        .to.emit(governor, "ProposalTypeSet")
        .withArgs(pid, TYPE_STANDARD);
    });
  });

  describe("wiring do selector e do treasury", function () {
    it("selectors de gestao de roles batem com as assinaturas do IAccessControl", async function () {
      const { governor } = await loadFixture(deployFixture);
      expect(await governor.GRANT_ROLE_SELECTOR()).to.equal(
        ethers.id("grantRole(bytes32,address)").slice(0, 10), // 0x2f2ff15d
      );
      expect(await governor.REVOKE_ROLE_SELECTOR()).to.equal(
        ethers.id("revokeRole(bytes32,address)").slice(0, 10), // 0xd547741f
      );
      expect(await governor.RENOUNCE_ROLE_SELECTOR()).to.equal(
        ethers.id("renounceRole(bytes32,address)").slice(0, 10), // 0x36568abe
      );
    });

    it("TREASURY exposto e imutavel aponta para o Treasury do deploy", async function () {
      const { governor, treasury } = await loadFixture(deployFixture);
      expect(await governor.TREASURY()).to.equal(await treasury.getAddress());
    });
  });
});
