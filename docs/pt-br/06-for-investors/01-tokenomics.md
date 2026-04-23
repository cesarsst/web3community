# Tokenomics

**Para quem é:** quem quer entender a distribuição, emissão e dinâmica de supply dos dois tokens.
**Pré-requisitos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

Esta página descreve a arquitetura econômica dos tokens. **Não é recomendação nem promessa de valorização.** Todos os parâmetros ajustáveis via governança podem mudar; faixas de parâmetro ajustável são codificadas on-chain.

## GOV — supply fixo

| Aspecto | Valor | Fonte |
|---|---|---|
| Supply cap | 100.000.000 GOV | `GovernanceToken.CAP_SUPPLY` (imutável) |
| Supply no deploy | 0 | construtor do `GovernanceToken` |
| Emissão | Exclusivamente via `mint(to, amount, tag)` pelo owner | `GovernanceToken.mint` |
| Owner em produção | `CommunityTimelock` | handoff via `transferOwnership` + `acceptOwnership` |

Cada GOV em circulação só pode existir se o Timelock (via proposta aprovada) chamou `mint`. O cap de 100M nunca pode ser excedido — a função reverte com `CapExceeded` se tentativa.

### Distribuição planejada

A distribuição não é feita no deploy. O genesis do GOV é 0. A DAO decide via propostas sequenciais. O repositório documenta a proposta inicial típica:

```
30%  Treasury permanente         (30M)   - fica no Treasury, sai via propostas futuras
25%  Team + early contributors    (25M)   - via TeamVesting contracts, cliff 12m + linear 36m
20%  Public sale / community      (20M)   - via sale contract (a definir em proposta)
15%  Community rewards            (15M)   - liquidity mining / airdrops via UserSubsidy
10%  Liquidity                    (10M)   - provisão de LP em DEX externa
----
100% (100M — atinge cap)
```

**Esses valores são intenção de proposta, não programação automática.** Cada alocação é uma proposta separada, votada individualmente. A DAO pode ajustar as proporções antes de executar cada bucket.

> **Contratos pendentes de design/deploy.** A distribuição acima descreve **intenção**, não estado atual do repositório. Os contratos `Sale` (venda pública dos 20%), `LiquidityBootstrappingPool` / `LiquidityManager` (provisão dos 10% em DEX) e `LPRewards` / liquidity-mining (para parte dos 15% community) **não existem no repo atual** e precisam ser desenhados, auditados e deployados antes das propostas correspondentes. O `TeamVesting` existe (1 instância por beneficiário) e o `UserSubsidy` existe (singleton para campanhas Merkle), mas também dependem de proposta para serem funded via transfer do Treasury. Até a proposta #2 de distribuição executar, **0 GOV está em circulação** — 100% do cap permanece mintável pelo Timelock. Sequência proposta de propostas bootstrap (após `acceptOwnership` pelo Timelock):
>
> 1. Mint 30M GOV para o Treasury.
> 2. Deploy `TeamVesting` × N + mint 25M GOV distribuído entre as instâncias via transfer do Treasury.
> 3. Deploy `Sale` + mint 20M GOV para o contrato de venda.
> 4. Fund `UserSubsidy` (CREDIT do Treasury) + mint 15M GOV para o bucket community (LP mining / airdrops).
> 5. Deploy `LiquidityManager` + mint 10M GOV + provisão da pool DEX inicial.
>
> Cada proposta é revisável independentemente. Ver `docs/pt-br/09-advanced/02-mainnet-deployment.md` para o procedimento operacional completo.

### TeamVesting

Cada membro do time recebe uma instância separada de `TeamVesting`. Parâmetros típicos:

- `start` = timestamp do TGE.
- `cliff` = 365 dias.
- `duration` = 4 × 365 dias (inclui cliff; 12m cliff + 36m linear).

Após cliff, libera `cliff/duration = 25%` de uma vez ("hockey stick") e depois linearmente até 100%. `release()` é pull — qualquer um pode chamar, mas tokens sempre vão para `beneficiary`.

Revogação: `owner` (Timelock, via proposta) pode revogar em qualquer ponto. Congela a fronteira em `totalAllocatedAtRevoke = vestedAmount(now)` e devolve o unvested ao `returnTo`.

### Não há yield em GOV per se

Ter GOV parado na wallet **não** paga reward. GOV só participa da economia via:

- Staking em projetos (gera peso + reward em CREDIT).
- Colateral de listagem de projeto (trava GOV sem gerar reward).
- Voto em propostas (gratuito).

## CREDIT — supply elástico

| Aspecto | Valor | Fonte |
|---|---|---|
| Supply cap hardcoded | **Não existe** | `CreditToken` não tem cap |
| Genesis | 10.000.000 CREDIT (one-shot) | `mintGenesis` com flag `genesisMinted` |
| Destinatário do genesis | `Treasury` | `ignition/modules/Dao.ts` |
| Mint subsequente | Apenas pelo `MINTER_ROLE` | `CreditToken.mint` |
| Minter em produção | `RewardDistributor` | grant do deploy |
| Burn | `burn`, `burnFrom` (ERC20Burnable), `burnByRole` (role-gated) | `CreditToken` herda `ERC20Burnable` |

### Fórmula de emissão

Em `RewardDistributor.finalizeRound`:

```
emissao_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Com parâmetros em produção:

- `alpha = 0.95` (ajustável entre `[0.5, 0.99]`). Faixa reduzida de `[0.5, 1.1]` para garantir IE1 (α < 1 permanente) por construção — a governança não pode mais votar valor inflacionário. Ver parecer `audit/economist/2026-04-22-consistency-audit.md` (C2) e `contracts/RewardDistributor.sol:117`.
- `capMax = 5.000.000 CREDIT` por rodada (ajustável entre `[1, 100M] CREDIT`).
- `floorSchedule`: imutável, 24 valores decrescentes:

```
floor[0]  = 400.000 CREDIT
floor[1]  = 383.333 CREDIT
floor[2]  = 366.666 CREDIT
...
floor[23] = 16.666 CREDIT
floor[24+] = 0 (sem entrada)
```

Decaimento linear de 400k a ~16.666 em 24 rodadas. Em produção (`roundDuration = 7 dias`), isso cobre **~168 dias ≈ 5.5 meses** de bootstrap.

### Dinâmica esperada de supply

Se o uso é constante (burn = constante), `alpha < 1` implica emissão < burn, e o supply cai gradualmente.

> **Nota sobre a simulação.** O repositório tem em `scripts/simulation/` uma simulação de 52 rodadas em 3 cenários. No cenário base, o supply cai **~3.8%** e o APR nominal do staker estabiliza em ~34% em CREDIT. Esses valores são **ilustrativos do comportamento qualitativo** (deflação sustentada com uso constante) em um cenário hipotético com supply inflado (70.4M CREDIT inicial, via `Charlie_seed = 60M` mintado por atalho de teste em `scripts/simulation/economicSim.ts:72`) e 1M burn/round. Em mainnet, o supply operacional **começa em 10M** (genesis real), e o burn orgânico precisa ser construído a partir de uso real dos apps — números absolutos não prometem comportamento de mainnet, apenas a dinâmica qualitativa.

Se o uso cresce, burn absoluto cresce, emissão absoluta cresce (até saturar em `capMax`). Nas primeiras 24 rodadas, o floor pode manter emissão mesmo se burn colapsa — depois, não.

Se o uso morre, burn ~ 0, `floor(R)` domina por 24 rodadas, depois zera.

## Subsídios — UserSubsidy

O contrato `UserSubsidy` distribui CREDIT pré-financiado para primeiros usuários dos apps via Merkle drops.

Parâmetros por campanha (propostos pela DAO):

- `merkleRoot` — raiz da árvore de usuários elegíveis.
- `amountPerUser` — CREDIT por claim.
- `maxClaims` — cap total de claims exercitáveis.
- `deadline` — até quando podem claim.

A DAO funda o contrato transferindo `maxClaims × amountPerUser` de CREDIT do Treasury antes de criar a campanha. Sobras após `closeCampaign` voltam ao `returnTo` (tipicamente Treasury).

## Floor decay — por que 24 rodadas

O floor existe para o **bootstrap** — garantir emissão positiva enquanto os apps ainda não geram burn orgânico. 24 rodadas × 7 dias = **~168 dias ≈ 5.5 meses**. Depois disso, o protocolo precisa andar com as próprias pernas.

Decaimento linear: `floor[R] = 400_000e18 - R * (400_000 / 24 * 1e18)`, arredondado. O total somado dá exatamente **5M CREDIT** (soma analítica: `24 * 400_000 - (400_000/24) * 276 = 9.6M - 4.6M = 5M`, conforme `ignition/modules/Dao.ts:86-94`) — bem abaixo do genesis (10M). Projetado para ser safety net, não orçamento fechado.

## Cap por rodada (capMax)

Teto duro da emissão total em qualquer rodada. Em produção, 5M CREDIT. Ajustável dentro de `[MIN_CAPMAX=1, MAX_CAPMAX=100M] CREDIT`.

Razão: mesmo se burn for absurdamente alto (ataque ou evento pontual), a emissão fica clampada. Isso preserva a previsibilidade do supply máximo.

## Sanity cap por (rodada, projeto)

Limite paralelo, mais local, imposto pelo `BurnTracker`:

- Default em produção: `10.000.000 CREDIT` por projeto por rodada.
- Se `accumulated + amount > sanityCap`, `burnAndRecord` reverte com `SanityCapExceeded`.
- Governança pode setar para 0 (desabilitar) ou ajustar via proposta.

Razão: impedir que um projeto malicioso queime volume absurdo para capturar share desproporcional.

## Probation penalty (25%)

Projetos em probation inicial (por tempo) recebem `projectShare / 4` na emissão. Os outros 75% **nunca são mintados** — não são redistribuídos, `CREDIT.mint` não é chamado para esse valor e `CreditToken.totalSupply()` não é afetado (não é `_burn`, é simplesmente divisão de share antes do mint). Preserva a intenção deflacionária por subtração de emissão, não por incineração.

Em produção, probation inicial dura 30 dias. Durante esse período, stakers em projetos novos capturam 25% do que seria cheio.

## Resumo de parâmetros ajustáveis via governança

| Parâmetro | Contrato | Faixa permitida | Valor em produção |
|---|---|---|---|
| `alpha` | RewardDistributor | `[0.5e18, 0.99e18]` | `0.95e18` |
| `capMax` | RewardDistributor | `[1e18, 100M * 1e18]` | `5M * 1e18` |
| `roundDuration` | BurnTracker | `[1 day, 30 days]` | `7 days` |
| `maxBurnPerRoundPerProject` | BurnTracker | `[0, ilimitado]` (0 = desabilita) | `10M * 1e18` |
| `minCollateral` | ProjectRegistry | `> 0` | `10.000 GOV` |
| `probationDuration` | ProjectRegistry | `> 0` | `30 days` |
| `defaultSplit` | FeeRouter | soma = 10.000 bps | `(9500, 0, 500)` |
| `votingDelay` | Governor | `> 0` blocos | `7200` (~1d) |
| `votingPeriod` | Governor | `> 0` blocos | `50400` (~7d) |
| `proposalThreshold` | Governor | `>= 0` GOV | `10.000 GOV` |
| `quorumNumerator` | Governor | `[0, 100]` | `4` |
| `timelockMinDelay` | Timelock | `>= 0` seg | `172800` (2d) |

Parâmetros **não ajustáveis**:

- Cap do GOV (`CAP_SUPPLY = 100M`, imutável).
- `MIN_LOCK = 14 days`, `MAX_LOCK = 365 days`, `MAX_MULTIPLIER = 4x` no Staking.
- `MIN_ROUND_DURATION`, `MAX_ROUND_DURATION` no BurnTracker (bounds).
- `MIN_ALPHA`, `MAX_ALPHA`, `MIN_CAPMAX`, `MAX_CAPMAX`, `FLOOR_SCHEDULE_LENGTH`, `PROBATION_PENALTY_DENOM` no RewardDistributor.
- `floorSchedule` (gravado no constructor).
- Endereço de qualquer contrato (sem upgrade path).

---

**Próximo →** [Value accrual](02-value-accrual.md)
