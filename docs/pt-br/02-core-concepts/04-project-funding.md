# Funding por rev-share: ProjectFunding

**Para quem é:** investidores que querem financiar apps e donos de projeto que querem captar capital antecipado.
**Pré-requisitos:** [Directed staking](02-directed-staking.md) e [Trilho de pagamento](03-payment-rail.md).

## A ideia central

No modelo vigente, a renda do investidor **não vem de inflação de token** — vem de uma fatia da **receita bruta real** do app que ele financiou. O [`ProjectFunding`](../08-contracts-reference/07-ProjectFunding.md) é o contrato que:

1. deixa o dono de um projeto **captar** CREDIT antecipado de investidores; e
2. em troca, promete a esses investidores uma fatia (`revShareBps`) de **cada pagamento futuro** que o app receber via [FeeRouterV2](03-payment-rail.md).

```
1. Dono abre rodada      openRound(alvo, revShareBps, prazo)
2. Investidores entram   invest(projectId, CREDIT)   <- exige GOV stakeado
3a. Alvo batido          -> Funded: dono recebe o captado, rev-share ativa
3b. Prazo vence s/ alvo  -> Failed: refund integral pra todos
4. App fatura            FeeRouterV2 chama notifyRevenue a cada pay
5. Investidor saca        claim(projectId)           <- exige GOV stakeado
```

## Abrir a rodada: `openRound`

Só o **dono** de um projeto `Active` abre a rodada, e **apenas uma vez por projeto** (rodada única — MVP):

```solidity
function openRound(uint256 projectId, uint256 target, uint16 revShareBps, uint64 duration) external;
```

Bounds validados no contrato:

| Parâmetro | Regra | Constante |
|---|---|---|
| `target` (alvo) | ≥ `minTarget` (default 100 CREDIT) | `minTarget = 100e18` (ajustável por governança) |
| `revShareBps` | 100 a 3000 (1% a 30%) | `MIN_REV_SHARE_BPS = 100`, `MAX_REV_SHARE_BPS = 3000` |
| `duration` (prazo) | 1 a 90 dias | `MIN_ROUND_DURATION = 1 days`, `MAX_ROUND_DURATION = 90 days` |

Fora de qualquer faixa, reverte (`TargetOutOfBounds`, `RevShareOutOfBounds`, `DurationOutOfBounds`). Aberta a rodada, `deadline = now + duration` e o status vira `Open`.

## Investir: `invest` (exige GOV stakeado)

```solidity
function invest(uint256 projectId, uint256 amount) external nonReentrant {
    // ... rodada Open e dentro do prazo ...
    if (STAKING.getWeight(msg.sender, projectId) == 0) revert NoGovStaked(projectId, msg.sender);
    uint256 remaining = r.target - r.raised;
    if (amount > remaining) revert ExceedsTarget(amount, remaining);
    r.raised += amount;
    sharesOf[projectId][msg.sender] += amount;   // shares = CREDIT investido, 1:1
    CREDIT.safeTransferFrom(msg.sender, address(this), amount);
    if (r.raised == r.target) _fund(projectId, r);  // bateu o alvo -> finaliza
}
```

Pontos-chave:

- **Gate de GOV.** Você **precisa ter GOV stakeado naquele projeto** ([Staking](02-directed-staking.md)) — `getWeight(...) > 0`. Sem stake, `invest` reverte com `NoGovStaked`. Este é o elo entre os dois conceitos: stake é o pré-requisito de investimento.
- **Shares = CREDIT investido**, 1:1, imutável depois que a rodada é financiada. Determinam a fatia pro-rata do rev-share.
- **Não ultrapassa o alvo.** Um investimento não pode passar de `remaining`; quando `raised == target`, a rodada finaliza automaticamente.

## All-or-nothing

A rodada só paga o dono se **bater o alvo**. Isso protege o investidor de financiar pela metade um projeto inviável.

- **`Funded`** — alvo batido. `_fund` transfere todo o `raised` ao dono e o rev-share passa a valer (`revShareBpsOf` retorna o bps ao FeeRouterV2).
- **`Failed`** — prazo vencido sem bater o alvo. Qualquer um "carimba" a falha com `closeExpiredRound(projectId)` (permissionless). Depois, cada investidor recupera 100% via `refund(projectId)`.

```solidity
function refund(uint256 projectId) external nonReentrant {
    // ... só se status == Failed ...
    uint256 amount = sharesOf[projectId][msg.sender];
    sharesOf[projectId][msg.sender] = 0;
    r.raised -= amount;
    CREDIT.safeTransfer(msg.sender, amount);   // devolve integral
}
```

## A receita chega: `notifyRevenue`

Quando o app fatura, o [FeeRouterV2](03-payment-rail.md) desconta o rev-share do pagamento, transfere o CREDIT ao `ProjectFunding` e chama:

```solidity
function notifyRevenue(uint256 projectId, uint256 amount) external onlyRole(REVENUE_NOTIFIER_ROLE) {
    // ... rodada Funded, raised > 0 ...
    accRevenuePerShare[projectId] += (amount * ACC_PRECISION) / r.raised;
    totalRevenueDistributed[projectId] += amount;
}
```

Só o FeeRouterV2 pode chamar (`REVENUE_NOTIFIER_ROLE`). A distribuição usa um **acumulador tipo MasterChef** (`accRevenuePerShare`, precisão `1e18`): O(1) por pagamento e O(1) por claim, sem iterar sobre investidores.

## Sacar: `claim` (exige GOV stakeado)

```solidity
function claim(uint256 projectId) external nonReentrant returns (uint256 amount) {
    if (STAKING.getWeight(msg.sender, projectId) == 0) revert NoGovStaked(projectId, msg.sender);
    amount = _pending(projectId, msg.sender);
    if (amount == 0) revert NothingToClaim(projectId, msg.sender);
    rewardDebt[projectId][msg.sender] =
        (sharesOf[projectId][msg.sender] * accRevenuePerShare[projectId]) / ACC_PRECISION;
    CREDIT.safeTransfer(msg.sender, amount);
}
```

Regras que definem o alinhamento:

- **Exige GOV ainda stakeado** no projeto — o mesmo gate de `invest`. Skin in the game: quem colhe rev-share tem que manter capital político travado.
- **Claims nunca expiram.** Se você retirou o stake, o valor **não é perdido** — fica acruado até você voltar a stakear e chamar `claim`. Consulte o pendente a qualquer momento com `pendingRevenue(projectId, investor)`.

## Views para UI e auditoria

| View | Retorna |
|---|---|
| `revShareBpsOf(projectId)` | bps ativo (0 se não `Funded`) — consumido pelo FeeRouterV2 |
| `pendingRevenue(projectId, investor)` | receita ainda não sacada do investidor |
| `sharesOf[projectId][investor]` | shares do investidor (= CREDIT investido) |
| `totalRevenueDistributed[projectId]` | receita total já distribuída (auditoria) |
| `rounds[projectId]` | struct `Round` completa (target, raised, deadline, revShareBps, status) |

## Limitações honestas

- **Rodada única por projeto (MVP).** Rodadas subsequentes exigiriam empilhar pools de shares com bps distintos — fora de escopo, documentado para V2.
- **Rev-share é receita, não token.** O `ProjectFunding` vende fatia de **receita bruta**, não emite token novo — não é launchpad.
- **Bloqueador regulatório pré-mainnet.** O rev-share tem semântica que pode caracterizar um valor mobiliário (*security*). **O parecer jurídico sobre o rev-share é um bloqueador pré-mainnet** — ver [Riscos e segurança](../06-for-investors/03-risk-and-security.md).

---

**Próximo →** [Governança](05-governance.md)
