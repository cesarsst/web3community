# Dual-token: GOV e CREDIT

**Para quem é:** qualquer pessoa que queira entender a base econômica antes de qualquer outro detalhe.
**Pré-requisitos:** [Modelo mental](../01-getting-started/02-mental-model.md).

> **Remodel 2026-07-08**: esta página descreve o modelo vigente — CREDIT estável 1:1 com USDC via [CreditPSM](../08-contracts-reference/15-CreditPSM.md); o desenho deflacionário (burn-to-mint) virou legado.

O protocolo tem dois tokens porque tenta resolver dois problemas que um token só não resolve bem.

## Os dois problemas

1. **Quem decide os rumos do protocolo — e quem captura o crescimento dele?** Precisa de um instrumento escasso, não manipulável no curto prazo, com peso proporcional ao investimento que alguém tem no projeto. Responde: **GOV**.

2. **Qual é a moeda usada dentro dos apps?** Precisa de um instrumento **estável e previsível** — ninguém precifica serviço em moeda volátil. Responde: **CREDIT**, estável 1:1 com USDC via [CreditPSM](../08-contracts-reference/15-CreditPSM.md) (compra e resgate sem taxa, lastro 100% retido no contrato).

Usar o mesmo token para os dois cria dissonância: ou a moeda de pagamento flutua com especulação de governança (rui a precificação dos apps) ou você dá direito de voto a quem acabou de gastar (rui separação de poderes). A separação vigente é limpa: **CREDIT é trilho de pagamento estável; GOV é quem captura o crescimento** — 40% da fee de cada pagamento (1% do GMV) financia buyback contínuo de GOV via [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md).

## GOV — governança e peso de longo prazo

| Propriedade | Valor | Fonte |
|---|---|---|
| Nome em produção | Web3Community Governance | `ignition/parameters/production.json` |
| Símbolo | GOV | idem |
| Supply cap | 100.000.000 (imutável) | `GovernanceToken.CAP_SUPPLY` |
| Padrão | ERC-20 + ERC20Permit + ERC20Votes | herança em `GovernanceToken` |
| Minter | apenas o `owner` atual (`Ownable2Step`) | `GovernanceToken.mint()` |
| Owner em produção | `CommunityTimelock` | handoff no deploy |
| Queimável? | Não | não herda `ERC20Burnable` |

**Como entra em circulação**: zero no deploy. Cada unidade de GOV só existe porque alguém chamou `mint(to, amount, tag)` — em produção isso só acontece via proposta aprovada no Governor, porque o owner é o Timelock. A alocação completa (treasury, equipe via `TeamVesting`, venda pública, community rewards, liquidez) acontece em propostas separadas, documentáveis e auditáveis.

> **Atenção — contratos pendentes de design.** A alocação "completa" descrita acima é **intenção**, não estado atual do repo. `TeamVesting` (1 instância por beneficiário) e `UserSubsidy` (singleton Merkle) existem no repo. Os contratos de **venda pública (`Sale`), provisão de liquidez (`LiquidityBootstrappingPool` / `LiquidityManager`) e liquidity-mining (`LPRewards`) NÃO existem no repo atual** — precisam ser desenhados, auditados e deployados antes das propostas correspondentes. Detalhamento operacional em [Tokenomics](../06-for-investors/01-tokenomics.md) e no README §7.

**Uso**:

1. **Votar**: basta delegar a si mesmo (`delegate(self)`) ou a outrem via `GovernanceToken.delegate`. Voting power é lido via `getPastVotes(account, snapshotBlock)` — imune a flash-loans.
2. **Stakar**: chamar `Staking.stake(projectId, amount, lockDuration)`. GOV vai para o contrato e gera peso proporcional.
3. **Servir de colateral para listar um projeto**: o owner de um novo projeto tranca GOV como colateral no `ProjectRegistry` (mínimo 10.000 GOV em produção, ajustável via governança).

Ver [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) para referência completa.

## CREDIT — moeda operacional da plataforma

| Propriedade | Valor | Fonte |
|---|---|---|
| Nome em produção | Web3Community Credit | `ignition/parameters/production.json` |
| Símbolo | CREDIT | idem |
| Supply cap hardcoded | **Não existe** | `CreditToken` não aplica cap |
| Padrão | ERC-20 + ERC20Burnable + AccessControl | herança em `CreditToken` |
| Genesis | 10.000.000 CREDIT para `Treasury`, one-shot — o valor é **parâmetro de deploy** (`genesisAmount` em `ignition/parameters/production.json`), não hardcoded no contrato | `mintGenesis`, flag `genesisMinted` |
| Mint vigente | `MINTER_ROLE` no **CreditPSM** — minta 1:1 contra USDC depositado (`buy`) | [CreditPSM](../08-contracts-reference/15-CreditPSM.md) |
| Burn vigente | `BURNER_ROLE` no **CreditPSM** — queima no resgate (`sell`, devolve USDC 1:1) | idem |
| Mint/burn legados | `RewardDistributor` V1/V2 (claims históricos) e `BurnTracker` (trilho de burn desativado de fato — o FeeRouterV2 não queima) | contratos seguem deployados |

**Por que não tem supply cap hardcoded?**

Porque o supply de CREDIT é **elástico por design, mas sempre lastreado**. Cada CREDIT mintado pelo PSM tem 1 USDC retido no contrato (invariante I-PSM1: `backing >= mintedOutstanding`, sem função de saque do lastro — nem para governança). O supply cresce quando há demanda de pagamento nos apps e encolhe quando usuários resgatam. Um cap hardcoded seria arbitrário: o limite real é o USDC que entra.

> **Legado**: no modelo pré-remodel, o cap era "econômico" via fórmula de emissão `min(max(alpha × burn, floor), capMax)` do `RewardDistributor`, com CREDIT deflacionário. Esse trilho está desativado como mecanismo vigente — ver [Burn-to-mint (legado)](03-burn-to-mint.md).

Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## Assimetrias importantes

| Dimensão | GOV | CREDIT |
|---|---|---|
| Oferta | Fixa (cap imutável 100M) | Elástica, 100% lastreada em USDC (PSM) |
| Função política | Vota, delega, cumula peso | Não vota |
| Preço | Flutua — captura crescimento do ecossistema | Estável: 1 CREDIT = 1 USDC, sempre (compra/resgate no PSM sem taxa) |
| Como captura valor | **Buyback contínuo**: 40% da fee do FeeRouterV2 (= 1% do GMV) financia recompra de GOV | Não captura — é trilho de pagamento |
| Papel do stake | Governança + curadoria + **gate de investimento** no [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) | Investível em rodadas de funding (rev-share de receita real) |

Estas diferenças não são decoração — elas modelam a separação entre "quem decide e captura valor" e "o que se usa para pagar". A DAO (via GOV) delibera parâmetros que afetam CREDIT, mas não vice-versa.

## Contratos-chave

| Contrato | Papel |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | GOV ERC20Votes |
| [CreditToken](../08-contracts-reference/02-CreditToken.md) | CREDIT ERC20Burnable com roles |
| [CreditPSM](../08-contracts-reference/15-CreditPSM.md) | Entrada/saída de CREDIT: USDC ↔ CREDIT 1:1, sem taxa, lastro integral |
| [FeeRouterV2](../08-contracts-reference/08b-FeeRouterV2.md) | Trilho de pagamento: fee 2,5% (40% treasury / 40% buyback GOV / 20% grants) + rev-share |
| [ProjectFunding](../08-contracts-reference/16-ProjectFunding.md) | Rodadas de captação com rev-share 1–30% — renda do investidor vem de receita real |
| [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md) / [V2](../08-contracts-reference/07b-RewardDistributorV2.md), [BurnTracker](../08-contracts-reference/06-BurnTracker.md), [FeeRouter V1](../08-contracts-reference/08-FeeRouter.md) | **Legado** — trilho burn-to-mint pré-remodel, contratos seguem deployados |

---

**Próximo →** [Directed staking](02-directed-staking.md)
