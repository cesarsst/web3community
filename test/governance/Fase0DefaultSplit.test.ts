import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  mine,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import CommunityDAOModule from "../../ignition/modules/Dao";

/**
 * Fase0DefaultSplit — proposta DAO da Fase 0 do pivot CLP.
 *
 * Cobre o ciclo completo da proposta que executa
 *   FeeRouter.setDefaultSplit({burnBps: 7000, treasuryBps: 2000, rebateBps: 1000})
 * via Governor + Timelock, com:
 *   - happy path (propose -> vote -> queue -> execute -> verifica state)
 *   - sobrescrita do split antigo (95/0/5 -> 70/20/10)
 *   - caminho triste: proposer sem voting power suficiente -> revert.
 *
 * Espelha os mesmos bytes de calldata usados em
 * `scripts/governance/propose-fase0-default-split.ts` para que qualquer
 * divergencia entre o teste e o script real seja detectada aqui.
 */
describe("Governance: Fase 0 — setDefaultSplit(7000, 2000, 1000)", function () {
  this.timeout(120_000);

  // Parametros DEV (devem espelhar `ignition/parameters/dev.json`).
  const DEV_TIMELOCK_DELAY = 3_600n;
  const DEV_VOTING_PERIOD = 50n;
  const VOTER_POWER = 50_000_000n * 10n ** 18n; // 50% do cap, garante quorum 4%
  const PROPOSER_POWER = 20_000n * 10n ** 18n; // > threshold (10k)

  // Constantes da proposta — devem ser IDENTICAS ao script de produc-script.
  const NEW_SPLIT = { burnBps: 7000, treasuryBps: 2000, rebateBps: 1000 } as const;
  const DESCRIPTION = [
    "# Fase 0 do pivot CLP — atualizar split default do FeeRouter para 70/20/10",
    "",
    "Acao unica:",
    "  FeeRouter.setDefaultSplit({burnBps: 7000, treasuryBps: 2000, rebateBps: 1000})",
    "",
    "Motivacao economica (resolve C4 do parecer original):",
    "- 70% burn: mantem deflacao do CREDIT e o vinculo I2 (burn-no-consumo).",
    "- 20% treasury: cria receita recorrente da DAO; destrava o flywheel da Fase 1",
    "  (Treasury passa a acumular CREDIT proporcional ao uso real).",
    "- 10% rebate: dobra o revenue share dos apps listados, alinhado a estrategia",
    "  de incentivar listagens uteis na Fase 1.",
    "",
    "Pareceres de referencia:",
    "- audit/economist/2026-04-24-clp-pivot.md (Fase 0 hard gate, bullet 5 alt. B)",
    "- audit/economist/2026-04-24-credit-peg.md (modelo FFP — Floating com Floor",
    "  Price defendido; receita do treasury alimenta o buyback-and-burn defensivo)",
    "",
    "Invariantes:",
    "- I2 mantida: burnBps = 7000 > 0.",
    "- I4 exercitada: a propria proposta passa pelo Timelock (GOVERNANCE_ROLE).",
    "- Overrides por projeto (setProjectSplit) nao sao afetados.",
  ].join("\n");

  async function deployFixture() {
    const deployed = await hre.ignition.deploy(CommunityDAOModule);

    const [deployer, voter, proposer, lowPowerProposer] = await ethers.getSigners();
    void deployer;

    const [gov, timelock, feeRouter, governor] = await Promise.all([
      ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress()),
      ethers.getContractAt("CommunityTimelock", await deployed.timelock.getAddress()),
      ethers.getContractAt("FeeRouter", await deployed.feeRouter.getAddress()),
      ethers.getContractAt("CommunityGovernor", await deployed.governor.getAddress()),
    ]);

    // Bootstrap one-shot: Timelock aceita ownership do GOV e minta voting power.
    // Em prod isso seria a primeira proposta (testada em outro arquivo);
    // aqui isolamos para focar em Fase 0.
    const tlAddr = await timelock.getAddress();
    await impersonateAccount(tlAddr);
    const tlSigner = await ethers.getSigner(tlAddr);
    await setBalance(tlSigner.address, ethers.parseEther("100"));
    await gov.connect(tlSigner).acceptOwnership();

    await gov.connect(tlSigner).mint(voter.address, VOTER_POWER, "fase0:voter");
    await gov.connect(tlSigner).mint(proposer.address, PROPOSER_POWER, "fase0:proposer");
    // lowPowerProposer fica DELIBERADAMENTE sem GOV — testa o caminho triste.

    await gov.connect(voter).delegate(voter.address);
    await gov.connect(proposer).delegate(proposer.address);
    await mine(1);

    return { gov, timelock, feeRouter, governor, voter, proposer, lowPowerProposer, tlSigner };
  }

  /**
   * Helper: monta os 4 argumentos canonicos da proposta. Calldata gerado
   * com a MESMA encodeFunctionData usada pelo script — qualquer mismatch
   * de tipo de campo (uint16 vs uint256) explode aqui.
   */
  function buildProposalArgs(
    feeRouterAddr: string,
    feeRouter: { interface: { encodeFunctionData(name: string, args: unknown[]): string } },
  ) {
    const calldata = feeRouter.interface.encodeFunctionData("setDefaultSplit", [
      {
        burnBps: NEW_SPLIT.burnBps,
        treasuryBps: NEW_SPLIT.treasuryBps,
        rebateBps: NEW_SPLIT.rebateBps,
      },
    ]);
    return {
      targets: [feeRouterAddr],
      values: [0n],
      calldatas: [calldata],
      descriptionHash: ethers.id(DESCRIPTION),
    };
  }

  it("happy path: propose -> vote -> queue -> execute aplica split 70/20/10", async () => {
    const { feeRouter, governor, voter, proposer } = await loadFixture(deployFixture);

    const feeRouterAddr = await feeRouter.getAddress();
    const { targets, values, calldatas, descriptionHash } = buildProposalArgs(
      feeRouterAddr,
      feeRouter,
    );

    // Pre-condicao: split atual e o seed 95/0/5 (ignition default).
    const initialSplit = await feeRouter.defaultSplit();
    expect(initialSplit.burnBps).to.equal(9500);
    expect(initialSplit.treasuryBps).to.equal(0);
    expect(initialSplit.rebateBps).to.equal(500);

    // Propose.
    const proposeTx = await governor
      .connect(proposer)
      .propose(targets, values, calldatas, DESCRIPTION);
    const proposeReceipt = await proposeTx.wait();

    type ProposalCreatedLog = { fragment?: { name: string }; args?: { proposalId: bigint } };
    const proposalId = (proposeReceipt!.logs as unknown as ProposalCreatedLog[])
      .filter((l) => l.fragment?.name === "ProposalCreated")
      .map((l) => l.args!.proposalId)[0];

    // Sanity: hashProposal off-chain bate com o evento.
    const computedId: bigint = await governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash,
    );
    expect(computedId).to.equal(proposalId);

    // votingDelay = 1 -> mine 2 para entrar em Active.
    await mine(2);
    expect(await governor.state(proposalId)).to.equal(1); // Active

    // Voto FOR.
    await governor.connect(voter).castVote(proposalId, 1);

    // Avanca o periodo de votacao.
    await mine(Number(DEV_VOTING_PERIOD));
    expect(await governor.state(proposalId)).to.equal(4); // Succeeded

    // Queue.
    await governor.connect(voter).queue(targets, values, calldatas, descriptionHash);
    expect(await governor.state(proposalId)).to.equal(5); // Queued

    // Avanca o delay do Timelock.
    await time.increase(Number(DEV_TIMELOCK_DELAY) + 1);

    // Execute — captura evento DefaultSplitUpdated.
    await expect(governor.connect(voter).execute(targets, values, calldatas, descriptionHash))
      .to.emit(feeRouter, "DefaultSplitUpdated")
      .withArgs(
        // oldSplit (tuple): 9500/0/500
        [9500, 0, 500],
        // newSplit: 7000/2000/1000
        [NEW_SPLIT.burnBps, NEW_SPLIT.treasuryBps, NEW_SPLIT.rebateBps],
      );

    expect(await governor.state(proposalId)).to.equal(7); // Executed

    // Pos-condicao: split novo persistido.
    const finalSplit = await feeRouter.defaultSplit();
    expect(finalSplit.burnBps).to.equal(NEW_SPLIT.burnBps);
    expect(finalSplit.treasuryBps).to.equal(NEW_SPLIT.treasuryBps);
    expect(finalSplit.rebateBps).to.equal(NEW_SPLIT.rebateBps);

    // Soma da invariante (10_000) — defesa contra mudanca futura nas constantes.
    expect(
      Number(finalSplit.burnBps) + Number(finalSplit.treasuryBps) + Number(finalSplit.rebateBps),
    ).to.equal(10_000);
  });

  it("split antigo e completamente sobrescrito (nao acumula com 95/0/5)", async () => {
    const { feeRouter, governor, voter, proposer } = await loadFixture(deployFixture);

    const feeRouterAddr = await feeRouter.getAddress();
    const { targets, values, calldatas, descriptionHash } = buildProposalArgs(
      feeRouterAddr,
      feeRouter,
    );

    await governor.connect(proposer).propose(targets, values, calldatas, DESCRIPTION);
    await mine(2);
    const computedId: bigint = await governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash,
    );
    await governor.connect(voter).castVote(computedId, 1);
    await mine(Number(DEV_VOTING_PERIOD));
    await governor.connect(voter).queue(targets, values, calldatas, descriptionHash);
    await time.increase(Number(DEV_TIMELOCK_DELAY) + 1);
    await governor.connect(voter).execute(targets, values, calldatas, descriptionHash);

    // O split deve ser EXATAMENTE 70/20/10 — nem 9500/2000/1500 (mistura),
    // nem 7000/0/3000 (preservou rebate). Isso valida que setDefaultSplit
    // sobrescreve o struct todo, nao mescla campos.
    const split = await feeRouter.defaultSplit();
    expect(split.burnBps).to.equal(7000);
    expect(split.treasuryBps).to.equal(2000);
    expect(split.rebateBps).to.equal(1000);
  });

  it("caminho triste: proposer sem voting power suficiente -> revert GovernorInsufficientProposerVotes", async () => {
    const { feeRouter, governor, lowPowerProposer } = await loadFixture(deployFixture);

    const feeRouterAddr = await feeRouter.getAddress();
    const { targets, values, calldatas } = buildProposalArgs(feeRouterAddr, feeRouter);

    // lowPowerProposer tem 0 GOV — abaixo do threshold de 10_000e18.
    // OZ Governor 5.0.x reverte com `GovernorInsufficientProposerVotes(proposer, votes, threshold)`.
    await expect(
      governor.connect(lowPowerProposer).propose(targets, values, calldatas, DESCRIPTION),
    ).to.be.revertedWithCustomError(governor, "GovernorInsufficientProposerVotes");
  });
});
