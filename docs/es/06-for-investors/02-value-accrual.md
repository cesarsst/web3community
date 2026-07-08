# Value accrual

**Audiencia:** lector evaluando la arquitectura económica del protocolo.
**Requisitos previos:** [Tokenomics](01-tokenomics.md), [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md).

> **Aviso**: esta página describe **mecanismos on-chain** por los cuales el valor transita en el protocolo. No es recomendación, proyección ni promesa. La exposición a GOV o CREDIT implica riesgos descritos en [Riesgos y seguridad](03-risk-and-security.md).

## Dónde entra el valor

La única fuente de **valor externo** en el sistema es el usuario final que compra CREDIT (en DEX externa, con stable, ETH, etc.) porque quiere usar los apps del ecosistema.

Si **cero** usuarios compran CREDIT para usar los apps, ningún mecanismo descrito abajo produce valor. La sustentación del protocolo depende de la utilidad ofrecida por los apps listados.

## Caminos por los cuales CREDIT adquiere presión de compra

1. **Consumo en los apps**: el usuario necesita CREDIT para pagar servicios. Compra en DEX, genera presión de compra.
2. **Retención por los apps**: los apps reciben rebate en CREDIT (10% default) y emisión vía stake (si stakearon). Mientras no venden, retiran CREDIT de circulación en DEX.
3. **Retención por los stakers**: los stakers reciben CREDIT como reward. Quien mantiene (en vez de vender inmediatamente) retira CREDIT de circulación.
4. **Subsidios por la DAO**: `UserSubsidy` distribuye CREDIT pre-financiado del Treasury a primeros usuarios. Eso **no crea demanda**, pero crea usuarios iniciales que pueden generar demanda recurrente tras el subsidio.
5. **Buyback de CREDIT (FFP)**: `Treasury.executeBuyback(usdcAmount, minCreditOut)` es **real** — compra CREDIT con USDC del Treasury (swap Uniswap V3) y **quema inmediatamente** el CREDIT comprado (`burnByRole`). El precio viene del `CreditPriceOracle` (TWAP Uniswap V3 CREDIT/USDC + sanidad Chainlink USDC/USD). Solo ejecuta vía propuesta DAO y bajo condiciones on-chain: spot TWAP por debajo del floor FFP por al menos `triggerDurationSecs` (default 24h), USDC sin depeg, cap por evento (default 20% de las reservas) y cap mensual (default 30% del snapshot). Presión de compra + reducción de supply en el mismo acto.

## Caminos por los cuales CREDIT sale de circulación

1. **Burn en pagos**: principal. 70% default de cada pago se quema vía `BurnTracker.burnAndRecord` → `CreditToken.burnByRole` (split Fase 0: 70% burn / 20% treasury / 10% rebate).
2. **Burn por buyback**: cada `executeBuyback` quema 100% del CREDIT comprado — no recicla al Treasury.

## Dinámica de supply

Con `alpha = 0.95`:

```
supply_R = supply_{R-1} + emissao_R - burn_R
         = supply_{R-1} + 0.95 * burn_{R-1} - burn_R
```

Si `burn_R ≈ burn_{R-1}` (uso estable):

```
supply_R ≈ supply_{R-1} - 0.05 * burn_R
```

Es decir, el supply cae en ~5% del burn de cada ronda.

Si el uso está creciendo (`burn_R > burn_{R-1}`), el supply aún puede caer pero más lento. Si está reduciéndose, puede caer más rápido (emisión basada en burn antiguo, menor, mientras burn nuevo es mayor — improbable pero posible).

## Caminos por los cuales GOV adquiere presión de compra

1. **Stakers comprando GOV en DEX externa** para stakear en proyectos (cuanto más optimistas sobre el protocolo, más GOV stakeado).
2. **Apps comprando GOV** para stakear en su propio proyecto y capturar emisión — la vía (B) descrita en [Flujo de valor](../03-protocol-overview/03-economic-flows.md).
3. **Nuevos proyectos comprando GOV** para cumplir `minCollateral` (10.000 GOV por listado).
4. **Programas de recompra de GOV aprobados por la DAO** — atención: **no hay mecanismo dedicado on-chain para GOV**. El `Treasury.executeBuyback` compra y quema **CREDIT**, no GOV. La recompra de GOV exigiría propuestas usando las transferencias genéricas del Treasury.

## Caminos por los cuales GOV sale de circulación

1. **Staking**: GOV bloqueado en `Staking` por hasta 365+ días, multiplicador de peso en función del lock.
2. **Colateral en proyectos**: GOV bloqueado en `ProjectRegistry` hasta `removeProject`.
3. **Vesting**: GOV bloqueado en instancias de `TeamVesting` hasta liberación gradual.
4. **Holding simple**: GOV parado en la wallet para votar.

GOV **no se quema**. El cap de 100M es la cantidad máxima que existirá.

## Captura de valor por perfil de participante

### Usuario final

Captura el **servicio del app**. El valor está fuera del protocolo — es lo que el app entrega a cambio del CREDIT pagado.

### App listada

Tres vectores combinados:

- **(A) Rebate directo**: 5% (default) de cada pago. Flujo de caja operacional inmediato.
- **(B) Stake en el propio proyecto**: si el app también stakeó GOV en su propio `projectId`, captura porción de la emisión proporcional al peso. Puede ser significativa — ver ejemplo numérico en [Flujo de valor](../03-protocol-overview/03-economic-flows.md).
- **(C) Apreciación del CREDIT retenido**: si el supply cae, el CREDIT no vendido vale más en términos reales.

### Staker

Captura emisión del RewardDistributor, proporcional al peso de su stake dentro del proyecto × share del proyecto en el burn total de la ronda.

Fórmula:

```
amount = total_emission
       × (burn_del_proyecto / burn_total)     // share del proyecto
       × (mi_peso / peso_total_del_proyecto)  // mi fraccion en el proyecto
       × (1 o 1/4 si probation)               // penalizacion
```

Bajo el `RewardDistributorV2` (Fase 1.4 del pivote CLP, activado por migración de gobernanza), la emisión se divide en 4 buckets antes de esa cuenta — default `[5500, 2500, 1500, 500]` bps = **55% stakers** / 25% LPs / 15% apps / 5% bonders. Es decir, sustituye `total_emission` por `0.55 × total_emission` en la fórmula de arriba.

El reward es en CREDIT. El staker puede vender (presión de venta) o retener.

Importante: **el staker también asume riesgo** — lock de 14 a 365+ días en GOV, posibilidad de que el proyecto elegido no genere burn, etc. Ver [Riesgos](03-risk-and-security.md).

### Holder de GOV sin stake

Captura derecho de voto. Exposición indirecta a la dinámica agregada — si el protocolo crece y GOV pasa a ser demandado (stakers nuevos, apps nuevas, buybacks), GOV puede valorizarse. Si el protocolo muere, GOV pierde utilidad.

## Mecanismo deflacionario — por qué no es Ponzi

Ponzi característico: se emite token nuevo para pagar a holders antiguos sin contrapartida real. Aquí:

- La emisión depende de burn real.
- El burn viene de pagos reales de los usuarios.
- Los pagos ocurren porque los usuarios compran CREDIT para usar apps.
- Los usuarios compran CREDIT porque quieren los servicios de los apps.

Si cualquier eslabón de la cadena se rompe (apps sin utilidad, usuarios no existen, CREDIT sin demanda), la emisión colapsa junto con el burn. El protocolo se desacelera — **pero no implota** simplemente porque alguien salió.

Lo que **ocurre** si nadie usa:

- Burn → 0.
- Emisión por la fórmula principal → 0 (después de que el floor se agote en el round 24).
- Los stakers dejan de entrar (sin reward).
- El protocolo queda zombi — los contratos corriendo pero sin actividad.

Lo que **no ocurre**:

- El protocolo no promete reward fijo. No hay obligación contractual de pagar a stakers X% al año.
- No hay contraparte "de último recurso" que pague reward si burn es cero.
- No hay salida caótica ("banco quebrado") — cada staker puede unstake cuando expire el lock.

## Mecanismos de salvaguarda

Tres salvaguardas impiden patologías:

1. **Floor decay** (rondas 0-23): emisión mínima durante bootstrap. Da tiempo para atraer usuarios. Después desaparece — forzando al ecosistema a caminar con sus propias piernas.

2. **Sanity cap por (ronda, proyecto)**: impide wash-burn por proyecto malicioso.

3. **Probation penalty** (25% share): proyectos nuevos capturan 25% de su share por 30 días. Desincentiva fraudes de listado rápido.

## No hay garantía de valor

Ningún mecanismo garantiza:

- Que GOV se va a valorizar.
- Que CREDIT va a mantener poder de compra.
- Que el uso de los apps va a crecer.
- Que un staker va a "lucrar".

La arquitectura alinea incentivos con uso real. Si el uso existe, el sistema opera según lo proyectado. Si no existe, la emisión (y por lo tanto el incentivo económico) colapsa. **Un producto malo no se salva con tokenomics.**

## Puntos a observar antes de cualquier exposición

- Salud del uso de los apps (vía `BurnTracker.getTotalBurnForRound`).
- Crecimiento o decremento de staking (vía `Staking.totalStaked` y `getGlobalWeight`).
- Propuestas recientes en el Governor (señal de dirección política).
- Distribución real del GOV (¿solo el genesis del Treasury post-deploy, o ya hubo asignaciones a equipo / venta pública / liquidez?).
- Liquidez del CREDIT en DEX externa (¿puede salir cuando quiera?).

Ver [Métricas que importan](04-metrics-that-matter.md).

---

**Siguiente →** [Riesgos y seguridad](03-risk-and-security.md)
