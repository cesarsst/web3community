# FAQ

**Audiencia:** cualquier persona con una pregunta específica.
**Requisitos previos:** ninguno.

## General

### ¿Qué es web3community?

Una plataforma multi-aplicación gobernada por DAO. Los apps aceptan CREDIT como pago; 95% del pago se quema, 5% va a la app. Los stakers de GOV en proyectos específicos reciben CREDIT emitido en la próxima ronda en función del burn total. Detalle en [Qué es](../01-getting-started/01-what-is-web3community.md).

### ¿Cuál es la diferencia entre GOV y CREDIT?

GOV es gobernanza (supply fijo 100M, vota). CREDIT es utilitario (supply elástico, quemado en el uso). Detalles en [Dual-token](../02-core-concepts/01-dual-token-economy.md).

### ¿Dónde están los contratos?

12 contratos de producción en `contracts/*.sol`. Referencia individual en [08-contracts-reference](../08-contracts-reference/). Direcciones on-chain en [Contract addresses](../05-for-developers/02-contract-addresses.md).

### ¿En qué red está corriendo?

Ver [Contract addresses](../05-for-developers/02-contract-addresses.md). La red de producción principal se definirá post-auditoría externa.

## Uso

### ¿Necesito saber programar?

No. El hub tiene UI para todas las operaciones. Firmas transacciones en tu wallet.

### ¿Cuánto cuesta participar?

Gas de la red + tokens necesarios (GOV para stakear, CREDIT para pagar apps). En testnet (Sepolia), el gas es casi cero.

### ¿Cómo recibo CREDIT?

- Compra en DEX externa (Uniswap, etc.).
- Recíbelo como reward si stakeaste en un proyecto que generó burn.
- Recíbelo vía `UserSubsidy` si eras elegible en una campaña.

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

### ¿Y si el protocolo muere?

Si el uso cae a casi cero, la emisión colapsa, el APR va a casi cero, los stakers salen. La DAO puede intervenir (ajustar α, abrir subsidio vía Treasury, contratar nuevas apps). Pero el tokenomics no salva a un producto malo.

## Staking

### ¿Cuál es el lock mínimo?

14 días. Lock por debajo revierte con `LockTooShort`.

### ¿Cuál es el lock máximo?

No hay máximo programático. Pero el multiplier satura en 4x a partir de 365 días — lockear más que eso inmoviliza capital sin ganar peso adicional.

### ¿Puedo salir antes del lock?

**No**, excepto si el proyecto es `Removed`. `Probation` (punitiva o inicial) no bypassea lock.

### ¿Puedo stakear en múltiples proyectos?

Sí. Cada `projectId` es una posición independiente.

### Si hago increase_stake, ¿se resetea el lock?

**No.** `increaseStake` preserva `lockStartAt` y `lockDuration`. Solo `stake` en una posición existente resetea.

### Extend lock ¿cambia el amount?

**No.** `extendLock` solo cambia `lockDuration`.

## Rewards

### ¿Cuándo puedo reclamar?

Tras el cierre de la ronda (`closeRound` vía gobernanza) y de ser finalizada (`finalizeRound` — permissionless). Detalle en [Reclamar rewards](../04-for-users/05-claiming-rewards.md).

### ¿Pierdo reward si olvido?

**No.** No hay deadline. Una vez finalizada, tu derecho de claim persiste indefinidamente.

### ¿Por qué mi claim es cero?

Posibles razones:

- Ronda no finalizada (`RoundNotFinalized`).
- Ya reclamaste (`AlreadyClaimed`).
- Tu peso era cero en el `snapshotBlock`.
- El proyecto no generó burn ni tenía peso global.

Usa `previewClaim(you, round, projectId)` para diagnosticar.

### ¿Cuánto voy a recibir?

Depende del burn del proyecto × tu peso × total de la ronda. Fórmula en [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Proyectos / Apps

### ¿Cómo listo mi app?

- Prepara metadata off-chain (IPFS).
- Consigue 10.000 GOV para colateral.
- Alguien con ≥ 10.000 GOV delegados propone `registerProject` en el Governor.
- Tras aprobación y ejecución, `activateProject` (segunda propuesta, puede ser batch).

Detalle en [Enviar un proyecto](../05-for-developers/03-submitting-a-project.md).

### ¿Cuánto recibo por pago?

5% por default. Ajustable por proyecto vía propuesta (`setProjectSplit`).

### Si stakeo en mi propio proyecto, ¿gano más?

Sí. Capturas porción de la emisión proporcional al peso de tu stake. Detalle en [Flujo de valor](../03-protocol-overview/03-economic-flows.md).

### ¿Pierdo mi colateral si salgo?

No, si la remoción es sin slash. La propuesta `removeProject(id, slash=false, _)` devuelve el colateral al owner.

Si la remoción es con slash (`slash=true`), el colateral va al Treasury.

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

**No.** Los contratos son inmutables. La sustitución exige deploy nuevo + migración de roles.

### ¿Tiene pause?

**No.** Decisión consciente — cualquier pause sería vector de captura.

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
```

Detalle en [Entorno local](../05-for-developers/05-local-dev.md).

---

**Siguiente →** [Recursos](02-resources.md)
