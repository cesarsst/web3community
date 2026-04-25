# Fase 1.2 do pivot CLP — `Treasury` POL (Protocol Owned Liquidity)

Documento operacional da **segunda implementação** da Fase 1 do pivot
Credit Liquidity Protocol. A Fase 1.2 transforma o `Treasury` em **LP
permanente** do pool CREDIT/USDC na Uniswap V3, dando substância ao floor
defendido pelo FFP da Fase 1.1 (sem liquidez no pool, `executeBuyback`
swappa contra book vazio).

Parâmetros operacionais congelados em
[`audit/economist/2026-04-24-pol-params.md`](../../audit/economist/2026-04-24-pol-params.md).

## 1. O que mudou

`contracts/Treasury.sol`:

- **Storage adicional** ao final do contrato (sem proxy → re-deploy
  necessário). Adiciona:
  - `INonfungiblePositionManager public positionManager` (mutável via
    `setPositionManager`, governance-only);
  - `uint256 public polTokenId` (NFT id da posição POL — `0` significa
    "ainda não seedada").
- **Constants `POL_TICK_LOWER = -887220`, `POL_TICK_UPPER = 887220`** —
  ticks "full range" no fee tier 3000 (tickSpacing 60).
- **Novas funções** (todas `onlyRole(GOVERNANCE_ROLE) + nonReentrant`,
  exceto views):
  - `addPOL(creditAmount, usdcAmount, amount0Min, amount1Min, deadline)` —
    primeira chamada cunha o NFT via `mint`; chamadas subsequentes usam
    `increaseLiquidity` no mesmo `polTokenId`.
  - `removePOL(liquidityAmount, amount0Min, amount1Min, deadline)` —
    `decreaseLiquidity` + `collect` em sequência. **Não queima o NFT** —
    a posição persiste com `liquidity == 0` para reuso.
  - `collectPOLFees(amount0Max, amount1Max)` — `collect()` puro para
    governance retirar fees acumuladas.
  - `polPosition()` view — retorna `(tokenId, liquidity, tickLower,
tickUpper, tokensOwed0, tokensOwed1)`.
  - `polTokensOrdered()` view — retorna `(token0, token1,
creditIsToken0)` para o proponente da DAO calcular `amount0Min` e
    `amount1Min` na ordem correta.
  - `setPositionManager(INonfungiblePositionManager)` — setter
    governance-only.
- **Eventos novos**: `POLAdded`, `POLRemoved`, `POLFeesCollected`. O setter
  reusa `BuybackInfraUpdated("positionManager", ...)`.
- **Custom error nova**: `POLNotInitialized()` (chamadas a remove/collect
  antes da primeira `addPOL`).

`contracts/interfaces/INonfungiblePositionManager.sol` — interface enxuta
(5 funções consumidas + structs). Não importa de
`@uniswap/v3-periphery` por incompatibilidade de pragma (0.7.6 vs 0.8.24).

## 2. Pré-requisitos antes do primeiro `addPOL`

Em ordem:

1. **Pool CREDIT/USDC criado e inicializado** (off-chain ou via call ao
   `UniswapV3Factory.createPool` + `IUniswapV3Pool.initialize(sqrtPriceX96)`).
   O preço inicial **não pode ser fixado pelo Treasury** — é decisão do
   bootstrap. Recomendação do parecer: $0.10/CREDIT (igual ao
   `floorAbsoluteUsd`), eliminando risco de preço inicial inflado que
   fura no primeiro swap. Cálculo do `sqrtPriceX96`:

   ```
   sqrtPrice = sqrt(price_token1_per_token0) * 2^96
   ```

   Atenção: se `CREDIT < USDC` (token0 = CREDIT), `price` é
   `USDC_per_CREDIT` em precisão de USDC/CREDIT respectivamente
   (USDC tem 6 decimais, CREDIT tem 18). A proposta DAO de seed deve
   incluir o cálculo na descrição.

2. **`setPositionManager(npm)`** chamado pelo Timelock.
   Endereço canônico do NPM Uniswap V3 (rede alvo):
   - Mainnet: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`
   - Sepolia: `0x1238536071E1c677A632429e3655c799b22cDA52`
   - Outras L2s: ver
     [docs.uniswap.org/contracts/v3/reference/deployments](https://docs.uniswap.org/contracts/v3/reference/deployments).

3. **Treasury com saldo de CREDIT e USDC suficientes**:
   - **CREDIT**: para o seed inicial, o Treasury precisa ter sido
     destinatário de um `mint` adicional (genesis foi inteiramente para
     o `RewardDistributor`). Esta é uma proposta DAO **separada**:
     - Calldata 1: `CreditToken.grantRole(MINTER_ROLE, treasury)`
     - Calldata 2: `Treasury.<custom-mint-helper>` — **pendência**: o
       Treasury não tem hoje um helper que minta CREDIT em si mesmo.
       Alternativa simples: a proposta usa `executeBatch` no Timelock
       passando como targets `(creditToken, treasury)` e calldatas
       `(grantRole MINTER_ROLE treasury, mint(treasury, amount, "pol-seed"))`,
       mas como `mint` exige que o caller tenha `MINTER_ROLE` e o caller é
       o Timelock, na verdade a ordem certa é:
       `(grantRole MINTER_ROLE timelock, mint(treasury, amount, "pol-seed"), revokeRole MINTER_ROLE timelock)` — tudo
       atomicamente.
   - **USDC**: bootstrap externo. Caminho recomendado pelo parecer:
     **OTC raise ($100k–$500k)**. Decisão do user pendente (ver §3
     do parecer `2026-04-24-pol-params.md`).

4. **Token ordering identificado off-chain**. Chame `polTokensOrdered()`
   antes de submeter a proposta — o retorno indica:
   - `token0` (menor address) e `token1` (maior address);
   - `creditIsToken0` (`true` se CREDIT < USDC).

   O proponente passa `amount0Min` e `amount1Min` na ordem do **pool**,
   NÃO na ordem CREDIT/USDC. Ex.: se `creditIsToken0 == false`,
   `amount0Min` aplica-se ao USDC e `amount1Min` ao CREDIT.

## 3. Sequência da proposta DAO de seed inicial

Single proposta atômica (Decisão 6 do parecer §6) executada via
`Timelock.executeBatch`:

```text
target[0]   = creditToken
calldata[0] = grantRole(MINTER_ROLE, timelock)

target[1]   = creditToken
calldata[1] = mint(treasury, creditAmount, "pol-seed-fase1.2")

target[2]   = creditToken
calldata[2] = revokeRole(MINTER_ROLE, timelock)

# (USDC já no Treasury — pré-bootstrap)

target[3]   = treasury
calldata[3] = addPOL(creditAmount, usdcAmount, amount0Min, amount1Min, deadline)
```

**Atomicidade é crítica** (parecer §6): se split em N propostas, atacante
de governança vê o `mint` autorizado e front-runs criando pool fake antes
de `addPOL`.

**Slippage para o seed inicial**: como o pool é criado virgem com preço
inicial conhecido, o slippage é zero — `amount0Min` e `amount1Min`
podem ser iguais a `amount0Desired`/`amount1Desired`. Em adições
subsequentes (após o pool ter histórico), calcular usando spot atual e
um buffer de ~0.5–1%.

## 4. Cenários de operação esperados

### 4.1. Spot crash (CREDIT cai 30%)

**O que acontece com o POL**:

- Range full → posição NÃO vira unilateral (continua provendo CREDIT e
  USDC nos dois lados em qualquer preço).
- Arbitrageurs vendem CREDIT no pool até equilibrar com pools externas
  → POL absorve CREDIT (acumula token0/1 dependendo de ordering) e
  libera USDC para os arbs.

**O que acontece com o FFP**:

- `recordDailyPrice` detecta breach e marca timestamp.
- 24h depois, governance pode propor `executeBuyback`: USDC do Treasury
  - (potencialmente) USDC liberado pelo POL via `collectPOLFees` →
    CREDIT (queimado).

**Risco a monitorar**: o `executeBuyback` swappa **contra a própria
posição POL**, consumindo o lado USDC dela. Cada buyback diminui a
profundidade futura — vide §8 do parecer ("two-sided risk").

### 4.2. Token deplete em buyback (USDC do POL drena)

Como acima: cada `executeBuyback` desbalanceia o POL para o lado CREDIT
(pool fica com mais CREDIT, menos USDC). Após N buybacks, o POL pode
ter `>80%` em CREDIT — **floor está bem defendido mas o protocolo
precisa "soltar"**:

- emitir mais CREDIT via novas rodadas de `RewardDistributor`;
- ou reduzir `floorMultiplierBps` (proposta governance);
- ou pausar buyback (não chamar `executeBuyback` por algumas rodadas).

Mitigação estrutural (Fase 3): **bonding** (BondDepository) repõe POL
sem custo de Treasury — bonders depositam USDC + CREDIT em troca de
bonds com desconto, e o LP token vai pra Treasury POL.

### 4.3. Spot rally (CREDIT sobe 5×)

**O que acontece com o POL**:

- Posição absorve USDC e libera CREDIT (arbs compram CREDIT do pool).
- Se CREDIT > floor, FFP fica adormecido (sem buyback).
- POL acumula USDC organicamente — saudável.

### 4.4. Coleta de fees mensal

Norma de governança (não codificada): a cada mês, governance propõe
`collectPOLFees(uint128.max, uint128.max)` para drenar fees acumulados
do NPM ao Treasury. Sem auto-compound (Decisão 4 do parecer §4).

## 5. Política de exit (Decisão 5 do parecer §5)

Implementada **fora** do `Treasury` (este contrato apenas exige
`GOVERNANCE_ROLE`):

- Adições (`addPOL`): proposta normal (50% quorum 4%).
- Remoções até 25% do POL (`removePOL` com liquidez ≤ 25%): proposta
  normal.
- Remoções **acima de 25%**: exigir **75% dos votos a favor** —
  threshold implementado via proposal type no `CommunityGovernor`
  (não no `Treasury`; **pendência de implementação** na Fase 2 ou via
  norma cultural até lá).

**Pendência operacional**: até o `CommunityGovernor` ter proposal types
diferenciados, o gate de supermaioria 75% é norma cultural — o
proponente declara explicitamente "remoção > 25%" na descrição da
proposta e holders rejeitam se quorum/supermaioria insuficientes.

## 6. Soft cap de 50% (Decisão 7 do parecer §7)

Sem hard cap on-chain (parecer recomenda travar resposta a crise).
Norma de governança documentada:

> Treasury busca participação de 30–50% do pool em estado estável; acima
> de 50% requer justificativa explícita na proposta.

Toda proposta `addPOL` deve incluir na descrição:

- `% participação atual do Treasury no pool`;
- `% projetada após o add`;
- justificativa se `> 50%`.

Dashboard externo (subgraph) deve expor `% POL` para auditoria pública.

## 7. Checklist pré-mainnet

- [ ] **[user]** Confirmar caminho de bootstrap USDC e tamanho do seed
      ($200k mínimo / $500k preferido — parecer Decisão 3).
- [ ] **[user]** Aprovar texto da proposta DAO de seed atômica (item §3
      acima).
- [ ] **[dao-economist]** Parecer separado sobre **two-sided risk POL/FFP**
      formalizando "POL decay rate" sob diferentes cenários de buyback
      (parecer §8).
- [ ] **[dao-dev]** Verificar se `CommunityGovernor` precisa de
      `castVoteWithReasonAndParams` ou proposal type diferenciado para
      gate de 75% (Decisão 5).
- [ ] **[dao-dev]** Adicionar cenário POL ao `economicSim.ts` para
      simular crash 30% e medir % de POL consumida.
- [ ] **[dao-docs]** Documentar política de governance norm para soft cap
      50% em `docs/pt-br/03-protocol-overview/treasury-pol.md`.
- [ ] **[security]** Revisar interface `INonfungiblePositionManager`
      contra a ABI canônica do NPM Uniswap V3 deployado em mainnet
      (4-byte selector match).

## 8. Pendências conhecidas

1. **Helper de mint pelo Treasury**: o Treasury não tem hoje uma função
   que minte CREDIT em si mesmo. A proposta de seed precisa usar
   `executeBatch` com 4 calldatas (grant + mint + revoke + addPOL). Se
   essa orquestração for considerada frágil, criar `Treasury.mintAndAddPOL`
   numa Fase 1.2.1 **com cuidado** (concentra MINTER_ROLE
   permanentemente — risco de captura).
2. **Pool initialization**: este contrato **não inicializa o pool**.
   Operacionalmente, o deploy pré-mainnet inclui:
   ```ts
   await uniswapFactory.createPool(token0, token1, 3000);
   const pool = await uniswapFactory.getPool(token0, token1, 3000);
   await IUniswapV3Pool(pool).initialize(sqrtPriceX96);
   ```
   Calldata exato deve fazer parte do mesmo proposal batch ou de uma
   proposta separada (admin do deploy faz `createPool + initialize`
   antes da proposta de seed; é permissionless no Uniswap V3).
3. **Two-sided risk não tem mitigação on-chain ainda**: §8 do parecer
   identifica que cada buyback drena USDC do POL assimetricamente. A
   defesa estrutural (bonding) chega só na Fase 3. Até lá: monitorar
   off-chain a composição do POL e pausar `executeBuyback` se POL ficar
   `>80%` CREDIT.

## 9. Referências

- Parecer principal:
  [`audit/economist/2026-04-24-clp-pivot.md`](../../audit/economist/2026-04-24-clp-pivot.md)
- Parecer FFP:
  [`audit/economist/2026-04-24-credit-peg.md`](../../audit/economist/2026-04-24-credit-peg.md)
- Parecer POL (parâmetros congelados):
  [`audit/economist/2026-04-24-pol-params.md`](../../audit/economist/2026-04-24-pol-params.md)
- Documento operacional Fase 1.1:
  [`fase1-1-buyback-ffp.md`](./fase1-1-buyback-ffp.md)
- Contratos modificados:
  - [`contracts/Treasury.sol`](../../contracts/Treasury.sol)
  - [`contracts/interfaces/INonfungiblePositionManager.sol`](../../contracts/interfaces/INonfungiblePositionManager.sol)
- Mock:
  [`contracts/test/NonfungiblePositionManagerMock.sol`](../../contracts/test/NonfungiblePositionManagerMock.sol)
- Testes:
  [`test/Treasury.pol.test.ts`](../../test/Treasury.pol.test.ts)
