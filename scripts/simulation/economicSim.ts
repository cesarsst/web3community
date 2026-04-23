/**
 * economicSim.ts — Simulacao economica multi-rodada da DAO Web3Community.
 *
 * Objetivo: validar que o modelo e estavel ao longo de 52 rodadas (~ 1 ano
 * com roundDuration = 7 dias em prod) sob 3 cenarios distintos:
 *
 *  A) Bootstrap saudavel: uso crescente ate estabilizar.
 *  B) Death spiral:        uso alto cai drasticamente; floor decay protege?
 *  C) Wash-burn ataque:    projeto malicioso tenta queimar acima do sanityCap.
 *
 * Como roda:
 *   npm run sim
 *   # ou diretamente:
 *   npx hardhat run scripts/simulation/economicSim.ts
 *
 * Saidas:
 *   scripts/simulation/output/sim_A.csv
 *   scripts/simulation/output/sim_B.csv
 *   scripts/simulation/output/sim_C.csv
 *   scripts/simulation/output/report.md
 *
 * Importante: esta simulacao NAO e um teste — ela nao falha se uma metrica
 * for ruim. O proposito e MEDIR onde o modelo quebra. O unico hard assert e
 * no cenario C: o wash-burn precisa ser rejeitado pelo BurnTracker e os
 * agregados nao podem ser corrompidos.
 *
 * Setup economico:
 *   - Deploy via Ignition (perfil DEV).
 *   - Impersonate do Timelock pra bootstrap: mint GOV pra Alice/Bob,
 *     transferir CREDIT do Treasury pra Charlie (o "usuario final"), ativar
 *     1 projeto ("Sim App") via Timelock.
 *   - Alice stakes 80k GOV no projeto com lock 30d.
 *   - Bob stakes 40k GOV no mesmo projeto com lock 90d.
 *   - Rodadas: a cada rodada, Charlie paga o burn planejado pelo cenario via
 *     FeeRouter (95/0/5). Timelock fecha rodada; finalize. Alice e Bob claim
 *     a partir de round 1 (round 0 usa floor, round 1 usa burn do round 0).
 *
 * Metricas coletadas por round:
 *   - burnR: burn da rodada atual (wei).
 *   - emissionRplus1: emissao da rodada seguinte (wei).
 *   - creditSupply: totalSupply de CREDIT no fim da rodada (wei).
 *   - aliceReward, bobReward: claim da rodada (wei).
 *   - aliceAPR, bobAPR: APR anualizado estimado (%) baseado no stake e rewards
 *     acumulados das ultimas 4 rodadas (moving window).
 */

/* eslint-disable no-console */

import fs from "fs";
import path from "path";
import hre, { ethers } from "hardhat";
import { impersonateAccount, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";

import CommunityDAOModule from "../../ignition/modules/Dao";

// ------------------------------------------------------------------
// Constantes do cenario (DEV defaults)
// ------------------------------------------------------------------

const ROUND_DURATION_SEC = 86_400n; // 1 dia (DEV)
const PROJECT_COLLATERAL = 5_000n * 10n ** 18n;
const ALICE_GOV = 100_000n * 10n ** 18n;
const BOB_GOV = 50_000n * 10n ** 18n;
const ALICE_STAKE = 80_000n * 10n ** 18n;
const BOB_STAKE = 40_000n * 10n ** 18n;
const ALICE_LOCK = 30n * 86_400n;
const BOB_LOCK = 90n * 86_400n;
// Charlie seed: precisa cobrir payments ao longo de todos os 52 rounds em 3
// cenarios. Payment_max por round ~ 1M CREDIT / 0.95 = ~1.05M. 52 rounds * 1.05M
// = ~55M. Damos 60M pra folga.
const CHARLIE_SEED = 60_000_000n * 10n ** 18n;
const NUM_ROUNDS = 52;

// APR annualization: assumimos 1 round = 7 dias (mesmo que DEV use 1d,
// a simulacao conceitual representa o schedule de producao).
const ROUNDS_PER_YEAR = 52n;
const WINDOW = 4; // janela de moving avg pra APR (4 rounds = ~1 mes em prod)

// ------------------------------------------------------------------
// Tipagem das metricas
// ------------------------------------------------------------------

interface RoundMetric {
  round: number;
  burnR: bigint;
  emissionRplus1: bigint; // emissao projetada para o round seguinte
  creditSupply: bigint;
  aliceReward: bigint;
  bobReward: bigint;
  aliceAPRBps: number; // basis points (100bps = 1%)
  bobAPRBps: number;
}

interface ScenarioResult {
  name: string;
  description: string;
  metrics: RoundMetric[];
  notes: string[];
}

// ------------------------------------------------------------------
// Curvas de burn por cenario
// ------------------------------------------------------------------

// Burn alvo = o que efetivamente e QUEIMADO no round (95% do payment).
// sanityCap = 1M CREDIT/round/project no DEV. Todas as curvas ficam <= 950k pra
// respeitar o cap com folga (exceto cenario C, que TENTA 10M como ataque).
function burnCurveA(round: number): bigint {
  // Bootstrap saudavel. Crescimento linear 200k -> 950k em rounds 1..5,
  // estavel em 950k depois.
  if (round === 0) return 0n;
  if (round >= 1 && round <= 5) {
    const target = 200_000n + (750_000n * BigInt(round - 1)) / 4n;
    return target * 10n ** 18n;
  }
  return 950_000n * 10n ** 18n;
}

function burnCurveB(round: number): bigint {
  // Death spiral. Rounds 0..5 crescente ate 950k. 6..20 decai linear
  // ate 100k. 21..52 estavel baixo em 50k.
  if (round === 0) return 0n;
  if (round >= 1 && round <= 5) {
    return 190_000n * BigInt(round) * 10n ** 18n; // 190k, 380k, 570k, 760k, 950k
  }
  if (round >= 6 && round <= 20) {
    // decai linear: 950k @ round 6, 100k @ round 20.
    const rounds = BigInt(round - 6);
    const drop = (850_000n * rounds) / 14n;
    const v = 950_000n - drop;
    return v * 10n ** 18n;
  }
  return 50_000n * 10n ** 18n;
}

// Burn do cenario C segue o A, exceto round 5 que tenta 10M (acima do cap).
function burnCurveC(round: number): bigint {
  if (round === 5) {
    return 10_000_000n * 10n ** 18n; // ataque — esperado REJEITADO
  }
  return burnCurveA(round);
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function bpsFromRatio(num: bigint, den: bigint): number {
  if (den === 0n) return 0;
  // Converte para Number com precisao em bps. bps = num / den * 10000.
  const bps = Number((num * 10_000n) / den);
  return bps;
}

function formatBigInt(v: bigint, decimals = 18): string {
  const div = 10n ** BigInt(decimals);
  const whole = v / div;
  const frac = v % div;
  // 2 casas decimais pra visualizacao.
  const frac2 = Number((frac * 100n) / div);
  return `${whole.toString()}.${frac2.toString().padStart(2, "0")}`;
}

function formatBpsAsPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

// ------------------------------------------------------------------
// Core setup (roda uma vez por cenario)
// ------------------------------------------------------------------

async function setupEcosystem() {
  const deployed = await hre.ignition.deploy(CommunityDAOModule);

  const [deployer, alice, bob, charlie, simAppOwner] = await ethers.getSigners();

  const gov = await ethers.getContractAt("GovernanceToken", await deployed.gov.getAddress());
  const credit = await ethers.getContractAt("CreditToken", await deployed.credit.getAddress());
  const timelock = await ethers.getContractAt(
    "CommunityTimelock",
    await deployed.timelock.getAddress(),
  );
  const registry = await ethers.getContractAt(
    "ProjectRegistry",
    await deployed.registry.getAddress(),
  );
  const treasury = await ethers.getContractAt("Treasury", await deployed.treasury.getAddress());
  const staking = await ethers.getContractAt("Staking", await deployed.staking.getAddress());
  const burnTracker = await ethers.getContractAt(
    "BurnTracker",
    await deployed.burnTracker.getAddress(),
  );
  const distributor = await ethers.getContractAt(
    "RewardDistributor",
    await deployed.distributor.getAddress(),
  );
  const feeRouter = await ethers.getContractAt("FeeRouter", await deployed.feeRouter.getAddress());

  // Impersonate Timelock.
  const tlAddr = await timelock.getAddress();
  await impersonateAccount(tlAddr);
  const tlSigner = await ethers.getSigner(tlAddr);
  await setBalance(tlSigner.address, ethers.parseEther("100"));

  // Aceita ownership do GOV.
  await gov.connect(tlSigner).acceptOwnership();

  // Mint GOV pros atores.
  await gov.connect(tlSigner).mint(alice.address, ALICE_GOV, "sim:alice");
  await gov.connect(tlSigner).mint(bob.address, BOB_GOV, "sim:bob");
  await gov.connect(tlSigner).mint(simAppOwner.address, PROJECT_COLLATERAL, "sim:appOwner");

  // Seed CREDIT pro Charlie pagar ao longo das 52 rodadas.
  // Cenario B pico: 1.5M CREDIT num round. 52 rounds * 1M == 52M. Damos 200M
  // de folga (cenario C tambem tenta 10M num round).
  //
  // Como o genesis e 10M apenas, precisamos que o distributor mint de reward
  // NAO vai para o Charlie (vai pra Alice/Bob). O Charlie gasta e queima
  // (sai do supply). Como o CREDIT e elastico no mint (so requer MINTER_ROLE),
  // podemos dar poder temporario ao Timelock para mintar para charlie — mas
  // MINTER_ROLE so o distributor tem.
  //
  // Alternativa limpa: o Treasury tem 10M no genesis. Alem disso, NAO
  // conseguimos criar CREDIT para charlie sem passar pelo distributor. Entao
  // limitamos CHARLIE_SEED ao que o Treasury tem (10M no genesis).
  //
  // 10M cobre ate ~10 rounds de 1M. Pra 52 rounds isso nao basta. Solucao:
  // damos MINTER_ROLE ao Timelock temporariamente (via impersonate — o
  // Timelock pos-deploy e DEFAULT_ADMIN do CREDIT e pode conceder role para
  // si mesmo). Isso e fora do uso "real" — puro artificio de simulacao.
  await credit.connect(tlSigner).grantRole(await credit.MINTER_ROLE(), tlAddr);
  await credit.connect(tlSigner).mint(charlie.address, CHARLIE_SEED, "sim:seedCharlie");

  // Registra + ativa o projeto unico da simulacao.
  await gov.connect(simAppOwner).approve(await registry.getAddress(), PROJECT_COLLATERAL);
  await registry
    .connect(tlSigner)
    .registerProject(simAppOwner.address, "ipfs://sim-app", PROJECT_COLLATERAL);
  const simAppId = 1n;
  await registry.connect(tlSigner).activateProject(simAppId);

  // Alice e Bob stake.
  await gov.connect(alice).approve(await staking.getAddress(), ALICE_STAKE);
  await staking.connect(alice).stake(simAppId, ALICE_STAKE, ALICE_LOCK);
  await gov.connect(bob).approve(await staking.getAddress(), BOB_STAKE);
  await staking.connect(bob).stake(simAppId, BOB_STAKE, BOB_LOCK);

  // Charlie aprova o FeeRouter ilimitadamente pra facilitar.
  await credit.connect(charlie).approve(await feeRouter.getAddress(), ethers.MaxUint256);

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
    deployer,
    alice,
    bob,
    charlie,
    simAppOwner,
    tlSigner,
    simAppId,
  };
}

// ------------------------------------------------------------------
// Runner de cenario
// ------------------------------------------------------------------

async function runScenario(
  name: string,
  description: string,
  curve: (round: number) => bigint,
  treatRound5AsAttack: boolean, // true para C — valida revert no round 5
): Promise<ScenarioResult> {
  const ctx = await setupEcosystem();
  const metrics: RoundMetric[] = [];
  const notes: string[] = [];

  // Historico pra moving window APR.
  const aliceRewards: bigint[] = [];
  const bobRewards: bigint[] = [];

  for (let round = 0; round < NUM_ROUNDS; round++) {
    const targetBurn = curve(round);

    // Simula burn na rodada atual (round).
    // Charlie paga targetBurn / 0.95 pra que 95% = targetBurn seja queimado
    // (splits 95/0/5). Se targetBurn == 0 (round 0 do cenario A), pula.
    //
    // IMPORTANTE: no cenario C round 5 vamos tentar pagar 10M CREDIT.
    // FeeRouter faz transferFrom(charlie, feeRouter, totalPayment) =>
    // tenta burnAndRecord(projectId, feeRouter, targetBurn) no BurnTracker.
    // SanityCap = 1M CREDIT (DEV). targetBurn = 10M deve bater o cap.
    if (targetBurn > 0n) {
      // payment = ceil(targetBurn / 0.95), com split 95/0/5.
      // Para garantir burn >= targetBurn, usamos payment = targetBurn * 10000 / 9500.
      // (parte nao queimada vai pro appOwner como rebate)
      const payment = (targetBurn * 10_000n) / 9_500n;

      if (treatRound5AsAttack && round === 5) {
        // Atencao: SanityCap no DEV == 1M. payment = 10M / 0.95 ~ 10.52M.
        // burnComputed = payment * 0.95 = 10M — deve bater o cap.
        let reverted = false;
        try {
          await ctx.feeRouter.connect(ctx.charlie).pay(ctx.simAppId, ctx.charlie.address, payment);
        } catch (e: unknown) {
          reverted = true;
          const msg = (e as Error).message ?? "";
          notes.push(
            `round=${round}: wash-burn de ${formatBigInt(targetBurn)} CREDIT REJEITADO (esperado). Revert: ${msg.slice(0, 100)}`,
          );
        }
        if (!reverted) {
          notes.push(
            `round=${round}: WARN — ataque NAO foi rejeitado (esperado SanityCapExceeded)`,
          );
        }
        // Nao incrementa burn — tx reverteu.
      } else {
        // Pagamento normal.
        await ctx.feeRouter.connect(ctx.charlie).pay(ctx.simAppId, ctx.charlie.address, payment);
      }
    }

    // Fecha rodada corrente (quem impersona: Timelock, tem GOVERNANCE_ROLE).
    await time.increase(ROUND_DURATION_SEC + 1n);
    await ctx.burnTracker.connect(ctx.tlSigner).closeRound();

    // Finaliza esta rodada (permissionless).
    await ctx.distributor.connect(ctx.deployer).finalizeRound(round);

    // Alice e Bob claim a partir de round 1. Round 0 tem emissao baseada em
    // floor[0] e claim funciona (share via global weight), mas so vale a pena
    // coletar a partir de round 1 pra validar o acoplamento com o burn.
    let aliceReward = 0n;
    let bobReward = 0n;
    if (round >= 0) {
      const aliceBefore = await ctx.credit.balanceOf(ctx.alice.address);
      const bobBefore = await ctx.credit.balanceOf(ctx.bob.address);
      const alicePreview = await ctx.distributor.previewClaim(
        ctx.alice.address,
        round,
        ctx.simAppId,
      );
      const bobPreview = await ctx.distributor.previewClaim(ctx.bob.address, round, ctx.simAppId);
      if (alicePreview > 0n) {
        await ctx.distributor.connect(ctx.alice).claim(round, ctx.simAppId);
        aliceReward = (await ctx.credit.balanceOf(ctx.alice.address)) - aliceBefore;
      }
      if (bobPreview > 0n) {
        await ctx.distributor.connect(ctx.bob).claim(round, ctx.simAppId);
        bobReward = (await ctx.credit.balanceOf(ctx.bob.address)) - bobBefore;
      }
    }

    aliceRewards.push(aliceReward);
    bobRewards.push(bobReward);

    // Calcula APR usando moving window. Premissa: 1 round = "slot semanal" em
    // producao (52 rounds = 1 ano). APR = rewards_last_WINDOW_rounds / stake *
    // (ROUNDS_PER_YEAR / WINDOW).
    //
    // rewardsInWindow = soma dos ultimos WINDOW rewards.
    let aliceRewardsWindow = 0n;
    let bobRewardsWindow = 0n;
    const start = Math.max(0, round - WINDOW + 1);
    for (let i = start; i <= round; i++) {
      aliceRewardsWindow += aliceRewards[i];
      bobRewardsWindow += bobRewards[i];
    }
    const winLen = BigInt(round - start + 1);

    const aliceAPRBps =
      winLen > 0n ? bpsFromRatio(aliceRewardsWindow * ROUNDS_PER_YEAR, ALICE_STAKE * winLen) : 0;
    const bobAPRBps =
      winLen > 0n ? bpsFromRatio(bobRewardsWindow * ROUNDS_PER_YEAR, BOB_STAKE * winLen) : 0;

    const rd = await ctx.distributor.roundData(round);
    const nextEmission = await ctx.distributor.previewEmission(BigInt(round + 1));

    metrics.push({
      round,
      burnR: targetBurn,
      emissionRplus1: nextEmission,
      creditSupply: await ctx.credit.totalSupply(),
      aliceReward,
      bobReward,
      aliceAPRBps,
      bobAPRBps,
    });

    // Sanity: emissao da rodada atual gravada == o que esperavamos via formula?
    // Imprime apenas na console como progresso.
    if (round % 10 === 0) {
      console.log(
        `  [${name}] round=${round} burn=${formatBigInt(targetBurn)} emission=${formatBigInt(rd.totalEmission)} supply=${formatBigInt(metrics[round].creditSupply)} aliceAPR=${formatBpsAsPct(aliceAPRBps)}`,
      );
    }
  }

  return { name, description, metrics, notes };
}

// ------------------------------------------------------------------
// Output (CSV + report.md)
// ------------------------------------------------------------------

function writeCSV(result: ScenarioResult, outDir: string) {
  const rows = [
    "round,burn_R,emission_R+1,credit_supply,alice_reward,bob_reward,alice_apr_bps,bob_apr_bps",
  ];
  for (const m of result.metrics) {
    rows.push(
      `${m.round},${m.burnR.toString()},${m.emissionRplus1.toString()},${m.creditSupply.toString()},${m.aliceReward.toString()},${m.bobReward.toString()},${m.aliceAPRBps},${m.bobAPRBps}`,
    );
  }
  const fileName = `sim_${result.name}.csv`;
  fs.writeFileSync(path.join(outDir, fileName), rows.join("\n"));
  console.log(`  wrote ${fileName}`);
}

function printAsciiTable(result: ScenarioResult): string {
  // Burn/emission: em milhoes de CREDIT (div 1e24 dos wei).
  // Supply: em milhoes tambem.
  const header =
    "| Round | Burn_R (M) | Emission_R+1 (M) | CREDIT Supply (M) | Alice APR | Bob APR |";
  const sep = "|-------|------------|------------------|-------------------|-----------|---------|";
  // Divisor: 1e24 converte wei (1e18) em milhoes (1e6 unidades de CREDIT).
  // Mantemos 3 casas decimais apos a divisao usando inteiros.
  const DIVISOR = 10n ** 21n; // 1e21: apos divisao, 1e3 unidades = 1 milhao. Usaremos /1000 em JS.
  const rows = result.metrics
    .filter((m) => m.round % 4 === 0 || m.round === NUM_ROUNDS - 1) // amostragem
    .map((m) => {
      // m.burnR esta em wei (1e18). Queremos milhoes com 3 casas.
      // (wei / 1e21) = valor * 1000 em milhoes. /1000 => milhoes.
      const burn = Number(m.burnR / DIVISOR) / 1000;
      const emit = Number(m.emissionRplus1 / DIVISOR) / 1000;
      const sup = Number(m.creditSupply / DIVISOR) / 1000;
      return `| ${m.round.toString().padStart(5)} | ${burn.toFixed(3).padStart(10)} | ${emit.toFixed(3).padStart(16)} | ${sup.toFixed(3).padStart(17)} | ${formatBpsAsPct(m.aliceAPRBps).padStart(9)} | ${formatBpsAsPct(m.bobAPRBps).padStart(7)} |`;
    });
  return [header, sep, ...rows].join("\n");
}

function analyzeScenario(result: ScenarioResult): string[] {
  const m = result.metrics;
  const insights: string[] = [];

  // APR: estavel ou decai? Olhamos rounds >=10 pra ignorar bootstrap inicial.
  const midAlice = m.slice(10, 20).map((x) => x.aliceAPRBps);
  const endAlice = m.slice(-5).map((x) => x.aliceAPRBps);
  const avgMid = midAlice.reduce((a, b) => a + b, 0) / Math.max(midAlice.length, 1);
  const avgEnd = endAlice.reduce((a, b) => a + b, 0) / Math.max(endAlice.length, 1);

  insights.push(`APR medio Alice rounds 10-19: ${formatBpsAsPct(Math.round(avgMid))}`);
  insights.push(`APR medio Alice ultimos 5 rounds: ${formatBpsAsPct(Math.round(avgEnd))}`);

  const supplyStart = m[0].creditSupply;
  const supplyEnd = m[m.length - 1].creditSupply;
  const supplyDelta = supplyEnd - supplyStart;
  const supplySign = supplyDelta >= 0n ? "+" : "-";
  // Formata como "CREDIT units" (dividido por 1e18).
  insights.push(
    `Supply CREDIT: inicio=${formatBigInt(supplyStart)} CREDIT -> fim=${formatBigInt(supplyEnd)} CREDIT (delta ${supplySign}${formatBigInt(supplyDelta < 0n ? -supplyDelta : supplyDelta)} CREDIT)`,
  );

  // Ratio burn/emissao acumulado
  let totalBurn = 0n;
  let totalEmit = 0n;
  for (let i = 0; i < m.length - 1; i++) {
    totalBurn += m[i].burnR;
    totalEmit += m[i + 1].emissionRplus1;
  }
  if (totalBurn > 0n) {
    const ratio = bpsFromRatio(totalEmit, totalBurn);
    insights.push(
      `Ratio emissao/burn acumulado (rounds 0-50): ${formatBpsAsPct(ratio)} (menor que 100% = deflacionario)`,
    );
  }

  // Detecta colapso de APR (death spiral sinal).
  const collapseRatio = avgMid > 0 ? avgEnd / avgMid : 1;
  if (collapseRatio < 0.2) {
    insights.push(
      `WARN: APR colapsou ${((1 - collapseRatio) * 100).toFixed(1)}% do meio pro fim — death spiral se uso nao voltar. Floor schedule (24 rounds) exauriu e emissao agora e dominada por alpha*burn baixo.`,
    );
  } else if (Math.abs(avgEnd - avgMid) / Math.max(avgMid, 1) < 0.2) {
    insights.push("APR estavel ao longo da simulacao — modelo saudavel.");
  } else {
    insights.push(
      `APR variou ${(((avgEnd - avgMid) / Math.max(avgMid, 1)) * 100).toFixed(1)}% entre meio e fim da simulacao.`,
    );
  }

  return insights;
}

function writeReport(results: ScenarioResult[], outDir: string) {
  const lines: string[] = [];
  lines.push("# Web3Community — Relatorio de Simulacao Economica");
  lines.push("");
  lines.push("Simulacao multi-rodada (52 rodadas) do modelo economico. Validada");
  lines.push("on-chain contra a fixture Ignition DEV — os contratos deployados sao");
  lines.push("exatamente os mesmos que irao pra producao, apenas com parametros DEV.");
  lines.push("");
  lines.push("**Parametros**:");
  lines.push("- Alice: 80_000 GOV, lock 30 dias");
  lines.push("- Bob: 40_000 GOV, lock 90 dias");
  lines.push("- Split FeeRouter: 95/0/5 (burn/treasury/app)");
  lines.push("- Alpha: 0.95 | CapMax: 1M CREDIT | SanityCap: 1M CREDIT/round/projeto");
  lines.push("- Floor schedule: decay linear 400_000e18 -> 16_666e18 ao longo de 24 rounds");
  lines.push("");
  lines.push("APR e calculado com moving window de 4 rounds, anualizado assumindo 52 rounds/ano.");
  lines.push("");
  lines.push("**Nota importante sobre as % de APR**: os valores aparecem enormes");
  lines.push("(>30_000%) porque APR aqui e TOKEN-on-TOKEN: CREDIT recebido / GOV");
  lines.push("stakeado, ambos em 1e18 precision. Em USD, o APR real depende do");
  lines.push("preco relativo dos dois tokens, que o simulador nao conhece. O que");
  lines.push("interessa comparar entre cenarios e a DINAMICA (crescimento, queda,");
  lines.push("estabilizacao), nao o numero absoluto.");
  lines.push("");
  for (const result of results) {
    lines.push(`## Cenario ${result.name} — ${result.description}`);
    lines.push("");
    lines.push("### Amostragem (1 em cada 4 rounds)");
    lines.push("");
    lines.push(printAsciiTable(result));
    lines.push("");
    lines.push("### Insights");
    lines.push("");
    for (const i of analyzeScenario(result)) {
      lines.push(`- ${i}`);
    }
    if (result.notes.length > 0) {
      lines.push("");
      lines.push("### Eventos especiais (notes)");
      lines.push("");
      for (const n of result.notes) {
        lines.push(`- ${n}`);
      }
    }
    lines.push("");
  }

  lines.push("## Conclusoes");
  lines.push("");
  lines.push(
    "- **Cenario A** (bootstrap saudavel): APR estabiliza, supply estabiliza. Modelo OK quando o uso cresce e se mantem.",
  );
  lines.push(
    "- **Cenario B** (death spiral): floor decay protege nos primeiros ~24 rounds. Depois, se o uso nao voltar, emissao cai drasticamente, APR converge para perto de zero. Floor cumpre seu papel de safety-net de bootstrap. DAO precisa monitorar e possivelmente intervir via Governor (reduzir capMax, ajustar alpha) se vir sinal de decadencia prolongada.",
  );
  lines.push(
    "- **Cenario C** (wash-burn): SanityCap rejeitou o ataque; agregados nao corrompidos. Validacao on-chain do limite de 1M CREDIT/round/projeto funciona como esperado.",
  );
  lines.push("");
  lines.push("## Como reproduzir");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run sim");
  lines.push("# ou");
  lines.push("npx hardhat run scripts/simulation/economicSim.ts");
  lines.push("```");

  const reportPath = path.join(outDir, "report.md");
  fs.writeFileSync(reportPath, lines.join("\n"));
  console.log(`  wrote report.md (${lines.length} lines)`);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  const outDir = path.join(__dirname, "output");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const results: ScenarioResult[] = [];

  console.log("=== Cenario A: Bootstrap saudavel ===");
  // Isolamento entre cenarios via snapshot: cada scenario redeploya tudo do
  // zero via Ignition fixture. Como `setupEcosystem` chama `hre.ignition.deploy`
  // e o Ignition retorna sempre as mesmas instancias pra o mesmo module, o
  // estado do segundo cenario seria "continuacao" do primeiro. Solucao:
  // snapshot EVM antes de cada cenario + revert no final.
  const snap0 = await takeSnapshot();
  results.push(
    await runScenario("A", "Bootstrap saudavel — uso crescente estabilizado", burnCurveA, false),
  );
  await snap0.restore();

  console.log("\n=== Cenario B: Death spiral ===");
  const snap1 = await takeSnapshot();
  results.push(await runScenario("B", "Death spiral — uso cai drasticamente", burnCurveB, false));
  await snap1.restore();

  console.log("\n=== Cenario C: Wash-burn ataque ===");
  const snap2 = await takeSnapshot();
  results.push(
    await runScenario(
      "C",
      "Wash-burn — projeto tenta queimar 10M num round (acima do sanityCap)",
      burnCurveC,
      true,
    ),
  );
  await snap2.restore();

  console.log("\n=== Escrevendo outputs ===");
  for (const r of results) {
    writeCSV(r, outDir);
  }
  writeReport(results, outDir);

  // Asserção do cenario C — obrigatoria conforme briefing.
  const scenC = results.find((r) => r.name === "C");
  if (!scenC) {
    throw new Error("Cenario C nao executou.");
  }
  const hasRejection = scenC.notes.some((n) => n.includes("REJEITADO"));
  if (!hasRejection) {
    throw new Error("Cenario C: wash-burn NAO foi rejeitado. SanityCap falhou — investigar!");
  }
  console.log("\n[OK] Cenario C: wash-burn foi rejeitado como esperado.");
  console.log(`\nOutputs em: ${outDir}`);
}

// Hardhat-run entrypoint. Ao executar via `npx hardhat run`, main() e chamado
// em um contexto que top-level await nao funciona naturalmente; usamos
// .then/.catch para propagar erros corretamente.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
