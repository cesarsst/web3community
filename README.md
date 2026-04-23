# web3community

DAO dual-token para uma plataforma multi-aplicativos: governança on-chain, staking direcionado por projeto e um ciclo econômico sustentado pelo consumo real dentro dos apps do ecossistema.

> **Status**: testes verdes (565, coverage 100% stmts/lines em contracts/) · slither sem findings high/medium · simulação econômica cobre 3 cenários · **pendências pré-mainnet listadas em §7; requer auditoria externa + distribuição inicial antes de produção**.

---

## 1. Como os contratos conversam entre si

Pense no protocolo como um **organismo com 12 órgãos**, cada um com uma função clara. As setas mostram quem _chama_ quem:

```
                       ┌─────────────────────────────┐
                       │    CommunityGovernor        │  (cérebro político)
                       │    — coleta votos           │
                       │    — cria propostas         │
                       └──────────────┬──────────────┘
                                      │ schedule()
                                      ▼
                       ┌─────────────────────────────┐
                       │    CommunityTimelock        │  (músculo — executor com delay)
                       │    — segura GOVERNANCE_ROLE │
                       │      de TODOS abaixo        │
                       └──────┬───────────────┬──────┘
                              │               │
              ┌───────────────┼───────────────┼───────────────┐
              ▼               ▼               ▼               ▼
     ┌────────────────┐  ┌────────────┐  ┌──────────┐  ┌─────────────┐
     │ ProjectRegistry│  │  Treasury  │  │ Staking  │  │ BurnTracker │
     │  — whitelist   │  │  — cofre   │  │ — stake  │  │ — oracle    │
     └───────┬────────┘  └─────┬──────┘  └────┬─────┘  └──────┬──────┘
             │                 │              │                │
             │ isActive/       │ spend        │ getWeightAt    │ getTotalBurn
             │ isInProbation   │              │                │
             ▼                 ▼              ▼                ▼
                   ┌──────────────────────────────────────────┐
                   │         RewardDistributor                │  (contador)
                   │  emissão_R = min(max(α·burn, floor), cap)│
                   └──────────────────────┬───────────────────┘
                                          │ mint CREDIT
                                          ▼
                   ┌──────────────────────────────────────────┐
                   │            CreditToken (CREDIT)          │
                   └──────────────────────────────────────────┘
                                          ▲
                                          │ burn
                   ┌──────────────────────┴───────────────────┐
                   │              FeeRouter                    │  (caixa)
                   │   split: 95% burn / 5% app rebate        │
                   └──────────────────────────────────────────┘

     GovernanceToken (GOV) ← staked em Staking, votado no Governor

     +-- Contratos auxiliares (governance-owned, deploy opcional) --+
     |                                                              |
     |  TeamVesting  — 1 instancia por beneficiario.                |
     |                 Cliff + linear, owner = Timelock, revogavel. |
     |                 Alimenta-se de transfers do Treasury.        |
     |                                                              |
     |  UserSubsidy  — singleton. Campanhas Merkle (funded do       |
     |                 Treasury em CREDIT). Onboarding de           |
     |                 primeiros usuarios dos apps.                 |
     |                                                              |
     +--------------------------------------------------------------+
```

**Três camadas mentais:**

1. **Camada política** (Governor + Timelock) — decide _o que o protocolo faz_.
2. **Camada de estado** (Registry, Treasury, Staking, BurnTracker) — guarda _quem é quem_ e _quanto tem o quê_.
3. **Camada econômica** (RewardDistributor, FeeRouter, tokens GOV/CREDIT) — move _valor_.

---

## 2. Como a DAO funciona — a via política

A DAO é **uma máquina de decidir coletivamente** com três travas de segurança.

### Atores

- **Holder de GOV**: quem tem token de governança. Se delegar pra si mesmo (`gov.delegate(self)`), vira eleitor.
- **Governor**: urna eletrônica. Aceita propostas, conta votos, marca o vencedor.
- **Timelock**: notário com prazo. Segura a decisão por 2 dias antes de executar, pra dar tempo de alguém gritar "espera!".

### O ciclo de uma decisão

```
  Propor          Esperar 1d        Votar 7d         Enfileirar        Esperar 2d        Executar
  ────────        ──────────        ────────         ──────────        ──────────        ────────
  Alice tem       votingDelay       holders de       governor.         timelock          qualquer
  10k GOV         (anti-MEV:        GOV votam        queue()           .execute()        um aperta
  delegados       ninguém vota      For/Against/     — agenda no       — espera          o botão
  (threshold).    no mesmo          Abstain.         timelock.         o delay.          execute()
  Chama           bloco).           Precisa de                                            (address(0)
  governor.                         4% quorum.                                             é executor).
  propose(...).                     Precisa For
                                    > Against.
```

Na prática: se Alice quer **adicionar o "ChatApp" ao Registry**, ela propõe `registry.registerProject(ownerX, "ipfs://...", 10_000 GOV)`. Se a comunidade aprovar, o Timelock executa — **Alice sozinha não consegue, nem o dev original consegue**. Essa é a garantia I7 do modelo.

### Por que três travas?

- **Threshold** (10k GOV pra propor) — evita spam.
- **Quorum** (4%) — evita captura por minoria ativa quando todo mundo está dormindo.
- **Timelock** (2d) — se uma proposta maliciosa passar, holders têm tempo de sacar fundos/vender GOV antes que o estrago aconteça.

### O que a DAO controla?

**Tudo que importa** está atrás do Timelock:

- Adicionar/remover projetos do Registry
- Gastar recursos do Treasury
- Ajustar α, capMax, floor, split de fees, duração de rodadas
- Dar e tirar roles (ex.: promover um novo FeeRouter)

**O que a DAO NÃO controla:**

- Supply cap do GOV (100M, hard-coded, imutável)
- Semântica dos tokens (burn, transfer, etc. — são ERC20 padrão)
- O próprio lock de 14 dias do Staking (protege staker contra a própria governança)

---

## 3. Como o comércio se mantém vivo — o motor econômico

Aqui está o ponto fino. Muitos protocolos dual-token são Ponzi disfarçado. O que impede este de virar isso?

### A pergunta fundamental: "De onde vem o valor real?"

Resposta: **do usuário final que paga stable (USDC/ETH) pra comprar CREDIT na DEX**, porque precisa usar os apps do ecossistema. Se ninguém paga stable lá fora, nenhuma fórmula matemática salva o protocolo.

Tudo gira em torno desse fluxo:

```
   ┌────────────────────────────────────────────────────────────────┐
   │   FLUXO DE VALOR REAL (o que sustenta o sistema)               │
   └────────────────────────────────────────────────────────────────┘

   [ Usuário Charlie ]
         │
         │  (1) compra 1000 CREDIT na DEX por $X em USDC
         │      — pressão de compra sobe o preço de CREDIT
         ▼
   [ Carteira Charlie ] ← tem 1000 CREDIT agora
         │
         │  (2) usa o Chat App. App cobra 1000 CREDIT.
         │      Charlie dá approve(feeRouter, 1000) e chama
         │      feeRouter.pay(chatAppId, charlie, 1000)
         ▼
   [ FeeRouter ] ← recebe 1000 CREDIT
         │
         ├── (3a) queima 950 via BurnTracker.burnAndRecord(chatAppId, router, 950)
         │         → CREDIT.totalSupply cai em 950
         │         → BurnTracker marca: "Chat App queimou 950 no round R"
         │
         └── (3b) transfere 50 pro app owner (rebate — app captura valor)
```

### Os 4 agentes e como cada um ganha

| Agente                        | O que faz                              | Como ganha                                                                                       |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Usuário final** (Charlie)   | Paga em CREDIT pra usar o app          | Recebe o **serviço** (valor fora do protocolo)                                                   |
| **App** (Chat App)            | Provê utilidade, recebe rebate         | **3 fontes combinadas** (rebate direto + emissão via stake + apreciação do CREDIT) — veja abaixo |
| **Staker** (Alice)            | Trava GOV em projeto, suporta liquidez | Recebe **CREDIT recém-emitido** na próxima rodada                                                |
| **Holder de GOV** (sem stake) | Participa da governança                | Pode ver **GOV valorizar** conforme uso cresce (apreciação, não yield direto)                    |

### As 3 fontes de receita de um app

Isolado, o rebate de 5% do split default parece desincentivador — nenhum app web2 aceitaria entregar 95% do preço nominal. **O modelo só fecha porque o app captura valor por três vetores simultâneos**, não por um. Olhar só pro vetor (A) leva à conclusão errada de que o ecossistema é predatório com apps.

```
   [ Usuário Charlie paga 1000 CREDIT no Chat App via feeRouter.pay() ]
                               │
                               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                       FeeRouter.pay()                             │
   │                     split 95 / 0 / 5 default                      │
   └────────┬─────────────────────────────────────────┬────────────────┘
            │ 950 CREDIT queimadas                    │ 50 CREDIT → appRecipient
            │ (registradas como burn do Chat App)     │
            ▼                                         ▼
   ┌───────────────────────┐            ┌────────────────────────────┐
   │  BurnTracker          │            │  (A) REBATE DIRETO          │
   │  burn[R][chatAppId]   │            │  ──────────────────────────│
   │      += 950           │            │  5% × cada pagamento        │
   └──────────┬────────────┘            │  Pago em CREDIT, na hora.   │
              │                          │  É o fluxo de caixa        │
              │ alimenta                 │  operacional do app.       │
              ▼                          └────────────────────────────┘
   ┌──────────────────────────────────┐
   │  RewardDistributor (próx. rodada)│
   │  emissao_R = min(max(α·burn,     │
   │                     floor), cap) │
   │  project_share =                 │
   │    emissao × burn[chatApp] /     │
   │             burn_total           │
   └──────────────┬───────────────────┘
                  │ split por peso de stake dentro do projeto
                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  (B) EMISSÃO VIA STAKE NO PRÓPRIO PROJECTID                       │
   │  ────────────────────────────────────────────────────────────────│
   │  Se o Chat App stakea X GOV direcionado ao próprio projectId,    │
   │  ele recebe uma fatia de `project_share` proporcional ao seu     │
   │  peso de stake (lock × multiplier) — exatamente como qualquer    │
   │  outro staker. Como o próprio app é quem "move" o burn do        │
   │  projeto, ele tem vantagem informacional pra dimensionar o       │
   │  stake. Essa é a via que transforma os 5% em algo competitivo.    │
   └──────────────────────────────────────────────────────────────────┘

   Ao longo do tempo, em paralelo:

   ┌──────────────────────────────────────────────────────────────────┐
   │  (C) APRECIAÇÃO DO CREDIT RETIDO                                  │
   │  ────────────────────────────────────────────────────────────────│
   │  α = 0.95 ⇒ emite-se 95% do que se queima. Supply cai com uso    │
   │  real do ecossistema (simulação 52 rounds: −3.8%).                │
   │  O estoque de CREDIT que o app não vendeu ainda (do rebate A     │
   │  + rewards B) tende a valer mais em termos reais, desde que o    │
   │  produto dos apps continue gerando demanda stable de fora.        │
   └──────────────────────────────────────────────────────────────────┘
```

**Exemplo numérico** (mesmos números da rodada de exemplo acima):

- Chat App movimentou 600k CREDIT de pagamentos no round R-1.
- **(A)** Rebate direto: 5% × 600k = **30k CREDIT** no caixa do app, imediato.
- **(B)** Stake: se o app stakeou 50k GOV com lock 1 ano (multiplier 4x → peso 200k de 400k de peso total no projeto), ele captura 50% do `project_share` do Chat App = 50% × 570k = **285k CREDIT** na rodada seguinte.
- **(C)** Apreciação: os 30k + 285k retidos sofrem deflação de supply junto com o resto do CREDIT.

Somando (A)+(B), o app captura `30k + 285k = 315k` de um volume bruto de 600k — **~52% efetivo**, não 5%. É essa matemática que o pitch para apps precisa explicitar, porque o split nominal do `FeeRouter` sozinho conta uma história enganosa.

**Pré-requisitos para (B) fechar a conta:**

- O app precisa adquirir GOV (compra em DEX ou participação em rodadas de distribuição da DAO).
- O app precisa aceitar o lock do Staking (14–365 dias) — é capital imobilizado.
- O peso do stake do app relativo ao stake total _no seu projeto_ define a captura. Se outros stakers entrarem com muito peso no mesmo projectId, a fatia do app dilui.

**Quando (B) não fecha** (app sem caixa pra comprar GOV, ou que recusa imobilizar capital), o modelo default de 5% realmente é desincentivador. Nesses casos o caminho é propor via Governor um `setProjectSplit` específico — a arquitetura permite overrides por projeto exatamente pra acomodar perfis diferentes de app.

### O ciclo de rodadas — onde o staker colhe

Imagine o protocolo funcionando em **rodadas semanais**:

```
   Round R-1 (a semana que passou)                 Round R (agora)
   ┌─────────────────────────────┐                 ┌─────────────────────────────┐
   │ Charlie, David e + 10k      │                 │ Alice pode sacar rewards de │
   │ usuários queimaram CREDIT   │  closeRound()   │ R-1 baseado em:             │
   │ nos apps.                   │  ────────────▶  │  • burn total de R-1         │
   │                             │                 │  • burn do projeto dela       │
   │ BurnTracker registrou:      │                 │  • peso do stake dela         │
   │  totalBurn = 950_000 CREDIT │                 │                             │
   └─────────────────────────────┘                 └─────────────────────────────┘
                                                              │
                                                   finalizeRound(R-1)
                                                              │
                                                              ▼
                                                   emissao_R = min(
                                                     max(0.95 × 950_000, floor),
                                                     capMax
                                                   ) = ~902_500 CREDIT

                                                   Esse pool é dividido:
                                                   — por projeto, proporcional ao
                                                     seu burn no round R-1
                                                   — por staker dentro do projeto,
                                                     proporcional ao peso stakeado
```

**Exemplo concreto**:

- Chat App queimou 600k, Game App queimou 350k (total 950k).
- Pool de 902.500 CREDIT divide: Chat App recebe ~570k, Game App ~333k.
- Alice stakou 80k GOV com lock 1 ano (multiplier 4x) = peso 320k.
- Total staked no Chat App: 400k de peso.
- **Alice reclama 570k × (320k/400k) = 456k CREDIT** — que ela pode vender na DEX ou usar pra consumir os próprios apps do ecossistema.

### Por que isso não é Ponzi

Porque tem **α = 0.95**. A fórmula garante que **emite-se um pouco menos do que foi queimado**.

**Modelo operacional real** (a fonte de verdade é `CreditToken.mintGenesis` + `ignition/parameters/production.json:genesisAmount`):

```
Supply CREDIT em produção:
  Round 0:  10.0M  (genesis unico — mintGenesis, one-shot, todo para Treasury)
  Round 1+: 10.0M + emissao_R - burn_R a cada rodada
             (emissao pela formula min(max(alpha*burn, floor), capMax))
```

Com alpha = 0.95, supply líquido cai em ~5% de cada `burn_R` em regime estável (burn aproximadamente constante).

**Número do simulador** (distinto do modelo operacional): a simulação em `scripts/simulation/economicSim.ts` parte de **70.4M** CREDIT — 10M de genesis + **60M de `Charlie_seed`** mintados por um atalho de teste (Timelock mintando direto para `charlie` em `scripts/simulation/economicSim.ts:72`). Os 60M não existem em mainnet. Isso é intencional no simulador para ter comprador ativo com liquidez grande durante 52 rodadas sem precisar modelar uma venda pública; mas qualquer leitor do relatório precisa entender que o supply inicial do simulador é uma escolha hipotética, **não** o supply operacional.

Simulação 52 rodadas (cenário base, supply inflado 70M, 1M burn/round): **supply cai ~3.8%**, APR nominal do staker estabiliza em ~34% em CREDIT. Esses valores absolutos são **ilustrativos do comportamento qualitativo** (deflação sustentada com uso constante) — não são promessa sobre mainnet, onde o supply operacional começa em 10M e o burn orgânico precisa ser construído a partir de uso real dos apps. Se CREDIT mantém preço, o staker captura valor real. Se CREDIT desvaloriza porque ninguém quer, APR nominal não paga as contas. **O motor só gira se os apps gerarem valor real.**

### As três salvaguardas que mantêm o sistema vivo

1. **Floor decay** (piso de emissão rounds 0–23): no bootstrap ninguém está queimando nada ainda. O floor garante que stakers ganham _alguma coisa_ pelos primeiros 24 rounds (~168 dias, ~5.5 meses), dando tempo de atrair apps e usuários. Depois ele some — obrigando o ecossistema a andar com as próprias pernas.

2. **Sanity cap** (`maxBurnPerRoundPerProject`): impede que um app malicioso queime 10M CREDIT próprio, inflacione a métrica e capture todo o pool de rewards. Validado on-chain — o Cenário C da simulação mostrou o ataque sendo rejeitado.

3. **Probation penalty** (projeto novo recebe só 25% da sua share): projetos entram na whitelist via Governor, mas ficam 30 dias em probation. Se revelarem má-conduta, 75% do que deveriam receber **nunca é cunhado** (não redistribuído) — punição cristalina sem complicar matemática. Não é `_burn` do token — é simplesmente uma redução do share antes de `CREDIT.mint`, então `totalSupply` **não muda** por esse caminho.

### Morte do sistema — como pode acontecer

O modelo **não é imortal**. O Cenário B da simulação (death spiral) mostrou que se o uso dos apps cair pra quase zero por mais de 24 rounds, a emissão colapsa junto com o burn, APR vai a quase zero, stakers saem, e o protocolo fica zumbi. A DAO pode intervir antes: ajustar α, aumentar capMax, abrir subsídio via Treasury, contratar novos apps. **Mas tokenomics não salva produto ruim** — os apps precisam gerar utilidade real.

---

## 4. Os 12 contratos — referência rápida

| #   | Contrato                | Função                                                                                                                     |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GovernanceToken` (GOV) | ERC20Votes, cap 100M imutável, Ownable2Step. Usado em governança + staking.                                                |
| 2   | `CreditToken` (CREDIT)  | ERC20Burnable, supply elástico, MINTER/BURNER roles, genesis one-shot de 10M.                                              |
| 3   | `ProjectRegistry`       | Whitelist on-chain de projetos. Status machine (Pending→Active→Probation→Removed) + collateral em GOV.                     |
| 4   | `Treasury`              | Custódia multi-ativo. Única saída: Timelock via `GOVERNANCE_ROLE`.                                                         |
| 5   | `Staking`               | Stake direcionado por projectId. Lock ≥ 14d; multiplier 1x→4x satura aos 365d; locks maiores são aceitos sem cap.          |
| 6   | `BurnTracker`           | Oracle interna do burn por (round, projectId). `burnAndRecord` atômico com sanityCap.                                      |
| 7   | `RewardDistributor`     | Fórmula `min(max(α·burn, floor), capMax)`. Pull-based claim. Snapshot anti-flashloan.                                      |
| 8   | `FeeRouter`             | Interface única de pagamento. Split 95/0/5 default, override por projeto.                                                  |
| 9   | `CommunityTimelock`     | OZ TimelockController, 2 dias de delay. Admin único de tudo acima.                                                         |
| 10  | `CommunityGovernor`     | Governor OZ. Voting delay 1d, period 7d, quorum 4%, threshold 10k GOV. Em L2s com block time < 12s os prazos encurtam.      |
| 11  | `TeamVesting`           | 1 instância por beneficiário. Cliff + linear, owner = Timelock, revogável. Funded via transfer do Treasury.                |
| 12  | `UserSubsidy`           | Singleton de campanhas Merkle em CREDIT. Funded do Treasury. Onboarding de primeiros usuários dos apps.                    |

Os contratos 11 e 12 **não fazem parte do deploy default** do `Dao.ts` (que preserva o comportamento de 10 contratos core do caminho de produção). Eles são deployados opcionalmente via env vars `DEPLOY_TEAM_VESTING=true` / `DEPLOY_USER_SUBSIDY=true` (ver §7 e `docs/pt-br/09-advanced/02-mainnet-deployment.md` para o fluxo recomendado em mainnet).

---

## 5. Instalação e comandos

```bash
# dependências
npm install

# compilar
npx hardhat compile

# rodar toda a suite (565 testes)
npm test

# coverage
npm run coverage

# simulação econômica 52 rodadas × 3 cenários
npm run sim

# deploy local (perfil dev)
npx hardhat node                                   # em outro terminal
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost

# deploy Sepolia (perfil produção)
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network sepolia

# slither (requer pipx install slither-analyzer)
slither contracts/<Contract>.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --solc-args "--optimize --optimize-runs 200 --evm-version paris"
```

### Primeira proposta em produção

Após deploy em rede pública, a **primeira ação obrigatória** é submeter ao Governor uma proposta chamando `governanceToken.acceptOwnership()` pelo Timelock — isso finaliza a transferência de ownership do GOV e destrava mints futuros via propostas (distribuição 30/25/20/15/10, vesting, etc.). O fluxo completo de propostas bootstrap está listado na §7 abaixo e detalhado em `docs/pt-br/09-advanced/02-mainnet-deployment.md`.

---

## 6. Stack técnico

- **Solidity 0.8.24** com `viaIR: true` (necessário pro Governor compilar dentro do EIP-170).
- **OpenZeppelin Contracts 5.0.2** pinado exato.
- **Hardhat + Ignition** pra orquestração de deploy.
- **Slither 0.11.5** via pipx pra auditoria estática.
- **Keep a Changelog 1.1.0 + SemVer 2.0.0** no `CHANGELOG.md`.
- Auditoria estática salva em `audit/slither/<Contract>.txt` (full) + `-projectonly.txt` (filtered).
- Simulação econômica em `scripts/simulation/` com outputs em CSV + relatório Markdown.

---

## 7. Próximos passos antes de mainnet

Itens marcados **[DESIGN]** exigem decisão arquitetural pendente (contrato ainda não existe ou comportamento precisa ser votado pela DAO). Itens **[OPS]** são operacionais.

1. **[OPS]** **Auditoria externa obrigatória** (Trail of Bits / OpenZeppelin / Certik).
2. **[OPS]** Deploy em Sepolia + smoke test de governança por ≥ 2 semanas.
3. **[OPS]** Primeira proposta após deploy: `GovernanceToken.acceptOwnership()` pelo Timelock (detalhada em `docs/pt-br/09-advanced/02-mainnet-deployment.md`).
4. **[DESIGN]** **Contratos de distribuição inicial que AINDA NÃO EXISTEM no repo** e precisam ser desenhados/deployados antes das propostas de bootstrap da distribuição 30/25/20/15/10:
   - `Sale` (venda pública dos 20% — formato a definir: bonding curve, fixed-price, LBP, etc.).
   - `LiquidityBootstrappingPool` / `LiquidityManager` (provisão dos 10% em DEX — escolha de venue Uniswap v2/v3/Balancer, range, TWAP).
   - `LPRewards` / liquidity-mining (opcional, se parte dos 15% community for programada dessa forma).

   Sequência proposta de propostas bootstrap (a ordenar e aprovar via Governor após `acceptOwnership`):

   ```
   proposta #1: acceptOwnership do GOV pelo Timelock (obrigatória e primeira).
   proposta #2: mint Treasury — 30M GOV.
   proposta #3: deploy TeamVesting × N + mint 25M GOV distribuído
                 entre as instâncias via Treasury transfer.
   proposta #4: deploy Sale + mint 20M GOV para o contrato de venda.
   proposta #5: fund UserSubsidy em CREDIT via Treasury + mint
                 15M GOV como community rewards (LP mining / airdrops).
   proposta #6: deploy LP inicial + mint 10M GOV para o
                 LiquidityManager e provisão da pool DEX.
   ```

   Até a proposta #2 executar, **0 GOV existe em circulação**. O bootstrap do primeiro proposer usa o padrão documentado em `docs/pt-br/09-advanced/02-mainnet-deployment.md` (deployer multi-sig faz mint mínimo para passar o `proposalThreshold` imediatamente antes de `acceptOwnership`).

5. **[DESIGN]** **Treasury sem receita recorrente** — `treasuryBps = 0` por default significa que o Treasury **não acumula receita operacional automática**. As únicas entradas recorrentes são slash e doações. Para ativar tesouraria com cash flow antes de habilitar buyback real, a DAO precisa aprovar uma proposta do tipo `setDefaultSplit({burnBps: 9000, treasuryBps: 500, rebateBps: 500})` (valores a serem decididos pela DAO). Essa proposta é **pré-requisito** para qualquer buyback operacional ter lastro.
6. **[DESIGN]** **`Treasury.executeBuyback` é stub v1** — só emite `BuybackRequested`. Integração DEX real (escolha de venue, TWAP, slippage, resistência a frontrunning) está em fase separada e depende do item 5 acima para ter orçamento.
7. **[OPS]** **TeamVesting e UserSubsidy opcionais no `Dao.ts`** — `ignition/modules/Dao.ts` aceita env vars `DEPLOY_TEAM_VESTING=true` e `DEPLOY_USER_SUBSIDY=true` (default `false` em ambas, preservando caminho de 10 contratos core). Em mainnet, a recomendação é **deployar esses auxiliares via módulos separados após a DAO aprovar beneficiários e schedules** (ver `ignition/modules/TeamVesting.ts` / `UserSubsidy.ts`). Ativar os flags no deploy all-in-one só é seguro quando os placeholders (beneficiários, datas) já foram substituídos por valores reais e auditados.
8. **[OPS]** Multi-sig Safe como segundo `CANCELLER_ROLE` no Timelock para emergências.
9. **[OPS]** Bug bounty via Immunefi antes ou logo após mainnet.
10. **[OPS]** Monitoramento on-chain (Forta / Tenderly) para eventos críticos: `CapExceeded`, `SanityCapExceeded`, `RoundClosed.earlyClose=true`, saídas grandes do Treasury, `AlphaUpdated`, `DefaultSplitUpdated`.
11. **[OPS]** Se o destino for L2 (Base, Arbitrum, Optimism), revisar `votingDelay` e `votingPeriod` em `production.json` conforme block time da chain — os valores `7200` / `50400` (blocos) assumem ~12s/block do L1; em L2 com 1–2s/block os prazos nominais 1d/7d colapsam para ~2.4h/16.8h.

---

## Licença

A definir pelo mantenedor do projeto.
