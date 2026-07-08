# Dual-token: GOV e CREDIT

**Para quem é:** qualquer pessoa que queira entender a base econômica antes de qualquer outro detalhe.
**Pré-requisitos:** [Modelo mental](../01-getting-started/02-mental-model.md).

O protocolo tem dois tokens porque tenta resolver dois problemas que um token só não resolve bem.

## Os dois problemas

1. **Quem decide os rumos do protocolo?** Precisa de um instrumento escasso, não manipulável no curto prazo, com peso proporcional ao investimento que alguém tem no projeto. Responde: **GOV**.

2. **Qual é a moeda usada dentro dos apps?** Precisa de um instrumento que queime quando usado (para criar pressão deflacionária que recompense retenção) e que possa ser cunhado como reward quando o uso gera valor. Responde: **CREDIT**.

Usar o mesmo token para os dois cria dissonância: ou você queima token de votação (rui governança) ou você dá direito de voto a quem acabou de gastar (rui separação de poderes).

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
| Mint subsequente | apenas `MINTER_ROLE` | concedida ao `RewardDistributor` (V1) no deploy; o `RewardDistributorV2` é o **minter alvo** — durante a migração de 4 rounds coexistem dois minters, até governança revogar a role do V1 |
| Burn | via `burn`, `burnFrom` (ERC20Burnable) **ou** `burnByRole` | `burnByRole` sem allowance, exige `BURNER_ROLE` |

**Por que não tem supply cap hardcoded?**

Porque o cap efetivo é **econômico**, não sintático. Quem tem `MINTER_ROLE` é o `RewardDistributor`, e a função `mint` dele é gated pela fórmula:

```
emissao_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

com `alpha <= 0.99` (teto reduzido de `1.1` para garantir IE1 por construção — ver `audit/economist/2026-04-22-consistency-audit.md` C2), `capMax <= 100M CREDIT` por rodada e `floor` decrescente que zera após a rodada 23. Logo: a emissão é **limitada pelo consumo passado** e por um teto duro ajustável via governança, e **estritamente deflacionária em regime estável** porque `alpha < 1` é invariante permanente por código. Um cap hardcoded no token seria redundante, e inflexível para ajustes econômicos futuros.

Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## Assimetrias importantes

| Dimensão | GOV | CREDIT |
|---|---|---|
| Oferta | Fixa (cap imutável) | Elástica (governança ajusta fórmula) |
| Função política | Vota, delega, cumula peso | Não vota |
| Queimável no uso? | Não | Sim, via `FeeRouter.pay` |
| Reward de stake em | — (GOV não é emitido como reward) | Sim (mint pelo `RewardDistributor`) |
| Direção do valor | Tende a apreciar com crescimento agregado | Tende a desinflacionar com uso constante |

Estas diferenças não são decoração — elas modelam a separação entre "quem decide" e "quem usa". A DAO (via GOV) delibera parâmetros que afetam CREDIT, mas não vice-versa.

## Contratos-chave

| Contrato | Papel |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | GOV ERC20Votes |
| [CreditToken](../08-contracts-reference/02-CreditToken.md) | CREDIT ERC20Burnable com roles |
| [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md) / [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md) | `MINTER_ROLE` em CREDIT — V1 recebe no deploy; V2 é o minter alvo (dois minters durante a migração de 4 rounds, V1 vira claim-only e perde a role após o cutoff) |
| [BurnTracker](../08-contracts-reference/06-BurnTracker.md) | `BURNER_ROLE` em CREDIT para o burn de uso (via `FeeRouter`); o [Treasury](../08-contracts-reference/04-Treasury.md) também recebe `BURNER_ROLE` (via proposta) para queimar o CREDIT comprado no buyback FFP |
| [FeeRouter](../08-contracts-reference/08-FeeRouter.md) | Entrypoint de pagamento que aciona o burn |

---

**Próximo →** [Directed staking](02-directed-staking.md)
