# Doble token: GOV y CREDIT

**Audiencia:** cualquier persona que quiera entender la base económica antes de cualquier otro detalle.
**Requisitos previos:** [Modelo mental](../01-getting-started/02-mental-model.md).

El protocolo tiene dos tokens porque intenta resolver dos problemas que un solo token no resuelve bien.

## Los dos problemas

1. **¿Quién decide los rumbos del protocolo?** Hace falta un instrumento escaso, no manipulable en el corto plazo, con peso proporcional a la inversión que alguien tiene en el proyecto. Responde: **GOV**.

2. **¿Cuál es la moneda usada dentro de las apps?** Hace falta un instrumento que se queme cuando se usa (para crear presión deflacionaria que recompense la retención) y que pueda acuñarse como reward cuando el uso genera valor. Responde: **CREDIT**.

Usar el mismo token para los dos crea disonancia: o quemas el token de votación (malo para la gobernanza) o das derecho a voto a quien acaba de gastar (malo para la separación de poderes).

## GOV — gobernanza y peso de largo plazo

| Propiedad | Valor | Fuente |
|---|---|---|
| Nombre en producción | Web3Community Governance | `ignition/parameters/production.json` |
| Símbolo | GOV | idem |
| Supply cap | 100.000.000 (inmutable) | `GovernanceToken.CAP_SUPPLY` |
| Estándar | ERC-20 + ERC20Permit + ERC20Votes | herencia en `GovernanceToken` |
| Minter | solo el `owner` actual (`Ownable2Step`) | `GovernanceToken.mint()` |
| Owner en producción | `CommunityTimelock` | handoff en el deploy |
| ¿Quemable? | No | no hereda `ERC20Burnable` |

**Cómo entra en circulación**: cero en el deploy. Cada unidad de GOV solo existe porque alguien llamó a `mint(to, amount, tag)` — en producción eso solo ocurre vía propuesta aprobada en el Governor, porque el owner es el Timelock. La asignación completa (treasury, equipo vía `TeamVesting`, venta pública, community rewards, liquidez) ocurre en propuestas separadas, documentables y auditables.

**Uso**:

1. **Votar**: basta con delegar a ti mismo (`delegate(self)`) o a otro vía `GovernanceToken.delegate`. Voting power se lee vía `getPastVotes(account, snapshotBlock)` — inmune a flash-loans.
2. **Stakear**: llamar a `Staking.stake(projectId, amount, lockDuration)`. GOV va al contrato y genera peso proporcional.
3. **Servir de colateral para listar un proyecto**: el owner de un nuevo proyecto bloquea GOV como colateral en el `ProjectRegistry` (mínimo 10.000 GOV en producción, ajustable vía gobernanza).

Ver [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) para la referencia completa.

## CREDIT — moneda operacional de la plataforma

| Propiedad | Valor | Fuente |
|---|---|---|
| Nombre en producción | Web3Community Credit | `ignition/parameters/production.json` |
| Símbolo | CREDIT | idem |
| Supply cap hardcodeado | **No existe** | `CreditToken` no aplica cap |
| Estándar | ERC-20 + ERC20Burnable + AccessControl | herencia en `CreditToken` |
| Genesis | 10.000.000 CREDIT a `Treasury`, one-shot — el valor es **parámetro de deploy** (`genesisAmount` en `ignition/parameters/production.json`), no hardcodeado en el contrato | `mintGenesis`, flag `genesisMinted` |
| Mint posterior | solo `MINTER_ROLE` | concedido al `RewardDistributor` (V1) en el deploy; el `RewardDistributorV2` es el **minter objetivo** — durante la migración de 4 rondas coexisten dos minters, hasta que la gobernanza revoque la role del V1 |
| Burn | vía `burn`, `burnFrom` (ERC20Burnable) **o** `burnByRole` | `burnByRole` sin allowance, exige `BURNER_ROLE` |

**¿Por qué no tiene supply cap hardcodeado?**

Porque el cap efectivo es **económico**, no sintáctico. Quien tiene `MINTER_ROLE` es el `RewardDistributor`, y su función `mint` está gated por la fórmula:

```
emissao_R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

con `alpha <= 0.99` (techo reducido de `1.1` para garantizar IE1 por construcción — ver `audit/economist/2026-04-22-consistency-audit.md` C2), `capMax <= 100M CREDIT` por ronda y `floor` decreciente que se pone a cero después de la ronda 23. Por lo tanto: la emisión está **limitada por el consumo pasado** y por un techo duro ajustable vía gobernanza, y **estrictamente deflacionaria en régimen estable** porque `alpha < 1` es invariante permanente por código. Un cap hardcodeado en el token sería redundante, e inflexible para ajustes económicos futuros.

Ver [CreditToken](../08-contracts-reference/02-CreditToken.md).

## Asimetrías importantes

| Dimensión | GOV | CREDIT |
|---|---|---|
| Oferta | Fija (cap inmutable) | Elástica (la gobernanza ajusta la fórmula) |
| Función política | Vota, delega, acumula peso | No vota |
| ¿Quemable en el uso? | No | Sí, vía `FeeRouter.pay` |
| Reward de stake en | — (GOV no se emite como reward) | Sí (mint por el `RewardDistributor`) |
| Dirección del valor | Tiende a apreciar con el crecimiento agregado | Tiende a desinflacionarse con uso constante |

Estas diferencias no son decoración — modelan la separación entre "quien decide" y "quien usa". La DAO (vía GOV) delibera parámetros que afectan a CREDIT, pero no al revés.

## Contratos clave

| Contrato | Rol |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | GOV ERC20Votes |
| [CreditToken](../08-contracts-reference/02-CreditToken.md) | CREDIT ERC20Burnable con roles |
| [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md) / [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md) | `MINTER_ROLE` en CREDIT — V1 lo recibe en el deploy; V2 es el minter objetivo (dos minters durante la migración de 4 rondas, V1 pasa a claim-only y pierde la role tras el cutoff) |
| [BurnTracker](../08-contracts-reference/06-BurnTracker.md) | `BURNER_ROLE` en CREDIT para el burn de uso (vía `FeeRouter`); el [Treasury](../08-contracts-reference/04-Treasury.md) también recibe `BURNER_ROLE` (vía propuesta) para quemar el CREDIT comprado en el buyback FFP |
| [FeeRouter](../08-contracts-reference/08-FeeRouter.md) | Entrypoint de pago que acciona el burn |

---

**Siguiente →** [Directed staking](02-directed-staking.md)
