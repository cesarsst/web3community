# Fase 1.3 do pivot CLP — `LiquidityGauge` (incentivos LP)

Documento operacional da **terceira implementação** da Fase 1 do pivot
Credit Liquidity Protocol. A Fase 1.3 introduz o `LiquidityGauge` — um
**adapter** sobre o `UniswapV3Staker` canonico (Uniswap Foundation) que
distribui o **bucket de 25% da emissão de CREDIT** para LPs externos do
par CREDIT/USDC, com vesting linear de 14d para conter mercenary capital.

Parâmetros operacionais congelados em
[`audit/economist/2026-04-24-clp-pivot.md`](../../audit/economist/2026-04-24-clp-pivot.md)
**Anexo D**.

## 1. O que mudou

`contracts/LiquidityGauge.sol` (novo, ~960 linhas com NatSpec):

- **2 roles**: `GOVERNANCE_ROLE` (whitelist/denylist/pause/vesting params) e
  `REWARD_NOTIFIER_ROLE` (plural — `Treasury` manual via Timelock + futuro
  `RewardDistributor` automático, D.7).
- **Whitelist governance-tunable** de pools (D.1) — seed CREDIT/USDC 0.3%.
- **Stake mecanico** delegado ao `UniswapV3Staker` oficial (D.2). Gauge
  mantém ledger interno de "real owner" e repassa NFT via
  `safeTransferFrom` com `IncentiveKey` no calldata — staker faz auto-stake
  on receive.
- **Vesting linear 14d** (D.4) — `unstake()` cria uma `VestingPosition`
  (linear, 14d), `harvest()` saca a fração já vestida. `emergencyUnstake()`
  descarta o reward do ciclo atual mas **NÃO afeta vesting positions
  pré-existentes**.
- **Continuous emission** (D.5) — `notifyRewardAmount(poolId, amount,
duration)` cria uma incentive nova no staker. Modelo simplificado: 1
  incentive ativa por pool por vez (rollover via `endIncentive` +
  `notifyRewardAmount`).
- **Sem boost cap** (D.6) — meritocracia UniV3 nativa.
- **`pause()` + `emergencyUnstake()`** (D.8) — pause bloqueia entrada,
  unstake/harvest/emergencyUnstake sempre operacionais (IE10).
- **Denylist anti self-dealing** (D.9) — Treasury (POL) **NÃO** pode
  stakear no gauge para evitar protocolo pagar rewards a si mesmo.

`contracts/interfaces/IUniswapV3Staker.sol` (novo) — interface enxuta
(7 funções consumidas + struct `IncentiveKey`). Não importa de
`@uniswap/v3-staker` por incompatibilidade de pragma (0.7.6 vs 0.8.24).

`contracts/test/UniswapV3StakerMock.sol` (novo) — mock minimal do staker
que reproduz custodia de NFT, contabilidade de incentive, claim/rewards.
Helpers de teste: `accrueRewards`, `setForceFailUnstake`.

`contracts/test/NonfungiblePositionManagerERC721Mock.sol` (novo) — mock
**ERC-721 real** (herda OZ `ERC721`) para exercitar o flow
`safeTransferFrom` (user → gauge → staker → user). O mock previo
(`NonfungiblePositionManagerMock`) usado pelo Treasury POL **não** é
ERC-721, então não serve para os testes do gauge.

`test/LiquidityGauge.test.ts` (novo, 64 testes) — happy paths, vesting
linear t=0/7d/14d, múltiplas vesting positions, denylist (D.9), pause,
emergencyUnstake fail-safe, ordering CREDIT<USDC e CREDIT>USDC, e todos
os caminhos tristes de access control e validação.

## 2. Pré-requisitos antes do primeiro `notifyRewardAmount`

Em ordem:

1. **Treasury (POL) já bootstrappado** (Fase 1.2 completa). Pool
   CREDIT/USDC 0.3% deve ter `liquidity > 0` para que LPs externos consigam
   posições concentradas com confiança.
2. **Pool CREDIT/USDC inicializado** (com tick / sqrtPriceX96 já setado pelo
   bootstrap da Fase 1.2 — o `LiquidityGauge` **não toca** o pool diretamente,
   apenas o staker referencia).
3. **`UniswapV3Staker` canonico conhecido** na rede-alvo:
   - **Mainnet**: `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`
   - **Sepolia**: deploy próprio (não há staker oficial em Sepolia — usar
     CREATE2 com salt do projeto, ou deployar uma instância via factory).
   - **Outras L2s**: ver
     [docs.uniswap.org/contracts/v3-staker/deployments](https://docs.uniswap.org).
4. **NPM (NonfungiblePositionManager) canonico**:
   - **Mainnet**: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`
   - **Sepolia**: `0x1238536071E1c677A632429e3655c799b22cDA52`
5. **Treasury com saldo de CREDIT** suficiente para a primeira incentive
   (proposta DAO de bucketing manual antes da Fase 1.4 ir live).

## 3. Setup inicial (proposta DAO de bootstrap)

Sequência mínima de calls via Timelock:

1. **Deploy** `LiquidityGauge(admin=Timelock, creditToken, uniswapV3Staker,
positionManager)`. O construtor já concede
   `DEFAULT_ADMIN_ROLE + GOVERNANCE_ROLE` ao admin.
2. **`grantRole(REWARD_NOTIFIER_ROLE, treasury)`** — durante a Fase 1.3,
   Treasury é o notifier manual. Quando `RewardDistributor` for refatorado
   (Fase 1.4), governance concede o role também ao distributor sem mudar
   interface.
3. **`addPool(creditUsdcPoolAddr)`** — retorna `poolId = 1`. Pool fica
   `enabled` por default mas **sem incentive ativa** (precisa
   `notifyRewardAmount` antes do primeiro stake).
4. **`setDenylist(treasuryAddr, true)`** — D.9 enforcement crítico: POL
   não stakea no gauge. Recomendado adicionar também `Staking`,
   `RewardDistributor`, `FeeRouter` por defesa em profundidade.
5. **(opcional) `setVestingDuration(...)`** — default é 14 dias; ajustar
   apenas se a DAO escolheu valor diferente em [1d, 90d].

## 4. Bootstrapping da primeira incentive

Pré-condição: Treasury tem `REWARD_NOTIFIER_ROLE` e saldo de CREDIT
suficiente.

1. **Treasury aprova** `amount` de CREDIT para o `LiquidityGauge` (call
   `IERC20.approve(gauge, amount)`).
2. **Treasury chama** `gauge.notifyRewardAmount(poolId, amount, duration)`.
   - `duration` deve ser ≥ `INCENTIVE_DURATION_MIN` (1 hora). Em produção:
     `7 days` (alinhado a `BurnTracker.roundDuration`).
   - Gauge faz pull do CREDIT, aprova ao staker, e cria `IncentiveKey` com
     `startTime = block.timestamp` e `endTime = startTime + duration`.
3. **Staker** passa a creditar rewards proporcionalmente a
   `secondsInsideX128 × liquidity` para cada NFT staked. **POL é
   full-range, ganha menos por dólar do que LP concentrado** — comportamento
   esperado (D.3).

Rollover (após `endTime`):

1. **`endIncentive(poolId)`** — encerra a incentive expirada e devolve
   refund (rewards não distribuidos) para o gauge. Limpa
   `currentIncentiveHash`.
2. **`governanceRescueRewards(treasury, refund)`** — opcional, se a
   governança quer reciclar o refund para a próxima rodada.
3. **`notifyRewardAmount(poolId, newAmount, newDuration)`** — abre nova
   incentive. Stakers ativos da incentive antiga **continuam vestindo na
   antiga** até unstake; novos stakes vão para a nova.

## 5. Fluxo do usuário

1. **Pré: ter NFT V3 do par whitelistado.** Usuário cria posição
   concentrada via `NPM.mint(...)` — out of scope do gauge.
2. **Aprovação:** `NPM.setApprovalForAll(gaugeAddr, true)` (uma vez)
   ou `NPM.approve(gaugeAddr, tokenId)` (por NFT).
3. **Stake:** `gauge.stake(tokenId, poolId)`. NFT vai para o staker, comeca
   a acumular.
4. **Aguarda.** Rewards dependem de `secondsInsideX128 × liquidity`. LP
   fora de range não acumula.
5. **Unstake:** `gauge.unstake(tokenId)`. NFT volta. Rewards entram em
   `VestingPosition` linear de 14 dias.
6. **Harvest:** `gauge.harvest(user, maxAmount)`. Pode chamar quantas vezes
   quiser durante o vesting; cada chamada saca a fração ja vestida desde
   `startedAt`. Após 14d completos, `harvest(user, MaxUint256)` saca
   100% e remove a position do array.

## 6. Cenários operacionais

### 6.1 `emergencyUnstake` — fail-safe

`gauge.emergencyUnstake(tokenId)`:

- Funciona mesmo se o gauge estiver pausado.
- Devolve o NFT incondicionalmente.
- **Descarta** o reward acumulado do ciclo atual (saldo no staker para
  esse `address(this)`). O CREDIT vai parar no balance do gauge — pode ser
  resgatado depois via `governanceRescueRewards`.
- **NÃO afeta** `VestingPosition`s pré-existentes do usuário (ciclos
  anteriores continuam vestindo normalmente).

Use quando: bug suspeito no gauge ou no staker; precisa retirar NFT
imediatamente sem se preocupar com reward.

### 6.2 Pool removida da whitelist

`gauge.setPoolEnabled(poolId, false)`:

- Bloqueia novos `stake()` na pool.
- **NÃO afeta** stakes existentes — usuários podem `unstake`/`harvest`
  normalmente.
- **NÃO encerra** a incentive ativa — rewards continuam acumulando para
  os NFTs já staked até `endTime`.

### 6.3 Pause global

`gauge.pause()`:

- Bloqueia `stake()` em qualquer pool.
- `unstake()`, `harvest()`, `emergencyUnstake()`, `notifyRewardAmount()`,
  `endIncentive()` e setters de governança seguem operacionais (IE10).

### 6.4 Mudança de `vestingDuration`

`gauge.setVestingDuration(newDur)`:

- Bounds [1d, 90d].
- **Não retroativo**: positions já criadas mantém `endsAt` original.
  Apenas novos `unstake()` usam o novo valor.

## 7. Riscos conhecidos e mitigações

### R1. Two-sided risk POL/FFP buyback ↔ Gauge (D.9, Anexo C)

Cada `executeBuyback` da Fase 1.1 drena USDC do POL para comprar CREDIT.
Pool fica desbalanceado pró-USDC, preço sobe. **LPs externos full-range**
não são afetados em proporção (eles já têm exposição USDC). **LPs
concentrados** próximos ao floor (`$0.10`) podem sair de range se o
buyback for agressivo, **perdendo elegibilidade temporária a rewards**.

Mitigação: governance pode pausar buyback (Treasury) se observar drift
excessivo, ou diversificar buyback via `UniswapV3SwapRouter` em pools
externas. **A Fase 1.3 não introduz risco novo aqui** — apenas herda.

### R2. Mercenary capital com vesting 14d

LP entra 1 dia antes do snapshot, sai imediatamente após — captura
proporção desproporcional do reward de uma rodada de 7d. **Defesa**:
vesting de 14d significa que esse LP só tem direito a 1/14 do reward
no momento da saída; o resto fica preso na `VestingPosition` (que persiste
mesmo após `unstake`).

Possível bypass: LP unstake após 1 dia, espera 13 dias sem stakear,
harvest no dia 14. Resultado: capturou 1/14 ≈ 7.1% do total. Aceitável.

Bypass mais agressivo: LP unstake e re-stake imediatamente em ciclo
contínuo. Cada `unstake/stake` cria nova `VestingPosition` mas o NFT
fica fora de range no intervalo (alguns blocos), perdendo
`secondsInsideX128`. Custo de oportunidade real.

### R3. POL self-staking (D.9)

Treasury é denylisted no bootstrap. Se a denylist falhar (ex.: governance
remove por engano), Treasury poderia stakear o NFT POL e **diluir
rewards de LPs externos** (protocolo pagando rewards a si mesmo, sem
valor líquido criado).

Mitigação **defesa em profundidade**: denylist do gauge é a primeira
camada; uma segunda camada conceitual seria revogar `REWARD_NOTIFIER_ROLE`
de governance se Treasury for removido da denylist (impede que rewards
sejam emitidos enquanto self-dealing está possível).

### R4. LP fora de range não acumula rewards

Posição concentrada cujo range não intercepta o tick atual: zero
`secondsInsideX128`. Comportamento esperado (D.3, D.6) — LPs com range
ativo recebem mais por sustentar liquidez onde importa para o peg.

Mitigação: **UI deve mostrar status de range** (in-range / out-of-range)
e tempo previsto out-of-range para informar a decisão do LP.

### R5. Incentive overlap

`notifyRewardAmount` reverte se a pool já tem incentive ativa não
expirada. Modelo simplificado de 1 incentive por pool por vez (ver D.5
do Anexo D — "alternativa simplificada").

Mitigação: governance precisa esperar `endTime` da incentive atual antes
de criar a próxima. Para sobreposição (overlap intencional), Fase 2 pode
introduzir múltiplas incentives concorrentes — não é necessário na Fase 1.

## 8. Próximas decisões pendentes do user

1. **Confirmar endereço do `UniswapV3Staker` em Sepolia** — não há staker
   oficial; precisa decidir se vamos deployar instância própria ou esperar
   a Uniswap publicar (improvável no curto prazo).
2. **Aprovar valor inicial da primeira incentive** (~ 25% × emissão da
   primeira rodada). Default sugerido: configurar quando Fase 1.4 estiver
   pronta — Treasury manual no intervalo.
3. **Avaliar adicionar ERC-4626 wrapper** sobre `LiquidityGauge` para
   composability (yield aggregators podem stakear via vault wrapper).
   Out of scope da Fase 1.3 — registrar para Fase 2.

## 9. Invariantes reafirmadas (IE)

| IE     | Status | Comentário                                                              |
| ------ | ------ | ----------------------------------------------------------------------- |
| IE1    | OK     | Não toca α (alpha) — gauge é puramente de distribuição.                 |
| IE2    | OK     | Não toca floor.                                                         |
| IE4/4b | Aviso  | Validar split de bucket em Fase 1.4 (RewardDistributor refator).        |
| IE5    | OK     | `denylisted[Staking] = true` recomendado; Staking não stakea LP.        |
| IE6    | OK+    | Gauge **fortalece** IE6 (incentivo a liquidez incremental além do POL). |
| IE10   | OK     | `pause()` bloqueia entrada, não saída. `unstake/harvest` sempre OK.     |
