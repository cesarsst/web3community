# FeeRouterV2

**Para quem é:** devs/auditores.

Contrato: `contracts/FeeRouterV2.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Trilho de pagamento do modelo vigente (remodel 2026-07-08): uma taxa competitiva com processadores de pagamento. Em um `pay(projectId, amount)` de CREDIT, o valor é repartido atomicamente:

1. **Fee do protocolo** (default 2,5%, teto duro 5%) → split 40% treasury / 40% buyback GOV / 20% grants.
2. **Rev-share do projeto** (`ProjectFunding.revShareBpsOf`, 0 se o projeto nunca captou) → investidores, via `notifyRevenue`.
3. **Resto** → `appRecipient` do projeto (fallback: owner no Registry).

Sem burn, sem emissão. Exige projeto `Active` no [ProjectRegistry](04-ProjectRegistry.md).

Herança: `AccessControl`, `ReentrancyGuard`. Usa `SafeERC20`.

## Interface pública

### Tipo

```solidity
struct FeeSplit {        // bps DA PRÓPRIA fee; soma obrigatória = 10000
    uint16 treasuryBps;
    uint16 buybackBps;
    uint16 grantsBps;
}
```

### Constantes / roles / storage

| Nome | Tipo | Valor / descrição |
|---|---|---|
| `GOVERNANCE_ROLE` | `bytes32 constant` | `keccak256("GOVERNANCE_ROLE")`. Setters econômicos. Produção: Timelock. |
| `FEE_BPS_CAP` | `uint16 constant` | `500` (5%). Teto duro — nem governança passa. |
| `CREDIT` / `REGISTRY` / `FUNDING` | immutables | CreditToken, ProjectRegistry, ProjectFunding. |
| `feeBps` | `uint16 public` | Fee do protocolo em bps (default 250 = 2,5%). |
| `feeSplit` | `FeeSplit public` | Repartição da fee. |
| `treasuryRecipient` / `buybackRecipient` / `grantsRecipient` | `address public` | Destinos da fee. |
| `appRecipientOf` | `mapping(uint256 => address) public` | Recipient por projeto (fallback: owner). |
| `grossVolumeOf` | `mapping(uint256 => uint256) public` | Volume bruto acumulado por projeto, **sem** self-payments. Soma eterna — só auditoria; UI/automação leem `recentVolumeOf`. |
| `uniquePayersOf` | `mapping(uint256 => uint256) public` | Pagadores **distintos** por projeto (D2). Sybil-inflável por gas — sinal, não prova. |
| `hasPaid` | `mapping(uint256 => mapping(address => bool)) public` | Se a carteira já pagou o projeto (suporte a `uniquePayersOf`). |
| `volumeHalfLife` | `uint256 public` | Meia-vida do decaimento de `recentVolumeOf` (default `30 days`, governável). |

### Constructor

```solidity
constructor(address admin, address credit, address registry, address funding,
            address treasury_, address buyback_, address grants_,
            uint16 initialFeeBps, FeeSplit initialSplit)
```
Concede `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE` a `admin`. Reverte `ZeroAddress`, `FeeAboveCap`, `SplitDoesNotSumTo10000`.

### Pagamento

```solidity
function pay(uint256 projectId, uint256 amount) external nonReentrant
```
Puxa `amount` de CREDIT do pagador, calcula e distribui fee → rev-share → app (nesta ordem, tudo atômico). O rev-share é transferido ao `ProjectFunding` **antes** de `notifyRevenue` (o funding só contabiliza, não puxa). Reverte `ZeroAmount`, `ProjectNotActive`. Emite `PaymentRouted`.

**Self-payment (D1):** se `msg.sender` é o owner do projeto ou o `appRecipient`, o pagamento é marcado `selfPayment = true`: o split de valor acontece normalmente, mas `grossVolumeOf`, `uniquePayersOf` e `recentVolumeOf` **não** são creditados. Isso bloqueia só o caso literal de mesma carteira — pagar de uma segunda carteira do próprio owner passa pelo gate e custa 2,5% do valor (fee) por ciclo. Ou seja: os contadores são **sinais encarecidos, não prova de uso real** ({REVIEW} #4).

### Governança (`onlyRole(GOVERNANCE_ROLE)`)

```solidity
function setFeeBps(uint16 newFeeBps) external           // reverte FeeAboveCap; emite FeeUpdated
function setFeeSplit(FeeSplit calldata newSplit) external // reverte SplitDoesNotSumTo10000; emite FeeSplitUpdated
function setRecipients(address treasury_, address buyback_, address grants_) external // reverte ZeroAddress; emite RecipientsUpdated — SUPERMAIORIA (75%) no Governor
function setVolumeHalfLife(uint256 newHalfLifeSeconds) external // reverte ZeroHalfLife; emite VolumeHalfLifeUpdated
```

### Owner do projeto

```solidity
function setAppRecipient(uint256 projectId, address recipient) external // só owner no Registry; reverte NotProjectOwner/ZeroAddress; emite AppRecipientUpdated
```

### View

```solidity
function previewPay(uint256 projectId, uint256 amount) external view returns (uint256 fee, uint256 revShare, uint256 toApp)
function recentVolumeOf(uint256 projectId) external view returns (uint256)  // volume com decaimento exponencial (D4)
```
`recentVolumeOf` = volume não-self acumulado com meia-vida `volumeHalfLife` (aproximação: meias-vidas inteiras por shift + interpolação linear, erro máx ~6%, zera após 64 meias-vidas). Um wash em rajada evapora em poucas meias-vidas; sustentar um número falso exige pagar 2,5% dele a cada meia-vida.

## Eventos

| Evento | Emitido em |
|---|---|
| `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp, selfPayment)` | `pay` (`projectId`, `payer` indexados) |
| `VolumeHalfLifeUpdated(previous, current)` | `setVolumeHalfLife` |
| `FeeUpdated(previousBps, currentBps)` | `setFeeBps` |
| `FeeSplitUpdated(treasuryBps, buybackBps, grantsBps)` | `setFeeSplit` |
| `RecipientsUpdated(treasury, buyback, grants)` | `setRecipients` |
| `AppRecipientUpdated(projectId, recipient)` | `setAppRecipient` (`projectId` indexado) |

## Erros

`ZeroAddress`, `ZeroAmount`, `ProjectNotActive(projectId)`, `NotProjectOwner(projectId, caller)`, `FeeAboveCap(provided, cap)`, `SplitDoesNotSumTo10000(sum)`, `ZeroHalfLife`.

## Roles

| Role | Produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock`. |
| `GOVERNANCE_ROLE` | `CommunityTimelock` — `setFeeBps`, `setFeeSplit`, `setVolumeHalfLife` (maioria simples); `setRecipients` (supermaioria 75% — redireciona 100% da fee). |

`setAppRecipient` é gated pelo owner do projeto (rotação operacional), sem role e **sem timelock** — o `ownerRecipient` de 48h do `ProjectRegistry` não é consultado pelo router (`audit/economist/2026-09-23-conceptual-gaming-review.md` #12, pendente).

## Invariantes

- **Teto de fee (I4):** `feeBps <= FEE_BPS_CAP` sempre; até governança reverte com `FeeAboveCap`.
- **Split fechado:** `treasuryBps + buybackBps + grantsBps == 10000`; senão `SplitDoesNotSumTo10000`. O resíduo de arredondamento da fee vai para grants (`toGrants = fee - toTreasury - toBuyback`).
- **Projeto Active (I7):** `pay` exige `REGISTRY.isActive(projectId)`.
- **Distribuição exata:** `toApp = amount - fee - revShare`; nenhum CREDIT fica retido no router após `pay`.
- **Ordem/atomicidade:** fee → rev-share (transferência + `notifyRevenue`) → app, dentro de `nonReentrant`.

## Ver também

[ProjectFunding](07-ProjectFunding.md) · [ProjectRegistry](04-ProjectRegistry.md) · [CreditToken](02-CreditToken.md)
