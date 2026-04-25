# FLUXO — A web3community do começo ao fim

> Este arquivo é a **porta de entrada didática** para a documentação. Lê-se em uma sentada (~30 min) e dá o modelo mental completo do protocolo: do dia em que ele nasce até a operação contínua de uma rodada típica.
>
> Toda a documentação detalhada vive em [`docs/pt-br/`](pt-br/) (10 pastas, ~40 arquivos). Aqui é só o **fluxo cronológico** com cada jargão acompanhado de uma nota explicativa curta.

---

## Sumário

1. [Leia isto primeiro](#1-leia-isto-primeiro)
2. [Os personagens](#2-os-personagens)
3. [Os dois tokens (e por que dois)](#3-os-dois-tokens-e-por-que-dois)
4. [Fase 0 — O nascimento (deploy)](#4-fase-0--o-nascimento-deploy)
5. [Fase 1 — A DAO assume o leme (governança)](#5-fase-1--a-dao-assume-o-leme-governança)
6. [Fase 2 — Um app pede para entrar](#6-fase-2--um-app-pede-para-entrar)
7. [Fase 3 — O uso real (uma rodada por dentro)](#7-fase-3--o-uso-real-uma-rodada-por-dentro)
8. [Fase 4 — A economia em loop contínuo](#8-fase-4--a-economia-em-loop-contínuo)
9. [Fase 5 — Manutenção e evolução](#9-fase-5--manutenção-e-evolução)
10. [Mapa: quem chama quem](#10-mapa-quem-chama-quem)
11. [Glossário consolidado](#11-glossário-consolidado)
12. [Para onde ir agora](#12-para-onde-ir-agora)

---

## 1. Leia isto primeiro

A **web3community** é uma DAO (organização autônoma descentralizada — uma "empresa" cujas decisões são tomadas por votação on-chain, sem CEO) que sustenta um **ecossistema de aplicativos** (apps tipo Chat, jogos, ferramentas) que cobram dos seus usuários em um token próprio chamado **CREDIT**. O protocolo tem **dois tokens** (GOV para votar, CREDIT para pagar), **14 contratos inteligentes** principais e um **ciclo econômico** que gira em rodadas semanais.

> **Nota técnica — DAO:** conjunto de contratos `CommunityGovernor` + `CommunityTimelock`. Toda mudança de parâmetro ou movimento da tesouraria passa por proposta + votação + atraso de segurança.

**Como ler este documento:**

- **Sou leigo, nunca mexi com cripto.** Comece pelo capítulo 2 e siga em ordem. Cada termo técnico tem uma "Nota técnica" curta e o glossário ao final consolida tudo.
- **Sou dev/auditor.** Pode pular direto para o cap. 4 (deploy) e usar o cap. 10 (mapa de chamadas) como cola.
- **Sou investidor/governance.** Caps. 3, 7.5, 8 e 9 são os essenciais.

Tudo aqui é **código-primeiro**: cada número (α=0.95, cap 5M, voting delay 1 dia etc.) vem dos parâmetros de produção em [`ignition/parameters/production.json`](../ignition/parameters/production.json) ou de constantes nos contratos em [`contracts/`](../contracts/). Se este texto e o código divergirem, **o código ganha**.

---

## 2. Os personagens

O protocolo só faz sentido com 5 atores em cena. Nomes consistentes com [`docs/pt-br/03-protocol-overview/02-user-flows.md`](pt-br/03-protocol-overview/02-user-flows.md).

| Ator | Quem é | O que faz | O que ganha |
|---|---|---|---|
| **Charlie** | Usuário final | Compra CREDIT na DEX e paga para usar um app | Acesso ao serviço do app |
| **ChatApp** | Equipe de um app (dApp) | Listou o app no protocolo, recebe pagamentos | 5% de cada pagamento (rebate) + parte da emissão de rewards |
| **Alice** | Stakeira | Trava GOV em um projeto específico | CREDIT recém-emitido proporcional ao seu peso |
| **Bob** | LP (provedor de liquidez) | Põe par CREDIT/USDC numa DEX e stakeia o NFT no `LiquidityGauge` | CREDIT recém-emitido em vesting de 14 dias |
| **DAO** | Holders de GOV votando no `CommunityGovernor` | Decide parâmetros, lista projetos, move o Treasury | Controle das regras |

> **Nota técnica — DEX:** Decentralized Exchange. Aqui é o pool Uniswap V3 CREDIT/USDC 0.3%. Pool = "tanque" onde os dois tokens ficam disponíveis para troca.
>
> **Nota técnica — LP:** Liquidity Provider. Quem deposita os dois tokens no pool e recebe um NFT (token único, não fungível) representando sua posição. Cobra taxa de quem usa o pool. Aqui também ganha CREDIT extra via gauge.
>
> **Nota técnica — dApp:** "decentralized app". Aplicativo cuja lógica de pagamento usa o protocolo on-chain. A lógica do app em si (ex.: enviar mensagem no chat) roda fora do protocolo.

---

## 3. Os dois tokens (e por que dois)

### GOV — o token de governança

- **Cap fixo de 100.000.000** (cem milhões), imutável no contrato. Ninguém, nem mesmo a DAO, consegue ultrapassar.
- Serve para **votar** em propostas e como **colateral** quando alguém lista um projeto novo (mínimo 10.000 GOV trancados).
- **Não há yield direto sobre GOV** — só vira CREDIT se for stakeado em um projeto.

> **Nota técnica — ERC-20:** padrão de token fungível na Ethereum (cada unidade equivale a outra, como dinheiro). Especificação em `OZ ERC20`.
>
> **Nota técnica — ERC20Votes / checkpoint:** extensão do ERC-20 que grava o saldo de voto a cada bloco em que ele muda. Permite consultar quantos votos a Alice tinha no bloco X (`getPastVotes`). Imuniza contra flash-loans.
>
> **Nota técnica — cap:** teto de supply. Para GOV é hardcoded no construtor (100M). Para CREDIT não há cap fixo — a inflação é controlada pela fórmula da rodada.

### CREDIT — o token utilitário

- **Supply elástico** — pode subir (mint na finalize de uma rodada) e cair (burn quando alguém paga em um app).
- **Genesis** de 10.000.000 CREDIT cunhados uma única vez no deploy, indo direto para o Treasury.
- Serve como **moeda dos apps** e como **pagamento de rewards** para stakers, LPs e apps.

> **Nota técnica — supply elástico:** total de tokens em circulação muda ao longo do tempo. Não é stablecoin (preço varia livre na DEX); é "elástico" no sentido de que mint e burn são contínuos.
>
> **Nota técnica — MINTER_ROLE / BURNER_ROLE:** permissões granulares (do `AccessControl` do OZ) para chamar `mint` ou `burnByRole` no `CreditToken`. Em produção: `RewardDistributorV2` é MINTER, `BurnTracker` é BURNER. Mais nada cunha ou queima.
>
> **Nota técnica — genesis mint:** cunhagem inicial única, protegida por uma flag `genesisMinted` que reverte chamadas futuras. Função `CreditToken.mintGenesis(to, amount)`.

### Por que dois tokens?

Porque **separar poder político de poder de compra é uma decisão de design**:

- Quem usa os apps (Charlie) **não precisa virar votante** — ele compra só CREDIT.
- Quem quer governar (Alice) **não precisa pagar inflação a cada uso** — ela detém GOV.
- Stakeiros que travam GOV ganham CREDIT, então o vínculo entre as duas pontas existe sem misturar funções.

Detalhamento em [`docs/pt-br/02-core-concepts/01-dual-token-economy.md`](pt-br/02-core-concepts/01-dual-token-economy.md).

---

## 4. Fase 0 — O nascimento (deploy)

O dia zero do protocolo: rodar o módulo de deploy [`ignition/modules/Dao.ts`](../ignition/modules/Dao.ts). Comando real:

```
npm run deploy:sepolia
# ou local:  npm run deploy:local
```

A ordem é estritamente sequencial porque cada contrato precisa do endereço dos anteriores no construtor. Cinco fases:

```
A. DEPLOY (10 contratos, em ordem):
   1. GovernanceToken      (GOV — 100M cap)
   2. CreditToken          (CREDIT — supply elástico, 0 inicialmente)
   3. CommunityTimelock    (executor com atraso de 2 dias)
   4. ProjectRegistry      (whitelist de projetos)
   5. Treasury             (cofre multi-ativo)
   6. Staking              (depende do Registry)
   7. BurnTracker          (depende de CREDIT + Registry)
   8. RewardDistributor V1 (depende de CREDIT + Tracker + Staking + Registry)
   9. FeeRouter            (depende de tudo acima + Treasury)
   10. CommunityGovernor   (depende de GOV + Timelock)

B. CONCESSAO DE ROLES (deployer ainda admin):
   - MINTER_ROLE     → RewardDistributor    (poder de cunhar CREDIT)
   - BURNER_ROLE     → BurnTracker          (poder de queimar CREDIT)
   - RECORDER_ROLE   → FeeRouter            (poder de registrar burn por projeto)
   - PROPOSER_ROLE   → Governor             (no Timelock — pode enfileirar)
   - CANCELLER_ROLE  → Governor             (no Timelock — pode cancelar)
   - GENESIS:        mintGenesis(Treasury, 10_000_000 CREDIT)

C. TRANSFERENCIA AO TIMELOCK:
   - GOVERNANCE_ROLE em todos os contratos econômicos → Timelock
   - DEFAULT_ADMIN_ROLE → Timelock
   - Ownable do GovernanceToken → Timelock (2-step accept)

D. DEPLOYER RENUNCIA:
   - Deployer renuncia todos os roles que ainda detinha
   - Timelock fica como único administrador

E. OPCIONAL:
   - TeamVesting (1 contrato por membro do time)
   - UserSubsidy (singleton para subsídios via Merkle drop)
```

> **Nota técnica — role / AccessControl:** sistema de permissões do OZ. Cada role é um `bytes32 keccak256("NOME_ROLE")`. Funções restritas usam `onlyRole(ROLE)`. Concessão e revogação por outro role (geralmente `DEFAULT_ADMIN_ROLE`).
>
> **Nota técnica — Timelock:** contrato que executa qualquer chamada com **atraso obrigatório** (em produção, 2 dias = 172.800 segundos). Implementado como subclasse trivial de `TimelockController` da OZ.
>
> **Nota técnica — Ownable / Ownable2Step:** padrão "tem um dono". A versão 2-step exige que o novo dono confirme via `acceptOwnership()`, evitando transferir para endereço errado.
>
> **Nota técnica — keeper:** processo automático off-chain (bot) que chama funções permissionless on-chain em horários certos. Aqui usado para `recordDailyPrice` e poderia ser usado para `closeRound`.

**Por que essa ordem?** Cada contrato injeta o endereço do anterior no construtor. Roles vêm depois porque alguns roles (MINTER_ROLE) precisam apontar para contratos que já foram deployados. O handoff ao Timelock vem por último para que o deployer **não consiga sabotar** depois — a partir da Fase D, **somente a DAO** controla qualquer parâmetro. Detalhe em [`docs/pt-br/09-advanced/02-mainnet-deployment.md`](pt-br/09-advanced/02-mainnet-deployment.md).

---

## 5. Fase 1 — A DAO assume o leme (governança)

A partir da Fase D, **toda mudança** passa por proposta. O ciclo é único, padronizado, com 8 estados:

```
       propose(...)              after votingDelay (7200 blk = ~1d)
   user --------------> Pending -----------------> Active
                                                     |
                                                     | votingPeriod (50400 blk = ~7d)
                                                     v
                              For>Against +     Defeated     Canceled
                              quorum 4%        (terminal)   (proposer
                                  |                          ou DAO)
                                  v
                              Succeeded
                                  |
                                  | governor.queue(id)
                                  v
                              Queued ---- timelockMinDelay (172800 s = 2d) ----+
                                                                                |
                                  +------ se ninguém executa em GRACE_PERIOD: Expired
                                  |
                                  | governor.execute(id)
                                  v
                              Executed (terminal)
```

**Tempo total mínimo:** ~10 dias (1 dia de delay + 7 dias de votação + 2 dias no Timelock). Esse atraso é o **preço intencional da segurança** — qualquer ataque tem 10 dias para ser detectado e cancelado.

**Pré-requisitos para propor:** `getVotes(msg.sender) >= 10.000 GOV` (proposalThreshold de produção).

**Quorum:** 4% do supply circulante de GOV votar "For" para a proposta passar.

> **Nota técnica — quorum:** mínimo de votos necessário para a proposta ter validade. Numerador 4 / denominador 100 = 4% do `totalSupply` no bloco do snapshot.
>
> **Nota técnica — snapshot de voto:** bloco de referência onde o `Governor` lê o saldo de votos de cada endereço (`getPastVotes(account, snapshot)`). Snapshot fica `votingDelay` blocos após a criação da proposta. Quem move GOV depois do snapshot **não muda** seu poder de voto naquela proposta.
>
> **Nota técnica — calldata:** sequência de bytes que codifica "qual função chamar e com quais argumentos". Cada proposta carrega `targets[]`, `values[]` (ETH a enviar, quase sempre 0) e `calldatas[]`.
>
> **Nota técnica — batch / atomicidade:** uma proposta pode ter várias calldatas. Ou todas executam, ou nenhuma. Se uma reverter, a tx inteira desfaz.

Detalhamento em [`docs/pt-br/07-governance/01-proposal-lifecycle.md`](pt-br/07-governance/01-proposal-lifecycle.md).

---

## 6. Fase 2 — Um app pede para entrar

Antes que Charlie pague pelo ChatApp, o ChatApp precisa estar **listado** no `ProjectRegistry`. O processo cronológico:

```
1. ChatApp team prepara metadata (off-chain)
   - JSON com nome, descrição, ícone, contratos
   - upload IPFS → recebe CID (ex.: ipfs://Qm...)

2. ChatApp team adquire 10.000 GOV
   - Comprando em DEX, ou via proposta de transfer do Treasury

3. Alguém com >= 10k GOV delegados cria proposta (batch):
   targets   = [registry, registry]
   calldatas = [
     registry.registerProject(chatAppOwner, "ipfs://Qm...", 10_000e18),
     registry.activateProject(nextProjectId)
   ]

4. Voto + queue + execute (ciclo do cap. 5, ~10 dias)

5. ChatApp team faz approve(registry, 10_000 GOV) antes da execução

6. No execute do Timelock:
   - GOV.transferFrom(chatAppOwner, registry, 10_000)  [colateral travado]
   - projeto vira Active com projectId atribuído (ex.: 42)
   - probationEndsAt = now + 30 dias

7. Durante 30 dias o projeto está em probation inicial:
   - pagamentos funcionam normal
   - share de rewards é dividido por 4 (recebe só 25%)

8. Após 30 dias: probation expira, share normaliza
```

> **Nota técnica — IPFS / CID:** InterPlanetary File System. Armazenamento descentralizado de arquivos. CID = "Content Identifier", hash que aponta para o conteúdo (`Qm...` ou `bafy...`). On-chain, o Registry só guarda o CID — o JSON em si vive fora.
>
> **Nota técnica — colateral:** garantia que o app deposita ao listar. Se a governança remover o projeto por má conduta, o colateral pode ser **slashed** (transferido para o Treasury). Se for removido em paz, devolvido ao owner.
>
> **Nota técnica — projectId:** inteiro auto-incrementado pelo Registry. É o identificador usado em **todas** as outras chamadas do protocolo (`feeRouter.pay(projectId, ...)`, `staking.stake(projectId, ...)` etc.).
>
> **Nota técnica — probation:** "período de prova". Duas formas distintas:
> - **Inicial por tempo** (automática, 30 dias): share /4, mas tudo funciona.
> - **Punitiva** (status do enum, manual via governança): bloqueia stake novo e pagamentos.

A partir do passo 8, o ChatApp pode receber pagamentos com share cheio. Ver [`docs/pt-br/05-for-developers/03-submitting-a-project.md`](pt-br/05-for-developers/03-submitting-a-project.md).

---

## 7. Fase 3 — O uso real (uma rodada por dentro)

Esta é **a peça central**. Vamos seguir uma rodada `R` do início ao fim. Em produção, uma rodada dura 7 dias.

### 7.1 Charlie paga em CREDIT

Charlie quer usar o ChatApp (`projectId = 42`). Tem 1.000 CREDIT na carteira.

```
Charlie.wallet
  | 1. CREDIT.approve(feeRouter, 1000)
  v
CreditToken |=> allowance[charlie][feeRouter] = 1000

  | 2. feeRouter.pay(projectId=42, user=charlie, amount=1000)
  v
FeeRouter
  | 3. checks: registry.isActive(42), amount > 0
  | 4. CREDIT.transferFrom(charlie, router, 1000)
  | 5. split default 9500/0/500:
  |     burned     = 950
  |     toTreasury = 0
  |     toApp      = 50
  | 6. CREDIT.transfer(chatAppOwner, 50)        [rebate direto]
  | 7. CREDIT.approve(burnTracker, 950)
  | 8. burnTracker.burnAndRecord(42, router, 950)
       |
       v
  BurnTracker
       | burnByRoundProject[R][42] += 950
       | totalBurnByRound[R]       += 950
       | CREDIT.burnByRole(router, 950)   [_burn → totalSupply -= 950]
```

**Resultado:** supply de CREDIT cai 950. ChatApp ganha 50. Burn de R fica registrado on-chain.

> **Nota técnica — approve / allowance:** padrão de duas etapas para gastar token de outro. Charlie autoriza (`approve`) o `feeRouter` a movimentar até 1.000 CREDIT da sua carteira. Depois, o `feeRouter` puxa via `transferFrom`.
>
> **Nota técnica — basis points (bps):** unidade de proporção. 10.000 bps = 100%. 9500 bps = 95%. Solidity não tem `float`, então split é em bps.
>
> **Nota técnica — split:** divisão do pagamento. Default 95/0/5 (burn/treasury/app). A DAO pode ajustar global ou por projeto via `setProjectSplit`.

Detalhe completo: [Fluxo 1 em `02-user-flows.md`](pt-br/03-protocol-overview/02-user-flows.md).

### 7.2 Alice trava GOV no projeto (em paralelo)

Alice tem 50.000 GOV e acredita no ChatApp. Trava por 1 ano:

```
Alice.wallet
  | 1. GOV.approve(staking, 50_000)
  | 2. staking.stake(projectId=42, amount=50_000, lockDuration=365 days)
  v
Staking
  | checks: amount > 0, lockDuration in [14d, ∞), registry.isActive(42)
  | multiplier = 4x (lock máximo, satura em 365d)
  | weight = 50_000 * 4 = 200_000
  | escreve checkpoints em block.number:
  |   _userWeight[alice][42]
  |   _projectWeight[42]
  |   _globalWeightCheckpoints
  | GOV.transferFrom(alice, staking, 50_000)
```

**Resultado:** Alice imobilizou 50k GOV até `now + 365 dias`. Peso do projeto 42 subiu 200k.

> **Nota técnica — lock:** prazo durante o qual a posição não pode ser desfeita (`unstake`). Mínimo 14 dias, sem máximo, mas multiplier satura em 365d.
>
> **Nota técnica — multiplier:** fator que multiplica `amount` para virar `weight`. Linear de 1x (14d) a 4x (365d). Quem trava por mais tempo tem peso desproporcionalmente maior.
>
> **Nota técnica — weight (peso):** `amount * multiplier`. É o que o `RewardDistributor` consulta para dividir share de rewards.
>
> **Nota técnica — flash-loan:** empréstimo gigante de tokens que precisa ser devolvido **no mesmo bloco**. Atacantes usam para inflar saldo temporariamente. Aqui é neutralizado: snapshot de peso é lido a partir de um bloco passado, não do bloco atual.

Detalhe: [Fluxo 2 em `02-user-flows.md`](pt-br/03-protocol-overview/02-user-flows.md).

### 7.3 Bob provê liquidez (em paralelo)

Bob tem CREDIT + USDC. Quer ganhar yield extra:

```
Bob.wallet
  | 1. abre posição CREDIT/USDC no Uniswap V3 (recebe NFT)
  | 2. NPM.safeTransferFrom(bob, liquidityGauge, tokenId, IncentiveKey)
  v
LiquidityGauge
  | encaminha NFT para o UniswapV3Staker oficial
  | grava posição interna
  | rewards começam a acumular enquanto a posição estiver in-range
```

Quando Bob desfizer a posição:

```
Bob -> liquidityGauge.unstake(tokenId)
  | UniswapV3Staker.unstakeToken + claimReward + withdrawToken
  | cria VestingPosition de 14 dias com o reward acumulado
Bob -> liquidityGauge.harvest()  [pode chamar a qualquer momento durante os 14d]
  | calcula vested linear até agora
  | CREDIT.safeTransfer(bob, vestedAmount)
```

> **Nota técnica — Uniswap V3:** DEX que usa "liquidez concentrada" — LP escolhe um intervalo de preço (chamado tick). Posição vira NFT (ERC-721, não fungível).
>
> **Nota técnica — NFT:** Non-Fungible Token. Cada token tem ID único (não trocável 1:1 como ERC-20). Padrão ERC-721. Aqui representa uma posição específica de LP.
>
> **Nota técnica — in-range:** preço atual do par está dentro do intervalo escolhido pelo LP. Só dentro do intervalo a posição está "trabalhando" (rendendo taxas e rewards do gauge).
>
> **Nota técnica — gauge:** mecanismo (do mundo Curve) que distribui rewards proporcionais ao tempo + tamanho da posição em LP. Aqui o `LiquidityGauge` é adapter sobre o `UniswapV3Staker` canônico da Uniswap Foundation.
>
> **Nota técnica — vesting:** liberação gradual ao longo do tempo. Reward de 14.000 CREDIT em vesting de 14 dias = 1.000/dia liberado linearmente.

### 7.4 A rodada fecha

Sete dias se passaram desde o início de `R`. Para fechar a rodada e abrir a próxima:

```
Governança aprova proposta:
  burnTracker.closeRound()
       |
       | only GOVERNANCE_ROLE (Timelock tem)
       | currentRound = R+1
       | roundStartedAt = now
```

> **Nota técnica — limitação real:** `closeRound` é gated por governança. Se a DAO ficar inativa, a rodada **não fecha sozinha** (`isRoundReadyToClose` é só consultivo). Recomendação: usar keeper externo (Gelato / Chainlink Automation) para chamar `closeRound` periódico via proposta agendada. Detalhe em [`02-core-concepts/03-burn-to-mint.md`](pt-br/02-core-concepts/03-burn-to-mint.md).

### 7.5 Qualquer um finaliza a rodada

Após `closeRound`, **qualquer endereço** pode chamar:

```
rewardDistributorV2.finalizeRound(R)
       |
       | checks: !roundData[R].finalized, currentRound > R
       | totalBurnPrev = burnTracker.getTotalBurnForRound(R)  [já fechada]
       |
       | rawEmission   = max(alpha * totalBurnPrev, floorSchedule[R])
       | totalEmission = min(rawEmission, capMax)
       |
       | snapshotBlock = block.number
       | roundData[R] = { totalEmission, totalBurnPrev, snapshotBlock, finalized=true }
```

**A fórmula do protocolo:**

```
emissao_R = min( max( α × burn_{R-1}, floor(R) ), capMax )
```

Em produção:

| Parâmetro | Valor | Significado |
|---|---|---|
| `α` (alpha) | 0,95 (= `950000000000000000` / 1e18) | Emite-se 95% do que foi queimado na rodada anterior → deflacionário se uso constante |
| `floor(R)` | array de 24 valores, cai linear de 400k a ~16,6k | Piso para bootstrap; após 24 rodadas (~5,5 meses) zera |
| `capMax` | 5.000.000 CREDIT | Teto duro para conter explosão de burn |

> **Nota técnica — alpha (α):** fator multiplicador. `α < 1` garante deflação líquida (emissão < burn) com uso estável. Bounds hardcoded `[0.5, 0.99]` — DAO não pode votar valor inflacionário.
>
> **Nota técnica — floor schedule:** array imutável de 24 valores definido no construtor. `floorSchedule[R]` é o piso da rodada R. Existe só para bootstrap (sem ele, a primeira rodada teria emissão 0).
>
> **Nota técnica — cap (de emissão):** teto. Mesmo se o burn for absurdo, emite-se no máximo `capMax`.
>
> **Nota técnica — deflacionário:** supply tende a cair com o tempo. Se a demanda por CREDIT se mantiver, isso aprecia o token unitariamente.
>
> **Nota técnica — snapshot block / anti-flashloan:** `snapshotBlock` grava `block.number` no momento da finalize. Pesos são consultados *naquele bloco passado*, não no bloco do claim. Quem fizer flash-stake depois não captura share.

Por trás da fórmula em [`02-core-concepts/03-burn-to-mint.md`](pt-br/02-core-concepts/03-burn-to-mint.md).

### 7.6 Distribuição em 4 buckets (V2 — pivot CLP)

A emissão **não vai toda para stakers** — vai para 4 destinos simultâneos:

```
                       totalEmission (ex.: 902.500 CREDIT)
                                  |
       +--------+--------+--------+--------+--------+
       | 55%    | 25%    | 15%    | 5%     |
       v        v        v        v
  +----------+ +-------+ +------+ +--------------------+
  | Stakers  | | LPs   | | Apps | | Bonders            |
  | (Alice)  | | (Bob) | |(App) | | (POL refill)       |
  | LAZY     | | PUSH  | | PUSH | | PUSH               |
  | claim()  | | gauge | | dono | | Treasury polRefill |
  +----------+ +-------+ +------+ +--------------------+
```

| Bucket | % default | Destino | Mecanismo |
|---|---|---|---|
| Stakers | 55% | mint para `claim()` lazy | Alice puxa quando quiser; CREDIT só nasce no claim |
| LPs | 25% | `LiquidityGauge.notifyRewardAmount` | Push automático no `finalizeRound` |
| Apps | 15% | `ownerRecipient(projectId)` | Push retrospectivo, proporcional ao burn de cada projeto |
| Bonders | 5% | `Treasury.polRefillBucket` | Earmark para refill de POL (Fase 1.2 CLP) |

> **Nota técnica — bucket:** "balde". Cada uma das 4 fatias da emissão V2. Soma exata 10.000 bps. Bounds individuais hardcoded (ex.: `MIN_BUCKET_STAKERS_BPS = 3000`).
>
> **Nota técnica — lazy mint vs push:** **lazy** = CREDIT só é cunhado quando o destinatário chama `claim`. **push** = é cunhado direto na finalize, transferido (ou notificado) automaticamente.
>
> **Nota técnica — CLP (Credit Liquidity Protocol):** pivot econômico de abril/2026 em 4 fases que reorganizou o protocolo para sustentar liquidez do par CREDIT/USDC. Histórico em [`docs/governance/`](governance/).
>
> **Nota técnica — POL (Protocol-Owned Liquidity):** liquidez do pool detida pelo próprio Treasury. Em vez de depender só de LPs externos, o protocolo é seu próprio LP.

Detalhe em [`docs/governance/fase1-4-bucket-split.md`](governance/fase1-4-bucket-split.md).

### 7.7 Alice e Bob recebem

**Alice (staker)** — chama claim quando quiser:

```
rewardDistributorV2.claim(round=R, projectId=42)
   | checks: roundData[R].finalized, !claimed[R][42][alice]
   | projectShare = totalEmission_stakers * burnByProject[R-1][42] / totalBurn[R-1]
   |   (caminho bootstrap se totalBurn==0: usa weight global)
   |   (penalty /4 se isInProbation(42))
   | userShare = projectShare * weightAt(alice,42,snap) / totalWeightAt(42,snap)
   | CREDIT.mint(alice, userShare)
```

**Bob (LP)** — chama harvest:

```
liquidityGauge.harvest(positionId)
   | calcula vested linear (até 14 dias após unstake)
   | CREDIT.safeTransfer(bob, vested)
```

**ChatApp (app bucket)** — é push, recebe direto na finalize:

```
finalizeRound(R) → CREDIT.mint(ownerRecipient(42), appsBucketShare)
```

> **Nota técnica — claim:** ato de "reivindicar". O CREDIT só passa a existir na carteira de Alice quando ela executa `claim` — antes era só uma promessa no `roundData`.
>
> **Nota técnica — ownerRecipient:** endereço canônico que recebe o bucket apps de um projeto. Setado via `proposeOwnerRecipient` (só owner) com timelock próprio de 48h. Cancelável pela DAO em emergência.

Fluxo completo: [Fluxo 3 em `02-user-flows.md`](pt-br/03-protocol-overview/02-user-flows.md).

---

## 8. Fase 4 — A economia em loop contínuo

Repetindo as Fases 3 muitas vezes, surge o **loop econômico**:

```
   +-----------------------------------------------------+
   | Charlie compra CREDIT na DEX                        | <-- valor real entra
   |  (POL do Treasury + LPs externos = liquidez)        |
   +-----------------------------------------------------+
                          |
                          v
   Charlie paga em CREDIT no ChatApp
                          |
                          v
                    FeeRouter.pay
                          |
        +-----------------+-----------------+
        |                 |                 |
        v                 v                 v
    burned 95%       treasury 0%        rebate 5%
   (supply -X)      (recomendação      (cash op
   BurnTracker       CLP: 20%)         pro app)
   registra
        |
        v
   close + finalizeRound
        |
        v
   emissao_R = min(max(0.95 * burn_{R-1}, floor), capMax)
        |
        v   split em 4 buckets
   +----+----+----+----+
   | 55%| 25%|15% | 5% |
   v    v    v    v
   stk  LP   App  Treasury polRefill
        |    |        |
        v    v        v
   apreciam/vendem CREDIT --> demanda secundária na DEX
   Treasury usa polRefill + USDC para addPOLFromRefill
   --> liquidez do pool aumenta --> Charlie consegue comprar com menor slippage
                          |
                          | (ciclo recomeça)
                          v
                       Rodada R+1
```

**Saldo líquido por rodada** (uso constante, α=0,95): supply cai ~5% do burn. Em 52 rodadas no cenário "base" da simulação `scripts/simulation/economicSim.ts`: ~3,8% de queda agregada.

### Os 3 loops do Treasury (pós-CLP)

1. **FFP — defesa do floor.** Keeper chama `recordDailyPrice` (cooldown 22h). Se spot < floor por ≥24h, governança propõe `executeBuyback(usdcAmount, minCreditOut)` → swap USDC→CREDIT no Uniswap V3 → queima imediata. Caps: 20%/evento, 30%/mês sobre USDC do Treasury.

2. **POL refill.** `treasuryBps` (se DAO ativar) e `polRefillBucket` (5% bonders) acumulam USDC e CREDIT. `Treasury.addPOLFromRefill` casa as duas pontas e injeta no `polTokenId` (NFT custodiado pelo Treasury).

3. **Fallback gauge.** Se `LiquidityGauge` está paused, `RewardDistributorV2` envia o bucket LPs para `Treasury.depositPendingGaugeRewards`. Quando a DAO despausa, `flushPendingGaugeRewards` joga o estoque no gauge como incentive.

> **Nota técnica — FFP (Floating com Floor Price):** modelo de defesa. Spot é livre acima do floor; abaixo dele a DAO pode intervir.
>
> **Nota técnica — MA90:** média móvel de 90 dias do preço do CREDIT em USD, mantida em ring buffer no Treasury. Floor relativo = `0.5 × MA90`.
>
> **Nota técnica — oráculo:** contrato externo que fornece dado de fora (preço de USDC, TWAP do CREDIT). Aqui: Chainlink (USDC/USD) e `priceOracle` interno (TWAP do par CREDIT/USDC).
>
> **Nota técnica — TWAP:** Time-Weighted Average Price. Preço médio ponderado pelo tempo, tirado dos pools Uniswap. Resistente a manipulação pontual.
>
> **Nota técnica — slippage:** diferença entre preço esperado e preço executado num swap, causada por liquidez insuficiente. Mais POL = menos slippage.
>
> **Nota técnica — swap:** troca on-chain entre dois tokens via DEX. `swapRouter.exactInputSingle` é a função canônica do Uniswap V3.

Aprofundamento em [`docs/pt-br/03-protocol-overview/03-economic-flows.md`](pt-br/03-protocol-overview/03-economic-flows.md) e [`docs/governance/fase1-1-buyback-ffp.md`](governance/fase1-1-buyback-ffp.md).

---

## 9. Fase 5 — Manutenção e evolução

Toda mudança de parâmetro e movimento da tesouraria passa pelo **mesmo ciclo do cap. 5** (proposta → vote → queue → execute, ~10 dias mínimos). Casos típicos:

### Ajuste de parâmetros econômicos

| Parâmetro | Bounds | Função |
|---|---|---|
| `alpha` | `[0.5, 0.99]` | `RewardDistributor.setAlpha` |
| `capMax` | `[1, 100M]` CREDIT | `RewardDistributor.setCapMax` |
| `roundDuration` | `[1d, 30d]` | `BurnTracker.setRoundDuration` |
| `bucketBps` (V2) | bounds individuais por bucket, soma 10000 | `RewardDistributorV2.setBucketBps` |
| Split global | soma 10000 bps | `FeeRouter.setDefaultSplit` |
| Split por projeto | soma 10000 bps | `FeeRouter.setProjectSplit` |
| `minCollateral`, `probationDuration` | governance | `ProjectRegistry.set...` |

**Não ajustáveis** (imutáveis no construtor): `floorSchedule`, `MIN_LOCK`, `MAX_LOCK`, `MAX_MULTIPLIER`, `MIN_ALPHA`, `MAX_ALPHA`, cap de GOV (100M).

### Projeto fraudulento

```
Governance propõe + executa:
  registry.putInProbation(projectId)    [bloqueia stake novo + pagamentos; permite unstake]
  ou
  registry.removeProject(projectId, slash=true)
       | colateral GOV → Treasury (slash)
       | status → Removed
       | stakers podem unstake mesmo com lock ativo (escape hatch)
```

> **Nota técnica — slash:** confisco de garantia como punição. Aqui é o GOV travado como colateral indo para o Treasury.
>
> **Nota técnica — escape hatch:** "saída de emergência". Mecanismo que permite ao usuário sair em situações anormais (ex.: unstake sem lock se o projeto foi removido).

### TeamVesting — alocação ao time

Cada membro do time tem **1 contrato `TeamVesting`** isolado, parametrizado com `(start, cliff, duration, beneficiary)`. Owner = Timelock. GOV é mintado pela DAO direto para o contrato; beneficiário chama `release()` para sacar a parcela já vested. DAO pode `revoke` para devolver o não-vested ao Treasury.

### UserSubsidy — subsídios para usuários novos

Singleton. DAO cria campanha via proposta:

```
governance executa:
  treasury.transfer(userSubsidy, creditAmount)
  userSubsidy.createCampaign(merkleRoot, amountPerUser, deadline, maxClaims)
```

Usuários elegíveis chamam `claim(merkleProof)` antes do deadline.

> **Nota técnica — Merkle root / proof:** árvore de hashes (estrutura de dados criptográfica). O contrato guarda só a raiz (32 bytes); o usuário fornece a "prova" de que está na árvore. Permite validar listas grandes de elegíveis sem armazenar tudo on-chain.

Detalhes em [`docs/pt-br/08-contracts-reference/`](pt-br/08-contracts-reference/) (um arquivo por contrato).

---

## 10. Mapa: quem chama quem

Visão consolidada dos 14 contratos e suas chamadas principais (pós-CLP Fase 1):

```
                       +-----------------------------+
                       |     CommunityGovernor       |   (camada política)
                       +-------------+---------------+
                                     | schedule
                                     v
                       +-----------------------------+
                       |     CommunityTimelock       |   (executor c/ atraso 2d)
                       |   detem GOVERNANCE_ROLE     |
                       +----+-------------------+----+
                            |                   |
        +---+---+---+---+---+---+---+---+---+---+---+
        |       |       |       |       |       |
        v       v       v       v       v       v
   +-------+ +------+ +------+ +-----+ +-----+ +------+
   |Project| |Treasr| |Stakng| |Burn-| |Fee- | |Liqui-|
   |Registr| | FFP  | |     | |Track| |Route| |Gauge |
   |+ownerR| | POL  | |     | |     | |     | |LP rwd|
   +---+---+ +---+--+ +---+--+ +--+--+ +--+--+ +--+---+
       |         ^        |       |       |       ^
   isActive/    spend     |       |     apprv   notify
   ownerRecip   addPOL    |       |     +burn   (LPs)
       |         |        v       v       |       |
       +---------+--------+-------+-------+-------+
                          v
              +-------------------------------------+
              |       RewardDistributorV2           |
              | emissao = min(max(α*burn,floor),    |
              |               capMax)               |
              | split: stakers | LPs | apps | bonds |
              +------------------+------------------+
                                 |
                          MINTER_ROLE
                                 v
                       +-----------------------------+
                       |        CreditToken          |
                       +--------------+--------------+
                                      ^ burnByRole
                                      |
                              +------------+
                              | BurnTracker|
                              +------------+

  GOV (GovernanceToken) -> stakado em Staking
                        -> colateral em ProjectRegistry
                        -> vestido em TeamVesting
                        -> vota em CommunityGovernor

  Externo: Uniswap V3 pool CREDIT/USDC 0.3%
       ^                                  ^
       | POL (Treasury custodia)          | LP externo + UniswapV3Staker
       |                                  |   controlado por LiquidityGauge
       |                                  |
   Treasury.polTokenId            LiquidityGauge.stake(tokenId)

  Auxiliares:
   +-------------+   +---------------+
   | TeamVesting |   | UserSubsidy   |
   | vesting GOV |   | Merkle drops  |
   +-------------+   +---------------+
```

Mapa cheio com tabela completa de "quem chama quem" em [`docs/pt-br/03-protocol-overview/01-architecture.md`](pt-br/03-protocol-overview/01-architecture.md).

---

## 11. Glossário consolidado

> Apêndice em ordem alfabética. Cobre só os termos que aparecem neste documento. Glossário maior em [`docs/pt-br/01-getting-started/03-glossary.md`](pt-br/01-getting-started/03-glossary.md).

**AccessControl** — sistema de permissões granulares do OpenZeppelin. Cada permissão é um `bytes32` (role); funções restritas usam `onlyRole(ROLE)`.

**Allowance** — quantidade que um endereço autoriza outro a movimentar do seu saldo. Definida com `approve`, gasta com `transferFrom`.

**Alpha (α)** — fator da fórmula de emissão. Em produção 0,95. Bounds `[0.5, 0.99]`.

**Basis points (bps)** — unidade de proporção. 10.000 bps = 100%. 9500 bps = 95%.

**Bonders** — quarto bucket do `RewardDistributorV2` (5% default). Na Fase 1 CLP, vira refill earmarkado de POL no Treasury.

**Bucket** — fatia da emissão V2. Quatro buckets: stakers / LPs / apps / bonders. Soma exata 10.000 bps.

**Burn (queima)** — decremento permanente de `totalSupply` via `_burn` do ERC-20. Acontece no `BurnTracker.burnAndRecord` chamado pelo `FeeRouter.pay`.

**BurnTracker** — oráculo on-chain que conta burn por `(rodada, projectId)`. Consumido pelo `RewardDistributor`.

**Calldata** — bytes que codificam chamada de função (selector + argumentos ABI). Cada proposta carrega `targets[]` + `calldatas[]`.

**Cap (de supply)** — teto. GOV: 100M imutável. CREDIT: sem cap fixo, controlado por `capMax` da emissão (5M default).

**Checkpoint** — historiografia on-chain por bloco. `Staking` e `ERC20Votes` escrevem checkpoints a cada mudança; consultados via `getPastVotes` / `getWeightAt`.

**CID** — Content Identifier do IPFS. Hash que aponta para conteúdo (ex.: `Qm...`).

**Claim** — ato de reivindicar reward. Lazy = CREDIT só nasce quando o destinatário chama. Push = cunhado e enviado direto na finalize.

**CLP (Credit Liquidity Protocol)** — pivot econômico de abril/2026 em 4 fases. Histórico em [`docs/governance/`](governance/).

**Colateral** — GOV travado pelo app no `ProjectRegistry` ao listar (mínimo 10k em produção). Slashable se removido com má conduta.

**CREDIT** — token utilitário ERC-20. Supply elástico. Pago em apps; cunhado como reward; queimado em pagamentos.

**DAO** — Decentralized Autonomous Organization. Aqui: `CommunityGovernor` + `CommunityTimelock`.

**dApp** — decentralized application. App cuja lógica de pagamento usa o protocolo on-chain.

**Deflacionário** — supply tende a cair com o tempo. Aqui via α<1 e uso constante.

**DEX** — Decentralized Exchange. Aqui o Uniswap V3 pool CREDIT/USDC 0.3%.

**ERC-20** — padrão de token fungível na Ethereum.

**ERC-721 / NFT** — Non-Fungible Token. Cada token tem ID único.

**Escape hatch** — saída de emergência. Ex.: unstake sem lock se projeto foi removido.

**FeeRouter** — contrato que recebe pagamentos em CREDIT, divide segundo split (95/0/5 default), distribui.

**FFP (Floating com Floor Price)** — modelo de defesa do CREDIT (Fase 1.1 CLP). Spot livre acima do floor; abaixo, governança pode propor buyback + queima.

**Finalize** — congelar emissão calculada para uma rodada. Função `RewardDistributor.finalizeRound(round)`. Permissionless.

**Flash-loan** — empréstimo gigante devolvido no mesmo bloco. Mitigado por snapshots em blocos passados.

**Floor schedule** — array imutável de 24 valores. `floorSchedule[R]` = piso da rodada R. Existe só para bootstrap.

**Gauge** — mecanismo que distribui rewards proporcionais ao tempo + tamanho da posição em LP. `LiquidityGauge` adapter sobre `UniswapV3Staker`.

**Gas** — taxa em ETH para executar uma transação. Cada operação consome unidades de gas. Pago pelo signatário da tx (relayer pode pagar pelo usuário).

**Genesis mint** — cunhagem inicial única (10M CREDIT em produção, indo para o Treasury). Flag one-shot bloqueia repetição.

**GOV** — token de governança ERC-20 + ERC20Votes. Cap 100M imutável. Voto + colateral.

**GOVERNANCE_ROLE** — role concedido apenas ao Timelock em produção. Gate em todas as funções governance-sensíveis.

**In-range** — preço atual do par está dentro do intervalo da posição V3. Só in-range a posição rende.

**IPFS** — InterPlanetary File System. Storage descentralizado. On-chain só armazena CID.

**Lazy mint** — CREDIT só é cunhado quando o destinatário chama `claim`. Oposto de push.

**LiquidityGauge** — adapter sobre `UniswapV3Staker`. Distribui bucket LPs (25% default) com vesting de 14d por unstake.

**Lock** — prazo de imobilização do stake. `[14d, ∞)`. Multiplier satura em 365d.

**LP (Liquidity Provider)** — quem fornece liquidez no pool, recebe NFT V3.

**MA90** — média móvel de 90 dias do preço do CREDIT em USD. Mantida no Treasury, atualizada por `recordDailyPrice`.

**Merkle root / proof** — árvore de hashes criptográfica. Contrato guarda raiz; usuário fornece proof. Usado em `UserSubsidy`.

**MINTER_ROLE / BURNER_ROLE / RECORDER_ROLE** — roles do `AccessControl` no `CreditToken` e `BurnTracker`.

**Multiplier** — fator aplicado a `amount` para calcular weight. Linear de 1x (14d) a 4x (365d).

**Multisig** — wallet controlada por múltiplas chaves (ex.: 3 de 5). Não usado como admin do protocolo (todo admin é o Timelock).

**Oráculo** — contrato que fornece dado off-chain (preço). Aqui: Chainlink USDC/USD + TWAP interno do CREDIT.

**ownerRecipient** — endereço canônico (com timelock 48h próprio) que recebe o bucket apps. Setado por `proposeOwnerRecipient`.

**POL (Protocol-Owned Liquidity)** — liquidez do pool detida pelo Treasury. NFT custodiado em `polTokenId`.

**Probation** — duas formas: **inicial por tempo** (auto, 30d, share /4) e **punitiva** (status, manual via DAO).

**Proposal** — objeto do Governor `(targets, values, calldatas, descriptionHash)`. 8 estados: Pending → Active → Succeeded → Queued → Executed (ou variações).

**Quorum** — mínimo de votos "For" para passar. 4% do supply em produção.

**Rebate** — fatia (5% default) que o `FeeRouter` transfere ao app. Cash operacional do app.

**RewardDistributorV2** — versão bucket-aware do distributor. 4 buckets simultâneos. Pivot CLP Fase 1.4.

**Role** — `bytes32 keccak256("NOME_ROLE")`. Permissão granular do `AccessControl`.

**Round / Rodada** — período contábil. Em produção 7 dias alvo. Aberto até `closeRound()` (gated por governance).

**Sanity cap** — limite de burn por `(rodada, projectId)` no `BurnTracker`. 10M default. Previne ataque de burn artificial.

**Slash** — confisco de colateral como punição.

**Slippage** — diferença entre preço esperado e executado num swap. Reduzido por mais POL.

**Snapshot** — bloco de referência para consultar voting power ou peso de stake. Imuniza contra flash-loans.

**Split** — `(burnBps, treasuryBps, rebateBps)` no `FeeRouter`. Soma 10.000. Default 9500/0/500.

**Staking direcionado** — Alice trava GOV em um `projectId` específico, não num pool global.

**Supply elástico** — CREDIT pode mintar e queimar continuamente; supply varia.

**Swap** — troca on-chain de um token por outro via DEX. `swapRouter.exactInputSingle` no Uniswap V3.

**Tick** — granularidade de preço no Uniswap V3. Range full ticks = `[-887220, 887220]` (preço de 0 a infinito).

**Timelock** — `CommunityTimelock`. Atraso de 2 dias entre queue e execute. Único portador do `GOVERNANCE_ROLE`.

**TWAP** — Time-Weighted Average Price. Preço médio ponderado pelo tempo, do pool Uniswap.

**Uniswap V3** — DEX com liquidez concentrada em ranges. Posição = NFT.

**Vesting** — liberação gradual ao longo do tempo (linear ou com cliff).

**Voting delay / period** — em blocos. Produção: 7200 (~1d) / 50400 (~7d).

**Wallet** — carteira on-chain. Endereço de 20 bytes + chave privada.

**Weight (peso de staking)** — `amount * multiplier(lockDuration) / 1e18`. Determina share de rewards.

---

## 12. Para onde ir agora

| Quero... | Vá para |
|---|---|
| Detalhe de um contrato específico | [`docs/pt-br/08-contracts-reference/`](pt-br/08-contracts-reference/) — 1 arquivo por contrato |
| Aprender a votar | [`docs/pt-br/04-for-users/04-voting.md`](pt-br/04-for-users/04-voting.md) |
| Listar meu app no protocolo | [`docs/pt-br/05-for-developers/03-submitting-a-project.md`](pt-br/05-for-developers/03-submitting-a-project.md) |
| Setup local (Hardhat) | [`docs/pt-br/05-for-developers/05-local-dev.md`](pt-br/05-for-developers/05-local-dev.md) |
| Tokenomics e value accrual | [`docs/pt-br/06-for-investors/`](pt-br/06-for-investors/) |
| Histórico do pivot CLP (Fase 0 → 1.4) | [`docs/governance/`](governance/) |
| Modelo de segurança / deep dives | [`docs/pt-br/09-advanced/`](pt-br/09-advanced/) |
| FAQ | [`docs/pt-br/10-reference/01-faq.md`](pt-br/10-reference/01-faq.md) |
| Glossário maior | [`docs/pt-br/01-getting-started/03-glossary.md`](pt-br/01-getting-started/03-glossary.md) |
