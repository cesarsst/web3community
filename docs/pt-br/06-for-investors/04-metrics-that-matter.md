# Métricas que importam

**Para quem é:** quem avalia uma rodada de investimento ou o protocolo com dados on-chain, não com narrativa.
**Pré-requisitos:** [Value accrual](02-value-accrual.md), noções de leitura de contrato (viem/ethers ou um explorer).

Tudo aqui é **verificável on-chain** — nenhuma métrica depende de dashboard fechado ou de números autorreportados. Esta página mapeia cada métrica à função que a expõe.

## Volume: a métrica-mãe

Todo o resto (buyback, rev-share) deriva do volume bruto processado.

### `FeeRouterV2.grossVolumeOf(projectId)`

Volume bruto acumulado (GMV) de um projeto, em CREDIT (18 decimais). Cada `pay` soma `amount` a esse contador.

```ts
const gmv = await sdk.feeRouterV2.grossVolumeOf(1n)
```

Por que importa: é o denominador da tese. O buyback de GOV é ~1% desse volume; o rev-share do investidor é `revShareBps` desse volume. Um projeto com GMV estagnado não vai render, por melhor que seja a narrativa. Acompanhe a **tendência**, não o valor absoluto — GMV crescente é o sinal de saúde.

### `FeeRouterV2.feeBps`

Fee atual do protocolo em bps (250 = 2,5%). Teto duro `FEE_BPS_CAP = 500` (5%). Confirme que está no valor esperado — é o que separa o GMV da parcela que vai pro app.

## Receita distribuída: o retorno já realizado

### `ProjectFunding.totalRevenueDistributed(projectId)`

Receita bruta total já **distribuída** aos investidores daquele projeto, em CREDIT. É o rev-share acumulado ao longo de todos os `pay` desde que a rodada financiou. Cresce monotonicamente.

```ts
const distributed = await funding.totalRevenueDistributed(1n)
```

Por que importa: é a prova concreta de que a posição de rev-share está pagando. Compare com o alvo captado (`target`) para estimar o retorno percentual já realizado da rodada.

### `ProjectFunding.pendingRevenue(projectId, investor)`

Quanto **você** especificamente tem a sacar agora, dado suas shares e o acumulador atual.

```ts
const claimable = await funding.pendingRevenue(1n, minhaCarteira)
```

Lembre: sacar (`claim`) exige manter GOV stakeado no projeto; o valor nunca expira.

## Lastro: a integridade do CREDIT

### `CreditPSM.backing()` e `CreditPSM.mintedOutstanding`

- `backing()` — USDC efetivamente retido no PSM (6 decimais).
- `backingNormalized()` — o mesmo em 18 decimais, comparável direto.
- `mintedOutstanding` — CREDIT mintado pelo PSM em circulação (18 decimais).

```ts
const backing = await psm.backingNormalized()
const minted  = await psm.mintedOutstanding()
// invariante I-PSM1: backing >= minted, SEMPRE
```

Por que importa: `backingNormalized() >= mintedOutstanding` é a invariante de solvência do CREDIT. Se algum dia isso não valer, o peg 1:1 estaria comprometido — mas o desenho (sem função de saque do lastro) impede que caia abaixo por ação de governança.

## Yield por projeto

Não há uma função única de "APY" — o protocolo não promete rendimento. Você o **estima** combinando as métricas acima:

```
yield realizado da rodada ≈ totalRevenueDistributed(projectId) / target
sua fatia estimada        ≈ suas shares / raised  (== CREDIT investido / total captado)
```

Para projetar yield futuro, o driver é a **taxa de crescimento do GMV** (`grossVolumeOf`) e o `revShareBps` da rodada. Modelo honesto: `rev-share por período ≈ revShareBps * ΔGMV do período`. Nenhuma dessas contas é garantida — todas dependem de o app faturar.

## Dados da rodada (para avaliar antes de entrar)

Consulte o mapping `rounds(projectId)` do `ProjectFunding` para os termos:

| Campo | O que diz |
|---|---|
| `target` | alvo em CREDIT da rodada |
| `raised` | quanto já foi captado |
| `deadline` | timestamp limite |
| `revShareBps` | fatia da receita oferecida (100–3000) |
| `status` | `Open` / `Funded` / `Failed` (ou `None`) |

`revShareBpsOf(projectId)` retorna o bps **ativo** (0 se a rodada ainda não financiou) — é exatamente o que o router usa para descontar.

## Checklist de due diligence on-chain

Antes de entrar numa rodada, leia diretamente da chain:

1. `grossVolumeOf(projectId)` — o app tem tração real? Cresce?
2. `rounds(projectId)` — os termos (alvo, rev-share, prazo) fazem sentido?
3. `totalRevenueDistributed(projectId)` — se já financiou antes, está pagando?
4. `Registry.getProject(projectId)` — status `Active`? Colateral do owner condizente?
5. `backing()` vs `mintedOutstanding` — o CREDIT que você vai aportar está lastreado?

---

**Próximo →** [Ciclo de uma proposta](../07-governance/01-proposal-lifecycle.md)
