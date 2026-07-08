# Value accrual

**Audiencia:** lector evaluando la arquitectura económica del protocolo.
**Requisitos previos:** [Tokenomics](01-tokenomics.md), [Flujo de valor](../03-protocol-overview/03-economic-flows.md).

> **Aviso**: esta página describe **mecanismos on-chain** por los cuales el valor transita en el protocolo. No es recomendación, proyección ni promesa. La exposición a GOV o a rondas de captación implica riesgos descritos en [Riesgos y seguridad](03-risk-and-security.md).

## Dónde entra el valor

La única fuente de **valor externo** en el sistema es el usuario final que deposita USDC en el `CreditPSM` para obtener CREDIT y pagar por los servicios de las apps.

Si **cero** usuarios pagan en las apps, ningún mecanismo descrito abajo produce valor. La sustentación del protocolo depende de la utilidad ofrecida por las apps listadas.

## Qué cambió con el remodel 2026-07-08

En el modelo anterior, la tesis del inversor era doble: emisión de CREDIT para stakers + deflación del supply. Ambas murieron con el remodel:

- **CREDIT ya no es un activo de inversión.** Es estable 1:1 con USDC vía PSM. No se aprecia, no se deprecia, no rinde. Tenerlo es tener saldo prepago.
- **No hay emisión de rewards.** El retorno del inversor viene de **rev-share sobre receita real** de la app que financió — pagado en CREDIT (= dólares) en cada pago que la app procesa.

El activo con tesis de apreciación es **GOV**; el instrumento de renta es la **ronda de captación**.

## Retorno del inversor: rev-share sobre receita real

El mecanismo, de punta a punta:

1. Stakeas GOV en el proyecto que quieres financiar (requisito de elegibilidad — `NoGovStaked` sin eso).
2. Aportas CREDIT en la ronda (`invest`). All-or-nothing: si el alvo no se alcanza en el plazo, `refund` devuelve el 100%.
3. Con la ronda `Funded`, **cada** pago que la app recibe vía `FeeRouterV2.pay` descuenta el rev-share (1%–30%, fijado al abrir la ronda) y lo acredita pro-rata a tus shares (= CREDIT invertido).
4. `claim` retira lo acumulado, cuando quieras — el derecho **nunca expira** (exige mantener GOV stakeado; sin stake el valor queda retenido hasta re-stake, no se pierde).

### La cuenta del rendimiento

```
rendimiento_anual ≈ revShareBps × GMV_anual / capital_invertido
```

Ejemplo ilustrativo (el mismo de [Flujo de valor](../03-protocol-overview/03-economic-flows.md)): ronda de 10.000 CREDIT al 8% de rev-share; la app factura 2.000 CREDIT/mes → los inversores reciben 160 CREDIT/mes → **~19% a.a.** sobre el capital. Del lado de la app, ese es su costo de capital — comparable a revenue-based financing.

Tres propiedades a internalizar:

- **El rendimiento es variable y no garantizado**: sigue el GMV real. App que factura el doble → rendimiento dobla; app que muere → rendimiento cero. No hay APR prometido.
- **Es renta, no apreciación**: recibes CREDIT (estable). El "upside" ilimitado no existe — existe una fatia perpetua de la receita bruta.
- **Es auditable antes de invertir**: `grossVolumeOf[projectId]` (router) da el historial de facturación on-chain; `totalRevenueDistributed[projectId]` (funding) muestra cuánto ya se pagó a inversores de cada proyecto.

## Caminos por los cuales GOV adquiere presión de compra

1. **Buyback continuo financiado por la fee**: 40% de la fee del protocolo (= 1% del GMV con fee de 2,5%) va al `buybackRecipient` para recompra de GOV. Es presión de compra estructural, proporcional al volumen de pagos — no depende de decisión discrecional por pago.
2. **Gate de inversión**: cada inversor necesita GOV stakeado en el proyecto para entrar en su ronda y para reclamar el rev-share. Más rondas atractivas → más GOV demandado y lockeado.
3. **Nuevos proyectos comprando GOV** para cumplir `minCollateral` (10.000 GOV por listado).
4. **Gobernanza**: control sobre parámetros económicos reales (fee, split, whitelist) con flujo de caja real detrás.

## Caminos por los cuales GOV sale de circulación

1. **Staking**: GOV bloqueado en `Staking` (lock 14–365+ días, gate de inversión).
2. **Colateral en proyectos**: GOV bloqueado en `ProjectRegistry` hasta `removeProject`.
3. **Vesting**: GOV bloqueado en instancias de `TeamVesting` hasta liberación gradual.
4. **Holding simple**: GOV parado en la wallet para votar.

GOV **no se quema**. El cap de 100M es la cantidad máxima que existirá.

## Captura de valor por perfil de participante

### Usuario final

Captura el **servicio de la app**. El valor está fuera del protocolo — es lo que la app entrega a cambio del CREDIT pagado. Sin riesgo cambiario: el CREDIT sobrante se redime 1:1.

### App listada

- **~97,5% de cada pago, al instante** (fee de 2,5%; ~89,5% si cedió 8% de rev-share). Sin ciclo de rondas, sin claim.
- **Capital anticipado sin deuda**: la ronda entrega el alvo íntegro si se completa; el "repago" es una fatia de la receita futura (costo ~19% a.a. en el ejemplo ilustrativo).
- Elegible a **grants** (20% de la fee del protocolo) vía gobernanza.

### Inversor (rondas de captación)

Renta en CREDIT proporcional a `shares × revShareBps × GMV`. Riesgos específicos: GMV puede caer a cero; capital lockeado hasta `Funded` o refund; exige mantener GOV stakeado para claim. Ver [Riesgos](03-risk-and-security.md).

### Holder de GOV

Derecho de voto + exposición al buyback continuo. Si el GMV agregado crece, el buyback crece; si el protocolo muere, GOV pierde utilidad y demanda.

### Treasury (la DAO)

1% del GMV (40% de la fee) para opex + 0,5% del GMV para grants. Presupuesto proporcional al uso real — sin tocar jamás el respaldo del PSM (segregado, sin función de retiro).

## Por qué no es Ponzi

Ponzi característico: se paga a los participantes antiguos con el capital de los nuevos, sin generación externa de valor. Aquí:

- El retorno del inversor viene de **receita real de las apps** — usuarios pagando por servicios, no nuevos inversores entrando.
- **No hay emisión**: el protocolo no puede "imprimir" retorno. Cada CREDIT reclamado por un inversor fue transferido por un pago real (evento `PaymentRouted` lo detalla parcela por parcela).
- **CREDIT está respaldado 1:1**: cada unidad minteada por el PSM tiene USDC retenido en el contrato, verificable on-chain (`backing()` vs `mintedOutstanding`).
- **All-or-nothing** impide que un proyecto capte a medias y desaparezca con capital parcial.

Lo que **ocurre** si nadie usa las apps:

- GMV → 0; rev-share → 0; buyback → 0; grants/opex → 0.
- Los inversores de rondas ya financiadas dejan de recibir (su capital ya fue entregado a la app — ese riesgo es explícito).
- El protocolo queda zombi — los contratos corriendo pero sin actividad. **El CREDIT en circulación sigue redimible 1:1** hasta el límite del respaldo del PSM.

Lo que **no ocurre**:

- No hay APR prometido ni obligación contractual de retorno.
- No hay "corrida bancaria" contra el PSM en el sentido clásico: el respaldo de lo minteado vía `buy` es 100% y no está prestado ni invertido en nada.

## Salvaguardas estructurales

1. **Techo duro de la fee (5%)**: ni la gobernanza puede convertir el protocolo en una app store — `FEE_BPS_CAP = 500` es constante.
2. **Respaldo segregado**: el USDC del PSM no tiene función de retiro. La DAO gasta de la fee, nunca del respaldo.
3. **All-or-nothing + bounds de ronda**: rev-share 1%–30%, plazo 1–90 días, una ronda por proyecto, refund integral en falla — límites constantes del contrato.
4. **Skin in the game del inversor**: el gate de GOV stakeado alinea al inversor con el proyecto que financió (y con el protocolo).

## No hay garantía de valor

Ningún mecanismo garantiza:

- Que GOV se va a valorizar.
- Que una app va a facturar lo suficiente para pagar el rev-share esperado.
- Que el uso de las apps va a crecer.
- Que un inversor va a recuperar su capital.

La arquitectura alinea incentivos con uso real. Si el uso existe, el sistema opera según lo proyectado. Si no existe, la receita (y por lo tanto el retorno) colapsa. **Un producto malo no se salva con tokenomics.**

## Puntos a observar antes de cualquier exposición

- GMV real por proyecto (`feeRouterV2.grossVolumeOf(projectId)`) y su tendencia.
- Receita ya distribuida a inversores (`funding.totalRevenueDistributed(projectId)`).
- Salud del respaldo del PSM (`psm.backingNormalized()` vs `psm.mintedOutstanding()`).
- Términos de la ronda: rev-share ofrecido vs GMV histórico (la cuenta del rendimiento arriba).
- Propuestas recientes en el Governor (señal de dirección política).
- Distribución real del GOV (¿ya hubo asignaciones a equipo / venta pública / liquidez?).

Ver [Métricas que importan](04-metrics-that-matter.md).

---

**Siguiente →** [Riesgos y seguridad](03-risk-and-security.md)
