# Como participar

**Para quem é:** usuário comum, pouca experiência com DAO, pouca paciência para teoria.
**Pré-requisitos:** ter uma wallet EVM (MetaMask, Rabby, Coinbase Wallet, etc.).

## As três formas de estar no sistema

Você pode participar de três maneiras, em ordem crescente de engajamento:

1. **Usuário de app** — compra CREDIT no PSM (1:1 com USDC, sem taxa), gasta nos apps. É o fluxo mais simples.
2. **Investidor** — trava GOV em projetos que suporta (curadoria) e investe CREDIT nas rodadas de captação deles; recebe fatia da receita real (rev-share).
3. **Votante** — delega voting power e vota em propostas do Governor.

Você pode combinar as três. Muitos investidores também são usuários e votantes.

## Como usuário de app — passo a passo

**O que você precisa:**

- Uma wallet EVM conectada à rede do protocolo.
- ETH (gas).
- USDC — para comprar CREDIT no [CreditPSM](../08-contracts-reference/15-CreditPSM.md).

**O que você faz:**

1. Compre CREDIT (aba **Swap** do hub): `USDC.approve(psm, amount)` + `CreditPSM.buy(amount)` — recebe 1:1, sem taxa nem slippage. Pode resgatar de volta a qualquer momento com `sell` (também 1:1).
2. Na UI do app, descubra o preço do serviço em CREDIT.
3. Clica "pagar" — o app te direciona a assinar:
   - `CREDIT.approve(feeRouterV2, amount)` (aprova o gasto).
   - `FeeRouterV2.pay(projectId, amount)` (efetiva o pagamento — o pagador é você, `msg.sender`).
4. Você recebe o serviço do app. Do valor pago: 2,5% de fee do protocolo (40% treasury / 40% buyback GOV / 20% grants), rev-share do projeto se houver rodada financiada, e o resto (~89,5-97,5%) vai na hora pro app. Nada é queimado.

**O que não é necessário:**

- Você **não** precisa ter GOV.
- Você **não** precisa votar.
- Você **não** precisa stakar.

## Como investidor — passo a passo

**O que você precisa:**

- GOV — adquirido em DEX externa ou recebido por alguma alocação.
- CREDIT — comprado no PSM.
- Decisão consciente de qual `projectId` suportar.

**O que você faz:**

1. Escolha o projeto. Consulte o Registry (`projects[projectId]`) para confirmar `status == Active`, leia `metadataURI` e confira o GMV on-chain (`FeeRouterV2.grossVolumeOf(projectId)`).
2. Stake GOV no projeto: `GOV.approve(staking, amount)` + `Staking.stake(projectId, amount, lockDuration)` (lock 14-365+ dias; multiplier 1x-4x). **O stake é o gate**: sem GOV stakeado no projeto você não pode investir nem sacar rev-share.
3. Na aba **Investir** do hub, confira a rodada do projeto: alvo, rev-share (1-30%), prazo (1-90 dias). All-or-nothing: se não bater o alvo, refund integral.
4. `CREDIT.approve(projectFunding, amount)` + `ProjectFunding.invest(projectId, amount)`.
5. Se a rodada bater o alvo (Funded), você passa a acumular rev-share a cada pagamento roteado pro app.
6. Saque quando quiser com `ProjectFunding.claim(projectId)` — na aba Investir. Nunca expira.

**Sair:**

- Rodada Failed (prazo venceu sem bater o alvo): `refund(projectId)` devolve 100% do investido.
- Rodada Funded: o capital investido não volta — o que você comprou é o fluxo de rev-share.
- GOV stakeado: após o lock expirar, `Staking.unstake` / `unstakeAll`. Se o projeto for `Removed`, unstake imediato (bypass de lock). Sem stake, o rev-share acruado fica retido (não é perdido) até você re-stakear.

Mais detalhe em [Staking em projetos](03-staking-in-projects.md) e [Sacando rev-share](05-claiming-rewards.md).

## Como votante — passo a passo

**O que você precisa:**

- GOV (qualquer quantidade).
- Delegar voting power a si mesmo (sem delegação = sem voto, mesmo com GOV).

**O que você faz:**

1. `GovernanceToken.delegate(yourAddress)` — uma única vez. Isso ativa seu voting power.
2. Quando uma proposta abre, acesse a UI do Governor (hub).
3. `CommunityGovernor.castVote(proposalId, support)` — `support` = 0 (Against), 1 (For), 2 (Abstain).
4. Espere a votação fechar. Se a proposta vence, vai para o Timelock.
5. Após o delay do Timelock (2d), qualquer um pode chamar `execute` — sua ação não é necessária, apenas bom sinal.

Você **não** precisa stakar para votar. O voting power vem do GOV que você detém (via `getPastVotes`), não do stake.

Mais detalhe em [Votar em propostas](04-voting.md).

## Custos operacionais

| Ação | Custo |
|---|---|
| `approve` (uma vez por allowance) | ~46k gas |
| `CreditPSM.buy` / `sell` | ~90-120k gas |
| `FeeRouterV2.pay` | ~150-250k gas (varia com rev-share ativo) |
| `Staking.stake` | ~250-300k gas |
| `Staking.unstake` | ~150-200k gas |
| `ProjectFunding.invest` | ~150-200k gas |
| `ProjectFunding.claim` | ~100-150k gas |
| `CommunityGovernor.castVote` | ~90k gas |

Valores aproximados em gas — custo em ETH depende da rede e do preço de gas no momento.

## O que não fazer

- **Não envie GOV direto para os contratos econômicos.** `Staking.stake` puxa via `transferFrom`. Transferência direta fica presa.
- **Não tente `unstake` antes do lock** se o projeto está `Active` ou `Probation`. Reverte com `LockNotExpired`.
- **Não pague em apps sem `approve`.** A função `pay` precisa de allowance.
- **Não tire todo o GOV do stake se ainda tem rev-share a sacar** — o `claim` do ProjectFunding exige GOV stakeado no projeto. O valor não expira, mas fica retido até você re-stakear.
- **Não esqueça de `delegate`** se quer votar — ter GOV sem delegar = voting power 0.
- **Não acredite em "yield garantido"**. O rev-share vem da receita real do app. Se o app não vende, rev-share = zero.

## FAQ rápido

**Preciso saber programar?** Não. O hub do protocolo tem UI para todas as operações. Você assina transações na sua wallet.

**Quanto custa participar?** O custo-base é gas da rede. Em Sepolia (testnet) é quase zero. Para investir você precisa ter GOV (stake) e CREDIT (rodada). Para usar apps, só CREDIT — comprado 1:1 no PSM.

**Meu CREDIT pode desvalorizar?** O CREDIT é resgatável 1:1 em USDC no PSM a qualquer momento, com lastro integral retido no contrato. O risco residual é o do próprio USDC e de bug de contrato — ver [Riscos](../06-for-investors/03-risk-and-security.md).

**A DAO pode confiscar meu GOV stakado?** Não. O lock protege mesmo contra a própria governança. Enquanto o lock está vigente, nem proposta aprovada destrava seu stake (exceto se o projeto for removido — aí o destrave é pró-você, não contra).

**E se o protocolo morrer?** Se o uso cair a quase zero, não há receita para ninguém: apps não faturam, rev-share seca, buyback de GOV para. Seu CREDIT continua resgatável 1:1 no PSM. Mas tokenomics não salva produto ruim.

**E o claiming antigo de rewards?** O trilho de emissão (RewardDistributor V1/V2) é **legado** — claims históricos continuam sacáveis, mas não há emissão nova. Ver [Sacando rev-share](05-claiming-rewards.md).

---

**Próximo →** [Ter GOV](02-holding-gov.md)
