# Fluxo de valor

**Para quem é:** leitor querendo entender por onde o valor real entra, transita e sai do protocolo.
**Pré-requisitos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Treasury e fees](../02-core-concepts/07-treasury-and-fees.md).

## De onde vem o valor real

A única fonte de **valor externo** no sistema é o usuário final que paga por CREDIT. Ele paga porque precisa usar os apps. Se ninguém quer usar os apps, ninguém compra CREDIT, e o sistema morre — essa é a invariante dura.

O caminho típico:

```
   [ Usuario Charlie ]
        |
        |  1. Compra 1000 CREDIT na DEX externa por $X em USDC
        |     (liquidez fornecida por quem tem CREDIT e quer sair,
        |      ou por liquidity mining off-protocol — nao esta aqui dentro)
        |
        v
   [ Carteira Charlie tem 1000 CREDIT ]
        |
        |  2. Usa o Chat App. App cobra 1000 CREDIT pelo servico.
        |     Charlie assina approve(feeRouter, 1000) + feeRouter.pay(...)
        |
        v
   [ FeeRouter ]
        |
        | split 95/0/5 default
        |
        +-------> 950 CREDIT queimados (via BurnTracker)
        |         - CREDIT.totalSupply diminui
        |         - burn registrado no BurnTracker para o Chat App
        |
        +-------> 50 CREDIT -> app owner (rebate direto)
```

**O valor real entrou no protocolo na etapa 1.** Todas as etapas subsequentes redistribuem esse valor. Nenhuma delas cria valor do nada.

## Os 4 agentes e por que cada um está no jogo

```
   +----------------+     +-----------------+     +----------------+     +-------------+
   | Usuario final  |     |      App        |     |     Staker     |     |   Holder    |
   |   (Charlie)    |     |   (ChatApp)     |     |    (Alice)     |     |  sem stake  |
   +--------+-------+     +--------+--------+     +--------+-------+     +------+------+
            |                      |                       |                    |
     paga em CREDIT         recebe rebate +          trava GOV num         poder de voto
     usa o app              captura rewards          projectId +           no Governor
                            se stakar no proprio     ganha CREDIT
                            projeto                  na rodada R+1
            |                      |                       |                    |
     extrai valor           captura caixa             ganha CREDIT         mantem direito
     de servico             operacional +             recem-emitido        sobre mudancas
     (fora do               emissao direcionada                            de parametros
     protocolo)
```

Perceba: **não há yield "do ar"**. O CREDIT emitido para Alice existe porque Charlie queimou CREDIT. O rebate para o ChatApp existe porque Charlie pagou. Nenhum ator recebe valor que não veio de algum ator a montante.

## As 3 fontes de receita de um app

O split default de 5% direto parece pouco. Mas a conta fecha — se o app também stakar no próprio projeto — por três vetores simultâneos:

### (A) Rebate direto

5% de cada pagamento. Instantâneo, em CREDIT. É o fluxo de caixa operacional.

### (B) Emissão via stake no próprio `projectId`

Se o app adquiriu GOV (por exemplo, comprando em DEX ou recebendo via proposta de distribuição) e stakou em `projectId = próprio`, ele captura parte da share de rewards daquele projeto na rodada seguinte.

Como?

1. Quando Charlie paga, 95% é queimado e vai para `burnByRoundProject[R][projectId=app]`.
2. Na rodada R+1, a emissão é proporcional a esse burn.
3. Se o app tem peso de staking dentro do próprio `projectId`, ele recebe parte dessa emissão.

**Exemplo numérico** (rodada hipotética):

- ChatApp movimenta 600.000 CREDIT em pagamentos na rodada R-1.
- (A) Rebate direto: 5% × 600k = **30.000 CREDIT** imediato.
- Na rodada R, `projectShare_ChatApp = 902.500 × 600k/950k = 570.000 CREDIT`.
- Se o ChatApp stakou 50k GOV com lock de 365d (multiplier 4x, peso 200k), e o peso total no projeto é 400k, ele captura 50% × 570k = **285.000 CREDIT**.
- Soma (A) + (B) = **315.000 CREDIT** de um volume bruto de 600k = **~52,5%** efetivo.

O split **nominal** conta história enganosa. O split **econômico efetivo** para um app que também stake depende de quanto ele stake e da concorrência de outros stakers no mesmo `projectId`.

### (C) Apreciação do CREDIT retido

Como `alpha < 1`, o supply de CREDIT cai se o uso se mantiver constante. O CREDIT que o app recebeu (rebate + rewards) e ainda não vendeu tende a apreciar em termos reais — desde que a demanda por CREDIT (gerada pelo uso dos apps) se sustente.

**Armadilha**: se o app vende todo o CREDIT imediatamente, ele abre mão de (C). Se retém, expõe-se a volatilidade. É decisão do app.

## Quando (B) não fecha a conta

Apps sem capital para adquirir GOV não capturam (B). Para esses casos:

- O split default (95/0/5) pode ser **desincentivador**.
- A DAO pode aprovar `setProjectSplit(projectId, custom)` via proposta. Por exemplo: `8000/0/2000` (20% rebate) para apps estratégicos que não conseguem stakar.
- Alternativamente, pode-se financiar aquisição inicial de GOV via `Treasury` (proposta de transferência direta).

A arquitetura permite ajuste por projeto exatamente para esse tipo de acomodação.

## Fluxo por ciclo de rodada

```
   Rodada R-1 (a que passou)                                 Rodada R (agora)
   +------------------------------------+                   +------------------------------------+
   | Charlie + 10k outros usuarios       |                  | Alice pode claim rewards de R-1 em |
   | pagaram em CREDIT nos apps          |                  | funcao de:                         |
   |                                     |                  |   - burn total de R-1              |
   | BurnTracker registrou:              |  closeRound()    |   - burn do projeto dela em R-1    |
   |   totalBurnByRound[R-1] = 950_000   |  --------->      |   - peso do stake dela             |
   |   burnByRoundProject[R-1][42] = 600_000                |                                    |
   +------------------------------------+                   +------------------------------------+
                                                                     |
                                                               finalizeRound(R-1)
                                                                     |
                                                                     v
                                                            emissao = min(
                                                                max(0.95 * 950_000, floor(R-1)),
                                                                capMax
                                                            ) = 902_500 CREDIT (no exemplo)

                                                            roundData[R-1].totalEmission = 902_500
                                                            roundData[R-1].snapshotBlock = block.number

                                                            Stakers podem claim:
                                                              project_share(42) = 902_500 * 600k/950k = 570k
                                                              alice_claim = 570k * aliceW/projectW
```

## Rotação de CREDIT

CREDIT entra no supply por **duas** vias apenas:

1. `CreditToken.mintGenesis` — one-shot, 10M para o Treasury, no deploy.
2. `CreditToken.mint` — pelo `RewardDistributor`, nos claims.

E sai por **uma** via:

- `CreditToken.burn` / `burnFrom` / `burnByRole` — principal caminho é via `FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole`.

Esse fluxo fechado permite análise simples:

```
   totalSupply_R = totalSupply_{R-1} + (novas emissoes em R) - (burns em R)
```

Se `novas emissoes <= burns`, o supply cai. Com `alpha = 0.95` e uso estável, essa é a dinâmica esperada.

## Rotação de GOV

GOV entra no supply de forma permanente até atingir o cap:

1. Genesis: 0 no deploy.
2. `mint`: apenas pelo owner (Timelock em produção) até atingir `CAP_SUPPLY = 100M`.
3. Após atingir o cap, `mint` reverte com `CapExceeded`.

Não há burn de GOV no código.

Circulação:

- **Holder livre** → compra/venda em DEX.
- **Holder → Staking**: `stake` trava GOV no contrato; `unstake` libera.
- **Holder → Registry**: `registerProject` trava GOV como colateral; `removeProject` libera (para owner ou treasury).
- **Holder → TeamVesting (via Timelock)**: vesting contracts que liberam gradualmente.
- **Holder → Governor**: `delegate` não move GOV, só confere poder de voto.

## O papel do Treasury nesse fluxo

O Treasury é o **amortecedor** do sistema. Ele:

- Recebe o genesis de CREDIT (10M).
- Pode receber `treasuryBps` dos pagamentos (0% no default).
- Recebe colateral de projetos removidos com slash.
- Pode ser financiado por buyback de GOV (via `executeBuyback`, stub no v1).

E distribui, via propostas:

- Subsídios para usuários novos (`UserSubsidy`).
- Vesting para o time (`TeamVesting`).
- Pagamento de rebates batch para apps.
- Financiamento de operações off-chain.

O Treasury **não** é distribuído automaticamente. Tudo sai por proposta.

## Invariante econômica de saúde

Um sinal simples de saúde do protocolo: **burn acumulado precisa crescer mais rápido do que emissão acumulada**, ao longo de rodadas. Como `alpha < 1` garante `emissão_R ≈ 0.95 × burn_{R-1}`, essa inequação se satisfaz automaticamente enquanto:

```
burn_R >= burn_{R-1}
```

Ou seja: o protocolo está saudável enquanto o uso real está se mantendo ou crescendo. Se burn cai, emissão cai junto, mas a razão `emissão/burn` permanece constante em `alpha`. O sintoma terminal é burn absoluto indo a zero por muitas rodadas consecutivas.

Métricas completas em [Métricas que importam](../06-for-investors/04-metrics-that-matter.md).

---

**Próximo →** [Como participar](../04-for-users/01-participate.md)
