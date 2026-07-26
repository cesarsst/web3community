# Fluxo de valor

**Para quem é:** quem quer formar um juízo sobre o tokenomics — por onde o valor real entra, transita e sai.
**Pré-requisitos:** [Trilho de pagamento](../02-core-concepts/03-payment-rail.md) e [Funding por rev-share](../02-core-concepts/04-project-funding.md).

## O fluxo em uma imagem

```
   USUARIO
     |  1. compra CREDIT 1:1 com USDC (sem taxa)
     v
   CreditPSM  ---- lastro USDC 100% retido, sem saque ----
     |  CREDIT
     v
   2. paga um app: FeeRouterV2.pay(projectId, 100 CREDIT)
     |
     +-- 2,5 CREDIT  fee (2,5%)     --> 40% treasury (1,0)
     |                                  40% buyback GOV (1,0)
     |                                  20% grants (0,5)
     |
     +-- ate 8 CREDIT rev-share (se captou com rev-share; ex. 8%)
     |        --> ProjectFunding --> investidores (pro-rata)  ---+
     |                                                            | 5. investidor saca (claim)
     +-- ~89,5-97,5 CREDIT --> app, na hora                       v
                |                                              CREDIT
                |  3. app resgata USDC no PSM quando quiser    (resgatavel no PSM)
                v
              USDC

   4. buyback: os 1,0 CREDIT/pagamento acumulam no buybackRecipient
      --> governanca recompra GOV --> demanda estrutural por GOV
```

## Passo a passo do valor

### 1. Entrada: USDC → CREDIT (sem perda)

O usuário compra CREDIT no [CreditPSM](../02-core-concepts/03-payment-rail.md) 1:1 com USDC, **sem taxa**. Comprar CREDIT não é gastar nem investir — é carregar o "cartão pré-pago" do ecossistema. O USDC fica 100% retido como lastro, e o CREDIT é resgatável 1:1 a qualquer momento. Nenhum valor é perdido nessa borda.

### 2. Uso: o pagamento se reparte

Num pagamento de **100 CREDIT** via `FeeRouterV2.pay`, com fee default 2,5% (250 bps) e um projeto que captou com rev-share de, digamos, **8%**:

| Parcela | CREDIT | % do pagamento |
|---|---|---|
| Fee → Treasury | 1,0 | 1,0% |
| Fee → Buyback de GOV | 1,0 | 1,0% |
| Fee → Grants | 0,5 | 0,5% |
| Rev-share → investidores | 8,0 | 8,0% |
| **App (na hora)** | **89,5** | **89,5%** |

Se o projeto **não** captou (rev-share = 0%), o app fica com **97,5%** e a única dedução é a fee de 2,5%. Portanto o app recebe **~89,5% a 97,5%** de cada pagamento, imediatamente, em CREDIT — que pode virar USDC no PSM na hora que quiser.

### 3. App: recebe quase tudo, na hora

Diferente de modelos com burn ou lockup, o app recebe sua fatia **imediatamente** e sem trava. Isso torna o custo de aceitar CREDIT competitivo com processadores de pagamento tradicionais (a fee de 2,5% é comparável a cartão).

### 4. GOV captura valor via buyback

40% da fee (1% do GMV com os defaults) é destinada a **buyback de GOV**. Quanto mais volume os apps processam, mais CREDIT acumula no `buybackRecipient` para recompra de GOV no mercado → demanda estrutural por GOV proporcional ao uso agregado.

> **Pendência honesta.** A recompra automatizada **não está implementada**: os fundos acumulam no recipient até a governança executar a recompra manualmente. Ver [Value accrual](../06-for-investors/02-value-accrual.md).

### 5. Investidor saca rev-share

Quem financiou a rodada do app (e mantém GOV stakeado no projeto) saca sua fatia pro-rata da receita com `claim`. O yield é verificável on-chain (`totalRevenueDistributed`, `grossVolumeOf`). Se o app não fatura, não há rev-share — a renda é estritamente função da receita real.

## Custo de capital do app: ~19% a.a.

O ponto de vista do **dono do app** que capta via rodada: ele recebe capital antecipado hoje e, em troca, cede uma fatia da receita futura. Com os parâmetros do protocolo, o custo de capital efetivo fica na ordem de **~19% ao ano** — competitivo com dívida de risco para um app early-stage, e sem diluir equity nem emitir token próprio. O dono escolhe o rev-share (1%–30%) e o alvo na abertura da rodada, calibrando esse custo conforme a confiança que a comunidade demonstra (via stake) e a receita que projeta.

## Para onde o valor real vai

- **Usuário**: recebe o serviço dos apps; nunca perde principal (CREDIT resgatável 1:1).
- **App**: fica com ~89,5–97,5% da receita, na hora, + capital antecipado da rodada.
- **Investidor**: recebe % da receita real (rev-share), condicionado a manter stake.
- **DAO / Treasury**: acumula 40% da fee (1% do GMV) para custear operações e iniciativas.
- **GOV holders**: capturam via buyback (40% da fee) — proporcional ao GMV agregado.
- **Grants**: 20% da fee (0,5% do GMV) financia novos apps.

## O ciclo de realimentação

```
   mais uso  ->  mais receita pros apps  ->  mais apps querem listar
      ^                    |                          |
      |                    +--> mais rev-share    +--> mais capital antecipado
      |                    +--> mais buyback GOV        (rodadas de funding)
      +---------------------------------------------------+
```

Se o uso cai, a receita cai, o rev-share seca, o buyback para, o sistema desacelera. **Tokenomics não salva produto ruim**: a sustentação depende dos apps gerarem utilidade real. O protocolo é uma ponte entre utilidade real e retorno — sem inflar nem desvalorizar a moeda de pagamento.

## O que este fluxo NÃO tem

- **Nenhuma emissão inflacionária como renda.** A renda do investidor é rev-share de receita real, não token novo.
- **Nenhuma queima especulativa.** A única queima é o `sell()` do PSM (resgate), 1:1, sem efeito de escassez.
- **Nenhum toque no lastro.** O USDC do PSM é segregado; o Treasury vive só da fee.

---

**Próximo →** [Como participar](../04-for-users/01-participate.md)
