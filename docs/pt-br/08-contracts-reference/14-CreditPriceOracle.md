# CreditPriceOracle

**Para quem é:** auditores, devs integrando o buyback FFP, keepers de `recordDailyPrice`.
**Pré-requisitos:** [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md), [Treasury (referência)](04-Treasury.md).

## Visão rápida

Adapter de produção do `ICreditPriceOracle`: deriva o **TWAP do CREDIT em USD** (18 decimais) a partir da pool Uniswap V3 CREDIT/USDC, convertendo USDC → USD via feed Chainlink USDC/USD. É o oracle **real** que o `Treasury` consome em `recordDailyPrice` e `executeBuyback` (antes o adapter só existia como mock de teste).

Desenho deliberado — **adapter burro e determinístico**:

- **SEM owner, SEM setters, SEM storage mutável** — toda a configuração é imutável no constructor. Se qualquer parâmetro precisar mudar (pool, feed, banda), deploya-se outro adapter e a governança aponta o novo endereço via `Treasury.setPriceOracle`.
- A **janela TWAP é parâmetro da chamada**: o `Treasury` passa o seu `twapWindowSecs` (default 30 min). O adapter não opina sobre o tamanho da janela — apenas rejeita zero.
- `peekTwapPrice` é implementada como `view` (restrição válida da interface não-view): nenhum estado interno é atualizado.

> **Nota de licença**: este contrato é **GPL-2.0-or-later** (o resto do repo é MIT). Contém um port fiel do `TickMath.getSqrtRatioAtTick` da Uniswap V3 (v3-core @ 0.7.6, GPL-2.0-or-later) para 0.8.24. A única adaptação é o bloco `unchecked` (o algoritmo depende de wrap-around controlado que o 0.8.x checaria) e o custom error no lugar de `require(..., 'T')`. `_quoteAtTick` segue o `OracleLibrary.getQuoteAtTick` da v3-periphery, usando `Math.mulDiv` do OpenZeppelin (512 bits) no lugar do `FullMath` da Uniswap.

## Pipeline de `peekTwapPrice`

1. `pool.observe([secondsAgo, 0])` → `tickCumulatives`.
2. Tick médio aritmético = `delta / janela`, arredondado para −∞ em deltas negativos não-divisíveis (convenção `OracleLibrary` da Uniswap — sem isso o preço enviesaria para cima).
3. Tick → `sqrtPriceX96` via port do `TickMath.getSqrtRatioAtTick`.
4. Cotação de 1 CREDIT inteiro em unidades brutas de USDC, tratando ambas as ordens `token0`/`token1` (ordem detectada no constructor via `pool.token0()`).
5. Escala USDC (6 dec em produção) → 18 dec (`USDC_TO_USD18_SCALE = 10^(18 - usdcDecimals)`).
6. Multiplica pelo preço Chainlink USDC/USD (staleness máx 6h + banda de sanidade fixa `[9900, 10100]` bps), para que o retorno seja **USD real** e não USDC nominal.
   - **Fallback explícito**: se o feed for `address(0)` no deploy, o adapter assume **1 USDC = 1 USD** (modo sem Chainlink, para redes onde o feed não existe — decisão deliberada de deploy).

## Herança

Nenhuma herança de contrato — implementa apenas a interface `ICreditPriceOracle`. Usa `IERC20Metadata` e `Math` do OpenZeppelin.

## Parâmetros e storage

### Constants

| Nome | Valor | Descrição |
|---|---|---|
| `BPS_DENOMINATOR` | `10_000` | Denominador de basis points |
| `CHAINLINK_MAX_STALENESS` | `6 hours` | Idade máxima da resposta do feed (mesmo valor do `Treasury`) |
| `CHAINLINK_SANITY_LOW_BPS` | `9900` (0.99) | Banda inferior de sanidade USDC/USD — **fixa** |
| `CHAINLINK_SANITY_HIGH_BPS` | `10_100` (1.01) | Banda superior — **fixa** |
| `MIN_TICK` | `-887272` | Tick mínimo Uniswap V3 |
| `MAX_TICK` | `887272` | Tick máximo Uniswap V3 |

> A banda de sanidade é **fixa por desenho** (adapter sem setters), espelhando os defaults do `Treasury`. O `Treasury` já aplica a própria banda (configurável) em `executeBuyback`; a checagem aqui é defesa em profundidade para `recordDailyPrice`, que não passa pelo `_enforceChainlinkSanity` do Treasury. Banda diferente ⇒ novo deploy.

### Immutables (constructor)

| Nome | Tipo | Descrição |
|---|---|---|
| `POOL` | `IUniswapV3Pool` | Pool Uniswap V3 CREDIT/USDC fonte do TWAP |
| `CREDIT_TOKEN` | `address` | Token CREDIT (base da cotação) |
| `USDC_TOKEN` | `address` | Token USDC (quote da cotação) |
| `CHAINLINK_USDC_FEED` | `IChainlinkAggregator` | Feed USDC/USD. `address(0)` = modo sem Chainlink (1:1) |
| `CREDIT_IS_TOKEN0` | `bool` | `true` se CREDIT é o `token0` da pool (detectado via `pool.token0()`) |
| `CREDIT_UNIT` | `uint128` | 1 CREDIT inteiro em unidades brutas (`10^decimals` do CREDIT) |
| `USDC_TO_USD18_SCALE` | `uint256` | Fator de escala USDC bruto → 18 dec (`10^(18 - usdcDecimals)`; USDC de produção: `10^12`) |

## Constructor

```solidity
constructor(address pool_, address credit_, address usdc_, address chainlinkUsdcFeed_)
```

- Valida que a pool realmente contém o par `{credit, usdc}` (em qualquer ordem) e detecta a ordem via `pool.token0()`.
- Lê os `decimals` de ambos os tokens UMA vez e congela os fatores de escala — decimals de ERC-20 são imutáveis na prática; se um token migrar, deploya-se outro adapter.
- `chainlinkUsdcFeed_ == address(0)` ativa o fallback 1 USDC = 1 USD (sem checagem de staleness/banda — usar apenas em redes sem o feed, decisão explícita de deploy).

- **Reverte**:
  - `ZeroAddress` se `pool_`, `credit_` ou `usdc_` for zero.
  - `PoolTokenMismatch(token0, token1)` se `(pool.token0(), pool.token1())` não corresponder a `{credit, usdc}`.
  - `UnsupportedDecimals(decimals)` se CREDIT ou USDC tiver mais de 18 decimais.

## Funções externas

### `peekTwapPrice(uint32 secondsAgo) → uint256 priceUsd18`

Retorna o TWAP do CREDIT em USD com 18 decimais para a janela `secondsAgo` mais recente. Implementada como `view` — o `Treasury` chama via CALL normal e funciona identicamente.

- **Reverte**:
  - `ZeroTwapWindow` se `secondsAgo == 0`.
  - `ObserveFailed(reason)` se a pool reverter no `observe` (ex.: `"OLD"` quando a cardinality do ring buffer de observações é insuficiente para a janela).
  - `InvalidTick(tick)` se o tick médio sair de `[MIN_TICK, MAX_TICK]`.
  - `InvalidChainlinkAnswer` / `ChainlinkStale` / `UsdcDepegDetected` conforme o estado do feed (apenas quando feed configurado).
- **Sem eventos** (view). **Sem storage** — não mantém estado.

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | Endereço zero em pool/credit/usdc no constructor |
| `PoolTokenMismatch(token0, token1)` | Par da pool não corresponde a `{CREDIT, USDC}` |
| `UnsupportedDecimals(decimals)` | Token com mais de 18 decimais |
| `ZeroTwapWindow()` | `secondsAgo == 0` (o Treasury nunca envia zero — bounds `[5min, 2h]`) |
| `ObserveFailed(reason)` | `pool.observe` reverteu (ex.: `"OLD"`) — bytes crus do revert anexados |
| `InvalidTick(tick)` | Tick médio fora de `[MIN_TICK, MAX_TICK]` — pool corrompida ou mock inválido |
| `ChainlinkStale(updatedAt, maxStaleness)` | Feed retorna dado stale |
| `InvalidChainlinkAnswer(answer)` | Feed retorna preço ≤ 0 |
| `UsdcDepegDetected(reportedAnswer, lowBound, highBound)` | Feed USDC/USD fora da banda `[9900, 10100]` bps |

## Invariantes

- **Imutabilidade total**: sem owner, sem setters, sem storage mutável. Troca de configuração ⇒ novo deploy + `Treasury.setPriceOracle`.
- **USD real, não USDC nominal**: a saída é multiplicada pelo preço Chainlink USDC/USD (ou 1:1 no fallback), então um depeg do USDC não passa silenciosamente como preço válido do CREDIT.
- **Defesa em profundidade**: a banda de sanidade fixa protege `recordDailyPrice`, que não tem a checagem do Treasury.
- **Convenção numérica**: `1e18 = $1.00`, `5e17 = $0.50` — mesma da interface `ICreditPriceOracle`.

## Observações importantes

### Por que a janela TWAP não é imutável

O adapter é agnóstico ao tamanho da janela — quem decide é o `Treasury` (`twapWindowSecs`, configurável em `[5min, 2h]`). Assim, ajustar a janela do buyback não exige re-deploy do oracle. O adapter só rejeita `secondsAgo == 0`.

### Modo sem Chainlink (fallback 1:1)

`CHAINLINK_USDC_FEED == address(0)` faz o adapter tratar 1 USDC = 1 USD sem checagem de staleness ou banda. É deliberado para ambientes (dev/testnet ou redes sem o feed oficial) onde o feed não existe. Em produção mainnet, o feed **deve** ser fornecido — caso contrário um depeg do USDC não seria detectado.

### Detecção de ordem do par

A ordem `token0`/`token1` é detectada no constructor via `pool.token0()` e congelada em `CREDIT_IS_TOKEN0`. `_quoteAtTick` usa esse flag para cotar 1 CREDIT em USDC na direção correta, sem depender de ordenação por endereço em runtime.

### Relação com o Treasury

- `Treasury.recordDailyPrice` lê `priceOracle.peekTwapPrice(twapWindowSecs)` — permissionless, cooldown 22h.
- `Treasury.executeBuyback` lê o mesmo valor para comparar spot vs floor.
- Enquanto `Treasury.priceOracle == address(0)`, ambos revertem com `BuybackInfraMissing` — o buyback fica desabilitado até a governança setar o adapter via `setPriceOracle`.

---

**Ver também**: [Treasury](04-Treasury.md), [CreditToken](02-CreditToken.md), [LiquidityGauge](13-LiquidityGauge.md).
