# Flujo de valor

**Para quién es:** lector que quiere entender por dónde el valor real entra, transita y sale del protocolo.
**Prerrequisitos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md).

## De dónde viene el valor real

La única fuente de **valor externo** en el sistema es el usuario final que paga por CREDIT. Paga porque necesita usar las apps. Si nadie quiere usar las apps, nadie compra CREDIT, y el sistema muere — esa es la invariante dura.

La liquidez del par CREDIT/USDC se construye por dos vías complementarias en el Credit Liquidity Protocol (CLP):

1. **POL** — Protocol-Owned Liquidity. El propio Treasury custodia una posición NFT en el pool. Construida por (a) seed inicial del genesis CREDIT + USDC del Treasury, (b) refill vía bucket bonders + USDC del `treasuryBps`.
2. **LPs externos** — usuarios que provisionan liquidez en el pool y stakean el NFT en el `LiquidityGauge`. Reciben incentives en CREDIT (bucket LPs del V2, default 25% de la emisión).

El camino típico de un pago:

```
   [ Usuario Charlie ]
        |
        |  1. Compra 1000 CREDIT en la DEX (POL + LPs externos proveen liquidez)
        |
        v
   [ Wallet de Charlie tiene 1000 CREDIT ]
        |
        |  2. Usa el Chat App. La app cobra 1000 CREDIT por el servicio.
        |     Charlie firma approve(feeRouter, 1000) + feeRouter.pay(...)
        |
        v
   [ FeeRouter ]
        |
        | split por defecto 95/0/5 (recomendacion CLP: 70/20/10)
        |
        +-------> burnBps quemados (via BurnTracker)
        |         - CREDIT.totalSupply disminuye
        |         - burn registrado en el BurnTracker para el Chat App
        |
        +-------> treasuryBps -> Treasury (USDC funding para refill POL)
        |
        +-------> rebateBps -> app owner (rebate directo)
```

**El valor real entró en el protocolo en la etapa 1.** Todas las etapas siguientes redistribuyen ese valor.

## Los 5 agentes y por qué cada uno está en el juego

Con el pivote CLP, el **LP** entra como agente formal — antes era sólo externo, ahora recibe bucket dedicado.

```
   +----------+    +-------------+    +----------+    +----------+    +------------+
   | Usuario  |    |    App      |    |  Staker  |    |    LP    |    |   Holder   |
   | final    |    | (ChatApp)   |    |  (Alice) |    |   (Bob)  |    |  sin stake |
   +----+-----+    +------+------+    +----+-----+    +----+-----+    +-----+------+
        |                 |                |               |                |
   paga en CREDIT    recibe rebate    lockea GOV en   LP en el pool    poder de voto
   usa la app        + bucket apps    projectId       CREDIT/USDC      en el Governor
                     (push directo    gana bucket     + stakea NFT
                      retrospectivo   stakers         en LiquidityGauge
                      por burn)       (claim)         gana bucket LPs
                                                      (vesting 14d)
        |                 |                |               |                |
   extrae valor      captura caja     gana CREDIT     gana CREDIT      mantiene derecho
   de un servicio    operacional +    recien-emitido  recien-emitido   sobre cambios
   (fuera del        emision push     en claim        en harvest       de parametros
   protocolo)        (apps bucket)    (stakers)       (LPs bucket)
```

Notá: **no hay yield "del aire"**. El CREDIT minteado para Alice (staker), Bob (LP) y ChatApp (apps bucket) existe porque Charlie quemó CREDIT. Ningún actor recibe valor que no provino de algún actor aguas arriba.

## Las 3 fuentes de ingreso de una app

El split por defecto de 5% directo parece poco. Pero la cuenta cierra — si la app también stakeó en su propio proyecto — por tres vectores simultáneos:

### (A) Rebate directo

5% de cada pago. Instantáneo, en CREDIT. Es el flujo de caja operacional.

### (B) Emisión vía stake en el propio `projectId`

Si la app adquirió GOV (por ejemplo, comprando en DEX o recibiendo vía propuesta de distribución) y stakeó en `projectId = propio`, captura parte de la share de rewards de ese proyecto en la ronda siguiente.

¿Cómo?

1. Cuando Charlie paga, 95% se quema y va a `burnByRoundProject[R][projectId=app]`.
2. En la ronda R+1, la emisión es proporcional a ese burn.
3. Si la app tiene peso de staking dentro del propio `projectId`, recibe parte de esa emisión.

**Ejemplo numérico** (ronda hipotética):

- ChatApp mueve 600.000 CREDIT en pagos en la ronda R-1.
- (A) Rebate directo: 5% × 600k = **30.000 CREDIT** instantáneo.
- En la ronda R, `projectShare_ChatApp = 902.500 × 600k/950k = 570.000 CREDIT`.
- Si ChatApp stakeó 50k GOV con lock de 365d (multiplier 4x, peso 200k), y el peso total en el proyecto es 400k, captura 50% × 570k = **285.000 CREDIT**.
- Suma (A) + (B) = **315.000 CREDIT** de un volumen bruto de 600k = **~52,5%** efectivo.

El split **nominal** cuenta una historia engañosa. El split **económico efectivo** para una app que también stake depende de cuánto stake y de la competencia de otros stakers en el mismo `projectId`.

### (C) Apreciación del CREDIT retenido

Como `alpha < 1`, el supply de CREDIT cae si el uso se mantiene constante. El CREDIT que la app recibió (rebate + rewards) y aún no vendió tiende a apreciarse en términos reales — siempre que la demanda por CREDIT (generada por el uso de las apps) se sostenga.

**Trampa**: si la app vende todo el CREDIT inmediatamente, renuncia a (C). Si retiene, queda expuesta a volatilidad. Es decisión de la app.

## Cuándo (B) no cierra la cuenta

Apps sin capital para adquirir GOV no capturan (B). Para esos casos:

- El split por defecto (95/0/5) puede ser **desincentivador**.
- La DAO puede aprobar `setProjectSplit(projectId, custom)` vía propuesta. Por ejemplo: `8000/0/2000` (20% rebate) para apps estratégicas que no logran stakear.
- Alternativamente, se puede financiar adquisición inicial de GOV vía `Treasury` (propuesta de transferencia directa).

La arquitectura permite ajuste por proyecto exactamente para ese tipo de acomodación.

## Flujo por ciclo de ronda

```
   Ronda R-1 (la pasada)                                     Ronda R (ahora)
   +------------------------------------+                   +------------------------------------+
   | Charlie + 10k otros usuarios        |                  | Alice puede claim rewards de R-1   |
   | pagaron en CREDIT en las apps       |                  | en funcion de:                     |
   |                                     |                  |   - burn total de R-1              |
   | BurnTracker registro:               |  closeRound()    |   - burn de su proyecto en R-1     |
   |   totalBurnByRound[R-1] = 950_000   |  --------->      |   - peso del stake de ella         |
   |   burnByRoundProject[R-1][42] = 600_000                |                                    |
   +------------------------------------+                   +------------------------------------+
                                                                     |
                                                               finalizeRound(R-1)
                                                                     |
                                                                     v
                                                            emision = min(
                                                                max(0.95 * 950_000, floor(R-1)),
                                                                capMax
                                                            ) = 902_500 CREDIT (en el ejemplo)

                                                            roundData[R-1].totalEmission = 902_500
                                                            roundData[R-1].snapshotBlock = block.number

                                                            Stakers pueden claim:
                                                              project_share(42) = 902_500 * 600k/950k = 570k
                                                              alice_claim = 570k * aliceW/projectW
```

## Rotación de CREDIT

CREDIT entra al supply por **dos** vías solamente:

1. `CreditToken.mintGenesis` — one-shot, 10M al Treasury, en el deploy.
2. `CreditToken.mint` — por el `RewardDistributor`, en los claims.

Y sale por **una** vía:

- `CreditToken.burn` / `burnFrom` / `burnByRole` — el camino principal es vía `FeeRouter.pay` -> `BurnTracker.burnAndRecord` -> `CreditToken.burnByRole`.

Ese flujo cerrado permite análisis simple:

```
   totalSupply_R = totalSupply_{R-1} + (nuevas emisiones en R) - (burns en R)
```

Si `nuevas emisiones <= burns`, el supply cae. Con `alpha = 0.95` y uso estable, esa es la dinámica esperada.

## Rotación de GOV

GOV entra al supply de forma permanente hasta alcanzar el cap:

1. Genesis: 0 en el deploy.
2. `mint`: sólo por el owner (Timelock en producción) hasta alcanzar `CAP_SUPPLY = 100M`.
3. Tras alcanzar el cap, `mint` reverte con `CapExceeded`.

No hay burn de GOV en el código.

Circulación:

- **Holder libre** -> compra/venta en DEX.
- **Holder -> Staking**: `stake` lockea GOV en el contrato; `unstake` libera.
- **Holder -> Registry**: `registerProject` lockea GOV como colateral; `removeProject` libera (al owner o al treasury).
- **Holder -> TeamVesting (via Timelock)**: contratos de vesting que liberan gradualmente.
- **Holder -> Governor**: `delegate` no mueve GOV, sólo confiere poder de voto.

## El rol del Treasury en este flujo (post-CLP)

El Treasury es el **amortiguador** del sistema. Él:

- Recibe el genesis de CREDIT (10M).
- Puede recibir `treasuryBps` de los pagos (recomendación CLP: subir de 0% a 20%).
- Recibe colateral de proyectos removidos con slash.
- **Recibe el bucket bonders** del `RewardDistributorV2` (5% de la emisión por ronda — ledger `polRefillBucket`).
- **Puede recibir el bucket LPs** cuando gauge paused (ledger `pendingGaugeRewards`).

Y distribuye, vía propuestas:

- **Ejecuta FFP buyback** — swap USDC -> CREDIT + quema inmediata, defendiendo el floor.
- **Provisiona POL** — `addPOL` / `addPOLFromRefill`.
- Subsidios para usuarios nuevos (`UserSubsidy`).
- Vesting para el equipo (`TeamVesting`).
- Pago de rebates batch para apps.
- Financiamiento de operaciones off-chain.

El Treasury **no** se distribuye automáticamente — todo sale por propuesta. Pero a partir del CLP, el Treasury ejecuta tres loops económicos (en lugar de sólo custodiar):

1. **Loop FFP**: `recordDailyPrice` (keeper) -> MA90 crece -> spot < floor por 24h -> gobernanza propone `executeBuyback` -> swap USDC->CREDIT -> quema -> `totalSupply` cae -> precio presionado para arriba.
2. **Loop POL refill**: `treasuryBps` trae USDC -> bucket bonders trae CREDIT -> gobernanza propone `addPOLFromRefill` -> liquidez en el pool aumenta -> menor slippage para holders.
3. **Loop fallback gauge**: `RewardDistributorV2` detecta gauge paused -> mint al Treasury -> gobernanza despausa gauge -> `flushPendingGaugeRewards` envía CREDIT acumulado de vuelta como incentive.

## Invariante económica de salud

Una señal simple de salud del protocolo: **el burn acumulado debe crecer más rápido que la emisión acumulada**, a lo largo de las rondas. Como `alpha < 1` garantiza `emisión_R ≈ 0.95 × burn_{R-1}`, esa desigualdad se satisface automáticamente mientras:

```
burn_R >= burn_{R-1}
```

Es decir: el protocolo está saludable mientras el uso real se mantiene o crece. Si burn cae, emisión cae junto, pero la razón `emisión/burn` permanece constante en `alpha`. El síntoma terminal es burn absoluto yendo a cero por muchas rondas consecutivas.

Post-CLP, dos señales adicionales:

- **MA90 del CREDIT creciente** — indica precio saludable; el floor relativo (`0.5 × MA90`) acompaña. Si spot cae debajo del floor por 24h, se propone FFP buyback.
- **POL TVL creciente** — Treasury acumula liquidez propia. Mayor POL = menor slippage para holders y menor dependencia de LPs externos para salir.

Métricas completas en [Métricas que importan](../06-for-investors/04-metrics-that-matter.md).

---

**Siguiente ->** [Cómo participar](../04-for-users/01-participate.md)
