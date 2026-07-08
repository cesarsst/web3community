# Cómo participar

**Audiencia:** usuario común, poca experiencia con DAO, poca paciencia para teoría.
**Requisitos previos:** tener una wallet EVM (MetaMask, Rabby, Coinbase Wallet, etc.).

## Las tres formas de estar en el sistema

Puedes participar de tres maneras, en orden creciente de compromiso:

1. **Usuario de app** — compras CREDIT en DEX externa, lo gastas en las apps. Es el flujo más simple.
2. **Staker** — bloqueas GOV en proyectos que apoyas, recibes CREDIT emitido.
3. **Votante** — delegas voting power y votas en propuestas del Governor.

Puedes combinar las tres. Muchos stakers también son usuarios y votantes.

## Como usuario de app — paso a paso

**Lo que necesitas:**

- Una wallet EVM conectada a la red del protocolo.
- ETH (gas).
- CREDIT — adquirido en DEX externa (Uniswap, PancakeSwap, etc., según integraciones que aparezcan).

**Lo que haces:**

1. En la UI de la app, descubre el precio del servicio en CREDIT.
2. Haces clic en "pagar" — la app te dirige a firmar:
   - `CREDIT.approve(feeRouterV2, amount)` (una única vez — aprueba el gasto).
   - `FeeRouterV2.pay(projectId, amount)` (efectiviza el pago; el payer eres tú, `msg.sender`).
3. Recibes el servicio de la app. Del valor pagado: 2,5% es la fee del protocolo (40% treasury / 40% buyback de GOV / 20% grants), el rev-share (si el proyecto tiene ronda financiada) va a los inversores y el resto (~89,5–97,5%) va a la app al instante. Nada se quema.

**Lo que no es necesario:**

- **No** necesitas tener GOV.
- **No** necesitas votar.
- **No** necesitas stakear.

Algunas apps pueden ofrecer un flujo donde ellas mismas envían la tx (tú solo firmas meta-transacción). En ese caso, el `approve` basta.

## Como staker — paso a paso

**Lo que necesitas:**

- GOV — adquirido en DEX externa o recibido por alguna asignación.
- Decisión consciente de qué `projectId` apoyar.
- Decisión de lock (14 a 365+ días).

**Lo que haces:**

1. Elige el proyecto. Consulta el Registry (`projects[projectId]`) para confirmar `status == Active` y leer la `metadataURI`.
2. Elige el lock. Multiplier lineal: 14d = 1x, 365d = 4x. Locks mayores a 365d son aceptados pero el multiplier satura en 4x.
3. `GOV.approve(staking, amount)`.
4. `Staking.stake(projectId, amount, lockDuration)`.
5. Espera a que las rondas cierren y sean finalizadas.
6. `RewardDistributor.claim(round, projectId)` o `claimMany([rounds], [projectIds])` para retirar CREDIT.

**Salir:**

- Tras expirar el lock: `Staking.unstake(projectId, amount)` o `unstakeAll(projectId)`.
- Si el proyecto queda `Removed` antes: unstake inmediato (bypass del lock).
- Durante el lock (y proyecto no-Removed): **no puedes salir**. Planea.

Más detalle en [Staking en proyectos](03-staking-in-projects.md) y [Reclamar rewards](05-claiming-rewards.md).

## Como votante — paso a paso

**Lo que necesitas:**

- GOV (cualquier cantidad).
- Delegar voting power a ti mismo (sin delegación = sin voto, incluso con GOV).

**Lo que haces:**

1. `GovernanceToken.delegate(yourAddress)` — una única vez. Eso activa tu voting power.
2. Cuando se abre una propuesta, accede a la UI del Governor (hub).
3. `CommunityGovernor.castVote(proposalId, support)` — `support` = 0 (Against), 1 (For), 2 (Abstain).
4. Espera a que cierre la votación. Si la propuesta vence, va al Timelock.
5. Tras el delay del Timelock (2d), cualquiera puede llamar a `execute` — tu acción no es necesaria, solo buena señal.

**No** necesitas stakear para votar. El voting power viene del GOV que posees (vía `getPastVotes`), no del stake.

Más detalle en [Votar en propuestas](04-voting.md).

## Costos operacionales

| Acción | Costo |
|---|---|
| `approve` (una vez por allowance) | ~46k gas |
| `FeeRouter.pay` (split default) | ~180-220k gas |
| `Staking.stake` | ~250-300k gas |
| `Staking.unstake` | ~150-200k gas |
| `RewardDistributor.claim` (una ronda/proyecto) | ~180-220k gas |
| `RewardDistributor.claimMany` (N pares) | ~180k + ~140k × N |
| `CommunityGovernor.castVote` | ~90k gas |

Valores aproximados en gas — el costo en ETH depende de la red y del precio del gas en el momento.

## Lo que no hacer

- **No envíes GOV directo a los contratos económicos.** `Staking.stake` hace pull vía `transferFrom`. Una transferencia directa queda atascada.
- **No intentes `unstake` antes del lock** si el proyecto está `Active` o `Probation`. Revierte con `LockNotExpired`.
- **No pagues en apps sin `approve`.** La función `pay` necesita allowance.
- **No olvides el `delegate`** si quieres votar — tener GOV sin delegar = voting power 0.
- **No creas en "yield garantizado"**. El reward varía con el uso de las apps. Si el uso cae, el reward cae junto.

## FAQ rápido

**¿Necesito saber programar?** No. El hub del protocolo tiene UI para todas las operaciones. Firmas transacciones en tu wallet.

**¿Cuánto cuesta participar?** El costo base es gas de la red. En Sepolia (testnet) es casi cero. Para stakear necesitas tener GOV. Para usar apps, CREDIT.

**¿La DAO puede confiscar mi GOV stakeado?** No. El lock protege incluso contra la propia gobernanza. Mientras el lock está vigente, ni una propuesta aprobada destraba tu stake (excepto si el proyecto es removido — ahí el destrabe es a favor tuyo, no en contra).

**¿Y si el protocolo muere?** Si el uso cae a casi cero, el GMV colapsa, el rev-share y el buyback van a cero, los inversores dejan de recibir. Tu CREDIT sigue redimible 1:1 contra el respaldo del PSM. La DAO puede intervenir (subsidios vía Treasury, grants, nuevas apps). Pero el tokenomics no salva a un producto malo.

---

**Siguiente →** [Tener GOV](02-holding-gov.md)
