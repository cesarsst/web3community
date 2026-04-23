# Enviar un proyecto

**Audiencia:** dev/equipo que quiere listar una app nueva en el `ProjectRegistry`.
**Requisitos previos:** [Whitelist de proyectos](../02-core-concepts/06-project-whitelist.md), [Visión general de integración](01-integration-overview.md).

## Qué significa "listar"

Listar un proyecto en el Registry de web3community es:

1. Registrar el par `(owner, metadataURI)` y bloquear colateral en GOV.
2. Activar el proyecto (transitar de `Pending` a `Active`).
3. Garantizar que el `FeeRouter` (o el futuro contrato de la app) pueda llamar a `burnAndRecord` — es decir, que la app tenga `RECORDER_ROLE` donde haga falta.

El resultado: tu app aparece en el Registry, acepta pagos vía `FeeRouter.pay`, y genera burn rastreable para el `RewardDistributor`.

## Lo que necesitas antes

- **Ownership definido**: una dirección (EOA o multisig) que será `owner` del proyecto.
- **Colateral en GOV**: en producción, al menos `10.000 GOV` (`minCollateral`, ajustable). Lee el valor actual del Registry.
- **Metadata off-chain**: JSON estructurado, hosteado en IPFS/Arweave. El Registry almacena solo el URI.
- **Apoyo político**: alguien con ≥ 10.000 GOV delegados para submitir la propuesta.

## Formato de metadata

La metadata es off-chain. Convención recomendada (no enforceada on-chain):

```json
{
  "name": "ChatApp",
  "description": "Mensageria end-to-end encrypted com pagamento por mensagem",
  "icon": "ipfs://Qm...",
  "website": "https://chatapp.example",
  "contracts": {
    "main": "0x...",
    "frontend": "https://app.chatapp.example"
  },
  "contact": {
    "email": "team@chatapp.example",
    "discord": "..."
  },
  "pricing": [
    { "service": "envio de msg", "costCREDIT": "0.01" }
  ]
}
```

Tu UI y los exploradores pueden leerla. El Registry guarda solo el `metadataURI` (ej: `ipfs://Qm...`).

## Paso a paso completo

### 1. Preparar metadata

- Sube el JSON a IPFS o Arweave.
- Anota el CID / URI.

### 2. Obtener apoyo político

- Encuentra un holder de GOV (o agrega varios vía delegación) con ≥ `proposalThreshold` (10.000 GOV en producción).
- El apoyante será el `proposer` en el Governor.

### 3. Montar la propuesta

La propuesta debe incluir (como mínimo):

```solidity
targets   = [address(registry), address(registry)]
values    = [0, 0]
calldatas = [
    abi.encode(registry.registerProject.selector, ownerAddress, metadataURI, collateralAmount),
    abi.encode(registry.activateProject.selector, /* projectId sera atribuido dinamicamente */)
]
```

Problema: la propuesta **aún no sabe el `projectId`** (es asignado en `registerProject`). Dos estrategias:

**Estrategia A (dos propuestas)**:

1. Primera propuesta: `registerProject(owner, metadataURI, collateral)`. Tras ejecutar, lee el `projectId` asignado (vía evento `ProjectRegistered`).
2. Segunda propuesta: `activateProject(projectId)`.

**Estrategia B (una propuesta con pre-approve)**:

1. La propuesta incluye `activateProject` asumiendo el `projectId` que **será** asignado (ver `_nextProjectId` actual en el Registry). Requiere que ninguna otra propuesta de `registerProject` se intercale entre proponer y ejecutar — difícil de garantizar en teoría, pero aceptable en práctica si la volumetría de registros es baja.

En ambos casos, la propuesta también debe (probablemente) incluir:

- `burnTracker.grantRole(RECORDER_ROLE, <contrato_que_vai_chamar_burnAndRecord>)` — si la app va a llamar directamente. En el bootstrap de v1, el `FeeRouter` ya tiene ese role, y las apps llaman a `FeeRouter.pay` — por lo que este grant puede no ser necesario.

### 4. Approve del colateral

El `owner` del proyecto necesita haber hecho `GovernanceToken.approve(registry, collateralAmount)` **antes** de que la propuesta se ejecute. Puede hacerse en cualquier momento durante el ciclo de la propuesta, pero mejor antes para evitar una falla de ejecución.

### 5. Votación + ejecución

- Espera `votingDelay` (~1d en producción).
- Votación `votingPeriod` (~7d).
- Si vence: `queue` en el Timelock.
- Espera `minDelay` (2d).
- `execute` — la DAO llama a `registerProject` (vía Timelock), que hace pull del GOV colateral y asigna `projectId`.
- Segunda propuesta similar para `activateProject`.

### 6. Post-activación

Tras `activateProject`:

- `activatedAt = now`, `probationEndsAt = now + probationDuration` (30d en producción).
- `projectId` está `Active`.
- `FeeRouter.pay` funciona para él.
- Stake está permitido.
- **Durante 30 días**, el share de rewards queda dividido por 4 (probation inicial por tiempo).

Tras 30 días, la probation inicial expira automáticamente.

## Operaciones del owner tras el listado

Sin necesidad de gobernanza:

- `registry.updateMetadata(projectId, newURI)` — actualizar metadata.
- `registry.transferProjectOwnership(projectId, newOwner)` — iniciar transferencia 2-step.
- `registry.acceptProjectOwnership(projectId)` — aceptar (llamado por el nuevo owner).
- `feeRouter.setAppRecipient(projectId, recipient)` — setear destino del rebate.

Requieren gobernanza (propuesta + ejecución):

- Cualquier cambio de status (`setProbation`, `reactivate`, `removeProject`).
- Cualquier override de split (`setProjectSplit`, `clearProjectSplit`).
- `burnTracker.revokeRole(RECORDER_ROLE, ...)` — revocar role si es necesario.

## Costos totales

- **GOV collateral**: 10.000 GOV inmovilizados hasta `removeProject`.
- **Gas de propuesta**: pagado por el proposer.
- **Gas de ejecución**: pagado por quien llame a `execute` (cualquiera, 2 días tras el queue).

Costo total en gas: ~300-500k gas por propuesta típica.

## Problemas comunes

### La propuesta revierte con `InsufficientAllowance`

El owner del proyecto no aprobó al Registry, o la allowance es menor que `collateralAmount`. Solución: llama a `GOV.approve(registry, collateralAmount)` antes de la ejecución.

### La propuesta revierte con `InsufficientCollateral`

Pasaste `collateralAmount < minCollateral`. Consulta `registry.minCollateral()` para el valor actual.

### La propuesta revierte con `EmptyMetadataURI`

El string `metadataURI` no puede estar vacío. Pasa al menos un CID placeholder.

### La propuesta no alcanza quorum

- Aumenta engagement off-chain (forum, Discord).
- Aumenta el tiempo de campaña — propón de nuevo si la primera falló.
- Considera delegar voting power para aumentar el peso total apoyante.

---

**Siguiente →** [Consultar estado on-chain](04-querying-state.md)
