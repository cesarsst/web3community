# Visão geral de integração

**Para quem é:** dev que quer listar um app no ecossistema e aceitar CREDIT como pagamento.
**Pré-requisitos:** [Arquitetura](../03-protocol-overview/01-architecture.md), [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md).

## O contrato que você precisa conhecer

Para aceitar pagamentos em CREDIT, você vai interagir com **um** contrato principal:

- [`FeeRouter`](../08-contracts-reference/08-FeeRouter.md) — função `pay(projectId, user, amount)`.

Tudo o mais (burn, treasury, rebate, status do projeto) é tratado automaticamente dentro dele.

## O ciclo completo de integração

```
1. Desenvolva seu app (fora do protocolo — qualquer stack)
   A lógica do app sabe: "servico X custa N CREDIT"

2. Registre o projeto via proposta (requer 10.000 GOV como colateral)
   Resultado: projectId atribuido (ex: 42)

3. Apos ativacao, seu app pode chamar FeeRouter.pay em nome do usuario
   (com approve previo do usuario)

4. (Opcional) Stake no proprio projectId para capturar emissao via (B)

5. Monitore eventos e metricas
```

## O que o app chama

Do ponto de vista do backend/contrato do seu app, o fluxo é:

```solidity
// Passo 1 (off-chain): UI do seu app mostra preco ao usuario
// Passo 2: UI pede approve
IERC20(creditToken).approve(feeRouter, amount);

// Passo 3: UI/app chama pay (ou o usuario chama direto)
(uint256 burned, uint256 toTreasury, uint256 toApp) =
    feeRouter.pay(projectId, user, amount);

// Passo 4: app verifica sucesso (via evento Paid ou return values)
// Passo 5: app entrega o servico ao usuario
```

`pay` é **pública** — qualquer um pode chamar, desde que `user` tenha `allowance`. Isso permite:

- **O próprio usuário** chamando `pay` (paga o gas ele mesmo).
- **O app** chamando `pay` em nome do usuário (gas sponsorship — app paga gas, usuário só aprovou antes).
- **Um relayer / smart wallet** chamando `pay` em nome do usuário (meta-tx-like).

O "payer econômico" é sempre `user` (pago via `transferFrom`).

## Quanto o app recebe

Dado o split default em produção (70% burn, 20% treasury, 10% rebate — `burnBps/treasuryBps/rebateBps = 7000/2000/1000` em `ignition/parameters/production.json`):

- Imediato: **10%** vai para o `appRecipient` (default é o `owner` do projeto no Registry).
- Indiretamente, via `RewardDistributor` da próxima rodada: **share de emissão proporcional ao burn do projeto**, que o app pode capturar se stakar.

Detalhamento das 3 fontes de receita (rebate + stake + apreciação do CREDIT retido) em [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).

## Aviso para UIs de claim — sempre checar `previewClaim` antes

`RewardDistributor.claim` com `amount == 0` é **no-op silencioso no contrato** (não marca `claimed[round][projectId][user]`), mas **gasta gas do caller** e não emite `Claimed`. Pior: `claimMany` aceita arrays grandes com todas as entries zeradas, desperdiçando gas sem efeito.

Se você integra uma UI de claim (dashboard de staker, app de consumo que também mostra rewards, etc.), **sempre chame `previewClaim(user, round, projectId)` antes** e só permita a tx se o retorno for `> 0`. Isso evita:

- Usuários pagando gas em transações que não fazem nada.
- Loops de retry inúteis quando o usuário não entende por que nada muda.
- Vetor de DoS leve onde alguém submete `claimMany` com 1000 entries todas com `amount = 0` — contrato aceita, gasta gas do caller, não marca nada.

```solidity
// Padrão recomendado pela UI:
uint256 preview = distributor.previewClaim(user, round, projectId);
if (preview == 0) return; // não habilitar botão
// senão, habilitar claim
```

Para `claimMany`, filtre pares `(round, projectId)` com `previewClaim > 0` antes de montar os arrays.

## Eventos que você quer monitorar

Do `FeeRouter`:

- `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)` — a cada pagamento do seu projeto.

Do `BurnTracker`:

- `BurnRecorded(round, projectId, from, amount, newTotalForProject)` — burn do seu projeto em cada rodada.
- `RoundClosed(round, totalBurn, projectsCount, closedAt, earlyClose)` — para saber quando uma rodada fecha.

Do `RewardDistributor`:

- `RoundFinalized(round, totalEmission, totalBurnAtFinalize, snapshotBlock)` — quando você pode começar a reivindicar.
- `Claimed(user, round, projectId, amount)` — cada claim feito por stakers do seu projeto.

## Configurando destino do rebate

Por default, o rebate vai para `ProjectRegistry.getProject(projectId).owner`. Se você quer direcionar para outro endereço (por exemplo, um contrato de distribuição interna do app, um multisig operacional, etc.):

```solidity
// Chamável pelo owner atual do projeto
feeRouter.setAppRecipient(projectId, newRecipient);
```

Passar `address(0)` reseta para lookup dinâmico (volta a seguir o owner do Registry).

Esta função é **owner-gated**, não governance-gated — rotação operacional não exige proposta.

## Cota e limites

- **Sanity cap por rodada**: em produção 10M CREDIT de burn por projeto por rodada. Se seu app explodir em volume em uma rodada, tx que ultrapasse o cap reverte com `SanityCapExceeded`. Use batch scheduling off-chain se esperar volume absurdo (split em múltiplas rodadas).
- **Projeto precisa estar `Active`**. Se virar `Probation` (punitiva) ou `Removed`, `pay` reverte com `ProjectNotActive`.

## Testando

Desenvolvimento local via Hardhat + Ignition (veja [Ambiente local](05-local-dev.md)).

Para testnet Sepolia, a equipe do protocolo fornece endereços após deploy. Sua UI aponta para esses endereços usando a configuração apropriada.

## O que o app **não** precisa fazer

- **Não** chame `BurnTracker.burnAndRecord` diretamente do seu app. O `FeeRouter.pay` faz isso por você. Apenas o `FeeRouter` tem `RECORDER_ROLE` no bootstrap.
- **Não** chame `CreditToken.burnByRole` diretamente. O caminho oficial de burn é via `FeeRouter`.
- **Não** precisa se preocupar com o splitting. Ele é feito pelo `FeeRouter` automaticamente.

## Segurança

Seu app deve:

- Verificar que o `user` na chamada `pay` é quem você espera (não passe `user = msg.sender` cegamente se o fluxo é meta-tx).
- Confiar no retorno de `pay` — se a tx não reverteu, o pagamento foi processado com sucesso.
- Tratar `ProjectNotActive` e `SanityCapExceeded` como sinais de erro irrecuperáveis naquela tx.

Seu app **não precisa**:

- Guardar CREDIT intermediário — `pay` é atômico.
- Gerenciar allowance infinita — a UX mais limpa é approve por quantia, não infinita, mas depende do seu UX.

---

**Próximo →** [Endereços dos contratos](02-contract-addresses.md)
