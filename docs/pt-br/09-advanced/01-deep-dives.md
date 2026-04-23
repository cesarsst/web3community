# Deep dives

**Para quem é:** auditores e devs que precisam entender decisões arquiteturais específicas em profundidade.
**Pré-requisitos:** leitura das seções 01–08.

Esta página agrega decisões de design não-óbvias que atravessam múltiplos contratos.

## Anti-flashloan em duas dimensões

Duas dimensões do protocolo são protegidas contra manipulação por empréstimo relâmpago:

### 1. Voto

`GovernanceToken` herda `ERC20Votes`. Voting power é lida via `getPastVotes(account, snapshotBlock)`. Quando uma proposta é criada, o Governor grava `snapshotBlock = block.number + votingDelay`. Toda chamada `castVote` consulta `getPastVotes` **naquele** bloco.

Flash-loan pega e devolve no mesmo bloco. Logo: a posição do atacante no bloco do snapshot é zero (ou anterior ao empréstimo).

### 2. Peso de stake

`RewardDistributor._calculateClaim` usa `Staking.getWeightAt(user, projectId, snapshotBlock)`, onde `snapshotBlock = roundData[round].snapshotBlock` (gravado em `finalizeRound`).

Flash-stake no bloco da finalize não entra — o peso é lido **depois** do push no `Checkpoints.Trace208`. Atacante teria que manter posição por pelo menos um bloco antes, o que um flash-loan não permite.

Detalhes implementação: `Checkpoints.Trace208` usa `uint48` para `block.number` (cabe em ~8920 anos a 1s/bloco) e `uint208` para valor (peso máximo teórico 100M×4=4e26, muito abaixo de 2^208).

## Burn atômico com `BURNER_ROLE`

### Alternativas consideradas

**(a) Event listener off-chain**: apps queimam CREDIT direto e indexer ouve `Transfer(to=0)` para imputar burn a projeto.

Rejeitada porque:
- Depende de indexer confiável.
- Não há prova criptográfica on-chain de "qual projeto consumiu".
- Janela entre burn e record cria race conditions.

**(b) App registra burn sem queimar**: confia no app.

Rejeitada porque: double-spend trivial (app registraria burn sem consumir CREDIT, inflando rewards sem deflação).

**(c) Atomic on-chain via `BURNER_ROLE`**: app → `BurnTracker.burnAndRecord` → `CREDIT.burnByRole` sem allowance. **Adotada.**

### Por que sem allowance

Exigir allowance quebraria UX:

1. Usuário `approve(burnTracker, amount)` — tx 1.
2. App chama `burnAndRecord(projectId, from, amount)` — tx 2.

Duas txs. Janela de front-run entre approve e burn. Usuário assinaria duas coisas em sequência.

Com `burnByRole`:

1. Usuário `approve(feeRouter, amount)` + `feeRouter.pay(projectId, user, amount)` — 2 txs mas o primeiro é uma única allowance reutilizável.
2. `FeeRouter.pay` internamente aciona `BurnTracker.burnAndRecord`, que chama `CREDIT.burnByRole` sem exigir outra allowance.

Mitigação do risco: `BURNER_ROLE` só é concedida via proposta aprovada no Governor + Timelock. Revocável a qualquer momento.

## Probation duplo

Duas noções distintas coexistem no `ProjectRegistry`:

| Dimensão | Probation inicial por tempo | Probation punitiva |
|---|---|---|
| Onde mora | `isInProbation(projectId)` view | `Project.status == Probation` |
| Quando aplica | Automático pós-ativação por `probationDuration` | Governança move manualmente |
| `isActive(projectId)` retorna | `true` (projeto está Active) | `false` |
| `isInProbation(projectId)` retorna | `true` | `false` (é estritamente "Active dentro da janela") |
| Aceita stake novo? | sim | não |
| Aceita pagamento? | sim | não |
| Aceita burn? | sim | não |
| Bypass lock em unstake? | não | não (só `Removed` bypassa) |
| Share de reward | 25% (penalty /4) | zero (porque `isActive = false` → share = 0) |

A penalty de 25% é aplicada no RewardDistributor usando `REGISTRY.isInProbation(projectId)` no momento do claim. Não se aplica à punitiva (que já é bloqueada por `isActive = false` em stake/pay).

## Split 95/0/5 — por que 0 de treasury

Decisão de design: default **não** captura fatia para o Treasury. Razões:

- **Preservar incentivo ao burn.** Cada centavo direcionado ao Treasury é um centavo a menos queimado. O modelo deflacionário depende do burn máximo possível.
- **Treasury tem outras fontes.** Genesis mint (10M CREDIT), slash de projetos removidos, buyback futuro, fatia explícita em projetos específicos via `setProjectSplit`.
- **Evitar dupla captura.** Se o default já desse 5% ao Treasury, propostas de override teriam que "zerar" para dar algo ao app — UX pior que o inverso.

Se no futuro a DAO quiser capturar direto, basta `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})`. Não exige mudança de contrato.

## Dust handling no split

```
burned     = amount * burnBps / 10_000
toTreasury = amount * treasuryBps / 10_000
toApp      = amount - burned - toTreasury   <- captura residuo
```

Residuo de arredondamento vai para `toApp`. Em splits com divisão não-exata, o app pode receber 1-2 wei a mais que o calculado nominal. Aceitável e auditável via evento `Paid`.

Alternativas:

- **Arredondar cada parcela separadamente**: perde wei. Soma final pode ser `amount - 3 wei`.
- **Exigir que split seja divisor exato de `amount`**: inviável em geral.

A escolha atual preserva `burned + toTreasury + toApp == amount` sempre.

## Floor decay — 24 entradas imutáveis

`floorSchedule` é `uint256[24] memory` no constructor do `RewardDistributor`. Tamanho fixo:

- **Força o caller a passar 24 valores** (array dinâmico exigiria check adicional).
- **Imutável pós-deploy**: nenhuma função de write expõe mudança.

Em produção, decaimento linear:

```
floor[R] = 400_000e18 - R * (400_000/24 * 1e18)
```

Ajustado para valores com 1e18 precisão:

- `floor[0]  = 400_000.000000000000000000`
- `floor[1]  = 383_333.333333333333333334`  (+ dust arredondamento)
- ...
- `floor[23] = 16_666.666666666666666682`

A soma é ~5.2M CREDIT — bem abaixo do genesis de 10M. Não é orçamento fechado, é safety net.

## CEI + ReentrancyGuard — padrão duplo

Todos os contratos que movem valor seguem:

1. **CEI** — Checks, Effects, Interactions. Effects antes de `safeTransfer` / `safeTransferFrom`.
2. **`ReentrancyGuard`** em todas as funções state-changing que movem tokens.

O guard é defesa em profundidade:

- Se o token é ERC-20 conhecido (GOV, CREDIT), CEI sozinho seria suficiente (sem callbacks).
- Se o token é arbitrário (Treasury recebe qualquer ERC-20), pode ter hooks (ERC-777 legacy, ou tokens maliciosos customizados). O guard blinda.
- Mesmo com tokens "seguros", o guard evita regressões futuras que introduzam callbacks.

Custo: ~2k gas por chamada no caminho feliz. Aceitável em operações que custam 100k+.

## Checkpoints globais no Staking

O `Staking` mantém **três** trilhos paralelos de peso:

```
_userWeight[user][projectId]   — por usuario-projeto
_projectWeight[projectId]       — agregado por projeto
_globalWeightCheckpoints        — agregado global
```

Cada escrita atualiza os 3 em O(1):

```solidity
uint256 newProjectWeight = oldProjectWeight - oldUserWeight + newUserWeight;
uint256 newGlobalWeight  = oldGlobalWeight  - oldUserWeight + newUserWeight;
```

Invariante: `globalWeight == SUM(projectWeight[i])` sempre.

Motivação: `RewardDistributor` no caminho bootstrap precisa `projectWeight / globalWeight`. Sem agregado global O(1), seria preciso iterar sobre N projetos a cada finalize — inviável em gas.

## `finalizeRound` permissionless

Qualquer um pode chamar. Ordem sequencial: `round == lastFinalizedRound + 1` (ou 0 se primeiro).

Por que permissionless:

- Destravar claim não precisa de governança — é ação puramente mecânica.
- Gás pago pelo chamador (~200k gas).
- Qualquer staker tem incentivo: se não finalizar, não claimam.

A sequencialidade força que rodadas anteriores sejam processadas antes. Impede "pular" uma rodada com parâmetros indesejáveis (alpha/capMax) — se você quer skip, seria via proposta mudando parâmetros antes da finalize específica.

## Genesis one-shot

`CreditToken.mintGenesis` tem flag `genesisMinted` que impede re-execução. Por que não usar `Ownable` + `renounceOwnership`?

- AccessControl é mais flexível (múltiplas roles).
- Genesis é uma **única** cunhagem com regra específica. Separá-la do `mint` operacional (role-based) é mais claro.
- Flag é barato (~20k gas por check após deploy).

## Separação MINTER vs DEFAULT_ADMIN no CreditToken

- `DEFAULT_ADMIN_ROLE` pode chamar `mintGenesis` (uma vez) e `grantRole`/`revokeRole`.
- `MINTER_ROLE` pode chamar `mint` (operacional, sem flag one-shot).

Se `DEFAULT_ADMIN` também tivesse `MINTER_ROLE`, o admin poderia cunhar a qualquer momento. Separando, o admin só cunha o genesis; inflação operacional fica isolada no contrato econômico (`RewardDistributor`).

## O caminho de bootstrap se ninguém tem GOV

Problema canônico de DAO ERC20Votes + Timelock:

1. Para mudar estado, precisa de proposta.
2. Para propor, precisa de GOV delegado acima de threshold.
3. Para ter GOV, alguém precisa ter mintado.
4. Mas mintar já é mudança de estado.

Solução: o deploy atribui ownership ao deployer (temporário). Deployer chama `mint` inicial e `transferOwnership(timelock)`. Timelock vira `pendingOwner`. **Primeira proposta aprovada em mainnet deve ser `acceptOwnership()` pelo Timelock** — consolida a transferência.

Janela crítica: entre deploy e acceptOwnership, deployer pode re-mintar livremente. Mitigação: deployer é multi-sig auditável, primeira proposta priorizada, renúncia planejada.

Documentado em [Mainnet deployment](02-mainnet-deployment.md).

---

**Próximo →** [Mainnet deployment](02-mainnet-deployment.md)
