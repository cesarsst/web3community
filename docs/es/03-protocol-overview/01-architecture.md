# Arquitectura

**Para quién es:** dev que busca un mapa completo de dependencias entre contratos.
**Prerrequisitos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md), [Gobernanza](../02-core-concepts/05-governance.md).

> **Remodel 2026-07-08.** El núcleo económico vigente son tres contratos: [`CreditPSM`](../08-contracts-reference/15-CreditPSM.md), [`FeeRouterV2`](../08-contracts-reference/08b-FeeRouterV2.md) y [`ProjectFunding`](../08-contracts-reference/16-ProjectFunding.md). Los contratos del modelo burn-to-mint (FeeRouter V1, BurnTracker, RewardDistributor V1/V2, LiquidityGauge) siguen deployados como **legado** — operativos solo para claims históricos.

## Mapa vigente (post-remodel)

```
                               +-----------------------------+
                               |     CommunityGovernor       |    (capa politica)
                               |     - colecta votos         |
                               |     - crea propuestas       |
                               +-------------+---------------+
                                             | schedule()
                                             v
                               +-----------------------------+
                               |     CommunityTimelock       |    (ejecutor)
                               |     tiene GOVERNANCE_ROLE   |
                               |     en todos los de abajo   |
                               +----+-------------------+----+
                                    |                   |
              +---------------+-----+------+------------+-------------+
              |               |            |            |             |
              v               v            v            v             v
      +-----------+    +----------+   +---------+  +-----------+  +----------+
      | Project-  |    | Treasury |   | Staking |  | FeeRouter |  | Project- |
      | Registry  |    | (opex:   |   | GOV lock|  |    V2     |  | Funding  |
      | whitelist |    |  40% de  |   | 14-365d |  | fee 2,5%  |  | rondas + |
      | + estados |    |  la fee) |   | mult 4x |  | cap 5%    |  | rev-share|
      +-----+-----+    +----------+   +----+----+  +-----+-----+  +----+-----+
            ^                              ^              |             ^
            | isActive /                   | getWeight    |             |
            | getProject(owner)            | (gate de     |             |
            |                              |  inversion)  |             |
            +------------------------------+--------------+             |
            |                                             |             |
            |     pay(projectId, amount):                 |             |
            |       fee 2,5% -> 40% treasuryRecipient     |             |
            |                   40% buybackRecipient (GOV)|             |
            |                   20% grantsRecipient       |             |
            |       revShare (revShareBpsOf) -------------+-------------+
            |            safeTransfer + notifyRevenue     |  (REVENUE_NOTIFIER_ROLE)
            |       resto -> appRecipient (o owner)       |
            |                                             |
            v                                             v
   +-----------------------------+          +-----------------------------+
   |         CreditToken         | <------- |          CreditPSM          |
   |         ERC-20              |  mint /  |  buy():  USDC in, 1:1 mint  |
   |  (pagos, rondas, claims)    |  burn    |  sell(): burn, USDC out     |
   +-----------------------------+          |  respaldo 100% RETENIDO     |
                                            |  (sin funcion de retiro)    |
                                            +--------------+--------------+
                                                           ^
                                                           | USDC (6 dec)
                                                           |
                                                    [ stablecoin externa ]

   GovernanceToken (GOV) ---- stakeado en Staking (gate de ProjectFunding)
                         ---- colateral en ProjectRegistry
                         ---- vested en TeamVesting
                         ---- vota en CommunityGovernor
                         ---- demandado por el buyback continuo (40% de la fee)

   Contratos auxiliares:
   +----------------+   +------------------+
   |  TeamVesting   |   |   UserSubsidy    |
   |  vesting GOV   |   | subsidio CREDIT  |
   |  por miembro   |   | via Merkle drops |
   +----------------+   +------------------+
   (fondeados por el Timelock con GOV/CREDIT transferido del Treasury)

   Legado (deployado, sin flujo economico nuevo):
   FeeRouter V1 - BurnTracker - RewardDistributor V1 - RewardDistributorV2
   LiquidityGauge - CreditPriceOracle (FFP) - POL del Treasury
```

## Quién llama a quién (modelo vigente)

| Llamador | Llama | Cuando |
|---|---|---|
| `CreditPSM.buy` | `USDC.safeTransferFrom(user, psm, usdcAmount)` | jala el respaldo |
| `CreditPSM.buy` | `CREDIT.mint(user, usdcAmount * 1e12, "psm:buy")` | mintea 1:1 (6→18 dec) |
| `CreditPSM.sell` | `CREDIT.safeTransferFrom(user, psm, creditAmount)` | jala el CREDIT al PSM |
| `CreditPSM.sell` | `CREDIT.burnByRole(psm, creditAmount, "psm:sell")` | quema del saldo propio |
| `CreditPSM.sell` | `USDC.safeTransfer(user, creditAmount / 1e12)` | devuelve el respaldo |
| `FeeRouterV2.pay` | `REGISTRY.isActive(projectId)` | gate |
| `FeeRouterV2.pay` | `CREDIT.safeTransferFrom(payer, router, amount)` | jala el monto total |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer(treasuryRecipient / buybackRecipient / grantsRecipient, ...)` | reparte la fee 40/40/20 |
| `FeeRouterV2.pay` | `FUNDING.revShareBpsOf(projectId)` | lee rev-share activo (0 si no Funded) |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer(funding, revShare)` + `FUNDING.notifyRevenue(projectId, revShare)` | acredita a inversores (transfer ANTES de notify) |
| `FeeRouterV2.pay` | `CREDIT.safeTransfer(appRecipient, toApp)` | paga a la app (fallback: owner del Registry) |
| `FeeRouterV2.setAppRecipient` | `REGISTRY.getProject(projectId).owner` | valida dueño |
| `ProjectFunding.openRound` | `REGISTRY.isActive` + `getProject().owner` | gates (proyecto Active, solo dueño) |
| `ProjectFunding.invest` | `STAKING.getWeight(investor, projectId)` | gate: exige GOV stakeado (> 0) |
| `ProjectFunding.invest` | `CREDIT.safeTransferFrom(investor, funding, amount)` | jala el aporte |
| `ProjectFunding._fund` (alvo batido) | `CREDIT.safeTransfer(owner, raised)` | paga al dueño; status → Funded |
| `ProjectFunding.refund` | `CREDIT.safeTransfer(investor, amount)` | devolución 100% (ronda Failed) |
| `ProjectFunding.claim` | `STAKING.getWeight(investor, projectId)` | gate: exige GOV aún stakeado |
| `ProjectFunding.claim` | `CREDIT.safeTransfer(investor, pending)` | paga receita acumulada |
| `Staking.stake` / `increaseStake` | `ProjectRegistry.isActive(projectId)` | gate |
| `Staking.stake` | `GOV.safeTransferFrom(user, this, amount)` | jala colateral |
| `Staking.unstake` | `GOV.safeTransfer(user, amount)` | devuelve (post-lock o proyecto Removed) |
| `ProjectRegistry.registerProject` | `GOV.safeTransferFrom(owner, this, collateral)` | jala colateral |
| `ProjectRegistry.removeProject` | `GOV.safeTransfer(destination, collateral)` | devuelve o slashea |
| `CommunityGovernor._queueOperations` | `CommunityTimelock.schedule(...)` | encola ejecución |
| `CommunityTimelock.execute*` | `CALLS.execute(...)` | llama función objetivo (Registry, FeeRouterV2, ProjectFunding, Treasury, etc.) |

Los flujos del modelo legado (FeeRouter V1 → BurnTracker → burn; RewardDistributor → mint) están documentados en las páginas de contratos marcadas como legado.

## Post-deploy: el grafo de roles (remodel)

```
   CommunityTimelock (auto-administrado tras handoff)
       |
       |  tiene GOVERNANCE_ROLE en:
       |  - FeeRouterV2 (setFeeBps <= 500, setFeeSplit, setRecipients)
       |  - ProjectFunding (setMinTarget)
       |  - Treasury, ProjectRegistry, Staking (pre-remodel, siguen operativos)
       |  - contratos legados (BurnTracker, RewardDistributor*, FeeRouter V1,
       |    LiquidityGauge) — solo administracion residual
       |
       |  tiene DEFAULT_ADMIN_ROLE en todos los de arriba
       |
       |  es owner de:
       |  - GovernanceToken (tras acceptOwnership)
       |  - cada TeamVesting

   CommunityGovernor
       |
       |  tiene PROPOSER_ROLE + CANCELLER_ROLE en el Timelock

   address(0)
       |
       |  cuenta como ejecutor autorizado en el Timelock
       |  (cualquiera puede llamar execute tras el delay)

   CreditPSM
       |
       |  tiene MINTER_ROLE en CreditToken  (mint 1:1 en buy)
       |  tiene BURNER_ROLE en CreditToken  (burn del saldo PROPIO en sell —
       |                                     nunca toca saldo de terceros)

   FeeRouterV2
       |
       |  tiene REVENUE_NOTIFIER_ROLE en ProjectFunding
       |  (unico autorizado a notifyRevenue)

   FeeRouterV2.setAppRecipient: owner-gated por proyecto (rotacion operacional)

   Legado: RewardDistributor V1/V2 y BurnTracker conservan MINTER_ROLE /
   BURNER_ROLE historicos hasta que la governanza los revoque (claims legados).
```

## Dependencias de imports Solidity (núcleo vigente)

```
GovernanceToken       -> OZ: ERC20, ERC20Permit, ERC20Votes, Ownable2Step
CreditToken           -> OZ: ERC20, ERC20Burnable, AccessControl
CreditPSM             -> OZ: IERC20, IERC20Metadata, SafeERC20, ReentrancyGuard
                          + CreditToken
FeeRouterV2           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + ProjectRegistry, ProjectFunding
ProjectFunding        -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + ProjectRegistry, Staking
ProjectRegistry       -> OZ: IERC20, SafeERC20, AccessControl
Staking               -> OZ: IERC20, SafeERC20, ReentrancyGuard, Checkpoints, SafeCast
                          + ProjectRegistry
Treasury              -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard
                          + interfaces Uniswap/Chainlink (FFP/POL — legado)
CommunityTimelock     -> OZ: TimelockController
CommunityGovernor     -> OZ: Governor + 5 extensiones
TeamVesting           -> OZ: IERC20, SafeERC20, Ownable, Ownable2Step
UserSubsidy           -> OZ: IERC20, SafeERC20, AccessControl, ReentrancyGuard, MerkleProof
```

Los imports de los contratos legados (BurnTracker, RewardDistributor V1/V2, FeeRouter V1, LiquidityGauge, CreditPriceOracle) están en sus páginas de referencia.

## Protecciones estructurales

1. **Voto anti-flashloan** — `Governor` usa `ERC20Votes.getPastVotes(account, proposalSnapshot)`. Quien toma flash-loan en el bloque de la votación no logra votar, porque el snapshot está en el pasado (`votingDelay` bloques atrás del bloque actual).

2. **Gate de inversión con capital comprometido** — `ProjectFunding.invest`/`claim` exigen `Staking.getWeight(msg.sender, projectId) > 0` en vivo. Un flash-loan de GOV no ayuda: `stake` exige lock mínimo de 14 días (incompatible con devolución en el mismo bloque), y el retorno del inversor está atado a CREDIT **ya depositado** — no hay share que inflar a último momento: las shares se fijan al invertir y son inmutables tras el `Funded`.

3. **CEI en todo el núcleo** — `invest` aplica effects antes de interactions; `notifyRevenue` solo contabiliza CREDIT que el router ya transfirió; `sell` del PSM quema del saldo propio tras el `transferFrom`.

## Puntos de confianza

**Confiables por construcción** (código inmutable y auditado):

- Todas las libs OZ 5.0.2 pinned.
- Cap del GOV (100M, inmutable).
- **Respaldo del PSM**: `USDC.balanceOf(PSM) >= mintedOutstanding` (normalizado); no existe función de retiro del respaldo — ni para la gobernanza (I-PSM1).
- **Conversión exacta 1:1** del PSM: factor `SCALE = 1e12`; `sell` con polvo por debajo de 1e-6 USDC revierte en vez de confiscar (I-PSM2).
- **Techo duro de la fee**: `FEE_BPS_CAP = 500` (5%) — constante, ni la gobernanza lo supera.
- **Bounds de las rondas**: rev-share `[100, 3000]` bps (1%–30%), duración `[1, 90]` días, una ronda por proyecto, all-or-nothing.
- Suma del `FeeSplit` == 10000 bps validada en constructor y setter.
- Snapshot anti-flashloan del voto.

**Confiables por gobernanza** (mutables vía propuesta, pero el cambio pasa por todos los delays):

- `feeBps` (≤ 500), `feeSplit` (40/40/20 default), `treasuryRecipient`/`buybackRecipient`/`grantsRecipient` del FeeRouterV2.
- `minTarget` del ProjectFunding (default 100 CREDIT).
- `minCollateral`, `probationDuration` del Registry.
- Parámetros del Governor (voting delay, period, threshold, quorum).

**Confiables fuera del sistema** (depende de integración externa):

- **USDC** — el respaldo del CREDIT es USDC retenido en el PSM. Un depeg o bloqueo del USDC (blacklist del emisor) afecta directamente la convertibilidad del CREDIT. Es la mayor dependencia externa del modelo.
- Integridad de datos off-chain en la `metadataURI` de los proyectos (el Registry guarda sólo el CID).
- En el MVP dev, los tres recipients de la fee apuntan al mismo Treasury — la separación contable la dan las parcelas del evento `PaymentRouted`.

---

**Siguiente ->** [Flujos de usuario](02-user-flows.md)
