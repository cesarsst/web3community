# Métricas que importam

**Para quem é:** quem avalia uma rodada de investimento ou o protocolo com dados on-chain, não com narrativa.
**Pré-requisitos:** [Value accrual](02-value-accrual.md), noções de leitura de contrato (viem/ethers ou um explorer).

Tudo aqui é **verificável on-chain** — nenhuma métrica depende de dashboard fechado ou de números autorreportados. Esta página mapeia cada métrica à função que a expõe.

## Volume: a métrica-mãe (e a mais fácil de forjar)

Todo o resto (buyback, rev-share) deriva do volume processado. Leia-o com três funções, na ordem:

### `FeeRouterV2.recentVolumeOf(projectId)` — o número que a UI mostra

Volume **não-self** com decaimento exponencial (meia-vida `volumeHalfLife`, default 30 dias). Um wash em rajada evapora; sustentar um número falso custa ~2,5% dele a cada meia-vida.

```ts
const recent = await sdk.feeRouterV2.recentVolumeOf(1n)
```

### `FeeRouterV2.uniquePayersOf(projectId)` — quantas carteiras distintas pagaram

Cresce uma vez por carteira. Inflável com carteiras novas ao custo de gas — por isso vale mais **cruzado** com o volume: 10.000 CREDIT de 3 pagadores é um sinal diferente de 10.000 CREDIT de 300.

### `FeeRouterV2.grossVolumeOf(projectId)` — auditoria

Soma histórica sem decaimento. Serve para reconciliar eventos `PaymentRouted`, não para avaliar tração: nunca cai, e um wash de um ano atrás ainda está lá.

**O que nenhum dos três prova:** que os pagadores são terceiros. O router só descarta pagamentos da carteira do owner/`appRecipient` (`selfPayment`); uma segunda carteira do dono passa. Por isso a régua é **tendência + pagadores distintos com histórico em outros projetos**, não o valor absoluto. O buyback de GOV é ~1% do volume real; o rev-share é `revShareBps` dele — se o volume for circular, o rev-share também é (e volta para quem o gerou).

### `FeeRouterV2.feeBps`

Fee atual do protocolo em bps (250 = 2,5%). Teto duro `FEE_BPS_CAP = 500` (5%). Confirme que está no valor esperado — é o que separa o GMV da parcela que vai pro app.

## Receita distribuída: o retorno já realizado

### `ProjectFunding.totalRevenueDistributed(projectId)`

Receita bruta total já **distribuída** aos investidores daquele projeto, em CREDIT. É o rev-share acumulado ao longo de todos os `pay` desde que a rodada financiou. Cresce monotonicamente.

```ts
const distributed = await funding.totalRevenueDistributed(1n)
```

Por que importa: mostra que a posição de rev-share está pagando. Compare com o alvo captado (`target`) para estimar o retorno percentual já realizado da rodada. **Atenção:** este contador **inclui** self-payments (o rev-share de um pagamento do próprio owner também é notificado) — um dono que detenha as shares da própria rodada infla o "% retornado" pagando a si mesmo.

### `ProjectFunding.pendingRevenue(projectId, investor)`

Quanto **você** especificamente tem a sacar agora, dado suas shares e o acumulador atual.

```ts
const claimable = await funding.pendingRevenue(1n, minhaCarteira)
```

Lembre: sacar (`claim`) exige ter GOV stakeado no projeto (peso > 0) no momento do saque; o valor acruado fica retido, não expira — salvo se o projeto for removido do Registry (aí `stake()` reverte e o pendente fica preso).

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

Para projetar yield futuro, o driver é a **taxa de crescimento do volume recente** (`recentVolumeOf`) e o `revShareBps` da rodada. Modelo honesto: `rev-share por período ≈ revShareBps * ΔGMV do período`. Nenhuma dessas contas é garantida — todas dependem de o app faturar.

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

1. `recentVolumeOf(projectId)` + `uniquePayersOf(projectId)` — o app tem tração recente **de carteiras distintas**? Cresce? (`grossVolumeOf` só para reconciliar histórico.)
1b. `rounds(projectId).raised` vs. `Invested` events — a rodada foi preenchida por várias carteiras ou por uma só (auto-rodada)?
2. `rounds(projectId)` — os termos (alvo, rev-share, prazo) fazem sentido?
3. `totalRevenueDistributed(projectId)` — se já financiou antes, está pagando?
4. `Registry.getProject(projectId)` — status `Active`? Colateral do owner condizente?
5. `backing()` vs `mintedOutstanding` — o CREDIT que você vai aportar está lastreado?
6. `Registry.getProject(projectId).owner` e `FeeRouterV2.appRecipientOf(projectId)` — quem recebe? O `appRecipient` pode ser trocado pelo owner **sem timelock**; o rev-share só existe enquanto o app receber pelo router (ver [Riscos](03-risk-and-security.md#risco-de-fuga-do-trilho-rev-share-inexigível)).

---

**Próximo →** [Ciclo de uma proposta](../07-governance/01-proposal-lifecycle.md)
