# Directed staking: stake de GOV por projeto

**Para quem é:** quem quer investir em projetos e precisa entender o pré-requisito (stake de GOV) — e por que ele existe.
**Pré-requisitos:** [Dual-token economy](01-dual-token-economy.md).

## O que muda em relação a staking "genérico"

Na maioria dos protocolos você staka um token e recebe reward "do protocolo", indefinido. Aqui o stake é **direcionado**: você trava GOV **num projeto específico** do [Registry](../08-contracts-reference/04-ProjectRegistry.md), e o peso gerado vale **só naquele projeto**.

```
stake(projectId = ChatApp, amount = 100 GOV, lockDuration = 180 dias)
        |
        v
   Voce gera peso SO no ChatApp.
   peso = 100 GOV * multiplier(180 dias)
```

No modelo vigente (remodel 2026-07-08), o stake **não rende mais emissão de token** — não existe reward inflacionário. O papel do stake é outro, e duplo:

1. **Curadoria com pele em jogo (sinal de confiança).** Ao lockar GOV num projeto, você sinaliza on-chain que aposta nele. O peso agregado por projeto (`getTotalWeight`) é um sinal público de quais apps a comunidade respalda.
2. **Pré-requisito para investir e sacar.** Ter peso `> 0` num projeto é o **gate** para entrar na rodada de captação dele no [ProjectFunding](04-project-funding.md) (`invest`) e para sacar o rev-share acumulado (`claim`).

Ou seja: **sem GOV stakeado no projeto, você não investe nele nem saca a receita dele.** É o mecanismo que garante skin in the game — quem colhe rev-share tem que manter capital político travado no projeto que financiou.

## Peso: amount × multiplier

O peso de uma posição é calculado por [`Staking`](../08-contracts-reference/05-Staking.md):

```
weight = amount * multiplier(lockDuration) / 1e18
```

O `multiplier` é **linear** entre o lock mínimo e o máximo, e satura no topo:

| Lock | Multiplier | Fórmula |
|---|---|---|
| `MIN_LOCK` = 14 dias | 1x (`1e18`) | piso |
| entre 14 e 365 dias | interpolação linear | `1e18 + (d − 14d) · 3e18 / (365d − 14d)` |
| `MAX_LOCK` = 365 dias | 4x (`4e18`) | teto |
| acima de 365 dias | 4x | satura (mas o lock real é respeitado) |

Constantes verificáveis no contrato:

```solidity
uint256 public constant MIN_LOCK = 14 days;
uint256 public constant MAX_LOCK = 365 days;
uint256 public constant MAX_MULTIPLIER = 4e18;   // 4x
```

Locks abaixo de 14 dias revertem com `LockTooShort`. Locks acima de 365 dias são **aceitos literalmente**: o multiplier não passa de 4x, mas o tempo real de trava é honrado no `unstake`.

## As operações

Todas em [`Staking`](../08-contracts-reference/05-Staking.md), uma posição única por par (`user`, `projectId`):

- **`stake(projectId, amount, lockDuration)`** — abre ou consolida a posição. Só aceita projeto `Active`. Se já existe posição, consolida (Opção B): `newAmount = old + amount`, `lockDuration = max(restante, novoLock)` e `lockStartAt` **reseta para agora**. O reset é intencional: impede alongar peso indefinidamente com micro-stakes sem re-comprometer o amount antigo.
- **`increaseStake(projectId, amount)`** — soma amount **preservando** `lockStartAt`/`lockDuration`. Não reabre lock expirado.
- **`extendLock(projectId, newLockDuration)`** — só aumenta a duração (nunca encurta). Não move tokens.
- **`unstake(projectId, amount)` / `unstakeAll(projectId)`** — devolve GOV. Exige lock expirado, **exceto** se o projeto está `Removed` (bypass do lock — a DAO removeu o projeto, não o staker).

## Regras de status do projeto

O gating de stake segue o status do projeto no Registry:

- **`Active`** — stake novo permitido; `invest`/`claim` liberados.
- **`Probation` punitiva** (governança suspendeu por má conduta) — bloqueia stake novo e pagamentos, mas **nunca bloqueia unstake**. Você não fica preso por decisão de governança.
- **`Removed`** (terminal) — libera o unstake **imediatamente**, ignorando o lock.

> A *probation inicial por tempo* (janela automática de novo projeto, `isInProbation`) é diferente: ela apenas sinaliza que o projeto é novo. Stake, invest e pagamentos funcionam normalmente durante ela. Ver [Glossário → Probation](../01-getting-started/03-glossary.md#probation).

## Anti-flashloan: peso é historiado

O peso é escrito em checkpoints por bloco (`Checkpoints.Trace208`). As views `getWeightAt` / `getTotalWeightAt` / `getGlobalWeightAt` leem peso em bloco **passado**. Isso impede que alguém mova GOV no mesmo bloco de uma consulta para manipular gate ou sinal. O gate do `ProjectFunding`, no entanto, usa o peso **corrente** (`getWeight`) — o requisito é simplesmente "tenha stake vivo agora", então flash-stake não ajuda: você teria que manter o GOV travado para sacar depois.

## Por que isso alinha incentivos

- O investidor **escolhe** projetos (seleção ativa, não passiva) — é curadoria de apps.
- Para colher rev-share, tem que **manter** o stake — não dá para financiar, sacar e sair no mesmo bloco.
- Se o projeto que você financiou some do mapa, seu investimento não rende — mesmo que outros estejam bombando. O capital fica amarrado ao sucesso específico daquele app.

## O que directed staking NÃO faz (no modelo vigente)

- **Não rende emissão.** Não há reward inflacionário de token por stakar. A única renda ligada a um projeto é o rev-share da receita real, e ela vem do [ProjectFunding](04-project-funding.md), condicionada a você ter investido na rodada.
- **Não dá voto extra.** Voto vem de GOV delegado (`ERC20Votes`), não de GOV stakeado. Stakar GOV, aliás, transfere a custódia para o contrato `Staking` — planeje a delegação de voto separadamente (ver [Governance](05-governance.md)).
- **Não trava CREDIT.** Você staka **GOV**; o CREDIT é **investido** na rodada, não stakeado.

---

**Próximo →** [Trilho de pagamento](03-payment-rail.md)
