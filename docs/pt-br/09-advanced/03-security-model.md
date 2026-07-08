# Modelo de segurança

> ⚠️ **Nota de legado (remodel 2026-07-08)**: invariantes e superfícies ligadas ao trilho econômico antigo (I2 burn no consumo, emissão α·burn, wash-burn, sanity caps do BurnTracker) descrevem o modelo **pré-remodel** — os contratos seguem deployados, mas o trilho vigente é PSM + FeeRouterV2 + ProjectFunding, com invariantes próprias (I-PSM1 lastro integral, teto duro de fee 500 bps, conservação `toApp + fee + revShare == amount`, all-or-nothing do funding) descritas em [CreditPSM](../08-contracts-reference/15-CreditPSM.md), [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) e [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). As invariantes de governança/roles (I1, I4, I7 etc.) continuam vigentes.

**Para quem é:** auditores, segurança ofensiva, pesquisadores.
**Pré-requisitos:** conhecimento geral da arquitetura.

Este documento consolida invariantes, superfícies de ataque identificadas e mitigações implementadas nos 15 contratos de produção.

## Invariantes globais

### I1 — Cap do GOV

**Afirmação**: `GovernanceToken.totalSupply() <= CAP_SUPPLY = 100_000_000 * 1e18` em todo momento.

**Onde é protegida**: `GovernanceToken._update`. Para mint (from == 0), verifica `totalSupply + value <= CAP_SUPPLY`, senão reverte `CapExceeded`.

**Relacionada**: `_maxSupply()` sobrescrito para retornar CAP_SUPPLY, garantindo que checks internos de ERC20Votes (uint208) também respeitem.

### I2 — Burn no consumo

**Afirmação**: todo CREDIT consumido em pagamentos é queimado via `_burn` nativo, decrementando `totalSupply`. Nenhum caminho de `FeeRouter.pay` com `burnBps > 0` desvia para dead-address, treasury ou remint.

**Onde é protegida**:

- `FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole`.
- `CreditToken.burnByRole` usa `_burn` nativo do ERC-20.

**Validação**: teste integrado valida decremento exato em `totalSupply` para cada `burned`.

### I3 — Cap por rodada

**Afirmação**: emissão de CREDIT por rodada nunca excede `capMax`. Burn por projeto por rodada nunca excede `maxBurnPerRoundPerProject` (se > 0).

**Onde é protegida**:

- `RewardDistributor.finalizeRound`: `totalEmission = min(rawEmission, capMax)`.
- `BurnTracker.burnAndRecord`: reverte `SanityCapExceeded` se acumulado + amount > cap.

### I4 — Governance-only exit

**Afirmação**: toda função state-changing que move fundos (Treasury, Staking, etc.) ou muda parâmetros econômicos exige `GOVERNANCE_ROLE` (ou Ownable2Step no GOV). Nenhuma EOA retém poder unilateral pós-handoff.

**Onde é protegida**:

- Setters nos contratos econômicos têm `onlyRole(GOVERNANCE_ROLE)`.
- `GovernanceToken.mint` é `onlyOwner` (Ownable2Step).
- `TeamVesting.revoke` é `onlyOwner`.
- `DEFAULT_ADMIN_ROLE` foi transferido ao Timelock no deploy.

### I5 — Anti-flashloan no voto

**Afirmação**: flash-loan de GOV no bloco da votação não confere voting power. Flash-stake no bloco de `finalizeRound` não entra no cálculo de share.

**Onde é protegida**:

- `Governor.castVote` lê `GovernanceToken.getPastVotes(account, proposalSnapshot)`.
- `RewardDistributor._calculateClaim` lê `Staking.getWeightAt(user, projectId, snapshotBlock)`.
- `snapshotBlock` é gravado em bloco anterior ao consultado.

### I6 — Lock mínimo

**Afirmação**: stake com lock abaixo de 14 dias reverte. Unstake antes do lock em projeto não-Removed reverte.

**Onde é protegida**:

- `Staking.stake` / `increaseStake` (indiretamente) reverte com `LockTooShort`.
- `Staking.unstake` reverte com `LockNotExpired` se `block.timestamp < unlockAt` e projeto não-Removed.

### I7 — Projetos via governança

**Afirmação**: nenhum projeto entra em `Active` sem passar por `GOVERNANCE_ROLE` (Timelock). Operações dependentes de projeto (`FeeRouter.pay`, `BurnTracker.burnAndRecord`, `Staking.stake`) verificam `isActive` antes.

**Onde é protegida**:

- `ProjectRegistry.registerProject` e `activateProject` são `onlyRole(GOVERNANCE_ROLE)`.
- Callers verificam `isActive` e revertem com `ProjectNotActive`.

### I8 — Segregação on-chain de saldos reservados (CLP Fase 1.4)

**Afirmação**: CREDIT que lastreia obrigações internas não pode ser drenado por saídas genéricas.

- **Treasury**: `polRefillBucket + pendingGaugeRewards <= balanceOf(CREDIT)` — enforced nos dois lados. Saídas (`transfer`/`batchTransfer`/`payRebates`/`addPOL`) revertem com `TransferExceedsUnreservedCredit`; depósitos revertem com `DepositExceedsCreditBalance`. Os ledgers só são consumidos por caminhos dedicados (`addPOLFromRefill`, `flushPendingGaugeRewards`) e válvulas `writeDown*`.
- **LiquidityGauge**: `totalVestingLocked` (CREDIT de `VestingPosition`s não sacadas) é intocável por `governanceRescueRewards` — o rescue só alcança `getUnreservedBalance()` (`RescueExceedsUnreserved`).

Antes esses saldos eram "norma contábil" off-chain; agora são invariantes enforced.

### I9 — Supermaioria 75% para remoção de POL (CLP Fase 1.2)

**Afirmação**: propostas contendo `Treasury.removePOL` — ou gestão de roles no Treasury/Timelock que re-autorizariam quem pode chamá-lo — exigem `forVotes >= 3 * againstVotes` E `forVotes > 0` (75% dos votos decisivos For/Against).

**Onde é protegida**:

- `CommunityGovernor.propose` escaneia `targets`/`calldatas` e marca `ProposalType.Supermajority` para os selectors `removePOL` (target Treasury) e `grantRole`/`revokeRole`/`renounceRole` (target Treasury **ou** Timelock).
- `CommunityGovernor._voteSucceeded` aplica a razão 3:1. Batch misto contamina a proposta inteira. A "norma cultural" virou código.

## Superfícies de ataque e mitigações

### Reentrancy

**Vetor**: ERC-20 custom com callbacks (ERC-777 legacy, tokens maliciosos) podendo reentrar em `transfer` / `approve`.

**Mitigação**: `ReentrancyGuard` em todas as funções que movem valor. Além disso, CEI estrito — effects antes de interactions.

**Contratos com guard**:

- `Treasury.transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH`, `recordDailyPrice`, `addPOL`, `removePOL`, `collectPOLFees`, `addPOLFromRefill`, `depositPolRefill`, `depositPendingGaugeRewards`, `flushPendingGaugeRewards`, `writeDownPolRefillBucket`, `writeDownPendingGaugeRewards`.
- `Staking.stake`, `increaseStake`, `extendLock`, `unstake`, `unstakeAll`.
- `BurnTracker.burnAndRecord`.
- `RewardDistributor.claim`, `claimMany`.
- `FeeRouter.pay`.
- `UserSubsidy.claim`, `closeCampaign`.
- `LiquidityGauge.stake`, `unstake`, `emergencyUnstake`, `harvest`, `notifyRewardAmount`, `endIncentive`, `governanceRescueRewards`.
- `CreditPriceOracle` — sem guard: é `view`, sem escrita de estado.

### Integer overflow / underflow

**Vetor**: precisões de ponto flutuante em cálculos de weight, share, emission.

**Mitigação**:

- Solidity 0.8.24 — checked arithmetic por default.
- `SafeCast` explícito em conversões que podem perder bits.
- Ordem das operações: multiplicar antes de dividir (preservar precisão).
- Bounds analíticos documentados nos contratos (ex: peso máximo em `Staking` cabe em uint208 com folga).

### Denial of Service via loops

**Vetor**: funções com loop sobre arrays controlados pelo caller.

**Mitigação**:

- `Treasury.batchTransfer` / `payRebates`: arrays externos, mas emissor é governança (Timelock) — sem ataque prático.
- `RewardDistributor.claimMany`: arrays externos, mas caller paga o gas.
- Nenhuma iteração sobre "todos os projetos" ou "todos os stakers" em caminho on-chain.

### Front-running

**Vetor**: atacante observa mempool, submete tx com gas maior para capturar valor.

**Mitigação**:

- Governance com `votingDelay` de ~1d — front-running direto de voto não funciona (voto via snapshot passado).
- `finalizeRound` é permissionless mas idempotente — front-run não traz vantagem (qualquer um pode finalizar, resultado é o mesmo).
- `FeeRouter.pay` não é atacável via FR — `user` e `amount` são fixos, split é determinístico.

### Ataques de sanity cap / cap econômico

**Vetor**: projeto malicioso inflaciona burn para capturar share.

**Mitigação**:

- Sanity cap por `(rodada, projeto)` — `SanityCapExceeded` se exceder.
- `capMax` global na emissão — clampa mesmo com burn absurdo.
- Probation penalty de 25% em projetos novos (primeiros 30 dias).

### Ataques via colateral reutilizável

**Vetor**: owner de projeto tenta reutilizar o colateral para múltiplas listagens.

**Mitigação**: cada `registerProject` exige colateral separado pullado via `transferFrom`. Saldos são custodiados por projeto no Registry.

### Ataques via transferência de ownership

**Vetor**: transferência acidental ou maliciosa de ownership (GOV, projeto, vesting).

**Mitigação**: `Ownable2Step` em GovernanceToken e TeamVesting; 2-step próprio em ProjectRegistry.transferProjectOwnership. `newOwner` precisa aceitar explicitamente.

### Ataques via recuperação de tokens perdidos

**Vetor**: tokens enviados para contratos errados (ex: ERC-20 para `Staking` em vez de `stake`).

**Mitigação**: **nenhuma no v1**. Decisão consciente — adicionar `rescueTokens` criaria backdoor governance-accessível. Tokens perdidos ficam perdidos (e o custo educa usuários). Em caso de perda significativa, a DAO pode votar migração.

### Ataques via upgrade

**Vetor**: contrato upgradável com proxy pode ser trocado maliciosamente.

**Mitigação**: **contratos não são upgradáveis**. Nenhum proxy. Qualquer substituição exige deploy novo + proposta para migrar roles/ownership.

### Ataques via time / timestamp

**Vetor**: miners/sequencers manipulam `block.timestamp`.

**Mitigação**:

- Lock, probation e vesting dependem de timestamps — manipulação em ±15s é irrelevante para janelas de dias/semanas.
- Governance usa `block.number` (clock), não timestamp — mais resistente.

### Ataques via signature replay

**Vetor**: assinaturas EIP-712 reexecutadas em outro contrato / chain.

**Mitigação**:

- Domain separator inclui `chainId` via OZ `EIP712` base.
- `nonces` em `ERC20Permit` e `ERC20Votes` invalidam reuso.
- Governor `castVoteBySig` usa nonce próprio.

## Threat model

### Atacante externo sem GOV

- Não pode propor (threshold = 10k GOV delegado).
- Pode chamar `FeeRouter.pay` (se tiver CREDIT e approve) — comportamento esperado.
- Pode chamar `finalizeRound` — comportamento esperado.
- Pode chamar `claim` — só recebe se tem peso em `(user, projectId)` no snapshot.
- Pode enviar ETH ao Treasury — doação.

**Ataque prático**: nenhum direto.

### Atacante com GOV mas abaixo do threshold

- Pode votar em propostas (se delegou).
- Pode stakar em projetos.
- Pode `delegate` para outrem.

**Ataque prático**: coordenação com outros holders — comportamento de governança normal.

### Atacante com GOV acima do threshold (~10k)

- Pode propor mudanças de parâmetro dentro dos bounds.
- Pode propor registro de projetos (se tiver colateral aprovado).
- Proposta ainda precisa de quorum (4% do supply) + For > Against.

**Ataque prático**: spam de propostas — custa gas da submissão + pressão social/política.

### Atacante com > 4% do supply

- Pode atingir quorum sozinho se 100% do resto votar contra ou se omitir.
- Ainda precisa de For > Against — outros holders podem bloquear.

**Mitigação**: distribuição ampla do GOV no bootstrap (nenhum single holder > 25%).

### Atacante com > 50% do supply (governance capture)

- Pode aprovar qualquer proposta dentro dos bounds on-chain.
- **Não pode** quebrar invariantes imutáveis (cap, MIN_LOCK, bounds de parâmetros).
- **Não pode** drenar fundos de stakers com lock vigente.

**Mitigação residual**: delay do Timelock dá 2 dias para holders não-atacantes responderem (saírem de posição, coordenarem proposta contrária, gritarem publicamente).

## Auditoria estática

Slither 0.11.5 rodado em todos os contratos. Resultados salvos em `audit/slither/`:

- `<Contract>.txt` — versão completa (inclui warnings em libs OZ).
- `<Contract>-projectonly.txt` — filtrado apenas para código do projeto.

Status no momento deste doc: **zero findings high/medium** no código do projeto. Findings low/informational documentados e aceitos.

## Suite de testes

- Total: **858 testes passing, 0 failing** (`npm test`, ~60s). Inclui as suítes do CLP Fase 1 (`CreditPriceOracle`, `CommunityGovernor.supermajority`, `Treasury.segregation`, `Treasury.polRefill`, `LiquidityGauge`).
- Testes integrados end-to-end em `test/ignition/Dao.test.ts`.
- Simulação econômica em `scripts/simulation/` — 52 rodadas × 3 cenários (base, crescimento, death spiral).

## Runbook de incidente

Se descoberto bug pós-mainnet:

1. **Severidade crítica (fundos em risco)**:
   - Informar signatários multi-sig.
   - Preparar proposta de emergência (mesmo que delays sejam dolorosos — não há botão de pause).
   - Comunicar publicamente via canais oficiais.
   - Se contratos dependentes permitem mitigação (ex: revogar role de contrato comprometido), proposta rápida.
   - Bug bounty critical pagável pós-confirmação.

2. **Severidade média**:
   - Proposta via governança regular (~10 dias).
   - Documentação pública + changelog.

3. **Severidade baixa**:
   - Tracking issue no repo.
   - Fix em próximo deploy (se houver) ou documentado como aceito.

---

Ver [Riscos e segurança (visão investidor)](../06-for-investors/03-risk-and-security.md) para abordagem menos técnica dos mesmos tópicos.
