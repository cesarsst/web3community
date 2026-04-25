# Fase 1.4 do pivot CLP — `RewardDistributorV2` (bucket-aware split)

Documento operacional da **quarta implementação** da Fase 1 do pivot Credit
Liquidity Protocol. Fecha o flywheel da Fase 1: `RewardDistributorV2`
distribui a emissão de CREDIT em 4 buckets (stakers/LPs/apps/bonders) por
rodada, integrando todos os contratos previamente entregues (FFP buyback
1.1, POL 1.2, LiquidityGauge 1.3).

Decisões operacionais congeladas em
[`audit/economist/2026-04-24-clp-pivot.md`](../../audit/economist/2026-04-24-clp-pivot.md)
**Anexo E**.

## 1. O que mudou

### 1.1 Contratos novos / modificados

- **`contracts/RewardDistributorV2.sol`** (novo, deploy paralelo ao V1).
  Reescreve `finalizeRound` com split em 4 buckets:

  | Bucket  | Default bps | Mecânica                                   | Destino                             |
  | ------- | ----------- | ------------------------------------------ | ----------------------------------- |
  | Stakers | 5500 (55%)  | Pull-based via `claim` (lazy mint)         | Staker do projeto                   |
  | LPs     | 2500 (25%)  | Push direto via `gauge.notifyRewardAmount` | `LiquidityGauge` (Fase 1.3)         |
  | Apps    | 1500 (15%)  | Push retrospectivo (burn-based)            | `ProjectRegistry.ownerRecipient(p)` |
  | Bonders | 500 (5%)    | Push earmark                               | `Treasury.depositPolRefill`         |

- **`contracts/Treasury.sol`** (estendido). Novos campos:
  - `polRefillBucket` (uint256): ledger contábil do bucket bonders. Drenado
    via `addPOLFromRefill(creditAmount, usdcAmount, ...)`.
  - `pendingGaugeRewards` (uint256): fallback para o bucket LPs quando
    `gauge.paused()` no momento de `finalizeRound` (red flag E.3 #2). Drenado
    via `flushPendingGaugeRewards(duration)` apos despausar.
  - `liquidityGauge` (address): destino do flush, configurado via
    `setLiquidityGauge(gauge, poolId)`.
  - 2 roles novas: `POL_REFILL_DEPOSITOR_ROLE`, `GAUGE_FALLBACK_DEPOSITOR_ROLE`.

- **`contracts/ProjectRegistry.sol`** (estendido). `ownerRecipient(projectId)`
  com timelock 48h (red flag E.3 #1). Setter `proposeOwnerRecipient` →
  aguarda `OWNER_RECIPIENT_TIMELOCK` (48h) → `applyOwnerRecipient`
  permissionless. Cancel via owner ou governance (escape hatch).

### 1.2 Interfaces slim

- **`contracts/interfaces/ITreasuryRewards.sol`** — usada pelo V2 para chamar
  `depositPolRefill` / `depositPendingGaugeRewards` no Treasury sem importar
  o contrato completo (evita ciclo).
- **`contracts/interfaces/ILiquidityGaugeRewards.sol`** — usada pelo V2 e
  Treasury para chamar `notifyRewardAmount` e ler `paused()` no gauge.

### 1.3 Bounds operacionais de `setBucketBps`

```text
| Bucket   | Min (bps) | Max (bps) | Justificativa                                        |
| -------- | --------- | --------- | ---------------------------------------------------- |
| stakers  | 3000      | 10000     | Não esvaziar sinal staker → projeto (Fase 2 usa)      |
| LPs      | 500       | 10000     | IE6 — liquidez mínima incentivada antes do POL maduro |
| apps     | 0         | 2500      | IE4b — anti auto-extração via wash burn               |
| bonders  | 0         | 2000      | Olympus mostrou que >20% destrava ponzi               |
| **soma** | 10000     | 10000     | Lossless (IE12)                                      |
```

Setter `setBucketBps([s, l, a, b])` reverte com `BucketBpsOutOfBounds` ou
`BucketBpsSumInvalid`.

## 2. Pré-requisitos antes do deploy

Em ordem rígida (governance approval cada um):

1. **Fase 0 split `(7000, 2000, 1000)` precisa estar live**. Sem isso, o
   Treasury não recebe USDC do FeeRouter, e o bucket bonders acumula CREDIT
   no `polRefillBucket` sem poder ser usado em `addPOLFromRefill` (que exige
   USDC matching). Verificar com `FeeRouter.getSplit()`.
2. **Fase 1.1 (FFP buyback)** precisa estar configurada com oracle/router/feed
   Chainlink.
3. **Fase 1.2 (POL)** precisa estar configurada com `positionManager` e a
   posição POL inicial criada (`polTokenId != 0`).
4. **Fase 1.3 (LiquidityGauge)** precisa estar deployado com a pool
   CREDIT/USDC whitelistada (poolId 1 por convenção).

## 3. Sequência de propostas DAO de migração

Cada bullet é uma proposta separada (Timelock 2d default).

### Proposta #1 — Deploy V2

Deploy de `RewardDistributorV2(admin=Timelock, credit, staking, burnTracker,
registry, gauge, treasury, alpha=0.95e18, capMax=5M*1e18, floorSchedule=
[24 valores])`.

Verificar pós-deploy: `bucketBps` default `[5500, 2500, 1500, 500]`,
`gaugePoolId = 1`, `gaugeIncentiveDuration = 7 days`.

### Proposta #2 — Grant roles do V2

Em batch:

1. `CreditToken.grantRole(MINTER_ROLE, V2)` — V2 mint CREDIT no
   `finalizeRound`.
2. `LiquidityGauge.grantRole(REWARD_NOTIFIER_ROLE, V2)` — V2 chama
   `gauge.notifyRewardAmount` no bucket LPs.
3. `Treasury.grantRole(POL_REFILL_DEPOSITOR_ROLE, V2)` — V2 chama
   `treasury.depositPolRefill` no bucket bonders.
4. `Treasury.grantRole(GAUGE_FALLBACK_DEPOSITOR_ROLE, V2)` — V2 chama
   `treasury.depositPendingGaugeRewards` quando gauge paused.

### Proposta #3 — Configurar Treasury → Gauge

`Treasury.setLiquidityGauge(LIQUIDITY_GAUGE_ADDRESS, 1)` para habilitar
`flushPendingGaugeRewards`. Pode ser combinado com Proposta #2 em batch.

### Proposta #4 — Janela de migração (4 rounds)

Durante 4 rounds (~28d em prod com round 7d), V1 e V2 coexistem:

- V1: **claim-only**. Stakers pendentes do modelo antigo continuam
  podendo chamar `V1.claim` / `V1.claimMany` para rounds **já finalizados**
  antes desta janela.
- V2: **único contrato a chamar `finalizeRound`** a partir do round atual.

**Atenção**: V1 ainda detém `MINTER_ROLE` no CREDIT durante a janela. Se
alguém chamasse `V1.finalizeRound` para a rodada corrente, haveria **dupla
emissão** (red flag E.3 #3 do parecer). Mitigação operacional: V1 não tem
nenhum keeper trigger automático, e a proposta DAO de Fase 1.4 explicitamente
não inclui chamadas a `V1.finalizeRound`. Como salvaguarda adicional, a
Proposta #5 (abaixo) revoga `MINTER_ROLE` do V1 ao final da janela.

### Proposta #5 — Cutoff (após 4 rounds)

`CreditToken.revokeRole(MINTER_ROLE, V1)`. A partir deste ponto, qualquer
chamada a `V1.finalizeRound` reverte com `AccessControlUnauthorizedAccount`
no `CREDIT.mint`. V1 fica permanentemente neutralizado, mas **claims
pendentes continuam funcionando** (mint dentro de `_claim` reverte sem
`MINTER_ROLE` — nesse caso, governance pode optar por: a) restaurar
brevemente a role para drenar pendentes; b) deixar pendentes evaporarem
como decisao politica documentada).

## 4. Cenários operacionais

### 4.1 Gauge paused durante `finalizeRound`

Caminho do código (`_emitLpsBucket`):

```solidity
if (GAUGE.paused()) {
    CREDIT.mint(address(TREASURY), lpsAmount, "rewardRound:lps:fallback");
    TREASURY.depositPendingGaugeRewards(lpsAmount);
    emit GaugePauseFallback(round, lpsAmount);
    return;
}
```

`pendingGaugeRewards` acumula. Quando governance despausar o gauge, basta
uma proposta `Treasury.flushPendingGaugeRewards(duration)` para drenar o
ledger inteiro de uma só vez. Importante: `duration` deve respeitar
`INCENTIVE_DURATION_MIN` do gauge (1h em dev, sugestão 7d em prod).

### 4.2 Bucket bonders sem USDC matching

Caso a Fase 0 split não esteja live (ex.: Treasury sem USDC), o
`polRefillBucket` acumula CREDIT mas `addPOLFromRefill` não pode ser chamada
(saldo USDC do Treasury < `usdcAmount`). Ações governance:

- **Curto prazo**: aguardar split ficar live ou bootstrap externo de USDC
  (donation, OTC, etc.). CREDIT acumulado fica earmarcado, **não é** parte
  do balance livre — não pode ser desviado para `transfer` ou `addPOL`
  tradicional.
- **Longo prazo**: alterar `bucketBps` via `setBucketBps` para reduzir o
  bucket bonders e redistribuir para outros (respeitando bounds).

### 4.3 Projeto `Removed` durante claim

V2 mantém comportamento V1 (red flag E.3 #5):

- Snapshot no `finalizeRound` fixa o peso via
  `STAKING.getWeightAt(snapshot)`.
- Status `Removed` posterior **não** zera o reward — peso pré-finalize fica.
- Probation penalty é avaliado no momento do claim (status
  `Active && isInProbation` → penalty / 4).

Se um projeto for `Removed` entre finalize e claim de stakers, os rewards
"fantasma" daquele projeto continuam mintáveis até serem claimed. Stakers
do projeto `Removed` podem fazer emergency unstake no `Staking` (que tem
bypass do lock para projetos Removed) e ainda chamar `V2.claim` retroativo.

### 4.4 Hot-swap de `ownerRecipient` mitigado pelo timelock

Antes da Fase 1.4, o `Registry.transferProjectOwnership` mudava o owner em
2-step (`accept`). Como o V2 mint para `ownerRecipient(p)`, sem timelock o
owner poderia chamar `transfer` + `accept` + reverse-transfer em sequência
para desviar rewards de uma única `finalizeRound`.

Mitigação Fase 1.4: o setter `proposeOwnerRecipient` registra a mudança com
`effectiveAt = now + 48h`. `applyOwnerRecipient` é permissionless apos
`effectiveAt`. Antes disso, qualquer `applyOwnerRecipient` reverte com
`OwnerRecipientTimelockActive`. Owner ou governance podem cancelar via
`cancelOwnerRecipient` (escape hatch).

## 5. Setters de governance pos-deploy

Resumo executivo do que é tunável:

| Setter                                      | Bounds                                               | Quem          |
| ------------------------------------------- | ---------------------------------------------------- | ------------- |
| `V2.setBucketBps([s,l,a,b])`                | Vide tabela §1.3                                     | Timelock      |
| `V2.setAlpha(newAlpha)`                     | `[0.5e18, 0.99e18]`                                  | Timelock      |
| `V2.setCapMax(newCap)`                      | `[1e18, 100M*1e18]`                                  | Timelock      |
| `V2.setGaugePoolId(poolId)`                 | uint256 (sem validação on-chain — governance audita) | Timelock      |
| `V2.setGaugeIncentiveDuration(secs)`        | `[1h, 90d]`                                          | Timelock      |
| `Treasury.setLiquidityGauge(gauge, poolId)` | endereços livres                                     | Timelock      |
| `Registry.proposeOwnerRecipient(pid, addr)` | qualquer endereço (zero = reset fallback)            | Project owner |

## 6. Invariantes economicas reafirmadas

- **IE1** α<1 perpétuo: `MAX_ALPHA = 0.99e18` (V2 herda do V1).
- **IE2** Floor temporário: `floorSchedule[24]` replicado idêntico do V1.
- **IE3 (fortalecida)**: cap aplicado _antes_ do split — nenhum bucket
  excede `bucketBps[i] × capMax`. Stack: `rawEmission → cap → split`.
- **IE4** split FeeRouter ≤ 1-α: OK (V2 não toca FeeRouter).
- **IE4b (codificada)**: `bucketBps[apps] <= 2500` em `setBucketBps`. Anti
  auto-extração via wash burn.
- **IE5** captura por staker: OK (V2 não muda Staking).
- **IE6** liquidez DEX: **fortalecida** — refill POL via bucket bonders é
  mecanismo direto de profundidade.
- **IE10** sem pause em CREDIT/Staking: OK (V2 não tem pause).
- **IE12 (criada)**: assert em `finalizeRound` — soma dos 4 buckets ==
  `totalEmission` com tolerância `SPLIT_TOLERANCE_WEI = 3` (residuos de
  divisão inteira no bucket apps por loop sobre projetos).

## 7. Decisões pendentes do user

Apenas operacionais (não-bloqueante para deploy):

1. **Quando submeter Proposta #1**? (Auto-mode: imediato.)
2. **Cronograma da janela de 4 rounds**? Em prod com round 7d, ~28d. Em
   testnet pode ser comprimido para 4h (round 1h).
3. **`gaugeIncentiveDuration` em prod**: default 7 days = igual round
   duration. Pode ser ajustado para multiplo (ex.: 14d) se governance
   quiser overlap entre rounds.
