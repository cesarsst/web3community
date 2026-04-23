# Como participar

**Para quem é:** usuário comum, pouca experiência com DAO, pouca paciência para teoria.
**Pré-requisitos:** ter uma wallet EVM (MetaMask, Rabby, Coinbase Wallet, etc.).

## As três formas de estar no sistema

Você pode participar de três maneiras, em ordem crescente de engajamento:

1. **Usuário de app** — compra CREDIT na DEX externa, gasta nos apps. É o fluxo mais simples.
2. **Staker** — trava GOV em projetos que suporta, recebe CREDIT emitido.
3. **Votante** — delega voting power e vota em propostas do Governor.

Você pode combinar as três. Muitos stakers também são usuários e votantes.

## Como usuário de app — passo a passo

**O que você precisa:**

- Uma wallet EVM conectada à rede do protocolo.
- ETH (gas).
- CREDIT — adquirido em DEX externa (Uniswap, PancakeSwap, etc., conforme integrações que aparecerem).

**O que você faz:**

1. Na UI do app, descubra o preço do serviço em CREDIT.
2. Clica "pagar" — o app te direciona a assinar:
   - `CREDIT.approve(feeRouter, amount)` (uma única vez — aprova o gasto).
   - `FeeRouter.pay(projectId, you, amount)` (efetiva o pagamento).
3. Você recebe o serviço do app. 95% do valor pago foi queimado, 5% foi para o app.

**O que não é necessário:**

- Você **não** precisa ter GOV.
- Você **não** precisa votar.
- Você **não** precisa stakar.

Alguns apps podem oferecer fluxo onde eles mesmos submetem a tx (você só assina meta-transação). Nesse caso, o `approve` basta.

## Como staker — passo a passo

**O que você precisa:**

- GOV — adquirido em DEX externa ou recebido por alguma alocação.
- Decisão consciente de qual `projectId` suportar.
- Decisão de lock (14 a 365+ dias).

**O que você faz:**

1. Escolha o projeto. Consulte o Registry (`projects[projectId]`) para confirmar `status == Active` e ler `metadataURI`.
2. Escolha o lock. Multiplier linear: 14d = 1x, 365d = 4x. Locks maiores que 365d são aceitos mas multiplier satura em 4x.
3. `GOV.approve(staking, amount)`.
4. `Staking.stake(projectId, amount, lockDuration)`.
5. Aguarde rodadas fecharem e serem finalizadas.
6. `RewardDistributor.claim(round, projectId)` ou `claimMany([rounds], [projectIds])` para sacar CREDIT.

**Sair:**

- Após o lock expirar: `Staking.unstake(projectId, amount)` ou `unstakeAll(projectId)`.
- Se o projeto for `Removed` antes: unstake imediato (bypass de lock).
- Durante o lock (e projeto não-Removed): **não pode sair**. Planeje.

Mais detalhe em [Staking em projetos](03-staking-in-projects.md) e [Reivindicar rewards](05-claiming-rewards.md).

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
| `FeeRouter.pay` (split default) | ~180-220k gas |
| `Staking.stake` | ~250-300k gas |
| `Staking.unstake` | ~150-200k gas |
| `RewardDistributor.claim` (uma rodada/projeto) | ~180-220k gas |
| `RewardDistributor.claimMany` (N pares) | ~180k + ~140k × N |
| `CommunityGovernor.castVote` | ~90k gas |

Valores aproximados em gas — custo em ETH depende da rede e do preço de gas no momento.

## O que não fazer

- **Não envie GOV direto para os contratos econômicos.** `Staking.stake` puxa via `transferFrom`. Transferência direta fica presa.
- **Não tente `unstake` antes do lock** se o projeto está `Active` ou `Probation`. Reverte com `LockNotExpired`.
- **Não pague em apps sem `approve`.** A função `pay` precisa de allowance.
- **Não esqueça de `delegate`** se quer votar — ter GOV sem delegar = voting power 0.
- **Não acredite em "yield garantido"**. O reward varia com o uso dos apps. Se o uso cai, reward cai junto.

## FAQ rápido

**Preciso saber programar?** Não. O hub do protocolo tem UI para todas as operações. Você assina transações na sua wallet.

**Quanto custa participar?** O custo-base é gas da rede. Em Sepolia (testnet) é quase zero. Para stakar você precisa ter GOV. Para usar apps, CREDIT.

**A DAO pode confiscar meu GOV stakado?** Não. O lock protege mesmo contra a própria governança. Enquanto o lock está vigente, nem proposta aprovada destrava seu stake (exceto se o projeto for removido — aí o destrave é pró-você, não contra).

**E se o protocolo morrer?** Se o uso cair a quase zero, emissão colapsa, APR vai a quase zero, stakers tendem a sair. A DAO pode intervir (ajustar α, abrir subsídio via Treasury, contratar novos apps). Mas tokenomics não salva produto ruim.

---

**Próximo →** [Ter GOV](02-holding-gov.md)
