# Como participar

**Para quem é:** qualquer pessoa querendo entrar na web3community — do usuário casual ao investidor.
**Pré-requisitos:** uma carteira EVM (MetaMask, Rabby, Coinbase Wallet) e um pouco de USDC na rede do protocolo.

Esta página é o mapa das jornadas possíveis. Cada uma tem sua própria página com o passo a passo.

## Os quatro caminhos

```
   Tenho USDC
      |
      v
   1. Comprar CREDIT no PSM  --->  usar os apps (pagar features)
      |
      +--> 2. Segurar/delegar GOV  --->  4. Votar em propostas
      |
      +--> 3. Stakar GOV num projeto  --->  investir na rodada  --->  5. Sacar rev-share
```

| Quero... | Preciso de | Comece por |
|---|---|---|
| **Usar um app** (pagar features) | CREDIT | [Comprar CREDIT](#1-comprar-credit-o-primeiro-passo) abaixo |
| **Participar da governança** | GOV delegado | [Ter GOV](02-holding-gov.md) |
| **Investir em projetos** | GOV stakeado + CREDIT | [Staking em projetos](03-staking-in-projects.md) |
| **Votar em propostas** | GOV delegado (a si) | [Votar](04-voting.md) |
| **Receber rev-share** | ter investido + manter stake | [Sacar rev-share](05-claiming-revenue.md) |

## 1. Comprar CREDIT: o primeiro passo

Tudo começa com CREDIT — a moeda de uso, estável **1:1 com USDC**. Você o compra no [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md):

1. **Aprove USDC** ao contrato do PSM (`USDC.approve(psm, valor)`).
2. **Compre**: `CreditPSM.buy(usdcAmount)` — deposita USDC (6 decimais), recebe CREDIT (18 decimais) na proporção exata, **sem taxa**.
3. Pronto: o CREDIT está na sua carteira, pronto para pagar em qualquer app listado.

Para **sair**, é o inverso: `CreditPSM.sell(creditAmount)` devolve CREDIT (queimado) e te dá USDC 1:1, sem taxa. O lastro é 100% retido no PSM e resgatável a qualquer momento.

> **CREDIT não é aposta.** Ele não valoriza nem desvaloriza — 10 CREDIT valem 10 USDC hoje, amanhã e daqui a um ano. Comprar CREDIT é carregar um cartão pré-pago, não investir. Quem quer exposição à valorização do ecossistema segura **GOV**.

## 2. Pagar nos apps

Com CREDIT na carteira, você usa os apps normalmente. Ao pagar por uma feature, o app chama (ou pede que você chame) `FeeRouterV2.pay(projectId, amount)`. Do valor, ~89,5–97,5% vai pro app na hora, 2,5% é fee do protocolo e, se o app captou investimento, uma fatia vira rev-share dos investidores. Detalhes em [Trilho de pagamento](../02-core-concepts/03-payment-rail.md).

## 3. Ir além: GOV, stake e rev-share

Se você quer mais do que usar apps:

- **[Ter GOV](02-holding-gov.md)** — o token político. Segurar e **delegar** GOV te dá voto.
- **[Staking em projetos](03-staking-in-projects.md)** — travar GOV num projeto específico. É o pré-requisito para investir na rodada dele e sacar rev-share.
- **[Votar](04-voting.md)** — participar das decisões da DAO.
- **[Sacar rev-share](05-claiming-revenue.md)** — colher a fatia da receita real dos projetos que você financiou.

## Em qual rede?

O protocolo roda em **hardhat local (31337)** para desenvolvimento e **Sepolia (11155111)** para testnet pública. Mainnet ainda não existe — depende de auditoria externa e de parecer jurídico sobre o rev-share (ver [Riscos e segurança](../06-for-investors/03-risk-and-security.md)). Em rede local, o [`DevFaucet`](../08-contracts-reference/12-DevFaucet.md) entrega ETH (gas) + USDC mock para você comprar CREDIT no PSM.

---

**Próximo →** [Ter GOV](02-holding-gov.md)
