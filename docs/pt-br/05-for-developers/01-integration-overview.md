# Visão geral de integração

**Para quem é:** dev que quer aceitar pagamentos em CREDIT dentro do próprio app usando o ecossistema web3community.
**Pré-requisitos:** [Dual-token economy](../02-core-concepts/01-dual-token-economy.md), Node ≥ 18, familiaridade com [viem](https://viem.sh).

Integrar um app significa duas coisas: **cobrar pagamentos** através do [`FeeRouterV2`](../08-contracts-reference/06-FeeRouterV2.md) e **verificar** esses pagamentos no seu backend. O SDK `@cesarsst/web3community-sdk` (v0.2.0) faz as duas pontas com viem puro — não há API HTTP a chamar, a "API" são as funções on-chain dos contratos.

## O modelo em uma frase

O usuário paga em CREDIT via `FeeRouterV2.pay(projectId, amount)`; o router cobra a fee de 2,5%, desconta o rev-share do projeto (se houver rodada financiada) e envia o resto pro seu app — tudo numa transação. Cada `pay` emite um evento `PaymentRouted` que seu backend usa como recibo verificável.

```
carteira do usuario                         seu backend
       |                                         |
   payActivation(sdk, wallet, {…})               |
       |  approve(CREDIT -> FeeRouterV2)          |
       |  FeeRouterV2.pay(projectId, amount)      |
       |  ---> tx minerada, PaymentRouted emitido |
       |                                          |
       |  envia txHash pro backend  ------------> |
       |                          verifyActivationPayment(sdk, {txHash, …})
       |                          <--- {valid, payment, blockTimestamp}
```

## Instalação

O SDK é publicado no GitHub Packages (registry privado). Pin de semver, nunca `file:`.

```bash
# .npmrc do seu projeto
@cesarsst:registry=https://npm.pkg.github.com
```

```jsonc
// package.json — pin exato
"dependencies": {
  "@cesarsst/web3community-sdk": "0.2.0",
  "viem": "^2.23.0"
}
```

## Configuração de runtime

O SDK não hardcoda endereços. Ele recebe um `RuntimeConfig` `{ chainId, rpcUrl, addresses }` — o mesmo shape que o backend web3community exporta em `scripts/export-runtime-config.ts` e que o frontend serve em `GET /config.json`.

```ts
import { createWeb3CommunitySdk, loadRuntimeConfig } from '@cesarsst/web3community-sdk'

// carrega de uma URL (ex.: /config.json do hub, ou seu próprio endpoint)
const config = await loadRuntimeConfig('https://hub.web3community.example/config.json')
const sdk = createWeb3CommunitySdk(config)
```

`addresses` precisa conter no mínimo `CreditToken`, `FeeRouterV2` e `ProjectRegistry` (validado em `parseRuntimeConfig`). Em ambiente local, gere o config a partir do deploy Ignition — ver [Ambiente local](05-local-dev.md).

## Cobrar um pagamento (lado da carteira)

`payActivation` faz o fluxo completo `approve` + `pay` a partir da carteira do usuário. **O pagador é sempre `msg.sender`** (a conta do `walletClient`) — não há custódia intermediária.

```ts
import { payActivation } from '@cesarsst/web3community-sdk'
import { parseEther } from 'viem'

const { approveHash, payHash } = await payActivation(sdk, walletClient, {
  projectId: 1n,
  amount: parseEther('10'),          // 10 CREDIT (18 decimais)
  onStep: (step) => console.log(step) // 'approve' | 'approve-wait' | 'pay' | 'pay-wait'
})
```

O que acontece por baixo:

1. Lê `allowance(payer, FeeRouterV2)`. Se `< amount`, envia `approve` **exato** e espera minerar.
2. Simula `FeeRouterV2.pay` (reverts viram erros decodificados) e envia a transação.
3. Espera a tx e retorna `payHash` (e `approveHash`, se o approve foi necessário).

Se a allowance já cobre o valor, o approve é pulado — só o `pay` acontece. Envie o `payHash` resultante pro seu backend.

### Preview do detalhamento (opcional, pra UI)

Antes de cobrar, mostre ao usuário quanto vai pra fee e quanto sobra pro app:

```ts
const { fee, revShare, toApp } = await sdk.feeRouterV2.previewPay(1n, parseEther('10'))
// fee = 2,5% * amount; revShare = revShareBps do projeto * amount; toApp = amount - fee - revShare
```

## Verificar um pagamento (lado do backend)

Nunca confie no cliente. No servidor, valide o `txHash` contra o evento on-chain:

```ts
import { verifyActivationPayment } from '@cesarsst/web3community-sdk'
import { parseEther } from 'viem'

const result = await verifyActivationPayment(sdk, {
  txHash,
  projectId: 1n,
  payer: userWalletAddress,   // deve bater com PaymentRouted.payer
  minAmount: parseEther('10') // valor mínimo aceito
})

if (result.valid) {
  // result.payment: { projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp }
  // result.blockTimestamp: âncora da janela de ativação (segundos)
  ativarServico(result.payment, result.blockTimestamp)
} else {
  console.warn('pagamento inválido:', result.reason)
}
```

`verifyActivationPayment` confere que:

- a transação minerou com **sucesso** (`receipt.status === 'success'`);
- ela emitiu `PaymentRouted` **do `FeeRouterV2` oficial** (filtra por `log.address`, ignorando eventos de contratos impostores);
- o evento bate com `projectId`, `payer` e `amount >= minAmount`.

Retorna o `blockTimestamp` do bloco para você ancorar janelas de ativação (ex.: assinatura válida por N segundos).

> **Anti-replay é responsabilidade sua.** O SDK não guarda estado. Marque cada `txHash` como consumido no seu banco para impedir que o mesmo recibo ative o serviço duas vezes.

## Checklist de integração

1. Registrar seu app como projeto no Registry e ativá-lo via governança — ver [Submeter um projeto](03-submitting-a-project.md). Sem projeto `Active`, `pay` reverte com `ProjectNotActive`.
2. Instalar o SDK (pin de semver) e carregar o `RuntimeConfig`.
3. Front: `payActivation` a partir da carteira do usuário.
4. Backend: `verifyActivationPayment` + anti-replay por `txHash`.
5. (Opcional) definir um `appRecipient` dedicado com `FeeRouterV2.setAppRecipient(projectId, recipient)` — por padrão o destino é o `owner` do projeto.

## Referências

- SDK completo (client, activation, walletLink): `@cesarsst/web3community-sdk`.
- Contrato de cobrança: [FeeRouterV2](../08-contracts-reference/06-FeeRouterV2.md).
- Consulta de estado on-chain: [Consultar estado](04-querying-state.md).

---

**Próximo →** [Endereços dos contratos](02-contract-addresses.md)
