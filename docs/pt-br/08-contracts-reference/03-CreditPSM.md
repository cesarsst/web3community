# CreditPSM

**Para quem é:** devs/auditores.

Contrato: `contracts/CreditPSM.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Peg Stability Module: converte **USDC ↔ CREDIT a 1:1, sem taxa**. Pilar do remodel 2026-07-08 — CREDIT deixa de ser ativo especulativo e vira trilho de pagamento estável. Todo CREDIT mintado por aqui é 100% lastreado no USDC retido neste contrato.

- `buy(usdcAmount)`: usuário deposita USDC, recebe CREDIT 1:1 (mint).
- `sell(creditAmount)`: usuário devolve CREDIT (queimado), recebe USDC 1:1.

O lastro **nunca sai** por qualquer outra via — não existe função de saque, nem para governança. Exige `MINTER_ROLE` e `BURNER_ROLE` no [CreditToken](02-CreditToken.md).

Herança: `ReentrancyGuard`. Usa `SafeERC20`.

## Interface pública

### Immutables / storage

| Nome | Tipo | Descrição |
|---|---|---|
| `CREDIT` | `CreditToken immutable public` | Token CREDIT (18 decimais). |
| `USDC` | `IERC20 immutable public` | Stablecoin de lastro (assume 6 decimais). |
| `SCALE` | `uint256 immutable public` | Fator de conversão de decimais = `10 ** (18 - usdcDecimals)` (1e12 para USDC 6). |
| `mintedOutstanding` | `uint256 public` | CREDIT em circulação mintado por este PSM (18 decimais). |

### Constructor

```solidity
constructor(address credit, address usdc)
```
Lê `IERC20Metadata(usdc).decimals()`; reverte com `InvalidDecimals` se `> 18`. Calcula `SCALE`.

### Funções

```solidity
function buy(uint256 usdcAmount) external nonReentrant returns (uint256 creditOut)
```
Compra CREDIT com USDC a 1:1. `creditOut = usdcAmount * SCALE`. Puxa USDC via `transferFrom`, incrementa `mintedOutstanding`, chama `CREDIT.mint(msg.sender, creditOut, "psm:buy")`. Reverte `ZeroAmount` se `usdcAmount == 0`. Emite `Bought`.

```solidity
function sell(uint256 creditAmount) external nonReentrant returns (uint256 usdcOut)
```
Resgata USDC devolvendo CREDIT a 1:1. Exige `creditAmount` múltiplo de `SCALE` (poeira abaixo de 1e-6 USDC reverte). `usdcOut = creditAmount / SCALE`. Puxa o CREDIT para o PSM e queima do próprio saldo via `burnByRole`; decrementa `mintedOutstanding` (clamp em 0); devolve USDC. Emite `Sold`.

Reverte: `ZeroAmount` (creditAmount 0), `DustAmount` (não múltiplo de SCALE), `InsufficientBacking` (USDC insuficiente no contrato).

### Views

```solidity
function backing() external view returns (uint256)            // USDC.balanceOf(this), 6 decimais
function backingNormalized() external view returns (uint256)  // backing * SCALE, comparável a mintedOutstanding
```

## Eventos

| Evento | Emitido em | Indexados |
|---|---|---|
| `Bought(address user, uint256 usdcIn, uint256 creditOut)` | `buy` | `user` |
| `Sold(address user, uint256 creditIn, uint256 usdcOut)` | `sell` | `user` |

## Erros

| Erro | Quando ocorre |
|---|---|
| `ZeroAmount()` | `usdcAmount`/`creditAmount == 0` |
| `DustAmount(uint256 amount, uint256 granularity)` | `sell` com `creditAmount` não múltiplo de `SCALE` |
| `InsufficientBacking(uint256 requested, uint256 available)` | `sell` pediria mais USDC do que o lastro disponível |
| `InvalidDecimals(uint8 decimals)` | constructor com USDC de mais de 18 decimais |

## Roles

O PSM não expõe roles próprias. Depende de possuir, no `CreditToken`:

- `MINTER_ROLE` — para `CREDIT.mint` em `buy`.
- `BURNER_ROLE` — para `CREDIT.burnByRole` em `sell` (sobre o próprio saldo).

## Invariantes

- **I-PSM1 (lastro integral):** `USDC.balanceOf(this) >= mintedOutstanding` (em unidades normalizadas). Não existe **nenhuma** função de saque do lastro — nem para governança. Gastos da DAO vêm da fee do [FeeRouterV2](06-FeeRouterV2.md), nunca daqui.
- **I-PSM2 (conversão exata):** USDC tem 6 decimais, CREDIT 18. `buy` converte `usdc * SCALE`; `sell` exige múltiplo de `SCALE` — poeira reverte (`DustAmount`) em vez de ser confiscada.
- **Burn só do próprio saldo:** o `burnByRole` sempre incide sobre CREDIT já transferido para o PSM; a role nunca queima saldo de terceiros.
- **`mintedOutstanding` conservador:** clamp em 0 se alguém resgatar CREDIT de origem externa (genesis/legado), sem reverter o resgate.

## Ver também

[CreditToken](02-CreditToken.md) · [FeeRouterV2](06-FeeRouterV2.md) · [DevFaucet](12-DevFaucet.md)
