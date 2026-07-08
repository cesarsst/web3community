// Simulação: FeeRouter vs transferência direta vs Stripe
// Parâmetros = valores vivos do deploy local (verificados on-chain):
//   FeeRouter split: 70% burn / 20% treasury / 10% rebate app
//   Buckets V2:      55% stakers / 25% LPs / 15% apps / 5% bonders
//   alpha = 0.95, capMax = 5M (não-vinculante nos volumes simulados)
//   Preço dev: 1 CREDIT = 1 USDC
// Alocação (do contrato): apps bucket e stakers bucket são pro-rata
//   ao burn share do projeto na rodada anterior. Projeto sem burn = 0.

const SPLIT = { burn: 0.70, treasury: 0.20, rebate: 0.10 };
const BUCKETS = { stakers: 0.55, lps: 0.25, apps: 0.15, bonders: 0.05 };
const ALPHA = 0.95;

// ————— Cenário 1: fluxo de 100 CREDIT de um único projeto (steady state) —————
// Steady state: mesmo volume V toda rodada; emissão da rodada r usa burn da r-1.
function steadyStatePer100(selfStakeShare) {
  const V = 100;
  const burn = V * SPLIT.burn;                    // 70
  const emission = ALPHA * burn;                  // 66.5 (única fonte de burn)
  const owner = {
    rebate: V * SPLIT.rebate,                     // 10 na hora
    appsBucket: emission * BUCKETS.apps,          // burn share = 100%
    selfStake: emission * BUCKETS.stakers * selfStakeShare,
  };
  return {
    userPaga: V,
    queimado: burn,
    treasury: V * SPLIT.treasury,
    emissaoTotal: emission,
    stakersTotal: emission * BUCKETS.stakers,
    lps: emission * BUCKETS.lps,
    bonders: emission * BUCKETS.bonders,
    ownerImediato: owner.rebate,
    ownerAppsBucket: owner.appsBucket,
    ownerSelfStake: owner.selfStake,
    ownerTotal: owner.rebate + owner.appsBucket + owner.selfStake,
    deflacaoLiquida: burn - emission,
  };
}

console.log("═══ 1. Steady state: 100 CREDIT via FeeRouter, projeto único ═══");
for (const ss of [0, 0.3, 1.0]) {
  const r = steadyStatePer100(ss);
  console.log(`\n— owner com ${ss * 100}% do stake do próprio projeto —`);
  console.log(`  Owner recebe: ${r.ownerImediato} (rebate) + ${r.ownerAppsBucket.toFixed(2)} (bucket apps) + ${r.ownerSelfStake.toFixed(2)} (self-stake) = ${r.ownerTotal.toFixed(2)} / 100`);
}
const base = steadyStatePer100(0);
console.log(`\n  Por 100 pagos: burn 70 | treasury 20 | emissão 66.5 → stakers ${base.stakersTotal.toFixed(1)} · LPs ${base.lps.toFixed(1)} · apps ${base.ownerAppsBucket.toFixed(1)} · bonders ${base.bonders.toFixed(1)}`);
console.log(`  Deflação líquida por 100: ${base.deflacaoLiquida.toFixed(1)} CREDIT`);

// ————— Cenário 2: comparação de modelos, app com US$ 10k/mês —————
console.log("\n═══ 2. App com US$ 10.000/mês de volume (1 CREDIT = 1 USDC) ═══");
const VOL = 10_000;
const stripe = VOL - (VOL * 0.029 + 0.30 * 200);  // 200 tx de $50
const direct = VOL;                                // transfer direto: fica com tudo
const fr0 = steadyStatePer100(0);
const fr30 = steadyStatePer100(0.3);
const fr100 = steadyStatePer100(1.0);
console.log(`  Stripe (2.9% + $0.30 × 200tx):   app líquido $${stripe.toFixed(0)}  (~96.2%)`);
console.log(`  Transfer direto de CREDIT:        app líquido $${direct}  (100%)`);
console.log(`  FeeRouter, sem self-stake:        app líquido $${(VOL * fr0.ownerTotal / 100).toFixed(0)}  (${fr0.ownerTotal.toFixed(1)}%)`);
console.log(`  FeeRouter, 30% self-stake:        app líquido $${(VOL * fr30.ownerTotal / 100).toFixed(0)}  (${fr30.ownerTotal.toFixed(1)}%)`);
console.log(`  FeeRouter, 100% self-stake:       app líquido $${(VOL * fr100.ownerTotal / 100).toFixed(0)}  (${fr100.ownerTotal.toFixed(1)}%)`);
console.log(`\n  Preço equivalente pra igualar Stripe ($${stripe.toFixed(0)}):`);
console.log(`    sem self-stake:  cobrar ${(stripe / (VOL * fr0.ownerTotal / 100) * 100).toFixed(0)}% a mais (×${(stripe / (VOL * fr0.ownerTotal / 100)).toFixed(2)})`);
console.log(`    30% self-stake:  ×${(stripe / (VOL * fr30.ownerTotal / 100)).toFixed(2)}`);
console.log(`    100% self-stake: ×${(stripe / (VOL * fr100.ownerTotal / 100)).toFixed(2)}`);

// ————— Cenário 3: dois projetos, um honesto e um que burla —————
console.log("\n═══ 3. Dois projetos, mesmo volume (10k/rodada cada) ═══");
function twoProjects(honestVol, bypassVol) {
  // só o volume honesto gera burn
  const burnA = honestVol * SPLIT.burn;
  const burnTotal = burnA; // bypass não registra burn
  const emission = ALPHA * burnTotal;
  const shareA = burnTotal > 0 ? burnA / burnTotal : 0; // 100%
  return {
    honesto: {
      imediato: honestVol * SPLIT.rebate,
      apps: emission * BUCKETS.apps * shareA,
      stakersDoProjeto: emission * BUCKETS.stakers * shareA,
    },
    burla: { imediato: bypassVol, apps: 0, stakersDoProjeto: 0 },
    emission,
  };
}
const t = twoProjects(VOL, VOL);
console.log(`  Projeto A (FeeRouter): owner ${(t.honesto.imediato + t.honesto.apps).toFixed(0)} + stakers dele ganham ${t.honesto.stakersDoProjeto.toFixed(0)}`);
console.log(`  Projeto B (transfer):  owner ${t.burla.imediato} + stakers dele ganham 0`);
console.log(`  → B ganha ${(t.burla.imediato / (t.honesto.imediato + t.honesto.apps)).toFixed(1)}× mais que A por rodada, de graça.`);

// ————— Cenário 4: todos burlam (colapso do flywheel) —————
console.log("\n═══ 4. Todos os projetos burlam ═══");
console.log("  burn = 0 → emissão = max(0.95×0, floor) = floor (e floor acaba no schedule)");
console.log("  → stakers ganham 0, LPs ganham 0, staking de GOV perde sentido,");
console.log("    deflação para, tese do token morre. Free-riding é dominante e o equilíbrio é o colapso.");
