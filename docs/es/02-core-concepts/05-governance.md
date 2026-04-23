# Gobernanza

**Audiencia:** quien quiera entender **cómo** toma decisiones la DAO.
**Requisitos previos:** [Modelo mental](../01-getting-started/02-mental-model.md).

## Separación de poderes

La gobernanza de web3community tiene **tres** componentes con roles distintos:

```
  Tenedores de GOV       CommunityGovernor       CommunityTimelock
  (con delegacion)        (urna electronica)     (ejecutor con delay)

  - tienen voting    ->  - recibe propuesta ->   - retiene 2 dias
    power                - abre ventana          - ejecuta contra
  - delegan a si         - cuenta votos            contratos objetivo
    o a terceros         - decide resultado
```

Ninguno de los tres puede actuar solo:

- **Governor** no ejecuta nada — solo agenda en el Timelock.
- **Timelock** no decide nada — solo ejecuta lo que fue agendado tras el delay.
- **Los holders de GOV** votan pero no pueden llamar funciones directas de los contratos económicos.

## Por qué tres etapas

### Threshold (entrada)

Para crear una propuesta, el proponente necesita tener al menos `proposalThreshold` de voting power delegado. En producción: `10.000 GOV` (0.01% del cap). Impide spam de propuestas por cuentas sin skin in the game.

### Quorum (participación mínima)

Una propuesta solo vence si alcanza quorum **y** tiene más `For` que `Against`. Quorum en producción: **4%** del supply total al bloque del snapshot. Evita que una minoría activa apruebe algo radical mientras la mayoría duerme.

### Delay total (ventana de respuesta)

Desde el momento de proponer hasta el momento de ejecutar, pasan aproximadamente:

- `votingDelay` — 7200 bloques (~1 día a 12s/bloque)
- `votingPeriod` — 50400 bloques (~7 días)
- `timelockMinDelay` — 172800 segundos (2 días)

Suma ~10 días. Durante ese tiempo, cualquier holder puede:

- Examinar la propuesta on-chain.
- Delegar votos para rechazar.
- Organizar respuesta off-chain.
- Salir de la posición si discrepa.

Si una propuesta maliciosa pasa, aún hay 2 días tras la aprobación para acción (retirar fondos, cancelar vía minoría bloqueadora en propuesta contraria, etc.).

## Lo que controla la DAO

**Todo** lo que afecta al protocolo económicamente pasa por propuesta. Listado completo en [Parámetros](../07-governance/03-parameters.md). Resumen:

| Contrato | Parámetros controlados |
|---|---|
| `ProjectRegistry` | `registerProject`, `activateProject`, `setProbation`, `reactivate`, `removeProject`, `setMinCollateral`, `setProbationDuration` |
| `Treasury` | `transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH` |
| `BurnTracker` | `closeRound`, `setRoundDuration`, `setMaxBurnPerRoundPerProject` |
| `RewardDistributor` | `setAlpha`, `setCapMax` |
| `FeeRouter` | `setDefaultSplit`, `setProjectSplit`, `clearProjectSplit` |
| `UserSubsidy` | `createCampaign`, `closeCampaign` |
| `GovernanceToken` | `mint` (vía `Ownable2Step`, owner = Timelock) |
| `TeamVesting` | `revoke` (owner = Timelock) |

## Lo que la DAO **no** controla

Decisiones que la DAO **no puede tomar** incluso con 100% de los votos:

- **Aumentar el cap de GOV**. El cap (100M) es `immutable` en `GovernanceToken.CAP_SUPPLY`.
- **Remover el `MIN_LOCK` del Staking** (14 días). Es `constant` y protege a los stakers contra la propia gobernanza.
- **Cambiar la ventana `[MIN_ROUND_DURATION, MAX_ROUND_DURATION]`** (1 día a 30 días).
- **Cambiar `[MIN_ALPHA, MAX_ALPHA]`** (0.5 a 1.1) o `[MIN_CAPMAX, MAX_CAPMAX]` (1 a 100M CREDIT).
- **Alterar `floorSchedule`**. Grabado en el storage del `RewardDistributor` en el deploy, sin función de write.
- **Cambiar la dirección de cualquier contrato económico**. Si la DAO necesita "sustituir" un contrato, necesita deployar uno nuevo y migrar roles — la arquitectura no prevé upgrade in-place.

La inmutabilidad de esas reglas es un compromiso: **ni siquiera la DAO unánime puede quebrar los derechos que el usuario vio en el deploy**. Es la base de confianza que permite que los stakers inmovilicen capital.

## Quién es dueño de qué

Post-deploy, después de todos los handoffs:

| Recurso | Owner/Admin |
|---|---|
| `GOVERNANCE_ROLE` en todos los contratos económicos | `CommunityTimelock` |
| `DEFAULT_ADMIN_ROLE` en todos los contratos con AccessControl | `CommunityTimelock` |
| `owner` del `GovernanceToken` | `CommunityTimelock` (tras `acceptOwnership`) |
| `owner` de cada `TeamVesting` | `CommunityTimelock` |
| `PROPOSER_ROLE` + `CANCELLER_ROLE` en el `CommunityTimelock` | `CommunityGovernor` |
| `EXECUTOR_ROLE` en el `CommunityTimelock` | `address(0)` — cualquiera ejecuta tras el delay |
| `DEFAULT_ADMIN_ROLE` en el `CommunityTimelock` | **Self** (el propio Timelock) |
| `MINTER_ROLE` en el `CreditToken` | `RewardDistributor` |
| `BURNER_ROLE` en el `CreditToken` | `BurnTracker` |
| `RECORDER_ROLE` en el `BurnTracker` | `FeeRouter` (y cada nueva app listada lo recibe vía propuesta) |

El deployer **renuncia a todas las roles** al final del deploy. Tras eso, no tiene más poder que cualquier holder de GOV.

## Rol de ERC20Votes

El `GovernanceToken` hereda `ERC20Votes`. Eso añade dos funciones críticas para la gobernanza:

- `delegate(delegatee)` — cada holder necesita **delegar** voting power, incluso a sí mismo. Si nadie delega, `getVotes` retorna cero y el Governor no cuenta.
- `getPastVotes(account, blockNumber)` — retorna el voting power en un bloque pasado. **Esta** es la función que el Governor usa para contar votos — inmune a flash-loans.

**Ataque flash-loan mitigado**: un atacante que hace flash-loan de GOV en el bloque de apertura de la votación no consigue votar, porque `getPastVotes` consulta el bloque `snapshot = proposalSnapshot(proposalId)` que está en el pasado (`votingDelay` atrás).

## Contratos clave

| Contrato | Rol |
|---|---|
| [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md) | Fuente de voting power |
| [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md) | Urna |
| [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md) | Executor con delay |

---

**Siguiente →** [Project whitelist](06-project-whitelist.md)
