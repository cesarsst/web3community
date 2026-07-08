# Riesgos y seguridad

**Audiencia:** quien necesita evaluar vectores de riesgo antes de cualquier exposición.
**Requisitos previos:** [Value accrual](02-value-accrual.md).

> **Aviso**: la lista de abajo describe riesgos **conocidos** y mitigaciones implementadas. Ningún protocolo es inmune a bugs, ataques imprevistos o cambios regulatorios. Lee y toma una decisión informada.

> **Remodel 2026-07-08**: los riesgos específicos del modelo burn-to-mint (wash-burn, manipulación de emisión, oracle del FFP) están marcados como **(legado)** — los contratos siguen deployados pero sin flujo económico nuevo. Los riesgos nuevos del modelo vigente (PSM, rev-share) están en su propia sección.

## Riesgos del modelo vigente (remodel)

### Riesgo: dependencia del USDC (respaldo del PSM)

**Descripción**: cada CREDIT minteado vía `CreditPSM.buy` está respaldado por USDC retenido en el contrato. Un depeg del USDC, o un bloqueo por el emisor (blacklist de la dirección del PSM), rompería la convertibilidad 1:1. Es la mayor dependencia externa del modelo.

**Mitigación**: el respaldo es 100% pasivo — no se presta, no se invierte, no tiene función de retiro (ni para la gobernanza). `backing()`/`backingNormalized()` vs `mintedOutstanding` son verificables on-chain por cualquiera, en cualquier bloque.

**Riesgo residual**: riesgo de contraparte del emisor del USDC. No eliminable a nivel del protocolo.

### Riesgo: CREDIT legado sin respaldo

**Descripción**: el genesis (10M) y los rewards emitidos antes del remodel circulan sin USDC correspondiente en el PSM. Si una masa grande de CREDIT legado intentara redimirse, `sell` revertiría con `InsufficientBacking` al agotar el USDC depositado vía `buy`.

**Mitigación**: el PSM nunca promete más de lo que retiene — la redención está limitada al respaldo real, y `mintedOutstanding` clampea en cero para contabilizar redenciones legadas de forma conservadora.

**Riesgo residual**: los holders de CREDIT legado dependen de demanda orgánica (gastarlo en apps) o de que la DAO proponga algún mecanismo de absorción.

### Riesgo: el GMV de la app financiada colapsa

**Descripción**: el retorno del inversor de una ronda es `revShareBps × GMV`. Si la app deja de facturar, el retorno va a cero — y el capital ya fue entregado al dueño en el `Funded`.

**Mitigación**: all-or-nothing (sin captación parcial); `grossVolumeOf` permite auditar la facturación histórica antes de invertir; el gate de GOV stakeado alinea al inversor; bounds duros de rev-share (1%–30%) y plazo (1–90 días) evitan términos absurdos.

**Riesgo residual**: es riesgo de negocio genuino — equivalente a cualquier revenue-based financing. No hay colateral del dueño respaldando la ronda en el MVP.

### Riesgo: dueño desvía pagos fuera del router

**Descripción**: tras captar, el dueño podría cobrar a sus usuarios fuera del `FeeRouterV2` para evitar el rev-share.

**Mitigación**: económica — con fee de 2,5%, procesar por el router es barato (contra ~80% del modelo legado, que hacía del bypass la estrategia dominante); reputacional/política — el `grossVolumeOf` cayendo a cero tras un `Funded` es señal pública, y la gobernanza puede mover el proyecto a `Probation`/`Removed` (bloqueando pagos y matando el listado).

**Riesgo residual**: no hay enforcement on-chain del volumen off-chain. La due diligence del inversor debe considerar la fricción real de bypass de cada app.

## Riesgos de protocolo

### Riesgo: bug en contrato

**Descripción**: un bug en cualquiera de los 18 contratos de producción (15 pre-remodel + `CreditPSM`, `FeeRouterV2`, `ProjectFunding`) puede resultar en pérdida de fondos, falla de gobernanza o rotura de invariantes económicas.

**Mitigación**:

- Código basado en OpenZeppelin 5.0.2 (pinado exacto).
- `ReentrancyGuard` en toda función state-changing que mueve valor.
- SafeERC20 / SafeCast en todas las conversiones.
- Custom errors en todos los reverts (ahorro de gas + mensajes claros).
- Slither 0.11.5 como análisis estático (`audit/slither/`). Sin findings high/medium en el código del proyecto en el momento del deploy.
- 872 tests (suite completa verde) con cobertura extensiva.
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
- **Supermayoría de 75% on-chain** (`ProposalType.Supermajority` en el `CommunityGovernor`): cualquier propuesta que contenga `Treasury.removePOL` — o gestión de roles (`grantRole`/`revokeRole`/`renounceRole`) con target en el Treasury o en el propio Timelock — sólo pasa con `forVotes >= 3 × againstVotes`. Cierra el vector de drenar la liquidez protocolar (POL) por mayoría simple, incluido el bypass de re-autorizar roles.
- **Segregación on-chain de saldos reservados en el Treasury**: `transfer`/`batchTransfer`/`payRebates` de CREDIT no pueden invadir `polRefillBucket + pendingGaugeRewards` (revierten con `TransferExceedsUnreservedCredit`), y los depósitos en esos ledgers exigen respaldo real en CREDIT (`DepositExceedsCreditBalance`). En el `LiquidityGauge`, `governanceRescueRewards` está limitado al saldo no reservado (`totalVestingLocked` protege el vesting de usuarios).

**Riesgo residual**: si un actor acumuló mucho GOV (vía venta pública mal distribuida o vía compra agresiva en DEX), puede forzar propuestas incluso con quorum. La mitigación es **distribución inicial bien hecha** (vía propuestas de la DAO eligiendo buckets adecuadamente — ver [Tokenomics](01-tokenomics.md)).

### Riesgo: flash-loan attack en el voto

**Descripción**: atacante toma préstamo gigante de GOV, vota en una propuesta favorable a sí mismo, devuelve el préstamo en el mismo bloque.

**Mitigación**:

- `GovernanceToken` hereda `ERC20Votes`. Voting power se lee vía `getPastVotes(account, snapshotBlock)` — bloque pasado. El flash-loan devuelve en el mismo bloque en que tomó, por lo que **no afecta** al bloque anterior.
- `votingDelay = 1 día` aleja el snapshot del bloque actual.

**Riesgo residual**: muy bajo. El mecanismo es estándar de OZ y ampliamente testeado.

### Riesgo: flash-loan attack en el reward (legado)

**Descripción**: atacante stake grande inmediatamente antes de `finalizeRound` para capturar share. *(Aplica a los claims legados del RewardDistributor; en el modelo vigente no hay emisión que capturar — el gate de `ProjectFunding` exige lock mínimo de 14 días y las shares se fijan con CREDIT ya depositado.)*

**Mitigación**:

- `Staking` mantiene checkpoints históricos (`Checkpoints.Trace208`).
- `RewardDistributor._calculateClaim` usa `Staking.getWeightAt(user, projectId, snapshotBlock)` — peso **antes** del `finalizeRound`.
- Flash-loan no consigue mantener posición en el bloque anterior.

**Riesgo residual**: muy bajo. Análogo directo de la protección de gobernanza, validado en tests.

### Riesgo: wash-burn para capturar share (legado)

**Descripción**: un proyecto malicioso quema volumen grande de CREDIT que él mismo acuñó (vía alguna vía externa) para capturar share desproporcionado en la emisión. *(Sin función en el modelo vigente: no hay emisión. El análogo moderno es el wash-trading de `grossVolumeOf` para inflar la métrica de GMV antes de una ronda — costo real: 2,5% de fee por cada CREDIT ciclado, más el rev-share si la ronda ya está Funded.)*

**Mitigación**:

- Sanity cap por `(ronda, proyecto)` en el `BurnTracker`. Default producción: 10M CREDIT por proyecto por ronda. Intento por encima revierte con `SanityCapExceeded`.
- Cap total por ronda (`capMax` en el `RewardDistributor`): 5M CREDIT en producción. Incluso si el atacante quemara dentro del sanity cap, la emisión total queda clampeada.
- Probation penalty (25% de la share) para proyectos nuevos.

**Riesgo residual**: un actor con **acceso a mucho CREDIT real** (no autoacuñado — ej.: compró en DEX) puede gastar ese CREDIT para inflar el burn de un proyecto cooptado. Pero eso **no es ataque** — es uso legítimo del protocolo (alguien pagó caro por eso).

### Riesgo: proyecto cooptado tras listado

**Descripción**: proyecto aprobado legítimamente es hackeado / owner comprometido / el equipo desaparece con colateral.

**Mitigaciones**:

- El colateral en GOV (10k) queda en el Registry hasta `removeProject`. Si está comprometido, la DAO aprueba `removeProject(id, slash=true, treasury)` — el colateral va al Treasury.
- `isActive(projectId)` en el `FeeRouterV2.pay` y en `ProjectFunding.openRound` bloquea nuevos pagos y nuevas rondas tan pronto como cambie el status.
- `setAppRecipient` solo lo llama el owner del Registry — un owner comprometido puede rotar el destino de los pagos, pero la remoción del proyecto corta el flujo.

**Riesgo residual**: tiempo entre el compromiso y la ejecución de la propuesta (mínimo ~10 días = votingDelay ~1d + votingPeriod ~7d + timelockMinDelay 2d). Durante ese tiempo, los usuarios pueden aún pagar en el proyecto. Mitigación operacional: monitoreo activo + propuestas de emergencia (meta-propuestas con voto rápido vía quorum reducido no implementadas en v1, pero discutibles en el futuro).

### Riesgo: ETH trabado indebidamente en el Treasury

**Descripción**: ETH enviado al Treasury para el cual no hay propuesta de uso.

**Mitigación**: `sweepETH` es governance-gated. La DAO siempre puede retirar vía propuesta.

**Riesgo residual**: solo tiempo — si la DAO pierde engagement, los fondos quedan atrapados.

### Riesgo: CREDIT sin liquidez de salida

**Descripción**: usuario recibe CREDIT (pago, refund o rev-share) y no consigue convertirlo a stable.

**Mitigación**: con el remodel este riesgo cambió de naturaleza — la salida canónica es `CreditPSM.sell` (1:1, sin fee, sin pool, sin slippage), disponible mientras exista respaldo. El POL/gauge del modelo CLP (liquidez en DEX) quedó como infraestructura legada.

**Riesgo residual**: el CREDIT **legado** (genesis + rewards pre-remodel) excede el respaldo del PSM — para esa masa, la redención 1:1 no está garantizada (ver "CREDIT legado sin respaldo" arriba).

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

- Bounds hardcodeados en todos los setters. Ej: `setFeeBps` solo acepta hasta `FEE_BPS_CAP = 500` (5%) — valores mayores revierten con `FeeAboveCap`; `setFeeSplit` exige suma exacta de 10.000 bps.
- El PSM no tiene setters — cero superficie de misconfiguración.
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

### Riesgo de oracle (buyback FFP) (legado)

**Descripción**: `executeBuyback` es **real** (Fase 1.1 del pivote CLP): swap USDC → CREDIT vía Uniswap V3 + quema inmediata del CREDIT comprado. Depende del `CreditPriceOracle` (adapter inmutable: TWAP del pool Uniswap V3 CREDIT/USDC + sanidad Chainlink USDC/USD). Un oracle manipulado o un pool poco profundo pueden inducir buyback a precio malo.

**Mitigación** (todo on-chain, en el `Treasury` y en el adapter):

- El precio es TWAP (ventana default 30 min, bounds [5min, 2h]) — la manipulación de spot instantáneo no basta.
- Sanidad Chainlink USDC/USD: staleness máxima 6h + banda [0.99, 1.01] — un depeg del USDC bloquea el buyback (`UsdcDepegDetected`).
- El buyback sólo es elegible con spot por debajo del floor por >= `triggerDurationSecs` (default 24h) y está capado: 20% de las reservas por evento, 30% del snapshot mensual (defaults; ajustables dentro de bounds).
- `minCreditOut` (slippage) obligatorio; cada ejecución exige propuesta DAO (GOVERNANCE_ROLE = Timelock).
- Adapter sin owner/setters — cambiar parámetros del oracle exige nuevo deploy + `setPriceOracle` vía propuesta.

**Riesgo residual**: manipulación sostenida del TWAP en un pool con poca liquidez a lo largo de la ventana entera. Mitigación operacional: POL (liquidez protocolar) profunda + monitoreo.

## Riesgos para stakers e inversores específicamente

- **Inmovilización**: lock de 14-365+ días. Si necesitas el GOV antes, solo sales si el proyecto pasa a `Removed`.
- **Capital de la ronda entregado**: tras el `Funded`, el CREDIT invertido va íntegro al dueño — no hay devolución (el refund existe solo para rondas `Failed`).
- **Dependencia del proyecto elegido**: si la app financiada no factura vía router, tu rev-share = 0.
- **Gate del claim**: reclamar rev-share exige mantener GOV stakeado en el proyecto. Si haces unstake, el valor acumulado queda retenido (no se pierde) hasta re-stake.
- **Dependencia del ecosistema**: incluso invirtiendo en un proyecto ejemplar, si el ecosistema agregado no genera uso, el GMV cae.

## Riesgos para apps listadas

- **Colateral bloqueado**: 10.000 GOV en el Registry. Solo vuelve con `removeProject` sin slash.
- **Suspensión por gobernanza**: `Probation` punitiva bloquea operación (pero no quema el colateral).
- **Slash**: si mala conducta comprobada, `removeProject(id, slash=true)` envía colateral al Treasury.
- **Fee del protocolo**: 2,5% de cada pago (techo duro 5%). Retienes ~97,5% al instante — ~89,5% si cediste 8% de rev-share en una ronda.
- **Rev-share perpetuo**: en el MVP, la fatia cedida no expira. Dimensiona el rev-share (1%–30%) según tu proyección de GMV — es tu costo de capital permanente.
- **Uso bajo**: si tu app no atrae usuarios, ni la fee baja te salva — y una ronda futura será difícil de justificar con `grossVolumeOf` bajo.

## Auditoría y bounty

Antes de mainnet:

- Auditoría externa por firma reconocida (Trail of Bits, OpenZeppelin, Certik o similar).
- Bug bounty vía Immunefi inmediatamente tras mainnet.
- Monitoreo on-chain (Forta / Tenderly) para eventos críticos: divergencia `backing` vs `mintedOutstanding` en el PSM, `FeeUpdated`/`RecipientsUpdated` inesperados, `RoundFunded` seguido de `grossVolumeOf` estancado, salidas grandes del Treasury.

Status actual en el repositorio:

- Slither sin findings high/medium en el código del proyecto.
- Suite de tests con 858 tests pasando (0 fallas).
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
