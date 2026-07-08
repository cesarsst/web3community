# Parecer econômico: incentivo de bypass do FeeRouter

**Modo**: B (falha de incentivo em mecanismo existente)
**Data**: 2026-07-08
**Analista**: dao-economist (análise assistida, simulação numérica reproduzível)
**Escopo**: por que um app racional rotearia pagamentos via `FeeRouter.pay`
(ficando com ~10% imediato) em vez de simplesmente receber `CREDIT.transfer`
direto (ficando com 100%)? Quantificação do gap, teoria dos jogos do
free-riding, e alavancas de correção. Gap identificado pelo user em 2026-07-08;
não coberto pelos pareceres anteriores (CLP pivot, credit-peg, pol-params
tratam wash-burn e mercenary capital, não evasão de roteamento).

---

## 1. Resumo executivo

**O gap é real e é estrutural.** Com os parâmetros vigentes (split
70/20/10, buckets 55/25/15/5, α = 0.95), rotear via FeeRouter devolve ao
owner do app entre **~20% e ~57%** do pagamento (dependendo de quanto do
stake do próprio projeto ele detém), contra **100%** na transferência
direta. Não existe mecanismo on-chain que impeça ou puna o bypass. Burlar
é **estratégia dominante** no jogo entre projetos: o equilíbrio de Nash sem
enforcement é burn → 0, emissão → floor → 0, e morte do flywheel.

**Veredito**: o FeeRouter como está só funciona se rotear for **condição de
acesso a benefícios que o app valoriza mais do que os ~80% de taxa efetiva**
— ou se a taxa cair. Quatro alavancas em §5, das quais duas já existem no
código (`setProjectSplit`, entitlement por evento `pay`) e precisam apenas
de política; duas são mudanças de desenho.

---

## 2. Mecânica relevante (verificada no código e on-chain)

- `FeeRouter.pay(projectId, amount)`: 70% queimado via
  `BurnTracker.burnAndRecord` (registra burn **por projeto**), 20% Treasury,
  10% `appRecipient`. Split default confirmado on-chain: `(7000, 2000, 1000)`.
- `RewardDistributorV2.finalizeRound(r)`: emissão
  `min(max(α·burn_{r-1}, floor(r)), capMax)` com α = 0.95, capMax = 5M.
  Split em buckets `(5500, 2500, 1500, 500)` = stakers/LPs/apps/bonders.
- Alocação dos buckets **apps** e **stakers** é pro-rata ao *burn share* do
  projeto na rodada anterior (`_emitAppsBucket`, `_projectStakerShare`).
  **Projeto sem burn registrado recebe 0 e seus stakers recebem 0.**
- Nada no stack impede um app de receber `CREDIT.transfer` direto. O burn
  por projeto é o único vínculo entre uso e recompensa — e é opt-in do app.

## 3. Simulação numérica

Preço de referência: 1 CREDIT = 1 USDC (oracle dev). Steady state: volume
constante V por rodada; emissão da rodada r consome burn da r-1; projeto
único (burn share 100% — melhor caso possível para o app honesto).

### 3.1 Captura do owner por 100 CREDIT roteados

Emissão induzida: 0.95 × 70 = 66.5 por 100 pagos.

| Estratégia do owner | Rebate | Bucket apps (15%) | Self-stake (bucket stakers, 55%) | Total |
| ------------------- | ------ | ----------------- | -------------------------------- | ----- |
| Só roteia | 10.0 | ~9.98 | 0 | **~20.0** |
| Detém 30% do stake do projeto | 10.0 | ~9.98 | ~10.97 | **~30.9** |
| Detém 100% do stake (limite teórico) | 10.0 | ~9.98 | ~36.58 | **~56.6** |

Destino completo dos 100: burn 70 · treasury 20 · rebate 10; emissão 66.5 →
stakers 36.6 · LPs 16.6 · apps 10.0 · bonders 3.3. Deflação líquida: 3.5.

### 3.2 Comparação com modelos de pagamento (app com US$ 10k/mês)

| Modelo | App líquido | Taxa efetiva |
| ------ | ----------- | ------------ |
| Stripe (2.9% + $0.30, 200 tx de $50) | $9.650 | ~3.8% |
| `CREDIT.transfer` direto | $10.000 | 0% |
| FeeRouter, sem self-stake | $1.998 | **~80%** |
| FeeRouter, 30% self-stake | $3.095 | ~69% |
| FeeRouter, 100% self-stake | $5.655 | ~43% |

Para líquido igual ao Stripe, o app precisa cobrar **1.7×–4.8×** mais caro
via FeeRouter. A comparação honesta não é com processador (3%), é com app
store (Apple/Google 15–30%) — e mesmo contra app store a taxa efetiva de
~69–80% não é competitiva por si só.

### 3.3 Free-riding entre projetos

Dois projetos, 10k/rodada cada; A roteia, B recebe transfer direto:

| | Owner recebe/rodada | Stakers do projeto recebem |
| - | ------------------- | -------------------------- |
| A (FeeRouter) | ~$1.998 | ~$3.658 |
| B (bypass) | $10.000 | 0 |

B ganha **5×** mais que A e ainda captura a deflação que A financia
(free-riding sobre o burn alheio). Único custo endógeno de B: não atrair
stakers (perde vitrine/apoio) — custo fraco comparado a 5× de receita.

### 3.4 Cenário de colapso

Se todos os projetos burlam: burn = 0 → emissão = floor (que expira no
schedule) → stakers e LPs sem renda → staking de GOV perde função econômica
→ deflação para → tese do CREDIT morre. **Dilema do prisioneiro com
equilíbrio no colapso.** A cooperação (todos roteiam) não é sustentável sem
enforcement porque a defecção unilateral sempre paga mais.

## 4. Por que os mitigadores atuais não bastam

1. **Entitlement via evento `pay`** (cloud-terminal valida ativação assim):
   protege contra o **usuário** burlar o app; não protege contra o **owner**
   decidir cobrar por fora — e é o owner quem escolhe o modelo de cobrança.
2. **Atração de stakers**: stakers rendem ao projeto visibilidade e apoio de
   governança, mas o valor monetário disso para o owner (§3.1: no máximo
   +36.6 por 100, e só com auto-stake total) não cobre o gap para 100.
3. **Detecção social**: transfers ao endereço do app sem evento `pay`
   correspondente são visíveis on-chain, mas hoje não há consequência
   codificada nem processo de governança definido para punir.

## 5. Alavancas de correção (recomendação)

Em ordem de custo de implementação:

1. **Política de registro com dente** (só governança, sem código novo):
   colateral do `ProjectRegistry` proporcional ao volume esperado + processo
   formal de remoção/slash por bypass detectado. Transforma a detecção
   social do §4.3 em custo esperado real. Limite: exige vigilância ativa e
   colateral alto o suficiente pra morder — colateral fixo baixo não
   dissuade app com $10k/mês.
2. **`setProjectSplit` como instrumento comercial** (já existe no contrato):
   split individual negociado por governança para apps de volume — ex.
   `(3000, 1000, 6000)` reduz a taxa efetiva de ~80% para ~35% (owner ~65%
   somando kickbacks de emissão). Enquadra o FeeRouter como taxa de app
   store negociável em vez de confisco. Custo: menos burn por CREDIT de
   volume — compensável se o split baixo destravar volume que hoje nem entra.
3. **Inverter quem paga a taxa** (mudança de desenho, proposta para
   discussão): burn como *network fee* do usuário sobre o preço do app
   (modelo gas), não fatia da receita. App cobra 100 e fica com ~100; o
   protocolo adiciona ex. 10–15 de fee queimada/treasury por cima. Owner
   alinhado, burn preservado (menor por transação, mas com adesão
   estrutural), e a comparação com Stripe fica em ~0% para o app e ~10–15%
   de "taxa de rede" para o usuário — narrativa muito mais vendável.
   Interage com o pivot CLP (o gauge prospectivo reduz a dependência do
   burn retrospectivo como âncora única).
4. **Gating on-chain do produto** (custo alto, caso a caso): serviços cujo
   *provisionamento* depende de estado on-chain criado exclusivamente pelo
   `pay` (créditos de uso mintados pelo FeeRouter, assinatura NFT emitida no
   `pay`). Elimina o bypass por construção onde couber — não generaliza
   para todo tipo de app.

**Recomendação executiva**: aplicar (1) + (2) imediatamente como política;
levar (3) à discussão do pivot CLP como red flag adicional — o parecer
2026-04-24 assume burn real como âncora do flywheel (§3, §9) sem tratar a
adesão ao roteamento como variável endógena. Qualquer projeção de burn que
ignore o incentivo de bypass superestima a emissão sustentável.

## 6. Limitações da simulação

- Preço CREDIT/USDC fixo em 1:1; não modela apreciação por deflação (que
  beneficia holders difusamente, não o owner marginal — não muda a ordem
  das estratégias).
- `capMax` (5M) e `floor` tratados como não-vinculantes nos volumes
  simulados.
- Projeto honesto modelado com burn share 100% (melhor caso); com N
  projetos honestos o kickback individual cai proporcionalmente.
- Script reproduzível da simulação: `sim/feerouter-bypass-sim.js`
  (`node audit/economist/sim/feerouter-bypass-sim.js`; parâmetros conferidos
  on-chain no deploy local em 2026-07-08).
