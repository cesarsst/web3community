# Métricas que importan

**Audiencia:** quien sigue la salud operacional del protocolo.
**Requisitos previos:** [Value accrual](02-value-accrual.md), [Consultar estado on-chain](../05-for-developers/04-querying-state.md).

Métricas que puedes calcular directo desde los contratos. Todas on-chain, sin depender de indexador externo.

## Métricas de uso (salud del protocolo)

### Burn por ronda

**Qué es**: cuánto CREDIT se quemó en cada ronda. Proxy directo del uso real de los apps.

**Cómo leer**:

```solidity
burnTracker.getTotalBurnForRound(round);
```

**Cómo interpretar**:

- Creciente a lo largo de las rondas → protocolo ganando tracción.
- Plano → estable.
- Decreciente → alerta; investiga la causa (¿la app cayó? ¿salida de usuarios?).
- Cero por muchas rondas → señal terminal.

### Burn por proyecto

**Qué es**: distribución del burn entre proyectos activos.

**Cómo leer**:

```solidity
burnTracker.getBurnForProjectInRound(round, projectId);
```

Para cada `projectId` listado, en cada ronda.

**Cómo interpretar**:

- Concentración en 1-2 proyectos → alta dependencia; riesgo si uno desaparece.
- Distribución equilibrada → ecosistema saludable con múltiples contribuyentes.
- Proyectos nuevos apareciendo consistentemente → entrada saludable.

### Proyectos con burn por ronda

**Qué es**: cuántos proyectos distintos tuvieron al menos 1 burn.

**Cómo leer**:

```solidity
burnTracker.projectsWithBurnCount(round);
```

**Cómo interpretar**: número creciente = amplitud del ecosistema creciendo. Estancamiento = pocos proyectos están sosteniendo todo.

### Proyectos totales en el Registry

```solidity
registry.totalProjects();
```

Suma de todos los que ya fueron registrados (incluye `Removed`). Para activos, itera vía `registry.isActive(id)` de 1 a `totalProjects()`.

## Métricas de staking

### Stake total agregado

```solidity
staking.totalStaked();
```

GOV total inmovilizado en posiciones. Alto = confianza de holders. Bajo = los holders prefieren liquidez a exposición.

### Peso global

```solidity
staking.getGlobalWeight();
```

Suma de pesos en todos los proyectos. Refleja tanto el `totalStaked` como la elección de locks largos (multiplier).

### Stake por proyecto

```solidity
staking.totalStakedByProject(projectId);
staking.getTotalWeight(projectId);
```

Indicador de qué proyecto tiene más apoyadores. Debe correlacionar con el burn del proyecto a lo largo del tiempo (los apps con buen stake tienden a generar más uso).

### Distribución de locks

No hay view agregada para la distribución de `lockDuration`. La métrica derivada es `globalWeight / totalStaked` — si es > 1 significa lock medio por encima de 14 días (multiplier > 1x). Cerca de 4 significa muchos stakers en lock máximo.

## Métricas económicas

### Supply de CREDIT

```solidity
credit.totalSupply();
```

Compara con el último valor y con `supply + emision - burn` esperado de la ronda. Divergencia → investigar.

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

### Emisión por ronda

```solidity
rd.getEmission(round);             // se finalized
rd.previewEmission(round);         // preview
```

Compara con `capMax` para saber si está dominado por el cap (emisión saturada) o por el burn.

### Razón emisión / burn

```
ratio = emissao_R / burn_{R-1}
```

Si `alpha = 0.95`, esa razón debe ser ~0.95 (cuando burn alto, no clampeado por floor ni cap).

Si ratio = 1 exacto → emisión alcanzó `capMax` (clampeada en el techo).
Si ratio > 1 → emisión dominada por el floor (burn bajo, bootstrap).
Si ratio ~ 0.95 → operación normal.

### Treasury balances

```solidity
treasury.balanceOf(IERC20(gov));
treasury.balanceOf(IERC20(credit));
address(treasury).balance;              // ETH
// + otros ERC-20 que la DAO reciba
```

Monitorea salidas grandes. Los eventos `Transferred`, `BatchTransferred`, `RebatesPaid` indican lo que la DAO aprobó gastar.

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
gov.delegates(account);     // para quem delegou (0 se ninguem)
gov.getVotes(account);      // voting power atual
```

Agregado: suma de `getVotes` para addresses conocidas. Compara con `totalSupply` para % delegado. Alta % delegada = gobernanza vibrante.

## Métricas de rondas

### Ronda actual

```solidity
burnTracker.currentRound();
burnTracker.roundStartedAt();
burnTracker.roundDuration();
burnTracker.isRoundReadyToClose();
```

### Última ronda finalizada

```solidity
rd.lastFinalizedRound();
rd.isFirstRoundFinalized();
```

El gap entre `currentRound - 1` y `lastFinalizedRound` indica si hay rondas cerradas sin finalize. Gap grande = alguien necesita llamar a `finalizeRound` (permissionless, cualquiera puede).

### Histórico de emisiones

```solidity
for (uint r = 0; r <= rd.lastFinalizedRound(); r++) {
    rd.roundData(r);  // { totalEmission, totalBurnAtFinalize, snapshotBlock, finalized }
}
```

Calcula el acumulado de emisión vs el acumulado de burn para ver el saldo neto de supply a lo largo del tiempo.

## Métricas operacionales del FeeRouter

### Volumen total pagado

Indexa eventos `Paid(projectId, user, payer, amount, burned, toTreasury, toApp, recipient)`.

Sum(amount) = volumen bruto del protocolo.
Sum(burned) = presión deflacionaria acumulada.
Sum(toApp) = caja total distribuida a los apps.

### Split efectivo por proyecto

```solidity
feeRouter.getEffectiveSplit(projectId);
```

Para proyectos con override vs default.

## Dashboard mínimo sugerido

Para que el dev/staker/operador pueda seguir:

```
┌ Salud del uso ────────────────────────┐
│ Total burn (ultimas 4 rondas)          │
│ Burn por proyecto top-5                │
│ N proyectos con burn                   │
│ N proyectos Active en Registry         │
└────────────────────────────────────────┘
┌ Staking ──────────────────────────────┐
│ Total staked (GOV)                     │
│ Global weight                          │
│ Top-5 proyectos por weight             │
│ Weight / Staked ratio (lock medio)     │
└────────────────────────────────────────┘
┌ Supply ───────────────────────────────┐
│ CREDIT totalSupply                     │
│ GOV totalSupply vs cap                 │
│ Delta supply ultima ronda              │
│ Ratio emision/burn                     │
└────────────────────────────────────────┘
┌ Gobernanza ───────────────────────────┐
│ Propuestas abiertas                    │
│ % participacion ultima propuesta       │
│ Quorum vigente (4% del supply)         │
│ Lista pendiente en Timelock            │
└────────────────────────────────────────┘
┌ Treasury ─────────────────────────────┐
│ Saldos GOV, CREDIT, otros tokens       │
│ ETH                                    │
│ Salidas recientes (Transferred event)  │
└────────────────────────────────────────┘
```

Todas esas métricas se derivan de llamadas `view` en los contratos + indexación de eventos. Ningún dato off-chain es necesario.

## Señales de alerta

- Burn por ronda cayendo por > 3 rondas consecutivas.
- `totalStaked` cayendo rápidamente (stakers unstakeando tras el lock).
- Participación en propuestas < 50% del quorum mínimo.
- Proyectos alcanzando `SanityCapExceeded` — señal de posible abuso.
- `RoundClosed.earlyClose = true` sin contexto claro vía propuesta.
- Salidas grandes del Treasury sin propuesta correspondiente conocida (investiga inmediatamente — sería evidencia de exploit, aunque el access control lo mitigue).

---

**Siguiente →** [Ciclo de propuesta](../07-governance/01-proposal-lifecycle.md)
