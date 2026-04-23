# Parecer econômico: auditoria de consistência código ↔ documentação web3community

**Modo**: A (revisão geral de saúde + consistência docs)
**Data**: 2026-04-22
**Analista**: dao-economist

## 1. Resumo executivo

- **Contagem incorreta de contratos em múltiplos lugares-chave.** README diz "10 contratos" em 3 pontos (título seção 1, seção 4, NatSpec de `Dao.ts`), mas o repo tem **12 contratos** (`TeamVesting.sol` e `UserSubsidy.sol` estão em `contracts/`, deployados por módulos Ignition separados, com docs próprios 11-TeamVesting.md / 12-UserSubsidy.md). Isso faz com que o mapa conceitual do README exclua contratos críticos de custódia e distribuição.
- **Erro matemático grosseiro no README sobre supply de CREDIT.** README linha 276 mostra "Round 0: 70.0M (genesis)" dentro do bloco que descreve deflação; genesis real é **10M** (corretamente citado na linha 303 do próprio README, em todos os docs e no código `mintGenesis`). Os 70.4M do relatório de simulação só existem porque o script artificialmente dá 60M para "Charlie" usando `MINTER_ROLE` concedido ao Timelock no teste — não é supply operacional.
- **Faixa de α permite valor inflacionário (MAX_ALPHA = 1.1)** — tanto o código quanto os docs admitem `α ∈ [0.5, 1.1]`. Acima de 1.0 é inflação líquida (emissão > burn), contradizendo a narrativa de "levemente deflacionário" em todo o material. Não é discrepância doc-código, é **decisão econômica fraca permitida por construção**. Viola IE1.
- **`executeBuyback` é stub em v1 e documentado como tal, porém a função apresenta 4 risco-sombra**: (1) não há receita recorrente no Treasury (split default 0% treasury + buyback stub + apenas slash/doações como entradas), (2) docs prometem funcionalidade sem timeline, (3) sem `nonReentrant` real útil já que nada é movido, (4) `swapData` opaco cria black-box para workers off-chain manipularem a intenção sem garantia de parâmetros. **Lacuna estrutural** — não é bug, é design incompleto.
- **Ausência total de plano de vesting para investidores**, floor decay perpétuo para equipe e documentação de distribuição 30/25/20/15/10 como "intenção de proposta". Isso é aceitável, mas o README sugere que está "pronto para deploy Sepolia pós-auditoria externa" — em mainnet com essa incerteza de distribuição, é captura inicial via primeira proposta.

---

## 2. Lista completa de discrepâncias

### CRÍTICA (risco econômico ou invariante quebrada)

#### C1. README diz supply genesis de CREDIT é 70M (erro factual grosseiro)

- **Código**: `contracts/CreditToken.sol:119-132` — `mintGenesis(to, amount)` é one-shot. `ignition/parameters/production.json:55` — `"genesisAmount": "10000000000000000000000000"` = 10M CREDIT.
- **Doc**: `README.md:274-280` exibe tabela:
  ```
  Round 0:  70.0M  (genesis)
  Round 10: 69.3M
  ...
  ```
- **Delta**: genesis real é **10M**, não 70M. O número 70M vem do output do simulador (`scripts/simulation/output/report.md`), onde `Charlie_seed = 60_000_000` CREDIT é mintado via atalho de teste (`credit.connect(tlSigner).mint(charlie, 60M)` em `scripts/simulation/economicSim.ts:72, 233`). Essa quantia não existe no caminho de produção.
- **Consequência econômica**: qualquer leitor externo (investidor, auditor, app candidato) que faça conta sobre o supply vai errar por fator de 7×. O "delta -3.8%" do supply reportado na simulação é contra 70.4M; contra 10M de genesis operacional, a deflação é **matematicamente diferente** — e a narrativa de APR 34% no staker também se distorce.
- **Correção**: **corrigir o README**. O simulador pode permanecer como está (é teste), mas o README precisa separar "número do simulador" de "modelo operacional real". Sugestão: no bloco, trocar por "Round 0: 10.0M (genesis, antes de qualquer rodada)".

#### C2. MAX_ALPHA permite α ≥ 1 (inflação líquida sem lastro real)

- **Código**: `contracts/RewardDistributor.sol:111` — `MAX_ALPHA = 11e17` (1.1). `setAlpha` aceita valor até 1.1e18.
- **Doc**: `docs/pt-br/06-for-investors/01-tokenomics.md:76` diz "ajustável entre `[0.5, 1.1]`". `docs/pt-br/02-core-concepts/03-burn-to-mint.md:19` afirma "sistema é projetado para que **emissão total < burn total** se o uso se mantiver constante". `README.md:272` diz "**emite-se um pouco menos do que foi queimado**".
- **Delta**: contrato permite α > 1 (emissão > burn). Narrativa de toda a documentação econômica é deflacionária. Uma governança capturada pode votar α = 1.1 legitimamente e transformar o protocolo em inflacionário via caminho de governança normal, sem violar nenhuma invariante dura.
- **Violação**: IE1 (α < 1 permanente). Esta é **invariante econômica**, não de código — mas o contrato não a enforça.
- **Correção**: recomendação dao-economist firme — **reduzir MAX_ALPHA para 0.99e18**. Alternativa aceitável: manter em 1.1 mas documentar explicitamente em todo lugar que "a DAO pode decidir inflacionar CREDIT via proposta", o que é incompatível com o posicionamento "não é Ponzi" de `docs/pt-br/02-core-concepts/03-burn-to-mint.md`. Requer votação antes de mainnet.

#### C3. `Dao.ts` do Ignition descreve fase de deploy como "10 contratos" mas deploya apenas 10 deles; `TeamVesting` e `UserSubsidy` ficam OUT do deploy principal

- **Código**: `ignition/modules/Dao.ts:40-41` diz "Fase A: deploy de todos os 10 contratos". `ignition/modules/` tem módulos separados `TeamVesting.ts` e `UserSubsidy.ts`.
- **Delta**: em mainnet, quem deploya só `Dao.ts` **não tem `TeamVesting` nem `UserSubsidy`** — o Treasury fica com 10M CREDIT sem instrumento de vesting ou subsídio para usuários. Para atingir a distribuição 30/25/20/15/10 de GOV descrita nos docs (que pressupõe vesting da equipe), é preciso deploy adicional manual de N instâncias de `TeamVesting` + `UserSubsidy`, cada um em proposta separada.
- **Risco econômico**: período entre deploy e primeira proposta de distribuição é **janela de captura** — owner do GOV é Timelock em `pendingOwner`, `acceptOwnership` é "primeira proposta obrigatória" mas o deployer ainda controla a janela se não seguir rigor operacional (detalhado em `docs/pt-br/09-advanced/02-mainnet-deployment.md`).
- **Correção**: documentar em `README.md` seção 7 que vesting e subsídio exigem deploy adicional; OU incluir no `Dao.ts` o deploy dos dois contratos complementares com placeholders que a DAO substitui via governança.

#### C4. Treasury não tem caminho de receita recorrente (split default 0% treasury)

- **Código**: `ignition/parameters/production.json:46-48` — `"treasuryBps": 0`. `contracts/Treasury.sol:266-279` — `executeBuyback` é stub. `contracts/Treasury.sol:37-40` natspec admite "NÃO executa swap".
- **Doc**: `docs/pt-br/02-core-concepts/07-treasury-and-fees.md:14-20` lista 5 fontes de entrada do Treasury: genesis, treasuryBps (0 por default!), slash, UserSubsidy refund, "doações/buyback". **Nenhuma é recorrente**.
- **Delta econômico**: Treasury não tem cash flow operacional. Para executar buyback real (quando DEX integrar), precisa ter stables; não há como adquirir stables de forma recorrente. Apenas via proposta `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})`, que docs sugerem ("`setDefaultSplit({...500...500})` — a arquitetura permite"), mas isso NUNCA é explicitado como "necessidade para sustentar buyback".
- **Violação**: IE7 parcial — buyback com Treasury exige orçamento dimensionado; aqui nem orçamento existe.
- **Correção**: **adicionar ao README seção 7** que buyback real é dependente de `setDefaultSplit` ativando treasuryBps > 0 — ou de doações externas. Recomendação: preparar proposta #2 (após `acceptOwnership`) que mude split para `(9000, 500, 500)` ou similar para bootstrap de tesouraria. Essa proposta precisa estar documentada em `docs/pt-br/09-advanced/02-mainnet-deployment.md`.

---

### ALTA (docs mentem sobre parâmetros ou fluxos críticos)

#### A1. "README §4: Os 10 contratos" esconde os 12 reais

- **Código**: 12 arquivos .sol em `contracts/`.
- **Doc**: `README.md:298-312` tabela "Os 10 contratos". Outras referências a "10 contratos" no README: linha 11 ("organismo com 10 órgãos") e mapa visual linhas 13-54 omite TeamVesting/UserSubsidy.
- **Doc interna divergente**: `docs/pt-br/08-contracts-reference/` tem 12 entradas (01-12), incluindo TeamVesting.md e UserSubsidy.md. Mapa de `docs/pt-br/03-protocol-overview/01-architecture.md:55-62` menciona os 2 contratos auxiliares corretamente.
- **Delta**: README é a porta de entrada. Leitor que para no README (maioria dos auditores externos, investidores, novos devs) **não sabe** que existem 2 contratos adicionais que movem GOV (TeamVesting) e CREDIT (UserSubsidy). Impacto maior em risk assessment externo.
- **Correção**: atualizar `README.md` seção 4 para 12 contratos + atualizar mapa ASCII seção 1.

#### A2. Docs de tokenomics tratam distribuição 30/25/20/15/10 como se fosse fato; é só intenção

- **Código**: nada é automatizado. `GovernanceToken` nasce com supply 0. `Dao.ts` só faz `transferOwnership(timelock)` sem mintar.
- **Doc**: `docs/pt-br/06-for-investors/01-tokenomics.md:22-33` apresenta a tabela 30/25/20/15/10 e diz "Esses valores são intenção de proposta, não programação automática" na L33 — OK. Mas `README.md:352` ordena "Propostas de distribuição de GOV via Governor" como etapa #4 de próximos passos, sem explicar que hoje não há **nenhum** GOV distribuído e que o 100% dos 100M fica no Timelock assim que a primeira proposta de `acceptOwnership` + `mint` executar.
- **Doc reforça a confusão**: `docs/pt-br/02-core-concepts/01-dual-token-economy.md:28` diz "A alocação completa (treasury, equipe via `TeamVesting`, venda pública, community rewards, liquidez) acontece em propostas separadas" — mas novamente sem alertar que **nada está implementado pro sale/liquidez/community rewards no repo atual**.
- **Delta**: nenhum contrato de `Sale`, nenhum mecanismo de `LiquidityBootstrappingPool`, nenhum `LPRewards`. O texto dá a impressão que "basta a DAO votar" — mas a DAO vota `mint(to, amount)` puro, que transfere GOV para uma EOA/contrato arbitrário que **ainda precisa ser desenhado/deployado**.
- **Violação**: parcial de IE9 (concentração). Antes das propostas de distribuição, Timelock detém poder de mintar 100M para qualquer endereço via proposta única. Com threshold 10k GOV (0.01%), se alguém conseguir 10k GOV na primeira distribuição, pode tentar propor mint abusivo — mitigável por quorum 4%, mas o quorum é sobre **supply já mintado**.
- **Correção**: seção de README sobre próximos passos antes de mainnet deve listar: "propostas ordenadas: (1) acceptOwnership, (2) mint bucket Treasury 30M, (3) deploy TeamVesting × N + mint 25M, (4) deploy Sale + mint 20M, (5) deploy UserSubsidy funding + mint 15M community via CREDIT, (6) transferir 10M para LP inicial em DEX". E documentar quais desses contratos (Sale, LP, LiquidityMining) **ainda não existem**.

#### A3. Docs dizem "deflação garantida por α = 0.95" — mas omitem que supply de CREDIT em circulação inclui 60M do simulador, não 10M do genesis real

- **Código**: simulação usa `Charlie_seed = 60_000_000 * 1e18` (`scripts/simulation/economicSim.ts:72`).
- **Doc**: `README.md:282` afirma "Simulação de 52 rodadas confirmou: **supply cai 3.8%**, APR nominal do staker estabiliza em ~34% em CREDIT". `docs/pt-br/02-core-concepts/03-burn-to-mint.md:28` repete "supply cai ~3.8% nas 52 rodadas" e `docs/pt-br/06-for-investors/02-value-accrual.md:41` idem.
- **Delta**: os 3.8% são a queda do supply **inflado** pelo simulador (70.4M → 67.7M). Em produção, o supply total antes da primeira rodada é 10M no Treasury + qualquer mint subsequente de reward. O cenário "uso estável com 1M burn/round" do simulador é inviável operacionalmente em mainnet antes do Treasury distribuir CREDIT para usuários via `UserSubsidy`, compra em DEX (que não existe ainda), etc.
- **Violação**: narrativa informativa, não invariante. Mas dirige expectativas de staker sobre APR.
- **Correção**: docs devem dizer "simulação modela um cenário hipotético com 70M de supply e 1M burn/round; valores absolutos não prometem comportamento de mainnet. A dinâmica qualitativa (deflação sustentada com uso constante) é o resultado relevante".

#### A4. Staking doc diz "lock máximo 365 dias" — código aceita qualquer valor, apenas multiplier satura

- **Código**: `contracts/Staking.sol:99-101` — `MAX_LOCK = 365 days` é o **ponto de saturação do multiplier**, não o lock máximo aceito. O comment interno de `stake()` (linha 427) diz "Locks acima de {MAX_LOCK} são aceitos literalmente: o multiplier satura em 4x, mas o tempo real é respeitado na hora do unstake."
- **Doc**: `docs/pt-br/08-contracts-reference/05-Staking.md:10` diz "máximo aceito ilimitado (multiplier satura em 4x a partir de 365 dias)" ✓. MAS `docs/pt-br/02-core-concepts/02-directed-staking.md:29` tabela lista `MAX_LOCK | 365 dias` como se fosse **lock máximo** (depois corrige na L33 "Locks acima de 365 dias **são aceitos**"). `README.md:306` diz "Lock 14d–365d, multiplier 1x–4x" — **esconde** que locks > 365d são aceitos.
- **Delta**: README e tabela podem induzir usuário a acreditar que não pode lockar > 365d. Cenário patológico: usuário quer fazer "veCRV-like" 4 anos (por motivos de alinhamento público com LPs, sinalização) — o contrato aceita, mas README diz que não. O risco é staker fazer lock de 2 anos por engano achando que seria rejeitado.
- **Correção**: atualizar `README.md:306` para "Lock ≥ 14d, multiplier 1x–4x satura em 365d, locks longos aceitos sem cap". Normalizar pt-br/02-core-concepts/02-directed-staking.md adicionando nota clara na tabela.

#### A5. Probation penalty — docs dizem "25% share"; código aplica `share / 4`, que é efetivamente 25%, MAS o comentário econômico é confuso sobre "75% queimados"

- **Código**: `contracts/RewardDistributor.sol:615-618` — `projectShare = projectShare / PROBATION_PENALTY_DENOM` (dividir por 4).
- **Docs**: múltiplos lugares afirmam "75% não são redistribuídos — **simplesmente não são cunhados**" (`README.md:290`, `docs/pt-br/02-core-concepts/03-burn-to-mint.md:60`, `docs/pt-br/02-core-concepts/04-rewards-distribution.md:64`, `docs/pt-br/06-for-investors/01-tokenomics.md:136`).
- **Delta semântico grave**: "queimar" em tokenomics significa `_burn` do token e redução de `totalSupply`. Aqui, nada é queimado porque **nunca foi mintado**. O código computa share, divide por 4, e cunha só esse valor. Dizer "queimado" em tokenomics quando na verdade é "não-cunhado" **induz erro de modelagem mental em auditor econômico**. Alguém planejando contra-fórmulas (ex.: calcular "queima total do ecossistema") vai somar esses 75% ao `burnByRoundProject` — errado.
- **Correção doc**: trocar "75% são queimados" por "75% nunca são mintados" em todos os lugares. No README linha 290 já diz "queimado (não redistribuído)" — trocar para "**não cunhado** (não redistribuído)".

#### A6. Docs e README divergem sobre "estado de produção real" para deploy

- **Código + deploy**: `production.json` tem todos os valores finalizados. `Dao.ts` sabe fazer o handoff completo.
- **Doc**: `README.md:5` afirma "**Status**: 462 testes verdes · coverage 100% stmts / 99.84% lines · slither sem findings high/medium no código do projeto · **pronto para deploy Sepolia pós-auditoria externa**". `README.md:370-377` lista 8 próximos passos antes de mainnet, mas #5 é "Integração DEX real no `Treasury.executeBuyback`" — o que é contradição com o "pronto para deploy Sepolia", porque Treasury sem buyback real em Sepolia ainda tem o risco estrutural descrito em C4.
- **Delta**: afirmar "pronto para Sepolia" antes de resolver C4 e auditoria externa é overpromise. Sepolia é testnet pública — é razoável deployar com stub. Mas não é razoável afirmar "ready" sem asterisco.
- **Correção**: trocar status para "**Status**: testes verdes, simulação econômica cobre 3 cenários, pendências pré-mainnet em README §7".

---

### MÉDIA (docs incompletas em fluxos importantes)

#### M1. Docs não explicam o cenário "rodada sem burn + sem staking global"

- **Código**: `contracts/RewardDistributor.sol:605-611` — se `globalWeight == 0` e `totalBurnPrev == 0`, `_projectShare` retorna 0. A emissão foi calculada via floor mas **nenhum claim resgata**. O CREDIT tecnicamente ainda pode ser cunhado para round seguinte, mas nunca é cunhado porque claim retorna 0.
- **Doc**: `docs/pt-br/02-core-concepts/04-rewards-distribution.md:117` menciona brevemente "Rodada sem burn e sem staking global: emissão acontece (via floor), mas nenhum claim funciona" ✓. Mas na seção Edge cases apenas; README e outras páginas não mencionam.
- **Delta**: o floor inicial de 400k CREDIT no round 0 **nunca é cunhado** se ninguém stakou antes. Isso significa que o "6 meses de floor" é **condicional** a existir stake desde o round 0. Nada nos docs principais reforça isso para o staker.
- **Correção**: adicionar alerta em README §3 "se o protocolo começar sem stakers, o floor não é aproveitado e CREDIT nunca é cunhado — não é bug, é no-op seguro. A DAO precisa coordenar stakers iniciais antes do round 0".

#### M2. Nenhum doc cobre o caminho de quem detém `appRecipient` = `address(0)` após `transferProjectOwnership` concluído

- **Código**: `contracts/FeeRouter.sol:541-547` — se `appRecipient[projectId] == 0`, usa `REGISTRY.getProject(projectId).owner` (lookup dinâmico). Transfer de ownership no Registry passa pelo 2-step; no intervalo entre `transferProjectOwnership` e `acceptProjectOwnership`, o owner **ainda é o antigo**. `setAppRecipient` exige owner atual — isso está certo.
- **Doc**: `docs/pt-br/08-contracts-reference/08-FeeRouter.md:153-154` menciona "Lookup dinâmico" brevemente. **Nenhum** doc alerta que é possível para o owner antigo definir `setAppRecipient(id, maliciousAddr)` **antes** de iniciar a transferência — o novo owner herda o recipient malicioso.
- **Delta**: risco pequeno mas real de ownership hand-off. Mitigação: documentar que o novo owner deve auditar `feeRouter.appRecipient(projectId)` antes de aceitar ownership.
- **Correção**: adicionar seção em `docs/pt-br/02-core-concepts/06-project-whitelist.md` sobre "checklist ao receber ownership de projeto".

#### M3. Docs de Staking não alertam sobre o cenário "projeto que fica em Probation punitiva permanente"

- **Código**: `contracts/Staking.sol:580-651` — unstake em projeto `Probation` exige lock expirado. Se um projeto entra em `Probation` no dia 0 e a DAO nunca executa `reactivate` ou `removeProject`, staker com lock 365d fica preso 365 dias independentemente, e pesos continuam nos checkpoints (emissões ocorrem sem burn do projeto, daí claim = 0, mas GOV fica travado).
- **Doc**: `docs/pt-br/02-core-concepts/04-rewards-distribution.md:104-109` menciona "lock não é bypassed" em Probation punitiva; `docs/pt-br/08-contracts-reference/05-Staking.md:131` repete. Mas **nenhum doc** descreve o cenário cumulativo: projeto vira Probation, stakers recebem 0 de emissão (não é probation inicial, é punitiva — penalty de `isInProbation` NÃO se aplica porque status ≠ Active; mas também não há burn → share = 0), e eles ficam sem opção de sair antes do lock.
- **Delta**: é by-design, mas é *punição desproporcional ao staker* para falha do app/governança. Staker não cometeu má conduta.
- **Violação**: tangencialmente IE5 (captura). Se grande staker fica preso, ele não consegue redelegar ou sair.
- **Correção**: documentar explicitamente "Probation punitiva é decisão da DAO. Stakers ficam presos até lock expirar; para mitigar, DAO pode propor `removeProject` terminal, que bypassa lock". Recomendar como boa prática da DAO: **evitar Probation punitiva de longo prazo**; preferir `removeProject(slash=true)` terminal ou `reactivate` rápido.

#### M4. Docs do RewardDistributor não mencionam que `claim` com `amount == 0` não marca `claimed` — logo staker com peso 0 pode "tentar pra sempre"

- **Código**: `contracts/RewardDistributor.sol:534-537` — se `amount == 0`, retorna 0 sem marcar `claimed`. Gas spent pelo caller, sem efeito.
- **Doc**: `docs/pt-br/08-contracts-reference/07-RewardDistributor.md:156` menciona "no-op silencioso". Mas usuários que entendem parcialmente podem fazer loops de retry inúteis. E `claimMany` no código vai aceitar arrays gigantes com zeros silenciosos.
- **Delta**: vetor de DoS leve (não crítico) onde alguém submete `claimMany` com 1000 entries todas com amount 0 — contrato aceita, gasta gas do caller, mas não marca nada. Não compromete contabilidade.
- **Correção**: adicionar um alerta em `docs/pt-br/05-for-developers/01-integration-overview.md` para UIs: "antes de mostrar claim button, chame `previewClaim` e só permita tx se > 0".

#### M5. Docs não mencionam que `roundStartedAt` pode "drift" — rodadas não têm duração garantida, e `isRoundReadyToClose` é apenas consultivo

- **Código**: `contracts/BurnTracker.sol:393-411` — `closeRound` é governance-gated. Se governança não chama no timing certo, rodada pode durar semanas/meses. `earlyClose` flag no evento captura isso, mas nada **força** close.
- **Doc**: `docs/pt-br/02-core-concepts/04-rewards-distribution.md:16-24` diz "Fim da janela alvo → Governança chama closeRound()". A palavra "alvo" é sutil; não reforça que não é automático.
- **Delta**: se a governança ficar capturada / inativa, a contabilidade do protocolo congela. Stakers esperam "1 rodada = 7 dias" mas na realidade é "1 rodada = quando a DAO decidir".
- **Correção**: adicionar em `docs/pt-br/02-core-concepts/03-burn-to-mint.md` seção "limitação operacional: `closeRound` depende de execução de governança. Se a DAO ficar inativa, rodada não fecha e emissão congela. Recomendação: DAO configurar keeper externo (Gelato/Chainlink Automation) para chamar `closeRound` via proposta periódica — futuro v2".

---

### BAIXA (typos, números levemente desatualizados)

#### B1. `ignition/parameters/production.json:19-43` floor schedule último valor é `16666666666666666682` wei ≈ 16.666 CREDIT; docs dizem `~16.666 CREDIT`

- **Delta**: zero. Esse wei é o valor final do linear decay com arredondamento; docs arredondam corretamente. OK.

#### B2. Simulação menciona "1 round = 7 dias (prod) mas sim roda em 1d (dev)"; APR calculado assume 52 rodadas/ano

- **Código**: `scripts/simulation/economicSim.ts:76-78` — OK, documentado no próprio simulador.
- **Delta**: zero. Reportando só por completude.

#### B3. `README.md:311` afirma "Governor OZ. Voting delay 1d, period 7d, quorum 4%, threshold 10k GOV"

- **Código**: delay 7200 blocos = 1 day @ 12s; period 50400 blocos = 7 days @ 12s. OK.
- **Delta**: zero, mas só se o block time do destino for 12s. Em L2 (Base, Arbitrum, Optimism) block time é 1-2s, o que reduz esses prazos de 1d → ~2.4h e 7d → ~16.8h. Nenhum doc alerta sobre isso.
- **Correção sugerida**: em `docs/pt-br/09-advanced/02-mainnet-deployment.md` adicionar checklist "ajustar voting delay/period conforme block time da chain alvo".

#### B4. Comentário `ignition/modules/Dao.ts:23-27` diz "Soma efetiva ~ 5.2M CREDIT"; cálculo matemático dá **5M**

- **Código**: soma analítica no próprio comment (`9_600_000e18 - 4_600_000e18 = 5_000_000e18`).
- **Doc inline**: primeiro diz "5.2M" depois calcula "5M" e não corrige o primeiro. Minor typo.
- **Correção**: trocar "~5.2M" por "~5M" no comment.

#### B5. Docs usam "168 dias" como "6 meses" para 24 rodadas × 7 dias

- **Cálculo**: 24 × 7 = 168 dias = 5.52 meses, não 6.
- **Doc**: múltiplos lugares arredondam para "6 meses" (`docs/pt-br/06-for-investors/01-tokenomics.md:89`, `docs/pt-br/02-core-concepts/03-burn-to-mint.md:34`, `README.md:286`).
- **Delta**: irrelevante economicamente; só marcação de precisão.

---

## 3. Consistência entre traduções (pt-br / en / es)

Verificação amostral via `diff` de `docs/pt-br/06-for-investors/01-tokenomics.md` vs `docs/en/` e `docs/es/`:

- Todos os valores numéricos (`100.000.000 GOV`, `10.000.000 CREDIT`, `5.000.000 CREDIT`, `0.95`, `[0.5, 1.1]`, `30/25/20/15/10`, `14 dias`, `365 dias`, `4e18`, `172800`) **coincidem entre as três traduções**.
- Terminologia técnica preservada (`MINTER_ROLE`, `BURNER_ROLE`, `floorSchedule`, `capMax`, `alpha`, `probationEndsAt`, etc.). ✓
- Alguns artigos e preposições localizadas adequadamente.
- **Nenhuma discrepância numérica ou invariante entre idiomas identificada.**

Consequência: **os defeitos C1-C4, A1-A6, M1-M5 se propagam nas 3 traduções.** Correção deve ser feita nas 3.

---

## 4. Riscos sistêmicos detectados (mesmo fora do escopo)

- **Lacuna de receita recorrente do Treasury** (C4) — sem isso, qualquer proposta futura de buyback operacional depende de doações externas ou aumento de treasuryBps, que precisaria ser aprovado pela mesma governança que começou com 0 GOV distribuído (ver A2). Não é tautológico, mas é frágil.
- **Threshold 10k GOV = 0.01% do cap** é baixo para proposta. Na janela pós-deploy, antes da primeira proposta de distribuição, apenas o Timelock tem GOV (0 circulante). Primeira proposta de `acceptOwnership + mint` precisa ser feita por EOA com ≥ 10k GOV — **que não existe ainda**. Governor vai reverter com `GovernorInsufficientProposerVotes`. Como isso é resolvido? Olhando `docs/pt-br/09-advanced/02-mainnet-deployment.md` pode haver uma proposta bootstrap via outra via. Precisa confirmar, mas não é evidente nos docs lidos.
- **Faixa de multiplier de 1x a 4x em [14d, 365d] linear** dá incentivo moderado ao lock longo. Curve faz 1x→2.5x em 4 anos (não-linear). Aqui é 4× em 1 ano — muito agressivo. Incentivo forte a lockar 365d, o que congela capital e reduz liquidez de GOV.
- **Sanity cap de burn 10M CREDIT/round/projeto em produção** é 2× do capMax de emissão (5M). Um projeto malicioso legitimamente listado pode consumir todo o sanity cap por round (10M burn), capturando >100% da emissão projetada (5M), forçando o clamp pelo capMax e preservando supply — mas a métrica de share de rewards fica dominada pelo atacante. Mitigação pelo sanity cap global indireto (soma de burn distribuída entre projetos). Vale rodar o Cenário C da simulação contra uma variante com "wash-burn apenas dentro do cap" em vez de acima.

---

## 5. Invariantes econômicas checadas

- **IE1 (α < 1 permanente)**: **FALHA** — MAX_ALPHA = 1.1 permite inflação via governança. Ver C2.
- **IE2 (Floor temporário)**: OK — 24 rounds, depois 0.
- **IE3 (capMax > α·peak burn esperado)**: OK — 5M > 0.95 × sanity cap teórico 10M × probab de atingir = superfície ok, mas sanity cap é 2× capMax, ver risco sistêmico.
- **IE4 (rebate app ≤ 1-α)**: OK apertado — rebate 5% = 1 − 0.95 exato. Se α for reduzido para 0.90, split precisa ajustar para 10% rebate, ou IE4 viola.
- **IE5 (Anti-captura via multiplier)**: OK — checkpoints por bloco via `Trace208` + `getWeightAt` no snapshotBlock.
- **IE6 (Liquidez DEX sustenta volume dos apps)**: **N/A no estado atual** — não há DEX, não há GOV circulante, não há CREDIT circulante fora do Treasury. Invariante só passa a fazer sentido após distribuição inicial + criação de pools.
- **IE7 (Buyback só quando preço < justo)**: N/A — buyback é stub.
- **IE8 (Vesting começa após 1ª proposta, cliff 6m, linear 24-36m)**: OK parcial — `teamVesting.example.json` tem `cliff=31536000` (365d = 12 meses) e `duration=126144000` (48 meses = 12m cliff + 36m linear). Cliff de 12m é **mais estrito** que o mínimo de 6m de IE8 — positivo. Mas o exemplo aponta para placeholders de endereço; nenhuma instância real está deployada.
- **IE9 (Nenhuma entidade > 20% fora do Treasury)**: N/A pré-distribuição; depende da proposta de distribuição futura respeitar.
- **IE10 (Emergency pause não existe para CREDIT/Staking)**: OK — confirmado `CreditToken` e `Staking` não herdam `Pausable`.

---

## 6. Recomendações priorizadas

### Ação imediata (antes de Sepolia)

1. **[CÓDIGO]** Reduzir `MAX_ALPHA` de 1.1e18 para 0.99e18 em `RewardDistributor.sol:111`. Motivação: IE1. (C2)
2. **[DOC]** Corrigir `README.md:276-280` — trocar "70.0M (genesis)" por "10M (genesis)" e reformular a tabela de supply deflacionário para refletir o modelo real, não a simulação. (C1)
3. **[DOC]** Atualizar `README.md` seções 1, 4 e mapa ASCII para "**12 contratos**" e incluir TeamVesting / UserSubsidy nos diagramas. (A1)
4. **[DOC]** Trocar "75% queimados" por "75% não cunhados" em 4 lugares: `README.md:290`, `docs/{pt-br,en,es}/02-core-concepts/{03-burn-to-mint.md:60, 04-rewards-distribution.md:64}`, `docs/{pt-br,en,es}/06-for-investors/01-tokenomics.md:136`. (A5)
5. **[DOC]** Ajustar status no `README.md:5` retirando "pronto para deploy Sepolia" (trocar para "candidato para Sepolia após resolver pendências §7"). (A6)

### Ação antes de mainnet

6. **[DESIGN]** Resolver C4 — preparar proposta de `setDefaultSplit` após primeira fase de distribuição para ativar `treasuryBps > 0`, OU preparar DEX real, OU documentar como dependência explícita da saúde de longo prazo. (C4)
7. **[CÓDIGO + DOC]** Expandir `Dao.ts` para deploy opcional de `TeamVesting` × N e `UserSubsidy`, OU documentar em `09-advanced/02-mainnet-deployment.md` quais deploys adicionais são necessários. (C3)
8. **[DOC]** Adicionar "primeira proposta bootstrap" detalhada — como submeter `acceptOwnership + mint inicial` quando nenhuma EOA tem 10k GOV. Sugestão: pre-deploy transferir GOV para Timelock via primeira proposta com proposalThreshold temporariamente 0, depois elevar. (risco sistêmico)
9. **[DOC]** Criar seção "Distribuição inicial — contratos pendentes" listando: Sale contract (não existe), LP setup (não existe), LiquidityMining (não existe). (A2)

### Ação contínua (manutenção de docs)

10. **[DOC]** Normalizar em pt/en/es: lock > 365d é aceito (A4), clarificar cenário "sem burn + sem staking global" (M1), documentar ownership handoff do Registry+FeeRouter (M2), alertar sobre risco de probation punitiva permanente (M3), instruir UIs sobre `previewClaim` (M4), explicar que `closeRound` depende de governança (M5).
11. **[DOC]** Corrigir typo "~5.2M" → "~5M" em `Dao.ts` comment (B4). Trocar "6 meses" → "~168 dias / ~5.5 meses" onde aparece (B5).
12. **[DOC]** Em `docs/pt-br/09-advanced/02-mainnet-deployment.md` adicionar nota sobre block-time em L2s que invalida voting delay/period nominais (B3).

---

## 7. Pendências / não resolvidos

- **Não explorado em profundidade** — `docs/pt-br/06-for-investors/03-risk-and-security.md` e `docs/pt-br/09-advanced/03-security-model.md` (tradução pode ter discrepâncias não-econômicas).
- **Não auditado** — `UserSubsidy.sol` em detalhe (apenas lido por completude). Economia de distribuição via Merkle parece sensata.
- **Não executado** — simulação do cenário B/C com parâmetros de produção (5M capMax, 10M sanity cap, α 0.95). Atual output usa dev (1M capMax, 1M sanity cap). Recomendo rodar produção antes de mainnet para validar que capMax 5M aguenta picos de burn realistas sem clampar excessivamente.
- **Fora de escopo** — análise de gas por função (relevante para UX de staker fazendo `claimMany` com 50 rodadas).
- **Decisão aberta para o user** — manter ou reduzir MAX_ALPHA (C2). Recomendação dao-economist é reduzir, mas é decisão de posicionamento do protocolo.

---

### Arquivos relevantes (caminhos absolutos)

Código:
- `/home/ubuntu/web3community/contracts/GovernanceToken.sol`
- `/home/ubuntu/web3community/contracts/CreditToken.sol`
- `/home/ubuntu/web3community/contracts/ProjectRegistry.sol`
- `/home/ubuntu/web3community/contracts/Treasury.sol`
- `/home/ubuntu/web3community/contracts/Staking.sol`
- `/home/ubuntu/web3community/contracts/RewardDistributor.sol`
- `/home/ubuntu/web3community/contracts/FeeRouter.sol`
- `/home/ubuntu/web3community/contracts/BurnTracker.sol`
- `/home/ubuntu/web3community/contracts/CommunityGovernor.sol`
- `/home/ubuntu/web3community/contracts/CommunityTimelock.sol`
- `/home/ubuntu/web3community/contracts/TeamVesting.sol`
- `/home/ubuntu/web3community/contracts/UserSubsidy.sol`

Configuração:
- `/home/ubuntu/web3community/ignition/parameters/production.json`
- `/home/ubuntu/web3community/ignition/parameters/dev.json`
- `/home/ubuntu/web3community/ignition/parameters/teamVesting.example.json`
- `/home/ubuntu/web3community/ignition/modules/Dao.ts`

Simulação:
- `/home/ubuntu/web3community/scripts/simulation/economicSim.ts`
- `/home/ubuntu/web3community/scripts/simulation/output/report.md`

Documentação (focos principais das correções):
- `/home/ubuntu/web3community/README.md`
- `/home/ubuntu/web3community/docs/pt-br/02-core-concepts/01-dual-token-economy.md`
- `/home/ubuntu/web3community/docs/pt-br/02-core-concepts/03-burn-to-mint.md`
- `/home/ubuntu/web3community/docs/pt-br/02-core-concepts/04-rewards-distribution.md`
- `/home/ubuntu/web3community/docs/pt-br/02-core-concepts/06-project-whitelist.md`
- `/home/ubuntu/web3community/docs/pt-br/02-core-concepts/07-treasury-and-fees.md`
- `/home/ubuntu/web3community/docs/pt-br/03-protocol-overview/01-architecture.md`
- `/home/ubuntu/web3community/docs/pt-br/03-protocol-overview/03-economic-flows.md`
- `/home/ubuntu/web3community/docs/pt-br/06-for-investors/01-tokenomics.md`
- `/home/ubuntu/web3community/docs/pt-br/06-for-investors/02-value-accrual.md`
- `/home/ubuntu/web3community/docs/pt-br/07-governance/03-parameters.md`
- `/home/ubuntu/web3community/docs/pt-br/08-contracts-reference/07-RewardDistributor.md`
- `/home/ubuntu/web3community/docs/pt-br/08-contracts-reference/05-Staking.md`
- `/home/ubuntu/web3community/docs/pt-br/08-contracts-reference/08-FeeRouter.md`
- Equivalentes em `/home/ubuntu/web3community/docs/en/` e `/home/ubuntu/web3community/docs/es/` precisam receber as mesmas correções.
