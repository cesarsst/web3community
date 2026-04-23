# Modelo de seguridad

**Audiencia:** auditores, seguridad ofensiva, investigadores.
**Requisitos previos:** conocimiento general de la arquitectura.

Este documento consolida invariantes, superficies de ataque identificadas y mitigaciones implementadas en los 12 contratos.

## Invariantes globales

### I1 — Cap de GOV

**Afirmación**: `GovernanceToken.totalSupply() <= CAP_SUPPLY = 100_000_000 * 1e18` en todo momento.

**Dónde se protege**: `GovernanceToken._update`. Para mint (from == 0), verifica `totalSupply + value <= CAP_SUPPLY`, si no revierte `CapExceeded`.

**Relacionada**: `_maxSupply()` sobrescrito para retornar CAP_SUPPLY, garantizando que los checks internos de ERC20Votes (uint208) también respeten.

### I2 — Burn en el consumo

**Afirmación**: todo CREDIT consumido en pagos es quemado vía `_burn` nativo, decrementando `totalSupply`. Ningún camino de `FeeRouter.pay` con `burnBps > 0` desvía a dead-address, treasury o remint.

**Dónde se protege**:

- `FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole`.
- `CreditToken.burnByRole` usa `_burn` nativo del ERC-20.

**Validación**: el test integrado valida decremento exacto en `totalSupply` para cada `burned`.

### I3 — Cap por ronda

**Afirmación**: la emisión de CREDIT por ronda nunca excede `capMax`. El burn por proyecto por ronda nunca excede `maxBurnPerRoundPerProject` (si > 0).

**Dónde se protege**:

- `RewardDistributor.finalizeRound`: `totalEmission = min(rawEmission, capMax)`.
- `BurnTracker.burnAndRecord`: revierte `SanityCapExceeded` si acumulado + amount > cap.

### I4 — Governance-only exit

**Afirmación**: toda función state-changing que mueve fondos (Treasury, Staking, etc.) o cambia parámetros económicos exige `GOVERNANCE_ROLE` (o Ownable2Step en el GOV). Ninguna EOA retiene poder unilateral post-handoff.

**Dónde se protege**:

- Los setters en los contratos económicos tienen `onlyRole(GOVERNANCE_ROLE)`.
- `GovernanceToken.mint` es `onlyOwner` (Ownable2Step).
- `TeamVesting.revoke` es `onlyOwner`.
- `DEFAULT_ADMIN_ROLE` fue transferido al Timelock en el deploy.

### I5 — Anti-flashloan en el voto

**Afirmación**: un flash-loan de GOV en el bloque de la votación no confiere voting power. Flash-stake en el bloque de `finalizeRound` no entra en el cálculo de share.

**Dónde se protege**:

- `Governor.castVote` lee `GovernanceToken.getPastVotes(account, proposalSnapshot)`.
- `RewardDistributor._calculateClaim` lee `Staking.getWeightAt(user, projectId, snapshotBlock)`.
- `snapshotBlock` se graba en bloque anterior al consultado.

### I6 — Lock mínimo

**Afirmación**: stake con lock por debajo de 14 días revierte. Unstake antes del lock en proyecto no-Removed revierte.

**Dónde se protege**:

- `Staking.stake` / `increaseStake` (indirectamente) revierte con `LockTooShort`.
- `Staking.unstake` revierte con `LockNotExpired` si `block.timestamp < unlockAt` y el proyecto no-Removed.

### I7 — Proyectos vía gobernanza

**Afirmación**: ningún proyecto entra en `Active` sin pasar por `GOVERNANCE_ROLE` (Timelock). Las operaciones dependientes de proyecto (`FeeRouter.pay`, `BurnTracker.burnAndRecord`, `Staking.stake`) verifican `isActive` antes.

**Dónde se protege**:

- `ProjectRegistry.registerProject` y `activateProject` son `onlyRole(GOVERNANCE_ROLE)`.
- Los callers verifican `isActive` y revierten con `ProjectNotActive`.

## Superficies de ataque y mitigaciones

### Reentrancy

**Vector**: ERC-20 custom con callbacks (ERC-777 legacy, tokens maliciosos) pudiendo reentrar en `transfer` / `approve`.

**Mitigación**: `ReentrancyGuard` en todas las funciones que mueven valor. Además, CEI estricto — effects antes de interactions.

**Contratos con guard**:

- `Treasury.transfer`, `batchTransfer`, `payRebates`, `executeBuyback`, `sweepETH`.
- `Staking.stake`, `increaseStake`, `extendLock`, `unstake`, `unstakeAll`.
- `BurnTracker.burnAndRecord`.
- `RewardDistributor.claim`, `claimMany`.
- `FeeRouter.pay`.
- `UserSubsidy.claim`, `closeCampaign`.

### Integer overflow / underflow

**Vector**: precisiones de punto flotante en cálculos de weight, share, emission.

**Mitigación**:

- Solidity 0.8.24 — checked arithmetic por default.
- `SafeCast` explícito en conversiones que pueden perder bits.
- Orden de las operaciones: multiplicar antes de dividir (preservar precisión).
- Bounds analíticos documentados en los contratos (ej: peso máximo en `Staking` cabe en uint208 con holgura).

### Denial of Service vía loops

**Vector**: funciones con loop sobre arrays controlados por el caller.

**Mitigación**:

- `Treasury.batchTransfer` / `payRebates`: arrays externos, pero el emisor es gobernanza (Timelock) — sin ataque práctico.
- `RewardDistributor.claimMany`: arrays externos, pero el caller paga el gas.
- Ninguna iteración sobre "todos los proyectos" o "todos los stakers" en camino on-chain.

### Front-running

**Vector**: el atacante observa mempool, somete tx con gas mayor para capturar valor.

**Mitigación**:

- Governance con `votingDelay` de ~1d — front-running directo de voto no funciona (voto vía snapshot pasado).
- `finalizeRound` es permissionless pero idempotente — front-run no trae ventaja (cualquiera puede finalizar, el resultado es el mismo).
- `FeeRouter.pay` no es atacable vía FR — `user` y `amount` son fijos, el split es determinístico.

### Ataques de sanity cap / cap económico

**Vector**: proyecto malicioso infla el burn para capturar share.

**Mitigación**:

- Sanity cap por `(ronda, proyecto)` — `SanityCapExceeded` si excede.
- `capMax` global en la emisión — clampea incluso con burn absurdo.
- Probation penalty de 25% en proyectos nuevos (primeros 30 días).

### Ataques vía colateral reutilizable

**Vector**: el owner del proyecto intenta reutilizar el colateral para múltiples listados.

**Mitigación**: cada `registerProject` exige colateral separado, pulleado vía `transferFrom`. Los saldos son custodiados por proyecto en el Registry.

### Ataques vía transferencia de ownership

**Vector**: transferencia accidental o maliciosa de ownership (GOV, proyecto, vesting).

**Mitigación**: `Ownable2Step` en GovernanceToken y TeamVesting; 2-step propio en ProjectRegistry.transferProjectOwnership. `newOwner` necesita aceptar explícitamente.

### Ataques vía recuperación de tokens perdidos

**Vector**: tokens enviados a contratos equivocados (ej: ERC-20 al `Staking` en vez de `stake`).

**Mitigación**: **ninguna en v1**. Decisión consciente — agregar `rescueTokens` crearía backdoor governance-accessible. Tokens perdidos quedan perdidos (y el costo educa a los usuarios). En caso de pérdida significativa, la DAO puede votar migración.

### Ataques vía upgrade

**Vector**: contrato upgradable con proxy puede ser cambiado maliciosamente.

**Mitigación**: **los contratos no son upgradables**. Ningún proxy. Cualquier sustitución exige deploy nuevo + propuesta para migrar roles/ownership.

### Ataques vía time / timestamp

**Vector**: miners/sequencers manipulan `block.timestamp`.

**Mitigación**:

- Lock, probation y vesting dependen de timestamps — manipulación en ±15s es irrelevante para ventanas de días/semanas.
- Governance usa `block.number` (clock), no timestamp — más resistente.

### Ataques vía signature replay

**Vector**: firmas EIP-712 reejecutadas en otro contrato / chain.

**Mitigación**:

- El domain separator incluye `chainId` vía OZ `EIP712` base.
- `nonces` en `ERC20Permit` y `ERC20Votes` invalidan reuso.
- Governor `castVoteBySig` usa nonce propio.

## Threat model

### Atacante externo sin GOV

- No puede proponer (threshold = 10k GOV delegado).
- Puede llamar a `FeeRouter.pay` (si tiene CREDIT y approve) — comportamiento esperado.
- Puede llamar a `finalizeRound` — comportamiento esperado.
- Puede llamar a `claim` — solo recibe si tiene peso en `(user, projectId)` en el snapshot.
- Puede enviar ETH al Treasury — donación.

**Ataque práctico**: ninguno directo.

### Atacante con GOV pero por debajo del threshold

- Puede votar en propuestas (si delegó).
- Puede stakear en proyectos.
- Puede `delegate` a otro.

**Ataque práctico**: coordinación con otros holders — comportamiento de gobernanza normal.

### Atacante con GOV por encima del threshold (~10k)

- Puede proponer cambios de parámetro dentro de los bounds.
- Puede proponer registro de proyectos (si tiene colateral aprobado).
- La propuesta aún necesita quorum (4% del supply) + For > Against.

**Ataque práctico**: spam de propuestas — cuesta gas de la submisión + presión social/política.

### Atacante con > 4% del supply

- Puede alcanzar quorum solo si el 100% del resto vota contra o se omite.
- Aún necesita For > Against — otros holders pueden bloquear.

**Mitigación**: distribución amplia del GOV en el bootstrap (ningún single holder > 25%).

### Atacante con > 50% del supply (governance capture)

- Puede aprobar cualquier propuesta dentro de los bounds on-chain.
- **No puede** romper invariantes inmutables (cap, MIN_LOCK, bounds de parámetros).
- **No puede** drenar fondos de stakers con lock vigente.

**Mitigación residual**: el delay del Timelock da 2 días para que los holders no atacantes respondan (salgan de posición, coordinen propuesta contraria, griten públicamente).

## Auditoría estática

Slither 0.11.5 corrido en todos los contratos. Resultados guardados en `audit/slither/`:

- `<Contract>.txt` — versión completa (incluye warnings en libs OZ).
- `<Contract>-projectonly.txt` — filtrado solo para código del proyecto.

Status en el momento de este doc: **cero findings high/medium** en el código del proyecto. Findings low/informational documentados y aceptados.

## Suite de tests

- Total: 462+ tests.
- Coverage: 100% statements, 99.84% lines.
- Tests integrados end-to-end en `test/ignition/Dao.test.ts`.
- Simulación económica en `scripts/simulation/` — 52 rondas × 3 escenarios (base, crecimiento, death spiral).

## Runbook de incidente

Si se descubre bug post-mainnet:

1. **Severidad crítica (fondos en riesgo)**:
   - Informar a signatarios multi-sig.
   - Preparar propuesta de emergencia (aunque los delays sean dolorosos — no hay botón de pause).
   - Comunicar públicamente vía canales oficiales.
   - Si los contratos dependientes permiten mitigación (ej: revocar role de contrato comprometido), propuesta rápida.
   - Bug bounty critical pagable post-confirmación.

2. **Severidad media**:
   - Propuesta vía gobernanza regular (~10 días).
   - Documentación pública + changelog.

3. **Severidad baja**:
   - Tracking issue en el repo.
   - Fix en próximo deploy (si lo hay) o documentado como aceptado.

---

Ver [Riesgos y seguridad (visión inversor)](../06-for-investors/03-risk-and-security.md) para un abordaje menos técnico de los mismos temas.
