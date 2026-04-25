# Fase 1.1 do pivot CLP — `Treasury.executeBuyback` real (FFP)

Documento operacional da **primeira implementação** da Fase 1 do pivot
Credit Liquidity Protocol. A Fase 1.1 substitui o stub `executeBuyback` do
`Treasury` por um buyback-and-burn defensivo do **floor price**, conforme o
modelo **FFP (Floating com Floor Price defendido)** aprovado em
[`audit/economist/2026-04-24-credit-peg.md`](../../audit/economist/2026-04-24-credit-peg.md).

## 1. O que mudou

`contracts/Treasury.sol`:

- **Construtor passou de 1 arg para 3 args** —
  `Treasury(admin, creditToken, usdcToken)`. `creditToken` é obrigatório;
  `usdcToken == address(0)` é aceito como "não configurado" (buyback
  permanece desabilitado por construção). Em produção, `usdcToken` deve ser
  o USDC oficial da rede alvo. Ambos são **imutáveis**.
- **Storage adicional** ao final do contrato (sem proxy → re-deploy
  necessário). Storage layout pré-Fase-1.1 não tinha state vars próprias
  além das herdadas, então a adição é segura.
- **Nova função `executeBuyback(uint256 usdcAmount, uint256 minCreditOut)`**
  (substitui o stub anterior `executeBuyback(stable, amount, minOut, swapData)`),
  `onlyRole(GOVERNANCE_ROLE)` + `nonReentrant`.
- **Nova função `recordDailyPrice()`** permissionless com cooldown 22h.
- **Setters governance-only** para todos os parâmetros do FFP (com bounds
  sanitários — ver §4).

## 2. Roles + infra que precisam ser bootstrappadas

`Treasury.executeBuyback` queima o CREDIT comprado via
`ICreditTokenBurnable(CREDIT_TOKEN).burn(treasury, amount)`. Logo, o
`Treasury` **precisa do `BURNER_ROLE` no `CreditToken`**.

Isso é uma **proposta DAO separada** que precisa ser submetida antes do
primeiro buyback. Calldata:

```text
target   = CreditToken
calldata = grantRole(BURNER_ROLE, treasuryAddress)
```

Não foi escrita ainda — a Fase 0 (split default) tem prioridade.

Além disso, governance precisa setar via 4 propostas adicionais (ou uma
batched, dependendo da preferência operacional):

| Setter | Argumento | Origem |
|---|---|---|
| `setPriceOracle(ICreditPriceOracle)` | adapter de TWAP CREDIT/USD | `contracts/interfaces/ICreditPriceOracle.sol` (escrever adapter sobre Uniswap V3 pool) |
| `setSwapRouter(IUniswapV3SwapRouter)` | router Uniswap V3 oficial da rede | endereço público da Uniswap |
| `setSwapFeeTier(uint24)` | tier do pool CREDIT/USDC (default 3000 = 0.3%) | escolha da rede |
| `setChainlinkFeed(IChainlinkAggregator)` | feed Chainlink USDC/USD | endereço oficial Chainlink (ex.: Mainnet `0x8fF...`, Sepolia `0xA2F...`) |

Sem essas 4 chamadas + `BURNER_ROLE`, qualquer call a `executeBuyback`
reverte com `BuybackInfraMissing`. **É proposital** — fail-safe por padrão.

## 3. Como preparar a proposta DAO de `executeBuyback`

### 3.1. Pré-condições on-chain

Antes do governance disparar buyback, **estas 5 condições devem ser
verdadeiras**:

| # | Condição | Verificação |
|---|---|---|
| 1 | Spot CREDIT/USD < floor | `treasury.currentFloorPrice()` vs spot do oracle |
| 2 | `lastFloorBreachTimestamp` não-zero e `now - last >= triggerDurationSecs` | leitura on-chain do storage |
| 3 | Chainlink USDC/USD entre 0.99 e 1.01 (default) | `chainlinkUsdcFeed.latestRoundData()` |
| 4 | `usdcAmount <= capPerEventBps × usdcReserves / 10000` | leitura + cálculo |
| 5 | `monthlySpent[currentMonth] + usdcAmount <= capMonthlyBps × monthlyReservesSnapshot[currentMonth] / 10000` | leitura on-chain |

A breach checkpoint **só é marcada** quando alguém chama `recordDailyPrice()`
e o spot fica abaixo do floor. Logo, **`recordDailyPrice` precisa estar
sendo chamado regularmente** (idealmente diariamente, no mínimo a cada 22h
por causa do cooldown).

### 3.2. Bootstrap dos primeiros 90 dias do MA

Enquanto `dailyPriceCount < 90`, **MA90 é considerado "não bootstrapped"** e
o floor cai para apenas `floorAbsoluteUsd` (default $0.10). Isso é
intencional: protege contra ataque de manipulação no início da vida do
protocolo, quando ainda não há histórico.

**Plano operacional:**

1. Logo após o deploy do Treasury, governance configura os 4 setters de
   infra (ver §2).
2. Um **keeper externo** (script cron, Gelato, Chainlink Automation, etc.)
   chama `recordDailyPrice()` uma vez por dia.
3. Dia 90 após o primeiro registro: MA90 vira plenamente válido.
4. Dia ~91+: o multiplier `0.50 × MA90` passa a dominar o floor (assumindo
   preço > $0.20).

**Sanity check do keeper**: `lastDailyPriceRecordedAt` deve estar a no
máximo ~7 dias do `block.timestamp` em produção. Se ficar mais antigo, é
sinal de keeper morto e governance deve investigar antes de aprovar
buyback. **Não há kill-switch automático** — é uma observação operacional.

### 3.3. Calldata da proposta

```solidity
// target  = treasuryAddress
// value   = 0
// calldata = treasury.executeBuyback(usdcAmount, minCreditOut)
```

`minCreditOut` deve ser computado off-chain como
`(usdcAmount * creditPriceSpot) / (1 + slippageMaxBps/10000)` — ou seja, o
chamador aceita até 1% de slippage em relação ao TWAP. O router do
Uniswap V3 reverte se o output for abaixo desse valor.

## 4. Parâmetros do FFP — defaults e bounds

| Parâmetro | Default | Bounds (`ParamOutOfBounds` se fora) | Setter |
|---|---:|---|---|
| `floorMultiplierBps` | 5000 (0.50) | [3000, 8000] | `setFloorMultiplierBps` |
| `floorAbsoluteUsd` | 1e17 ($0.10) | [1e16, 1e19] ($0.01–$10) | `setFloorAbsoluteUsd` |
| `triggerDurationSecs` | 86400 (24h) | [1h, 7d] | `setTriggerDurationSecs` |
| `twapWindowSecs` | 1800 (30min) | [5min, 2h] | `setTwapWindowSecs` |
| `chainlinkSanityLowBps` | 9900 (0.99) | [9000, 9999] | `setChainlinkSanityLowBps` |
| `chainlinkSanityHighBps` | 10100 (1.01) | [10001, 11000] | `setChainlinkSanityHighBps` |
| `capPerEventBps` | 2000 (20%) | [100, 5000] | `setCapPerEventBps` |
| `capMonthlyBps` | 3000 (30%) | [100, 7000] | `setCapMonthlyBps` |
| `slippageMaxBps` | 100 (1%) | [10, 500] | `setSlippageMaxBps` |

Todos os setters são `onlyRole(GOVERNANCE_ROLE)`. Em produção, isso
significa que **só passam via Governor + Timelock**.

## 5. Cenários esperados

### 5.1. Spot crash 30%

- TWAP cai abaixo do floor.
- Próxima `recordDailyPrice` marca `lastFloorBreachTimestamp = now`.
- Governance espera 24h e prepara proposta de buyback.
- Voting period (~7 dias em prod) + Timelock (2 dias) → **execução
  ~10 dias depois do crash**. Isto é **intencional** — buyback impulsivo
  dentro de uma queda contínua é exatamente como Iron Finance / OHM
  morreram. O delay de governance é uma feature.

### 5.2. USDC despega

- Chainlink reporta < 0.99 ou > 1.01.
- `_enforceChainlinkSanity` reverte com `UsdcDepegDetected`.
- **Buyback fica indisponível enquanto USDC estiver despegado.** Correto:
  comprar CREDIT com USDC despegado é destruir reservas para defender o
  CREDIT, vetor de death spiral cruzado.

### 5.3. Keeper morre

- `recordDailyPrice` para de ser chamado.
- `lastFloorBreachTimestamp` fica congelado (não é resetado nem incrementado).
- Se o spot já estava abaixo do floor, governance pode chamar
  `recordDailyPrice` ela mesma (é permissionless) e prosseguir.
- Se o spot voltou acima do floor durante o silêncio, a primeira
  `recordDailyPrice` reseta `lastFloorBreachTimestamp = 0` e o cooldown de
  24h recomeça.

### 5.4. Reservas USDC esgotam

- `executeBuyback` reverte com `InsufficientBalance` quando
  `usdcAmount > usdc.balanceOf(treasury)`.
- Cap por evento (20% reservas) protege contra esgotar tudo num ataque.
- **Modo hibernação**: se reservas zerarem, o protocolo cai para o floor
  absoluto $0.10 e depende do burn-by-use orgânico (FeeRouter `burnBps`)
  para reduzir supply. Ver §3.7 do parecer FFP.

## 6. Checklist pós-deploy

- [ ] Treasury redeployado com construtor 3-arg.
- [ ] Proposta DAO concedendo `BURNER_ROLE` ao Treasury executada.
- [ ] Setters de infra executados (oracle, router, fee tier, chainlink
      feed).
- [ ] Keeper de `recordDailyPrice` rodando (cron diário).
- [ ] Dashboard monitorando `lastDailyPriceRecordedAt`,
      `dailyPriceCount`, `currentFloorPrice` vs spot real.
- [ ] Atualizar `CHANGELOG.md` movendo a entrada de Fase 1.1 de
      `[Unreleased]` para a versão publicada.
- [ ] Rodar simulação atualizada (`scripts/simulation/economicSim.ts`)
      com infra setada para confirmar que o flywheel de buyback fecha.

## 7. Caminhos sad

| Erro custom | Causa provável | Ação |
|---|---|---|
| `BuybackInfraMissing` | Algum dos 4 endereços de infra não setado | Submeter proposta de setter |
| `SpotAboveFloor` | Spot está acima do floor — buyback não justificado | Esperar nova breach |
| `BreachDurationInsufficient` | Spot caiu mas não passou 24h | Esperar mais |
| `UsdcDepegDetected` | USDC fora de [0.99, 1.01] | Esperar USDC voltar; investigar Chainlink |
| `ChainlinkStale` | Feed > 6h sem update | Investigar Chainlink |
| `CapPerEventExceeded` | Tentou comprar > 20% reservas | Reduzir `usdcAmount` ou submeter múltiplas propostas |
| `CapMonthlyExceeded` | Já gastou 30% no mês | Esperar próximo mês |
| `InvalidOraclePrice` | TWAP retornou 0 | Investigar pool |
| `RecordCooldownActive` | `recordDailyPrice` chamado < 22h após o anterior | Esperar |
| `AccessControlUnauthorizedAccount` | Caller sem `GOVERNANCE_ROLE` | Submeter via Governor |

## 8. Referências

- Contrato: [`contracts/Treasury.sol`](../../contracts/Treasury.sol).
- Interfaces: [`contracts/interfaces/ICreditPriceOracle.sol`](../../contracts/interfaces/ICreditPriceOracle.sol),
  [`contracts/interfaces/IUniswapV3SwapRouter.sol`](../../contracts/interfaces/IUniswapV3SwapRouter.sol),
  [`contracts/interfaces/IChainlinkAggregator.sol`](../../contracts/interfaces/IChainlinkAggregator.sol),
  [`contracts/interfaces/IUniswapV3Pool.sol`](../../contracts/interfaces/IUniswapV3Pool.sol),
  [`contracts/interfaces/ICreditTokenBurnable.sol`](../../contracts/interfaces/ICreditTokenBurnable.sol).
- Testes: [`test/Treasury.buyback.test.ts`](../../test/Treasury.buyback.test.ts).
- Parecer econômico: [`audit/economist/2026-04-24-credit-peg.md`](../../audit/economist/2026-04-24-credit-peg.md).
- Fase anterior: [`docs/governance/fase0-default-split.md`](./fase0-default-split.md).
