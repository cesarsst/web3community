# CreditPSM

**Para quem é:** usuários e devs convertendo USDC ↔ CREDIT, auditores.
**Pré-requisitos:** [CreditToken](02-CreditToken.md), [FeeRouterV2](08b-FeeRouterV2.md).

## Visão rápida

Peg Stability Module do remodel 2026-07-08. Converte USDC ↔ CREDIT a **1:1, sem taxa**, nos dois sentidos:

- `buy(usdcAmount)` — deposita USDC, minta CREDIT 1:1 (conversão 6 → 18 decimais).
- `sell(creditAmount)` — queima CREDIT, devolve USDC 1:1 (18 → 6 decimais).

Com o PSM, **CREDIT deixa de ser ativo especulativo/deflacionário e vira trilho de pagamento estável**: todo CREDIT mintado por aqui é 100% lastreado no USDC retido no próprio contrato. Não existe **nenhuma** função de saque do lastro — nem para governança. Se a DAO quiser gastar, gasta da fee do [FeeRouterV2](08b-FeeRouterV2.md), nunca daqui.

O contrato não tem owner, roles próprias nem parâmetros ajustáveis — é imutável e sem superfície administrativa.

## Herança

```
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parâmetros e storage

| Nome | Tipo | Descrição |
|---|---|---|
| `CREDIT` | immutable | CreditToken (18 decimais) |
| `USDC` | immutable | Stablecoin de lastro (6 decimais em produção) |
| `SCALE` | immutable | Fator de conversão de decimais: `10^(18 - decimals(USDC))` = `1e12` para USDC |
| `mintedOutstanding` | `uint256` | CREDIT em circulação mintado por este PSM (18 decimais) |

O constructor reverte com `InvalidDecimals` se a stable tiver mais de 18 decimais.

## Roles e permissões

O PSM **não tem AccessControl**. Ele precisa, isso sim, de roles **no CreditToken**:

| Role (no CreditToken) | Por quê |
|---|---|
| `MINTER_ROLE` | `buy` minta CREDIT para o comprador |
| `BURNER_ROLE` | `sell` queima o CREDIT devolvido |

O burn é sempre sobre saldo **do próprio PSM** (após `transferFrom` do vendedor) — a role de burn nunca toca saldo de terceiros.

## Funções externas

### `buy(uint256 usdcAmount) → uint256 creditOut`

Compra CREDIT com USDC a 1:1.

- **Quem chama**: qualquer um. Exige `USDC.approve(psm, usdcAmount)` prévio.
- **Efeitos**: `USDC.safeTransferFrom(caller, psm)`, `mintedOutstanding += creditOut`, `CREDIT.mint(caller, creditOut, "psm:buy")`.
- **Retorno**: `creditOut = usdcAmount * SCALE` (18 decimais).
- **Reverte**: `ZeroAmount`.
- **Eventos**: `Bought(user, usdcIn, creditOut)`.
- **ReentrancyGuard**: sim.

### `sell(uint256 creditAmount) → uint256 usdcOut`

Resgata USDC devolvendo CREDIT a 1:1. O CREDIT devolvido é **queimado**.

- **Quem chama**: qualquer um. Exige `CREDIT.approve(psm, creditAmount)` prévio.
- **Efeitos**: puxa o CREDIT para o PSM, `CREDIT.burnByRole(psm, creditAmount, "psm:sell")`, decrementa `mintedOutstanding` (clamp em zero), `USDC.safeTransfer(caller, usdcOut)`.
- **Retorno**: `usdcOut = creditAmount / SCALE` (6 decimais).
- **Reverte**: `ZeroAmount`; `DustAmount` se `creditAmount` não for múltiplo de `SCALE` (poeira abaixo de 1e-6 USDC reverte em vez de ser confiscada); `InsufficientBacking` se o lastro USDC disponível for insuficiente.
- **Eventos**: `Sold(user, creditIn, usdcOut)`.
- **ReentrancyGuard**: sim.

### Views

- `backing() → uint256` — lastro USDC atual (6 decimais).
- `backingNormalized() → uint256` — lastro em 18 decimais, comparável a `mintedOutstanding`.

## Eventos

| Evento | Indexados |
|---|---|
| `Bought(user, usdcIn, creditOut)` | `user` |
| `Sold(user, creditIn, usdcOut)` | `user` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAmount()` | `amount == 0` em `buy`/`sell` |
| `DustAmount(amount, granularity)` | `sell` com valor não múltiplo de `SCALE` |
| `InsufficientBacking(requested, available)` | `sell` maior que o lastro USDC disponível |
| `InvalidDecimals(decimals)` | Constructor com stable > 18 decimais |

## Invariantes

- **I-PSM1 (lastro integral)**: `USDC.balanceOf(psm) >= mintedOutstanding` (em unidades normalizadas). Não existe função de saque do lastro — nem governança consegue drenar.
- **I-PSM2 (conversão exata)**: `buy` converte `usdc * 1e12`; `sell` exige múltiplo de `1e12`. Nenhuma poeira é confiscada — reverte.
- **Sem taxa**: 1:1 exato nos dois sentidos, sempre.
- **Burn só do próprio saldo**: `burnByRole` sempre sobre `address(this)`.

## Observações importantes

### `mintedOutstanding` é estimativa conservadora

Se alguém vende CREDIT vindo de outra origem (genesis/legado), `mintedOutstanding` pode ficar aquém do queimado — o contador faz clamp em zero em vez de reverter o resgate. O lastro real verificável é sempre `backing()`.

### Relação com o modelo antigo

No modelo pré-remodel, CREDIT era adquirido em DEX externa (pool CREDIT/USDC) e o preço flutuava com defesa de floor via FFP buyback. O PSM substitui esse trilho como via primária de entrada/saída: **1 CREDIT = 1 USDC, sempre, on-chain**. Pool de DEX e FFP ficam como legado — quem captura valorização do ecossistema agora é o GOV (via buyback financiado pela fee do FeeRouterV2).

---

**Ver também**: [FeeRouterV2](08b-FeeRouterV2.md), [ProjectFunding](16-ProjectFunding.md), [CreditToken](02-CreditToken.md).
