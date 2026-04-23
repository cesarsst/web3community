# Treasury

**Para quem é:** devs construindo integrações com a tesouraria, auditores.
**Pré-requisitos:** [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md).

## Visão rápida

Custódia multi-ativo da DAO. Recebe passivamente qualquer ERC-20 (e ETH via `receive`). Única via de saída é `GOVERNANCE_ROLE` — nenhum admin pode drenar fundos fora do ciclo de governança.

Sem função `deposit` — qualquer pagador usa `token.transfer(treasury, amount)` direto. Sem pause — poder unilateral de congelar seria vetor de captura.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`.

## Parâmetros e storage

Não há storage mutável. O contrato apenas custodia balances dos tokens que recebe.

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funções externas

### Governance-gated

#### `transfer(IERC20 token, address to, uint256 amount)`

Transfere ERC-20 do treasury para `to`.

- **Reverte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`.
- **Eventos**: `Transferred(token, to, amount)`.
- **ReentrancyGuard**: sim.

#### `batchTransfer(IERC20 token, address[] recipients, uint256[] amounts)`

Batch de transfers em um único token.

- **Reverte**: `ZeroAddress`, `ZeroAmount`, `ArrayLengthMismatch`, `EmptyBatch`, `InsufficientBalance`.
- **Eventos**: N × `Transferred` + 1 × `BatchTransferred(token, total, recipientCount)`.

#### `payRebates(IERC20 token, address[] apps, uint256[] amounts, uint256 round)`

Idêntico em mecânica a `batchTransfer`, mas com evento semântico `RebatesPaid` incluindo `round`.

- **Eventos**: N × `Transferred` + 1 × `RebatesPaid(token, round, total, appCount)`.

#### `executeBuyback(address stable, uint256 amountIn, uint256 minGovOut, bytes swapData)`

**Stub v1** — emite evento `BuybackRequested` mas **não** executa swap. Integração DEX virá em fase posterior.

- **Reverte**: `ZeroAddress` (stable), `ZeroAmount` (amountIn ou minGovOut).
- **Eventos**: `BuybackRequested(stable, amountIn, minGovOut, swapData)`.

#### `sweepETH(address payable to, uint256 amount)`

Saca ETH custodiado.

- **Reverte**: `ZeroAddress`, `ZeroAmount`, `InsufficientBalance`, `ETHTransferFailed`.
- **Eventos**: `ETHSwept(to, amount)`.

### `receive()`

Aceita ETH enviado diretamente. Emite `ETHReceived(sender, amount)`. Sem autorização — qualquer um pode doar ETH.

### Views

- `balanceOf(IERC20 token) → uint256` — wrapper sobre `token.balanceOf(this)`.

## Eventos

| Evento | Emitido em | Parâmetros indexados |
|---|---|---|
| `Transferred(token, to, amount)` | `_transfer` (usado por `transfer` e helpers) | `token`, `to` |
| `BatchTransferred(token, totalAmount, recipientCount)` | `batchTransfer` | `token` |
| `RebatesPaid(token, round, totalAmount, appCount)` | `payRebates` | `token`, `round` |
| `BuybackRequested(stable, amountIn, minGovOut, swapData)` | `executeBuyback` | `stable` |
| `ETHReceived(from, amount)` | `receive` | `from` |
| `ETHSwept(to, amount)` | `sweepETH` | `to` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Endereço zero em operação que exige válido |
| `ZeroAmount()` | Valor zero |
| `ArrayLengthMismatch()` | Arrays com tamanhos diferentes |
| `EmptyBatch()` | Arrays vazios |
| `InsufficientBalance(token, requested, available)` | Saldo insuficiente no token |
| `ETHTransferFailed()` | `call{value}` no destino falhou |

## Invariantes

- **I4 (Governance-only exit)**: toda saída de valor exige `GOVERNANCE_ROLE`. Em produção, esse papel é exclusivo do Timelock.
- **Sem pause**: não há função de emergency stop. Risco residual aceito em troca de descentralização.
- **CEI**: checks → (sem effects de storage, apenas evento antes) → interaction. Ver cada função.
- **ReentrancyGuard**: todas as saídas de valor.

## Observações importantes

### Por que não tem `deposit`

Treasury é um cofre, não um bookkeeper. Quem quiser enviar fundos usa `transfer` direto. Simplifica modelo mental e elimina superfície de ataque (permissões cruzadas).

### Por que `executeBuyback` é stub

Integração com DEX exige modelar:

- TWAP oracle para preço justo.
- Slippage máximo explícito.
- Resistência a frontrunning.
- Escolha entre Uniswap v3, Balancer weighted pools, etc.

A decisão responsável é uma fase separada. No v1, `executeBuyback` apenas registra intenção on-chain via evento — off-chain workers ou futuros contratos podem agir depois. A DAO pode aprovar buybacks via `transfer` manual enquanto isso (ex.: `transfer(stable, dex_router, amount)` com outra proposta para completar swap).

### Tokens não-standard

`SafeERC20` é usada em todas as saídas para tolerar tokens não-standard (USDC histórico não retorna bool em transfer, por exemplo). `forceApprove` poderia ser usada em integrações com approve, mas não há approve saindo do Treasury no v1 (não chama contratos externos que consomem allowance).

### Recebimento de ETH

`receive` tem `emit ETHReceived` — não é payable silencioso. Isso dá indexação off-chain de qualquer doação.

Construtor **não** é payable — não aceita ETH durante o deploy (sem justificativa para).

---

**Ver também**: [FeeRouter](08-FeeRouter.md), [UserSubsidy](12-UserSubsidy.md), [TeamVesting](11-TeamVesting.md).
