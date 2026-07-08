# Riscos e segurança

**Para quem é:** quem precisa avaliar vetores de risco antes de qualquer exposição.
**Pré-requisitos:** [Value accrual](02-value-accrual.md).

> **Aviso**: a lista abaixo descreve riscos **conhecidos** e mitigações implementadas. Nenhum protocolo é imune a bugs, ataques imprevistos ou mudanças regulatórias. Leia e tome decisão informada.

> **Remodel 2026-07-08**: o perfil de risco mudou com o modelo novo. Riscos centrais agora: **receita do app** (rev-share para se o app não vende), **peg/lastro do PSM** e **regulatório** (rev-share se aproxima de security). Riscos do trilho antigo (wash-burn, emissão, floor/FFP) estão marcados como legado.

## Riscos do modelo vigente (remodel)

### Risco: receita do app (o principal risco do investidor)

**Descrição**: o retorno do investidor no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) é 100% dependente da **receita real do app**. Se o app não vende, o rev-share simplesmente **para** — não há piso, não há emissão compensatória, não há dívida acumulando a seu favor. O capital investido numa rodada Funded não é devolvido: o que se compra é o fluxo futuro de rev-share.

**Mitigação**:

- All-or-nothing: rodada que não bate o alvo devolve 100% (`refund`).
- Métricas on-chain para due diligence **antes** de investir: `grossVolumeOf` (GMV histórico), `totalRevenueDistributed` (receita já paga), eventos `PaymentRouted`.
- Gate de GOV stakeado: quem investe já tem exposição de longo prazo ao projeto (curadoria com skin in the game).
- Bounds duros: rev-share 1-30% (100-3000 bps), prazo 1-90 dias, alvo mínimo `minTarget`.

**Risco residual**: alto por natureza — é risco de negócio, não de contrato. Projeto que morre não paga nada. Dimensione a exposição como faria em revenue-based financing.

### Risco: peg/lastro do PSM

**Descrição**: o CREDIT vale 1 USDC porque o [CreditPSM](../08-contracts-reference/15-CreditPSM.md) garante resgate 1:1 contra o lastro retido. Vetores: (a) bug no PSM que permita drenar o lastro; (b) depeg do próprio USDC; (c) `sell` maior que o lastro disponível.

**Mitigação**:

- Lastro 100% retido no contrato, **sem função de saque** — nem governança move (invariante I-PSM1: `backingNormalized() >= mintedOutstanding`, verificável por qualquer um a qualquer momento).
- PSM sem owner, sem roles próprias, sem parâmetros ajustáveis — superfície administrativa zero.
- Conversão exata 1:1 nos dois sentidos, sem taxa; `sell` acima do lastro reverte com `InsufficientBacking` em vez de pagar parcial.

**Risco residual**: depeg do USDC (o CREDIT herda o risco da stable de lastro) e bug de contrato não coberto por testes/auditoria. `mintedOutstanding` é estimativa conservadora — o lastro verificável é sempre `backing()`.

## Riscos de protocolo

### Risco: bug em contrato

**Descrição**: um bug em qualquer um dos 15 contratos de produção pode resultar em perda de fundos, falha de governança ou quebra de invariantes econômicas.

**Mitigação**:

- Código baseado em OpenZeppelin 5.0.2 (pinado exato).
- `ReentrancyGuard` em toda função state-changing que move valor.
- SafeERC20 / SafeCast em todas as conversões.
- Custom errors em todos os reverts (economia de gas + mensagens claras).
- Slither 0.11.5 como análise estática (`audit/slither/`). Sem findings high/medium no código do projeto no momento do deploy.
- 858 testes (suite completa verde) com cobertura extensiva.
- **Auditoria externa obrigatória antes de mainnet** (Trail of Bits, OpenZeppelin ou similar).

**Risco residual**: bugs sutis que testes + análise estática não pegam. Auditoria externa reduz mas não elimina.

### Risco: captura de governança

**Descrição**: um ator acumula GOV suficiente para aprovar propostas maliciosas (drenar Treasury, mudar splits para benefício próprio, etc.).

**Mitigações**:

- `proposalThreshold = 10.000 GOV` (0.01% do cap) previne spam, não captura direta.
- `quorum = 4%` do supply requer participação mínima real.
- `timelockMinDelay = 2 dias` dá janela de resposta para holders verem proposta maliciosa e agirem.
- `votingPeriod = 7 dias` permite discussão off-chain.
- Execução é permissionless após delay — qualquer holder pode bloquear via proposta contrária antes da execução.
- **Supermaioria de 75% on-chain** (`ProposalType.Supermajority` no `CommunityGovernor`): qualquer proposta contendo `Treasury.removePOL` — ou gestão de roles (`grantRole`/`revokeRole`/`renounceRole`) com target no Treasury ou no próprio Timelock — só passa com `forVotes >= 3 × againstVotes`. Fecha o vetor de drenar a liquidez protocolar (POL) por maioria simples, inclusive o bypass de re-autorizar roles.
- **Segregação on-chain de saldos reservados no Treasury**: `transfer`/`batchTransfer`/`payRebates` de CREDIT não podem invadir `polRefillBucket + pendingGaugeRewards` (revertem com `TransferExceedsUnreservedCredit`), e depósitos nesses ledgers exigem lastro real em CREDIT (`DepositExceedsCreditBalance`). No `LiquidityGauge`, `governanceRescueRewards` é limitado ao saldo não-reservado (`totalVestingLocked` protege o vesting de usuários).

**Risco residual**: se um ator acumulou muito GOV (via venda pública mal distribuída ou via compra agressiva em DEX), pode forçar propostas mesmo com quorum. A mitigação é **distribuição inicial bem feita** (via propostas da DAO escolhendo buckets adequadamente — ver [Tokenomics](01-tokenomics.md)).

### Risco: flash-loan attack no voto

**Descrição**: atacante toma empréstimo gigante de GOV, vota numa proposta favorável a si, devolve o empréstimo no mesmo bloco.

**Mitigação**:

- `GovernanceToken` herda `ERC20Votes`. Voting power é lida via `getPastVotes(account, snapshotBlock)` — bloco passado. Flash-loan devolve no mesmo bloco em que pegou, então **não afeta** bloco anterior.
- `votingDelay = 1 dia` afasta o snapshot do bloco atual.

**Risco residual**: muito baixo. O mecanismo é padrão da OZ e amplamente testado.

### Risco: flash-loan attack no reward

**Descrição**: atacante stake grande imediatamente antes de `finalizeRound` para capturar share.

**Mitigação**:

- `Staking` mantém checkpoints históricos (`Checkpoints.Trace208`).
- `RewardDistributor._calculateClaim` usa `Staking.getWeightAt(user, projectId, snapshotBlock)` — peso **antes** do `finalizeRound`.
- Flash-loan não consegue manter posição em bloco anterior.

**Risco residual**: muito baixo. Análogo direto da proteção de governança, validado em testes.

### Risco: wash-burn para capturar share (legado)

> ⚠️ **LEGADO** — este vetor pertence ao trilho burn-to-mint pré-remodel. Sem emissão nova, o wash-burn perdeu o alvo. (No modelo vigente, o análogo seria wash-trading de GMV para inflar métricas de uma rodada de funding — mitigado pelo custo real: cada `pay` paga 2,5% de fee + rev-share.)

**Descrição**: um projeto malicioso queima volume grande de CREDIT que ele mesmo cunhou (via alguma via externa) para capturar share desproporcional na emissão.

**Mitigação**:

- Sanity cap por `(rodada, projeto)` no `BurnTracker`. Default produção: 10M CREDIT por projeto por rodada. Tentativa acima reverte com `SanityCapExceeded`.
- Cap total por rodada (`capMax` no `RewardDistributor`): 5M CREDIT em produção. Mesmo se o atacante queimar dentro do sanity cap, a emissão total fica clampada.
- Probation penalty (25% da share) para projetos novos.

**Risco residual**: um ator com **acesso a muito CREDIT real** (não auto-cunhado — ex.: comprou em DEX) pode gastar esse CREDIT para inflar o burn de um projeto cooptado. Mas isso **não é ataque** — é uso legítimo do protocolo (alguém pagou caro por aquilo).

### Risco: projeto cooptado após listagem

**Descrição**: projeto aprovado legitimamente é hackeado / owner comprometido / equipe some com colateral.

**Mitigações**:

- Colateral em GOV (10k) fica no Registry até `removeProject`. Se comprometido, DAO aprova `removeProject(id, slash=true, treasury)` — colateral vai para Treasury.
- Apps perdem `RECORDER_ROLE` (se tinham) via `revokeRole` quando o projeto vira `Probation` ou `Removed` — via proposta.
- `isActive(projectId)` no `FeeRouter.pay` e `BurnTracker.burnAndRecord` bloqueia novos pagamentos assim que status muda.

**Risco residual**: tempo entre o comprometimento e a execução da proposta (mínimo ~10 dias = votingDelay ~1d + votingPeriod ~7d + timelockMinDelay 2d). Durante esse tempo, usuários podem ainda pagar no projeto. Mitigação operacional: monitoramento ativo + propostas de emergência (meta-propostas com voto rápido via quorum reduzido não implementadas no v1, mas discutíveis em futuro).

### Risco: ETH travado indevidamente no Treasury

**Descrição**: ETH enviado ao Treasury para o qual não há proposta de uso.

**Mitigação**: `sweepETH` é governance-gated. DAO pode sempre sacar via proposta.

**Risco residual**: apenas tempo — se a DAO perde engajamento, fundos ficam presos.

### Risco: CREDIT sem liquidez em DEX (legado)

> ⚠️ **LEGADO** — com o PSM, a saída primária do CREDIT é o resgate 1:1 no próprio contrato, sem depender de liquidez de DEX. O risco de conversão migrou para "peg/lastro do PSM" (acima). POL e pool CREDIT/USDC ficam como legado do pivot CLP.

**Descrição**: usuário recebe CREDIT como reward mas não consegue converter (baixa liquidez em DEX externa).

**Mitigação**: o Treasury tem mecanismo on-chain de **POL (Protocol Owned Liquidity, Fase 1.2)**: `addPOL`/`addPOLFromRefill` provisionam liquidez CREDIT/USDC (Uniswap V3, range full) com a posição NFT custodiada no próprio Treasury; toda saída (`removePOL`) exige proposta com **supermaioria 75%** no Governor.

## Riscos de operação

### Risco: deployer comprometido antes do handoff

**Descrição**: durante o deploy inicial, o deployer tem controle temporário de todos os contratos. Se comprometido antes de transferir roles ao Timelock, pode drenar fundos.

**Mitigação**:

- Deploy via Ignition em transação batched.
- Handoff automatizado no módulo `Dao.ts` — transfere roles e renuncia admin na mesma sequência.
- Documentação rigorosa em [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

**Risco residual**: janela curta durante a execução do script. Mitigação operacional: deploy feito a partir de hardware seguro, com revisão do tx batch antes de submeter.

### Risco: primeiro `acceptOwnership` não acontece

**Descrição**: após o deploy, o Timelock é `pendingOwner` do GovernanceToken mas ainda não aceitou. Quem pode mintar GOV é o deployer. Se o deployer some sem mintar distribuição inicial via proposta aceita pelo Timelock, a DAO nasce morta.

**Mitigação**:

- Procedimento de bootstrap documentado em [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).
- Primeira proposta obrigatória deve ser `GovernanceToken.acceptOwnership()` pelo Timelock.

**Risco residual**: erro humano. Mitigação: procedimento checklist + revisão multi-sig + teste end-to-end prévio em testnet.

### Risco: má configuração de parâmetros

**Descrição**: DAO aprova mudança de parâmetro (α, capMax, etc.) que causa patologia econômica.

**Mitigação**:

- Bounds hardcoded em todos os setters. Ex: `alpha` só aceita `[0.5, 0.99]` (reduzido de `[0.5, 1.1]` — ver `audit/economist/2026-04-22-consistency-audit.md` C2, para garantir IE1 α<1 permanente por construção); valores fora revertem com `InvalidAlpha`.
- Mudanças passam por 7 dias de voto + 2 dias de delay — tempo para discussão e reversão.

**Risco residual**: dentro dos bounds, a DAO pode fazer mudanças controversas. É característica de DAO, não bug.

## Riscos externos

### Risco regulatório

**Descrição**: três frentes distintas no modelo vigente:

1. **Rev-share ≈ security**: o direito a fatia da receita futura de um projeto, comprado com expectativa de lucro pelo esforço de terceiros, **se aproxima da definição de security** (teste de Howey e análogos). É o risco regulatório mais sério do remodel.
2. **CREDIT como stablecoin**: um token estável 1:1 lastreado em USDC pode cair em regimes de stablecoin regulada (MiCA, legislação dos EUA), com requisitos de emissor/reserva que um protocolo imutável não cumpre da forma tradicional.
3. **GOV**: classificação como security pela via clássica de token de governança com buyback.

**Mitigação**:

- **Parecer jurídico formal está PENDENTE e é bloqueador pré-mainnet** — nenhum deploy em mainnet antes dessa análise por jurisdição.
- Rev-share é limitado (1-30%), atrelado a receita real (não a promessa de valorização), e o investimento exige participação ativa (GOV stakeado = curadoria).
- Lastro do PSM 100% on-chain e verificável — transparência acima do padrão de emissores centralizados.
- Não há emissor central identificável pós-handoff da governança.

**Risco residual**: significativo e não eliminável no nível do protocolo. A classificação pode variar por jurisdição e mudar com o tempo. Usuários devem avaliar suas próprias jurisdições.

### Risco de integração DEX externa

**Descrição**: o GOV depende de DEX externas para liquidez. Se DEX sofre hack, listagem é removida, pool drenado, etc., holders perdem acesso a conversão. (Para CREDIT esse risco é legado — a conversão primária é o resgate 1:1 no PSM.)

**Mitigação**: diversificação de DEXs via ações da DAO. Não está implementado no v1.

### Risco de oracle (buyback FFP) (legado)

> ⚠️ **LEGADO** — o buyback FFP de CREDIT e a defesa de floor pertencem ao pivot CLP pré-remodel. Com CREDIT estável via PSM, não há floor a defender. O buyback vigente é o de **GOV** (40% da fee do FeeRouterV2), que não depende de oracle.

**Descrição**: `executeBuyback` é **real** (Fase 1.1 do pivot CLP): swap USDC → CREDIT via Uniswap V3 + queima imediata do CREDIT comprado. Depende do `CreditPriceOracle` (adapter imutável: TWAP da pool Uniswap V3 CREDIT/USDC + sanidade Chainlink USDC/USD). Oracle manipulado ou pool rasa podem induzir buyback a preço ruim.

**Mitigação** (tudo on-chain, no `Treasury` e no adapter):

- Preço é TWAP (janela default 30 min, bounds [5min, 2h]) — manipulação de spot instantâneo não basta.
- Sanidade Chainlink USDC/USD: staleness máxima 6h + banda [0.99, 1.01] — depeg do USDC bloqueia buyback (`UsdcDepegDetected`).
- Buyback só é elegível com spot abaixo do floor por >= `triggerDurationSecs` (default 24h) e é capado: 20% das reservas por evento, 30% do snapshot mensal (defaults; ajustáveis dentro de bounds).
- `minCreditOut` (slippage) obrigatório; cada execução exige proposta DAO (GOVERNANCE_ROLE = Timelock).
- Adapter sem owner/setters — trocar parâmetros de oracle exige novo deploy + `setPriceOracle` via proposta.

**Risco residual**: manipulação sustentada de TWAP em pool com pouca liquidez ao longo da janela inteira. Mitigação operacional: POL (liquidez protocolar) profunda + monitoramento.

## Riscos para investidores especificamente

- **Imobilização do GOV**: lock de 14-365+ dias. Se você precisar do GOV antes, só sai se o projeto virar `Removed`.
- **Capital da rodada não volta**: em rodada Funded, o que você comprou é o fluxo de rev-share — não há resgate do principal.
- **Dependência do projeto escolhido**: se seu app não vende, rev-share = 0. Sem piso, sem compensação.
- **Gate de claim**: sacar rev-share exige manter GOV stakeado no projeto. Sem stake, o valor fica retido (não expira) até você re-stakear.
- **Dependência do ecossistema**: mesmo investindo num projeto exemplar, se o hub agregado não atrai usuários, GMV encolhe para todos.

## Riscos para apps listados

- **Colateral lockado**: 10.000 GOV no Registry. Só volta com `removeProject` sem slash.
- **Suspensão por governança**: `Probation` punitiva bloqueia operação (mas não queima colateral).
- **Slash**: se má conduta comprovada, `removeProject(id, slash=true)` envia colateral para Treasury.
- **Custo do trilho**: fee de 2,5% (250 bps; teto duro 500) + rev-share da rodada, se você captou (1-30%). Você recebe ~89,5-97,5% de cada pagamento, na hora.
- **Rev-share é perpétuo no MVP**: a rodada Funded não tem prazo de encerramento do rev-share — a fatia incide sobre toda a receita futura roteada pelo FeeRouterV2.
- **Uso baixo**: se seu app não atrai usuários, não há receita — e uma rodada de funding aberta tende a falhar (refund aos investidores).

## Auditoria e bounty

Antes de mainnet:

- Auditoria externa por firma reconhecida (Trail of Bits, OpenZeppelin, Certik ou similar).
- Bug bounty via Immunefi logo após mainnet.
- Monitoramento on-chain (Forta / Tenderly) para eventos críticos: `CapExceeded`, `SanityCapExceeded`, `RoundClosed.earlyClose=true`, saídas grandes do Treasury.

Status atual no repositório:

- Slither sem findings high/medium no código do projeto.
- Suite de testes com 858 testes passando (0 falhas).
- **Auditoria externa ainda não realizada** no momento desta doc.

## Resumo

O protocolo tem múltiplas salvaguardas on-chain e off-chain. Nenhuma elimina risco totalmente. Exposição a GOV, CREDIT ou rodadas de funding implica:

- Risco de contrato (bug).
- Risco de receita (rev-share depende 100% das vendas do app).
- Risco de peg/lastro (PSM herda o risco do USDC).
- Risco de governança (mudanças adversas via proposta).
- Risco de mercado (liquidez do GOV).
- Risco regulatório (rev-share ≈ security; parecer jurídico pendente pré-mainnet).

Avalie antes de qualquer exposição. Comece pequeno. Entenda o lock e o all-or-nothing antes de investir.

---

**Próximo →** [Métricas que importam](04-metrics-that-matter.md)
