import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { ethers } from "ethers";

/**
 * CommunityDAOModule — Modulo Ignition unico que deploya e wira a DAO Web3Community.
 *
 * Cobertura padrao: 10 contratos core (GOV, CREDIT, Timelock, Registry,
 * Treasury, Staking, BurnTracker, RewardDistributor, FeeRouter, Governor).
 * Opcionalmente — via flags `deployTeamVesting` e `deployUserSubsidy`,
 * ambas default `false` — o modulo tambem deploya `TeamVesting` (single
 * beneficiary) e `UserSubsidy` (singleton), totalizando ate 12 contratos
 * em um unico deploy all-in-one. Alem dessas, as flags `DEPLOY_CLP_PHASE1`
 * (LiquidityGauge + RewardDistributorV2) e `DEPLOY_CLP_ORACLE`
 * (CreditPriceOracle) — ambas default `false` — cobrem a Fase 1 do pivot
 * CLP com wiring minimo de constructor e ZERO concessao de roles pelo
 * modulo (roles via proposta; ver Fase F). Com os defaults, o comportamento e
 * bit-compatible com a versao anterior: o deploy dos 2 contratos
 * auxiliares permanece como responsabilidade dos modulos
 * `TeamVesting.ts` / `UserSubsidy.ts` acionados por propostas de
 * governanca apos o bootstrap. Racional da expansao documentado em
 * `audit/economist/2026-04-22-consistency-audit.md` (C3): facilita
 * testnet/dev all-in-one quando beneficiario e parametros estao
 * definidos a priori, sem alterar o caminho seguro de producao.
 *
 * Decisoes arquiteturais documentadas:
 *
 * 1) Single-module com parametros (em vez de modulos separados dev/prod).
 *    Defaults batem com o perfil DEV/teste local. Para producao, o deploy
 *    precisa receber `--parameters ignition/parameters/production.json` (override
 *    integral). Isso elimina drift entre os dois caminhos: a mesma sequencia de
 *    chamadas roda em ambos, so os valores mudam.
 *
 * 2) Genesis CREDIT vai 100% para o Treasury.
 *    Decisao consciente de simplificar a fase de bootstrap. A alocacao real
 *    (30% treasury permanente / 25% team vesting / 20% public sale / 15%
 *    community rewards / 10% liquidity) sera proposta e executada via
 *    Governor depois do bootstrap, com vesting e cliffs apropriados. Manter
 *    tudo em um unico bucket (Treasury) preserva flexibilidade e evita
 *    deploys dependentes de contratos (vesting, sale) ainda nao auditados.
 *
 * 3) Floor schedule: linear decay de 400_000e18 -> ~16_666e18 ao longo de 24
 *    rounds. Nao exigimos soma == 10M (CREDIT genesis) — floor e safety net
 *    de bootstrap, nao orcamento fechado. Soma efetiva ~ 5M CREDIT (valor
 *    exato 5_000_000e18 = 9_600_000e18 - 4_600_000e18, derivado no bloco
 *    "Floor schedule" abaixo), abaixo do genesis. Valores listados
 *    explicitamente no array para auditoria on-chain trivial.
 *
 * 4) acceptOwnership do GovernanceToken NAO acontece neste modulo.
 *    Ownable2Step exige que o NEW owner (Timelock) chame `acceptOwnership()`.
 *    O Timelock so executa o que foi `schedule()`d e passou pelo delay; nao
 *    podemos forcar ele a chamar `acceptOwnership` no mesmo deploy script.
 *    Estrategia: a PRIMEIRA proposta a ser ratificada no Governor em
 *    producao deve ser exatamente um `governanceToken.acceptOwnership()`,
 *    movendo o `_pendingOwner` (timelock) para `_owner`. Em dev/teste o
 *    fixture do teste integrado faz isso via `impersonateAccount` do
 *    Timelock (ver `test/ignition/Dao.test.ts`).
 *
 * 5) Ordem de operacoes (CRITICA):
 *    Fase A: deploy de todos os 10 contratos (deployer e admin temporario
 *            de tudo).
 *    Fase B: role grants funcionais (MINTER -> distributor, BURNER ->
 *            tracker, RECORDER -> feeRouter, PROPOSER/CANCELLER -> governor)
 *            + genesis mint.
 *    Fase C: roles de governanca para o Timelock (GOVERNANCE_ROLE +
 *            DEFAULT_ADMIN_ROLE em todos os contratos economicos +
 *            transferOwnership do GovernanceToken).
 *    Fase D: deployer renuncia TODAS as suas roles. Timelock DEFAULT_ADMIN
 *            renuncia POR ULTIMO — se renunciar antes, deployer perde o
 *            poder de conceder o restante.
 *
 *    Genesis mint precisa rodar ANTES da renuncia do DEFAULT_ADMIN_ROLE no
 *    CreditToken (mintGenesis e onlyRole(DEFAULT_ADMIN_ROLE)).
 *
 * 6) IDs unicos por call (Ignition exige). Prefixos semanticos:
 *    `phaseB_*`, `phaseC_*`, `phaseD_*` documentam claramente onde cada
 *    chamada se encaixa.
 *
 * 7) Floor schedule e passado como tuple (uint256[24]). Solidity ABI exige
 *    array fixo, e Ignition serializa arrays JS como tuple — funciona pois
 *    o constructor do RewardDistributor aceita `uint256[24] memory`.
 *
 * @custom:security-contact security@web3community.example
 */

// ------------------------------------------------------------------
// Constantes economicas
// ------------------------------------------------------------------

/**
 * Floor schedule: decay linear de 400_000e18 a ~16_666e18 ao longo de 24
 * rodadas. floor[i] = FLOOR_INITIAL - STEP * i, com STEP = FLOOR_INITIAL / 24.
 *
 * Soma analitica: sum_{i=0..23} (FLOOR_INITIAL - i * STEP)
 *                = 24*FLOOR_INITIAL - STEP * (23*24/2)
 *                = 24*FLOOR_INITIAL - STEP * 276
 *                = 24*400_000e18 - (400_000e18/24)*276
 *                = 9_600_000e18 - 4_600_000e18
 *                = 5_000_000e18  (5M CREDIT, abaixo dos 10M de genesis).
 *
 * Computado em runtime por clareza do code review (cada valor visivel no
 * audit). O array literal vai pra storage do RewardDistributor, imutavel
 * apos o deploy.
 */
const FLOOR_INITIAL: bigint = 400_000n * 10n ** 18n;
const FLOOR_STEP: bigint = FLOOR_INITIAL / 24n;
const FLOOR_SCHEDULE: bigint[] = Array.from(
  { length: 24 },
  (_, i) => FLOOR_INITIAL - FLOOR_STEP * BigInt(i),
);

// Hashes das roles (calculadas em build time — sao constants do AccessControl
// e nao dependem de runtime). Equivalentes a `keccak256("MINTER_ROLE")` etc.
const DEFAULT_ADMIN_ROLE: string = ethers.ZeroHash;
const MINTER_ROLE: string = ethers.id("MINTER_ROLE");
const BURNER_ROLE: string = ethers.id("BURNER_ROLE");
const RECORDER_ROLE: string = ethers.id("RECORDER_ROLE");
const GOVERNANCE_ROLE: string = ethers.id("GOVERNANCE_ROLE");
const PROPOSER_ROLE: string = ethers.id("PROPOSER_ROLE");
const CANCELLER_ROLE: string = ethers.id("CANCELLER_ROLE");

// ------------------------------------------------------------------
// Modulo
// ------------------------------------------------------------------

const CommunityDAOModule = buildModule("CommunityDAOModule", (m) => {
  const deployer = m.getAccount(0);

  // ---------- Parametros (defaults = perfil DEV) ----------

  // Token names
  const govName = m.getParameter<string>("govName", "Web3Community Governance");
  const govSymbol = m.getParameter<string>("govSymbol", "GOV");
  const creditName = m.getParameter<string>("creditName", "Web3Community Credit");
  const creditSymbol = m.getParameter<string>("creditSymbol", "CREDIT");

  // Timelock
  const timelockMinDelay = m.getParameter<bigint>("timelockMinDelay", 3_600n); // dev: 1h | prod: 172_800 (2d)

  // Registry
  const minCollateral = m.getParameter<bigint>("minCollateral", 1_000n * 10n ** 18n); // prod: 10_000e18
  const probationDuration = m.getParameter<bigint>("probationDuration", 86_400n); // dev: 1d | prod: 30d (2_592_000)

  // BurnTracker
  const roundDuration = m.getParameter<bigint>("roundDuration", 86_400n); // dev: 1d | prod: 7d (604_800)
  const sanityCap = m.getParameter<bigint>("sanityCap", 1_000_000n * 10n ** 18n); // prod: 10_000_000e18

  // RewardDistributor
  const alpha = m.getParameter<bigint>("alpha", 950_000_000_000_000_000n); // 0.95e18 (ambos)
  const capMax = m.getParameter<bigint>("capMax", 1_000_000n * 10n ** 18n); // dev: 1M | prod: 5_000_000e18

  // Floor schedule (24 valores). Default = computed acima. Passado como tuple
  // dinamica que Ignition empacota como uint256[24].
  const floorSchedule = m.getParameter<bigint[]>("floorSchedule", FLOOR_SCHEDULE);

  // FeeRouter — split inicial 70/20/10, ratificado na Fase 0 do pivot CLP
  // (docs/governance/fase0-default-split.md). Como o protocolo e
  // pre-deploy, o split novo e assado direto nos defaults e nos parameters
  // JSON (dev + production) — nao ha proposta `setDefaultSplit` pos-deploy
  // necessaria para fresh deploys.
  //
  // NOTA (racional economico, corrigido): a fatia `treasuryBps` (20%) e
  // denominada em CREDIT — `FeeRouter.pay` transfere CREDIT ao Treasury,
  // NAO USDC. Ela engorda o saldo livre de CREDIT do Treasury, mas nao
  // fornece o lado USDC de `Treasury.addPOLFromRefill`; as fontes reais de
  // USDC sao bootstrap externo e fees da posicao POL (`collectPOLFees`).
  // Sem USDC para casar, o `polRefillBucket` (5%/rodada via V2) cresce sem
  // consumo — a valvula `Treasury.writeDownPolRefillBucket` permite ao
  // governance reciclar bucket antigo de volta ao saldo livre antes que a
  // reserva domine o balanco de CREDIT (ver NatSpec de addPOLFromRefill).
  //
  // Passado como struct {burnBps, treasuryBps, rebateBps}.
  // Ignition serializa objetos como tuple de campos, ordem importa: ABI do
  // construtor da Split do FeeRouter e (uint16, uint16, uint16) na ordem
  // (burnBps, treasuryBps, rebateBps).
  const burnBps = m.getParameter<number>("burnBps", 7000);
  const treasuryBps = m.getParameter<number>("treasuryBps", 2000);
  const rebateBps = m.getParameter<number>("rebateBps", 1000);

  // Governor (parametros em BLOCOS)
  const votingDelay = m.getParameter<bigint>("votingDelay", 1n); // dev: 1 block | prod: 7200
  const votingPeriod = m.getParameter<bigint>("votingPeriod", 50n); // dev: 50 blocks | prod: 50400
  const proposalThreshold = m.getParameter<bigint>("proposalThreshold", 10_000n * 10n ** 18n);
  const quorumNumerator = m.getParameter<bigint>("quorumNumerator", 4n);

  // Genesis
  const genesisAmount = m.getParameter<bigint>("genesisAmount", 10_000_000n * 10n ** 18n);

  // USDC para o Treasury (FFP buyback — Fase 1.1 do pivot CLP).
  // Em producao, e o endereco do USDC oficial da rede alvo
  // (Sepolia/Mainnet). Em dev/teste, pode apontar para um ERC20Mock
  // deployado a parte ou para o proprio CREDIT (placeholder, sem efeito
  // ate `priceOracle`/`swapRouter` serem configurados via governance).
  // Default = ZeroAddress NAO e aceito pelo construtor do Treasury — em
  // dev/teste, sobrescrever via `ignition/parameters/dev.json` apontando
  // para um mock; em prod, via `production.json` apontando para o USDC
  // oficial.
  const usdcAddress = m.getParameter<string>("usdcAddress", ethers.ZeroAddress);

  // ------------------------------------------------------------------
  // Optional aux contracts (Fase E)
  // ------------------------------------------------------------------
  //
  // Flags lidas de env vars (`DEPLOY_TEAM_VESTING`, `DEPLOY_USER_SUBSIDY`),
  // ambas default `false`. Motivo de NAO usar `m.getParameter` aqui: o
  // Ignition resolve parametros so no deploy-time, retornando
  // `ModuleParameterRuntimeValue` objects que sao sempre truthy em JS.
  // Isso impede branching na definicao do modulo com base em valor de
  // parametro. Env vars resolvem no build-time (ao carregar o modulo),
  // permitindo que `if (flag) m.contract(...)` funcione como esperado.
  //
  // Caminho de producao bit-compatible com a versao anterior (10 contratos)
  // — nenhum deploy auxiliar se as env vars nao forem setadas. Quando
  // ativados, este modulo deploya `TeamVesting` (1 beneficiario) e/ou
  // `UserSubsidy` (singleton). Em qualquer cenario de auditoria seria,
  // `TeamVesting` e `UserSubsidy` devem ser deployados via proposta
  // ratificada no Governor (ver NatSpec de `TeamVesting.ts` / `UserSubsidy.ts`).
  // Este caminho all-in-one e uma conveniencia de dev/testnet.
  //
  // Os params de cronograma do TeamVesting continuam via `m.getParameter`
  // (Ignition aceita RuntimeValue como argumento de construtor diretamente).
  // Em prod, passe explicitamente via `ignition/parameters/*.json`.
  const deployTeamVesting = (process.env.DEPLOY_TEAM_VESTING ?? "").toLowerCase() === "true";
  const deployUserSubsidy = (process.env.DEPLOY_USER_SUBSIDY ?? "").toLowerCase() === "true";

  // Flags da Fase 1 do pivot CLP (mesmo padrao env-var das flags acima —
  // Ignition nao permite branching por parametro runtime, ver comentario
  // acima):
  //
  // - `DEPLOY_CLP_PHASE1`: deploya `LiquidityGauge` + `RewardDistributorV2`
  //   (Fase 1.3/1.4). Wiring MINIMO de constructor apenas; NENHUMA role e
  //   concedida pelo modulo (MINTER_ROLE do CREDIT para o V2, GAUGE_ROLE
  //   etc. continuam sendo concedidas por proposta ratificada no Governor).
  //   `admin` de ambos = Timelock (grant interno do proprio constructor,
  //   alinhado ao modelo de seguranca da Fase E: nenhum poder na EOA
  //   deployer).
  //
  // - `DEPLOY_CLP_ORACLE`: deploya `CreditPriceOracle` (adapter TWAP
  //   imutavel, sem roles). Em deploy fresh a pool Uniswap V3 CREDIT/USDC
  //   e o feed Chainlink NAO existem — os enderecos sao aceitos via
  //   parametro Ignition com default address(0) e o oracle SO deve ser
  //   deployado quando os parametros forem fornecidos. Como parametros
  //   Ignition so resolvem em deploy-time (RuntimeValue e sempre truthy em
  //   JS), a flag e a afirmacao build-time do operador de que os
  //   parametros existem; se a flag for setada com `creditUsdcPool` (ou
  //   `usdcAddress`) ainda em address(0), o constructor do oracle reverte
  //   com `ZeroAddress` — fail-fast, sem deploy silencioso de oracle
  //   quebrado. `usdcUsdFeed` em address(0) e VALIDO (modo 1 USDC = 1 USD,
  //   documentado no NatSpec do contrato).
  const deployClpPhase1 = (process.env.DEPLOY_CLP_PHASE1 ?? "").toLowerCase() === "true";
  const deployClpOracle = (process.env.DEPLOY_CLP_ORACLE ?? "").toLowerCase() === "true";

  const teamVestingBeneficiary = m.getParameter<string>(
    "teamVestingBeneficiary",
    ethers.ZeroAddress,
  );
  const teamVestingStart = m.getParameter<bigint>("teamVestingStart", 0n);
  const teamVestingCliff = m.getParameter<bigint>("teamVestingCliff", 0n);
  const teamVestingDuration = m.getParameter<bigint>("teamVestingDuration", 1n);

  // Enderecos externos da Fase 1 do pivot CLP. Defaults ZeroAddress NAO sao
  // validos para os construtores (revertem com `ZeroAddress`) — mesma
  // assinatura "dura" e intencional do `teamVestingBeneficiary` acima:
  // quando as flags `DEPLOY_CLP_PHASE1` / `DEPLOY_CLP_ORACLE` estiverem
  // ativas, os enderecos reais DEVEM vir via `ignition/parameters/*.json`.
  //
  // - `uniswapV3Staker` / `positionManager`: periferia canonica da Uniswap
  //   V3 na rede alvo (existem mesmo em deploy fresh da DAO).
  // - `creditUsdcPool`: pool Uniswap V3 CREDIT/USDC — NAO existe em deploy
  //   fresh (o CREDIT acabou de nascer); so fornecer depois que a pool for
  //   criada, tipicamente num deploy incremental do modulo.
  // - `usdcUsdFeed`: feed Chainlink USDC/USD — address(0) e VALIDO
  //   (fallback 1 USDC = 1 USD do adapter, ver CreditPriceOracle.sol).
  const uniswapV3Staker = m.getParameter<string>("uniswapV3Staker", ethers.ZeroAddress);
  const positionManager = m.getParameter<string>("positionManager", ethers.ZeroAddress);
  const creditUsdcPool = m.getParameter<string>("creditUsdcPool", ethers.ZeroAddress);
  const usdcUsdFeed = m.getParameter<string>("usdcUsdFeed", ethers.ZeroAddress);

  // ---------- Fase A: Deploy ----------

  // 1. GovernanceToken (admin = deployer; transfere ownership ao Timelock na fase C).
  const gov = m.contract("GovernanceToken", [govName, govSymbol, deployer], {
    id: "phaseA_GovernanceToken",
  });

  // 2. CreditToken (admin = deployer).
  const credit = m.contract("CreditToken", [creditName, creditSymbol, deployer], {
    id: "phaseA_CreditToken",
  });

  // 3. CommunityTimelock (proposers=[], executors=[address(0)], admin = deployer).
  //    address(0) em executors permite execucao publica pos-delay — recomendado
  //    em CommunityTimelock.sol contract-level NatSpec.
  const timelock = m.contract(
    "CommunityTimelock",
    [timelockMinDelay, [], [ethers.ZeroAddress], deployer],
    { id: "phaseA_CommunityTimelock" },
  );

  // 4. ProjectRegistry (depende de gov; admin = deployer).
  const registry = m.contract(
    "ProjectRegistry",
    [gov, deployer, minCollateral, probationDuration],
    { id: "phaseA_ProjectRegistry" },
  );

  // 5. Treasury (admin = deployer; CREDIT imutavel; USDC imutavel mas
  //    aceito como zero em dev/testnet — buyback FFP fica desativado por
  //    construcao ate USDC ser conhecido + oracle/router setados via
  //    governance, ver `contracts/Treasury.sol` constructor NatSpec).
  const treasury = m.contract("Treasury", [deployer, credit, usdcAddress], {
    id: "phaseA_Treasury",
  });

  // 6. Staking (depende de gov + registry; sem admin).
  const staking = m.contract("Staking", [gov, registry], { id: "phaseA_Staking" });

  // 7. BurnTracker (admin = deployer; depende de credit + registry).
  const burnTracker = m.contract(
    "BurnTracker",
    [deployer, credit, registry, roundDuration, sanityCap],
    { id: "phaseA_BurnTracker" },
  );

  // 8. RewardDistributor (admin = deployer; depende de credit + staking + tracker + registry).
  //    Floor schedule passado como tuple de 24 uint256.
  const distributor = m.contract(
    "RewardDistributor",
    [deployer, credit, staking, burnTracker, registry, alpha, capMax, floorSchedule],
    { id: "phaseA_RewardDistributor" },
  );

  // 9. FeeRouter (admin = deployer; depende de credit + tracker + registry + treasury).
  //    Split passado como tuple {burnBps, treasuryBps, rebateBps} — ordem dos
  //    campos espelha a struct Split em FeeRouter.sol.
  const feeRouter = m.contract(
    "FeeRouter",
    [deployer, credit, burnTracker, registry, treasury, { burnBps, treasuryBps, rebateBps }],
    { id: "phaseA_FeeRouter" },
  );

  // 10. CommunityGovernor (depende de gov + timelock + treasury).
  //     O treasury entra imutavel no construtor para o scan de proposal
  //     types: propostas contendo `Treasury.removePOL` exigem supermaioria
  //     75% (ver NatSpec de CommunityGovernor.sol).
  const governor = m.contract(
    "CommunityGovernor",
    [gov, timelock, treasury, votingDelay, votingPeriod, proposalThreshold, quorumNumerator],
    { id: "phaseA_CommunityGovernor" },
  );

  // ---------- Fase B: Role grants funcionais (deployer ainda admin) ----------

  // B.1 — CreditToken: MINTER_ROLE para o RewardDistributor.
  const grantMinter = m.call(credit, "grantRole", [MINTER_ROLE, distributor], {
    id: "phaseB_grantMinterToDistributor",
  });

  // B.2 — CreditToken: BURNER_ROLE para o BurnTracker.
  const grantBurner = m.call(credit, "grantRole", [BURNER_ROLE, burnTracker], {
    id: "phaseB_grantBurnerToTracker",
  });

  // B.3 — BurnTracker: RECORDER_ROLE para o FeeRouter.
  const grantRecorder = m.call(burnTracker, "grantRole", [RECORDER_ROLE, feeRouter], {
    id: "phaseB_grantRecorderToFeeRouter",
  });

  // B.4 — Timelock: PROPOSER_ROLE para o Governor.
  const grantProposer = m.call(timelock, "grantRole", [PROPOSER_ROLE, governor], {
    id: "phaseB_grantProposerToGovernor",
  });

  // B.5 — Timelock: CANCELLER_ROLE para o Governor.
  const grantCanceller = m.call(timelock, "grantRole", [CANCELLER_ROLE, governor], {
    id: "phaseB_grantCancellerToGovernor",
  });

  // B.6 — Genesis mint do CREDIT para o Treasury.
  //       Tem que rodar ANTES de renunciar DEFAULT_ADMIN_ROLE do CREDIT (fase D).
  const genesisMint = m.call(credit, "mintGenesis", [treasury, genesisAmount], {
    id: "phaseB_genesisMintToTreasury",
  });

  // ---------- Fase C: Transferencia de roles para o Timelock ----------
  //
  // Em cada contrato gated por AccessControl: GOVERNANCE_ROLE primeiro
  // (operacional), DEFAULT_ADMIN_ROLE depois (meta — quem pode conceder
  // outras roles). A ordem nao afeta correcao dentro do mesmo contrato, mas
  // mantem o pattern legivel.
  //
  // ATENCAO: aqui o Timelock recebe poder, mas o deployer ainda mantem suas
  // proprias roles ate a fase D. So apos D o sistema esta totalmente em
  // governanca.

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

  // C.3 — BurnTracker
  const cTrackerGov = m.call(burnTracker, "grantRole", [GOVERNANCE_ROLE, timelock], {
    id: "phaseC_trackerGovToTimelock",
    after: [grantRecorder], // garantir que RECORDER_ROLE ja foi concedido antes
  });
  const cTrackerAdmin = m.call(burnTracker, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_trackerAdminToTimelock",
  });

  // C.4 — RewardDistributor
  const cDistributorGov = m.call(distributor, "grantRole", [GOVERNANCE_ROLE, timelock], {
    id: "phaseC_distributorGovToTimelock",
  });
  const cDistributorAdmin = m.call(distributor, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_distributorAdminToTimelock",
  });

  // C.5 — FeeRouter
  const cRouterGov = m.call(feeRouter, "grantRole", [GOVERNANCE_ROLE, timelock], {
    id: "phaseC_routerGovToTimelock",
  });
  const cRouterAdmin = m.call(feeRouter, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_routerAdminToTimelock",
  });

  // C.6 — CreditToken: timelock vira admin (vai poder revogar MINTER/BURNER se preciso).
  //       Tem que esperar genesisMint terminar — apos esta call o Timelock detem
  //       DEFAULT_ADMIN, mas o deployer so renuncia em D. Antes disso, deployer
  //       ainda pode chamar mintGenesis caso B.6 nao tenha rodado, mas com a flag
  //       genesisMinted = true ja, qualquer reentry reverte com GenesisAlreadyMinted.
  const cCreditAdmin = m.call(credit, "grantRole", [DEFAULT_ADMIN_ROLE, timelock], {
    id: "phaseC_creditAdminToTimelock",
    after: [genesisMint, grantMinter, grantBurner],
  });

  // C.7 — GovernanceToken: transferOwnership 2-step para o Timelock.
  //       Apenas seta `_pendingOwner = timelock`. O Timelock precisa chamar
  //       `acceptOwnership()` em uma proposta ratificada via Governor para que
  //       a transferencia se complete (ver decisao 4 no header). Ate la, o
  //       deployer continua sendo o owner efetivo do GOV — mas o `mint()` so
  //       e usado em distribuicao manual e nao e necessario para a operacao
  //       basica da DAO.
  const cGovTransferOwnership = m.call(gov, "transferOwnership", [timelock], {
    id: "phaseC_govOwnershipToTimelock",
  });

  // ---------- Fase D: Renuncia do deployer ----------
  //
  // ORDEM RIGIDA: TIMELOCK ADMIN POR ULTIMO. Se o admin do Timelock for
  // renunciado antes das outras renuncias, o deployer ainda renuncia as
  // proprias mas isso nao afeta — o problema seria se o deployer precisasse
  // CONCEDER algo a alguem depois, e ai o Timelock ja nao teria self-admin.
  // Manter o Timelock por ultimo e a regra defensiva.
  //
  // BUG FIX (importante): cada renuncia de DEFAULT_ADMIN_ROLE em um contrato
  // X precisa esperar TODAS as chamadas de grantRole pelo deployer em X, nao
  // apenas a do `cXxxAdmin`. Caso contrario o batcher do Ignition pode
  // colocar `phaseD_xxxRenounceAdmin` num batch ANTERIOR ao `phaseC_xxxGovToTimelock`
  // — o deployer perde DEFAULT_ADMIN_ROLE em X e a fase C subsequente reverte
  // com `AccessControlUnauthorizedAccount`. Por isso `dXxxAdmin` declara
  // explicitamente `after: [cXxxAdmin, cXxxGov]`.
  //
  // Renuncia de GOVERNANCE_ROLE so precisa esperar `cXxxGov` — uma vez
  // gravada, deployer pode renunciar a propria sem afetar o admin de gating.

  // D.1 — Registry
  const dRegistryGov = m.call(registry, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_registryRenounceGov",
    after: [cRegistryGov],
  });
  const dRegistryAdmin = m.call(registry, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_registryRenounceAdmin",
    after: [cRegistryAdmin, cRegistryGov],
  });

  // D.2 — Treasury
  const dTreasuryGov = m.call(treasury, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_treasuryRenounceGov",
    after: [cTreasuryGov],
  });
  const dTreasuryAdmin = m.call(treasury, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_treasuryRenounceAdmin",
    after: [cTreasuryAdmin, cTreasuryGov],
  });

  // D.3 — BurnTracker
  const dTrackerGov = m.call(burnTracker, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_trackerRenounceGov",
    after: [cTrackerGov],
  });
  const dTrackerAdmin = m.call(burnTracker, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_trackerRenounceAdmin",
    after: [cTrackerAdmin, cTrackerGov, grantRecorder], // grantRecorder tambem usa DEFAULT_ADMIN do tracker
  });

  // D.4 — RewardDistributor
  const dDistributorGov = m.call(distributor, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_distributorRenounceGov",
    after: [cDistributorGov],
  });
  const dDistributorAdmin = m.call(distributor, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_distributorRenounceAdmin",
    after: [cDistributorAdmin, cDistributorGov],
  });

  // D.5 — FeeRouter
  const dRouterGov = m.call(feeRouter, "renounceRole", [GOVERNANCE_ROLE, deployer], {
    id: "phaseD_routerRenounceGov",
    after: [cRouterGov],
  });
  const dRouterAdmin = m.call(feeRouter, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_routerRenounceAdmin",
    after: [cRouterAdmin, cRouterGov],
  });

  // D.6 — CreditToken admin. Precisa esperar genesisMint, grantMinter,
  //       grantBurner E cCreditAdmin — todos consomem o DEFAULT_ADMIN_ROLE
  //       do deployer no CREDIT.
  const dCreditAdmin = m.call(credit, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_creditRenounceAdmin",
    after: [cCreditAdmin, genesisMint, grantMinter, grantBurner],
  });

  // D.7 — Timelock admin POR ULTIMO. Apos esta call, o Timelock e
  //       self-administered: so ele mesmo (via execucao de proposta
  //       aprovada no Governor) pode alterar suas proprias roles.
  m.call(timelock, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], {
    id: "phaseD_timelockRenounceAdmin",
    after: [
      // Garantir que TUDO antes ja foi feito (defensivo).
      grantProposer,
      grantCanceller,
      cGovTransferOwnership,
      dRegistryGov,
      dRegistryAdmin,
      dTreasuryGov,
      dTreasuryAdmin,
      dTrackerGov,
      dTrackerAdmin,
      dDistributorGov,
      dDistributorAdmin,
      dRouterGov,
      dRouterAdmin,
      dCreditAdmin,
    ],
  });

  // ---------- Fase E: Deploys opcionais de contratos auxiliares ----------
  //
  // Estes deploys sao desligados por default. Quando ativos, usam o Timelock
  // ja deployado como `owner`/`admin`, alinhando-se ao modelo de seguranca
  // do resto da DAO (nenhum poder permanente na EOA deployer). Nao ha
  // transferencia de ownership adicional necessaria — `TeamVesting` usa
  // `Ownable(owner_)` no construtor, e `UserSubsidy` concede ambas as roles
  // ao `admin` no construtor. Como o fluxo de funding (mint de GOV, transfer
  // de CREDIT) exige proposta do Governor, nada aqui pode ser capturado
  // mesmo com defaults conservadores — o contrato permanece vazio ate que
  // uma proposta ratifique o funding.
  //
  // Ordem: apos fase D. Nao ha dependencias de role neste caminho — o
  // deployer nao precisa mais ter roles. Opcional: encadear via `after`
  // para evitar reordenacao do batcher que tente deployar antes da
  // transferencia de ownership do GOV (defensivo mesmo sendo contratos
  // independentes).

  let teamVesting;
  if (deployTeamVesting) {
    // IMPORTANTE: `teamVestingBeneficiary` deve ser explicitamente fornecido
    // quando `deployTeamVesting=true`. O default ZeroAddress NAO e valido
    // para o construtor (reverte com `ZeroAddress`). Essa assinatura "dura"
    // e intencional — evita deploy silencioso com placeholder invisivel
    // em producao. Em dev/testnet onde um placeholder seguro e aceitavel,
    // passe `teamVestingBeneficiary = <deployer address>` via parameters
    // JSON; em prod, passe o endereco real do membro.
    teamVesting = m.contract(
      "TeamVesting",
      [
        gov,
        teamVestingBeneficiary,
        teamVestingStart,
        teamVestingCliff,
        teamVestingDuration,
        timelock,
      ],
      {
        id: "phaseE_TeamVesting",
        after: [cGovTransferOwnership],
      },
    );
  }

  let userSubsidy;
  if (deployUserSubsidy) {
    userSubsidy = m.contract("UserSubsidy", [credit, timelock], {
      id: "phaseE_UserSubsidy",
      after: [cCreditAdmin],
    });
  }

  // ---------- Fase F: Deploys opcionais da Fase 1 do pivot CLP ----------
  //
  // Desligados por default (flags `DEPLOY_CLP_PHASE1` / `DEPLOY_CLP_ORACLE`,
  // ver bloco de flags acima). Wiring MINIMO de constructor apenas — o
  // modulo NAO concede nenhuma role a estes contratos (nem deles para
  // outros): MINTER_ROLE do CREDIT para o RewardDistributorV2, whitelist de
  // pools no gauge, `Treasury.setPriceOracle(oracle)` etc. sao atos de
  // governanca e continuam via proposta ratificada no Governor.
  //
  // `admin` do gauge e do V2 = Timelock: e o proprio constructor de cada
  // contrato que concede DEFAULT_ADMIN/GOVERNANCE ao `admin` — nenhum poder
  // fica na EOA deployer, consistente com a Fase E. O CreditPriceOracle e
  // um adapter imutavel sem roles/owner por design.
  //
  // `after: [cCreditAdmin]` defensivo: garante que o batcher nao intercale
  // estes deploys no meio das fases B-D (mesma justificativa da Fase E).

  let liquidityGauge;
  let distributorV2;
  if (deployClpPhase1) {
    // IMPORTANTE: `uniswapV3Staker` e `positionManager` devem ser
    // explicitamente fornecidos quando `DEPLOY_CLP_PHASE1=true` — o default
    // ZeroAddress reverte no constructor (`ZeroAddress`), fail-fast.
    liquidityGauge = m.contract(
      "LiquidityGauge",
      [timelock, credit, uniswapV3Staker, positionManager],
      {
        id: "phaseF_LiquidityGauge",
        after: [cCreditAdmin],
      },
    );

    // RewardDistributorV2 depende do gauge (constructor) — Ignition ordena
    // automaticamente via a future `liquidityGauge`. Reusa alpha/capMax/
    // floorSchedule do V1: os parametros economicos sao os mesmos; a
    // migracao V1 -> V2 (revogar MINTER do V1, conceder ao V2) e ato de
    // governanca fora deste modulo.
    distributorV2 = m.contract(
      "RewardDistributorV2",
      [
        timelock,
        credit,
        staking,
        burnTracker,
        registry,
        liquidityGauge,
        treasury,
        alpha,
        capMax,
        floorSchedule,
      ],
      {
        id: "phaseF_RewardDistributorV2",
        after: [cCreditAdmin],
      },
    );
  }

  let creditPriceOracle;
  if (deployClpOracle) {
    // SO deployar com `creditUsdcPool` (e `usdcAddress`) reais — pool/feed
    // nao existem em deploy fresh, por isso a flag e SEPARADA da
    // `DEPLOY_CLP_PHASE1`. Com pool ou USDC em address(0) o constructor
    // reverte com `ZeroAddress`; `usdcUsdFeed` pode ser address(0)
    // (fallback 1 USDC = 1 USD). Ver bloco de flags acima para o racional
    // completo (parametros Ignition nao permitem branching build-time).
    creditPriceOracle = m.contract(
      "CreditPriceOracle",
      [creditUsdcPool, credit, usdcAddress, usdcUsdFeed],
      {
        id: "phaseF_CreditPriceOracle",
        after: [cCreditAdmin],
      },
    );
  }

  // Retorno com shape estavel. Os campos `teamVesting` / `userSubsidy` /
  // `liquidityGauge` / `distributorV2` / `creditPriceOracle` so existem
  // quando os flags correspondentes foram passados. Consumidores devem
  // checar antes de usar.
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
    ...(teamVesting !== undefined ? { teamVesting } : {}),
    ...(userSubsidy !== undefined ? { userSubsidy } : {}),
    ...(liquidityGauge !== undefined ? { liquidityGauge } : {}),
    ...(distributorV2 !== undefined ? { distributorV2 } : {}),
    ...(creditPriceOracle !== undefined ? { creditPriceOracle } : {}),
  };
});

export default CommunityDAOModule;
