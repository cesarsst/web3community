# Changelog

Todas as mudanças notáveis neste projeto serão documentadas aqui. O formato segue
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) e a versionagem segue
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). A escolha desse
formato casa com o ciclo de entrega "um contrato por vez" da DAO: cada unidade
auditada gera uma linha clara em `Added`, correções viram `Fixed`, e endurecimentos
de segurança (invariantes, access control, static analysis) ficam em `Security`.

## [Unreleased]

### Added

- **`CreditPriceOracle` — adapter de producao do `ICreditPriceOracle` (FFP).**
  `contracts/CreditPriceOracle.sol` (novo, SPDX `GPL-2.0-or-later` por conter
  port do `TickMath.getSqrtRatioAtTick` da Uniswap v3-core, anotado no header):
  pipeline `pool.observe([secondsAgo, 0])` -> tick medio aritmetico
  (arredondado para -infinito, convencao OracleLibrary) -> exponenciacao
  binaria `1.0001^tick` em Q128 -> quote (port de `OracleLibrary.getQuoteAtTick`
  usando `Math.mulDiv` do OZ 5.x, com ramo Q128 para `sqrtRatio > uint128.max`)
  -> escala USDC->18 dec -> multiplicacao pelo Chainlink USDC/USD. Sem
  owner/setters: pool, credit, usdc, feed, ordem do par e fatores de escala
  sao todos `immutable` (troca = novo deploy + `Treasury.setPriceOracle`).
  Ordem token0/token1 detectada no constructor via `pool.token0()` e validada
  (`PoolTokenMismatch`); decimais lidos de `IERC20Metadata.decimals()`
  (> 18 reverte `UnsupportedDecimals`). Chainlink: staleness max 6h (igual
  `Treasury.CHAINLINK_MAX_STALENESS`), banda fixa `[9900, 10100]` bps
  (defesa em profundidade para `recordDailyPrice`, que nao passa pelo
  `_enforceChainlinkSanity` do Treasury); feed `address(0)` = fallback
  explicito 1 USDC = 1 USD. Tick medio validado em int56 contra
  `[MIN_TICK, MAX_TICK]` ANTES do cast para int24 (elimina truncamento
  silencioso do OracleLibrary canonico). Custom errors: `ZeroAddress`,
  `PoolTokenMismatch`, `UnsupportedDecimals`, `ZeroTwapWindow`,
  `ObserveFailed(bytes)`, `InvalidTick`, `ChainlinkStale`,
  `InvalidChainlinkAnswer`, `UsdcDepegDetected`. Suporte:
  `contracts/interfaces/IUniswapV3Pool.sol` ganha `token0()`/`token1()`;
  `contracts/test/UniswapV3PoolMock.sol` estendido de forma retrocompativel
  (`setTokens`, `setMeanTick`, `setRawTickCumulatives`, `observe` view);
  mock novo `contracts/test/ERC20DecimalsMock.sol` (decimals configuravel).
  Testes: `test/CreditPriceOracle.test.ts` com 25 testes — espelho exato de
  TickMath/getQuoteAtTick em bigint (asserts de igualdade exata, nao
  aproximada), CREDIT como token0 E token1, conversao 6->18 dec, bordas de
  tick, sanity Chainlink, e integracao Treasury completa (`setPriceOracle` +
  `recordDailyPrice` + bootstrap MA90 + `executeBuyback` real com burn).
- **Ignition — Fase F opcional: deploy da infra CLP Fase 1 via env vars.**
  `ignition/modules/Dao.ts` ganha `DEPLOY_CLP_PHASE1=true` (deploya
  `LiquidityGauge` + `RewardDistributorV2`, admin = Timelock; novos
  parametros `uniswapV3Staker`/`positionManager` com default ZeroAddress =
  revert fail-fast, mesmo padrao do `teamVestingBeneficiary`) e flag
  separada `DEPLOY_CLP_ORACLE=true` (deploya `CreditPriceOracle` com
  parametros `creditUsdcPool`/`usdcUsdFeed`; address(0) reverte no
  constructor — sem deploy silencioso quebrado; feed address(0) e valido).
  Env vars em vez de parametros pelo mesmo motivo documentado na Fase E
  (RuntimeValue sempre truthy impede branching build-time). NENHUMA role e
  concedida pelo modulo (MINTER_ROLE do V2, whitelist do gauge e
  `setPriceOracle` ficam para propostas DAO). Retorno do modulo ganha
  campos opcionais `liquidityGauge`/`distributorV2`/`creditPriceOracle`.

### Security

- **`CommunityGovernor` — supermaioria de 75% para propostas contendo
  `Treasury.removePOL`.** Implementa a politica de exit do POL registrada
  em `docs/governance/fase1-2-pol.md` (antes apenas norma social). Novos:
  `enum ProposalType { Standard, Supermajority }`, constante
  `REMOVE_POL_SELECTOR = Treasury.removePOL.selector` (= `0x6a71d4b3`,
  derivada pelo compilador — sincronia garantida), `TREASURY` immutable
  (3o argumento do constructor; `address(0)` aceito em dev = scan
  desativado), mapping `proposalRequiresSupermajority` e evento
  `ProposalTypeSet` (emitido em TODO propose, Standard e Supermajority,
  para indexacao). Override de `propose()` roda `super.propose` primeiro e
  depois escaneia targets+calldatas: `target == TREASURY &&
calldatas[i].length >= 4 && bytes4(calldatas[i]) == REMOVE_POL_SELECTOR`
  marca a proposta INTEIRA (batch misto contamina — evita diluir o
  requisito empacotando removePOL com calls populares; guard `length >= 4`
  evita falso-positivo do pad-a-zeros do `bytes4()`). Override de
  `_voteSucceeded`: Supermajority exige `forVotes > 0 && forVotes >= 3 *
againstVotes` (75% inclusivo dos votos decisivos For/Against, Abstain
  fora da razao como no CountingSimple; `forVotes > 0` fecha o edge 0/0
  com quorum so de Abstain). Conservador por design: ">25% do POL" nao e
  mensuravel no propose (liquidez muda entre propose e execute), entao
  TODA proposta com removePOL exige 75%. `ignition/modules/Dao.ts` passa
  `treasury` ao Governor (Treasury ja era deployado antes na fase A).
  ANTI-BYPASS de roles (review adversarial): o scan tambem marca como
  Supermajority QUALQUER call de gestao de roles do `IAccessControl`
  (`grantRole`/`revokeRole`/`renounceRole`; constantes
  `GRANT_ROLE_SELECTOR`/`REVOKE_ROLE_SELECTOR`/`RENOUNCE_ROLE_SELECTOR`)
  com target no TREASURY ou no proprio Timelock (`timelock()`) — sem
  isso, uma proposta de maioria simples poderia conceder
  GOVERNANCE_ROLE/DEFAULT_ADMIN_ROLE do Treasury (ou PROPOSER_ROLE do
  Timelock) a um terceiro que chamaria `removePOL` direto, refutando a
  garantia de 75% (em producao o Timelock detem DEFAULT_ADMIN_ROLE do
  Treasury, Dao.ts fase C.2). Nested calls continuam falhando no
  AccessControl (msg.sender nunca e o Timelock).
  Testes: `test/CommunityGovernor.supermajority.test.ts` (21 testes:
  74/26 Defeated vs 76/24 Succeeded, fronteira EXATA 75/25 Succeeded e
  75k-1wei Defeated, supermaioria na razao mas abaixo do quorum
  Defeated, quorum so com Abstain Defeated (guard `forVotes > 0`),
  anti-bypass grantRole/revokeRole/renounceRole no Treasury e no
  Timelock com fixture espelhando producao (DEFAULT_ADMIN do Treasury no
  Timelock + renuncia do deployer, execute real via queue + delay),
  grantRole em contrato terceiro continua Standard, batch misto,
  selector `transfer` continua Standard, wiring de selectors/TREASURY) +
  fixture de `test/CommunityGovernor.test.ts` atualizado para o novo
  constructor.
- **Segregacao on-chain de saldos reservados (`LiquidityGauge` +
  `Treasury`).** Invariantes que antes eram apenas comentario passam a
  ser enforced no lado das saidas:
  - `contracts/LiquidityGauge.sol`: novo ledger `totalVestingLocked`
    (incrementa em `_createVestingPosition`, unico ponto de criacao de
    vesting; decrementa em `harvest` pelo valor sacado, CEI).
    `governanceRescueRewards` nao pode mais drenar CREDIT reservado a
    vesting em curso: novo check `RescueExceedsUnreserved(available,
requested)` apos o `InsufficientBalance` original (ordem preservada);
    sentinel `type(uint256).max` agora transfere apenas o nao-reservado.
    Nova view `getUnreservedBalance()` (saturante em zero).
    `emergencyUnstake` (forfeit vira saldo nao-reservado, positions
    previas intactas) e a compactacao swap-and-pop de `harvest`
    verificados por teste — contador correto em ambos os caminhos.
  - `contracts/Treasury.sol`: `_enforceUnreservedCredit` aplicado em
    `transfer`, em `batchTransfer`/`payRebates` (sobre o TOTAL do batch —
    parcelas isoladas nao contornam) e em `addPOL` (saida generica de
    CREDIT do saldo livre; o bucket earmarkado usa `addPOLFromRefill`).
    Saidas de CREDIT nao podem mais invadir `polRefillBucket +
pendingGaugeRewards`: revert `TransferExceedsUnreservedCredit(
available, requested)`. Nova view `unreservedCreditBalance()`
    (saturante em zero). `addPOLFromRefill`/`flushPendingGaugeRewards`
    confirmados operando com unreserved == 0 (debitam o ledger antes das
    interactions, CEI ja correto). `sweepETH` fora do escopo (ETH);
    `executeBuyback` neutro em CREDIT (compra e queima na mesma tx).
  - `contracts/Treasury.sol` — lado das ENTRADAS tambem enforced (review
    adversarial): `depositPolRefill`/`depositPendingGaugeRewards` agora
    revertem com `DepositExceedsCreditBalance(reservedAfter,
creditBalance)` se a reserva total pos-deposito exceder o
    `balanceOf(CREDIT)` real. Sem isso, um depositor bugado/comprometido
    inflaria o ledger acima do lastro, `unreservedCreditBalance()`
    saturaria em 0 e TODA saida generica de CREDIT congelaria (DoS). O
    fluxo legitimo (V2 minta ANTES do deposit na mesma tx) nao muda.
  - `contracts/Treasury.sol` — valvulas anti-freeze/reciclagem (review
    adversarial): `flushPendingGaugeRewards` ganhou `amount` parcial
    (0 = ledger inteiro) e `poolId` explicito (0 = default de
    `setLiquidityGauge`; poolIds do gauge sao 1-based) — defesa contra o
    freeze por `IncentiveOverlap` quando o `RewardDistributorV2` recria
    incentives na pool default a cada `finalizeRound` (novo erro
    `PendingGaugeRewardsInsufficient`). Novas
    `writeDownPolRefillBucket`/`writeDownPendingGaugeRewards`
    (GOVERNANCE_ROLE, eventos `PolRefillWrittenDown`/
    `PendingGaugeWrittenDown`): reducao explicita e auditavel dos
    ledgers, liberando a parcela para o saldo livre — escape do freeze
    do gauge e reciclagem do bucket bonders, que cresce 5%/rodada sem
    contrapartida on-chain de USDC (a fatia `treasuryBps` do FeeRouter e
    denominada em CREDIT, nao USDC — NatSpec de `addPOLFromRefill` e
    comentario do split em `ignition/modules/Dao.ts` corrigidos).
  - Testes: `test/LiquidityGauge.segregation.test.ts` (10) +
    `test/Treasury.segregation.test.ts` (20: inclui enforcement dos
    depositos, agregacao dos dois ledgers e write-downs) +
    `test/Treasury.polRefill.test.ts` (23: flush parcial, poolId
    explicito, `DepositExceedsCreditBalance`).
- **`ChainlinkAggregatorMock` — decimals configuraveis (`setDecimals`).**
  `Treasury._enforceChainlinkSanity` e `CreditPriceOracle._usdcToUsd`
  leem `feed.decimals()` em runtime, mas o mock fixava 8 — a matematica
  de escala nunca era exercitada fora de 8 decimais.
  `test/CreditPriceOracle.test.ts` ganha 4 testes: feeds de 18 e 6
  decimais a $1.00 produzem preco IDENTICO ao de 8 dec, multiplicacao
  exata a $0.99 em 18 dec, e banda de sanidade (UsdcDepegDetected)
  normalizando bps corretamente em 18 e 6 dec.

### Changed

- **Fase 0 do pivot CLP aplicada aos parametros de deploy — split default
  70/20/10.** `ignition/parameters/production.json` e
  `ignition/parameters/dev.json` mudam `burnBps/treasuryBps/rebateBps` de
  `9500/0/500` para `7000/2000/1000` (decisao ratificada, pre-requisito
  C4 do parecer `audit/economist/2026-04-24-clp-pivot.md`). Os defaults
  inline de `ignition/modules/Dao.ts` tambem foram atualizados — deploys
  sem parameters JSON (testes ignition/e2e, scripts dev) usariam o split
  antigo, criando drift com a decisao ratificada. Testes ajustados para o
  split novo: `test/ignition/Dao.test.ts`, `test/e2e/FullLifecycle.test.ts`,
  `test/e2e/projectLifecycle.e2e.test.ts`,
  `test/e2e/stakingRewards.e2e.test.ts`,
  `test/e2e/governanceFlow.e2e.test.ts`;
  `test/governance/Fase0DefaultSplit.test.ts` agora seeda EXPLICITAMENTE
  o split antigo via parametros ignition, preservando o teste dos
  mecanismos da proposta `setDefaultSplit` com o mesmo calldata do script
  real.
- Docs publicas (`/docs`): traducao das 10 paginas multi-idioma que estavam
  como stub `status: needs-translation` apos o pivot CLP — paridade real
  alcancada entre pt-br, en e es (50/50/50 markdown). Arquivos traduzidos:
  `01-getting-started/03-glossary.md`, `02-core-concepts/04-rewards-distribution.md`,
  `02-core-concepts/07-treasury-and-fees.md`, `03-protocol-overview/01-architecture.md`,
  `03-protocol-overview/03-economic-flows.md`,
  `08-contracts-reference/{03-ProjectRegistry,04-Treasury,07-RewardDistributor,07b-RewardDistributorV2,13-LiquidityGauge}.md`.
  Conteudo cobre FFP buyback, POL, LiquidityGauge, bucket-aware split,
  ownerRecipient timelock 48h, fallback gauge paused e migration window
  V1->V2. Frontmatter `needs-translation` removido em todos. `npm run sync:docs`
  e `npm run typecheck` verdes; `npm run build` produz `DocsView` com
  conteudo final (1284kB JS contendo as 3 arvores).

### Security

- `RewardDistributor.MAX_ALPHA` reduzido de `1.1e18` (1.10) para `0.99e18`
  (0.99). Garante por construcao a invariante economica IE1 (`alpha < 1`
  permanente), eliminando o vetor de governanca inflacionaria identificado
  em `audit/economist/2026-04-22-consistency-audit.md` (C2). Faixa valida
  passa a ser `[0.5e18, 0.99e18]` tanto no construtor quanto em `setAlpha`.
  NatSpec da constante e de `setAlpha` atualizados; testes positivos do
  limite superior reconfigurados para `0.99e18`; casos que antes passavam
  em `1.05e18` / `1.10e18` agora asseguram revert com `InvalidAlpha` como
  cobertura de regressao.

### Changed

- Docs publicas (`/docs`): atualizacao multi-idioma para refletir o pivot
  Credit Liquidity Protocol (CLP, Fase 1.1-1.4). pt-BR como fonte de verdade
  reescrita a partir do codigo; en/es recriadas como stubs
  `status: needs-translation` com corpo identico ao pt-BR atualizado, para
  preservar paridade estrita de paths (52/52/52 arquivos). Alteracoes:
  - **Novos arquivos** em `08-contracts-reference/`:
    - `13-LiquidityGauge.md` — adapter sobre UniswapV3Staker, bucket LPs
      (25%), vesting linear 14d, denylist anti self-dealing.
    - `07b-RewardDistributorV2.md` — distributor bucket-aware (split
      stakers/LPs/apps/bonders), bounds individuais, IE12 assert, gauge
      paused fallback, ownerRecipient timelock 48h.
  - **Reescrita completa** de `08-contracts-reference/04-Treasury.md`:
    FFP buyback real (Fase 1.1) com TWAP+breach 24h+caps, POL com NFT
    custodiado (Fase 1.2), ledgers `polRefillBucket` e
    `pendingGaugeRewards` (Fase 1.4), 4 novas roles, 5 novas funcoes.
  - **Anotada** `08-contracts-reference/07-RewardDistributor.md` como
    V1 em modo claim-only durante migration window de 4 rounds; cutoff
    revoga `MINTER_ROLE`.
  - **Atualizada** `08-contracts-reference/03-ProjectRegistry.md` com
    `proposeOwnerRecipient` / `applyOwnerRecipient` /
    `cancelOwnerRecipient` (timelock 48h), constante
    `OWNER_RECIPIENT_TIMELOCK`, struct `PendingRecipientChange`.
  - **Atualizada** `02-core-concepts/04-rewards-distribution.md` com
    split em 4 buckets, bootstrap apps -> bonders, bucket-aware claim,
    fluxo LPs no gauge.
  - **Atualizada** `02-core-concepts/07-treasury-and-fees.md` removendo
    "buyback stub" e descrevendo FFP real, POL, refill loop, gauge
    fallback, recomendacao split `(7000, 2000, 1000)`.
  - **Atualizada** `03-protocol-overview/01-architecture.md` com
    diagrama incluindo LiquidityGauge + RewardDistributorV2 + FFP/POL,
    grafo de roles pos-CLP (REWARD_NOTIFIER plural,
    POL_REFILL_DEPOSITOR, GAUGE_FALLBACK_DEPOSITOR), tabela "quem chama
    quem" expandida com 8 fluxos novos.
  - **Atualizada** `03-protocol-overview/03-economic-flows.md` com
    o agente "LP" como 5o ator, 3 loops economicos do Treasury (FFP,
    POL refill, fallback gauge), invariante de saude expandida com
    MA90 e POL TVL.
  - **Atualizada** `01-getting-started/03-glossary.md` com 11 termos
    novos: Bonders, Bucket, CLP, FFP, LiquidityGauge, MA90,
    ownerRecipient, POL, polRefillBucket, RewardDistributorV2.
- `ignition/modules/Dao.ts` agora suporta deploy opcional de `TeamVesting`
  e `UserSubsidy` via env vars (`DEPLOY_TEAM_VESTING`, `DEPLOY_USER_SUBSIDY`),
  ambas default `false`. Motivacao: facilitar deploy all-in-one em
  dev/testnet quando beneficiarios e params estao definidos a priori (C3
  do parecer `audit/economist/2026-04-22-consistency-audit.md`). Defaults
  mantem o caminho de producao bit-compatible com a versao anterior
  (10 contratos); quando ativados, o modulo deploya ate 12 contratos.
  Usa env vars em vez de `m.getParameter<boolean>` porque parametros do
  Ignition resolvem so no deploy-time (retornam RuntimeValue sempre
  truthy em JS), impedindo branching na definicao do modulo. Novo bloco
  de testes "Phase E — Optional auxiliary deploys" em
  `test/ignition/Dao.test.ts` cobre os 3 cenarios (default off, UserSubsidy
  on, TeamVesting on) com invalidacao de cache de modulos para re-executar
  `buildModule` com env vars atuais.
- Typo em comentario de `ignition/modules/Dao.ts` corrigido: "Soma efetiva
  ~ 5.2M CREDIT" -> "~ 5M CREDIT" (valor exato 5_000_000e18 =
  9_600_000e18 - 4_600_000e18, ja derivado no bloco de calculo adjacente)
  — B4 do parecer.
- Docs publicas (`/docs`): traducao completa de `en/` e `es/` — varredura
  de residuos PT nos diagramas ASCII, comentarios em code fences e prosa;
  guard regulatorio reconfirmado nos tres locales.
- Docs publicas (`/docs`): marco i18n — pt-BR + en + es. Tres arvores
  paralelas em `docs/pt-br/`, `docs/en/` e `docs/es/` com paridade estrita
  (50 arquivos cada, mesmos paths relativos). pt-BR e a fonte de verdade
  (escrita a partir de `contracts/`); en e es sao traducoes espelhadas.
  `scripts/sync-docs.ts` agora descobre os tres locales, valida paridade
  de paths e aborta em drift. Rotas do vue-router aceitam segmento de
  locale (`/docs/:locale(pt-br|en|es)/:slug*`) com redirect default
  `/docs -> /docs/pt-br`. `DocsView.vue` le o locale da URL, filtra
  sidebar/prev-next/breadcrumb pelo locale corrente, expoe language
  switcher no header (PT/EN/ES) que preserva o slug ao trocar de idioma,
  e usa dicionario inline para labels de UI e de secao. Definicao do
  agente `dao-docs` (`.claude/agents/dao-docs.md`) a atualizar para
  refletir fluxo multi-idioma (ver Pendencias abaixo).
- Docs publicas (`/docs`): restruturacao completa em arvore didatica
  progressiva de 10 secoes (`01-getting-started/` ... `10-reference/`),
  seguindo padroes de Uniswap/Aave/Optimism. Inclui trilhas por persona
  (devs, usuarios, investidores), 12 arquivos em `08-contracts-reference/`
  (um por `.sol`, com `TeamVesting` e `UserSubsidy` antes ausentes da doc
  publica), e guias procedurais em `09-advanced/` (deep dives, mainnet
  deployment, modelo de seguranca). Frontend atualizado:
  `scripts/sync-docs.ts` agora faz walk recursivo preservando a arvore,
  `DocsView.vue` renderiza sidebar hierarquica + breadcrumb multi-nivel +
  prev/next no rodape + reescrita de links internos .md para rotas do
  vue-router. Rotas antigas (`/docs/01-governancetoken` etc.)
  substituidas por rotas limpas (`/docs/contracts-reference/governancetoken`).

### Added

- **Fase 1.4 do pivot CLP — `RewardDistributorV2` (bucket-aware split).**
  Reescrita do distributor de emissao para suportar split entre **4 buckets**
  por rodada — fecha o flywheel da Fase 1 (FFP + POL + Gauge + Bucket Split).
  Decisoes operacionais congeladas em
  `audit/economist/2026-04-24-clp-pivot.md` Anexo E (E.1-E.8). **Re-deploy
  paralelo** ao V1: V1 vira claim-only durante migration window de 4 rounds
  (governance revoga `MINTER_ROLE` no CREDIT do V1 apos cutoff).
  **Contratos**:
  - `contracts/RewardDistributorV2.sol` (novo): split default
    `[5500, 2500, 1500, 500]` (stakers/LPs/apps/bonders) tunavel via
    `setBucketBps` com bounds individuais (E.8: stakers >= 30%, LPs >= 5%,
    apps <= 25% IE4b, bonders <= 20%) e soma exata 10000. `finalizeRound`
    aplica formula V1 (`min(max(alpha*burn, floor), capMax)`) **antes** do
    split, depois distribui:
    - Stakers (lazy): pull-based via `claim`/`claimMany` consumindo
      `bucketEmissionByRound[round][BUCKET_STAKERS]` como base.
    - LPs (push): mint para self + `forceApprove` + `gauge.notifyRewardAmount`.
      Quando `gauge.paused()`, fallback para
      `Treasury.depositPendingGaugeRewards` (red flag E.3 #2 — sem fallback,
      pause do gauge travaria `finalizeRound` da rodada inteira).
    - Apps (push retrospectivo): loop em `1..totalProjects` com burn no
      round R-1 e mint direto para `REGISTRY.ownerRecipient(p)`. Em
      bootstrap (`totalBurnPrev == 0`), bucket apps redistribui para bonders.
    - Bonders (push earmark): mint para Treasury +
      `depositPolRefill` — refill earmarkado do POL na Fase 1, sera
      reciclado para `BondDepository` na Fase 3.
      Invariantes economicas reafirmadas: **IE3 fortalecida** (cap antes do
      split, nenhum bucket excede `bucketBps[i] × capMax`), **IE4b codificada**
      (`bucketBps[apps] <= 2500`), **IE12 criada** (soma dos 4 buckets ==
      `totalEmission` com tolerancia 3 wei via assert em `finalizeRound`).
  - 7 custom errors novos: `BucketBpsSumInvalid`, `BucketBpsOutOfBounds`,
    `EmissionMismatch`, `InvalidGaugeIncentiveDuration` (alem de reusar
    `RoundNotClosed`/`RoundAlreadyFinalized`/`OutOfOrderFinalize`/
    `InvalidAlpha`/`InvalidCapMax`/`AlreadyClaimed` etc do V1).
  - 8 eventos novos: `RoundFinalizedV2`, `BucketEmissionMinted`,
    `GaugePauseFallback`, `BucketBpsUpdated`, `Claimed`, `AlphaUpdated`,
    `CapMaxUpdated`, `GaugePoolIdUpdated`, `GaugeIncentiveDurationUpdated`.
  - **Interfaces novas**:
    - `contracts/interfaces/ITreasuryRewards.sol` — slim interface consumida
      pelo V2 (`depositPolRefill`, `depositPendingGaugeRewards`).
    - `contracts/interfaces/ILiquidityGaugeRewards.sol` — slim interface
      consumida pelo V2 e Treasury (`notifyRewardAmount`, `paused`).
- **Treasury — extensao Fase 1.4**: 2 novas roles
  (`POL_REFILL_DEPOSITOR_ROLE`, `GAUGE_FALLBACK_DEPOSITOR_ROLE`),
  ledgers `polRefillBucket` e `pendingGaugeRewards`, e 5 novas funcoes:
  - `depositPolRefill(amount)` — accumula bucket bonders no ledger
    contabil interno (CREDIT cunhado para o Treasury pelo V2 antes do call).
  - `addPOLFromRefill(creditAmount, usdcAmount, ...)` — drena o ledger
    casado com USDC do balance livre do Treasury para injecao em
    `polTokenId` (reusa `_orderTokens` + `_provisionLiquidity`). CEI:
    debita ledger ANTES da chamada externa (idempotencia em revert).
    Reverte com `PolRefillBucketInsufficient` se `creditAmount > polRefillBucket`.
  - `depositPendingGaugeRewards(amount)` — fallback contabil quando
    `gauge.paused()` no `finalizeRound` (red flag E.3 #2).
  - `flushPendingGaugeRewards(duration)` — drena ledger para o gauge via
    `notifyRewardAmount` apos despausar. Reverte com `LiquidityGaugePaused`
    se gauge ainda paused; `LiquidityGaugeNotSet` se `liquidityGauge` zero;
    `NoPendingGaugeRewards` se ledger vazio.
  - `setLiquidityGauge(gauge, poolId)` — configura destino do flush.
    Eventos novos: `PolRefillDeposited`, `PolRefillUsed`, `PendingGaugeDeposited`,
    `PendingGaugeFlushed`, `LiquidityGaugeSet`. Errors: `PolRefillBucketInsufficient`,
    `LiquidityGaugeNotSet`, `LiquidityGaugePaused`, `NoPendingGaugeRewards`.
- **ProjectRegistry — `ownerRecipient` com timelock 48h**: red flag E.3 #1
  do parecer (sem timelock, owner do projeto poderia hot-swap o recipient
  entre `finalizeRound` e indexacao off-chain, desviando o bucket apps
  inteiro). Implementa pattern `propose` -> aguarda `OWNER_RECIPIENT_TIMELOCK`
  (48h) -> `apply` permissionless. View `ownerRecipient(projectId)` retorna
  o recipient explicito ou faz fallback para `project.owner`. Funcoes:
  `proposeOwnerRecipient(projectId, newRecipient)` (only owner),
  `applyOwnerRecipient(projectId)` (permissionless apos `effectiveAt`),
  `cancelOwnerRecipient(projectId)` (owner OU governance — escape hatch).
  Eventos: `OwnerRecipientProposed`, `OwnerRecipientApplied`,
  `OwnerRecipientCancelled`. Errors: `OwnerRecipientTimelockActive`,
  `NoPendingOwnerRecipient`.
- **Mock novo**: `contracts/test/LiquidityGaugeRewardsMock.sol` — mock minimo
  da interface `ILiquidityGaugeRewards` para testes da Fase 1.4 (bypass do
  gauge real que tem dependencias pesadas com UniswapV3Staker + NPM canonico).
- **Testes novos**: 3 suites totalizando 71 tests:
  - `test/RewardDistributorV2.test.ts` (40 tests): construction bounds,
    `setBucketBps` com 4 bounds individuais + soma, finalize com 4 buckets
    distribuidos, IE12 (soma == totalEmission), apps mint para
    `ownerRecipient`, gauge paused -> fallback Treasury, bonders -> POL
    refill, claim usando bucket stakers (nao totalEmission), probation
    penalty, claimMany batch, previews, governance setters.
  - `test/Treasury.polRefill.test.ts` (18 tests): cobre `depositPolRefill`,
    `addPOLFromRefill` (CEI + integracao NPM), `depositPendingGaugeRewards`,
    `flushPendingGaugeRewards` (com gauge mock), `setLiquidityGauge`, gating
    de roles, errors.
  - `test/ProjectRegistry.timelock.test.ts` (13 tests): `ownerRecipient`
    fallback, propose com 48h delay, sobrescrita de pending, apply
    permissionless apos `effectiveAt`, revert antes do timelock, cancel
    pelo owner E pela governance, integracao com ownership transfer.
- **Coverage Fase 1.4**: V2 95% lines, Treasury 100% lines, Registry 100%
  lines. Suite total: 765 passing (anterior 694 + 71 novos), zero regressao.

- **Fase 1.3 do pivot CLP — `LiquidityGauge` (incentivos LP).** Adapter
  sobre o `UniswapV3Staker` canonico (Uniswap Foundation, mainnet
  `0xe34139463bA50bD61336E0c446Bd8C0867c6fE65`) que distribui o **bucket
  de 25% da emissao de CREDIT** para LPs externos do par CREDIT/USDC.
  Parametros operacionais congelados em
  `audit/economist/2026-04-24-clp-pivot.md` Anexo D (D.1–D.13).
  **Contratos**:
  - `contracts/LiquidityGauge.sol` (novo): adapter com 2 roles
    (`GOVERNANCE_ROLE` para whitelist/denylist/pause/vesting params;
    `REWARD_NOTIFIER_ROLE` plural para Treasury manual + futuro
    RewardDistributor automatico, D.7), whitelist governance-tunable de
    pools (D.1, seed CREDIT/USDC 0.3%), stake/unstake mecanico delegado
    ao staker oficial (D.2 — gauge mantem ledger interno do real owner e
    repassa NFT via safeTransferFrom com IncentiveKey no calldata, staker
    faz auto-stake on receive), reward proporcional a `liquidity in-range`
    (D.3, padrao staker oficial, secondsInsideX128), **vesting linear de
    14 dias** em `unstake()` (D.4 — `harvest(user, maxAmount)` saca a
    fracao ja vestida, suporta saque parcial e compactacao em-loco de
    positions exauridas; multiplas positions do mesmo user acumulam),
    `notifyRewardAmount(poolId, amount, duration)` cria nova incentive no
    staker (D.5 — modelo simplificado de 1 incentive ativa por pool por
    vez, rollover via `endIncentive` + nova notify), sem boost cap (D.6),
    `pause()/unpause()` bloqueia entrada mas mantem
    `unstake/harvest/emergencyUnstake` operacionais (D.8 + IE10),
    `emergencyUnstake(tokenId)` fail-safe sempre permitido que devolve
    NFT incondicionalmente e descarta reward do ciclo atual (mas NAO
    afeta VestingPositions in-flight), **denylist anti self-dealing**
    (D.9 — Treasury/POL nao pode stakear no gauge para evitar protocolo
    pagar rewards a si mesmo), `endIncentive(poolId)` apos expiry com
    refund para o gauge, `governanceRescueRewards(to, amount)` para
    drenar saldo orfao (refund + forfeits de emergencyUnstake).
    Implementa `IERC721Receiver` para aceitar NFT em ambos sentidos
    (gauge faz pull do user E recebe de volta do staker em
    `withdrawToken`).
  - 11 custom errors: `ZeroAddress`, `ZeroAmount`, `InvalidPool`,
    `PoolDisabled`, `NoActiveIncentive`, `Denylisted`, `StakeNotFound`,
    `NotStakeOwner`, `InvalidVestingDuration`, `InsufficientBalance`,
    `InvalidIncentiveDuration`, `IncentiveNotExpired`, `IncentiveOverlap`.
  - 10 eventos: `PoolAdded`, `PoolEnabledSet`, `RewardNotified`,
    `IncentiveEnded`, `Staked`, `Unstaked`, `EmergencyUnstaked`,
    `Harvested`, `VestingDurationSet`, `DenylistSet`, `RewardsRescued`.

  **Interface nova**:
  `contracts/interfaces/IUniswapV3Staker.sol` — 7 funcoes consumidas
  (`createIncentive`, `endIncentive`, `stakeToken`, `unstakeToken`,
  `claimReward`, `rewards`, `withdrawToken`) + struct `IncentiveKey`.
  Nao importa de `@uniswap/v3-staker` por incompatibilidade de pragma
  (0.7.6 vs 0.8.24); selectors validados contra ABI do staker canonico.

  **Mocks novos**:
  - `contracts/test/UniswapV3StakerMock.sol` — simula
    createIncentive/endIncentive/stake/unstake/claim/rewards/withdraw com
    contabilidade observavel. Helpers `accrueRewards(rewardToken, owner,
amount)` para injetar ganhos atribuiveis e `setForceFailUnstake(bool)`
    para exercitar try/catch em `emergencyUnstake`. Implementa
    `onERC721Received` espelhando o staker real (decoder de IncentiveKey
    em `data` faz auto-stake on receive).
  - `contracts/test/NonfungiblePositionManagerERC721Mock.sol` — mock
    **ERC-721 real** (herda OZ `ERC721`) com helper `mintTo(to, tokenId)`.
    Necessario para o flow `safeTransferFrom` (user -> gauge -> staker
    -> user); o `NonfungiblePositionManagerMock` previo (Fase 1.2) NAO e
    ERC-721 real entao nao serve para o gauge. Stubs das funcoes de
    `INonfungiblePositionManager` revertem com `NOT_IMPLEMENTED` para
    sinalizar uso indevido.

  **Testes**: `test/LiquidityGauge.test.ts` com 64 testes cobrindo
  constructor (zero addresses, roles), todos os setters governance-only,
  `notifyRewardAmount` (zero amount, duration <
  `INCENTIVE_DURATION_MIN`, unknown poolId, overlap, replacement apos
  expiry), `stake` (denylisted/D.9, paused, unknown pool, disabled pool,
  no active incentive, happy path com transferencia do NFT ao staker e
  registro do Stake), `unstake` (stake unknown, not owner, happy path com
  vesting position criada, zero rewards path), `emergencyUnstake` (forfeit
  de rewards, paused-still-works, vesting in-flight intacto, try/catch
  fail-safe quando staker reverte unstake), **vesting linear** (t=0d
  harvest 0, t=7d ~50%, t=14d 100%, partial cap, multiplas positions
  acumulam corretamente, harvest funciona pausado), `endIncentive` (gates
  de expiry e role, refund para o gauge), `governanceRescueRewards`
  (zero address, zero amount, amount > balance via `InsufficientBalance`,
  exact amount, max sentinel), token ordering CREDIT<USDC e CREDIT>USDC,
  e `onERC721Received` retorna selector canonico. **Coverage**:
  `LiquidityGauge.sol` 99.32% lines / 92.24% branches / 95.45% functions
  (linha unica nao coberta era `pendingRewardsAtStaker`, agora coberta);
  `IUniswapV3Staker.sol` 100%. Suite total **692 passing** (630 + 62
  novos antes de adicionar 2 testes de view -> 64), sem regressao.

  **Slither**: 0 high/medium atribuiveis. Achados informacionais:
  `reentrancy-benign` em `unstake` (escrita de VestingPosition apos call
  ao staker — protegido por `nonReentrant`, staker e contrato canonico
  trusted), `timestamp` em comparacoes de vesting/incentive (intencional,
  padrao do projeto com `not-rely-on-time: off` no solhint),
  `dangerous strict equality` em `== 0` (padrao aceitavel),
  `naming-convention` em `CREDIT_TOKEN`/`UNISWAP_V3_STAKER`/
  `POSITION_MANAGER` (consistente com `Staking.GOV_TOKEN` —
  `solhint-disable` inline), pragma OZ `^0.8.20` e dead-code de OZ
  identicos aos das fases anteriores.

  **Documentacao operacional**:
  `docs/governance/fase1-3-liquidity-gauge.md` — sequencia da proposta
  DAO de bootstrap (deploy gauge -> grantRole REWARD_NOTIFIER ao
  Treasury -> addPool(creditUsdcPool) -> setDenylist(treasury, true)
  para D.9 enforcement -> Treasury aprova CREDIT e chama
  notifyRewardAmount), pre-requisitos (POL ja bootstrappado da Fase 1.2,
  pool inicializado, staker canonico conhecido na rede-alvo), fluxo do
  usuario, cenarios (emergencyUnstake fail-safe, pool removida da
  whitelist drena ate unstake, pause global, mudanca de
  vestingDuration nao retroativa), riscos conhecidos
  (R1 two-sided risk POL/FFP/Gauge do Anexo C, R2 mercenary capital
  com vesting 14d, R3 POL self-staking defesa em profundidade,
  R4 LP fora de range, R5 incentive overlap), e proximas decisoes
  pendentes do user (endereco do staker em Sepolia — nao ha staker
  oficial; valor inicial da primeira incentive — Treasury manual ate
  Fase 1.4; ERC-4626 wrapper para composability — Fase 2).

  **Pendencias para o user**:
  (1) Confirmar plano de deploy do `UniswapV3Staker` em Sepolia (nao ha
  instancia oficial — deployar uma?);
  (2) Aprovar valor inicial da primeira incentive (proposta DAO manual
  ate Fase 1.4 RewardDistributor refator);
  (3) Avaliar se POL self-staking deve ter denylist secundaria (Staking,
  RewardDistributor, FeeRouter) por defesa em profundidade na proposta
  de bootstrap.

- **Fase 1.2 do pivot CLP — `Treasury` POL (Protocol Owned Liquidity).**
  Treasury vira LP permanente do pool CREDIT/USDC na Uniswap V3 (fee tier
  3000, full range), dando substancia ao floor defendido pelo FFP da Fase
  1.1 — sem liquidez no pool, `executeBuyback` swappa contra book vazio.
  Parametros operacionais congelados em
  `audit/economist/2026-04-24-pol-params.md`. **Contratos**:
  - `contracts/Treasury.sol` ganha 4 funcoes governance-only +
    nonReentrant: `addPOL(creditAmount, usdcAmount, amount0Min,
amount1Min, deadline)` (primeira chamada cunha NFT via
    `INonfungiblePositionManager.mint`, subsequentes usam
    `increaseLiquidity` no mesmo `polTokenId`); `removePOL(liquidity,
amount0Min, amount1Min, deadline)` (decreaseLiquidity + collect em
    sequencia, NAO queima o NFT — posicao persiste com liq=0 para
    reuso); `collectPOLFees(amount0Max, amount1Max)` (claim de fees
    para Treasury, sem auto-compound — Decisao 4 do parecer §4); e o
    setter `setPositionManager(npm)`.
  - 2 views novas: `polPosition()` (tokenId, liquidity, ticks, owed) e
    `polTokensOrdered()` (token0, token1, creditIsToken0) — esta
    ultima crucial para o proponente da DAO calcular `amount0Min`/
    `amount1Min` na ordem do pool (Uniswap V3 ordena tokens por
    address ascendente).
  - Storage adicional: `INonfungiblePositionManager public
positionManager`, `uint256 public polTokenId` (0 = nao seedada).
    Constants `POL_TICK_LOWER = -887220`, `POL_TICK_UPPER = 887220`
    (full range no fee tier 3000, tickSpacing 60).
  - 3 eventos novos: `POLAdded(tokenId, liquidity, creditAmount,
usdcAmount)`, `POLRemoved(tokenId, liquidityRemoved, amount0Out,
amount1Out)`, `POLFeesCollected(tokenId, amount0, amount1)`. Setter
    reusa `BuybackInfraUpdated("positionManager", ...)`.
  - 1 custom error nova: `POLNotInitialized()` (chamadas a
    `removePOL`/`collectPOLFees`/`polPosition` antes de `addPOL` inicial).
  - Helper interno `_orderTokens(creditAmount, usdcAmount)` retorna
    `(token0, token1, amount0, amount1)` corretos para o NPM
    independente de qual token tem endereco menor — testado com CREDIT
    < USDC E CREDIT > USDC.
  - Helper `_provisionLiquidity(...)` despacha entre `mint`/
    `increaseLiquidity` e helper `_approveNPM(...)` faz forceApprove
    set-and-reset. Ambos extraidos para manter `addPOL` <= 50 linhas
    (solhint function-max-lines).

  **Interface nova**:
  `contracts/interfaces/INonfungiblePositionManager.sol` — 5 funcoes
  consumidas (mint, increaseLiquidity, decreaseLiquidity, collect,
  positions) + 4 structs. Nao importa de `@uniswap/v3-periphery` por
  incompatibilidade de pragma (0.7.6 vs 0.8.24); selectors validados
  contra ABI canonica do NPM.

  **Mock novo**:
  `contracts/test/NonfungiblePositionManagerMock.sol` — simula
  mint/increase/decrease/collect/positions com ledger interno
  (`StoredPosition` por tokenId, distribuicao proporcional em
  decrease, transfer em collect). Helper de teste `accrueFees`
  injeta fees pendentes para exercitar `collectPOLFees`. Helpers
  `setForceSlippageRevert`/`setOverrideAmounts` para casos
  adversariais.

  **Testes**: `test/Treasury.pol.test.ts` com 31 testes cobrindo
  ciclo completo (add inicial -> add incremento -> collectFees ->
  removePOL parcial -> removePOL total), token ordering com CREDIT <
  USDC E CREDIT > USDC (fixture itera deploys de USDC mock ate
  satisfazer ordering desejada), todos os caminhos tristes
  (BuybackInfraMissing, POLNotInitialized, ZeroAmount,
  AccessControlUnauthorizedAccount, slippage do NPM repassado),
  verificacao de eventos com `withArgs`, e estado pos-operacao
  (polTokenId persiste apos full remove, balances do Treasury,
  approvals zerados). **Coverage**: `Treasury.sol` mantem 100% lines
  e funcs (90.56% branch, +0.x absoluto vs Fase 1.1);
  `INonfungiblePositionManager.sol` 100%. Suite total 630 passing
  (599 + 31 novos), sem regressao.

  **Slither**: 0 high/medium novos atribuiveis a esta mudanca. Os
  achados em `_provisionLiquidity` (reentrancy-no-eth com escrita
  de `polTokenId` apos `mint`) e em `polPosition`/`removePOL`
  (unused-return) sao falsos positivos justificados em comentarios
  inline — `addPOL` tem `nonReentrant`, `polPosition` e `view`, e
  os retornos ignorados de `decreaseLiquidity`/`positions` sao
  deliberados (decrease registra debito que `collect` saca; view
  ignora campos irrelevantes).

  **Documentacao operacional**:
  `docs/governance/fase1-2-pol.md` — sequencia da proposta DAO de
  seed atomica (grantRole MINTER_ROLE -> mint(treasury) -> revoke ->
  addPOL via Timelock.executeBatch), pre-requisitos (pool criado e
  initialized off-chain antes da proposta), token ordering, cenarios
  esperados (spot crash, token deplete em buyback two-sided risk
  §8 do parecer, spot rally), politica de exit (75% supermaioria
  para >25% — pendente de proposal type no Governor), soft cap 50%
  (governance norm, sem hard cap on-chain).

  **Pendencias para o user**:
  (1) Decidir caminho de bootstrap USDC e tamanho do seed inicial
  ($200k mínimo / $500k preferido);
  (2) Confirmar texto da proposta DAO atomica de seed;
  (3) Validar interface `INonfungiblePositionManager` contra a ABI do
  NPM canonico na rede alvo (selectors). NPM mainnet:
  `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`; Sepolia:
  `0x1238536071E1c677A632429e3655c799b22cDA52`.

- **Fase 1.1 do pivot CLP — `Treasury.executeBuyback` real (FFP).**
  Substitui o stub anterior por um buyback-and-burn defensivo do floor
  price segundo o modelo FFP (Floating com Floor Price defendido) do
  parecer `audit/economist/2026-04-24-credit-peg.md`. **Contratos**:
  refator profundo de `contracts/Treasury.sol` (986 LOC) — construtor
  passa de `(admin)` para `(admin, creditToken, usdcToken)` com ambos
  os tokens imutaveis; novo `executeBuyback(usdcAmount, minCreditOut)`
  governance-gated + nonReentrant que valida 5 pre-condicoes (spot <
  floor; breach >= 24h consecutivas; Chainlink USDC em [0.99, 1.01]
  com staleness < 6h; cap por evento 20% reservas; cap mensal 30%
  snapshot inicio do mes) antes de fazer swap UniV3 USDC->CREDIT e
  queimar o CREDIT recebido via `ICreditTokenBurnable.burn`; nova
  `recordDailyPrice()` permissionless com cooldown 22h alimentando ring
  buffer de 90 slots para MA90; 9 setters governance-only com bounds
  sanitarios para parametros do FFP (defaults congelados em
  `floorMultiplierBps=5000`, `floorAbsoluteUsd=1e17`,
  `triggerDurationSecs=24h`, `twapWindowSecs=30min`,
  `chainlinkSanity=[9900, 10100]`, `capPerEventBps=2000`,
  `capMonthlyBps=3000`, `slippageMaxBps=100`); novos custom errors
  (`BuybackInfraMissing`, `SpotAboveFloor`,
  `BreachDurationInsufficient`, `UsdcDepegDetected`, `ChainlinkStale`,
  `CapPerEventExceeded`, `CapMonthlyExceeded`,
  `RecordCooldownActive`, `ParamOutOfBounds`, `InvalidOraclePrice`,
  `InvalidChainlinkAnswer`); eventos `BuybackExecuted`,
  `DailyPriceRecorded`, `BuybackParamsUpdated`,
  `BuybackInfraUpdated`. **Interfaces minimas pinadas**:
  `contracts/interfaces/ICreditPriceOracle.sol`,
  `contracts/interfaces/IUniswapV3Pool.sol`,
  `contracts/interfaces/IUniswapV3SwapRouter.sol`,
  `contracts/interfaces/IChainlinkAggregator.sol`,
  `contracts/interfaces/ICreditTokenBurnable.sol` — todas com surface
  enxuta (so funcoes consumidas) para evitar dependency hell de
  `@uniswap/v3-*`. **Mocks de teste**:
  `contracts/test/UniswapV3PoolMock.sol`,
  `contracts/test/UniswapV3SwapRouterMock.sol`,
  `contracts/test/ChainlinkAggregatorMock.sol`. **Cobertura**: 35
  testes em `test/Treasury.buyback.test.ts` (constructor + infra,
  bounds dos 9 setters, recordDailyPrice + ring buffer + cooldown,
  happy path, 13 caminhos sad cobrindo cada precondicao,
  rollover de mes); suite completa do projeto subiu para 599 testes
  passando (de 568). `Treasury.test.ts`, `CommunityGovernor.test.ts`,
  `FeeRouter.test.ts` adaptados para o construtor 3-arg passando
  `creditToken` real e `usdcToken=address(0)` (buyback FFP fica
  desabilitado por construcao quando USDC nao configurado — ver
  NatSpec do construtor). **Ignition**: `ignition/modules/Dao.ts`
  expoe parametro `usdcAddress` (default `address(0)` aceito em
  dev/testnet; producao deve sobrescrever via
  `ignition/parameters/production.json` apontando para o USDC
  oficial). **Slither**: limpo (so detecta padroes ja existentes do
  projeto — `timestamp` em comparacoes intencionais, `low-level-calls`
  em `sweepETH`, `naming-convention` para imutaveis, `missing-inheritance`
  informacional). **Documentacao**:
  `docs/governance/fase1-1-buyback-ffp.md` (runbook operacional com
  pre-condicoes, bootstrap dos 90 dias do MA, parametros e bounds, 4
  cenarios esperados, checklist pos-deploy, caminhos sad). **Esta
  entrada documenta a IMPLEMENTACAO em codigo**; o ciclo de
  governanca (concessao de `BURNER_ROLE`, setters de infra, primeira
  proposta de buyback) sera disparado em propostas separadas quando o
  user decidir submeter.
- `scripts/governance/propose-fase0-default-split.ts`,
  `scripts/governance/execute-fase0-default-split.ts`,
  `test/governance/Fase0DefaultSplit.test.ts` e
  `docs/governance/fase0-default-split.md` — pacote operacional da **Fase 0
  do pivot CLP**: proposta DAO unica que executa
  `FeeRouter.setDefaultSplit({burnBps: 7000, treasuryBps: 2000, rebateBps: 1000})`,
  destravando o pre-requisito C4 (Treasury sem receita recorrente) do
  parecer `audit/economist/2026-04-24-clp-pivot.md`. O script de propose
  tem modo `DRY_RUN=true` (imprime calldata + proposalId computado via
  `Governor.hashProposal` sem submeter); o script de execute identifica
  automaticamente o estado da proposta e executa a transicao apropriada
  (`Succeeded -> queue`, `Queued+ETA maturado -> execute`, `Executed -> noop`).
  Teste de integracao cobre o ciclo completo (propose → vote → queue →
  execute → verifica `defaultSplit() == (7000, 2000, 1000)` + evento
  `DefaultSplitUpdated`), sobrescrita do split antigo e caminho triste
  (proposer sem voting power -> `GovernorInsufficientProposerVotes`).
  Nenhum contrato Solidity foi alterado — a proposta usa a funcao
  `setDefaultSplit` ja existente. **Esta entrada documenta a PREPARACAO
  da proposta**; a execucao on-chain real movera esta entrada para a
  versao publicada quando o user disparar o ciclo via Governor. Modelo de
  peg adotado: FFP (`audit/economist/2026-04-24-credit-peg.md`).
- `contracts/test/ReentrantCallMock.sol` — ERC-20 malicioso generico que
  durante `_update` executa um `call(target, data)` arbitrario. Permite
  armar reentradas cross-function sem precisar de um mock especifico por
  alvo; substitui o padrao um-mock-por-funcao usado anteriormente e
  generaliza a cobertura defense-in-depth dos `nonReentrant`.
- `contracts/test/ReentrantCreditMock.sol` — mock da ABI minima de
  `CreditToken.mint(address,uint256,string)` usado como impostor de
  CREDIT no `RewardDistributor` para exercer o `nonReentrant` de
  `claim` / `claimMany`. Em producao o `CreditToken` real nao tem
  callback; o mock injeta a reentrada necessaria para auditar o guard.
- Testes de reentrancia (defense-in-depth) cobrindo branches ate entao
  descobertos:
  - `Treasury.batchTransfer` / `payRebates` / `executeBuyback` (linhas
    214 / 236 / 271): cross-function reentry disparada durante
    `Treasury.transfer` via `ReentrantCallMock`. `ReentrancyGuard`
    compartilha `_status` entre todas as funcoes `nonReentrant`, o que
    cobre inclusive o `executeBuyback` que nao tem call externo natural.
  - `UserSubsidy.claim` / `closeCampaign` (linhas 288 / 331): mock
    passado como `credit_` no construtor — armado com reentradas para
    `claim` e `closeCampaign` durante o `safeTransfer` interno.
  - `RewardDistributor.claim` / `claimMany` (linhas 389 / 408): deploy
    com `ReentrantCreditMock` no lugar do `CREDIT`; durante `mint`
    (chamado apos marcar `claimed = true`) o mock tenta reentrar.
    Branch coverage pos-testes: `contracts/` (sem mocks) = 99.15%, sendo
    `Treasury.sol`, `UserSubsidy.sol` e `RewardDistributor.sol` todos
    em 100% de branches cobertas.
- `.prettierignore` — adicionados `.claude/` e `ignition/deployments/`
  para silenciar ruido permanente em `npm run format:check` (settings
  do agente e artefatos auto-gerados do Ignition, respectivamente).
- Teste `UserSubsidy.isEligible` cobrindo branch "cap reached" — valida
  que a view retorna `false` mesmo com proof valido quando
  `c.claimed >= c.maxClaims`, simetrico ao `CapReached` do `claim`.
  Sobe branch coverage do contrato de 94% para 95%.
- Teste `RewardDistributor.previewEmission` cobrindo branch "clamps to
  capMax" em rodada NAO finalizada — com capMax reduzido para 100k e
  alpha\*burn ~ 950k, a view retorna exatamente `capMax`. Sobe branch
  coverage do contrato de 95.74% para 96.81%.

### Security

- Upgrade para `hardhat@3` + `@nomicfoundation/hardhat-toolbox@7` foi
  TENTADO e revertido (backup previo de `package.json`,
  `package-lock.json` e `hardhat.config.ts`). Motivos:
  `hardhat-toolbox@7` e um pacote stub que apenas avisa "instale `hh2`
  ou migre" — o ecossistema Hardhat 3 requer migracao ESM (`"type":
"module"`), reescrita de `hardhat.config.ts` para `.mts`, substituicao
  do toolbox por plugins individuais, ajustes na API de `hre.ethers` /
  chai matchers, e re-auditar compatibilidade de `solidity-coverage`. O
  escopo excede o gate de rollback (>20 arquivos afetados). O upgrade
  reduzia `npm audit` de 41 vulns (7 high) para 13 vulns (2 high) — as
  2 high restantes sao `lodash` / `lodash-es` via
  `@nomicfoundation/ignition-core@3.x` (upstream ainda nao fixou).
  PENDING: reavaliar quando o ecossistema Hardhat 3 estabilizar — em
  particular quando `@nomicfoundation/hardhat-toolbox-viem` ou o
  substituto oficial tiver maturidade e `solidity-coverage` confirmar
  suporte a HH3. As 7 vulns high permanecem em dependencias dev-only
  (`hardhat` CLI, `mocha`, `solidity-coverage`, `eth-gas-reporter`,
  `lodash`, `serialize-javascript`, `undici`) — nenhuma toca o bytecode
  dos contratos nem e embarcada em runtime de producao.

### Fixed

- `test/TeamVesting.test.ts` — troca `time.increaseTo(t)` por helper
  `mineAt(t) = setNextBlockTimestamp(t) + mine()` nos testes de
  cronograma que leem views imediatamente apos avancar o tempo. Remove
  drift de 1s entre o bloco minerado e o contexto do `eth_call`
  subsequente que causava flakiness no teste "returns frozen vested
  after revoke" (diff de ~198 tokens em 25M pela formula linear
  `vested = total * (t - start) / duration` com DURATION de 4 anos).
  5 runs consecutivos verdes pos-fix.

## [0.1.0] - 2026-04-19

### Added

- `contracts/TeamVesting.sol` — cofre de vesting linear com cliff para
  distribuir GOV a UM beneficiario do time. Padrao single-beneficiary
  deploy-per-membro (isola revogacao: se alguem sai, a DAO revoga so
  aquela instancia). Formula OZ padrao: `vested(t) = total * (t - start)
/ duration`, zero antes do cliff, hockey-stick no cliff, pull-based
  via `release()` (qualquer caller, fundos sempre ao `beneficiary`).
  `revoke()` one-shot `onlyOwner` (Timelock em prod via Ownable2Step):
  congela fronteira em `totalAllocatedAtRevoke = vestedAmount(now)` e
  devolve unvested ao `returnTo` (Treasury) — nao transfere
  automaticamente o vested-unreleased pro beneficiary (separacao
  intencional da UX "pull"). Transfers extras pos-revoke NAO aumentam
  vested. Suite `test/TeamVesting.test.ts` com 29 testes verdes:
  construcao + guards, cronograma (antes/no/apos cliff, checkpoints
  1/4-1/2-3/4-full), release happy/cumulative/anyone-can-call, revoke
  em 3 timings (pre-cliff/mid/pos-duration) + one-shot + extra-tokens,
  Ownable2Step transfer 2-passos, totalAllocation view.
- `contracts/UserSubsidy.sol` — distribuidor de CREDIT para primeiros
  usuarios dos apps via Merkle drops com cap de claims. Subsidia
  DEMANDA (nao oferta) durante o bootstrap (~6 meses). Campanhas
  multiplas simultaneas com IDs monotonicos, uma por app/rodada.
  `createCampaign(root, amountPerUser, maxClaims, deadline)` governance-
  gated; `claim(id, proof)` pelo user com proof double-hashed (padrao
  OZ anti-preimage: leaf = `keccak256(bytes.concat(keccak256(abi.encode
(user))))`). Cap duplo: Merkle root limita QUEM, `maxClaims` limita
  QUANTOS efetivamente recebem (protecao contra erro na geracao
  off-chain da lista). `closeCampaign(id, returnTo)` kill-switch +
  varredura (antes ou depois do deadline): devolve
  `(maxClaims - claimed) * amountPerUser` ao Treasury. `msg.sender` e
  sempre o recipient (sem `to` param) — impede claim-em-nome-de-outro.
  View `isEligible(...)` para pre-check em UI sem tx. `ReentrancyGuard`
  em `claim` e `closeCampaign`; `credit` imutavel. Suite
  `test/UserSubsidy.test.ts` com 34 testes verdes: construcao + guards,
  createCampaign (happy, role, zero-root/amount/maxClaims, deadline-
  passado, IDs monotonicos), claim (happy, invalid-proof variants,
  already-claimed, expired, cap-reached, non-existent, closed, all-
  eligible-up-to-cap), closeCampaign (full/partial/zero sobra, pre/pos-
  deadline, role + guards + already-closed), isEligible em todos os
  estados, multi-campanhas coexistindo.
- `ignition/modules/UserSubsidy.ts` — modulo Ignition standalone
  (singleton) que deploya `UserSubsidy` recebendo `creditAddress` e
  `adminAddress` via parametros. Separado do `Dao.ts` porque a
  distribuicao nao faz parte do bootstrap core (ver Dao.ts header,
  decisao 2). Em prod, `adminAddress` deve ser o `CommunityTimelock`.
  Parametros de exemplo em `ignition/parameters/userSubsidy.dev.json`.
- `ignition/modules/TeamVesting.ts` — template Ignition parametrizavel
  para deploy de UMA instancia de `TeamVesting`. Todos os campos
  (token, beneficiary, start, cliff, duration, owner) obrigatorios sem
  defaults — deploy silencioso com `start=0` seria catastrofico. Em
  prod, deploy nao deve rodar direto via CLI e sim ser parte de uma
  proposta no Governor que tambem executa `gov.mint(vesting_addr,
alloc, "team:<nome>")`. Parametros de exemplo em
  `ignition/parameters/teamVesting.example.json`.
- `docs/concepts/distribuicao.md` — guia publico completo (didatico) de
  como GOV e CREDIT sao distribuidos: os 5 buckets do GOV com racional
  de cada trava temporal (Treasury sem vesting, time com cliff 12m +
  linear 36m, venda publica 25%-no-TGE + linear 12m, comunidade em 4
  temporadas de 12m, LP lockada ≥24m), genesis de 10M do CREDIT
  entrando 100% no Treasury + usos planejados (pool inicial, subsidio
  de usuarios, reserva de emergencia, buyback fund), fluxo de valor
  dos 4 atores (usuario / app / staker / holder), 3 vias de receita
  do app (rebate direto + emissao via stake + apreciacao) com exemplo
  numerico ~52% efetivo, 3 salvaguardas anti-abuso (floor decay /
  sanity cap / probation penalty), timeline bootstrap → handoff em
  4 fases com marcos temporais, checklist objetivo de "DAO saudavel",
  FAQ respondendo "isso e Ponzi?", "25% pro time e muito?", "e se a
  DAO quiser mintar mais depois?", "posso comprar GOV agora?".
  Diagramas ASCII de fluxo de valor e controle politico. Indexado em
  `docs/README.md` como ponto de entrada para novos holders/usuarios.
- `scripts/proposals/` — templates para submeter as 3 propostas
  recorrentes da DAO: (a) `deploy-user-subsidy.ts` — deploy one-shot do
  singleton `UserSubsidy` (sem proposta, admin = Timelock direto),
  idempotente por checagem de bytecode; (b) `propose-team-vesting.ts` —
  deploy de uma instancia de `TeamVesting` via Ignition (owner =
  Timelock, `deploymentId` parametrizado por nome do membro pra
  permitir multiplos deploys) + proposta `gov.mint(vesting_addr,
alloc, "team:<nome>")`; (c) `propose-subsidy-campaign.ts` — proposta
  batch atomica `[Treasury.transfer(credit, subsidy, budget),
UserSubsidy.createCampaign(root, amount, maxClaims, deadline)]` que
  garante que nenhuma campanha existe sem orcamento e nenhum orcamento
  fica sem campanha. Todos leem configs JSON via env
  `PROPOSAL_CONFIG=<path>`; validacoes falham cedo com mensagens claras
  (zero-address/root/amount, cliff>duration, deadline passado,
  Treasury sem saldo). Helper compartilhado `_shared.ts` resolve
  enderecos do `deployed_addresses.json` do Ignition, valida
  `proposalThreshold`, imprime pacote auditavel (proposalId, targets,
  values, calldatas, descriptionHash). Configs de exemplo em
  `scripts/proposals/configs/`. Smoke-tested end-to-end contra o
  hardhat node DEV: UserSubsidy deploy -> TeamVesting deploy + mint
  proposal -> subsidy campaign batch proposal, todos retornando
  proposalIds validos.
- `test/e2e/projectLifecycle.e2e.test.ts` — suite end-to-end cobrindo o
  ciclo de vida completo de projetos no `ProjectRegistry` e o impacto nos
  contratos dependentes (Staking, FeeRouter, BurnTracker,
  RewardDistributor). 7 cenarios: (1) Pending -> Active (stake/pay
  bloqueados em Pending, liberam apos activate); (2) probation inicial
  por tempo (isInProbation true, penalty de share reservado para claim);
  (3) probation punitiva (stake novo/pay bloqueados, unstake ainda
  requer lock expirado — bypass so em Removed); (4) Removed (slash)
  colateral vai pro Treasury + staker bypassa lock; (5) Removed (clean)
  colateral volta pro owner original; (6) burns pre-remocao permanecem
  validos no accounting da rodada e claim continua funcionando apos
  removal; (7) ownership 2-step do projeto (transfer + accept), com
  `FeeRouter.getEffectiveRecipient` seguindo o novo owner via lookup
  dinamico no Registry. Todos validam revert custom-error com args
  esperados e event emission. 7/7 testes verdes, ~4s.
- `test/e2e/stakingRewards.e2e.test.ts` — suite end-to-end cobrindo o
  fluxo de staking direcionado + emissao de rewards proporcional. 12
  cenarios cobrindo edge cases cross-contract entre Staking /
  BurnTracker / RewardDistributor: multi-staker num projeto (share
  proporcional ao peso); multi-projeto por staker (claim independente);
  consolidacao de stake (Opcao B: amount soma, lockDuration =
  max(rem, new), lockStartAt reseta); `increaseStake` NAO reseta
  lockStartAt; `extendLock` nao encurta, aumenta peso; snapshot
  anti-flash-stake (I5) — stake pos-snapshotBlock nao conta no claim,
  flash-staker recebe 0 silenciosamente; claim duplicado reverte;
  preview == claim real; bootstrap (rodada 0 sem burn prev) usa
  `globalWeight`/`projectWeight` do Staking; probation penalty (share
  dividido por 4 quando projeto em probation inicial por tempo, usando
  `setProbationDuration(10d)` para manter janela viva); `previewEmission`
  consulta burn live; `claimMany` agrega rounds+projects (+
  ArrayLengthMismatch / EmptyBatch). Teste final de conservacao
  macroeconomica (CREDIT supply conservado, GOV conservado, FeeRouter
  nao custodia). 12/12 testes verdes, ~5s.
- `test/e2e/governanceFlow.e2e.test.ts` — suite end-to-end cobrindo o
  caminho real de PRODUCAO: propostas on-chain do `CommunityGovernor`
  passando pelo ciclo completo (propose -> vote -> queue -> timelock
  delay -> execute) e atingindo todos os contratos economicos gated por
  `GOVERNANCE_ROLE`. 8 cenarios: (1) `acceptOwnership` do GOV via
  proposta — teste isolado que NAO faz bootstrap por impersonate,
  validando que o caminho real da primeira proposta da DAO funciona;
  (2) `registerProject` + `activateProject` via proposta batch
  (invariante I7); (3) `setAlpha` do RewardDistributor via proposta +
  verificacao de event emission parseando raw logs (contracts nao-target
  emitem logs sem `fragment.name` no typechain); (4) batch multi-alvo —
  `setProjectSplit(FeeRouter)` + `payRebates(Treasury)` numa unica
  proposta; (5) proposta sem quorum chega a Defeated (state = 3) e
  queue/execute revertem; (6) proposer cancela proposta Pending;
  (7) `onlyGovernance` gating — chamada direta reverte com
  `AccessControlUnauthorizedAccount` para nao-Timelock; (8) separacao
  temporal — mudanca de alpha via governanca NAO afeta rodada ja
  finalizada (totalEmission imutavel) mas afeta proximas rodadas. Helper
  `proposeAndExecute` tipado com `CommunityGovernor` + `HardhatEthersSigner`
  do typechain. 8/8 testes verdes, ~7s.
- `test/e2e/FullLifecycle.test.ts` — teste de integracao end-to-end
  passando por TODOS os 10 contratos deployados via Ignition em uso
  coordenado: deploy (perfil DEV) + impersonate do Timelock pra aceitar
  ownership do GOV, mintar GOV pra Alice/Bob, distribuir CREDIT do genesis
  pra Charlie/David (simulacao da distribuicao via proposta) e registrar 2
  projetos (Chat App, Game App). Fluxo testado: Alice stake 80k GOV lock
  30d em Chat App, Bob stake 40k GOV lock 90d em Game App, Charlie paga
  1000 CREDIT em Chat App (95/0/5 — 950 burn + 50 rebate), David paga
  500 CREDIT em Game App (475 burn + 25 rebate); avanca tempo >
  roundDuration; Timelock fecha rodada 0 (via BurnTracker.closeRound);
  finalize permissionless da rodada 0 pelo Alice; avanca tempo + fecha/
  finaliza rodada 1 (que acopla com burn de 1425 CREDIT da rodada 0);
  Alice/Bob claim rewards proporcionais ao peso de stake e ao burn do
  proprio projeto; Alice tenta unstake cedo e reverte com LockNotExpired;
  avanca 30d e Alice unstake com sucesso. Invariantes validadas:
  conservacao de CREDIT (supplyFinal == supplyInicial - burns + rewards),
  conservacao de GOV (soma balances == total mintado), FeeRouter nao
  custodia CREDIT entre chamadas, Treasury mantem saldo esperado pos-
  transferencias. Teste secundario valida rejeicao de wash-burn: projeto
  tenta queimar 2M CREDIT num unico pay, FeeRouter reverte com
  SanityCapExceeded do BurnTracker; agregados `totalBurnByRound` e
  `burnByRoundProject` permanecem zerados apos o revert. 2/2 testes
  verdes, tempo ~4s.
- `scripts/simulation/economicSim.ts` — simulacao on-chain multi-rodada
  (52 rodadas) do modelo economico, rodando 3 cenarios sequenciais
  isolados via `takeSnapshot`/`restore` do hardhat-network-helpers: **A)
  Bootstrap saudavel** (uso crescente 200k -> 950k CREDIT/round, estavel
  depois); **B) Death spiral** (pico 950k aos 5 rounds, decai linear pra
  100k aos 20 rounds, estavel baixo 50k depois); **C) Wash-burn ataque**
  (identica ao A, mas round 5 tenta queimar 10M CREDIT — acima do
  sanityCap de 1M). Para cada round, o simulador: aplica burn via
  FeeRouter.pay do Charlie, avanca tempo, Timelock fecha rodada,
  permissionless finalize, Alice/Bob claim. Coleta metricas por round:
  `burnR`, `emissionRplus1` (via `previewEmission`), `creditSupply`
  (`totalSupply`), rewards individuais, APR anualizado com moving window
  de 4 rounds. Saidas: `scripts/simulation/output/sim_A.csv`, `sim_B.csv`,
  `sim_C.csv` (raw metrics) + `report.md` (analise textual com tabela
  ASCII amostrada e insights por cenario). Hard assert final: cenario C
  DEVE rejeitar o wash-burn e os agregados `burnByRoundProject`/
  `totalBurnByRound` NAO podem ser corrompidos — valida on-chain a
  invariante I3 do sanityCap. Tempo total ~6 min (156 transacoes por
  cenario).
- `scripts/simulation/output/report.md`, `sim_A.csv`, `sim_B.csv`,
  `sim_C.csv` — outputs gerados pela simulacao. Key findings:
  **Cenario A** — APR estabiliza em ~34% (token-on-token, sem conversao
  USD), ratio emissao/burn acumulado 97.36% (levemente deflacionario
  como desenhado por alpha=0.95). **Cenario B** — floor schedule protege
  nos primeiros ~24 rounds; apos exaustao do floor, APR colapsa de
  ~21_000% (meio) pra ~1789% (fim), queda de 91.5% — death spiral
  matematicamente correto, floor cumpre seu papel de safety-net de
  bootstrap. **Cenario C** — revert com `SanityCapExceeded(projectId=1,
attempted=~9.5M, cap=1M)` no round 5, `burnByRoundProject` permanece
  no valor legitimo ate o ataque, simulacao segue normalmente dos rounds
  6 em diante.
- `npm run sim` (em `package.json`) — atalho para executar a simulacao
  diretamente: `hardhat run scripts/simulation/economicSim.ts`.
- `ignition/modules/Dao.ts` — modulo Ignition unico que deploya os 10
  contratos da DAO (GovernanceToken, CreditToken, CommunityTimelock,
  ProjectRegistry, Treasury, Staking, BurnTracker, RewardDistributor,
  FeeRouter, CommunityGovernor) e executa o wiring completo em 4 fases
  rigorosamente ordenadas: A) deploy, B) role grants funcionais
  (MINTER -> distributor, BURNER -> tracker, RECORDER -> feeRouter,
  PROPOSER/CANCELLER -> governor) + genesis mint de 10M CREDIT pro
  Treasury, C) GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE de todos os contratos
  economicos cedidos ao Timelock + `transferOwnership` 2-step do
  GovernanceToken pro Timelock, D) deployer renuncia todas as roles, com
  Timelock admin POR ULTIMO (regra defensiva). Single-module com
  parametrizacao via `getParameter`: defaults batem o perfil DEV; producao
  usa `--parameters ignition/parameters/production.json` (delay Timelock 2d,
  votingDelay 7200 blocks, votingPeriod 50400 blocks, etc). Floor schedule
  do RewardDistributor pre-computado como decay linear 400_000e18 -> 16_666e18
  ao longo de 24 rodadas, soma analitica = 5M CREDIT (safety net abaixo do
  genesis de 10M). `acceptOwnership` do GovernanceToken nao acontece no
  modulo (Ownable2Step exige caller = pendingOwner = Timelock; em prod vira
  primeira proposta ratificada no Governor; em dev e simulado via
  `impersonateAccount` no fixture do teste). **Bug nao-obvio descoberto e
  corrigido durante implementacao**: o batcher do Ignition reordena `m.call`s
  por dependencias, e a renuncia de `DEFAULT_ADMIN_ROLE` do deployer em um
  contrato X estava caindo num batch ANTES do `grantRole(GOVERNANCE_ROLE,
timelock)` no mesmo X — deployer perdia o admin antes da fase C terminar.
  Solucao: cada `phaseD_xxxRenounceAdmin` declara explicitamente
  `after: [cXxxAdmin, cXxxGov, ...]` cobrindo todas as chamadas do deployer
  no contrato. Decisao registrada em comentario inline no modulo.
- `ignition/parameters/dev.json` e `ignition/parameters/production.json` —
  arquivos de parametros explicitos para os dois perfis. Dev replica os
  defaults do modulo (uteis para `npm run deploy:local` e validacao manual);
  prod tem todos os bigints como string (limitacao do JSON) e os 24 valores
  do floor schedule listados explicitamente para auditoria.
- `test/ignition/Dao.test.ts` — teste integrado do modulo Ignition com **31
  testes, todos passando**. Cobre cada uma das 4 fases isoladamente:
  - **Phase A** (2 testes): deploy de todos os 10 contratos com addresses
    nao-zero e distintos; wiring de imutaveis (Staking->GOV+Registry,
    Distributor->todos, FeeRouter->todos, Governor->GOV+Timelock).
  - **Phase B** (7 testes): MINTER no distributor, BURNER no tracker,
    RECORDER no feeRouter, PROPOSER+CANCELLER no governor, EXECUTOR somente
    em address(0) (publica), genesis mint de 10M CREDIT pro Treasury,
    impossibilidade de re-mintar genesis mesmo pelo Timelock (flag one-shot).
  - **Phase C** (8 testes): GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE no Timelock
    em Registry/Treasury/BurnTracker/RewardDistributor/FeeRouter; admin no
    Timelock em CreditToken; `pendingOwner` do GOV = Timelock (accept
    pendente); `acceptOwnership` simulado via impersonate completa a
    transferencia (`owner == timelock`).
  - **Phase D** (5 testes): deployer perdeu GOVERNANCE_ROLE em todos os
    contratos economicos; deployer perdeu DEFAULT_ADMIN_ROLE em todos
    (incluindo Timelock); deployer nao consegue mais grant de role nenhuma;
    deployer nao consegue registrar projeto direto no Registry; deployer
    nao consegue mover fundos do Treasury (ambos com revert
    `AccessControlUnauthorizedAccount`).
  - **Configuration sanity** (8 testes): floor schedule (24 valores,
    decay linear), alpha/capMax do distributor, default split 95/0/5 do
    feeRouter, roundDuration/sanityCap do tracker, minDelay do timelock,
    voting params do governor, minCollateral/probationDuration do registry,
    cap imutavel de 100M do GOV.
  - **End-to-end** (1 teste): full governance flow — propose
    `Treasury.transfer(CREDIT, recipient, 1000e18)` -> votingDelay -> vote
    FOR -> votingPeriod -> queue -> Timelock delay -> execute. Efeito
    observavel: saldo CREDIT do recipient sobe em 1000e18. Contraprova:
    deployer continua sem poder fazer o mesmo via direct call (revert
    `AccessControlUnauthorizedAccount`).
    Fixture usa `loadFixture` + `hre.ignition.deploy(CommunityDAOModule)` e
    re-resolve cada contrato via `ethers.getContractAt` para tipos TypeChain
    (Ignition retorna `BaseContract` generico).
- `CommunityTimelock` — wrapper identitario sobre `TimelockController` (OZ
  5.0.2), sem codigo adicional. Motivacao: identidade on-chain (Etherscan
  exibe `CommunityTimelock` em vez de `TimelockController` generico) e
  ancoragem de NatSpec de deploy num unico lugar, sem introduzir superficie
  de bug extra. Constructor canonico: `(minDelay, proposers, executors,
admin)`; estrategia de bootstrap documentada prescreve `proposers=[]`,
  `executors=[address(0)]` (execucao publica pos-delay, menor friccao e
  menor superficie de captura) e `admin=deployer` que renuncia apos o
  Governor receber PROPOSER_ROLE e CANCELLER_ROLE. **12 testes, 100%
  stmts/branch/funcs/lines** — cobrem role hierarchy, ciclo
  `schedule -> delay -> execute`, rejeicao antes do delay, cancel por
  `CANCELLER_ROLE`, self-administration e suporte a interfaces
  (IAccessControl, IERC1155Receiver). Fundacao para as invariantes I4
  (Timelock unico portador de `GOVERNANCE_ROLE` nos contratos economicos em
  producao) e I7 (projetos so entram no Registry via proposta aprovada +
  delay).
- `CommunityGovernor` — Governor OZ 5.0.2 composto pelo stack canonico:
  `Governor` + `GovernorSettings` + `GovernorCountingSimple` +
  `GovernorVotes` + `GovernorVotesQuorumFraction` +
  `GovernorTimelockControl`. Voting power lida do `GovernanceToken`
  (ERC20Votes) via `getPastVotes`, garantindo imunidade a flash-loan attack
  no bloco do voto (I5). Execucao roteada 100% via `CommunityTimelock`,
  mantendo os contratos economicos isolados de chamadas ad-hoc do Governor.
  Overrides multiplos resolvidos explicitamente com NatSpec por funcao
  (`votingDelay`, `votingPeriod`, `proposalThreshold`, `quorum`, `state`,
  `proposalNeedsQueuing`, `_queueOperations`, `_executeOperations`,
  `_cancel`, `_executor`). Parametros documentados em dois perfis:
  **producao** (`votingDelay=7200` blocks / ~1d, `votingPeriod=50400`
  blocks / ~7d, `threshold=10_000e18` GOV, `quorum=4%`, `timelockDelay=2d`)
  e **dev/teste** (`votingDelay=1` block, `votingPeriod=50` blocks,
  `threshold=10_000e18` GOV, `quorum=4%`, `timelockDelay=1h`). Decisao de
  qual perfil usar fica para o Ignition module (fase 5 parte 2/2). Nome
  "CommunityGovernor" trava o domain separator EIP-712 — nao mudar sem
  migracao de assinaturas `castVoteBySig`. Clock mode delegado ao token
  (fallback `block.number`). **29 testes, 100%
  stmts/branch/funcs/lines** — cobrem:
  - construcao (9 parametros + reverts por `GovernorInvalidVotingPeriod(0)`
    e `GovernorInvalidQuorumFraction(>100)`),
  - threshold de proposta (spammer com `< 10_000e18` revert com
    `GovernorInsufficientProposerVotes`),
  - voting delay / period (voto em Pending ou apos periodo revert com
    `GovernorUnexpectedProposalState`),
  - counting For/Against/Abstain, double-voting bloqueado com
    `GovernorAlreadyCastVote`,
  - quorum igual a `totalSupply * 4 / 100` no snapshot,
  - proposta Defeated por Against > For apos period,
  - proposta Defeated por falta de quorum,
  - **full E2E I4**: propose -> delay -> vote -> period -> queue -> timelock
    delay -> execute; efeito observavel em `Treasury.transfer(USDC, to,
42k)` (evento `Transferred` com args corretos; saldo do destinatario e
    treasury atualizados). Negative-case: admin direto no Treasury revert
    com `AccessControlUnauthorizedAccount` apos renuncia.
  - **full E2E I7**: propose `ProjectRegistry.registerProject(voterA,
"ipfs://...", minCollateral)` com approve previo do owner -> vote ->
    queue -> execute; projeto registrado com status Pending. Negative-case:
    admin direto no Registry revert com `AccessControlUnauthorizedAccount`.
  - `onlyGovernance` setters: `setVotingDelay`, `setVotingPeriod`,
    `setProposalThreshold`, `updateQuorumNumerator`, `updateTimelock` todos
    revertem com `GovernorOnlyExecutor` em chamada direta; via proposta
    aprovada funcionam (teste completo para `setVotingDelay`).
  - cancel flow pelo proposer enquanto Pending; non-proposer revert com
    `GovernorOnlyProposer`.
  - `queue` guard antes de Succeeded; `proposalEta` = 0 antes do queue;
    `castVoteWithReasonAndParams` emite `VoteCast` com `weight` correto;
    `relay` revert com `GovernorOnlyExecutor`; `receive()` revert com
    `GovernorDisabledDeposit` para transferencias plain de ETH.
- Auditoria estatica com Slither 0.11.5 sobre `CommunityTimelock` e
  `CommunityGovernor`: **zero findings no codigo do projeto** (ambos
  `*-projectonly.txt` com `--filter-paths node_modules` retornam 0
  results). Os relatorios completos (`CommunityTimelock.txt` 110 linhas;
  `CommunityGovernor.txt` 322 linhas) listam apenas findings em
  `node_modules/@openzeppelin` — mesma classe ja documentada em todos os
  contratos anteriores (pragma `^0.8.20` vs `0.8.24`, dead-code em
  `Context._msgData/_contextSuffixLength`, low-level-call intencional do
  `TimelockController._execute`, etc). Slither tambem emite warning de
  code size `27909 bytes > 24576` para `CommunityGovernor` — isso
  vem do solc que Slither invoca internamente **sem otimizador e sem
  viaIR**; com o pipeline real do projeto (optimizer=200, viaIR=true), o
  bytecode deployed e **15324 bytes** (9252 bytes abaixo do limite
  EIP-170), confirmado via leitura do `artifacts/**/CommunityGovernor.json`.
- `GovernanceToken` (GOV) — ERC20Votes + ERC20Permit + Ownable2Step, supply cap
  imutável de 100.000.000 \* 10^18 declarado no constructor, emissão controlada
  por `mint(to, amount, tag)` onde `tag` rastreia o bucket de distribuição
  (treasury / team / public sale / ...) apenas via evento. 24 testes, 100% de
  coverage (linhas, branches e funções). Cobre as invariantes I1 (supply cap),
  I4 (owner via `Ownable2Step`, preparado para Timelock) e I5 (voto via
  snapshot ERC20Votes, imune a flash-loan attacks no voto).
- Auditoria estática com Slither 0.11.5 sobre `GovernanceToken`: zero findings
  high/medium no código do projeto; único finding informational
  (`naming-convention` em `CAP_SUPPLY`) é intencional — a variável é
  `immutable` e segue a convenção UPPER_CASE já adotada pela OpenZeppelin
  (ex.: `DEFAULT_ADMIN_ROLE`). Suprimido no solhint via
  `// solhint-disable-next-line var-name-mixedcase`. Output bruto preservado
  em `audit/slither/GovernanceToken.txt`.
- `CreditToken` (CREDIT) — ERC20 + ERC20Burnable + AccessControl (OZ 5.0.2).
  Supply elástico (sem cap no token — cap por rodada vive no futuro
  `RewardDistributor`, invariante I3). Três caminhos complementares de queima
  para cobrir a invariante I2 (burn no consumo): `burn` (self), `burnFrom`
  (com allowance) e `burnByRole(from, amount, tag)` (portadores de
  `BURNER_ROLE` queimam sem allowance — necessário para o fluxo atômico
  `FeeRouter.pay → BurnTracker.burnAndRecord → CreditToken.burnByRole` em
  1 tx; segurança assegurada pelo gating via `BURNER_ROLE` concedida apenas
  a contratos aprovados pela DAO via Timelock). Genesis de 10M exposto por
  `mintGenesis(to, amount)` one-shot (flag `genesisMinted` + erro custom
  `GenesisAlreadyMinted`), restrito a `DEFAULT_ADMIN_ROLE`. Cunhagem
  operacional via `mint(to, amount, tag)` restrita a `MINTER_ROLE` (concedida
  ao `RewardDistributor` na fase 4). 33 testes, 100% de coverage
  (stmts/branch/funcs/lines). Eventos dedicados `GenesisMinted`, `Minted`,
  `BurnedByRole` para auditabilidade completa do ciclo de vida do supply.
- Auditoria estática com Slither 0.11.5 sobre `CreditToken`: **zero findings**
  no código do projeto (`CreditToken-projectonly.txt` com
  `--filter-paths node_modules` retorna 0 results). O relatório completo
  (`CreditToken.txt`) lista 5 findings, todos em `node_modules/@openzeppelin`
  (pragma mismatch `^0.8.20` vs `0.8.24`, `dead-code` em helpers internos do
  OZ, `solc-version`) — nada acionável no escopo do projeto. Conformidade
  ERC20 validada por `slither-check-erc`: todas as funções e eventos
  obrigatórios presentes, com tipos e `indexed` corretos.
- `ProjectRegistry` — whitelist on-chain de projetos do ecossistema com
  colateral lockado em GOV (skin in the game), state machine
  `Pending → Active → Probation → Removed` (terminal), probation inicial por
  tempo (view `isInProbation`) separada de probation punitiva (status do
  enum), ownership 2-step (`transferProjectOwnership` + `acceptProjectOwnership`),
  metadata URI owner-updatable e params governance-tunable (`minCollateral`,
  `probationDuration`). Remoção clean devolve colateral ao owner; slash envia
  ao treasury. IDs incrementais começam em 1 (ID 0 = inválido). Contrato
  gated por `GOVERNANCE_ROLE` (concedido ao Timelock na Fase 5) para toda
  mudança de status, registro e ajuste de parâmetros — atende invariante I7.
  67 testes, **100% coverage** em stmts/branch/funcs/lines. CEI rigoroso em
  `registerProject` e `removeProject` (movimentação de GOV via `SafeERC20`
  após todos os effects); `ReentrancyGuard` dispensado com justificativa
  documentada em NatSpec (token é o próprio GOV, ERC20Votes sem callbacks).
  Custom errors dedicados: `InvalidStatus`, `ProjectNotFound`,
  `ProjectAlreadyRemoved`, `NotProjectOwner`, `NotPendingOwner`,
  `InsufficientCollateral`, `InsufficientAllowance`, `ZeroAddress`,
  `ZeroAmount`, `EmptyMetadataURI`. Eventos granulares para indexação
  off-chain: `ProjectRegistered`, `ProjectActivated`, `ProjectProbation`,
  `ProjectReactivated`, `ProjectRemoved`, `MetadataUpdated`,
  `OwnershipTransferInitiated`, `OwnershipTransferAccepted`,
  `MinCollateralUpdated`, `ProbationDurationUpdated`.
- Auditoria estática com Slither 0.11.5 sobre `ProjectRegistry`: **zero
  findings high/medium acionáveis** no código do projeto. O relatório
  filtrado (`ProjectRegistry-projectonly.txt`) lista 3 findings, todos
  avaliados e aceitos:
  1. `arbitrary-send-erc20` em `registerProject` — **falso positivo**
     esperado. Slither flag porque o `from` do `transferFrom` é parâmetro;
     a semântica é intencional: o `TimelockController` (único com
     `GOVERNANCE_ROLE`) registra projetos em nome de owners que aprovaram
     explicitamente allowance ao Registry. A validação
     `InsufficientAllowance` antes do `safeTransferFrom` garante que o
     owner consentiu; ausência de aprovação reverte com erro claro.
     Sem aprovação ≡ sem registro.
  2. `timestamp` em `isInProbation` — uso de `block.timestamp` em
     comparação. Aceitável: janela de probation é de 30 dias (default);
     manipulação de timestamp em ordem de segundos pelo miner é
     irrelevante em escala de semana/mês.
  3. `naming-convention` em `GOV_TOKEN` — intencional. Variável
     `immutable` seguindo a convenção UPPER_CASE já adotada pela
     OpenZeppelin (ex.: `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`), consistente
     com `CAP_SUPPLY` do `GovernanceToken`. Suprimido no solhint via
     `// solhint-disable-next-line var-name-mixedcase`.
     Output bruto preservado em `audit/slither/ProjectRegistry.txt`
     (completo, inclui findings em `node_modules`) e
     `audit/slither/ProjectRegistry-projectonly.txt` (filtrado).
- `Treasury` — custódia multi-ativo da DAO (stables USDC/USDT como
  primários, GOV via buyback, qualquer ERC-20 aceito passivamente).
  100% governance-gated via `GOVERNANCE_ROLE` concedido ao Timelock em
  produção; admin inicial apenas detém poder de role management, sem
  via de drenagem fora do ciclo de propostas (atende I4). Superfície:
  `transfer`, `batchTransfer`, `payRebates(round)` (semanticamente
  idêntico a batch mas com evento rastreando rodada de rebate),
  `executeBuyback` (STUB v1 — apenas emite `BuybackRequested`; execução
  real de swap DEX fica para fase posterior quando modelo de slippage/
  TWAP/frontrun estiver validado), `sweepETH` para o fallback `receive`,
  e view `balanceOf(token)`. Custódia PASSIVA deliberada (sem função
  `deposit`) — fee payers e routers usam `token.transfer(treasury,amount)`
  direto, simplificando modelo mental e eliminando autorizações
  cruzadas. 47 testes cobrindo happy path, guards (ZeroAddress,
  ZeroAmount, ArrayLengthMismatch, EmptyBatch, InsufficientBalance,
  ETHTransferFailed), matriz de access control sobre as 5 funções
  gated (I4), e `ReentrancyGuard` nas 4 saídas de fundos testadas com
  ERC-20 malicioso que reentra em `_update` e um contrato ETH receiver
  que reentra em `sweepETH` via `receive`. Coverage:
  100% stmts/lines/funcs, 94.64% branches (branches restantes são
  instrumentação do solidity-coverage sobre `nonReentrant` em
  `executeBuyback`, stub sem caminho de reentrância natural por não
  fazer call externo — guard está aplicado defensivamente para
  resistir à substituição futura por integração DEX sem regressão de
  segurança). Mocks de teste em `contracts/test/` (`ERC20Mock`,
  `ReentrantERC20Mock`, `ReentrantETHReceiver`) isolados em subpasta
  para ficar explícito que não entram em deploy de produção.
- Auditoria estática com Slither 0.11.5 sobre `Treasury`: **zero findings
  high/medium acionáveis** no código do projeto. O relatório filtrado
  (`Treasury-projectonly.txt`) lista 2 findings, ambos avaliados e
  aceitos:
  1. `arbitrary-send-eth` em `sweepETH` — **falso positivo** esperado.
     O destino `to` é parâmetro por design: o Governor propõe onde
     enviar ETH residual (acidental ou doado). A função é
     `onlyRole(GOVERNANCE_ROLE)` — em produção, `GOVERNANCE_ROLE`
     pertence exclusivamente ao Timelock, portanto qualquer sweep
     exige proposta + votação + delay. Slither apenas alerta sobre a
     forma (destino parametrizado), não sobre a substância.
  2. `low-level-calls` em `sweepETH` — uso intencional de
     `to.call{value: amount}("")`. Essa é a forma correta e recomendada
     de enviar ETH a contratos pós-EIP-2929/EIP-1884 (os antigos
     `.transfer`/`.send` com stipend de 2300 gas falham em contratos
     com lógica em `receive`). Retorno é checado e falha emite erro
     custom `ETHTransferFailed`. O único outro caminho seria usar
     `Address.sendValue` da OZ, que faz exatamente o mesmo low-level
     call internamente — apenas move o warning para dentro de
     `node_modules`.
     Output bruto preservado em `audit/slither/Treasury.txt` (completo)
     e `audit/slither/Treasury-projectonly.txt` (filtrado).
- `Staking` — cofre de stake direcionado por `projectId` do
  `ProjectRegistry`, com lock mínimo 14d / máximo 365d e multiplier
  linear 1x→4x (precisão 1e18). Peso = `amount * multiplier(lockDuration)`
  alimenta o futuro `RewardDistributor` no cálculo de share de rewards
  por projeto por rodada (ve-light, sem NFT / sem transferibilidade de
  posição). Snapshots históricos via `OpenZeppelin Checkpoints.Trace208`
  em `_userWeight[user][projectId]` e `_projectWeight[projectId]`
  (chave `uint48 = block.number`, valor `uint208`) — views
  `getWeightAt` / `getTotalWeightAt` imunes a flash-stake (estendem I5
  para cálculo de rewards). Superfície state-changing:
  `stake`, `increaseStake`, `extendLock`, `unstake`, `unstakeAll` —
  todas `nonReentrant` e com `SafeERC20`, CEI estrito em todos os
  caminhos que movem GOV (effects antes do `safeTransferFrom` /
  `safeTransfer`). Semântica de **consolidação Opção B** em
  `stake` com posição preexistente: `amount` soma, `lockDuration`
  vira `max(remainingOld, newLockDuration)` e `lockStartAt` reseta
  para `block.timestamp` — decisão documentada em NatSpec
  contract-level (reset intencional impede o staker de alongar o
  peso fazendo micro-stakes sem re-commitar temporalmente o amount
  antigo). `increaseStake` e `extendLock` preservam `lockStartAt`
  por design — `increaseStake` explicitamente não reabre lock
  expirado (use `stake` para reset). **Bypass de lock apenas em
  status `Removed`**: projeto removido pela governança libera o
  stake imediatamente (evento `EarlyUnstakeAllowed`) — punir o
  projeto não deve prender o staker. Probation (punitiva ou
  inicial por tempo) **não** bypassa lock — apenas bloqueia stake
  novo. 56 testes cobrindo as 16 invariantes da spec (lock min/max,
  curva linear, peso, agregados, consolidação, extend só aumenta,
  increase preserva, unstake respeita lock, bypass Removed, gating
  de Active, snapshots históricos, reentrância em todas as 4
  saídas de fundos, guards ZeroAmount/ZeroAddress/InsufficientStake/
  PositionNotFound). Coverage: **100% stmts / 100% funcs / 100% lines,
  98.39% branches** (único branch restante é instrumentação do
  `nonReentrant` em `extendLock`, função que não faz call externo —
  branch inalcançável naturalmente, mesmo padrão aceito em
  `Treasury.executeBuyback`). Mock `ReentrantStakingERC20Mock`
  (em `contracts/test/`) reentra via callback em `_update` com 4
  modos de ataque: stake-on-pull, unstake-on-push, increaseStake-on-pull,
  unstakeAll-on-push — todos bloqueados pelo `ReentrancyGuard`.
- Auditoria estática com Slither 0.11.5 sobre `Staking`: **zero
  findings high/medium acionáveis** no código do projeto. O relatório
  filtrado (`Staking-projectonly.txt`) lista 3 famílias de findings
  atribuíveis a este contrato, todas avaliadas e aceitas:
  1. `unused-return` em `_writeCheckpoints` — `Checkpoints.Trace208.push`
     retorna `(uint208 oldValue, uint208 newValue)` e nós ignoramos o
     retorno. A semântica desejada é estritamente "grava e segue" —
     não precisamos do par de valores porque já temos `oldUserWeight`
     e `oldProjectWeight` capturados via `.latest()` antes do push,
     e `newUserWeight` / `newProjectWeight` são os argumentos que
     acabamos de passar. Consumir o retorno apenas para silenciar o
     detector adicionaria código inútil.
  2. `timestamp` em `isUnlocked`, `stake` (consolidação de lock),
     `_unstake` (check de expiração) e `_multiplier` (comparações de
     duração) — usos deliberados. Toda a economia do lock é em
     escala de **dias a meses** (mínimo 14d, máximo 365d); a janela
     de manipulação que um miner tem sobre `block.timestamp` é da
     ordem de segundos, irrelevante frente à granularidade das
     decisões. Documentado como aceitável no Slither wiki para
     comparações de duração longa.
  3. `naming-convention` em `GOV_TOKEN` e `REGISTRY` — intencional.
     Ambos são `immutable` e seguem a convenção UPPER_CASE já
     adotada em `GovernanceToken.CAP_SUPPLY`, `CreditToken.MINTER_ROLE`,
     `ProjectRegistry.GOV_TOKEN` / `GOVERNANCE_ROLE` e na própria
     OpenZeppelin (`DEFAULT_ADMIN_ROLE`). Suprimido no solhint via
     `// solhint-disable-next-line var-name-mixedcase`.
     Output bruto preservado em `audit/slither/Staking.txt` (completo,
     inclui findings em `node_modules`) e
     `audit/slither/Staking-projectonly.txt` (filtrado).
- `BurnTracker` — "oracle interna" do modelo econômico. Contabiliza on-chain
  o burn de `CreditToken` (CREDIT) por `(round, projectId)` via
  `burnAndRecord(projectId, from, amount)` — chamada por cada app listado
  (portador de `RECORDER_ROLE`) atomicamente em 1 tx: valida que projeto
  está `Active` no Registry, valida `from != 0` e `amount != 0`, checa
  sanity cap, atualiza 3 mappings de accounting (`burnByRoundProject`,
  `totalBurnByRound`, `projectsWithBurnCount`) e finalmente chama
  `CreditToken.burnByRole(from, amount, "burnTracker")` — sem allowance
  porque o tracker detém `BURNER_ROLE` no CREDIT (concedido via Timelock
  pós-deploy). **Decisão arquitetural "caminho c" — on-chain atômico vs
  event listener**: alternativas (a) event listener off-chain e (b)
  record-sem-burn foram rejeitadas — (a) não dá prova criptográfica de qual
  projeto consumiu qual burn e abre race-conditions que o Distributor não
  resolve deterministicamente; (b) permite double-spend trivial (registrar
  burn sem queimar CREDIT inflacionaria reward sem deflação, quebrando I2).
  Rodadas identificadas por `uint256` sequencial iniciando em 0 no
  constructor; `closeRound` (governance-gated) incrementa e reseta
  `roundStartedAt`. **Early close permitido** — fechar antes de
  `roundDuration` emite `RoundClosed.earlyClose=true`; é ferramenta de
  emergência documentada em NatSpec. Parâmetros governance-tunable:
  `roundDuration` (bounded `[1d, 30d]` — impede rodadas ruidosas ou
  emissão atrasada) e `maxBurnPerRoundPerProject` (sanity cap anti
  wash-burn; `0` = opt-out). 55 testes cobrindo as 16 invariantes da
  spec (happy path, access control, status Pending/Probation/Removed,
  guards zero/zero, sanity cap em 4 cenários incl. boundary exato + cap=0,
  accounting multi-projeto, `projectsWithBurnCount` único por projeto,
  closeRound normal/early/sem-governance, isolamento de rounds, faixas
  de `setRoundDuration`, integração end-to-end com `CreditToken`
  real descontando `totalSupply` corretamente). Coverage:
  **100% stmts / 100% funcs / 100% lines, 97.06% branches** (único
  branch restante é instrumentação do `nonReentrant` em `burnAndRecord`
  — `CreditToken.burnByRole` usa `_burn` nativo ERC-20 sem callback,
  portanto não há reentrância natural; guard aplicado defensivamente
  contra regressão futura, mesmo padrão aceito em `Treasury.executeBuyback`
  e `Staking.extendLock`).
- Auditoria estática com Slither 0.11.5 sobre `BurnTracker`: **zero
  findings high/medium acionáveis** no código do projeto. O relatório
  filtrado (`BurnTracker-projectonly.txt`) lista 3 famílias de findings
  atribuíveis a este contrato, todas avaliadas e aceitas:
  1. `timestamp` em `closeRound` e `isRoundReadyToClose` — uso
     deliberado. Toda a economia da rodada é em escala de **dias**
     (mínimo 1d, default 7d, máximo 30d); manipulação de `block.timestamp`
     em ordem de segundos pelo miner é irrelevante frente à granularidade
     da decisão de close. Mesmo padrão aceito em `ProjectRegistry.isInProbation`
     e nos comparadores de duração do `Staking`.
  2. `naming-convention` em `CREDIT_TOKEN` e `REGISTRY` — intencional.
     Ambos são `immutable` e seguem a convenção UPPER_CASE já adotada
     em `GovernanceToken.CAP_SUPPLY`, `CreditToken.MINTER_ROLE/BURNER_ROLE`,
     `ProjectRegistry.GOV_TOKEN`, `Staking.GOV_TOKEN/REGISTRY` e na própria
     OpenZeppelin (`DEFAULT_ADMIN_ROLE`). Suprimido no solhint via
     `// solhint-disable-next-line var-name-mixedcase`.
  3. `arbitrary-send-erc20` em `ProjectRegistry.registerProject` — finding
     herdado do contrato anterior, já analisado e aceito na Fase 2
     (falso positivo — transferFrom com `from` parametrizado é intencional
     pós-allowance explícita pelo owner). Não atinge o `BurnTracker`.
     Output bruto preservado em `audit/slither/BurnTracker.txt` (completo,
     inclui findings em `node_modules`: `pragma` mismatch `^0.8.20` vs
     `0.8.24`, `dead-code` em helpers internos do OZ, `solc-version`,
     `low-level-calls` em `SafeERC20/Address`, `assembly` em `Address._revert`
     — todos fora do escopo) e `audit/slither/BurnTracker-projectonly.txt`
     (filtrado, 7 findings totais dos quais apenas os 3 acima tocam o
     código do projeto).
- `RewardDistributor` — coração do modelo econômico (fase 4.1). Calcula a
  emissão de CREDIT por rodada seguindo a fórmula
  `emissao_R = min(max(alpha * burn_{R-1}, floor(R)), capMax)` onde
  `alpha = 0.95e18` (levemente deflacionário), `floor(R)` é um schedule
  imutável de 24 rodadas (constructor-set) que serve como safety-net de
  bootstrap, e `capMax` é o teto duro governance-tunable (default 5M CREDIT,
  bounds `[1, 100M]`). Dois pontos arquiteturais-chave: **(1) emissão
  por-projeto é calculada sob demanda** em `_calculateClaim`, não
  pré-computada em `finalizeRound` — escala o gás com claims efetuados e
  não com o número de projetos listados; **(2) split bootstrap via global
  weight** do Staking: quando `totalBurnPrev == 0` (nenhum consumo na
  rodada anterior), o share do projeto na emissão vem de
  `totalWeight_P / globalWeight` no snapshot do bloco de finalização —
  evita iteração on-chain sobre projetos. Probation inicial por tempo
  aplica penalty de 75%: projeto em probation recebe 25% do seu share
  raw; os 75% restantes **não são redistribuídos** — são simplesmente
  não-cunhados (decisão documentada: redistribuir exigiria contar
  projetos não-probation e introduziria loops, contra-balanceando a
  simplificação do claim on-demand). Superfície state-changing:
  `finalizeRound` (permission-less — qualquer um pode destravar claims
  após o `closeRound` do BurnTracker), `claim(round, projectId)` e
  `claimMany(rounds[], projectIds[])` (pull-based: usuário paga gas
  para cunhar seu próprio share, evita gas explosion push-based),
  `setAlpha` e `setCapMax` (governance-gated com bounds rígidos).
  Views: `previewClaim`, `previewEmission`, `getEmission`,
  `getProjectEmission`, `isFinalized`. Finalização é **sequencial**
  (revert `OutOfOrderFinalize` se pular) e **idempotente**
  (revert `RoundAlreadyFinalized` em reentries) — garante que
  `lastFinalizedRound` cresce monotonicamente. 48 testes cobrindo as 21
  invariantes da spec: fórmula em 3 cenários (floor > α·burn, α·burn
  em faixa média, α·burn > cap), round-0 bootstrap apenas com floor,
  out-of-order revert, double-finalize revert, round-não-fechado
  revert, claim happy path (single + multi staker, proporcional ao
  peso), claim sem stake/peso (no-op silencioso, não marca claimed),
  claim duplicado revert, probation penalty de 25%, split por burn
  70/30, bootstrap via global weight com stakes de pesos diferentes,
  previewClaim espelhando claim, claimMany batch + mismatch + empty
  - item-já-claimado + round-não-finalizado, governance matrix
    (setAlpha/setCapMax sem role → revert), emissão zero após floor
    exaurido (round 24+ sem burn → 0), end-to-end (stake → burn →
    close → finalize → claim cunha CREDIT correto). Coverage:
    **100% stmts / 100% funcs / 100% lines, 95.74% branches**
    (branches restantes são instrumentação do `nonReentrant` em
    `claim`/`claimMany` — `CREDIT.mint` usa `_mint` nativo ERC-20 sem
    callback, guard aplicado defensivamente; mesmo padrão aceito em
    `Treasury.executeBuyback`, `Staking.extendLock`,
    `BurnTracker.burnAndRecord`).
- Auditoria estática com Slither 0.11.5 sobre `RewardDistributor`:
  **zero findings high/medium acionáveis** no código do projeto. O
  relatório filtrado (`RewardDistributor-projectonly.txt`) lista 5
  famílias de findings, todas avaliadas e aceitas:
  1. `calls-loop` em `_projectShare`, `_calculateClaim` e `_claim` —
     7 chamadas externas atingidas via `claimMany`. **NÃO é bug de
     segurança**: (a) o batch é controlado pelo próprio caller
     (não há input externo que possa forçar loop longo), (b)
     `nonReentrant` blinda contra interação externa durante o
     batch, (c) todas as chamadas são para contratos do próprio
     protocolo (Registry, BurnTracker, Staking, CREDIT) — sem
     token externo malicioso com hooks. Slither alerta sobre a
     forma (external call inside loop), não sobre a substância.
     O usuário paga seu próprio gás e decide o tamanho do batch.
  2. `timestamp` — herdado do `REGISTRY.isInProbation` chamado em
     `_projectShare`. Já aceito em fase 2: a probation é em
     escala de dias (30d default), imune à manipulação de segundos
     pelo miner.
  3. `naming-convention` em `CREDIT`, `STAKING`, `BURN_TRACKER`,
     `REGISTRY` — intencional. Variáveis `immutable` seguindo a
     convenção UPPER_CASE adotada por todo o projeto (vide
     `CAP_SUPPLY`, `MINTER_ROLE`, etc.) e pela OpenZeppelin.
     Suprimido no solhint via
     `// solhint-disable-next-line var-name-mixedcase`.
  4. `arbitrary-send-erc20` em `ProjectRegistry.registerProject` —
     herdado da fase 2, já analisado e aceito. Não atinge o
     RewardDistributor.
  5. `unused-return` em `Staking._writeCheckpoints` — herdado da
     fase 3. Agora inclui `_globalWeightCheckpoints.push(...)`
     (novo trilho adicionado nesta fase). Mesma justificativa:
     `Checkpoints.Trace208.push` retorna `(old, new)` e nós já
     temos ambos capturados via `.latest()` antes do push.
     Consumir o retorno apenas para silenciar o detector
     adicionaria código inútil.
     Output bruto preservado em `audit/slither/RewardDistributor.txt`
     (completo, inclui findings em `node_modules`: `pragma` mismatch,
     `dead-code`, `solc-version`, `low-level-calls`, `assembly`,
     `divide-before-multiply` e `incorrect-exp` em
     `Math.mulDiv`/`Checkpoints`, todos fora do escopo) e
     `audit/slither/RewardDistributor-projectonly.txt` (filtrado,
     27 findings totais dos quais 5 famílias tocam o código do
     projeto).
- `Staking` — adicionado trilho de **checkpoint global** para
  alimentar o split bootstrap do `RewardDistributor`. Novo storage
  `_globalWeightCheckpoints` (`Checkpoints.Trace208` com chave
  `uint48 = block.number`, valor `uint208 = peso global`) e novos
  views `getGlobalWeight` / `getGlobalWeightAt(blockNumber)`. A
  invariante `globalWeight == SUM(totalWeightByProject)` é mantida
  em O(1) por escrita no `_writeCheckpoints` (usa o mesmo diff
  `newUserWeight - oldUserWeight` aplicado sobre o total global).
  6 testes adicionais em `Staking.test.ts` validam:
  `starts at zero`, `equals single-staker weight`,
  `aggregates across projects (sum invariant)`,
  `decrements on unstake and returns to zero on full unwind`,
  `getGlobalWeightAt returns historic values (anti flash-stake)`,
  `remains consistent under increaseStake and extendLock`.
  Coverage do `Staking.sol` permanece 100% stmts/funcs/lines.
- `FeeRouter` (fase 4.2 — encerra a fase 4) — ponto único de pagamento
  entre apps e protocolo. `pay(projectId, user, amount)` puxa CREDIT via
  `transferFrom` (user aprovou previamente) e divide em 3 fatias conforme
  split em basis points: `burnBps` (queimado via `BurnTracker.burnAndRecord`),
  `treasuryBps` (transferido ao `Treasury`), `rebateBps` (transferido ao
  `appRecipient` do projeto). Split default 95/0/5 set no constructor e
  ajustável via `setDefaultSplit` (governance). Override por projeto via
  `setProjectSplit` (flag `hasProjectSplit` separada do struct para
  distinguir "não setado" de "zeros válidos"). `clearProjectSplit` reverte
  ao default com `NoProjectSplit` em idempotência. `appRecipient` tem
  fallback dinâmico para `Registry.getProject(projectId).owner` quando
  setado com `address(0)` — acompanha `transferProjectOwnership` no
  Registry sem re-configuração manual; escrita owner-gated via
  `setAppRecipient`. Pagamento é público (qualquer endereço pode iniciar
  desde que `user` tenha aprovado) — habilita apps, smart wallets e UI
  direta sem conflito. Dust handling: resíduo de arredondamento vai
  integralmente para `toApp`, garantindo `burned + toTreasury + toApp ==
amount` bit-por-bit. Constructor valida soma do split inicial == 10_000
  e rejeita qualquer dependência em `address(0)`. 51 testes cobrindo as
  20 invariantes da spec + variantes 100/0/0, 50/50/0 e 0/50/50.
  Coverage: 100% stmts, 100% funcs, 100% lines, 97.62% branches — a
  branch restante é o re-entry path do `nonReentrant` (guard OZ), mesma
  limitação estática dos outros contratos do codebase. Slither bruto em
  `audit/slither/FeeRouter.txt` e filtrado em
  `audit/slither/FeeRouter-projectonly.txt`: único finding próprio é
  `arbitrary-send-erc20` em `pay` (false positive — é exatamente o
  modelo pretendido: user aprova allowance, qualquer caller dispara
  `transferFrom` dentro do limite já autorizado; mesmo padrão/justificativa
  do `ProjectRegistry.registerProject`) e `naming-convention` em
  `CREDIT`/`BURN_TRACKER`/`REGISTRY`/`TREASURY` (intencional, immutables
  em UPPER_CASE seguindo `DEFAULT_ADMIN_ROLE` da OZ e o padrão já adotado
  por `BurnTracker.CREDIT_TOKEN` e `ProjectRegistry.GOV_TOKEN`, suprimido
  via `solhint-disable-next-line var-name-mixedcase`). Suite total
  388 testes verdes. Fase 4 COMPLETA — próximo passo: fase 5 (Timelock +
  Governor + Ignition wiring).

### Changed

- `.solhint.json`: renomeia as regras `contract-name-camelcase` e
  `event-name-camelcase` para `contract-name-capwords` e
  `event-name-capwords`. As regras antigas foram renomeadas no solhint
  (v5.2.0 em uso) — os warnings "Rule '...' doesn't exist" foram
  eliminados preservando a intencao original (validar CapWords em
  contratos e eventos). `npm run lint` agora sai 0 warnings 0 errors.
- Pinning de `@openzeppelin/contracts` em `5.0.2` (exato, sem caret) no
  `package.json`. Intencional: a série 5.0.x está estabilizada e a 5.1.x /
  5.6.x introduzem mudanças de behavior em `AccessControl`, `ERC20Votes` e
  `Governor` que exigem re-auditoria. Qualquer bump dessa dependência deve
  disparar nova rodada de testes + slither + revisão das invariantes I1–I7
  antes de mergear.

### Fixed

- Corrige 3 erros de typecheck pre-existentes em `scripts/deploy-dev.ts`,
  `test/BurnTracker.test.ts` e `test/CommunityGovernor.test.ts`:
  (1) tipagem do JSON de parametros Ignition trocada de
  `Record<string, Record<string, unknown>>` para o tipo oficial
  `DeploymentParameters` importado de `@nomicfoundation/ignition-core`,
  eliminando TS2322 na chamada `hre.ignition.deploy()`;
  (2) cast do `NewTracker.attach(ethers.ZeroAddress)` para o tipo
  concreto `BurnTracker` do TypeChain (via `as unknown as BurnTracker`)
  para expor a property `DEFAULT_ADMIN_ROLE`, resolvendo TS2339 que
  antes vinha porque `attach` retorna `BaseContract` generico;
  (3) troca `governor.quorumNumerator()` por
  `governor["quorumNumerator()"]()` — TypeChain gera overloads com
  assinatura explicita (`quorumNumerator()` e `quorumNumerator(uint256)`)
  quando o contrato OZ Governor tem ambas as versoes, e nao ha property
  bare `quorumNumerator`, resolvendo TS2551. Fix puro de tipagem:
  nenhuma mudanca de runtime, 489/489 testes verdes, lint limpo,
  `npm run typecheck` passa 100%.
- Renomeia storage public `target` -> `attackTarget` em
  `contracts/test/ReentrantERC20Mock.sol` e
  `contracts/test/ReentrantStakingERC20Mock.sol` para eliminar colisao
  entre o getter auto-gerado `target()` e a property nativa
  `target: string | Addressable` de `BaseContract` (ethers v6). A
  colisao quebrava `npm run typecheck` nos arquivos gerados pelo
  TypeChain (`typechain-types/contracts/test/Reentrant*Mock.sol/*.ts` e
  factories correspondentes) com TS2430/TS2416/TS2352. Refactor puro:
  nenhuma mudanca de comportamento em runtime, 489/489 testes verdes,
  coverage mantida (100% stmts / 99.84% lines / 97.51% branch),
  slither sem regressoes. Funcoes `armAttack`/`armStakeReentry`/
  `armUnstakeReentry`/`armIncreaseStakeReentry`/`armUnstakeAllReentry`
  e hook `_update` atualizados para referenciar `attackTarget`.

### Removed

- Dead code em `test/BurnTracker.test.ts` no `it("does not grant
RECORDER_ROLE to anyone by default")`: bloco que fazia cast de
  `NewTracker.attach(ethers.ZeroAddress)` para `BurnTracker` apenas para
  tipar uma variavel `ADMIN_ROLE` descartada com `void`. O bloco nao
  contribuia para a asserção real do teste (que segue intacta:
  `hasRole(RECORDER_ROLE, admin) === false`). Import orfao
  `import type { BurnTracker } from "../typechain-types"` tambem removido
  — era usado apenas por esse cast. 489/489 testes verdes, typecheck
  limpo.

### Security

- `audit/slither/TeamVesting.txt` + `-projectonly.txt`: apenas findings
  project-relevantes sao `incorrect-equality` em `release()`
  (`amount == 0` — guard canonico sobre retorno de `releasable()`,
  triage ACCEPTED — mesmo padrao aceito em `Treasury.transfer`) e
  `timestamp` em 4 funcoes (releasable/release/revoke/\_vestedAmount —
  triage ACCEPTED: contrato de vesting e intrinsicamente temporal,
  drift de ~15s irrelevante em cronograma de anos). Zero findings
  high/medium. O restante e ruido de library OZ (dead-code em
  Context, pragma ^0.8.20, assembly em Address, low-level-calls em
  SafeERC20, naming em IERC20Permit).
- `audit/slither/UserSubsidy.txt` + `-projectonly.txt`: unico finding
  project-relevante e `timestamp` em 3 funcoes
  (createCampaign/claim/isEligible — triage ACCEPTED: deadline em
  escala de dias a semanas, drift de ~15s irrelevante, padrao
  identico ao de `ProjectRegistry.isInProbation`). Zero findings
  high/medium.
- Invariante de governanca **I4** ("owner de contratos criticos e o Timelock")
  e **I7** ("projetos entram no Registry apenas via Timelock") validadas
  end-to-end pelo par `CommunityTimelock` + `CommunityGovernor`. O teste
  `full E2E: propose -> queue -> execute` demonstra I4 transferindo USDC do
  Treasury via proposta ratificada pelos voters, apos `admin` renunciar
  `GOVERNANCE_ROLE` — chamada direta do admin revert com
  `AccessControlUnauthorizedAccount`. O teste `full E2E: register project`
  demonstra I7 registrando um projeto via proposta; chamada direta do admin
  apos renuncia revert com o mesmo custom error. Invariante **I5** ("voto
  usa snapshot via ERC20Votes") validada indiretamente por `GovernorVotes`
  - `GovernorVotesQuorumFraction` com `getPastVotes` / `getPastTotalSupply`
    — mais um teste explicito confirma que `quorum(snapshot) = totalSupply *
4 / 100`.
- `hardhat.config.ts`: `viaIR` habilitado (`viaIR: true`). Motivacao:
  `CommunityGovernor` com o stack completo da OZ 5.0.x estoura o limite de
  24.576 bytes do EIP-170/Spurious Dragon no pipeline classico (bytecode
  deployed ~29.2KB com optimizer=200). O pipeline via IR reduz o mesmo
  contrato para **15.324 bytes** (9.252 bytes abaixo do limite). Efeito
  colateral: todos os contratos do projeto agora recompilam via IR; a
  suite de 429 testes continua 100% verde sem mudanca observavel, e os
  bytecodes dos outros contratos permanecem confortavelmente abaixo do
  limite (o maior apos Governor e GovernanceToken @ 9.255 bytes).
- `CommunityTimelock` auditado com Slither 0.11.5: zero findings no codigo
  do projeto (project-only). O Timelock concentra custodia de todos os
  poderes `GOVERNANCE_ROLE` em producao; qualquer bypass quebraria I4/I7.
  Cenario de deploy documentado prescreve `executors=[address(0)]`
  (execucao publica apos delay — o delay e o gate real) e
  CANCELLER_ROLE mantido **apenas** com o Governor, para impedir DoS de
  propostas validas por guardian externo.
- `CommunityGovernor` auditado com Slither 0.11.5: zero findings no codigo
  do projeto (project-only). Warning de code size no output bruto do
  Slither e inerte no pipeline real do projeto (confirmado acima).
- Invariantes econômicas I2, I4 e I7 asseguradas pelo `FeeRouter`: todo
  consumo de CREDIT passa por `pay`, que revalida `Registry.isActive` antes
  de distribuir qualquer fatia (bloqueia Pending/Probation/Removed em um
  único ponto — inclusive treasury e rebate, não só burn), executa `_burn`
  via caminho atômico `FeeRouter → BurnTracker → CreditToken.burnByRole`
  (decrementa `totalSupply` on-chain, nenhum caminho re-cunha ou desvia
  CREDIT queimado), e deixa os setters econômicos (`setDefaultSplit`,
  `setProjectSplit`, `clearProjectSplit`) restritos a `GOVERNANCE_ROLE`
  (concedida ao Timelock em produção). `setAppRecipient` é owner-gated
  (mesmo rationale do `ProjectRegistry.updateMetadata`): rotação
  operacional do endereço de rebate não exige ciclo de proposta/voto, e
  o escopo do poder é restrito ao próprio slot do projeto.
- `FeeRouter.pay` aplica CEI rigoroso: validações → `transferFrom` de
  entrada → distribuições (`transfer` para app, `transfer` para treasury,
  `forceApprove` + `BurnTracker.burnAndRecord`). `nonReentrant` ativo em
  todo o pipeline como defesa-em-profundidade mesmo sabendo que `CREDIT`
  é ERC-20 confiável sem callbacks — blinda contra regressão futura se
  token ou tracker mudarem. `BurnTracker.burnAndRecord` tem seu próprio
  `nonReentrant`, cross-contract guard cobre reentrada por qualquer via.
- `FeeRouter` usa `SafeERC20.forceApprove` em vez de `approve` direto
  antes de `burnAndRecord`, garantindo allowance exata mesmo se por
  qualquer motivo houvesse resíduo de uma chamada anterior (não deveria
  haver — pattern é allowance-then-burn imediato, mas `forceApprove` é
  barato e correto).
- `FeeRouter` não mantém custódia de CREDIT entre chamadas: cada `pay`
  recebe, distribui, queima e termina com saldo zero (teste
  `Router nao retem CREDIT` valida explicitamente). Decisão consciente
  contra adicionar `sweep` no v1 — qualquer centralização de escape
  reduziria a garantia estrutural de "roteador sem custódia". Se fundos
  ficarem presos por anomalia (ex.: token enviado direto por engano),
  remediação é via upgrade proposto pelo Governor.
- Dust handling (`amount - burned - toTreasury` → `toApp`) garante que a
  soma das 3 fatias reconstitui `amount` bit-por-bit em qualquer split
  com soma == 10_000, eliminando vazamento silencioso de wei por
  arredondamento.
- Invariantes econômicas I1, I4 e I5 asseguradas pelo `GovernanceToken` e
  cobertas por testes dedicados (`reverts when exceeding the cap`,
  `transferOwnership starts a pending transfer`, `getPastVotes returns the
snapshot at a past timepoint`).
- `_maxSupply()` do ERC20Votes override para `CAP_SUPPLY`, fechando qualquer
  caminho interno de cunhagem que bypass-aria a checagem de cap.
- Invariante econômica I2 (burn no consumo) assegurada pelo `CreditToken`:
  cobertura tripla (self-burn / allowance burn / role-gated burn), cada uma
  testada com happy path e caminhos de falha (saldo insuficiente, allowance
  insuficiente, role ausente, alvo zero, amount zero). Nenhum caminho re-cunha
  ou desvia tokens queimados — `_burn` do ERC-20 decrementa `totalSupply`
  diretamente, garantindo deflação.
- `burnByRole` deliberadamente NÃO consome allowance (testado explicitamente
  em `does not consume allowance (by design — atomic consumption path)`).
  A decisão é documentada em NatSpec com justificativa UX/atomicidade e
  mitigação via gating de role concedida apenas via Timelock.
- Construção do `CreditToken` rejeita `address(0)` como `initialAdmin` com
  erro custom `ZeroAddress` — impede deploy acidental sem admin válido (que
  deixaria o token com roles inalcançáveis e genesis inexecutável).
- Flag `genesisMinted` one-shot com custom error `GenesisAlreadyMinted`
  impede re-execução do genesis mesmo por `DEFAULT_ADMIN_ROLE`
  comprometido — após o primeiro `mintGenesis`, a única via de cunhagem é
  via `MINTER_ROLE` (economicamente controlada pelo distributor com cap por
  rodada, invariante I3).
- Invariante econômica I7 (projetos só via Timelock) assegurada pelo
  `ProjectRegistry`: todas as funções de mudança de status
  (`registerProject`, `activateProject`, `setProbation`, `reactivate`,
  `removeProject`) e ajuste de parâmetros (`setMinCollateral`,
  `setProbationDuration`) são gated por `onlyRole(GOVERNANCE_ROLE)`.
  Teste dedicado `I7: no state-changing status function is callable by a
non-governance account` valida a gating em um loop sobre todas as 7
  funções. As únicas escapes são `updateMetadata` e
  `transferProjectOwnership`/`acceptProjectOwnership`, owner-gated por
  design (correções de metadata off-chain e 2-step transfer não justificam
  ciclo de proposta/voto).
- Colateral custódia exata no `ProjectRegistry`: teste
  `collateral custody is exact` verifica que `balanceOf(registry)` ==
  soma dos colaterais vivos após múltiplos registros. `removeProject`
  zera `collateral` na storage **antes** de executar o transfer (CEI),
  blindando contra qualquer reentrância mesmo sem `ReentrancyGuard`.
- `ProjectRegistry.registerProject` explicitamente checa
  `govToken.allowance(owner, registry) >= collateralAmount` antes do
  `safeTransferFrom` e reverte com `InsufficientAllowance(provided,
required)` — mensagem de auditoria/UX mais clara que o revert genérico
  do ERC-20, e sinaliza inequivocamente que o owner precisa ter consentido
  via `approve` antes do Timelock executar o registro (mitigação da
  observação `arbitrary-send-erc20` do Slither).
- `ProjectRegistry.transferProjectOwnership` usa padrão 2-step (initiate +
  accept) análogo a `Ownable2Step` da OZ — evita transferir ownership para
  endereço errado/inalcançável. `removeProject` cancela qualquer
  transferência pendente ao marcar o projeto como `Removed`, impedindo
  que um pending owner "ressuscite" o controle de um projeto removido.
- `ProjectRegistry` distingue duas semânticas de "probation" — inicial por
  tempo (view `isInProbation`, reduz peso de rewards temporariamente) e
  punitiva (status `Probation` do enum, suspende o projeto até
  `reactivate`). A distinção é documentada em NatSpec contract-level e
  testada explicitamente (`isInProbation returns false for non-Active
projects even within the time window`).
- Invariante econômica I4 (governança via Timelock) assegurada no
  `Treasury`: TODAS as 5 funções que movem fundos
  (`transfer`, `batchTransfer`, `payRebates`, `executeBuyback`,
  `sweepETH`) são gated por `onlyRole(GOVERNANCE_ROLE)`, sem escape
  via `DEFAULT_ADMIN_ROLE`. Teste dedicado
  `no governance-gated function is callable by non-role account`
  itera sobre as 5 funções e valida o revert
  `AccessControlUnauthorizedAccount`.
- **Ausência intencional de `Pausable`** no `Treasury`. Qualquer papel
  com poder unilateral de congelar a tesouraria é vetor de captura
  (admin? guardian? governance?). A DAO optou por não adicionar pausa:
  se um contrato dependente quebrar, a correção é via Timelock
  substituindo o consumidor, não congelando fundos. Decisão documentada
  em NatSpec contract-level.
- **`executeBuyback` é stub v1** — emite `BuybackRequested` mas não
  executa swap. Integração real com DEX (Uniswap v3 / Balancer) fica
  para fase posterior, quando modelo de slippage, TWAP e proteção
  anti-MEV estiver validado. Guard exige `minGovOut > 0` (slippage
  finito) desde já para evitar que a interface seja usada sem declarar
  o limite de execução. `nonReentrant` aplicado defensivamente para
  que a substituição futura do stub pela integração real não exija
  refactor de segurança.
- `Treasury.sweepETH` usa `to.call{value: amount}("")` com `nonReentrant`
  e retorno checado via custom error `ETHTransferFailed`. O padrão
  `.call` é obrigatório pós-EIP-2929; `.send`/`.transfer` com
  2300-gas-stipend falham em destinatários contratuais válidos. Teste
  com `ReentrantETHReceiver` que tenta reentrar via `receive` confirma
  que drain é bloqueado (saldo do treasury não muda em ataque).
- `Treasury` recebe ERC-20 arbitrários passivamente (sem `deposit`) e
  aplica `nonReentrant` em todas as saídas de fundos. Justificativa:
  tokens externos podem ter hooks em `_update` (ERC-777 legacy ou
  ERC-20 customizados maliciosos), e CEI sozinho não cobre vetor
  multi-call no mesmo token. Testado com `ReentrantERC20Mock` que
  dispara callback durante o próprio `transfer`/`transferFrom` —
  revert com `ReentrancyGuardReentrantCall` em `transfer`,
  `batchTransfer` e `payRebates`.
- Invariante **I5 estendida ao cálculo de rewards** pelo `Staking`:
  o `RewardDistributor` (fase 4) deve consultar peso via
  `getWeightAt(user, projectId, blockN)` /
  `getTotalWeightAt(projectId, blockN)` com `blockN` ancorado ao
  início da rodada, nunca pelo estado corrente. Isso replica a
  proteção anti-flash-loan do ERC20Votes para a dimensão de
  share-of-rewards. Testes dedicados
  (`getWeightAt returns historic weight at a past block`,
  `getTotalWeightAt aggregates correctly across multiple stakers
over time`, `returns 0 for queries before any checkpoint`)
  validam a semântica de `Checkpoints.Trace208.upperLookupRecent`.
- Invariante **I6 (lock mínimo 14d)** assegurada pelo `Staking`:
  `stake` e a função pure `multiplier` revertem com `LockTooShort`
  para `lockDuration < MIN_LOCK`; `extendLock` herda o invariante
  (lock atual sempre >= MIN_LOCK por construção, e só pode aumentar).
  Lock máximo 365d é um teto do **multiplier** (satura em 4x), não
  do lock temporal — locks acima de 365d são aceitos literalmente
  e o tempo real é respeitado em `unstake`. Decisão documentada em
  NatSpec para não surpreender staker que queira lock multi-ano
  com peso 4x.
- **Consolidação Opção B** do `Staking.stake`: quando há posição
  preexistente, `newLockDuration = max(remainingOld, newLockDuration)`
  e `lockStartAt` reseta para `block.timestamp`. O reset é
  **intencional** — sem ele, um staker poderia manter peso alto
  indefinidamente fazendo micro-stakes que "alongam" a duração
  sem re-commitar temporalmente o amount antigo. Documentado em
  NatSpec contract-level; testes
  `consolidates existing position with Opcao B (I6 — max, reset start)`,
  `consolidation picks newLockDuration when greater than remaining`
  e `consolidation with expired lock: remaining is 0, adopts
newLockDuration` exercitam os três ramos.
- **Bypass de lock em `Removed`** (e apenas em `Removed`) pelo
  `Staking.unstake`: projeto removido pela governança libera o
  stake imediatamente (evento `EarlyUnstakeAllowed` + `Unstaked`).
  Probation (punitiva ou inicial por tempo) **não** bypassa lock —
  apenas bloqueia stake novo. Decisão alinhada com ética do modelo:
  punir o **projeto** (via remoção + slash via Registry) não deve
  prender o **staker**. Testes `bypasses lock when project is Removed`,
  `Removed bypass is independent of lock expiry`,
  `respects Probation — lock still enforced` validam a matriz.
- `Staking.increaseStake` **não reabre lock expirado** — preserva
  `lockStartAt` e `lockDuration` mesmo que o lock já tenha vencido.
  Se o staker quer re-committar temporalmente, usa `stake()` que
  aplica Opção B. Teste
  `does not re-open an expired lock (semantics: use stake() to reset
start)` documenta explicitamente o comportamento para evitar
  surpresa futura.
- `Staking` aplica `ReentrancyGuard` em **todas as 5 funções**
  state-changing (`stake`, `increaseStake`, `extendLock`, `unstake`,
  `unstakeAll`), inclusive as que não movem tokens (`extendLock`) ou
  que só fazem `safeTransfer` de GOV (ERC20Votes conhecido sem
  callbacks). O guard é defensivo contra regressões futuras
  (ex.: swap do token por um wrapper com hook) e custa ~2k gas.
  Ataques simulados com `ReentrantStakingERC20Mock` (em 4 modos:
  stake-on-pull, unstake-on-push, increaseStake-on-pull,
  unstakeAll-on-push) revertem com `ReentrancyGuardReentrantCall`
  em todos os caminhos.
- `Staking._writeCheckpoints` atualiza o agregado por projeto como
  `newProjectWeight = oldProjectWeight - oldUserWeight + newUserWeight`
  em vez de iterar sobre N stakers — O(1) por escrita. A aritmética
  é segura por invariante: `oldProjectWeight >= oldUserWeight` porque
  o total do projeto agrega todos os usuários, e o `Checkpoints.Trace208`
  obriga chaves monotônicas (`block.number`), garantindo que cada
  escrita se apoie no último checkpoint consistente.
- `Staking` recusa `address(0)` como `govToken_` e `registry_` no
  constructor via `ZeroAddress`. `SafeCast` (OZ) é usado em todas as
  conversões para `uint48` (block number) e `uint208` (peso) — reverte
  explicitamente em overflow em vez de truncar silenciosamente.
- Invariante **I2 (burn no consumo) fechada on-chain** via `BurnTracker`:
  o caminho atômico `app → BurnTracker.burnAndRecord →
CreditToken.burnByRole → _burn` garante que (1) o CREDIT é efetivamente
  destruído (`totalSupply` decrementa) e (2) o burn fica atribuído a um
  `projectId` específico com prova criptográfica on-chain (evento
  `BurnRecorded` + mapping `burnByRoundProject`). Testes dedicados
  (`burns CREDIT atomically and records burn (I1, I16)`, integração
  `real CreditToken + real Registry + multi-round lifecycle (I16)`)
  validam que supply e accounting caminham juntos em todos os cenários.
- Invariante **I7 estendida ao consumo** pelo `BurnTracker`: apenas
  projetos em status `Active` no `ProjectRegistry` podem ter burn
  atribuído. Status `Pending`, `Probation` (punitiva ou por tempo),
  `Removed` ou projeto inexistente revertem com `ProjectNotActive`.
  Testes dedicados cobrem cada estado (`reverts when project is
Pending`, `reverts when project is Probation`, `reverts when project
is Removed`, `reverts when project does not exist`). **Decisão
  explícita**: se um projeto vira Probation/Removed DEPOIS de já ter
  queimado na rodada atual, o burn já registrado NÃO é revertido —
  história é história e a matemática da rodada permanece consistente;
  apenas novos burns são bloqueados. Documentado em NatSpec
  contract-level.
- **Sanity cap anti wash-burn** no `BurnTracker`
  (`maxBurnPerRoundPerProject`, governance-tunable): limita o total
  queimável por `(round, projectId)` para evitar que um projeto
  malicioso queime quantidades arbitrárias num único tx e capture
  share desproporcional de rewards na rodada. `0` desativa o gating
  (opt-out explícito via governança). A checagem é feita antes do
  burn real, usando o valor vigente no momento da chamada — não
  retroativa sobre burns já acumulados. Teste `enforces sanity cap
when > 0`, `allows exactly at cap (boundary)`, `cap == 0 means no
limit` e `sanity cap is per (round, project) — different projects
independent` exercitam os 4 cenários.
- **`closeRound` é permission-gated (GOVERNANCE_ROLE)** no
  `BurnTracker`, nunca permission-less. Motivação: evitar race /
  captura onde qualquer um poderia fechar a rodada no instante mais
  favorável a um projeto específico. Governança (Timelock em
  produção) decide quando fechar, dentro ou fora do `roundDuration`.
  **Early close** (antes do `roundDuration`) é permitido e marcado
  como `earlyClose=true` no evento `RoundClosed` para trilha de
  auditoria; é ferramenta de emergência documentada. Testes
  `normal close after roundDuration (earlyClose=false, I9)` e
  `early close before roundDuration (earlyClose=true, I10)`
  validam a semântica.
- **Bounds rígidos em `roundDuration`** (`[1d, 30d]`, enforcement em
  `setRoundDuration` e no constructor) no `BurnTracker`. Limite
  inferior impede rodadas micro-curtas com contabilidade ruidosa
  demais para rewards; superior impede rodadas longas que atrasariam
  emissão e criariam dead weight no orçamento. `InvalidRoundDuration`
  custom error carrega os três args (provided, min, max) para
  mensagem de auditoria clara. Testes de boundary exato cobrem os
  dois extremos (`accepts exactly MIN_ROUND_DURATION (boundary)` e
  `accepts exactly MAX_ROUND_DURATION (boundary)`).
- **CEI estrito** em `BurnTracker.burnAndRecord`: todos os checks
  primeiro (role, address, amount, status, cap), então todas as
  mutações de storage (`burnByRoundProject`, `totalBurnByRound`,
  `projectsWithBurnCount`), emit do evento, e finalmente o call
  externo ao `CreditToken.burnByRole`. Como `burnByRole` usa `_burn`
  nativo ERC-20 sem callback, não há vetor real de reentrância —
  mas seguir CEI mantém consistência com o restante do codebase e
  blinda contra regressão futura (ex.: substituição do CreditToken
  por um token com hook `_afterTokenTransfer`). `nonReentrant`
  aplicado como defesa-em-profundidade porque recorders são apps
  terceiros cujo bytecode não controlamos.
- `BurnTracker` rejeita `address(0)` em `admin`, `creditToken` e
  `registry` no constructor via `ZeroAddress`; `initialRoundDuration`
  deve estar em `[1d, 30d]` senão `InvalidRoundDuration`.
  `initialSanityCap == 0` é explicitamente aceito (opt-out documentado).
- Invariantes econômicas **I3 (cap por rodada) + I5 (snapshot anti
  flash-loan) + I6 (lock mínimo) fechadas on-chain** pelo
  `RewardDistributor`. I3: fórmula
  `emissao = min(max(α·burn, floor), capMax)` garante teto duro via
  `capMax` (governance-tunable, bounded `[1, 100M]` CREDIT) e
  safety-net via `floorSchedule` imutável de 24 rodadas; emissão
  **nunca** excede `capMax` (teste dedicado
  `formula: cap when alpha*burn > capMax` com burn forçando
  `α·burn = 5.7M > capMax = 5M`). I5: toda consulta de peso no claim
  é `Staking.getWeightAt(user, projectId, snapshotBlock)` /
  `getTotalWeightAt` / `getGlobalWeightAt`, onde `snapshotBlock` é
  registrado atomicamente em `finalizeRound` e imutável daí em
  diante — flash-stake na mesma rodada após o finalize **não**
  afeta share de reward (testes
  `claim happy path with single staker in bootstrap round` e
  `bootstrap split via global weight` validam que peso histórico
  conduz o cálculo). I6: como o lock mínimo do Staking é 14d e o
  peso é computado com `Checkpoints.Trace208` monotônico, não é
  possível flash-stake em um bloco e sair no próximo capturando
  reward — o custo temporal é real.
- **Sequencialidade + idempotência de `finalizeRound`** no
  `RewardDistributor`: a rodada R só pode ser finalizada se
  `R == lastFinalizedRound + 1` (ou `R == 0` no primeiro finalize)
  e se `!roundData[R].finalized`. Ordem dos checks intencional:
  `RoundAlreadyFinalized` é verificado **antes** de
  `OutOfOrderFinalize` para que reentries retornem o erro
  específico. Testes `reverts on out-of-order (skip)` e
  `reverts on double finalize` cobrem a matriz. Sequencialidade
  é invariante estrutural: `previewEmission`, claims e reports
  off-chain assumem que `lastFinalizedRound` é monotonicamente
  crescente sem gaps.
- **Snapshot imutável de `totalBurnAtFinalize`** em cada `RoundData`:
  mesmo que o mapping `totalBurnByRound` do `BurnTracker` pudesse
  mudar (não pode, mas defensiva), a fórmula de emissão é
  congelada no momento do finalize. Impede que qualquer
  manipulação retroativa dos mappings do tracker afete rewards
  já destravados. Validado implicitamente pelos testes de
  formula (rd.totalBurnAtFinalize vs valor calculado).
- **Permissionless `finalizeRound`** no `RewardDistributor`:
  qualquer conta pode chamar após o `closeRound` do tracker.
  Motivação: destravar claims não deve depender de governança —
  governança já decidiu o round ao fechá-lo. Se o distributor
  exigisse `GOVERNANCE_ROLE` para finalize, um Timelock
  comprometido poderia atrasar rewards indefinidamente. O
  resultado de `finalizeRound` é deterministicamente derivado
  de `alpha`, `capMax`, `floorSchedule` e `totalBurnByRound` —
  quem chama não influencia o valor.
- **Pull-based claim** no `RewardDistributor`: rewards **não são
  auto-cunhados**. Usuários invocam `claim` ou `claimMany` para
  receber CREDIT. Elimina gas explosion que push-based teria
  em rodadas com milhares de stakers e delega o custo para
  quem se beneficia. `claimed[round][projectId][user]`
  flag single-bit previne double-claim; `claim` com amount=0
  é no-op silencioso (não marca claimed) — deixa aberto o
  caminho caso o estado mude posteriormente (improvável, mas
  defensivo).
- **Probation penalty = 25%** (share / 4) no `RewardDistributor`,
  com os 75% restantes **queimados** (não redistribuídos).
  Decisão documentada em NatSpec contract-level: redistribuir
  exigiria enumerar projetos não-probation (loop ou contador),
  aumentando complexidade e gás do claim. Queimar os 75% é um
  desincentivo cristalino contra projetos em probation e
  preserva o cap econômico (emissão real nunca excede o share
  calculado). Testado em `probation penalty: projeto probation
recebe 25%` (dois projetos ambos em probation, ambos recebem
  25% do seu share raw).
- **Bootstrap via global weight** do Staking no
  `RewardDistributor`: quando `totalBurnPrev == 0`
  (nenhum consumo na rodada anterior — cenário natural no
  round 0 e em períodos de inatividade), o share do projeto na
  emissão é `totalEmission * projectWeight / globalWeight` no
  snapshot. Requer `Staking.getGlobalWeightAt` (trilho de
  checkpoint global adicionado nesta fase, com invariante
  `globalWeight == SUM(projectWeight)` mantida em O(1) por
  update). Alternativas rejeitadas:
  (a) contar projetos ativos on-chain (exigiria enumerar Registry),
  (b) split igualitário entre todos os ativos (ignora stake real,
  incentivaria ghost-projects sem comunidade). Global weight é a
  escolha que preserva "stake-gated rewards" mesmo em bootstrap.
- `RewardDistributor` rejeita `address(0)` em todos os 5
  parâmetros de endereço do constructor (`admin`, `credit`,
  `staking`, `burnTracker`, `registry`) via `ZeroAddress`.
  `alpha` validado em `[MIN_ALPHA, MAX_ALPHA] = [0.5e18, 1.1e18]`
  tanto no constructor quanto em `setAlpha` via
  `InvalidAlpha(provided, min, max)`. `capMax` validado em
  `[MIN_CAPMAX, MAX_CAPMAX] = [1e18, 100M·1e18]` via
  `InvalidCapMax`. Bounds são imutáveis para ancorar o modelo
  econômico em limites auditáveis: mudanças exigem nova
  auditoria do contrato.

[Unreleased]: https://github.com/cesarstenico/web3community/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cesarstenico/web3community/releases/tag/v0.1.0
