# ProjectFunding

**Para quem é:** donos de projeto captando, investidores (stakers de GOV), auditores.
**Pré-requisitos:** [FeeRouterV2](08b-FeeRouterV2.md), [Staking](05-Staking.md), [ProjectRegistry](03-ProjectRegistry.md).

## Visão rápida

Captação + redistribuição de receita por projeto (remodel 2026-07-08). Substitui a emissão inflacionária de CREDIT como fonte de renda do investidor: quem financia um projeto compra o direito a uma fatia (`revShareBps`) da **receita bruta futura**, paga automaticamente pelo [FeeRouterV2](08b-FeeRouterV2.md) a cada pagamento.

Ciclo:

```
1. Dono do projeto Active abre UMA rodada:
   openRound(projectId, alvo em CREDIT, revShareBps 1-30%, prazo 1-90 dias)
        |
2. Investidores com GOV stakeado NO projeto depositam CREDIT
   invest(projectId, amount)          [shares = CREDIT investido, 1:1]
        |
        +-- alvo batido  --> finaliza automaticamente: dono recebe o
        |                    captado, rev-share ativa       (Funded)
        +-- prazo vencido --> closeExpiredRound (permissionless)
                              refund devolve 100%           (Failed)
3. A cada pagamento no FeeRouterV2:
   notifyRevenue(projectId, revShare) --> acumulador por share
        |
4. Investidor saca com claim(projectId)
   (exige manter GOV stakeado no projeto; claims nunca expiram)
```

**All-or-nothing**: a rodada só paga o dono se bater o alvo — protege o investidor de financiar pela metade um projeto inviável. **Skin in the game**: tanto `invest` quanto `claim` exigem `Staking.getWeight(investor, projectId) > 0`.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parâmetros e storage

| Nome | Tipo | Descrição |
|---|---|---|
| `MIN_REV_SHARE_BPS` | constant | **100** (1%) |
| `MAX_REV_SHARE_BPS` | constant | **3000** (30%) |
| `MIN_ROUND_DURATION` | constant | **1 day** |
| `MAX_ROUND_DURATION` | constant | **90 days** |
| `ACC_PRECISION` | constant | `1e18` (precisão do acumulador) |
| `CREDIT` | immutable | CreditToken |
| `REGISTRY` | immutable | ProjectRegistry |
| `STAKING` | immutable | Staking |
| `minTarget` | `uint256` | Alvo mínimo de rodada (anti-spam), default `100e18`; ajustável por governança |
| `rounds` | mapping | Rodada (única) de cada projeto |
| `sharesOf` | mapping | Shares do investidor (== CREDIT investido) por projeto |
| `accRevenuePerShare` | mapping | Acumulador de receita por share (padrão MasterChef) |
| `rewardDebt` | mapping | Checkpoint do investidor contra o acumulador |
| `totalRevenueDistributed` | mapping | Receita total já distribuída por projeto (auditoria/UI) |

### Enum `RoundStatus` e struct `Round`

```solidity
enum RoundStatus { None, Open, Funded, Failed }

struct Round {
    uint256 target;      // alvo em CREDIT (18d)
    uint256 raised;      // captado ate agora
    uint64 deadline;     // timestamp limite
    uint16 revShareBps;  // fatia da receita bruta oferecida
    RoundStatus status;
}
```

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` (ajusta `minTarget`) |
| `REVENUE_NOTIFIER_ROLE` | `FeeRouterV2` — único autorizado a `notifyRevenue` |

## Funções externas

### `openRound(uint256 projectId, uint256 target, uint16 revShareBps, uint64 duration)`

Abre a rodada de captação do projeto. Só o dono (Registry), projeto Active, **uma rodada por projeto** (MVP).

- **Reverte**: `ProjectNotActive`, `NotProjectOwner`, `RoundAlreadyExists`, `RevShareOutOfBounds` (fora de 100-3000 bps), `TargetOutOfBounds` (abaixo de `minTarget`), `DurationOutOfBounds` (fora de 1-90 dias).
- **Eventos**: `RoundOpened(projectId, target, revShareBps, deadline)`.

### `invest(uint256 projectId, uint256 amount)`

Investe CREDIT na rodada aberta. **Exige GOV stakeado no projeto.** Não aceita overshoot: `amount` não pode exceder o que falta para o alvo. Se o alvo for batido, a rodada finaliza automaticamente (paga o dono, ativa o rev-share).

- **Reverte**: `RoundNotOpen` (inclui prazo vencido), `ZeroAmount`, `NoGovStaked`, `ExceedsTarget`.
- **Eventos**: `Invested(projectId, investor, amount, totalRaised)`; se bateu o alvo, também `RoundFunded(projectId, raised, paidTo)`.

### `closeExpiredRound(uint256 projectId)`

Encerra rodada com prazo vencido e alvo não batido (→ `Failed`). **Permissionless** — qualquer um pode "carimbar" a falha.

- **Reverte**: `RoundNotOpen`, `RoundStillOpen` (prazo ainda não venceu).
- **Eventos**: `RoundFailed(projectId, raised)`.

### `refund(uint256 projectId)`

Devolve 100% do investido numa rodada `Failed`.

- **Reverte**: `RoundNotFailed`, `NothingToRefund`.
- **Eventos**: `Refunded(projectId, investor, amount)`.

### `notifyRevenue(uint256 projectId, uint256 amount)`

Recebe a fatia de rev-share de um pagamento. **Só FeeRouterV2** (`REVENUE_NOTIFIER_ROLE`). O router já transferiu o CREDIT antes; aqui só se atualiza o acumulador: `accRevenuePerShare += amount * 1e18 / raised` e `totalRevenueDistributed += amount`.

- **Reverte**: `ZeroAmount`, `NoActiveShares` (rodada não Funded).
- **Eventos**: `RevenueNotified(projectId, amount)`.

### `claim(uint256 projectId) → uint256 amount`

Saca a receita acumulada do investidor no projeto. **Exige GOV ainda stakeado no projeto** (skin in the game). O valor **nunca expira** — sem stake ele apenas fica retido até o investidor voltar a stakear.

- **Reverte**: `NoGovStaked`, `NothingToClaim`.
- **Eventos**: `RevenueClaimed(projectId, investor, amount)`.

### Governance-gated

#### `setMinTarget(uint256 newMin)`

- **Eventos**: `MinTargetUpdated(previous, current)`.

### Views

- `revShareBpsOf(uint256 projectId) → uint16` — rev-share ativo (0 se não `Funded`); consumido pelo FeeRouterV2 em cada `pay`.
- `pendingRevenue(uint256 projectId, address investor) → uint256` — receita pendente de claim.
- `rounds(projectId)`, `sharesOf(projectId, investor)`, `accRevenuePerShare(projectId)`, `rewardDebt(projectId, investor)`, `totalRevenueDistributed(projectId)` — getters públicos.

## Eventos

| Evento | Indexados |
|---|---|
| `RoundOpened(projectId, target, revShareBps, deadline)` | `projectId` |
| `Invested(projectId, investor, amount, totalRaised)` | `projectId`, `investor` |
| `RoundFunded(projectId, raised, paidTo)` | `projectId`, `paidTo` |
| `RoundFailed(projectId, raised)` | `projectId` |
| `Refunded(projectId, investor, amount)` | `projectId`, `investor` |
| `RevenueNotified(projectId, amount)` | `projectId` |
| `RevenueClaimed(projectId, investor, amount)` | `projectId`, `investor` |
| `MinTargetUpdated(previous, current)` | — |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAmount()` / `ZeroAddress()` | Valor/endereço zero |
| `ProjectNotActive(projectId)` | `openRound` com projeto não Active |
| `NotProjectOwner(projectId, caller)` | `openRound` sem ser owner |
| `RoundAlreadyExists(projectId)` | Segunda rodada no mesmo projeto |
| `RoundNotFound(projectId)` | Rodada inexistente |
| `RoundNotOpen(projectId)` | `invest`/`closeExpiredRound` fora do estado Open |
| `RoundStillOpen(projectId)` | `closeExpiredRound` antes do prazo |
| `RoundNotFailed(projectId)` | `refund` sem rodada Failed |
| `RevShareOutOfBounds(provided, min, max)` | Fora de `[100, 3000]` bps |
| `TargetOutOfBounds(provided, min)` | Alvo abaixo de `minTarget` |
| `DurationOutOfBounds(provided, min, max)` | Fora de `[1 day, 90 days]` |
| `NoGovStaked(projectId, investor)` | `invest`/`claim` sem GOV stakeado no projeto |
| `ExceedsTarget(requested, remaining)` | `invest` acima do que falta para o alvo |
| `NothingToRefund(projectId, investor)` | `refund` sem shares |
| `NothingToClaim(projectId, investor)` | `claim` sem receita pendente |
| `NoActiveShares(projectId)` | `notifyRevenue` sem rodada Funded |

## Invariantes

- **Uma rodada bem-sucedida por projeto** (MVP). Rodadas subsequentes exigiriam empilhar pools de shares com bps distintos — documentado para V2.
- **Shares = CREDIT investido** (1:1, imutável após finalize).
- **All-or-nothing**: o dono só recebe se `raised == target`; rodada vencida sem alvo → refund integral.
- **Distribuição O(1)**: acumulador `accRevenuePerShare` (padrão MasterChef, precisão 1e18) — O(1) por pagamento, O(1) por claim.
- **Gate de GOV**: `invest` e `claim` exigem `STAKING.getWeight(msg.sender, projectId) > 0`. Sem stake o valor **não é perdido** — fica acruado até re-stake.
- **Bounds imutáveis**: rev-share `[1%, 30%]`, prazo `[1, 90] dias` são constants.

## Observações importantes

### Por que exigir GOV stakeado

O gate materializa o requisito "quem tem GOV em stake recebe a redistribuição": o investidor de CREDIT precisa também ter exposição de longo prazo ao projeto (GOV lockado via [Staking](05-Staking.md)). Isso alinha o funding com a curadoria — quem financia é quem já sinalizou convicção.

### Yield transparente

O retorno do investidor é calculável on-chain: `totalRevenueDistributed[projectId] / rounds[projectId].raised` dá o retorno acumulado por unidade investida; anualize pela idade da rodada. Combine com `grossVolumeOf[projectId]` do FeeRouterV2 para estimar receita futura. Ver [Métricas que importam](../06-for-investors/04-metrics-that-matter.md).

---

**Ver também**: [FeeRouterV2](08b-FeeRouterV2.md), [CreditPSM](15-CreditPSM.md), [Staking](05-Staking.md), [ProjectRegistry](03-ProjectRegistry.md).
