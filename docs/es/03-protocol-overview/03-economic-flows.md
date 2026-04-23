# Flujo de valor

**Audiencia:** lector que quiere entender por donde entra, transita y sale el valor real del protocolo.
**Requisitos previos:** [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md), [Treasury y fees](../02-core-concepts/07-treasury-and-fees.md).

## De donde viene el valor real

La unica fuente de **valor externo** en el sistema es el usuario final que paga por CREDIT. Paga porque necesita usar las apps. Si nadie quiere usar las apps, nadie compra CREDIT, y el sistema muere — esa es la invariante dura.

El camino tipico:

```
   [ Usuario Charlie ]
        |
        |  1. Compra 1000 CREDIT en DEX externa por $X en USDC
        |     (liquidez aportada por quien tiene CREDIT y quiere salir,
        |      o por liquidity mining off-protocol — no esta aqui dentro)
        |
        v
   [ Wallet de Charlie tiene 1000 CREDIT ]
        |
        |  2. Usa el Chat App. App cobra 1000 CREDIT por el servicio.
        |     Charlie firma approve(feeRouter, 1000) + feeRouter.pay(...)
        |
        v
   [ FeeRouter ]
        |
        | split 95/0/5 default
        |
        +-------> 950 CREDIT quemados (via BurnTracker)
        |         - CREDIT.totalSupply disminuye
        |         - burn registrado en BurnTracker para el Chat App
        |
        +-------> 50 CREDIT -> app owner (rebate directo)
```

**El valor real entro en el protocolo en el paso 1.** Todos los pasos subsiguientes redistribuyen ese valor. Ninguno de ellos crea valor de la nada.

## Los 4 agentes y por que cada uno esta en el juego

```
   +----------------+     +-----------------+     +----------------+     +-------------+
   | Usuario final  |     |      App        |     |     Staker     |     |   Holder    |
   |   (Charlie)    |     |   (ChatApp)     |     |    (Alice)     |     |  sem stake  |
   +--------+-------+     +--------+--------+     +--------+-------+     +------+------+
            |                      |                       |                    |
     paga en CREDIT         recibe rebate +          lockea GOV en un     poder de voto
     usa la app             captura rewards          projectId +           en el Governor
                            si stakea en el propio   gana CREDIT
                            proyecto                 en la ronda R+1
            |                      |                       |                    |
     extrae valor           captura caja              gana CREDIT          mantiene derecho
     de servicio            operacional +             recien emitido       sobre cambios
     (fuera del             emision dirigida                               de parametros
     protocolo)
```

Nota: **no hay yield "del aire"**. El CREDIT emitido para Alice existe porque Charlie quemo CREDIT. El rebate para el ChatApp existe porque Charlie pago. Ningun actor recibe valor que no venga de algun actor aguas arriba.

## Las 3 fuentes de ingreso de una app

El split default de 5% directo parece poco. Pero la cuenta cierra — si la app tambien stakea en su propio proyecto — por tres vectores simultaneos:

### (A) Rebate directo

5% de cada pago. Instantaneo, en CREDIT. Es el flujo de caja operacional.

### (B) Emision via stake en el propio `projectId`

Si la app adquirio GOV (por ejemplo, comprando en DEX o recibiendo via propuesta de distribucion) y stakeo en `projectId = propio`, captura parte del share de rewards de ese proyecto en la ronda siguiente.

Como?

1. Cuando Charlie paga, 95% es quemado y va a `burnByRoundProject[R][projectId=app]`.
2. En la ronda R+1, la emision es proporcional a ese burn.
3. Si la app tiene peso de staking dentro del propio `projectId`, recibe parte de esa emision.

**Ejemplo numerico** (ronda hipotetica):

- ChatApp mueve 600.000 CREDIT en pagos en la ronda R-1.
- (A) Rebate directo: 5% × 600k = **30.000 CREDIT** inmediato.
- En la ronda R, `projectShare_ChatApp = 902.500 × 600k/950k = 570.000 CREDIT`.
- Si ChatApp stakeo 50k GOV con lock de 365d (multiplier 4x, peso 200k), y el peso total en el proyecto es 400k, captura 50% × 570k = **285.000 CREDIT**.
- Suma (A) + (B) = **315.000 CREDIT** sobre un volumen bruto de 600k = **~52,5%** efectivo.

El split **nominal** cuenta una historia enganosa. El split **economico efectivo** para una app que tambien stakea depende de cuanto stakea y de la competencia de otros stakers en el mismo `projectId`.

### (C) Apreciacion del CREDIT retenido

Como `alpha < 1`, el supply de CREDIT cae si el uso se mantiene constante. El CREDIT que la app recibio (rebate + rewards) y aun no vendio tiende a apreciarse en terminos reales — siempre que la demanda por CREDIT (generada por el uso de las apps) se sostenga.

**Trampa**: si la app vende todo el CREDIT inmediatamente, renuncia a (C). Si retiene, se expone a volatilidad. Es decision de la app.

## Cuando (B) no cierra la cuenta

Apps sin capital para adquirir GOV no capturan (B). Para esos casos:

- El split default (95/0/5) puede ser **desincentivador**.
- La DAO puede aprobar `setProjectSplit(projectId, custom)` via propuesta. Por ejemplo: `8000/0/2000` (20% rebate) para apps estrategicas que no logran stakear.
- Alternativamente, se puede financiar la adquisicion inicial de GOV via `Treasury` (propuesta de transferencia directa).

La arquitectura permite ajuste por proyecto exactamente para ese tipo de acomodacion.

## Flujo por ciclo de ronda

```
   Ronda R-1 (la pasada)                                     Ronda R (ahora)
   +------------------------------------+                   +------------------------------------+
   | Charlie + 10k otros usuarios        |                  | Alice puede claim rewards de R-1   |
   | pagaron en CREDIT en las apps       |                  | en funcion de:                     |
   |                                     |                  |   - burn total de R-1              |
   | BurnTracker registro:               |  closeRound()    |   - burn del proyecto de ella R-1  |
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

## Rotacion de CREDIT

CREDIT entra al supply por **dos** vias unicamente:

1. `CreditToken.mintGenesis` — one-shot, 10M al Treasury, en el deploy.
2. `CreditToken.mint` — por el `RewardDistributor`, en los claims.

Y sale por **una** via:

- `CreditToken.burn` / `burnFrom` / `burnByRole` — el camino principal es via `FeeRouter.pay` → `BurnTracker.burnAndRecord` → `CreditToken.burnByRole`.

Ese flujo cerrado permite analisis simple:

```
   totalSupply_R = totalSupply_{R-1} + (novas emissoes em R) - (burns em R)
```

Si `nuevas emisiones <= burns`, el supply cae. Con `alpha = 0.95` y uso estable, esa es la dinamica esperada.

## Rotacion de GOV

GOV entra al supply de forma permanente hasta alcanzar el cap:

1. Genesis: 0 en el deploy.
2. `mint`: solo por el owner (Timelock en produccion) hasta alcanzar `CAP_SUPPLY = 100M`.
3. Tras alcanzar el cap, `mint` revierte con `CapExceeded`.

No hay burn de GOV en el codigo.

Circulacion:

- **Holder libre** → compra/venta en DEX.
- **Holder → Staking**: `stake` bloquea GOV en el contrato; `unstake` libera.
- **Holder → Registry**: `registerProject` bloquea GOV como colateral; `removeProject` libera (al owner o al treasury).
- **Holder → TeamVesting (via Timelock)**: vesting contracts que liberan gradualmente.
- **Holder → Governor**: `delegate` no mueve GOV, solo confiere poder de voto.

## El rol del Treasury en ese flujo

El Treasury es el **amortiguador** del sistema. El:

- Recibe el genesis de CREDIT (10M).
- Puede recibir `treasuryBps` de los pagos (0% en el default).
- Recibe colateral de proyectos removidos con slash.
- Puede ser financiado por buyback de GOV (via `executeBuyback`, stub en v1).

Y distribuye, via propuestas:

- Subsidios para usuarios nuevos (`UserSubsidy`).
- Vesting para el equipo (`TeamVesting`).
- Pago de rebates batch para apps.
- Financiamiento de operaciones off-chain.

El Treasury **no** se distribuye automaticamente. Todo sale por propuesta.

## Invariante economica de salud

Una senal simple de salud del protocolo: **el burn acumulado tiene que crecer mas rapido que la emision acumulada**, a lo largo de rondas. Como `alpha < 1` garantiza `emision_R ≈ 0.95 × burn_{R-1}`, esa desigualdad se satisface automaticamente mientras:

```
burn_R >= burn_{R-1}
```

Es decir: el protocolo esta saludable mientras el uso real se mantiene o crece. Si burn cae, la emision cae junto, pero la razon `emision/burn` permanece constante en `alpha`. El sintoma terminal es el burn absoluto yendo a cero durante muchas rondas consecutivas.

Metricas completas en [Metricas que importan](../06-for-investors/04-metrics-that-matter.md).

---

**Siguiente →** [Como participar](../04-for-users/01-participate.md)
