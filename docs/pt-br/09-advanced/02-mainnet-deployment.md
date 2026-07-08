# Mainnet deployment

> ⚠️ **Nota de legado (remodel 2026-07-08)**: este procedimento cobre o deploy do módulo core e cita parâmetros do trilho antigo (alpha, split 70/20/10, roles do BurnTracker/RewardDistributor) **como vigentes** — trate-os como legado. O deploy do trilho vigente (CreditPSM, FeeRouterV2, ProjectFunding — hoje via `scripts/deploy-remodel.ts`) ainda precisa ser incorporado ao procedimento de mainnet. Bloqueadores pré-mainnet adicionais: auditoria externa **e parecer jurídico do rev-share** (ver [Riscos](../06-for-investors/03-risk-and-security.md)).

**Para quem é:** equipe técnica fazendo deploy em rede pública.
**Pré-requisitos:** familiaridade com Hardhat + Ignition.

Este documento **não** é "como rodar `ignition deploy`" — isso está automatizado. É o **procedimento crítico** antes, durante e depois do deploy, que garante que a DAO nasça segura.

## O paradoxo do bootstrap

Toda DAO ERC20Votes + Timelock + Governor tem o mesmo dilema:

> Para mudar o estado do protocolo, precisa passar por proposta.
> Para fazer a primeira proposta, precisa de GOV delegado acima do threshold.
> Para ter GOV, alguém precisa ter mintado.
> Mas mintar já é uma mudança de estado.

Existe uma janela — entre o deploy e o `acceptOwnership` do Timelock — em que **um único endereço (o deployer) tem o poder soberano** de decidir quanto GOV existe e quem recebe. Esse poder é necessário para o bootstrap. É também o maior risco operacional.

Três formas saudáveis de fechar essa janela:

1. **Multi-sig como deployer** — não uma EOA. Gnosis Safe 4-de-7 com signatários públicos.
2. **Mint mínimo para bootstrap** — mintar apenas o necessário para passar o `proposalThreshold`, não os 100M. Distribuição real vem depois, via propostas.
3. **Handoff rápido** — `acceptOwnership` deve ser a primeira proposta. Quanto menos tempo o deployer for owner, menor a janela.

## As 4 fases

| Fase | Quando | Atores | Entrega |
|---|---|---|---|
| **F0 — Pré-deploy** | T-8 a T-1 semanas | Auditores, multisig, time | Código auditado, monitoramento em pé, multisig operacional |
| **F1 — Deploy** | Dia D | Deployer (multisig) | 10 contratos core on-chain, verificados no Etherscan (de 15 contratos de produção no repo; auxiliares e a Fase 1 do CLP são opcionais) |
| **F2 — Bootstrap** | D+1 a D+12 | Deployer → Governor | `acceptOwnership` executado; Timelock é owner |
| **F3 — Distribuição** | D+12 a D+90 | DAO (multisig + holders) | GOV distribuído via propostas |
| **F4 — Handoff completo** | D+90+ | Comunidade | Multisig perde maioria do voto |

Cada fase tem um gate. Se o gate falha, **não avança**.

## F0 — Pré-deploy

Checklist obrigatório:

- [ ] **Auditoria externa completa.** Trail of Bits, OpenZeppelin, Certik ou Zellic. Escolher uma (preferencialmente duas) e fechar todos os findings high/medium. Findings low/informational documentados como aceitos.
- [ ] **Relatório de auditoria público** antes do deploy.
- [ ] **Bug bounty ativo** no Immunefi (critical: faixa $50k-$250k) a partir do dia D.
- [ ] **Multisig operacional.** Gnosis Safe com ≥4 signatários geograficamente distribuídos. Threshold 3/5 ou 4/7. Signatários com reputação pública.
- [ ] **Teste em Sepolia por ≥ 14 dias** rodando o mesmo perfil de produção — incluindo `acceptOwnership` + 3 propostas reais.
- [ ] **Monitoramento on-chain** configurado antes do deploy: Forta, Tenderly, OZ Defender. Eventos críticos: `CapExceeded`, `SanityCapExceeded`, `RoundClosed(earlyClose=true)`, `Transferred` (Treasury), `RoleGranted`, `RoleRevoked`.
- [ ] **Runbook de incidente** escrito: quem apaga fogo, quem cancela proposta, quem comunica holders.

### Contratos externos dependentes

Estes **não** estão no módulo principal e precisam existir antes do deploy ou antes das propostas de distribuição correspondentes:

- **Vesting (team)** — usa `TeamVesting` do próprio repo (auditado junto com o resto). Em mainnet, a recomendação é deployar via módulo separado (`ignition/modules/TeamVesting.ts`) após a DAO aprovar o beneficiário e o cronograma — o `Dao.ts` principal aceita opcionalmente `DEPLOY_TEAM_VESTING=true` para deploy all-in-one (ver abaixo), mas em prod o caminho via proposta é preferível.
- **UserSubsidy** — singleton Merkle no repo (`ignition/modules/UserSubsidy.ts`). Deployado via módulo separado após a DAO decidir funding. Flag opcional `DEPLOY_USER_SUBSIDY=true` no `Dao.ts` para dev/testnet.
- **Sale contract (public sale)** — **não existe no repo**. A definir por proposta: bonding curve, fixed-price, LBP etc. Precisa ser desenhado, auditado e deployado antes da proposta #4 (mint 20M GOV para a venda pública).
- **Liquidity pool / LiquidityManager** — **não existe no repo**. Endereço e configuração do pool Uniswap V2/V3 ou Balancer onde os 10% de liquidity bootstrap serão provisionados. Precisa ser desenhado antes da proposta #6.
- **LPRewards / liquidity-mining** — **não existe no repo**. Necessário se parte dos 15% community rewards for programada como LP mining (em vez de apenas airdrops via `UserSubsidy`).

### Deploy opcional de auxiliares no `Dao.ts`

`ignition/modules/Dao.ts` suporta env vars de build-time (todas default `false`):

- `DEPLOY_TEAM_VESTING` — `TeamVesting` (1 beneficiário).
- `DEPLOY_USER_SUBSIDY` — `UserSubsidy` (singleton Merkle).
- `DEPLOY_CLP_PHASE1` — `LiquidityGauge` + `RewardDistributorV2` (Fase 1 do pivot CLP).
- `DEPLOY_CLP_ORACLE` — `CreditPriceOracle` (adapter TWAP CREDIT/USDC + sanity Chainlink).

O módulo **não concede role alguma** aos contratos do CLP nem chama `Treasury.setPriceOracle` — isso são atos de governança pós-deploy (ver "Wiring pós-deploy do CLP" abaixo).

```bash
# Default (caminho de produção recomendado) — 10 contratos core:
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet

# All-in-one (dev/testnet) — inclui TeamVesting (1 beneficiário) + UserSubsidy:
DEPLOY_TEAM_VESTING=true DEPLOY_USER_SUBSIDY=true \
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet

# Com a Fase 1 do CLP (gauge + distributorV2 + oracle):
DEPLOY_CLP_PHASE1=true DEPLOY_CLP_ORACLE=true \
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet
```

`DEPLOY_CLP_ORACLE` só deve ser ativado com `creditUsdcPool` e `usdcAddress` **reais** nos parâmetros — o constructor do `CreditPriceOracle` reverte com `ZeroAddress` (ou `PoolTokenMismatch`) se pool/USDC forem placeholders. `usdcUsdFeed` pode ser `address(0)` (fallback 1 USDC = 1 USD). Por isso a flag é separada de `DEPLOY_CLP_PHASE1`.

Em mainnet, **só ative os flags quando os placeholders de construtor do TeamVesting (endereço do beneficiário, datas de cliff/duration) forem substituídos por valores reais e auditados**. O default `ZeroAddress` para `teamVestingBeneficiary` faz o constructor reverter com `ZeroAddress` — isso é intencional, evita deploy silencioso com placeholder visualmente invisível. Em dev/testnet, passe o endereço do próprio deployer como placeholder via `ignition/parameters/*.json`.

### Revisão de `production.json`

Arquivo em `ignition/parameters/production.json`. Valores default:

- `timelockMinDelay: 172800` (2 dias)
- `probationDuration: 2592000` (30 dias)
- `roundDuration: 604800` (7 dias)
- `votingDelay: 7200` (blocos; ~1d assumindo 12s/block)
- `votingPeriod: 50400` (blocos; ~7d assumindo 12s/block)
- `proposalThreshold: 10000e18` GOV
- `quorumNumerator: 4` (4%)
- `sanityCap: 10_000_000e18` CREDIT
- `capMax: 5_000_000e18` CREDIT
- `alpha: 0.95e18` (limites on-chain: `[0.5e18, 0.99e18]` — ver C2 do parecer econômico)

Qualquer mudança deve estar documentada em changelog e revisada por 2 pessoas além de quem mudou.

> **Checklist L2 — ajustar `votingDelay` / `votingPeriod` conforme block time da chain alvo.** Os defaults assumem block time de **12s (Ethereum L1)**. Em L2s com block time muito menor, os prazos nominais colapsam:
>
> | Chain alvo | Block time | `votingDelay = 7200` equivale a | `votingPeriod = 50400` equivale a |
> |---|---|---|---|
> | Ethereum L1 | ~12s | ~1 dia | ~7 dias |
> | Arbitrum | ~0.25s | ~30 min | ~3.5h |
> | Optimism / Base | ~2s | ~4h | ~28h |
> | Polygon PoS | ~2s | ~4h | ~28h |
>
> **Antes de deployar em qualquer L2, recalcular `votingDelay` e `votingPeriod` em blocos para manter janelas ~1d / ~7d** (ou outras decididas pela DAO) e atualizar `production.json` correspondentemente. O mesmo vale para `timelockMinDelay` (que é em segundos, então não muda entre chains, mas merece revisão contra o tempo de coordenação humano da DAO naquela chain).

## F1 — Deploy

### Pré-voo

- [ ] Multi-sig tem ≥ 0.5 ETH para gas (~0.3 ETH realista + margem para retry).
- [ ] RPC provider principal + fallback configurados.
- [ ] `hardhat.config.ts` com mainnet RPC.
- [ ] Gas price monitorado; deploy ideal < 20 gwei.

### Comando

```bash
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet \
  --verify
```

Ignition é idempotente — se erro no meio, retoma do último passo confirmado. **Não apagar** `ignition/deployments/chain-1/` até ter certeza de que completou.

### Fases do módulo Ignition

O `Dao.ts` estrutura em 4 sub-fases:

- **A**: deploy de todos os contratos (deployer = admin temporário).
- **B**: role grants funcionais (MINTER → distributor, BURNER → tracker, RECORDER → feeRouter, PROPOSER/CANCELLER → governor) + genesis mint de 10M CREDIT para Treasury.
- **C**: roles de governança para o Timelock (`GOVERNANCE_ROLE` + `DEFAULT_ADMIN_ROLE` em todos os contratos econômicos) + `transferOwnership(timelock)` no GovernanceToken.
- **D**: deployer renuncia todas as suas roles. Timelock `DEFAULT_ADMIN_ROLE` renuncia **por último** — se renunciar antes, deployer perde poder de conceder o restante.

Genesis mint acontece **antes** da renúncia do `DEFAULT_ADMIN_ROLE` no CreditToken (`mintGenesis` é `onlyRole(DEFAULT_ADMIN_ROLE)`).

> **Novo argumento do CommunityGovernor**: o constructor do Governor ganhou o endereço do **Treasury** (3ª posição, após `token` e `timelock`) na Fase 1.2. O `Dao.ts` já passa `treasury` imutável — necessário para o scan de `propose` que aplica a supermaioria 75% a `Treasury.removePOL` e a gestão de roles do Treasury/Timelock (ver [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md)). Deploy scripts externos que instanciam o Governor por constructor devem propagar esse argumento.

### Wiring pós-deploy do CLP (só se as flags de Fase 1 forem usadas)

O `Dao.ts` deploya os contratos do CLP mas **não** os conecta. Estes atos são propostas de governança (via Timelock) após o bootstrap:

1. **`Treasury.setPriceOracle(creditPriceOracle)`** — habilita `recordDailyPrice` e `executeBuyback` (até então revertem com `BuybackInfraMissing`). Também `setSwapRouter` e `setChainlinkFeed`.
2. **`CreditToken.grantRole(MINTER_ROLE, rewardDistributorV2)`** — durante uma migração V1→V2, ambos os distributors podem deter a role transitoriamente.
3. **`LiquidityGauge.addPool(...)` + `grantRole(REWARD_NOTIFIER_ROLE, ...)`** e **`LiquidityGauge.setDenylist(treasury, true)`** (anti self-dealing D.9).
4. **`Treasury.setLiquidityGauge(gauge, poolId)`** — destino do fallback `flushPendingGaugeRewards`.

### Verificação pós-deploy — ANTES de qualquer outra ação

Cada item é um assert obrigatório via `cast` ou hardhat console:

- [ ] **10 contratos core verificados no Etherscan** (GovernanceToken, CreditToken, CommunityTimelock, ProjectRegistry, Treasury, Staking, BurnTracker, RewardDistributor, FeeRouter, CommunityGovernor). Se as flags do CLP forem usadas, verificar também LiquidityGauge, RewardDistributorV2 e/ou CreditPriceOracle.
- [ ] **Timelock tem `PROPOSER_ROLE` e `CANCELLER_ROLE`**:
  ```
  cast call $TIMELOCK 'hasRole(bytes32,address)(bool)' $(cast keccak "PROPOSER_ROLE") $GOVERNOR
  # → true
  cast call $TIMELOCK 'hasRole(bytes32,address)(bool)' $(cast keccak "CANCELLER_ROLE") $GOVERNOR
  # → true
  ```
- [ ] **Deployer NÃO tem `DEFAULT_ADMIN_ROLE`** em nenhum contrato com AccessControl:
  ```
  cast call $REGISTRY 'hasRole(bytes32,address)(bool)' 0x00...0 $DEPLOYER
  # → false (em todos)
  ```
- [ ] **Timelock TEM `DEFAULT_ADMIN_ROLE`** nos contratos econômicos.
- [ ] **`owner(GOV) == deployer`** (ainda — esperado para bootstrap).
- [ ] **`pendingOwner(GOV) == timelock`**.
- [ ] **`CREDIT.balanceOf(treasury) == 10_000_000e18`** e **`CREDIT.totalSupply() == 10_000_000e18`**.
- [ ] **`GOV.totalSupply() == 0`** — ninguém recebeu GOV ainda.
- [ ] **FeeRouter split = (7000, 2000, 1000)** — 70% burn / 20% treasury / 10% rebate (Fase 0 do CLP, assado em `production.json`). O `defaultSplit` vem dos parâmetros de deploy, não é hardcoded no contrato.

Se **qualquer** falhar: pare. Não avance para F2. Investigue.

## F2 — Bootstrap da governança (D+1 a D+12)

### Mint mínimo para passar threshold

Deployer (multi-sig) faz um único mint:

```solidity
gov.mint(
  multisigAddress,           // ou bootstrap address
  12_000e18,                  // um pouco acima do threshold de 10k
  "bootstrap"
);
```

**Não** mintar 100M. **Não** mintar os 30M de treasury ainda. Apenas o mínimo para permitir propor.

Em seguida, o multisig delega a si mesmo:

```solidity
gov.delegate(multisigAddress);
```

### Primeira proposta: `acceptOwnership()`

```solidity
targets    = [govTokenAddress]
values     = [0]
calldatas  = [gov.interface.encodeFunctionData("acceptOwnership")]
description = "Bootstrap 1: accept GOV ownership by Timelock"
```

Submeter via:

```solidity
governor.propose(targets, values, calldatas, description);
```

- Aguardar `votingDelay` (~1d).
- Votar For (multisig).
- Aguardar `votingPeriod` (~7d).
- `queue` + `execute` após 2d.

### Verificação pós-F2

- [ ] `gov.owner() == timelock`.
- [ ] `gov.pendingOwner() == address(0)`.
- [ ] Deployer multisig não tem mais poder soberano sobre o GOV. Qualquer mint futuro exige proposta.

## F3 — Distribuição (D+12 a D+90)

Propostas sequenciais para executar os buckets. Recomendação:

1. **30% Treasury permanente (30M)**: `gov.mint(treasury, 30_000_000e18, "treasury")`.
2. **25% Team via TeamVesting**: deploy N instâncias de `TeamVesting`, cada uma com beneficiário específico. Transferir GOV do Treasury para cada instância.
3. **20% Public sale**: `gov.mint(saleContract, 20_000_000e18, "publicSale")` após sale contract auditado e deployado.
4. **15% Community rewards**: `gov.mint(userSubsidy, 15_000_000e18, "community")` ou para contrato de liquidity mining futuro.
5. **10% Liquidity**: `gov.mint(liquidityManager, 10_000_000e18, "liquidity")` para um contrato que provisione LP em DEX.

Cada bucket é uma proposta separada — revisável independentemente.

### Verificação pós-F3

- [ ] `gov.totalSupply() == 100_000_000e18` (atinge cap).
- [ ] `gov.mint(anyone, 1, "try")` reverte com `CapExceeded`.
- [ ] Nenhum holder individual (exceto Treasury e vesting contracts) tem > 25% do voting power ativo.
- [ ] Public sale acontece e se conclui.
- [ ] Liquidity provisionada em DEX com range razoável.

## F4 — Handoff completo (D+90+)

Sinais de saúde:

- Participação em propostas sobe para >10% do supply.
- Multi-sig perde maioria do voto ativo (holders diversos entram).
- Burn rate orgânico emergente (apps começam a gerar tráfego).
- Stakers entrando em múltiplos projetos, não apenas um.

A DAO pode então:

- Aprovar novos apps via Registry.
- Executar buybacks (quando integração DEX estiver pronta).
- Ajustar `alpha`, `capMax` conforme métricas observadas.
- Contratar auditorias adicionais.

## Runbook de emergência

Se detectar ataque:

1. **Comunicar** imediatamente via canais oficiais (Discord, Twitter, fórum).
2. **Propor** ação corretiva via Governor com `description` explicando urgência.
3. Se proposta está em `Queued` e atacante ainda não executou: chamar `Governor.cancel` ou `Timelock.cancel` (via proposta contrária).
4. Se contratos privilegiados (tokens, routers) comprometidos: propor `grantRole` revogatório + deploy substituto + migração.
5. **Sem guardian unilateral no v1** — qualquer pause exige proposta. O delay é intencional.

## Pós-mainnet

- Monitoramento ativo por ≥ 30 dias.
- Bug bounty ativo permanentemente.
- Reavaliação de parâmetros após 3 meses de dados reais.
- Proposta para adicionar guardian multi-sig como `CANCELLER_ROLE` pode ser considerada após maturidade.

---

**Próximo →** [Modelo de segurança](03-security-model.md)
