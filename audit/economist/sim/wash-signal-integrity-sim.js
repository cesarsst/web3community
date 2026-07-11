#!/usr/bin/env node
/*
 * wash-signal-integrity-sim.js
 * Parecer 2026-07-10 — integridade de sinal do FeeRouterV2 sob wash-payment.
 *
 * Quantifica o custo por ciclo e o custo total para um atacante que controla
 * app + pagador (+ stake) e usa pay() circular para falsificar os 3 sinais
 * economicos do protocolo: GMV (grossVolumeOf), pressao de buyback (GOV) e
 * rev-share acumulado (accRevenuePerShare).
 *
 * Parametros conferidos no codigo/deploy em 2026-07-10:
 *   feeBps        = 250   (2,5%)   contracts/FeeRouterV2.sol + ignition/parameters/production.json
 *   FEE_BPS_CAP   = 500   (5%)     contracts/FeeRouterV2.sol:69
 *   split         = 40/40/20       treasury/buyback/grants (Dao.ts feeBuybackBps=4000)
 *   revShareBps   in [100, 3000]   contracts/ProjectFunding.sol:98-99
 *
 * Rodar: node audit/economist/sim/wash-signal-integrity-sim.js
 */

const BPS = 10_000;
const FEE_BPS = 250; // 2,5%
const SPLIT = { treasuryBps: 4000, buybackBps: 4000, grantsBps: 2000 };

// Reparte um pay(amount) exatamente como FeeRouterV2.pay (conservacao).
function splitPay(amount, revShareBps) {
  const fee = Math.floor((amount * FEE_BPS) / BPS);
  const toTreasury = Math.floor((fee * SPLIT.treasuryBps) / BPS);
  const toBuyback = Math.floor((fee * SPLIT.buybackBps) / BPS);
  const toGrants = fee - toTreasury - toBuyback;
  const revShare = Math.floor((amount * revShareBps) / BPS);
  const toApp = amount - fee - revShare;
  return { fee, toTreasury, toBuyback, toGrants, revShare, toApp };
}

// Custo liquido de UM ciclo de wash para um atacante que:
//  - paga (perde `amount`, recupera toApp como app),
//  - recupera revShare via claim se controla 100% das shares do projeto,
//  - "perde" apenas o que sai para maos de terceiros: treasury + grants + (buyback - fracao_gov_propria).
// govShare = fracao do buyback que retorna ao atacante como holder de GOV (0..1).
function washCycleCost(amount, revShareBps, govShare = 0, sharesSelf = 1) {
  const s = splitPay(amount, revShareBps);
  const recoveredApp = s.toApp; // atacante e o appRecipient
  const recoveredRev = Math.floor(s.revShare * sharesSelf); // claim pro-rata das proprias shares
  const recoveredBuyback = Math.floor(s.toBuyback * govShare); // buyback que pressiona o proprio bag
  const injected = amount;
  const recovered = recoveredApp + recoveredRev + recoveredBuyback;
  return { ...s, injected, recovered, netCost: injected - recovered };
}

function pct(x) { return (x * 100).toFixed(2) + '%'; }

console.log('=== Custo por ciclo de wash (por 1.000 CREDIT roteados) ===\n');
const A = 1000;
for (const rev of [0, 800, 3000]) {
  console.log(`revShareBps=${rev} (${rev / 100}%)`);
  for (const gov of [0, 0.30, 1.0]) {
    const c = washCycleCost(A, rev, gov, 1);
    console.log(
      `  govShare=${(gov * 100).toFixed(0).padStart(3)}%  ` +
      `netCost=${String(c.netCost).padStart(4)} CREDIT  ` +
      `(${pct(c.netCost / A)} do volume washeado)`
    );
  }
  console.log();
}

console.log('=== Sinal comprado por um dado orcamento de wash ===\n');
// Quanto de GMV falso e de rev-share falso um atacante compra gastando um
// orcamento fixo de fee (o unico custo real quando ele controla tudo, govShare>0
// so reduz). Caso pessimista para o defensor: govShare=0, so a fee sangra.
for (const budget of [100, 1000, 10000]) {
  // netCost por ciclo (govShare=0, rev=0) = fee = 2,5% do amount.
  // Com orcamento `budget` de fee, o atacante rota GMV = budget / 0.025.
  const gmvFake = budget / (FEE_BPS / BPS);
  const buybackFake = gmvFake * (FEE_BPS / BPS) * (SPLIT.buybackBps / BPS);
  console.log(
    `orcamento de fee=${String(budget).padStart(6)} CREDIT  ->  ` +
    `GMV falso=${gmvFake.toLocaleString()} CREDIT  ` +
    `buyback falso=${buybackFake.toLocaleString()} CREDIT`
  );
}

console.log('\n=== Auto-rodada: atacante financia a propria rodada ===\n');
// Atacante staka GOV, abre rodada (target T, revShareBps R), investe T sozinho
// (100% das shares), bate alvo -> _fund manda T ao proprio owner. Depois wash
// para gerar rev-share, que ele saca 100% via claim. O gate de GOV nao impede
// self-stake nem self-invest.
const T = 100; // minTarget = 100 CREDIT
console.log(`target minimo=${T} CREDIT, atacante detem 100% das shares.`);
console.log('Fluxo:');
console.log('  1. stake(projectId, GOV, lock>=14d)      -> getWeight>0 (gate aberto)');
console.log('  2. openRound(target=100, revShareBps=3000, dur)');
console.log('  3. invest(projectId, 100)                -> raised==target -> _fund: 100 volta ao owner');
console.log('  4. wash pay() -> revShare -> notifyRevenue -> accRevenuePerShare sobe');
console.log('  5. claim(projectId)                      -> saca 100% (unica share)');
console.log('  => "rodada financiada + rev-share ativo" e 100% autoinfligido; custo = fee dos ciclos.');
