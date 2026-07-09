# ProjectFunding

**Para quem é:** devs/auditores.

Contrato: `contracts/ProjectFunding.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Captação + redistribuição de receita por projeto (remodel 2026-07-08). Quem financia um projeto compra o direito a uma fatia (`revShareBps`) da receita bruta futura, paga automaticamente pelo [FeeRouterV2](06-FeeRouterV2.md) a cada pagamento.

Ciclo:

1. Dono do projeto abre rodada: alvo em CREDIT, rev-share oferecido (bps) e prazo.
2. Investidores com GOV stakeado **no projeto** (`Staking.getWeight > 0`) depositam CREDIT até o alvo.
3. Alvo batido → finaliza automaticamente (paga o dono, ativa o rev-share). Prazo vencido sem alvo → rodada falha, `refund` devolve 100%.
4. `FeeRouterV2` chama `notifyRevenue` a cada pagamento; investidor saca com `claim` (exige manter GOV stakeado no projeto).

Distribuição via acumulador MasterChef (`accRevenuePerShare`, precisão 1e18): O(1) por pagamento e por claim. **Uma rodada bem-sucedida por projeto** (MVP). Shares = CREDIT investido (1:1).

Herança: `AccessControl`, `ReentrancyGuard`. Usa `SafeERC20`.

## Interface pública

### Tipos

```solidity
enum RoundStatus { None, Open, Funded, Failed }

struct Round {
    uint256 target;       // alvo em CREDIT (18d)
    uint256 raised;       // captado até agora
    uint64  deadline;     // timestamp limite
    uint16  revShareBps;  // fatia da receita bruta oferecida
    RoundStatus status;
}
```

### Constantes / roles / storage

| Nome | Valor / descrição |
|---|---|
| `REVENUE_NOTIFIER_ROLE` | `keccak256("REVENUE_NOTIFIER_ROLE")`. Só o FeeRouterV2 notifica receita. |
| `GOVERNANCE_ROLE` | `keccak256("GOVERNANCE_ROLE")`. Ajusta bounds. Produção: Timelock. |
| `MIN_REV_SHARE_BPS` / `MAX_REV_SHARE_BPS` | `100` (1%) / `3000` (30%). |
| `MIN_ROUND_DURATION` / `MAX_ROUND_DURATION` | `1 days` / `90 days`. |
| `ACC_PRECISION` | `1e18`. |
| `CREDIT` / `REGISTRY` / `STAKING` | immutables. |
| `minTarget` | `uint256 public` (default `100e18`) — alvo mínimo anti-spam, ajustável. |
| `rounds` | `mapping(uint256 => Round) public`. |
| `sharesOf` | `mapping(uint256 => mapping(address => uint256)) public` — CREDIT investido. |
| `accRevenuePerShare` / `rewardDebt` / `totalRevenueDistributed` | acumulador MasterChef, checkpoint por investidor e total distribuído. |

### Constructor

```solidity
constructor(address admin, address credit, address registry, address staking)
```
Concede `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE` a `admin`. Reverte `ZeroAddress`.

### Rodada (todas `nonReentrant`)

```solidity
function openRound(uint256 projectId, uint256 target, uint16 revShareBps, uint64 duration) external
```
Só o dono (Registry) de projeto `Active`, uma vez por projeto. Reverte `ProjectNotActive`, `NotProjectOwner`, `RoundAlreadyExists`, `RevShareOutOfBounds`, `TargetOutOfBounds`, `DurationOutOfBounds`. Emite `RoundOpened`.

```solidity
function invest(uint256 projectId, uint256 amount) external
```
Investe CREDIT na rodada aberta. Exige `Staking.getWeight(msg.sender, projectId) > 0`. Alvo batido finaliza automaticamente (paga o dono, status `Funded`). Reverte `RoundNotOpen`, `ZeroAmount`, `NoGovStaked`, `ExceedsTarget`. Emite `Invested` (e `RoundFunded` se completar).

```solidity
function closeExpiredRound(uint256 projectId) external
```
Permissionless. Marca `Open` com prazo vencido como `Failed`. Reverte `RoundNotOpen`, `RoundStillOpen`. Emite `RoundFailed`.

```solidity
function refund(uint256 projectId) external
```
Devolve 100% do investido em rodada `Failed`. Reverte `RoundNotFailed`, `NothingToRefund`. Emite `Refunded`.

### Receita

```solidity
function notifyRevenue(uint256 projectId, uint256 amount) external onlyRole(REVENUE_NOTIFIER_ROLE)
```
Recebe a fatia de rev-share (o router já transferiu o CREDIT). Atualiza `accRevenuePerShare`. Exige rodada `Funded` com `raised > 0`. Reverte `ZeroAmount`, `NoActiveShares`. Emite `RevenueNotified`.

```solidity
function claim(uint256 projectId) external nonReentrant returns (uint256 amount)
```
Saca a receita acumulada. Exige GOV ainda stakeado no projeto (o valor nunca expira — sem stake fica retido até re-stake). Reverte `NoGovStaked`, `NothingToClaim`. Emite `RevenueClaimed`.

### Governança / views

```solidity
function setMinTarget(uint256 newMin) external onlyRole(GOVERNANCE_ROLE)  // emite MinTargetUpdated
function revShareBpsOf(uint256 projectId) external view returns (uint16)  // 0 se não Funded — consumido pelo router
function pendingRevenue(uint256 projectId, address investor) external view returns (uint256)
```

## Eventos

`RoundOpened(projectId, target, revShareBps, deadline)`, `Invested(projectId, investor, amount, totalRaised)`, `RoundFunded(projectId, raised, paidTo)`, `RoundFailed(projectId, raised)`, `Refunded(projectId, investor, amount)`, `RevenueNotified(projectId, amount)`, `RevenueClaimed(projectId, investor, amount)`, `MinTargetUpdated(previous, current)`.

## Erros

`ZeroAmount`, `ZeroAddress`, `ProjectNotActive`, `NotProjectOwner`, `RoundAlreadyExists`, `RoundNotFound`, `RoundNotOpen`, `RoundStillOpen`, `RoundNotFailed`, `RevShareOutOfBounds(provided, min, max)`, `TargetOutOfBounds(provided, min)`, `DurationOutOfBounds(provided, min, max)`, `NoGovStaked(projectId, investor)`, `ExceedsTarget(requested, remaining)`, `NothingToRefund(projectId, investor)`, `NothingToClaim(projectId, investor)`, `NoActiveShares(projectId)`.

## Roles

| Role | Produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock`. |
| `GOVERNANCE_ROLE` | `CommunityTimelock` — `setMinTarget`. |
| `REVENUE_NOTIFIER_ROLE` | Apenas o `FeeRouterV2` — `notifyRevenue`. |

## Invariantes

- **All-or-nothing:** a rodada só paga o dono se bater o alvo exato; senão vira `Failed` e permite refund integral. Protege o investidor de financiar pela metade.
- **Gate de stake:** `invest` e `claim` exigem `Staking.getWeight(msg.sender, projectId) > 0` (skin in the game).
- **Receita não expira:** sem stake, o valor acruado fica retido (não é perdido) até re-stake.
- **Uma rodada por projeto:** `openRound` reverte `RoundAlreadyExists` se status != `None`.
- **Shares imutáveis pós-finalize:** shares = CREDIT investido, 1:1.
- **Acumulador MasterChef:** `pending = shares * accRevenuePerShare / 1e18 - rewardDebt`; distribuição O(1).
- **CEI:** effects antes das interações em `invest`/`refund`/`claim` (dentro de `nonReentrant`).

## Ver também

[FeeRouterV2](06-FeeRouterV2.md) · [Staking](05-Staking.md) · [ProjectRegistry](04-ProjectRegistry.md)
