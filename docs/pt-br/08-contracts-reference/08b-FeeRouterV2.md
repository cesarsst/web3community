# FeeRouterV2

**Para quem é:** devs de apps integrando pagamentos, investidores acompanhando volume, auditores.
**Pré-requisitos:** [CreditPSM](15-CreditPSM.md), [ProjectFunding](16-ProjectFunding.md).

## Visão rápida

Trilho de pagamento do remodel 2026-07-08. Substitui o modelo burn-to-mint do [FeeRouter V1](08-FeeRouter.md) (split 70/20/10) por uma **taxa competitiva com processadores de pagamento**:

```
pay(projectId, 100 CREDIT)
  |
  +--> fee do protocolo (default 2,5% = 250 bps; teto duro 5%)
  |       +--> 40% treasury   (1,0% do pagamento)
  |       +--> 40% buyback GOV (1,0% do pagamento)
  |       +--> 20% grants      (0,5% do pagamento)
  |
  +--> rev-share do projeto (ProjectFunding.revShareBpsOf; 0 se nunca captou)
  |       +--> transferido ao ProjectFunding + notifyRevenue (investidores)
  |
  +--> resto --> appRecipient do projeto, na hora
          (97,5% sem rodada; ~89,5% com rev-share de 8%)
```

**Sem burn, sem emissão**: CREDIT é trilho estável (ver [CreditPSM](15-CreditPSM.md)). A renda do investidor vem de receita real; o valor do GOV vem do buyback contínuo financiado pela fee. Para comparação: a fee total de 2,5% é menor que Stripe (~3,8%) e ordens de grandeza menor que a taxa efetiva de ~80% do modelo V1 (análise em `audit/economist/2026-07-08-feerouter-bypass.md`).

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parâmetros e storage

| Nome | Tipo | Descrição |
|---|---|---|
| `FEE_BPS_CAP` | constant `uint16` | **500** (5%) — teto duro da fee; nem governança ultrapassa |
| `GOVERNANCE_ROLE` | constant | Role dos setters econômicos |
| `CREDIT` | immutable | CreditToken |
| `REGISTRY` | immutable | ProjectRegistry |
| `FUNDING` | immutable | ProjectFunding |
| `feeBps` | `uint16` | Fee do protocolo em bps do pagamento (default de deploy **250** = 2,5%) |
| `feeSplit` | `FeeSplit` | Repartição interna da fee (default **4000/4000/2000** = 40% treasury / 40% buyback / 20% grants) |
| `treasuryRecipient` / `buybackRecipient` / `grantsRecipient` | `address` | Destinos da fee |
| `appRecipientOf` | mapping | Recipient de pagamento por projeto (fallback: owner do Registry) |
| `grossVolumeOf` | mapping | **Volume bruto acumulado por projeto** — métrica on-chain para investidores |

### Struct `FeeSplit`

```solidity
struct FeeSplit {
    uint16 treasuryBps;
    uint16 buybackBps;
    uint16 grantsBps;
}
// bps da PROPRIA fee, soma tem que ser 10000
```

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

Além disso, o FeeRouterV2 detém `REVENUE_NOTIFIER_ROLE` **no ProjectFunding** — é o único autorizado a chamar `notifyRevenue`.

## Funções externas

### `pay(uint256 projectId, uint256 amount)`

Paga `amount` de CREDIT ao projeto. Tudo atômico, ordem: fee → rev-share → app.

- **Quem chama**: qualquer um (o pagador é `msg.sender`). Exige `CREDIT.approve(feeRouterV2, amount)` prévio.
- **Reverte**: `ZeroAmount`, `ProjectNotActive` (exige projeto Active no Registry).
- **Eventos**: `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)`.
- **ReentrancyGuard**: sim.

Pipeline interno:

1. `CREDIT.safeTransferFrom(payer, router, amount)`.
2. `fee = amount * feeBps / 10000`; split `toTreasury` / `toBuyback` / `toGrants` (resíduo de arredondamento vai para grants).
3. `revShare = amount * FUNDING.revShareBpsOf(projectId) / 10000` (0 se o projeto nunca teve rodada Funded).
4. `toApp = amount - fee - revShare`.
5. Transfere cada parcela; o rev-share é transferido ao ProjectFunding **antes** do `FUNDING.notifyRevenue(projectId, revShare)` (o funding só contabiliza, não puxa).
6. Resolve `appRecipient` (`appRecipientOf[projectId]` ou, se zero, `REGISTRY.getProject(projectId).owner`) e transfere `toApp`.
7. `grossVolumeOf[projectId] += amount`.

### Governance-gated (`GOVERNANCE_ROLE`)

#### `setFeeBps(uint16 newFeeBps)`

- **Reverte**: `FeeAboveCap` se `newFeeBps > 500`.
- **Eventos**: `FeeUpdated(previousBps, currentBps)`.

#### `setFeeSplit(FeeSplit calldata newSplit)`

- **Reverte**: `SplitDoesNotSumTo10000`.
- **Eventos**: `FeeSplitUpdated(treasuryBps, buybackBps, grantsBps)`.

#### `setRecipients(address treasury_, address buyback_, address grants_)`

- **Reverte**: `ZeroAddress`.
- **Eventos**: `RecipientsUpdated(treasury, buyback, grants)`.

### Owner-gated

#### `setAppRecipient(uint256 projectId, address recipient)`

Dono do projeto (Registry) rotaciona o recipient de pagamento — operacional, como no V1.

- **Reverte**: `NotProjectOwner`, `ZeroAddress`.
- **Eventos**: `AppRecipientUpdated(projectId, recipient)`.

### Views

- `previewPay(uint256 projectId, uint256 amount) → (uint256 fee, uint256 revShare, uint256 toApp)` — preview do detalhamento para UI, sem side effects.
- `grossVolumeOf(projectId)` — volume bruto acumulado (GMV on-chain do projeto).

## Eventos

| Evento | Indexados |
|---|---|
| `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)` | `projectId`, `payer` |
| `FeeUpdated(previousBps, currentBps)` | — |
| `FeeSplitUpdated(treasuryBps, buybackBps, grantsBps)` | — |
| `RecipientsUpdated(treasury, buyback, grants)` | — |
| `AppRecipientUpdated(projectId, recipient)` | `projectId` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Endereço zero em constructor/setters |
| `ZeroAmount()` | `pay` com `amount == 0` |
| `ProjectNotActive(projectId)` | Projeto não Active no Registry |
| `NotProjectOwner(projectId, caller)` | `setAppRecipient` sem ser owner |
| `FeeAboveCap(provided, cap)` | Fee acima de `FEE_BPS_CAP` (500) |
| `SplitDoesNotSumTo10000(sum)` | Split da fee não soma 10.000 bps |

## Invariantes

- **Teto duro da fee**: `feeBps <= 500` (5%) — enforçado no constructor e em `setFeeBps`. Mesmo proposta aprovada não passa disso.
- **I4 (governance via Timelock)**: setters econômicos são `GOVERNANCE_ROLE`.
- **I7 (projetos via Registry)**: `pay` exige projeto Active.
- **Conservação**: `toApp + fee + revShare == amount` em toda `pay`; dentro da fee, resíduo de arredondamento vai para grants.
- **Sem custódia entre chamadas**: cada `pay` distribui tudo; o router termina com saldo 0.
- **Transparência contábil**: os eventos carregam o detalhamento por parcela mesmo quando os três recipients apontam pro mesmo endereço (MVP dev: os três = Treasury).

## Observações importantes

### Diferenças em relação ao V1

| | FeeRouter V1 (legado) | FeeRouterV2 |
|---|---|---|
| Custo pro app | 90% (70% burn + 20% treasury) | **2,5%** (+ rev-share se captou) |
| Burn de CREDIT | 70% de cada pagamento | Nenhum |
| Emissão compensatória | Sim (RewardDistributor) | Não existe |
| Renda do investidor | CREDIT emitido (inflação) | Rev-share de receita real |
| Valor pro GOV | Indireto | Buyback contínuo (40% da fee = 1% do GMV) |
| Assinatura de `pay` | `pay(projectId, user, amount)` | `pay(projectId, amount)` — pagador é `msg.sender` |

### `grossVolumeOf` como métrica de investimento

Investidores avaliando uma rodada do [ProjectFunding](16-ProjectFunding.md) podem verificar o GMV histórico do projeto direto on-chain, sem indexador: `grossVolumeOf[projectId]` acumula todo pagamento que passou pelo router.

---

**Ver também**: [CreditPSM](15-CreditPSM.md), [ProjectFunding](16-ProjectFunding.md), [FeeRouter V1 (legado)](08-FeeRouter.md), [ProjectRegistry](03-ProjectRegistry.md).
