# Trilho de pagamento: CreditPSM + FeeRouterV2

**Para quem é:** dev integrando um app, investidor e curioso econômico — quem quer entender como o dinheiro entra, se move e se reparte.
**Pré-requisitos:** [Dual-token economy](01-dual-token-economy.md).

O "trilho de pagamento" (payment rail) é o coração operacional do protocolo depois do remodel 2026-07-08. São dois contratos:

1. [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md) — a porta de entrada e saída do dinheiro (USDC ↔ CREDIT, 1:1).
2. [`FeeRouterV2`](../08-contracts-reference/06-FeeRouterV2.md) — o roteador que reparte cada pagamento em fee, rev-share e a fatia do app.

```
   USDC  --buy-->  CreditPSM  --mint-->  CREDIT  --pay-->  FeeRouterV2  --->  app + investidores + DAO
   USDC  <-sell--            <--burn--
```

## CreditPSM: 1 CREDIT = 1 USDC, sempre

O PSM (*Peg Stability Module*) é o **único** minter e burner do CREDIT no modelo vigente. Ele garante o peg por construção: cada CREDIT em circulação nascido dele tem 1 USDC guardado.

### `buy(usdcAmount)` — entra USDC, sai CREDIT

```solidity
function buy(uint256 usdcAmount) external nonReentrant returns (uint256 creditOut) {
    if (usdcAmount == 0) revert ZeroAmount();
    creditOut = usdcAmount * SCALE;                       // 6 -> 18 decimais
    USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);
    mintedOutstanding += creditOut;
    CREDIT.mint(msg.sender, creditOut, "psm:buy");
    emit Bought(msg.sender, usdcAmount, creditOut);
}
```

Deposita USDC (6 decimais), minta CREDIT (18 decimais) na proporção exata — o `SCALE = 1e12` faz a conversão. **Sem taxa.** O USDC fica retido no contrato.

### `sell(creditAmount)` — entra CREDIT, sai USDC

```solidity
function sell(uint256 creditAmount) external nonReentrant returns (uint256 usdcOut) {
    if (creditAmount == 0) revert ZeroAmount();
    if (creditAmount % SCALE != 0) revert DustAmount(creditAmount, SCALE);
    usdcOut = creditAmount / SCALE;
    // ... checa lastro suficiente ...
    IERC20(address(CREDIT)).safeTransferFrom(msg.sender, address(this), creditAmount);
    CREDIT.burnByRole(address(this), creditAmount, "psm:sell");   // queima
    USDC.safeTransfer(msg.sender, usdcOut);
    emit Sold(msg.sender, creditAmount, usdcOut);
}
```

Devolve CREDIT (queimado — esta é a **única** "queima" no protocolo vigente), recebe USDC 1:1, sem taxa. Poeira abaixo de `1e-6 USDC` (não múltipla de `SCALE`) reverte com `DustAmount` em vez de ser confiscada.

### Lastro integral, sem função de saque

```solidity
function backing() external view returns (uint256) {           // 6 decimais
    return USDC.balanceOf(address(this));
}
function backingNormalized() external view returns (uint256) { // 18 decimais
    return USDC.balanceOf(address(this)) * SCALE;
}
```

O lastro é verificável a qualquer momento. **Não existe nenhuma função de saque do lastro — nem para a governança.** Se a DAO quer gastar, gasta da fee do FeeRouterV2, nunca daqui. Isso é o que torna o CREDIT confiável como meio de pagamento: o usuário sempre consegue resgatar.

## FeeRouterV2: `pay(projectId, amount)`

Todo pagamento dentro de um app passa por aqui. A ordem é **fee → rev-share → app**, atômica:

```solidity
function pay(uint256 projectId, uint256 amount) external nonReentrant {
    if (amount == 0) revert ZeroAmount();
    if (!REGISTRY.isActive(projectId)) revert ProjectNotActive(projectId);
    CREDIT.safeTransferFrom(msg.sender, address(this), amount);

    // fee do protocolo
    uint256 fee = (amount * feeBps) / BPS;                       // feeBps = 250 (2,5%)
    uint256 toTreasury = (fee * feeSplit.treasuryBps) / BPS;     // 40% da fee
    uint256 toBuyback  = (fee * feeSplit.buybackBps)  / BPS;     // 40% da fee
    uint256 toGrants   = fee - toTreasury - toBuyback;           // 20% da fee (resíduo)

    // rev-share do projeto (0 se nunca captou)
    uint256 revShare = (amount * FUNDING.revShareBpsOf(projectId)) / BPS;

    // app fica com o resto
    uint256 toApp = amount - fee - revShare;
    // ... transfere cada parcela; revShare vai pro FUNDING via notifyRevenue ...
    grossVolumeOf[projectId] += amount;
    emit PaymentRouted(projectId, msg.sender, amount, toTreasury, toBuyback, toGrants, revShare, toApp);
}
```

### A fee: 2,5%, teto duro de 5%

```solidity
uint16 public constant FEE_BPS_CAP = 500;   // 5% — nem governança ultrapassa
uint16 public feeBps;                        // default 250 = 2,5%
```

A fee default é **250 bps (2,5%)**. A governança pode ajustá-la, mas o `FEE_BPS_CAP = 500` é imutável — a fee **nunca** passa de 5%. Setters (`setFeeBps`, `setFeeSplit`, `setRecipients`) são `onlyRole(GOVERNANCE_ROLE)` — em produção, só o Timelock.

### O split da fee: 40 / 40 / 20

A fee é repartida entre três destinos (soma exata de 10.000 bps, validada em `_validateSplit`):

| Destino | Bps default | % da fee | % do pagamento (com fee 2,5%) |
|---|---|---|---|
| Treasury | 4000 | 40% | 1,0% |
| Buyback de GOV | 4000 | 40% | 1,0% |
| Grants | 2000 | 20% | 0,5% |

Os três recipients são endereços configuráveis. No deploy MVP, os três apontam para o [Treasury](../08-contracts-reference/08-Treasury.md) — mas os eventos carregam o detalhamento por parcela, então a contabilidade on-chain é transparente mesmo com endereços coincidentes. A governança re-aponta `buybackRecipient`/`grantsRecipient` quando quiser separá-los.

> **Buyback: pendência honesta.** A parcela de buyback só **acumula** no `buybackRecipient` — a recompra automatizada de GOV **não está implementada**. A execução da recompra é feita pela governança, quando e como a DAO decidir. Ver [Value accrual](../06-for-investors/02-value-accrual.md).

### O rev-share: descontado no ato

Se o projeto tem rodada financiada no [ProjectFunding](04-project-funding.md), `revShareBpsOf(projectId)` retorna o bps prometido (1%–30%); senão, retorna 0. A fatia de rev-share é **descontada do pagamento na hora**, transferida ao contrato `ProjectFunding` e contabilizada via `notifyRevenue` — que o FeeRouterV2 pode chamar por deter `REVENUE_NOTIFIER_ROLE`.

### O resto vai pro app, na hora

O `appRecipient` (configurável pelo dono via `setAppRecipient`; fallback é o owner no Registry) recebe `amount − fee − revShare` **imediatamente**, em CREDIT. Com fee 2,5% e rev-share entre 0% e 8%, isso dá **~89,5% a 97,5%** do pagamento chegando ao app na hora. O app pode resgatar USDC no PSM quando quiser.

### O evento `PaymentRouted`

```solidity
event PaymentRouted(
    uint256 indexed projectId, address indexed payer, uint256 amount,
    uint256 feeToTreasury, uint256 feeToBuyback, uint256 feeToGrants,
    uint256 revShare, uint256 toApp
);
```

Detalhamento completo de cada pagamento. É a **fonte de verdade** para verificação server-side (usada pelo SDK em `verifyActivationPayment`). Além dele, `grossVolumeOf[projectId]` acumula o GMV on-chain do projeto.

## Como o dev usa isso

1. Usuário aprova CREDIT ao FeeRouterV2 e chama `pay(projectId, amount)` (ou o app chama em nome do usuário, com allowance).
2. Antes, `previewPay(projectId, amount)` retorna `(fee, revShare, toApp)` para exibir na UI.
3. O backend do app confirma o pagamento lendo o evento `PaymentRouted`.

---

**Próximo →** [Funding por rev-share](04-project-funding.md)
