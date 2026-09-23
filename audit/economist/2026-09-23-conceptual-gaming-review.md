# Parecer — falhas de conceito e vetores de "burlar o objetivo" (2026-09-23)

**Escopo:** contratos (`contracts/`), deploy (`ignition/modules/Dao.ts`, `scripts/deploy-prod-sim.ts`), hub Vue (`web3community-frontend/src`), SDK + consumidor (`utils/packages/web3community-sdk`, `cloud-terminal`), docs `docs/pt-br/06-for-investors`, fórum Flarum (`FORUM.md` + API em `:5191`), orquestração (`swarm/docker-compose.production.yml`).
**Método:** leitura estática + verificação por chamada/grep. Não é auditoria de roubo de valor (já coberta pelas invariantes I1–I7 e pelos pareceres 2026-07-08/07-10); é análise de **incentivos e de sinal** — onde um usuário, dono de app, investidor ou detentor de GOV consegue obter o resultado do protocolo sem cumprir o objetivo (uso real de apps, rev-share sobre receita real, governança comunitária).

**Objetivo do protocolo, como declarado nas docs:** *"a renda vem de receita real, não de aporte de novos investidores; GOV valoriza por buyback proporcional ao GMV; CREDIT lastreado 1:1 sem saque, nem para governança."* Cada item abaixo é um ponto onde o código **não garante** essa frase.

Legenda de severidade: **C** = quebra o objetivo/promessa central · **A** = permite burlar com custo baixo · **M** = inconsistência que induz decisão errada · **B** = higiene.

---

## Resumo executivo

| # | Sev | Vetor | Quem burla | Custo p/ atacante |
|---|---|---|---|---|
| 1 | C | Rev-share é **inexigível**: o app pode sair do trilho `pay()` (ou usar um `projectId` novo) a qualquer momento após receber o capital. Colateral slashado vai p/ Treasury, não p/ investidor. | dono de app | zero |
| 2 | C | Governança por maioria simples pode **mintar CREDIT sem lastro** (`grantRole(MINTER_ROLE)` ou `mintGenesis`) e sacar o USDC do PSM via `sell`. Contradiz I-PSM1 ("nem governança"). | ≥50% dos votos | 1 proposta |
| 3 | C | Governança por maioria simples pode **mintar GOV até o cap (100M) para si** → captura permanente. Docs vendem "cap imutável, nunca inflacionado". | ≥50% dos votos | 1 proposta |
| 4 | A | **D1 (anti-self-payment) é contornável com 1 carteira extra**; `uniquePayersOf` e `recentVolumeOf` são infláveis por sybil sem gate. Custo continua 2,5%/ciclo. | dono de app | 2,5% do volume falso + gas |
| 5 | A | **Auto-rodada** continua possível com **uma única carteira**: `invest` não impede o owner; `minTarget = 100 CREDIT`; basta 100 GOV stakeados 14d. Selo "Funded" custa ≈ 0. | dono de app | ~100 GOV por 14 dias |
| 6 | A | **UI e docs ainda leem `grossVolumeOf`** (soma bruta, washável) e `totalRevenueDistributed` (inflado até por self-payment). D2/D4 não chegaram ao investidor. | — (o protocolo se auto-engana) | — |
| 7 | A | **GOV stakeado não vota** (`Staking` nunca delega). Quem mais se compromete perde voz; quem fica líquido decide. Quórum (4% do supply total) conta tokens que não podem votar. | holder líquido | — |
| 8 | A | Supermaioria 75% cobre só `grant/revoke/renounceRole` em Treasury/Timelock. **Fica em maioria simples:** `Treasury.transfer` (esvaziar), `setRecipients` (desviar a fee), `removeProject(slash, destino=qualquer)`, `grantRole` em Registry/FeeRouter/Funding/CreditToken, `updateDelay` do Timelock. | ≥50% dos votos | 1 proposta |
| 9 | M | Rev-share perpétuo e **sem teto** → após `receita × bps > raised`, o owner racional sai do trilho (reforça #1). | dono de app | — |
| 10 | M | **Uma rodada por projeto, para sempre.** `Failed` é terminal; `Funded` também. Projeto que falhou nunca capta de novo; projeto que captou nunca faz 2ª rodada. | — | — |
| 11 | M | `Staking.getWeight` **ignora expiração do lock**: 365d → 4× imediatamente e permanece 4× depois de destravado. "Skin in the game" é declarado, não realizado. | investidor/sybil | — |
| 12 | M | `Registry.ownerRecipient` (timelock 48h) é **código morto**; `FeeRouterV2.setAppRecipient` troca o destino instantaneamente. | dono de app | 1 tx |
| 13 | M | `Probation` = kill switch: `pay()` reverte, receita dos investidores para, stake fica preso (só `Removed` libera). Governança pode punir investidores, não só o owner. | governança | 1 proposta |
| 14 | M | Chain de "produção" é Hardhat com **RPC público sem filtro de método** (`hardhat_impersonateAccount`, `hardhat_reset`, `evm_increaseTime`) + USDC mock com faucet → todo sinal econômico e a ativação paga do cloud-terminal são fabricáveis de graça. Já conhecido (`SECURITY_HARDENING_PLAN.md`). | qualquer IP | zero |
| 15 | B | Docs desatualizadas: "872 testes" (são 386), "invest exige `> 0`" (é `>= minInvestWeight`), "grossVolumeOf é a métrica-mãe". UI checa `=== 0n` e deixa o usuário mandar tx que reverte com `InsufficientStakeWeight`. | — | — |
| 16 | B | Fórum: `allowSignUp: true`, sem vínculo com identidade on-chain; 2 discussões, 1 participante. "Comunidade" e "DAO" hoje são 1 conta (1M GOV mintado para `dev.address`). | sybil social | — |

---

## Detalhamento

### 1. Rev-share inexigível (C)

**Promessa:** `06-for-investors/02-value-accrual.md` — "O mecanismo é 100% on-chain e automático… o router desconta o rev-share antes de pagar o app".
**Realidade:** o desconto só acontece se o app **escolher** receber via `FeeRouterV2.pay(projectId)`. Nada no protocolo obriga isso. Após `_fund` (`ProjectFunding.sol:315`) o owner já tem o capital; a partir daí:

- aceita USDC/CREDIT direto na carteira (transfer simples) → `revShareBpsOf` nunca é consultado;
- ou pede à governança um **novo `projectId`** (mesmo app, novo cadastro) → `revShareBpsOf(novoId) == 0` (`ProjectFunding.sol:397`) e ainda ganha um contador GMV "limpo";
- `transferProjectOwnership` não é bloqueado por rodada `Funded` → o owner pode passar o projeto a uma carteira nova e sumir.

**Recurso do investidor:** nenhum. `removeProject(slash=true)` (`ProjectRegistry.sol:538`) manda o colateral para o `treasury`, não para `sharesOf`. Não há refund após `Funded`, não há claim sobre o colateral, não há multa.

O parecer 2026-07-08 fechou o bypass da **fee** baixando-a para 2,5%. Mas a rodada reintroduz um incentivo de bypass de **1%–30%** exatamente no ator que já embolsou o capital. Com rev-share perpétuo (#9), o bypass é a estratégia dominante assim que `receita acumulada × bps ≈ raised`.

**Correções possíveis (escolha de desenho, não bug):**
- Teto de retorno (múltiplo, ex. 2–3× do `raised`) + prazo → transforma "renda perpétua" em "empréstimo participativo", reduz o incentivo de fuga e ajuda o enquadramento jurídico.
- Colateral do owner **em garantia dos investidores** enquanto houver rodada `Funded`, com slash pro-rata para `sharesOf` (hoje vai p/ Treasury).
- Bloquear `transferProjectOwnership` e reregistro do mesmo `metadataURI` enquanto há rodada `Funded` abaixo do teto.
- Aceitar que o trilho é opcional e dizer isso nas docs de investidor em vez de "100% on-chain e automático".

### 2. Governança pode quebrar o peg do CREDIT (C)

**Promessa:** `03-risk-and-security.md` — "não existe função de saque do lastro — **nem para governança** (invariante I-PSM1)".
**Realidade:** verdadeiro para o PSM isolado, falso para o sistema:

- `CreditToken.mintGenesis` (`CreditToken.sol:113`) é `DEFAULT_ADMIN_ROLE` = Timelock, one-shot, **valor arbitrário**, `genesisMinted` ainda `false` (deploy "sem genesis"). Um voto de maioria simples minta N CREDIT sem USDC.
- `CreditToken.grantRole(MINTER_ROLE, X)` — target é o CreditToken, não Treasury/Timelock → proposta **Standard** (`CommunityGovernor.sol:257-258`). Mint ilimitado.
- `CreditPSM.sell` (`CreditPSM.sol:116`) só checa `usdcOut <= USDC.balanceOf(psm)`; não checa `mintedOutstanding`. CREDIT sem lastro sai por USDC real até secar o cofre. Os últimos a vender ficam com CREDIT sem lastro.

**Correção:** `mintGenesis` deve ser removido ou executado/queimado no deploy; `CreditToken` deve entrar na lista de alvos supermajority (ou melhor: PSM como **único** minter imutável, sem `grantRole` possível — `renounceRole(DEFAULT_ADMIN_ROLE)` pelo Timelock após deploy).

### 3. GOV "cap imutável" é diluível por voto (C)

`GovernanceToken.mint` (`GovernanceToken.sol:85`) é `onlyOwner` = Timelock, sem cronograma, sem teto por período. Supply hoje ≈ 1M (dev). Maioria simples aprova `mint(atacante, 99M)` → controla a DAO para sempre, colateraliza projetos de graça, satisfaz qualquer `minInvestWeight`. Docs: "supply é cap imutável de 100M, nunca inflacionado" — o cap é imutável; o supply circulante não.

**Correção:** cronograma de emissão on-chain (ou mint único no deploy + `renounceOwnership`), e `GovernanceToken` no conjunto supermajority.

### 4. D1 contornável com uma carteira; D2/D4 sybil-infláveis (A)

`FeeRouterV2.sol:253`: `selfPayment = (msg.sender == appRecipient || msg.sender == projectOwner)`. Basta o owner pagar de **qualquer outra carteira** (B) para o próprio app (A): `selfPayment=false`, `grossVolumeOf`, `uniquePayersOf` e `_recentVolume` são creditados (`:280`). `toApp` volta para o owner; `revShare` volta via `claim` se ele detém as shares (#5). Custo líquido = 2,5% do volume falso, igual ao parecer 2026-07-10. N carteiras novas → `uniquePayersOf = N` por gas.

Ou seja, o BRAIN diz "vetor wash-payment fechado nas 4 camadas"; o correto é: **D1 fecha só o caso literal de mesma carteira**; D2 e D4 mudam a *forma* do sinal (distintos / decaído) mas não o *custo* de forjá-lo. O que realmente encarece é (a) D3 quando aplicado a *quem paga*, o que não existe — `pay()` não exige stake; e (b) decaimento, que exige wash **contínuo** (2,5%/mês do volume que se quer exibir).

**Correções:** (i) documentar o custo real (2,5% do GMV exibido por meia-vida) em vez de "fechado"; (ii) ponderar `uniquePayersOf` por carteiras com histórico (idade, GOV, N pagamentos em projetos distintos) — sinal fora da chain ou via view composta; (iii) nunca indexar automação (recompra, grants) a nenhum desses três contadores sem custo de capital para o pagador.

### 5. Auto-rodada com uma única carteira (A)

`ProjectFunding.invest` (`:244`) não impede `msg.sender == owner` nem carteira do owner. `minTarget = 100e18` (`:125`) = 100 CREDIT ≈ US$100. Sequência: stake 100 GOV em `projectId` (lock 14d, peso 1× = `minInvestWeight`) → `openRound(target=100e18, revShare=1%)` → `invest(100e18)` da mesma carteira → `_fund` devolve os 100 CREDIT ao owner. Resultado: badge **Funded** na UI, `revShareBpsOf > 0`, custo ≈ gas + 100 GOV imobilizados 14 dias.

D3 ("força imobilizar GOV real por carteira sybil") pressupõe múltiplas carteiras; a auto-rodada precisa de **uma**. E a partir daí todo `pay()` de carteira-fantoche alimenta `totalRevenueDistributed`, que a UI mostra como "% retornado até agora" (`InvestView.vue:68-72`) — sinal de APR forjado que **nem D1 filtra** (self-payment ainda envia `revShare` ao `FUNDING`, `FeeRouterV2.sol:274`).

**Correções:** proibir `invest` de `owner`/`appRecipient`; exigir N investidores distintos mínimos e/ou cap por carteira (ex. 25% do target); `minTarget` maior em prod; excluir `selfPayment` de `notifyRevenue` (ou marcar separadamente).

### 6. UI e docs ainda apontam para o sinal washável (A)

- `stores/funding.ts:64` lê `grossVolumeOf`; `InvestView.vue:265` exibe "volume bruto". `recentVolumeOf`/`uniquePayersOf` estão na ABI (2 ocorrências em `abis.ts`) mas **nenhuma view os usa**.
- `04-metrics-that-matter.md`: "`grossVolumeOf` — a métrica-mãe… verificável on-chain, não autorreportado" — é exatamente a métrica que o parecer 2026-07-10 mandou rebaixar a auditoria.
- BRAIN §2 e §9 afirmam "UI/automação leem `recentVolumeOf`". Não leem.

**Correção:** trocar a leitura na store, exibir `recentVolumeOf` + `uniquePayersOf` com nota "sinal, não prova", regravar a página de métricas.

### 7. GOV stakeado não vota (A)

`Staking.sol` não contém `delegate` (grep = 0). Tokens transferidos ao contrato entram no `balanceOf(Staking)` do `ERC20Votes`, que nunca delega → **peso zero**. `TeamVesting` idem. Efeitos:
- Investidores (obrigados a stakear para investir/claimar) perdem voz de governança proporcionalmente ao compromisso. Inversão do objetivo "alinhar investidor e projeto".
- `GovernorVotesQuorumFraction` usa `getPastTotalSupply` → o quórum de 4% conta stake + vesting + treasury; com 60% travado, quem vota precisa de 10% do líquido. Favorece o holder que **não** participa.

**Correção:** `Staking` delegar para o staker (`IVotes(GOV).delegate` via sub-conta/ERC20Wrapper) ou o Governor usar `Staking.getGlobalWeightAt` como fonte de votos (os checkpoints por bloco já existem: `getWeightAt`, `getGlobalWeightAt`).

### 8. Supermaioria protege as chaves, não o cofre (A)

`CommunityGovernor.propose` marca Supermajority só se `target ∈ {TREASURY, timelock}` **e** selector ∈ {grantRole, revokeRole, renounceRole}. Em maioria simples + 2 dias ficam:
- `Treasury.transfer(token, atacante, tudo)` / `transferETH`;
- `FeeRouterV2.setRecipients(atacante, atacante, atacante)` — 100% da fee redirecionada;
- `FeeRouterV2.setFeeBps(500)` + `setVolumeHalfLife` + `ProjectFunding.setMinInvestWeight(0)` / `setMinTarget(1)`;
- `ProjectRegistry.removeProject(id, slash=true, treasury=atacante)` — colateral de qualquer projeto para qualquer endereço;
- `grantRole(GOVERNANCE_ROLE, atacante)` em Registry, FeeRouter, Funding, CreditToken (só Treasury/Timelock são checados);
- `TimelockController.updateDelay(0)` — self-call do Timelock, selector fora da lista → depois disso tudo é instantâneo.

**Correção:** lista de alvos sensíveis = todos os contratos com `GOVERNANCE_ROLE`/`DEFAULT_ADMIN_ROLE` + `updateDelay` + `setRecipients` + `mint*`; ou inverter: Standard só para uma allowlist de setters de parâmetro dentro de faixas.

### 9–13. Desenho do funding e staking (M)

- **#9** Sem teto de retorno nem prazo: `accRevenuePerShare` cresce para sempre. Incentivo de fuga do trilho (#1) cresce com o sucesso do app — o protocolo pune o app que dá certo.
- **#10** `openRound` exige `status == None` (`:208`); `Failed`/`Funded` são terminais. Um projeto sério que errou o alvo por 1% em 90 dias nunca mais capta; um projeto financiado nunca faz série B. Contradiz "ecossistema de projetos".
- **#11** `getWeight` (`Staking.sol:292`) = `amount × multiplier(lockDuration)`, sem olhar `lockStartAt`. Lock 365d dá 4× no bloco do stake e mantém 4× depois de destravado (até `unstake`). O gate de investir e o de claimar leem esse peso. `stake()` novo após expirar reseta `lockStartAt` sem custo.
- **#12** `ProjectRegistry.ownerRecipient` + `OWNER_RECIPIENT_TIMELOCK = 48h` (`:163`) não é chamado por nenhum outro contrato (grep). `FeeRouterV2.setAppRecipient` (`:347`) muda o destino do pagamento **na mesma tx** — o único timelock de proteção ao usuário/investidor é decorativo.
- **#13** `setProbation` → `isActive=false` → `pay()`, `stake()`, `invest()` revertem. Investidores da rodada `Funded` param de receber, e como `status != Removed`, `_unstake` continua exigindo lock vencido. "Probation" como aviso ao owner é, na prática, congelamento dos investidores.

### 14. Ambiente "produção" (M — conhecido)

`docker-compose.production.yml:641-675`: `web3c-hardhat` chain 31337 com RPC em `:8545` público, rate-limit só (o próprio comentário admite: "NAO impede um unico hardhat_reset ou hardhat_impersonateAccount"). `deploy-prod-sim.ts` usa `timelockSigner` impersonado, USDC mock com faucet (250 USDC/claim), 1M GOV para uma conta. Consequências além do DoS já mapeado:
- qualquer visitante executa **qualquer** ação de governança (impersonar Timelock), minta GOV/CREDIT, avança o tempo para vencer locks, zera a chain;
- CREDIT é grátis (faucet → PSM) → GMV/rev-share/`uniquePayers` exibidos no hub e a **ativação paga do cloud-terminal** (10 CREDIT) custam zero;
- o hub não sinaliza ao visitante que os números são de sandbox.

Não é falha de conceito do protocolo, mas é o ambiente onde o "objetivo" está sendo demonstrado — e ali ele é 100% burlável. Mínimo: proxy JSON-RPC com allowlist de métodos (`eth_*`, `net_*`, `web3_clientVersion`), banner "rede de demonstração" no hub.

### 15. Drift docs/UI (B)

- `03-risk-and-security.md`: "872 testes" — suite atual 386 (BRAIN). "Investir e sacar exigem `getWeight > 0`" — investir exige `>= minInvestWeight` desde D3.
- `InvestView.vue:281`: mostra o formulário de investir se `weight !== 0n`; contrato exige `>= 100e18` → usuário com 1–99 de peso assina tx que reverte (`InsufficientStakeWeight`), traduzida ou não em `errors.ts`.
- `02-value-accrual.md`: "o valor **nunca expira**" vs. `claim` exige `getWeight > 0` (`:362`). Quem destravou e sacou o GOV precisa re-stakear (≥1 wei, 14d) para claimar; se o projeto foi `Removed`, `stake()` reverte → pendente **inacessível para sempre**.
- Landing (`PaymentFlow3D`) mostra split 40/40/20 treasury/buyback/grants; no deploy os três destinatários são o **mesmo** `treasury` (`Dao.ts:152-154`). Buyback e grants são narrativa até existirem contratos.

### 16. Fórum e "comunidade" (B)

API `:5191`: `allowSignUp: true`, `canStartDiscussion: false` para anônimo (ok). Sem vínculo carteira↔conta Flarum: sinal social (posts, "apoio da comunidade" a uma rodada) é sybil livre. Estado atual: 2 discussões, 1 participante, autor = admin. Não é vulnerabilidade; é o lembrete de que o protocolo descreve uma DAO e o estado real é uma pessoa com 100% do GOV — qualquer parâmetro "governável" hoje é parâmetro do dev.

---

## O que NÃO encontrei

- Roubo direto de valor no `pay`/`invest`/`claim`/`refund`/PSM (conservação e CEI ok, `nonReentrant` em tudo que move token).
- Replay na ativação do cloud-terminal (`ActivationPayment.txHash` único, 409 em duplicata; carteira vinculada única por `sub`).
- Reentrância via `ERC777`-like: CREDIT/GOV são ERC20 OZ puros.

## Prioridade sugerida (pré-mainnet)

1. **#2 + #3 + #8** — um único pacote: allowlist de alvos supermajority ampliada, `mintGenesis` removido, PSM único minter sem `grantRole` possível, cronograma de GOV. Sem isso, "maioria simples de um token distribuído pela própria maioria" é o modelo de governança real.
2. **#1 + #9** — decidir o que rev-share **é** (perpétuo inexigível vs. participativo com teto e colateral em garantia). Isso muda o parecer jurídico também.
3. **#5 + #4 + #6** — fechar auto-rodada (owner não investe; N distintos), corrigir UI/docs para `recentVolumeOf`/`uniquePayersOf`, reescrever BRAIN §2 ("fechado" → "encarecido para 2,5%/meia-vida").
4. **#7** — votos do stake.
5. **#10–#13** — reabertura de rodada, peso com expiração, remover `ownerRecipient` morto ou fazer o router usá-lo, Probation sem congelar investidor.
6. **#14** — filtro de método no RPC + banner sandbox.

Sims reproduzíveis dos custos de #4/#5 podem ser adicionadas em `sim/` reaproveitando `sybil-cost-sim.js` (parametrizar N carteiras pagadoras = 1 e owner-invest = true).
