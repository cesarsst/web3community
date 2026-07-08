# Visão geral de integração

**Para quem é:** dev que quer listar um app no ecossistema e aceitar CREDIT como pagamento.
**Pré-requisitos:** [Arquitetura](../03-protocol-overview/01-architecture.md), [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md).

> **Remodel 2026-07-08**: a integração de pagamento vigente é via [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) — assinatura **nova**: `pay(projectId, amount)` (o pagador é `msg.sender`; não existe mais o parâmetro `user`). Validação de pagamento é por evento `PaymentRouted`. O `FeeRouter` V1 é legado.

## O contrato que você precisa conhecer

Para aceitar pagamentos em CREDIT, você vai interagir com **um** contrato principal:

- [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) — função `pay(projectId, amount)`.

Tudo o mais (fee, rev-share, status do projeto, métricas de volume) é tratado automaticamente dentro dele.

## O ciclo completo de integração

```
1. Desenvolva seu app (fora do protocolo — qualquer stack)
   A lógica do app sabe: "servico X custa N CREDIT"

2. Registre o projeto via proposta (requer 10.000 GOV como colateral)
   Resultado: projectId atribuido (ex: 42)

3. Apos ativacao, o usuario paga chamando FeeRouterV2.pay(projectId, amount)
   (com approve previo do proprio usuario — o pagador e msg.sender)

4. Seu backend valida o pagamento pelo evento PaymentRouted

5. (Opcional) Abra uma rodada de captacao no ProjectFunding
   (capital antecipado em troca de rev-share 1-30% da receita bruta)

6. Monitore eventos e metricas (grossVolumeOf = GMV on-chain)
```

## O que o app chama

Do ponto de vista do frontend do seu app, o fluxo é:

```solidity
// Passo 1 (off-chain): UI do seu app mostra preco ao usuario
// Passo 2: UI pede approve (assinado pelo usuario)
IERC20(creditToken).approve(feeRouterV2, amount);

// Passo 3: o usuario chama pay — o pagador e msg.sender
feeRouterV2.pay(projectId, amount);

// Passo 4: backend valida via evento PaymentRouted (ver abaixo)
// Passo 5: app entrega o servico ao usuario
```

**Diferença importante do V1**: a assinatura é `pay(projectId, amount)` — o pagador é sempre `msg.sender`. Não há mais o parâmetro `user`, então **quem assina a tx é quem paga**. Fluxos de gas sponsorship/meta-tx exigem que a smart wallet do usuário seja o `msg.sender` (ex.: ERC-4337), não um relayer arbitrário com allowance alheia.

Para preview do detalhamento na UI (sem side effects):

```solidity
(uint256 fee, uint256 revShare, uint256 toApp) =
    feeRouterV2.previewPay(projectId, amount);
```

## Validando o pagamento — evento `PaymentRouted`

O jeito canônico de o backend confirmar um pagamento é observar o evento:

```solidity
event PaymentRouted(
    uint256 indexed projectId,
    address indexed payer,
    uint256 amount,
    uint256 feeToTreasury,
    uint256 feeToBuyback,
    uint256 feeToGrants,
    uint256 revShare,
    uint256 toApp
);
```

Padrão recomendado: o backend recebe o `txHash` do frontend, busca o receipt, decodifica o `PaymentRouted` e confere `projectId`, `payer` (a wallet vinculada ao usuário) e `amount` (≥ preço do serviço). O SDK `@cesarsst/web3community-sdk` implementa esse fluxo (`payActivation`/`verifyActivationPayment`).

## Quanto o app recebe

Com fee default de **2,5%** (250 bps; teto duro 500):

- **Sem rodada de funding**: **97,5%** de cada pagamento, na carteira do `appRecipient`, no mesmo bloco.
- **Com rodada financiada** (ex.: rev-share de 8%): **~89,5%** — a fee e o rev-share são descontados atomicamente no `pay`.

Não há burn, não há espera de rodada: a receita é imediata. Capital antecipado adicional pode vir de uma rodada no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) (alvo ≥ `minTarget`, rev-share 1-30%, prazo 1-90 dias, all-or-nothing). Detalhamento em [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).

## Eventos que você quer monitorar

Do `FeeRouterV2`:

- `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)` — a cada pagamento do seu projeto (validação + analytics).
- `AppRecipientUpdated(projectId, recipient)` — rotação do recipient.

Do `ProjectFunding` (se você abriu rodada):

- `RoundOpened` / `Invested` / `RoundFunded` / `RoundFailed` — ciclo da captação.
- `RevenueNotified(projectId, amount)` — rev-share contabilizado a cada pagamento.

> **Legado**: eventos `Paid` (FeeRouter V1), `BurnRecorded`/`RoundClosed` (BurnTracker) e `RoundFinalized`/`Claimed` (RewardDistributor) pertencem ao trilho antigo — só interessam para históricos.

## Configurando destino do pagamento

Por default, o `toApp` vai para `ProjectRegistry.getProject(projectId).owner`. Se você quer direcionar para outro endereço (por exemplo, um contrato de distribuição interna do app, um multisig operacional, etc.):

```solidity
// Chamável pelo owner atual do projeto
feeRouterV2.setAppRecipient(projectId, newRecipient);
```

Esta função é **owner-gated**, não governance-gated — rotação operacional não exige proposta.

## Cota e limites

- **Projeto precisa estar `Active`**. Se virar `Probation` (punitiva) ou `Removed`, `pay` reverte com `ProjectNotActive`.
- **Sem sanity cap de volume** no V2 — `grossVolumeOf` apenas acumula. (O cap de burn por rodada era do trilho legado.)

## Testando

Desenvolvimento local via Hardhat + Ignition (veja [Ambiente local](05-local-dev.md)).

Para testnet Sepolia, a equipe do protocolo fornece endereços após deploy. Sua UI aponta para esses endereços usando a configuração apropriada.

## O que o app **não** precisa fazer

- **Não** chame `ProjectFunding.notifyRevenue` — só o FeeRouterV2 tem `REVENUE_NOTIFIER_ROLE`; o rev-share é roteado automaticamente em cada `pay`.
- **Não** precisa se preocupar com o splitting (fee/rev-share/app). Ele é feito pelo `FeeRouterV2` automaticamente e é auditável no evento.
- **Não** precisa integrar DEX para o usuário obter CREDIT — aponte para o PSM (`CreditPSM.buy`, 1:1 com USDC, sem taxa).

## Segurança

Seu app deve:

- Validar o pagamento pelo evento `PaymentRouted` (conferindo `projectId`, `payer` e `amount`) antes de liberar o serviço — não confie só em callback do frontend.
- Tratar `ProjectNotActive` como sinal de erro irrecuperável naquela tx.
- Lembrar que o pagador é `msg.sender` — desenhe o fluxo de wallet do usuário de acordo.

Seu app **não precisa**:

- Guardar CREDIT intermediário — `pay` é atômico e o router termina cada tx com saldo 0.
- Gerenciar allowance infinita — a UX mais limpa é approve por quantia, não infinita, mas depende do seu UX.

---

**Próximo →** [Endereços dos contratos](02-contract-addresses.md)
