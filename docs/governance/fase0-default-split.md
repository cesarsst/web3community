# Fase 0 do pivot CLP — `setDefaultSplit(7000, 2000, 1000)`

Documento operacional da **primeira proposta DAO** do pivot Credit Liquidity
Protocol. A Fase 0 consiste em UMA acao on-chain — atualizar o split default
do `FeeRouter` de 95/0/5 para 70/20/10 — e e o **hard gate** para iniciar
qualquer trabalho de Fase 1 (LPs/staking refinado).

## 1. Contexto

Os pareceres economicos relevantes:

- [`audit/economist/2026-04-24-clp-pivot.md`](../../audit/economist/2026-04-24-clp-pivot.md)
  — pivot CLP em 2 fases com hard gate. Ponto C4 (Treasury sem receita
  recorrente) bloqueia qualquer flywheel da Fase 1. A solucao acordada e
  redirecionar parte do CREDIT consumido nos apps (atualmente 100% queimado +
  rebate) para o cofre da DAO. Bullet 5 alternativa B do parecer:
  `setDefaultSplit(7000, 2000, 1000)`.
- [`audit/economist/2026-04-24-credit-peg.md`](../../audit/economist/2026-04-24-credit-peg.md)
  — modelo de peg adotado: **FFP (Floating com Floor Price defendido)**. O
  Treasury alimentado pelo split de 20% e a fonte de capital para o
  buyback-and-burn defensivo do floor.

Decisao do user (2026-04-24):

> Pivot em 2 fases com hard gate; split default `(7000, 2000, 1000)`;
> CREDIT como FFP.

## 2. O que a proposta faz

Acao unica e atomica:

```text
target  = FeeRouter
value   = 0
calldata = setDefaultSplit({burnBps: 7000, treasuryBps: 2000, rebateBps: 1000})
```

Efeito on-chain:

| Campo         | Antes (95/0/5) | Depois (70/20/10) | Delta            |
| ------------- | -------------: | ----------------: | ---------------- |
| `burnBps`     |           9500 |              7000 | -2500 bps (-25%) |
| `treasuryBps` |              0 |              2000 | +2000 bps (+20%) |
| `rebateBps`   |            500 |              1000 | +500 bps (+5%)   |
| **Total**     |     **10_000** |        **10_000** | **invariante**   |

Invariantes economicas tocadas:

- **I2 (burn no consumo)**: mantida — `burnBps = 7000 > 0`.
- **I4 (governanca via Timelock)**: exercitada — `setDefaultSplit` e
  `onlyRole(GOVERNANCE_ROLE)`, que em producao e detida exclusivamente pelo
  `CommunityTimelock`.
- **Overrides por projeto** (`projectSplit`/`hasProjectSplit`): NAO sao
  afetados. Projetos com `setProjectSplit(...)` ja aplicado continuam
  usando seus overrides.

## 3. Texto sugerido para `description` (proposal description)

O hash desta string e parte do `proposalId` — qualquer byte alterado produz
proposta diferente. **Use exatamente este texto** ao submeter a proposta
on-chain (o script ja faz isso por default):

```markdown
# Fase 0 do pivot CLP — atualizar split default do FeeRouter para 70/20/10

Acao unica:
FeeRouter.setDefaultSplit({burnBps: 7000, treasuryBps: 2000, rebateBps: 1000})

Motivacao economica (resolve C4 do parecer original):

- 70% burn: mantem deflacao do CREDIT e o vinculo I2 (burn-no-consumo).
- 20% treasury: cria receita recorrente da DAO; destrava o flywheel da Fase 1
  (Treasury passa a acumular CREDIT proporcional ao uso real).
- 10% rebate: dobra o revenue share dos apps listados, alinhado a estrategia
  de incentivar listagens uteis na Fase 1.

Pareceres de referencia:

- audit/economist/2026-04-24-clp-pivot.md (Fase 0 hard gate, bullet 5 alt. B)
- audit/economist/2026-04-24-credit-peg.md (modelo FFP — Floating com Floor
  Price defendido; receita do treasury alimenta o buyback-and-burn defensivo)

Invariantes:

- I2 mantida: burnBps = 7000 > 0.
- I4 exercitada: a propria proposta passa pelo Timelock (GOVERNANCE_ROLE).
- Overrides por projeto (setProjectSplit) nao sao afetados.
```

## 4. Tempos esperados (por rede)

Lidos diretamente dos parametros do Ignition em
[`ignition/parameters/`](../../ignition/parameters):

| Parametro                    | Dev (`dev.json`) | Producao (`production.json`) |
| ---------------------------- | ---------------: | ---------------------------: |
| `votingDelay` (blocos)       |                1 |       7200 (~1 dia @ 12s/bl) |
| `votingPeriod` (blocos)      |               50 |     50400 (~7 dias @ 12s/bl) |
| `proposalThreshold` (GOV)    |   10_000 \* 1e18 |               10_000 \* 1e18 |
| `quorumNumerator` (% supply) |               4% |                           4% |
| `timelockMinDelay` (s)       |       3600 (1 h) |                 172800 (2 d) |

Ciclo total minimo (caso quorum atingido com voto unanime FOR):

- **Dev**: ~1h05 (50 blocos de voting period @ ~12s + 1h timelock). Em
  ambiente Hardhat com `time.increase`, o ciclo e instantaneo.
- **Producao**: **~10 dias** (1d delay + 7d voting + 2d timelock).

## 5. Sequencia operacional

### 5.1. Proposer

```bash
# (1) Auditoria local SEM submeter — imprime calldata + proposalId computado.
DRY_RUN=true npx hardhat run scripts/governance/propose-fase0-default-split.ts --network <rede>

# (2) Submete a proposta. Requer >= 10_000 GOV delegado.
npx hardhat run scripts/governance/propose-fase0-default-split.ts --network <rede>
```

Saida esperada: `proposalId`, `descriptionHash`, lista de `targets/values/calldatas`.
**Salve esses valores** — `descriptionHash` e necessario nas chamadas
`queue()` e `execute()`.

### 5.2. Voters

Apos `votingDelay` (estado da proposta = `Active`):

```javascript
governor.castVote(proposalId, 1); // 1 = FOR; 0 = AGAINST; 2 = ABSTAIN
```

Quorum = 4% do supply do `GovernanceToken`. Em producao, com cap 100M e
`genesisAmount = 10M`, sao **400_000 GOV em voto FOR** para atingir quorum
(considerando supply atual).

### 5.3. Queue + execute

Apos o periodo de votacao (estado = `Succeeded`):

```bash
npx hardhat run scripts/governance/execute-fase0-default-split.ts --network <rede>
```

O script identifica o estado e executa a transicao apropriada:

- `Succeeded` → chama `queue(...)`. Re-rode apos o `timelockMinDelay`.
- `Queued` (apos timelock) → chama `execute(...)` e verifica
  `defaultSplit()` on-chain.
- `Executed` → noop (idempotente; valida que o split bate).

## 6. Checklist pos-execucao

- [ ] `governor.state(proposalId) == 7` (Executed).
- [ ] Evento `DefaultSplitUpdated` emitido pelo `FeeRouter` no bloco do execute.
  - `oldSplit = (9500, 0, 500)`
  - `newSplit = (7000, 2000, 1000)`
- [ ] `feeRouter.defaultSplit()` retorna `(7000, 2000, 1000)`.
- [ ] Sanity: chamar `feeRouter.quote(<projectId>, 1e18)` em um projeto sem
      override retorna `(burned=0.7e18, toTreasury=0.2e18, toApp=0.1e18)`.
- [ ] Atualizar `CHANGELOG.md` movendo a entrada de Fase 0 de `[Unreleased]`
      para a nova versao publicada (ver formato Keep a Changelog).
- [ ] Comunicado off-chain: anunciar a execucao no Discord + forum citando
      o tx hash do execute.
- [ ] Alertar economist: rodar a simulacao
      (`npx hardhat run scripts/simulation/economicSim.ts`) com o split novo
      para confirmar que o flywheel de Fase 1 esta pronto.

## 7. Caminhos sad

| Estado da proposta                                        | O que aconteceu                                                                   | Acao                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Defeated` (3)                                            | Voting period acabou sem quorum, ou voto AGAINST > FOR.                           | Recriar com `propose-fase0-default-split.ts`. Ajustar comunicacao off-chain antes do retry.     |
| `Canceled` (2)                                            | Proposer cancelou em `Pending`/`Active`.                                          | Recriar quando o proposer estiver pronto.                                                       |
| `Expired` (6)                                             | Foi `Queued`, mas ninguem chamou `execute()` antes de `GRACE_PERIOD` do Timelock. | Recriar do zero.                                                                                |
| `Succeeded` parado                                        | Voto venceu mas ninguem chamou `queue()`.                                         | Rodar `execute-fase0-default-split.ts` — ele detecta e enfileira.                               |
| `Queued`, ETA nao maturou                                 | Timelock ainda no delay.                                                          | Aguardar e re-rodar `execute-fase0-default-split.ts`.                                           |
| Reverte com `AccessControlUnauthorizedAccount` no execute | `GOVERNANCE_ROLE` do FeeRouter nao esta com o Timelock.                           | Bootstrap de roles incompleto — verificar `scripts/deploy-dev.ts` ou proposta de transferencia. |

## 8. Referencias

- Contrato: [`contracts/FeeRouter.sol`](../../contracts/FeeRouter.sol) (`setDefaultSplit`).
- Contrato: [`contracts/CommunityGovernor.sol`](../../contracts/CommunityGovernor.sol).
- Contrato: [`contracts/CommunityTimelock.sol`](../../contracts/CommunityTimelock.sol).
- Script: [`scripts/governance/propose-fase0-default-split.ts`](../../scripts/governance/propose-fase0-default-split.ts).
- Script: [`scripts/governance/execute-fase0-default-split.ts`](../../scripts/governance/execute-fase0-default-split.ts).
- Teste: [`test/governance/Fase0DefaultSplit.test.ts`](../../test/governance/Fase0DefaultSplit.test.ts).
- Pattern de propostas: [`scripts/proposals/README.md`](../../scripts/proposals/README.md).
