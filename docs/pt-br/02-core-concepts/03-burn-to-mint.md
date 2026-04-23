# Burn-to-mint

**Para quem é:** quem quer entender como o protocolo sustenta emissão sem virar Ponzi.
**Pré-requisitos:** [Dual-token](01-dual-token-economy.md).

## A fórmula

```
emissao_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Definida em `RewardDistributor.finalizeRound`. Três camadas:

1. **`alpha * burn_{R-1}`** — base econômica. Em produção `alpha = 0.95`, ou seja, emite-se 95% do que foi queimado na rodada anterior. Se ninguém queimou nada, esse termo é zero.
2. **`max(..., floor(R))`** — garante piso mínimo durante o bootstrap. O `floorSchedule` tem 24 entradas. Rodadas >= 24 não têm floor. Em produção, o floor cai linearmente de 400k CREDIT (rodada 0) a ~16.666 CREDIT (rodada 23).
3. **`min(..., capMax)`** — teto duro. Em produção `capMax = 5.000.000 CREDIT`. Ajustável via governança dentro de `[1, 100M] CREDIT`.

## Por que `alpha < 1` (levemente deflacionário)

O sistema é projetado para que **emissão total < burn total** se o uso se mantiver constante. Intuição:

- Rodada R-1: usuários queimaram 1.000.000 CREDIT.
- Rodada R: emitimos 950.000 CREDIT.
- Saldo líquido de supply: -50.000 CREDIT.

Ao longo de muitas rodadas, o supply cai lentamente. Se a demanda por CREDIT se mantiver, essa queda de oferta se traduz em apreciação unitária — que é o prêmio para quem retém.

**Simulação**: o repositório tem em `scripts/simulation/` uma simulação de 52 rodadas em 3 cenários. No cenário "base" (uso constante), supply cai ~3.8% nas 52 rodadas.

> **Nota — escopo da simulação.** Esse ~3.8% vem de um cenário **hipotético** com supply inflado (70.4M CREDIT inicial, via `Charlie_seed = 60M` em `scripts/simulation/economicSim.ts:72`) e 1M burn/round constante. Em mainnet o supply operacional **começa em 10M** (genesis real de `mintGenesis`). Os valores absolutos (−3.8%, APR ~34%) são **ilustrativos do comportamento qualitativo** (deflação sustentada com uso constante), não promessa sobre mainnet. O comportamento qualitativo permanece: se `burn_R ≈ constante` e `alpha < 1`, `supply` cai linearmente em `(1 - alpha) * burn_R` por rodada.

## O papel do floor

Na rodada 0, `burn_{-1}` não existe (considerado 0). Sem floor, a emissão seria 0 — stakers não teriam incentivo para entrar. O floor existe só para o bootstrap: **"até o ecossistema começar a gerar burn orgânico, a DAO banca uma emissão mínima"**.

Após 24 rodadas (em produção, 24 × 7 dias = **~168 dias ≈ 5.5 meses**), o floor zera. Daí em diante, **só há emissão se houve burn**. Se o protocolo não decolou nessa janela, a emissão natural cai a zero — o que é o sinal correto para a DAO intervir ou para os apoiadores reavaliarem.

### Limitação operacional — rodada sem staker global

Se o protocolo **começar sem stakers** (ou seja, `globalWeight == 0`) e também sem burn, a fórmula calcula a emissão corretamente (via floor), mas **nenhum claim funciona** — o share de cada projeto no caminho bootstrap é `emissao * projectWeight / globalWeight`, que com `globalWeight == 0` retorna 0. Resultado: o CREDIT **nunca é cunhado** para essa rodada. Não é bug, é no-op seguro — o pool simplesmente não é alocado. **A DAO precisa coordenar stakers iniciais antes do round 0** para que o floor de bootstrap seja efetivamente aproveitado.

### Limitação operacional — `closeRound` depende da DAO

`BurnTracker.closeRound` é governance-gated (`GOVERNANCE_ROLE`, hoje detido apenas pelo Timelock). Se a DAO ficar inativa, **a rodada não fecha e a emissão congela** — stakers esperam "1 rodada = 7 dias" mas na realidade é "1 rodada = quando a DAO decidir". `isRoundReadyToClose` é apenas consultivo. Recomendação: a DAO deve configurar um keeper externo (Gelato / Chainlink Automation / multisig operacional com `CANCELLER_ROLE` limitado) para chamar `closeRound` via proposta periódica — previsto como melhoria para v2.

## O papel do cap

O `capMax` existe como salvaguarda contra uma explosão de burn (seja genuína ou artificial). Mesmo se alguém queimasse 10 bilhões de CREDIT numa rodada, a emissão seria clampada em `capMax` (5M em produção).

## A proteção multicamada contra ataques de burn

Além do `capMax` da emissão total, há o **sanity cap por `(rodada, projectId)`** no `BurnTracker` (default 10M CREDIT em produção):

```
se burn acumulado do projeto na rodada + novo burn > maxBurnPerRoundPerProject:
    revert SanityCapExceeded
```

Isso impede que **um projeto malicioso queime volume absurdo para capturar share desproporcional** dentro de uma rodada. Mesmo que o atacante queimasse abaixo do sanity cap mas acima da sua proporção de uso real, o `capMax` da emissão total limita o impacto sobre o supply global.

## O papel da probation

Todo projeto recém-ativado entra em probation inicial por tempo (`probationDuration`, 30 dias em produção). Enquanto `block.timestamp < probationEndsAt`:

```
se RewardDistributor detecta isInProbation(projectId):
    projectShare = projectShare / PROBATION_PENALTY_DENOM   // = /4
```

Ou seja, **o projeto recebe só 25% da sua share de emissão**. Os outros 75% **nunca são mintados** — não são redistribuídos e não há `_burn` do token envolvido. "Queimar" em tokenomics usualmente significa `_burn` sobre `totalSupply` já existente; aqui a `projectShare` é simplesmente dividida por 4 antes de `CREDIT.mint` ser chamado, então `CreditToken.totalSupply()` **não é afetado** por este caminho. Isso preserva o espírito deflacionário por subtração de emissão, não por incineração.

Intuição: um projeto novo tem risco de ser fraude. Durante 30 dias, a DAO e os stakers observam. Se for legítimo, a probation expira e a share normaliza. Se for fraude, a governança pode mover o projeto para `Status.Probation` punitiva (bloqueia stake e pagamentos) ou `Status.Removed` (encerra e potencialmente dá slash no colateral).

## Bootstrap: e quando não há burn?

Se `burn_{R-1} == 0`, a emissão ainda acontece (via floor, enquanto R < 24). Mas **como a emissão é dividida entre projetos se ninguém queimou?**

`RewardDistributor._projectShare` tem um caminho alternativo:

```
se totalBurnPrev == 0:
    projectShare = emissao * projectWeight / globalWeight
```

Ou seja: quando não há burn, o share é proporcional ao **peso de staking** do projeto sobre o peso global. Isso mantém o incentivo para stakers entrarem cedo mesmo sem uso real ainda — eles capturam o floor na proporção do seu stake direcionado.

Para isso funcionar, o `Staking` mantém um checkpoint global (`_globalWeightCheckpoints`) atualizado em O(1) em cada mudança de posição.

## A equação de sustentação

O protocolo sobrevive no longo prazo **se e somente se** burn orgânico agregado cobre ao menos o custo para stakers. Em equação narrativa:

```
valor percebido pelos stakers > custo de oportunidade de ter GOV em outro lugar
        |
        v
  stakers continuam entrando (ou pelo menos nao saem)
        |
        v
  apps continuam com backing (stakers sao distribuidores de confianca)
        |
        v
  usuarios continuam usando
        |
        v
  burn continua
        |
        v
  loop fechado
```

Se qualquer um desses elos se rompe, o loop desacelera. **Nenhuma fórmula salva produto ruim**; o papel da matemática é só não ser o ponto de falha adicional.

## O que a DAO pode ajustar (e o que não pode)

Ajustável via `GOVERNANCE_ROLE` (Timelock, que só executa após proposta aprovada):

- `alpha` dentro de `[0.5, 0.99]` — `RewardDistributor.setAlpha`. A faixa foi reduzida (antes `[0.5, 1.1]`) para garantir a invariante econômica IE1 (α < 1 permanente) por construção — a governança não pode mais votar valor inflacionário. Ver parecer em `audit/economist/2026-04-22-consistency-audit.md` (C2).
- `capMax` dentro de `[1, 100M] CREDIT` — `RewardDistributor.setCapMax`
- `roundDuration` dentro de `[1 dia, 30 dias]` — `BurnTracker.setRoundDuration`
- `maxBurnPerRoundPerProject` (0 = desabilita) — `BurnTracker.setMaxBurnPerRoundPerProject`
- Split padrão e overrides — `FeeRouter.setDefaultSplit` / `setProjectSplit` / `clearProjectSplit`
- `minCollateral` e `probationDuration` do Registry

**Não ajustável**:

- `floorSchedule` — imutável desde o constructor do `RewardDistributor`.
- `MIN_LOCK`, `MAX_LOCK`, `MAX_MULTIPLIER` do `Staking`.
- `MIN_ROUND_DURATION`, `MAX_ROUND_DURATION` do `BurnTracker`.
- `MIN_ALPHA`, `MAX_ALPHA`, `MIN_CAPMAX`, `MAX_CAPMAX` do `RewardDistributor`.
- Cap de supply do GOV (100M).

---

**Próximo →** [Rewards distribution](04-rewards-distribution.md)
