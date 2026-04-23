# Riscos e segurança

**Para quem é:** quem precisa avaliar vetores de risco antes de qualquer exposição.
**Pré-requisitos:** [Value accrual](02-value-accrual.md).

> **Aviso**: a lista abaixo descreve riscos **conhecidos** e mitigações implementadas. Nenhum protocolo é imune a bugs, ataques imprevistos ou mudanças regulatórias. Leia e tome decisão informada.

## Riscos de protocolo

### Risco: bug em contrato

**Descrição**: um bug em qualquer um dos 12 contratos pode resultar em perda de fundos, falha de governança ou quebra de invariantes econômicas.

**Mitigação**:

- Código baseado em OpenZeppelin 5.0.2 (pinado exato).
- `ReentrancyGuard` em toda função state-changing que move valor.
- SafeERC20 / SafeCast em todas as conversões.
- Custom errors em todos os reverts (economia de gas + mensagens claras).
- Slither 0.11.5 como análise estática (`audit/slither/`). Sem findings high/medium no código do projeto no momento do deploy.
- 462+ testes com 100% stmts coverage e 99.84% lines.
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

### Risco: wash-burn para capturar share

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

**Risco residual**: tempo entre o comprometimento e a execução da proposta (mínimo ~8 dias = votingDelay + period + minDelay). Durante esse tempo, usuários podem ainda pagar no projeto. Mitigação operacional: monitoramento ativo + propostas de emergência (meta-propostas com voto rápido via quorum reduzido não implementadas no v1, mas discutíveis em futuro).

### Risco: ETH travado indevidamente no Treasury

**Descrição**: ETH enviado ao Treasury para o qual não há proposta de uso.

**Mitigação**: `sweepETH` é governance-gated. DAO pode sempre sacar via proposta.

**Risco residual**: apenas tempo — se a DAO perde engajamento, fundos ficam presos.

### Risco: CREDIT sem liquidez em DEX

**Descrição**: usuário recebe CREDIT como reward mas não consegue converter (baixa liquidez em DEX externa).

**Mitigação**: **fora do protocolo**. A DAO pode aprovar uso do Treasury para seed de liquidez em DEX. O próprio bucket "10% liquidity" da distribuição inicial é para isso.

**Risco residual**: se DEXs abandonarem o pool, usuários ficam presos ao CREDIT. Solução depende de ação da DAO + mercado externo.

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

**Descrição**: classificação de GOV ou CREDIT como security, stablecoin regulada ou outra categoria com requisitos que o protocolo não cumpre.

**Mitigação**:

- Tokens não prometem retorno financeiro.
- Não há emissor central identificável pós-handoff da governança.
- DAO pode evoluir termos ou aspectos não-contratuais conforme marcos regulatórios se consolidarem.

**Risco residual**: significativo e não eliminável no nível do protocolo. Usuários devem avaliar suas próprias jurisdições.

### Risco de integração DEX externa

**Descrição**: o protocolo depende de DEX externas para liquidez do CREDIT (e eventualmente GOV). Se DEX sofre hack, listagem é removida, pool drenado, etc., usuários perdem acesso a conversão.

**Mitigação**: diversificação de DEXs via ações da DAO. Não está implementado no v1.

### Risco de oracle (aplicação futura)

**Descrição**: quando integração DEX real do `executeBuyback` for implementada, haverá dependência de price oracle / TWAP / slippage protection.

**Mitigação**: design detalhado será auditado antes da implementação. No v1, `executeBuyback` é stub — só emite evento, não executa swap.

## Riscos para stakers especificamente

- **Imobilização**: lock de 14-365+ dias. Se você precisar do GOV antes, só sai se o projeto virar `Removed`.
- **Dependência do projeto escolhido**: se seu projeto não gera burn, seu reward = 0.
- **Dependência do ecossistema**: mesmo stakando em um projeto exemplar, se o ecossistema agregado não gera uso, emissão cai.
- **Volatilidade do CREDIT**: seu reward é em CREDIT. Se CREDIT não tem liquidez ou desvaloriza, reward em termos reais diminui.

## Riscos para apps listados

- **Colateral lockado**: 10.000 GOV no Registry. Só volta com `removeProject` sem slash.
- **Suspensão por governança**: `Probation` punitiva bloqueia operação (mas não queima colateral).
- **Slash**: se má conduta comprovada, `removeProject(id, slash=true)` envia colateral para Treasury.
- **Dependência do split**: 95% de cada pagamento é queimado. Você recebe 5% direto + (opcional, via stake) fatia da emissão.
- **Uso baixo**: se seu app não atrai usuários, burn do seu projeto é baixo, share da emissão também.

## Auditoria e bounty

Antes de mainnet:

- Auditoria externa por firma reconhecida (Trail of Bits, OpenZeppelin, Certik ou similar).
- Bug bounty via Immunefi logo após mainnet.
- Monitoramento on-chain (Forta / Tenderly) para eventos críticos: `CapExceeded`, `SanityCapExceeded`, `RoundClosed.earlyClose=true`, saídas grandes do Treasury.

Status atual no repositório:

- Slither sem findings high/medium no código do projeto.
- Suite de testes 462+ testes com cobertura extensiva.
- **Auditoria externa ainda não realizada** no momento desta doc.

## Resumo

O protocolo tem múltiplas salvaguardas on-chain e off-chain. Nenhuma elimina risco totalmente. Exposição a GOV ou CREDIT implica:

- Risco de contrato (bug).
- Risco econômico (modelo pode não decolar).
- Risco de governança (mudanças adversas via proposta).
- Risco de mercado (liquidez, volatilidade).
- Risco regulatório (jurisdição do usuário).

Avalie antes de qualquer exposição. Comece pequeno. Entenda o lock antes de stakar.

---

**Próximo →** [Métricas que importam](04-metrics-that-matter.md)
