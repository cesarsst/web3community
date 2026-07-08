# FAQ

**Audiencia:** cualquier persona con una pregunta específica.
**Requisitos previos:** ninguno.

## General

### ¿Qué es web3community?

Una plataforma multi-aplicación gobernada por DAO. Las apps aceptan CREDIT (estable, 1:1 con USDC) como pago vía `FeeRouterV2`: el protocolo cobra una fee de 2,5% y la app recibe el resto al instante (~97,5%, o ~89,5% si cedió rev-share de 8% en una ronda de captación). Los inversores financian proyectos vía `ProjectFunding` y reciben un % de los ingresos reales. Detalle en [Qué es](../01-getting-started/01-what-is-web3community.md).

### ¿Qué cambió con el remodel 2026-07-08?

El protocolo dejó de ser "burn-to-mint deflacionario" (70% de cada pago quemado + emisión de rewards) y pasó a ser "riel de pagos + financiamiento por rev-share". Motivo: la tasa efectiva de ~80% sobre la app no competía con Stripe (~3,8%) — el bypass era la estrategia dominante. Ver [Modelo mental](../01-getting-started/02-mental-model.md).

### ¿Cuál es la diferencia entre GOV y CREDIT?

GOV es gobernanza + llave de inversión + captura de valor vía buyback (supply fijo 100M, vota). CREDIT es medio de pago estable 1:1 con USDC vía `CreditPSM` (supply elástico, respaldado al 100%). Detalles en [Dual-token](../02-core-concepts/01-dual-token-economy.md).

### ¿Dónde están los contratos?

En `contracts/*.sol`. El núcleo del remodel: `CreditPSM.sol`, `FeeRouterV2.sol`, `ProjectFunding.sol`. Referencia individual en [08-contracts-reference](../08-contracts-reference/) (las páginas del modelo anterior están marcadas como LEGADO). Direcciones on-chain en [Contract addresses](../05-for-developers/02-contract-addresses.md).

### ¿En qué red está corriendo?

Ver [Contract addresses](../05-for-developers/02-contract-addresses.md). La red de producción principal se definirá post-auditoría externa.

## Uso

### ¿Necesito saber programar?

No. El hub tiene UI para todas las operaciones. Firmas transacciones en tu wallet.

### ¿Cuánto cuesta participar?

Gas de la red + tokens necesarios (USDC para comprar CREDIT 1:1, GOV para stakear/invertir). En testnet (Sepolia), el gas es casi cero.

### ¿Cómo recibo CREDIT?

- Deposita USDC en el `CreditPSM` (`buy`) — 1:1, sin fee, sin slippage.
- Recíbelo como pago si eres dueño de una app, o como rev-share si invertiste en una ronda.
- Recíbelo vía `UserSubsidy` si eras elegible en una campaña.

### ¿Puedo convertir CREDIT de vuelta a USDC?

Sí: `CreditPSM.sell` quema tu CREDIT y devuelve USDC 1:1, mientras haya respaldo (todo el CREDIT comprado vía `buy` está respaldado al 100%). El monto debe ser múltiplo de `1e12` wei — el polvo revierte en vez de confiscarse.

### ¿CREDIT se puede valorizar?

No — y es a propósito. CREDIT es estable por construcción (1 CREDIT = 1 USDC). No rinde, no se aprecia, no es una apuesta: es saldo prepago. El activo de exposición al protocolo es GOV.

### ¿Cómo recibo GOV?

- Compra en DEX externa.
- Recíbelo vía asignación aprobada por la DAO (public sale, airdrop, vesting si eres equipo).

### ¿Cómo voto?

1. Delega voting power a ti: `gov.delegate(you)`.
2. Espera a que la propuesta se abra.
3. Llama a `governor.castVote(proposalId, support)` vía UI o directo.

Detalle en [Votar en propuestas](../04-for-users/04-voting.md).

### ¿La DAO puede confiscar mi GOV stakeado?

**No.** El lock del staking protege incluso contra la propia gobernanza. Mientras el lock está vigente, una propuesta aprobada **no destraba** tu stake. La única excepción es si el proyecto queda `Removed` — ahí es liberación anticipada, pro-usuario (no contra).

### ¿La DAO puede gastar el respaldo del PSM?

**No.** El `CreditPSM` no tiene función de retiro del respaldo — ni siquiera vía propuesta de gobernanza. Si la DAO quiere gastar, gasta de la fee del `FeeRouterV2` (40% de la fee ≈ 1% del GMV va al Treasury).

### ¿Y si el protocolo muere?

Si el uso cae a casi cero, el GMV colapsa, el rev-share y el buyback van a cero, los inversores dejan de recibir. Pero el CREDIT en circulación sigue redimible 1:1 hasta el límite del respaldo del PSM. El tokenomics no salva a un producto malo.

## Staking

### ¿Para qué sirve stakear GOV ahora?

Dos cosas: es la **llave de inversión** (solo quien tiene GOV stakeado en un proyecto puede invertir en su ronda y reclamar el rev-share) y es señal de compromiso con el proyecto. Ya **no** genera rewards de emisión — eso era el modelo legado.

### ¿Cuál es el lock mínimo?

14 días. Lock por debajo revierte con `LockTooShort`.

### ¿Cuál es el lock máximo?

No hay máximo programático. El multiplier satura en 4x a partir de 365 días.

### ¿Puedo salir antes del lock?

**No**, excepto si el proyecto es `Removed`. `Probation` (punitiva o inicial) no bypassea lock.

### ¿Puedo stakear en múltiples proyectos?

Sí. Cada `projectId` es una posición independiente — y te habilita a invertir en la ronda de cada uno.

### Si hago increase_stake, ¿se resetea el lock?

**No.** `increaseStake` preserva `lockStartAt` y `lockDuration`. Solo `stake` en una posición existente resetea.

## Inversión (rondas y rev-share)

### ¿Cómo invierto en un proyecto?

1. Stakea GOV en el `projectId` (requisito — sin eso `invest` revierte con `NoGovStaked`).
2. Aprueba CREDIT y llama `funding.invest(projectId, amount)` mientras la ronda está `Open`.
3. Si la ronda alcanza el alvo, el rev-share activa; si vence sin alcanzarlo, `refund()` te devuelve el 100%.

### ¿Qué es el rev-share?

El % de los ingresos **brutos** del proyecto que los inversores reciben en cada pago, fijado por el dueño al abrir la ronda: entre 1% y 30%. Se descuenta automáticamente en `FeeRouterV2.pay` y se acredita pro-rata a las shares (= CREDIT invertido).

### ¿Cuánto voy a ganar?

`rendimiento anual ≈ revShareBps × GMV anual / capital de la ronda`. Ejemplo ilustrativo: ronda de 10.000 CREDIT al 8% con la app facturando 2.000 CREDIT/mes → ~19% a.a. **No hay garantía**: si la app factura cero, recibes cero. Audita `grossVolumeOf(projectId)` antes de invertir.

### ¿Cuándo puedo reclamar mi rev-share?

Cuando quieras (`funding.claim(projectId)`), siempre que mantengas GOV stakeado en el proyecto. El derecho **nunca expira**.

### ¿Pierdo mi rev-share si hago unstake?

**No se pierde**, pero queda inaccesible: `claim` exige GOV stakeado en el momento del retiro. Re-stakea y vuelve a estar disponible. Lo prudente: reclama antes de hacer unstake.

### ¿Puede una ronda quedarse a medias?

No. Es all-or-nothing: o alcanza el 100% del alvo (el dueño recibe todo y el rev-share activa) o falla al vencer el plazo (refund integral). Tampoco se puede invertir por encima del alvo (`ExceedsTarget`).

### ¿Un proyecto puede abrir varias rondas?

No en el MVP: **una** ronda por proyecto (incluso si falló). Rondas múltiples están documentadas para una V2 del contrato.

### ¿Tengo rewards del modelo antiguo por retirar?

Los claims del `RewardDistributor` V1/V2 pre-remodel siguen disponibles (no expiran). Ver [Reclamar rewards](../04-for-users/05-claiming-rewards.md) y las páginas legadas.

## Proyectos / Apps

### ¿Cómo listo mi app?

- Prepara metadata off-chain (IPFS).
- Consigue 10.000 GOV para colateral.
- Alguien con ≥ 10.000 GOV delegados propone `registerProject` en el Governor.
- Tras aprobación y ejecución, `activateProject` (segunda propuesta, puede ser batch).

Detalle en [Enviar un proyecto](../05-for-developers/03-submitting-a-project.md).

### ¿Cuánto recibo por pago?

**~97,5%** de cada pago, al instante (fee del protocolo: 2,5%). Si cediste rev-share en una ronda (por ejemplo 8%), recibes ~89,5%. Usa `feeRouterV2.previewPay(projectId, amount)` para el desglose exacto.

### ¿La fee puede subir?

Vía gobernanza, hasta el techo duro de **5%** (`FEE_BPS_CAP = 500`) — es una constante del contrato: ni una propuesta aprobada puede superarla.

### ¿Cómo consigo capital para mi app?

Abre una ronda en `ProjectFunding`: alvo en CREDIT, rev-share de 1% a 30%, plazo de 1 a 90 días. Si la ronda se completa, recibes el alvo íntegro; el "repago" es la fatia de tu facturación futura (costo de capital ~19% a.a. en el ejemplo de referencia — comparable a revenue-based financing).

### ¿Pierdo mi colateral si salgo?

No, si la remoción es sin slash. La propuesta `removeProject(id, slash=false, _)` devuelve el colateral al owner. Si es con slash (`slash=true`), el colateral va al Treasury.

## Gobernanza

### ¿Cuánto GOV necesito para proponer?

10.000 GOV delegados (producción). Ajustable vía propuesta dentro de `[0, ilimitado]`.

### ¿Cuánto tarda una propuesta?

~10 días en producción: 1d delay + 7d votación + 2d timelock.

### ¿Puedo cancelar mi propuesta?

Sí, mientras está `Pending` o `Active`. Tras `Succeeded`, necesita una propuesta contraria.

### Mi propuesta fue aprobada pero nadie hace queue/execute

Cualquiera puede llamar a `queue` y `execute`. Basta con que alguien lo haga — típicamente un holder comprometido o el proposer.

### ¿Puedo votar por delegación?

Sí. `gov.delegate(trustedAddress)` transfiere voting power a quien confías. Tu balance sigue siendo tuyo.

## Técnico

### ¿Qué versión de Solidity?

0.8.24 con `viaIR: true`.

### ¿Qué OpenZeppelin?

5.0.2 pinado exacto.

### ¿Tiene upgrade path?

**No.** Los contratos son inmutables. La sustitución exige deploy nuevo + migración de roles — exactamente lo que hizo el remodel (FeeRouter V1 → FeeRouterV2, deploy paralelo).

### ¿Tiene pause?

**No.** Decisión consciente — cualquier pause sería vector de captura. (El `CreditPSM` tampoco tiene owner ni setters: cero superficie administrativa.)

### ¿Tiene guardian multisig?

**No en v1.** El Timelock es self-administered. `CANCELLER_ROLE` es solo del Governor (cancel vía propuesta). Un guardian multisig puede agregarse en futura propuesta de la DAO.

### ¿Hay un bug bounty?

Previsto vía Immunefi justo después de mainnet. Rango critical: $50k-$250k.

### ¿Cómo testear localmente?

```bash
npm install
npx hardhat node                       # terminal 1
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost                  # terminal 2
npx hardhat run scripts/deploy-remodel.ts --network localhost   # PSM + FeeRouterV2 + ProjectFunding
```

Detalle en [Entorno local](../05-for-developers/05-local-dev.md).

---

**Siguiente →** [Recursos](02-resources.md)
