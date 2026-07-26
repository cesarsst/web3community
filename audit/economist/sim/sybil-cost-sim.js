#!/usr/bin/env node
/*
 * sybil-cost-sim.js — custo real de contornar as mitigações com N carteiras.
 *
 * Pergunta do user: bloquear só o owner basta? Se o atacante usar OUTRAS
 * carteiras (pagando a taxa extra), qual o custo real e compensa?
 *
 * Modela 3 cenários sob cada defesa proposta:
 *   D0 = hoje (nenhuma defesa): 2 endereços, loop livre
 *   D1 = anti-self-payment (bloqueia owner/appRecipient como pagador)
 *   D2 = uniquePayersOf (painel mostra pagadores distintos, não soma bruta)
 *   D3 = GMV com decaimento/janela (volume precisa ser contínuo)
 *
 * Custos por carteira sybil (parâmetros conferidos no código 2026-07-10):
 *   fee por ciclo de wash = 2,5% do amount washeado (FeeRouterV2)
 *   float travado por carteira = precisa segurar CREDIT p/ pagar (recuperável)
 *   gate de stake p/ investir/sacar = precisa de GOV travado por carteira (D-invest)
 */

const FEE = 0.025;      // 2,5% taxa do FeeRouterV2
const BUYBACK = 0.40;   // 40% da fee vai a buyback

// Custo de setup por carteira sybil (estimativas de mercado, ajustáveis):
const GAS_PER_WALLET = 0;        // L2 barato; ignorado (parecer trata como desprezível)
const CREDIT_FLOAT_APR = 0.05;   // custo de oportunidade do CREDIT parado (5% a.a. em USDC yield)

// Cenário-alvo do atacante: quer que o painel mostre um app "com tração"
// convincente o suficiente p/ atrair um investidor de fora com ticket V_vitima.
function scenario({ washVolume, nWallets, holdDays, govPerWallet, credInUSD }) {
  // custo direto: taxa sobre TODO volume washeado (independe de nWallets)
  const feeCost = washVolume * FEE;
  const buybackRecovered = govPerWallet > 0 ? 0 : 0; // simplificação: assume govShare=0 (pior p/ defensor)
  // custo de oportunidade do float travado durante a farsa
  const floatUSD = credInUSD; // CREDIT parado p/ rodar os ciclos
  const floatCost = floatUSD * CREDIT_FLOAT_APR * (holdDays / 365);
  // custo do GOV travado por carteira (se a defesa exige stake p/ parecer investidor)
  // GOV não é recuperável imediato — lock mínimo 14d; custo = oportunidade + risco de preço
  const govLockedUSD = nWallets * govPerWallet;
  const govOppCost = govLockedUSD * 0.15 * (Math.max(holdDays, 14) / 365); // 15% a.a. custo de carregar GOV
  const total = feeCost + floatCost + govOppCost - buybackRecovered;
  return { feeCost, floatCost, govOppCost, total, govLockedUSD, floatUSD };
}

function fmt(x) { return '$' + Math.round(x).toLocaleString(); }
function pctOf(cost, vol) { return (100 * cost / vol).toFixed(2) + '%'; }

console.log('Objetivo do atacante: forjar um app "com tração" p/ atrair 1 investidor externo.\n');
console.log('Suposição: p/ convencer, precisa mostrar ~$100k de GMV e receita distribuída.\n');
const WASH = 100000; // $100k de volume falso a exibir

console.log('=== D0 — HOJE (sem defesa): 2 carteiras, loop livre ===');
{
  const s = scenario({ washVolume: WASH, nWallets: 2, holdDays: 7, govPerWallet: 0, credInUSD: 5000 });
  console.log(`  taxa: ${fmt(s.feeCost)} | float: ${fmt(s.floatCost)} | total: ${fmt(s.total)} (${pctOf(s.total, WASH)} do volume)`);
  console.log('  → trivial. custo ~ só a taxa.\n');
}

console.log('=== D1 — anti-self-payment (bloqueia OWNER como pagador) ===');
console.log('  Pergunta do user: basta? NÃO por si só. Atacante troca pra 2ª carteira "cliente".');
{
  // agora precisa de pelo menos 1 carteira separada do owner. Ainda 2 endereços no total.
  const s = scenario({ washVolume: WASH, nWallets: 2, holdDays: 7, govPerWallet: 0, credInUSD: 5000 });
  console.log(`  custo: ${fmt(s.total)} (${pctOf(s.total, WASH)}). MESMO que D0 — só trocou de bolso.`);
  console.log('  → D1 sozinho NÃO resolve. Só impede o caso mais preguiçoso.\n');
}

console.log('=== D2 — uniquePayersOf (painel mostra PAGADORES DISTINTOS) ===');
console.log('  Agora o sinal exige N carteiras distintas com CREDIT real. Aqui muda o jogo.');
for (const N of [10, 50, 200]) {
  // p/ parecer N clientes distintos, cada carteira precisa de float próprio.
  // float total ~ washVolume distribuído; cada carteira segura credInUSD/N.
  const perWalletFloat = 5000; // cada "cliente" convincente segura algum saldo
  const s = scenario({ washVolume: WASH, nWallets: N, holdDays: 30, govPerWallet: 0, credInUSD: N * perWalletFloat * 0.2 });
  console.log(`  N=${String(N).padStart(3)} carteiras: taxa ${fmt(s.feeCost)} + float ${fmt(s.floatCost)} = ${fmt(s.total)} (${pctOf(s.total, WASH)})`);
}
console.log('  → custo direto ainda dominado pela taxa (2,5%), MAS: gerir 200 carteiras críveis');
console.log('    (idade, histórico, distribuição temporal) é caro em trabalho, não em $. Sinal fica caro de FALSIFICAR de forma crível.\n');

console.log('=== D2+invest-gate — sybil TAMBÉM precisa parecer N investidores ===');
console.log('  Se a defesa exige stake real por investidor (caso 02), cada carteira trava GOV.');
for (const [N, govUSD] of [[10, 500], [50, 500], [200, 500]]) {
  const s = scenario({ washVolume: WASH, nWallets: N, holdDays: 30, govPerWallet: govUSD, credInUSD: N * 1000 });
  console.log(`  N=${String(N).padStart(3)} × $${govUSD} GOV travado: GOV lock ${fmt(s.govLockedUSD)} | custo total ${fmt(s.total)} (${pctOf(s.total, WASH)})`);
}
console.log('  → agora o atacante trava CAPITAL REAL em GOV (sujeito a preço + lock 14d).');
console.log('    $100 travado × 200 = $100k de GOV imobilizado. O disfarce fica caro de verdade.\n');

console.log('=== VEREDITO: compensa? ===');
console.log('  Compensa SE (ganho com a vítima) > (custo do disfarce).');
console.log('  D0/D1: custo ~$2.500 (2,5%) p/ forjar $100k. Se a vítima aporta >$2.500, compensa. → SIM, fácil.');
console.log('  D2: custo direto igual, mas exige N carteiras críveis — barreira de TRABALHO, não de taxa.');
console.log('  D2 + invest-gate + GMV-decay: atacante trava ~$100k de GOV real + precisa volume CONTÍNUO.');
console.log('    O disfarce passa a custar quase tanto quanto o capital que tenta atrair. → deixa de compensar.');
