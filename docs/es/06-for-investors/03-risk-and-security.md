# Riesgos y seguridad

**Audiencia:** quien necesita evaluar vectores de riesgo antes de cualquier exposición.
**Requisitos previos:** [Value accrual](02-value-accrual.md).

> **Aviso**: la lista de abajo describe riesgos **conocidos** y mitigaciones implementadas. Ningún protocolo es inmune a bugs, ataques imprevistos o cambios regulatorios. Lee y toma una decisión informada.

## Riesgos de protocolo

### Riesgo: bug en contrato

**Descripción**: un bug en cualquiera de los 12 contratos puede resultar en pérdida de fondos, falla de gobernanza o rotura de invariantes económicas.

**Mitigación**:

- Código basado en OpenZeppelin 5.0.2 (pinado exacto).
- `ReentrancyGuard` en toda función state-changing que mueve valor.
- SafeERC20 / SafeCast en todas las conversiones.
- Custom errors en todos los reverts (ahorro de gas + mensajes claros).
- Slither 0.11.5 como análisis estático (`audit/slither/`). Sin findings high/medium en el código del proyecto en el momento del deploy.
- 462+ tests con 100% stmts coverage y 99.84% lines.
- **Auditoría externa obligatoria antes de mainnet** (Trail of Bits, OpenZeppelin o similar).

**Riesgo residual**: bugs sutiles que los tests + el análisis estático no atrapan. La auditoría externa reduce pero no elimina.

### Riesgo: captura de gobernanza

**Descripción**: un actor acumula GOV suficiente para aprobar propuestas maliciosas (drenar Treasury, cambiar splits para beneficio propio, etc.).

**Mitigaciones**:

- `proposalThreshold = 10.000 GOV` (0.01% del cap) previene spam, no captura directa.
- `quorum = 4%` del supply requiere participación mínima real.
- `timelockMinDelay = 2 días` da ventana de respuesta para que los holders vean propuesta maliciosa y actúen.
- `votingPeriod = 7 días` permite discusión off-chain.
- La ejecución es permissionless tras el delay — cualquier holder puede bloquear vía propuesta contraria antes de la ejecución.

**Riesgo residual**: si un actor acumuló mucho GOV (vía venta pública mal distribuida o vía compra agresiva en DEX), puede forzar propuestas incluso con quorum. La mitigación es **distribución inicial bien hecha** (vía propuestas de la DAO eligiendo buckets adecuadamente — ver [Tokenomics](01-tokenomics.md)).

### Riesgo: flash-loan attack en el voto

**Descripción**: atacante toma préstamo gigante de GOV, vota en una propuesta favorable a sí mismo, devuelve el préstamo en el mismo bloque.

**Mitigación**:

- `GovernanceToken` hereda `ERC20Votes`. Voting power se lee vía `getPastVotes(account, snapshotBlock)` — bloque pasado. El flash-loan devuelve en el mismo bloque en que tomó, por lo que **no afecta** al bloque anterior.
- `votingDelay = 1 día` aleja el snapshot del bloque actual.

**Riesgo residual**: muy bajo. El mecanismo es estándar de OZ y ampliamente testeado.

### Riesgo: flash-loan attack en el reward

**Descripción**: atacante stake grande inmediatamente antes de `finalizeRound` para capturar share.

**Mitigación**:

- `Staking` mantiene checkpoints históricos (`Checkpoints.Trace208`).
- `RewardDistributor._calculateClaim` usa `Staking.getWeightAt(user, projectId, snapshotBlock)` — peso **antes** del `finalizeRound`.
- Flash-loan no consigue mantener posición en el bloque anterior.

**Riesgo residual**: muy bajo. Análogo directo de la protección de gobernanza, validado en tests.

### Riesgo: wash-burn para capturar share

**Descripción**: un proyecto malicioso quema volumen grande de CREDIT que él mismo acuñó (vía alguna vía externa) para capturar share desproporcionado en la emisión.

**Mitigación**:

- Sanity cap por `(ronda, proyecto)` en el `BurnTracker`. Default producción: 10M CREDIT por proyecto por ronda. Intento por encima revierte con `SanityCapExceeded`.
- Cap total por ronda (`capMax` en el `RewardDistributor`): 5M CREDIT en producción. Incluso si el atacante quemara dentro del sanity cap, la emisión total queda clampeada.
- Probation penalty (25% de la share) para proyectos nuevos.

**Riesgo residual**: un actor con **acceso a mucho CREDIT real** (no autoacuñado — ej.: compró en DEX) puede gastar ese CREDIT para inflar el burn de un proyecto cooptado. Pero eso **no es ataque** — es uso legítimo del protocolo (alguien pagó caro por eso).

### Riesgo: proyecto cooptado tras listado

**Descripción**: proyecto aprobado legítimamente es hackeado / owner comprometido / el equipo desaparece con colateral.

**Mitigaciones**:

- El colateral en GOV (10k) queda en el Registry hasta `removeProject`. Si está comprometido, la DAO aprueba `removeProject(id, slash=true, treasury)` — el colateral va al Treasury.
- Los apps pierden `RECORDER_ROLE` (si lo tenían) vía `revokeRole` cuando el proyecto pasa a `Probation` o `Removed` — vía propuesta.
- `isActive(projectId)` en el `FeeRouter.pay` y `BurnTracker.burnAndRecord` bloquea nuevos pagos tan pronto como cambie el status.

**Riesgo residual**: tiempo entre el compromiso y la ejecución de la propuesta (mínimo ~8 días = votingDelay + period + minDelay). Durante ese tiempo, los usuarios pueden aún pagar en el proyecto. Mitigación operacional: monitoreo activo + propuestas de emergencia (meta-propuestas con voto rápido vía quorum reducido no implementadas en v1, pero discutibles en el futuro).

### Riesgo: ETH trabado indebidamente en el Treasury

**Descripción**: ETH enviado al Treasury para el cual no hay propuesta de uso.

**Mitigación**: `sweepETH` es governance-gated. La DAO siempre puede retirar vía propuesta.

**Riesgo residual**: solo tiempo — si la DAO pierde engagement, los fondos quedan atrapados.

### Riesgo: CREDIT sin liquidez en DEX

**Descripción**: usuario recibe CREDIT como reward pero no consigue convertir (baja liquidez en DEX externa).

**Mitigación**: **fuera del protocolo**. La DAO puede aprobar uso del Treasury para seed de liquidez en DEX. El propio bucket "10% liquidity" de la distribución inicial es para eso.

**Riesgo residual**: si los DEXs abandonan el pool, los usuarios quedan atrapados con CREDIT. La solución depende de acción de la DAO + mercado externo.

## Riesgos de operación

### Riesgo: deployer comprometido antes del handoff

**Descripción**: durante el deploy inicial, el deployer tiene control temporal de todos los contratos. Si está comprometido antes de transferir los roles al Timelock, puede drenar fondos.

**Mitigación**:

- Deploy vía Ignition en una transacción batched.
- Handoff automatizado en el módulo `Dao.ts` — transfiere roles y renuncia al admin en la misma secuencia.
- Documentación rigurosa en [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).

**Riesgo residual**: ventana corta durante la ejecución del script. Mitigación operacional: deploy hecho desde hardware seguro, con revisión del tx batch antes de someter.

### Riesgo: el primer `acceptOwnership` no ocurre

**Descripción**: tras el deploy, el Timelock es `pendingOwner` del GovernanceToken pero aún no aceptó. Quien puede mintar GOV es el deployer. Si el deployer desaparece sin mintear distribución inicial vía propuesta aceptada por el Timelock, la DAO nace muerta.

**Mitigación**:

- Procedimiento de bootstrap documentado en [Mainnet deployment](../09-advanced/02-mainnet-deployment.md).
- Primera propuesta obligatoria debe ser `GovernanceToken.acceptOwnership()` por el Timelock.

**Riesgo residual**: error humano. Mitigación: procedimiento checklist + revisión multi-sig + test end-to-end previo en testnet.

### Riesgo: mala configuración de parámetros

**Descripción**: la DAO aprueba cambio de parámetro (α, capMax, etc.) que causa patología económica.

**Mitigación**:

- Bounds hardcodeados en todos los setters. Ej: `alpha` solo acepta `[0.5, 1.1]`; valores fuera revierten con `InvalidAlpha`.
- Los cambios pasan por 7 días de voto + 2 días de delay — tiempo para discusión y reversión.

**Riesgo residual**: dentro de los bounds, la DAO puede hacer cambios controvertidos. Es característica de DAO, no bug.

## Riesgos externos

### Riesgo regulatorio

**Descripción**: clasificación de GOV o CREDIT como security, stablecoin regulada u otra categoría con requisitos que el protocolo no cumple.

**Mitigación**:

- Los tokens no prometen retorno financiero.
- No hay emisor central identificable post-handoff de la gobernanza.
- La DAO puede evolucionar términos o aspectos no contractuales conforme los marcos regulatorios se consoliden.

**Riesgo residual**: significativo y no eliminable a nivel del protocolo. Los usuarios deben evaluar sus propias jurisdicciones.

### Riesgo de integración DEX externa

**Descripción**: el protocolo depende de DEXs externas para liquidez del CREDIT (y eventualmente GOV). Si el DEX sufre hack, se remueve listado, se drena el pool, etc., los usuarios pierden acceso a conversión.

**Mitigación**: diversificación de DEXs vía acciones de la DAO. No implementado en v1.

### Riesgo de oracle (aplicación futura)

**Descripción**: cuando se implemente la integración DEX real del `executeBuyback`, habrá dependencia de price oracle / TWAP / slippage protection.

**Mitigación**: el diseño detallado será auditado antes de la implementación. En v1, `executeBuyback` es stub — solo emite evento, no ejecuta swap.

## Riesgos para stakers específicamente

- **Inmovilización**: lock de 14-365+ días. Si necesitas el GOV antes, solo sales si el proyecto pasa a `Removed`.
- **Dependencia del proyecto elegido**: si tu proyecto no genera burn, tu reward = 0.
- **Dependencia del ecosistema**: incluso stakeando en un proyecto ejemplar, si el ecosistema agregado no genera uso, la emisión cae.
- **Volatilidad del CREDIT**: tu reward es en CREDIT. Si CREDIT no tiene liquidez o se desvaloriza, el reward en términos reales disminuye.

## Riesgos para apps listadas

- **Colateral bloqueado**: 10.000 GOV en el Registry. Solo vuelve con `removeProject` sin slash.
- **Suspensión por gobernanza**: `Probation` punitiva bloquea operación (pero no quema el colateral).
- **Slash**: si mala conducta comprobada, `removeProject(id, slash=true)` envía colateral al Treasury.
- **Dependencia del split**: 95% de cada pago se quema. Recibes 5% directo + (opcional, vía stake) porción de la emisión.
- **Uso bajo**: si tu app no atrae usuarios, el burn de tu proyecto es bajo, la share de emisión también.

## Auditoría y bounty

Antes de mainnet:

- Auditoría externa por firma reconocida (Trail of Bits, OpenZeppelin, Certik o similar).
- Bug bounty vía Immunefi inmediatamente tras mainnet.
- Monitoreo on-chain (Forta / Tenderly) para eventos críticos: `CapExceeded`, `SanityCapExceeded`, `RoundClosed.earlyClose=true`, salidas grandes del Treasury.

Status actual en el repositorio:

- Slither sin findings high/medium en el código del proyecto.
- Suite de tests 462+ tests con cobertura extensa.
- **Auditoría externa aún no realizada** en el momento de esta doc.

## Resumen

El protocolo tiene múltiples salvaguardas on-chain y off-chain. Ninguna elimina el riesgo totalmente. Exposición a GOV o CREDIT implica:

- Riesgo de contrato (bug).
- Riesgo económico (el modelo puede no despegar).
- Riesgo de gobernanza (cambios adversos vía propuesta).
- Riesgo de mercado (liquidez, volatilidad).
- Riesgo regulatorio (jurisdicción del usuario).

Evalúa antes de cualquier exposición. Empieza pequeño. Entiende el lock antes de stakear.

---

**Siguiente →** [Métricas que importan](04-metrics-that-matter.md)
