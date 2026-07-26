import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { ethers } from "ethers";

/**
 * CommunityDAOModule — Modulo Ignition unico que deploya e wira a DAO
 * Web3Community no modelo vigente (remodel 2026-07-08: payment rail +
 * funding por rev-share).
 *
 * Cobertura padrao: 10 contratos core — GovernanceToken (GOV), CreditToken
 * (CREDIT), CommunityTimelock, ProjectRegistry, Treasury, Staking,
 * CreditPSM, ProjectFunding, FeeRouterV2 e CommunityGovernor. Opcionalmente
 * (flag `DEPLOY_TEAM_VESTING`) tambem o TeamVesting.
 *
 * Decisoes arquiteturais:
 *
 * 1) Single-module com parametros (dev defaults; producao via
 *    `--parameters ignition/parameters/production.json`). Mesma sequencia
 *    de calls nos dois perfis — zero drift dev/prod.
 *
 * 2) SEM genesis de CREDIT. Todo CREDIT em circulacao nasce no {CreditPSM}
 *    contra deposito de USDC 1:1 — lastro integral por construcao. Um
 *    genesis mint sem lastro quebraria o peg no bloco zero.
 *
 * 3) USDC: em producao, `usdcAddress` DEVE apontar pro USDC oficial da rede
 *    (parameters JSON). Em dev/local, a env flag `DEPLOY_USDC_MOCK=true`
 *    deploya um ERC20DecimalsMock(6) e o usa como lastro. Env var (e nao
 *    parametro Ignition) porque parametros so resolvem em deploy-time e nao
 *    permitem branching na definicao do modulo.
 *
 * 4) Ordem de operacoes (CRITICA):
 *    Fase A: deploy de todos os contratos (deployer admin temporario).
 *    Fase B: role grants funcionais — MINTER+BURNER do CREDIT pro PSM,
 *            REVENUE_NOTIFIER do ProjectFunding pro FeeRouterV2,
 *            PROPOSER/CANCELLER do Timelock pro Governor.
 *    Fase C: roles de governanca para o Timelock (GOVERNANCE_ROLE +
 *            DEFAULT_ADMIN_ROLE nos contratos gated + transferOwnership do
 *            GovernanceToken, 2-step — aceite via primeira proposta).
 *    Fase D: deployer renuncia TODAS as roles; Timelock admin POR ULTIMO.
 *
 * 5) IDs unicos por call com prefixos `phaseA_...phaseE_` (Ignition exige).
 *
 * @custom:security-contact security@web3community.example
 */

// Hashes das roles (constants do AccessControl — nao dependem de runtime).
const DEFAULT_ADMIN_ROLE: string = ethers.ZeroHash;
const MINTER_ROLE: string = ethers.id("MINTER_ROLE");
const BURNER_ROLE: string = ethers.id("BURNER_ROLE");
const GOVERNANCE_ROLE: string = ethers.id("GOVERNANCE_ROLE");
const REVENUE_NOTIFIER_ROLE: string = ethers.id("REVENUE_NOTIFIER_ROLE");
const PROPOSER_ROLE: string = ethers.id("PROPOSER_ROLE");
const CANCELLER_ROLE: string = ethers.id("CANCELLER_ROLE");

const CommunityDAOModule = buildModule("CommunityDAOModule", (m) => {
  const deployer = m.getAccount(0);

  // ---------- Parametros (defaults = perfil DEV) ----------

  const govName = m.getParameter<string>("govName", "Web3Community Governance");
  const govSymbol = m.getParameter<string>("govSymbol", "GOV");
  const creditName = m.getParameter<string>("creditName", "Web3Community Credit");
  const creditSymbol = m.getParameter<string>("creditSymbol", "CREDIT");

  // Timelock
  const timelockMinDelay = m.getParameter<bigint>("timelockMinDelay", 3_600n); // dev: 1h | prod: 172_800 (2d)

  // Registry
  const minCollateral = m.getParameter<bigint>("minCollateral", 1_000n * 10n ** 18n); // prod: 10_000e18
  const probationDuration = m.getParameter<bigint>("probationDuration", 86_400n); // dev: 1d | prod: 30d

  // FeeRouterV2 — fee 2,5% (teto duro 5% no contrato) com split 40/40/20.
  const feeBps = m.getParameter<number>("feeBps", 250);
  const feeTreasuryBps = m.getParameter<number>("feeTreasuryBps", 4000);
  const feeBuybackBps = m.getParameter<number>("feeBuybackBps", 4000);
  const feeGrantsBps = m.getParameter<number>("feeGrantsBps", 2000);

  // Governor (parametros em BLOCOS)
  const votingDelay = m.getParameter<bigint>("votingDelay", 1n); // dev: 1 block | prod: 7200
  const votingPeriod = m.getParameter<bigint>("votingPeriod", 50n); // dev: 50 blocks | prod: 50400
  const proposalThreshold = m.getParameter<bigint>("proposalThreshold", 10_000n * 10n ** 18n);
  const quorumNumerator = m.getParameter<bigint>("quorumNumerator", 4n);

  // USDC de lastro do PSM. Producao: USDC oficial da rede via parameters
  // JSON. Dev: `DEPLOY_USDC_MOCK=true` deploya mock e ignora este parametro.
  const usdcAddress = m.getParameter<string>("usdcAddress", ethers.ZeroAddress);
  const deployUsdcMock = (process.env.DEPLOY_USDC_MOCK ?? "").toLowerCase() === "true";

  // TeamVesting opcional (mesmo padrao env-var; parametros de cronograma via JSON).
  const deployTeamVesting = (process.env.DEPLOY_TEAM_VESTING ?? "").toLowerCase() === "true";
  const teamVestingBeneficiary = m.getParameter<string>("teamVestingBeneficiary", ethers.ZeroAddress);
  const teamVestingStart = m.getParameter<bigint>("teamVestingStart", 0n);
  const teamVestingCliff = m.getParameter<bigint>("teamVestingCliff", 0n);
  const teamVestingDuration = m.getParameter<bigint>("teamVestingDuration", 1n);

  // ---------- Fase A: Deploy ----------

  // 1. GovernanceToken (admin = deployer; ownership 2-step ao Timelock na fase C).
  const gov = m.contract("GovernanceToken", [govName, govSymbol, deployer], {
    id: "phaseA_GovernanceToken",
  });

  // 2. CreditToken (admin = deployer). Sem genesis — supply nasce no PSM.
  const credit = m.contract("CreditToken", [creditName, creditSymbol, deployer], {
    id: "phaseA_CreditToken",
  });

  // 3. CommunityTimelock (proposers=[], executors=[address(0)] = execucao
  //    publica pos-delay, admin = deployer ate a fase D).
  const timelock = m.contract(
    "CommunityTimelock",
    [timelockMinDelay, [], [ethers.ZeroAddress], deployer],
    { id: "phaseA_CommunityTimelock" },
  );

  // 4. ProjectRegistry (colateral em GOV; admin = deployer).
  const registry = m.contract(
    "ProjectRegistry",
    [gov, deployer, minCollateral, probationDuration],
    { id: "phaseA_ProjectRegistry" },
  );

  // 5. Treasury — cofre multi-ativo simples (admin = deployer).
  const treasury = m.contract("Treasury", [deployer], { id: "phaseA_Treasury" });

  // 6. Staking (GOV por projeto; sem admin).
  const staking = m.contract("Staking", [gov, registry], { id: "phaseA_Staking" });

  // 7. USDC de lastro: mock em dev, endereco oficial em producao.
  const usdc = deployUsdcMock
    ? m.contract("ERC20DecimalsMock", ["Mock USDC", "USDC", 6], { id: "phaseA_UsdcMock" })
    : m.contractAt("ERC20DecimalsMock", usdcAddress, { id: "phaseA_UsdcAt" });

  // 8. CreditPSM — mint/redeem 1:1 (sem roles proprias; precisa de
  //    MINTER+BURNER no CREDIT, fase B).
  const psm = m.contract("CreditPSM", [credit, usdc], { id: "phaseA_CreditPSM" });

  // 9. ProjectFunding (admin = deployer ate a fase C).
  const funding = m.contract("ProjectFunding", [deployer, credit, registry, staking], {
    id: "phaseA_ProjectFunding",
  });

  // 10. FeeRouterV2 — recipients iniciais = Treasury para as tres parcelas
  //     (eventos carregam o detalhamento; governanca re-aponta buyback/grants
  //     quando os veiculos dedicados existirem).
  const feeRouterV2 = m.contract(
    "FeeRouterV2",
    [
      deployer,
      credit,
      registry,
      funding,
      treasury,
      treasury,
      treasury,
      feeBps,
      { treasuryBps: feeTreasuryBps, buybackBps: feeBuybackBps, grantsBps: feeGrantsBps },
    ],
    { id: "phaseA_FeeRouterV2" },
  );

  // 11. CommunityGovernor (treasury imutavel pro scan de supermajority em
  //     gestao de roles do Treasury/Timelock).
  const governor = m.contract(
    "CommunityGovernor",
    [gov, timelock, treasury, votingDelay, votingPeriod, proposalThreshold, quorumNumerator],
    { id: "phaseA_CommunityGovernor" },
  );

  // ---------- Fase B: Role grants funcionais ----------

  // B.1/B.2 — CreditToken: MINTER + BURNER pro PSM (unico emissor/queimador).
  const grantMinter = m.call(credit, "grantRole", [MINTER_ROLE, psm], {
    id: "phaseB_grantMinterToPsm",
  });
  const grantBurner = m.call(credit, "grantRole", [BURNER_ROLE, psm], {
    id: "phaseB_grantBurnerToPsm",
  });

  // B.3 — ProjectFunding: REVENUE_NOTIFIER pro FeeRouterV2.
  const grantNotifier = m.call(funding, "grantRole", [REVENUE_NOTIFIER_ROLE, feeRouterV2], {
    id: "phaseB_grantNotifierToRouter",
  });

  // B.4/B.5 — Timelock: PROPOSER + CANCELLER pro Governor.
  const grantProposer = m.call(timelock, "grantRole", [PROPOSER_ROLE, governor], {
    id: "phaseB_grantProposerToGovernor",
  });
  const grantCanceller = m.call(timelock, "grantRole", [CANCELLER_ROLE, governor], {
    id: "phaseB_grantCancellerToGovernor",
  });

  // ---------- Fase C: Transferencia de roles para o Timelock ----------

  // C.1 — ProjectRegistry
  const cRegistryGov = m.call(registry, "grantRole", [GOVERNANCE_ROLE, timelock], {
    id: "phaseC_registryGovToTimelock",
  });
  const cRegistryAdmin = m.call(registry, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_registryAdminToTimelock",
  });

  // C.2 — Treasury
  const cTreasuryGov = m.call(treasury, "grantRole", [GOVERNANCE_ROLE, timelock], {
    id: "phaseC_treasuryGovToTimelock",
  });
  const cTreasuryAdmin = m.call(treasury, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_treasuryAdminToTimelock",
  });

  // C.3 — ProjectFunding
  const cFundingGov = m.call(funding, "grantRole", [GOVERNANCE_ROLE, timelock], {
    id: "phaseC_fundingGovToTimelock",
  });
  const cFundingAdmin = m.call(funding, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_fundingAdminToTimelock",
    after: [grantNotifier],
  });

  // C.4 — FeeRouterV2
  const cRouterGov = m.call(feeRouterV2, "grantRole", [GOVERNANCE_ROLE, timelock], {
    id: "phaseC_routerGovToTimelock",
  });
  const cRouterAdmin = m.call(feeRouterV2, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_routerAdminToTimelock",
  });

  // C.5 — CreditToken: Timelock vira admin (pode revogar MINTER/BURNER do
  //       PSM se a governanca decidir trocar o modulo de peg).
  const cCreditAdmin = m.call(credit, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_creditAdminToTimelock",
    after: [grantMinter, grantBurner],
  });

  // C.6 — GovernanceToken: transferOwnership 2-step (aceite = primeira
  //       proposta ratificada; ver decisao 4 do modulo antigo, inalterada).
  const cGovTransferOwnership = m.call(gov, "transferOwnership", [timelock], {
    id: "phaseC_govOwnershipToTimelock",
  });

  // ---------- Fase D: Renuncia do deployer (Timelock admin POR ULTIMO) ----------
  //
  // Cada renuncia de DEFAULT_ADMIN_ROLE em X espera TODAS as calls do
  // deployer que consomem essa role em X (batcher do Ignition pode reordenar
  // — `after` explicito evita renuncia prematura).

  const dRegistryGov = m.call(registry, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_registryRenounceGov",
    after: [cRegistryGov],
  });
  const dRegistryAdmin = m.call(registry, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_registryRenounceAdmin",
    after: [cRegistryAdmin, cRegistryGov],
  });

  const dTreasuryGov = m.call(treasury, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_treasuryRenounceGov",
    after: [cTreasuryGov],
  });
  const dTreasuryAdmin = m.call(treasury, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_treasuryRenounceAdmin",
    after: [cTreasuryAdmin, cTreasuryGov],
  });

  const dFundingGov = m.call(funding, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_fundingRenounceGov",
    after: [cFundingGov],
  });
  const dFundingAdmin = m.call(funding, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_fundingRenounceAdmin",
    after: [cFundingAdmin, cFundingGov, grantNotifier],
  });

  const dRouterGov = m.call(feeRouterV2, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_routerRenounceGov",
    after: [cRouterGov],
  });
  const dRouterAdmin = m.call(feeRouterV2, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_routerRenounceAdmin",
    after: [cRouterAdmin, cRouterGov],
  });

  const dCreditAdmin = m.call(credit, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_creditRenounceAdmin",
    after: [cCreditAdmin, grantMinter, grantBurner],
  });

  m.call(timelock, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_timelockRenounceAdmin",
    after: [
      grantProposer,
      grantCanceller,
      cGovTransferOwnership,
      dRegistryGov,
      dRegistryAdmin,
      dTreasuryGov,
      dTreasuryAdmin,
      dFundingGov,
      dFundingAdmin,
      dRouterGov,
      dRouterAdmin,
      dCreditAdmin,
    ],
  });

  // ---------- Fase E: TeamVesting opcional ----------

  let teamVesting;
  if (deployTeamVesting) {
    // `teamVestingBeneficiary` deve vir explicito quando a flag esta ativa
    // (ZeroAddress reverte no constructor — fail-fast, sem placeholder).
    teamVesting = m.contract(
      "TeamVesting",
      [gov, teamVestingBeneficiary, teamVestingStart, teamVestingCliff, teamVestingDuration, timelock],
      { id: "phaseE_TeamVesting", after: [cGovTransferOwnership] },
    );
  }

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
    ...(teamVesting !== undefined ? { teamVesting } : {}),
  };
});

export default CommunityDAOModule;
