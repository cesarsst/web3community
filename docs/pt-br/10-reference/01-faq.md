# FAQ

**Para quem é:** qualquer pessoa com uma pergunta específica.
**Pré-requisitos:** nenhum.

## Geral

### O que é a web3community?

Uma plataforma multi-aplicativos governada por DAO. Desde o **remodel 2026-07-08**, é um **trilho de pagamento + funding por rev-share**: os apps aceitam CREDIT (estável 1:1 USDC via [CreditPSM](../08-contracts-reference/15-CreditPSM.md)) com fee de apenas 2,5% no [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md), e investidores financiam projetos em troca de fatia da receita real via [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md). (Legado: o modelo burn-to-mint com split 70/20/10 e emissão por rodada foi substituído.) Detalhe em [O que é](../01-getting-started/01-what-is-web3community.md).

### Qual a diferença entre GOV e CREDIT?

GOV é governança + gate de investimento (supply fixo 100M, vota, captura valor via buyback contínuo). CREDIT é meio de pagamento **estável 1:1 com USDC** (mint/burn no PSM, não especulativo). Detalhes em [Dual-token](../02-core-concepts/01-dual-token-economy.md) e [Modelo mental](../01-getting-started/02-mental-model.md).

### Onde estão os contratos?

18 contratos em `contracts/*.sol` — 3 do remodel 2026-07-08 (`CreditPSM`, `FeeRouterV2`, `ProjectFunding`) + 15 anteriores (parte deles agora legado: `FeeRouter` V1, `BurnTracker`, `RewardDistributor` V1/V2, `LiquidityGauge`). Referência individual em [08-contracts-reference](../08-contracts-reference/). Endereços on-chain em [Contract addresses](../05-for-developers/02-contract-addresses.md).

### Por que um app usaria o FeeRouter em vez de cobrar por fora?

No modelo antigo, não usaria — a taxa efetiva de ~80% tornava o bypass estratégia dominante (equilíbrio de Nash no colapso; parecer `audit/economist/2026-07-08-feerouter-bypass.md`). Foi exatamente por isso que o protocolo mudou. No modelo vigente:

- **Fee de 2,5%** — mais barato que Stripe (~3,8%) e muito abaixo de app stores (15-30%). Teto duro de 5% que nem governança ultrapassa.
- **Capital antecipado** — só projetos que roteiam receita pelo FeeRouterV2 têm rev-share verificável e conseguem captar no `ProjectFunding` (custo de capital ~19% a.a. nos exemplos, comparável a revenue-based financing: Pipe/Clearco 15-25%).
- **Métricas on-chain pra investidores** — `grossVolumeOf` é o histórico de GMV que dá credibilidade à rodada.
- **Hub, base de usuários e trilho pronto** (PSM + router, sem adquirente/chargeback).

Cobrar por fora significa abrir mão do funding e da distribuição — pra pagar mais caro em outro processador.

### CREDIT valoriza?

**Não — por desenho.** CREDIT é estável: 1 CREDIT = 1 USDC, sempre, com compra e resgate 1:1 no PSM (lastro 100% retido, sem função de saque — nem governança). Quem captura a valorização do ecossistema é o **GOV**: 40% da fee de cada pagamento (= 1% do GMV) financia buyback contínuo de GOV. Quem busca renda financia projetos via `ProjectFunding` (rev-share de receita real).

### Qual rede está rodando?

Ver [Contract addresses](../05-for-developers/02-contract-addresses.md). Rede de produção principal será definida pós-auditoria externa.

## Uso

### Preciso saber programar?

Não. O hub tem UI para todas as operações. Você assina transações na sua wallet.

### Quanto custa participar?

Gas da rede + tokens necessários (GOV para stakar, CREDIT para pagar apps). Em testnet (Sepolia), gas é quase zero.

### Como recebo CREDIT?

- Compra no `CreditPSM` com USDC, 1:1 e sem taxa (`buy`). Resgata do mesmo jeito (`sell`).
- Recebe como rev-share se investiu em rodada de projeto que fatura (`ProjectFunding.claim`).
- Recebe via `UserSubsidy` se era elegível em uma campanha.
- (Legado: rewards de emissão por burn — claims históricos seguem sacáveis.)

### Como recebo GOV?

- Compra em DEX externa.
- Recebe via alocação aprovada pela DAO (public sale, airdrop, vesting se é equipe).

### Como voto?

1. Delegue voting power a si: `gov.delegate(you)`.
2. Espere proposta abrir.
3. Chame `governor.castVote(proposalId, support)` via UI ou direto.

Detalhe em [Votar em propostas](../04-for-users/04-voting.md).

### A DAO pode confiscar meu GOV stakado?

**Não.** O lock do staking protege mesmo contra a própria governança. Enquanto o lock está vigente, proposta aprovada **não destrava** seu stake. A única exceção é se o projeto for `Removed` — aí é liberação antecipada, pro-usuário (não contra).

### E se o protocolo morrer?

Se o uso cair a quase zero, o GMV seca: rev-share vai a zero, fee vai a zero (sem buyback, sem opex). Investidores ficam com posições que não rendem — mas o CREDIT continua resgatável 1:1 no PSM (o lastro não depende de atividade). A DAO pode intervir (grants, subsídio via Treasury, contratar novos apps). Mas tokenomics não salva produto ruim.

### O buyback de GOV é real ou "futuro"?

**Real e contínuo.** 40% da fee de cada `FeeRouterV2.pay` (= 1% do GMV) vai automaticamente pro `buybackRecipient` — não depende de proposta por evento. Quanto mais pagamento nos apps, mais pressão de compra de GOV. Detalhe em [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

(Legado: o buyback de **CREDIT** do modelo FFP — `Treasury.executeBuyback`, swap USDC→CREDIT + queima com caps de 20%/30% — pertence ao trilho antigo; com CREDIT estável via PSM, não há floor a defender. Detalhe em [Treasury](../08-contracts-reference/04-Treasury.md).)

## Staking

### Qual o lock mínimo?

14 dias. Lock abaixo reverte com `LockTooShort`.

### Qual o lock máximo?

Não há máximo programático. Mas o multiplier satura em 4x a partir de 365 dias — lockar mais que isso imobiliza capital sem ganhar peso adicional.

### Posso sair antes do lock?

**Não**, exceto se o projeto for `Removed`. `Probation` (punitiva ou inicial) não bypassa lock.

### Posso stakar em múltiplos projetos?

Sim. Cada `projectId` é uma posição independente.

### Se eu increase_stake, o lock reseta?

**Não.** `increaseStake` preserva `lockStartAt` e `lockDuration`. Só `stake` numa posição existente reseta.

### Extend lock muda amount?

**Não.** `extendLock` só muda `lockDuration`.

## Renda do investidor (rev-share)

### Como invisto num projeto?

1. Stake GOV no projeto (`Staking.stake`) — é o gate.
2. Com a rodada aberta, `ProjectFunding.invest(projectId, amount)` em CREDIT.
3. Se a rodada bater o alvo (all-or-nothing), o rev-share ativa; se vencer sem bater, `refund` devolve 100%.

### Quando posso sacar minha receita?

A qualquer momento, via `ProjectFunding.claim(projectId)` — a receita acumula a cada pagamento processado pelo FeeRouterV2. Exige **manter GOV stakeado no projeto** (skin in the game).

### Perco receita se esquecer de sacar (ou se der unstake)?

**Não.** Claims nunca expiram. Sem GOV stakeado você não consegue sacar, mas o valor fica acruado até você voltar a stakear.

### Por que meu claim é zero?

Possíveis razões:

- A rodada do projeto não está `Funded` (rev-share só ativa depois de bater o alvo).
- O app ainda não processou pagamentos desde o funding (`grossVolumeOf` parado).
- Você já sacou tudo (`NothingToClaim`).
- Você não tem GOV stakeado no projeto (`NoGovStaked` — o acumulado não se perde).

Use `pendingRevenue(projectId, you)` para diagnosticar.

### Quanto vou receber?

`amount × revShareBps/10000 × (suas shares / total de shares)` a cada pagamento. Yield ilustrativo de 14-19% a.a. nos exemplos da doc — depende 100% da receita real do app, não é prometido. Ver [Value accrual](../06-for-investors/02-value-accrual.md).

### E os rewards de emissão antigos?

**Legado.** Claims de rodadas finalizadas do `RewardDistributor` V1/V2 continuam sacáveis indefinidamente (`previewClaim` + `claim`), mas não há novas rodadas de emissão desde o remodel. Detalhe em [Reivindicar rewards](../04-for-users/05-claiming-rewards.md).

## Projetos / Apps

### Como listar meu app?

- Prepare metadata off-chain (IPFS).
- Consiga 10.000 GOV para colateral.
- Alguém com ≥ 10.000 GOV delegados propõe `registerProject` no Governor.
- Após aprovação e execução, `activateProject` (segunda proposta, pode ser batch).

Detalhe em [Submeter um projeto](../05-for-developers/03-submitting-a-project.md).

### Quanto recebo por pagamento?

**97,5%** de cada pagamento, na hora (fee do protocolo: 2,5%). Se o projeto captou rodada no `ProjectFunding`, desconta também o rev-share escolhido (1-30%) — ex.: com rev-share de 8%, você fica com **~89,5%**. Use `feeRouterV2.previewPay(projectId, amount)` para simular. (Legado: no FeeRouter V1 o app recebia só 10% de rebate.)

### Se eu stakar no meu próprio projeto, ganho mais?

Stakar GOV no próprio projeto permite **investir na própria rodada** (e sacar rev-share como qualquer investidor), além de sinalizar convicção. (Legado: no modelo antigo o stake capturava fatia da emissão por burn.) Detalhe em [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).

### Como capto capital pro meu app?

Com o projeto Active, chame `ProjectFunding.openRound(projectId, alvo, revShareBps, prazo)`: alvo ≥ 100 CREDIT, rev-share entre 1% e 30%, prazo de 1 a 90 dias. **Uma rodada por projeto** (MVP). All-or-nothing: bateu o alvo → você recebe o captado na hora e o rev-share ativa; venceu sem bater → investidores pegam refund e nada muda pra você. Detalhe em [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md).

### Perco meu colateral se eu sair?

Não, se remoção for sem slash. Proposta `removeProject(id, slash=false, _)` devolve colateral ao owner.

Se remoção com slash (`slash=true`), colateral vai para Treasury.

## Governança

### Quanto de GOV preciso para propor?

10.000 GOV delegados (produção). Ajustável via proposta dentro de `[0, ilimitado]`.

### Quanto tempo leva uma proposta?

~10 dias em produção: 1d delay + 7d votação + 2d timelock.

### Posso cancelar minha proposta?

Sim, enquanto está `Pending` ou `Active`. Após `Succeeded`, precisa proposta contrária.

### Minha proposta foi aprovada mas ninguém queue/execute?

Qualquer um pode chamar `queue` e `execute`. Basta alguém fazer — tipicamente um holder engajado ou o proposer.

### Posso votar por delegação?

Sim. `gov.delegate(trustedAddress)` transfere voting power para quem você confia. Seu balance continua seu.

## Técnico

### Solidity qual versão?

0.8.24 com `viaIR: true`.

### Qual OpenZeppelin?

5.0.2 pinado exato.

### Tem upgrade path?

**Não.** Contratos são imutáveis. Substituição exige deploy novo + migração de roles.

### Tem pause?

**Nos contratos econômicos core (Treasury, tokens, distributor), não** — decisão consciente, qualquer pause da tesouraria seria vetor de captura. **Exceção**: o `LiquidityGauge` (CLP Fase 1.3) é `Pausable`, mas o pause bloqueia apenas ENTRADA de novos stakes — `unstake`/`harvest` seguem operacionais e `emergencyUnstake` é fail-safe sempre (invariante IE10, "não pausar o usuário"). O `pause`/`unpause` do gauge é `GOVERNANCE_ROLE` (Timelock).

### Tem guardian multisig?

**Não no v1.** Timelock é self-administered. `CANCELLER_ROLE` é só do Governor (cancel via proposta). Guardian multisig pode ser adicionado em futura proposta da DAO.

### Há um bug bounty?

Previsto via Immunefi logo após mainnet. Faixa critical: $50k-$250k.

### Como testar localmente?

```bash
npm install
npx hardhat node                       # terminal 1
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost                  # terminal 2
```

Detalhe em [Ambiente local](../05-for-developers/05-local-dev.md).

---

**Próximo →** [Recursos](02-resources.md)
