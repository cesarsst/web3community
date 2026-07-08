# Métricas que importan

**Audiencia:** quien sigue la salud operacional del protocolo.
**Requisitos previos:** [Value accrual](02-value-accrual.md), [Consultar estado on-chain](../05-for-developers/04-querying-state.md).

Métricas que puedes calcular directo desde los contratos. Todas on-chain, sin depender de indexador externo. Actualizadas al **remodel 2026-07-08** — las métricas del modelo burn-to-mint quedan al final como legado.

## Métricas de uso (salud del protocolo)

### GMV por proyecto (la métrica reina)

**Qué es**: volumen bruto acumulado de pagos de cada proyecto, registrado on-chain por el router. Proxy directo del uso real de las apps — sustituye al "burn por ronda" del modelo legado.

**Cómo leer**:

```solidity
feeRouterV2.grossVolumeOf(projectId);
```

Para la serie temporal, indexa los eventos `PaymentRouted` (el delta de `grossVolumeOf` entre dos bloques es el GMV del período).

**Cómo interpretar**:

- Creciente → la app gana tracción; el rev-share de su ronda rinde más.
- Plano → estable.
- Decreciente → alerta; investiga la causa (¿la app cayó? ¿salida de usuarios? ¿bypass del router?).
- Cero tras un `RoundFunded` → señal grave: la app captó y dejó de facturar por el router.

### GMV agregado del protocolo

Suma de `grossVolumeOf(id)` para todo `id` activo, o `Sum(amount)` sobre los eventos `PaymentRouted`. Con fee de 2,5%: ingreso del protocolo = 2,5% del GMV (1% treasury, 1% buyback, 0,5% grants).

### Distribución del GMV entre proyectos

- Concentración en 1-2 proyectos → alta dependencia; riesgo si uno desaparece.
- Distribución equilibrada → ecosistema saludable con múltiples contribuyentes.
- Proyectos nuevos apareciendo consistentemente → entrada saludable.

### Proyectos totales en el Registry

```solidity
registry.totalProjects();
```

Suma de todos los que ya fueron registrados (incluye `Removed`). Para activos, itera vía `registry.isActive(id)` de 1 a `totalProjects()`.

## Métricas del PSM (respaldo del CREDIT)

### Paridad respaldo / circulante

```solidity
psm.backing();              // USDC retenido (6 decimales)
psm.backingNormalized();    // idem, en 18 decimales
psm.mintedOutstanding();    // CREDIT minteado por el PSM aun en circulacion
```

**Invariante**: `backingNormalized() >= mintedOutstanding()` — garantizada por construcción. Cualquier divergencia negativa sería evidencia de bug crítico (alerta máxima).

La brecha `totalSupply de CREDIT - mintedOutstanding` mide la masa de **CREDIT legado** (genesis + rewards pre-remodel) que circula sin respaldo en el PSM. Cuanto menor esa brecha relativa, más sólida la convertibilidad agregada.

### Flujo neto del PSM

Indexa `Bought(user, usdcIn, creditOut)` y `Sold(user, creditIn, usdcOut)`:

- `Sum(usdcIn) - Sum(usdcOut)` creciente → entra dinero para gastar en apps (demanda de saldos).
- Redenciones dominando por semanas → los usuarios están saliendo del ecosistema.

## Métricas de rondas e inversión (ProjectFunding)

### Estado y desempeño de las rondas

```solidity
funding.rounds(projectId);                   // { target, raised, deadline, revShareBps, status }
funding.revShareBpsOf(projectId);            // rev-share activo (0 si no Funded)
funding.totalRevenueDistributed(projectId);  // receita ya acreditada a inversores
funding.pendingRevenue(projectId, investor); // pendiente de claim del inversor
funding.sharesOf(projectId, investor);       // shares (= CREDIT invertido)
```

### Rendimiento realizado de una ronda

```
yield_anualizado ≈ (delta de totalRevenueDistributed en el periodo / raised) × (365 / dias del periodo)
```

Compara con la promesa implícita al invertir (`revShareBps × GMV_proyectado / target`). Ejemplo de referencia: ronda de 10.000 CREDIT al 8% con GMV de 2.000/mes → ~19% a.a.

### Tasa de éxito de rondas

Indexa `RoundOpened` / `RoundFunded` / `RoundFailed`. Muchas `RoundFailed` seguidas = apetito de inversión bajo o términos poco realistas (rev-share bajo para el riesgo, alvos altos para el GMV histórico).

## Métricas de staking

### Stake total agregado

```solidity
staking.totalStaked();
```

GOV total inmovilizado en posiciones. En el modelo vigente, el stake es la **llave de inversión**: crecimiento de stake en un proyecto anticipa demanda por su ronda.

### Stake por proyecto

```solidity
staking.totalStakedByProject(projectId);
staking.getTotalWeight(projectId);
```

Indicador de qué proyecto tiene más apoyadores habilitados a invertir. Debe correlacionar con el GMV del proyecto a lo largo del tiempo.

### Distribución de locks

No hay view agregada para la distribución de `lockDuration`. La métrica derivada es `globalWeight / totalStaked` — si es > 1 significa lock medio por encima de 14 días (multiplier > 1x). Cerca de 4 significa muchos stakers en lock máximo.

## Métricas económicas

### Supply de CREDIT

```solidity
credit.totalSupply();
```

En el modelo vigente el supply sigue la demanda de saldos de pago (crece con `buy`, cae con `sell`). Ya no hay dinámica deflacionaria que monitorear — lo relevante es la paridad con el respaldo (sección PSM).

### Supply de GOV en circulación

```solidity
gov.totalSupply();
```

En producción, empieza en 0 y crece vía `mint` aprobados. Compara con el cap (`gov.cap()` = 100M) para saber lo que aún puede acuñarse.

### GOV inmovilizado

Suma de:

```solidity
staking.totalStaked();                    // en staking
// + colateral en proyectos activos
//   (iterar registry.getProject(id).collateral para id activo)
// + saldos de TeamVesting (aún no released)
// + Treasury
```

La razón `GOV_inmovilizado / totalSupply` indica qué tan "en actividad" está el GOV. Alta = buena señal. Baja = muchos holders parados.

### Flujo del buyback

Indexa las transferencias de CREDIT al `buybackRecipient` (parcela `feeToBuyback` del evento `PaymentRouted`). Es la presión de compra estructural de GOV: debe ser ≈ 1% del GMV del período (40% de la fee de 2,5%).

### Treasury balances

```solidity
treasury.balanceOf(IERC20(gov));
treasury.balanceOf(IERC20(credit));
address(treasury).balance;              // ETH
// + otros ERC-20 que la DAO reciba
```

Monitorea salidas grandes. Los eventos `Transferred`, `BatchTransferred` indican lo que la DAO aprobó gastar. Recuerda: el respaldo del PSM **no** aparece aquí — está segregado en el `CreditPSM`.

## Métricas de gobernanza

### Participación en votos

Por propuesta:

```solidity
(againstVotes, forVotes, abstainVotes) = governor.proposalVotes(proposalId);
totalVotes = againstVotes + forVotes + abstainVotes;
```

Compara `totalVotes` con `getPastTotalSupply(snapshot)` para participación %. Tendencia declinante = engagement cayendo.

### Quorum alcanzado

```solidity
quorumNeeded = governor.quorum(snapshot);
quorumAtingido = forVotes + abstainVotes >= quorumNeeded;
```

### Propuestas pendientes

Monitorea eventos `ProposalCreated` + `state(id)`.

### Delegación activa

Para un account específico:

```solidity
gov.delegates(account);     // a quien delego (0 si nadie)
gov.getVotes(account);      // voting power actual
```

Agregado: suma de `getVotes` para addresses conocidas. Compara con `totalSupply` para % delegado. Alta % delegada = gobernanza vibrante.

## Métricas operacionales del FeeRouterV2

### Parámetros vigentes

```solidity
feeRouterV2.feeBps();        // 250 = 2,5% (techo duro 500)
feeRouterV2.feeSplit();      // (4000, 4000, 2000)
feeRouterV2.appRecipientOf(projectId);  // 0 = fallback al owner del Registry
```

### Contabilidad por parcela

Indexa eventos `PaymentRouted(projectId, payer, amount, feeToTreasury, feeToBuyback, feeToGrants, revShare, toApp)`:

- `Sum(amount)` = GMV del protocolo.
- `Sum(feeToTreasury + feeToBuyback + feeToGrants)` = ingreso del protocolo.
- `Sum(revShare)` = renta agregada pagada a inversores.
- `Sum(toApp)` = caja total distribuida a las apps (~89,5–97,5% del GMV).

### Preview de un pago

```solidity
feeRouterV2.previewPay(projectId, amount);  // (fee, revShare, toApp)
```

## Dashboard mínimo sugerido

```
┌ Salud del uso ────────────────────────┐
│ GMV total (ultimas 4 semanas)          │
│ GMV por proyecto top-5                 │
│ N proyectos con pagos en el periodo    │
│ N proyectos Active en Registry         │
└────────────────────────────────────────┘
┌ PSM / CREDIT ─────────────────────────┐
│ backing vs mintedOutstanding           │
│ Flujo neto buy - sell (semana)         │
│ CREDIT legado (supply - outstanding)   │
└────────────────────────────────────────┘
┌ Inversion ────────────────────────────┐
│ Rondas Open / Funded / Failed          │
│ Receita distribuida (semana)           │
│ Yield realizado por ronda top-5        │
│ Buyback acumulado (feeToBuyback)       │
└────────────────────────────────────────┘
┌ Staking ──────────────────────────────┐
│ Total staked (GOV)                     │
│ Top-5 proyectos por weight             │
│ Weight / Staked ratio (lock medio)     │
└────────────────────────────────────────┘
┌ Gobernanza ───────────────────────────┐
│ Propuestas abiertas                    │
│ % participacion ultima propuesta       │
│ Quorum vigente (4% del supply)         │
│ Lista pendiente en Timelock            │
└────────────────────────────────────────┘
┌ Treasury ─────────────────────────────┐
│ Saldos GOV, CREDIT, otros tokens       │
│ Ingreso fee (1% del GMV) vs gastos     │
│ Salidas recientes (Transferred event)  │
└────────────────────────────────────────┘
```

Todas esas métricas se derivan de llamadas `view` en los contratos + indexación de eventos. Ningún dato off-chain es necesario.

## Señales de alerta

- GMV cayendo por > 3 semanas consecutivas (agregado o en un proyecto con ronda Funded).
- `grossVolumeOf` estancado justo después de un `RoundFunded` (posible bypass del dueño).
- `backingNormalized() < mintedOutstanding()` — **imposible por construcción**; si ocurre, exploit (alerta máxima).
- Redenciones (`Sold`) dominando las compras (`Bought`) por semanas.
- `FeeUpdated` / `FeeSplitUpdated` / `RecipientsUpdated` sin propuesta correspondiente conocida.
- `totalStaked` cayendo rápidamente (stakers saliendo tras el lock).
- Participación en propuestas < 50% del quorum mínimo.
- Salidas grandes del Treasury sin propuesta correspondiente conocida (investiga inmediatamente).

## Métricas del modelo legado

Las métricas del modelo burn-to-mint (`burnTracker.getTotalBurnForRound`, emisión por ronda del `RewardDistributor`, razón emisión/burn, gap de finalize, split del FeeRouter V1) siguen consultables on-chain para análisis histórico y para acompañar los claims legados pendientes, pero **ya no miden la salud del protocolo**. Referencia en las páginas de contratos marcadas como legado: [BurnTracker](../08-contracts-reference/06-BurnTracker.md), [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md), [RewardDistributorV2](../08-contracts-reference/07b-RewardDistributorV2.md), [FeeRouter](../08-contracts-reference/08-FeeRouter.md).

---

**Siguiente →** [Ciclo de propuesta](../07-governance/01-proposal-lifecycle.md)
