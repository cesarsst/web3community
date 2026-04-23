# Mainnet deployment

**Audiencia:** equipo técnico haciendo deploy en red pública.
**Requisitos previos:** familiaridad con Hardhat + Ignition.

Este documento **no** es "cómo correr `ignition deploy`" — eso está automatizado. Es el **procedimiento crítico** antes, durante y después del deploy, que garantiza que la DAO nazca segura.

## La paradoja del bootstrap

Toda DAO ERC20Votes + Timelock + Governor tiene el mismo dilema:

> Para cambiar el estado del protocolo, hay que pasar por propuesta.
> Para hacer la primera propuesta, hace falta GOV delegado por encima del threshold.
> Para tener GOV, alguien necesita haber minteado.
> Pero mintear ya es un cambio de estado.

Existe una ventana — entre el deploy y el `acceptOwnership` del Timelock — donde **una única dirección (el deployer) tiene el poder soberano** de decidir cuánto GOV existe y quién lo recibe. Ese poder es necesario para el bootstrap. Es también el mayor riesgo operacional.

Tres formas saludables de cerrar esa ventana:

1. **Multi-sig como deployer** — no una EOA. Gnosis Safe 4-de-7 con signatarios públicos.
2. **Mint mínimo para bootstrap** — mintear solo lo necesario para pasar el `proposalThreshold`, no los 100M. La distribución real viene después, vía propuestas.
3. **Handoff rápido** — `acceptOwnership` debe ser la primera propuesta. Cuanto menos tiempo sea el deployer owner, menor la ventana.

## Las 4 fases

| Fase | Cuándo | Actores | Entrega |
|---|---|---|---|
| **F0 — Pre-deploy** | T-8 a T-1 semanas | Auditores, multisig, equipo | Código auditado, monitoreo en pie, multisig operacional |
| **F1 — Deploy** | Día D | Deployer (multisig) | 12 contratos on-chain, verificados en Etherscan |
| **F2 — Bootstrap** | D+1 a D+12 | Deployer → Governor | `acceptOwnership` ejecutado; el Timelock es owner |
| **F3 — Distribución** | D+12 a D+90 | DAO (multisig + holders) | GOV distribuido vía propuestas |
| **F4 — Handoff completo** | D+90+ | Comunidad | El multisig pierde mayoría del voto |

Cada fase tiene un gate. Si el gate falla, **no avanza**.

## F0 — Pre-deploy

Checklist obligatorio:

- [ ] **Auditoría externa completa.** Trail of Bits, OpenZeppelin, Certik o Zellic. Elegir una (preferentemente dos) y cerrar todos los findings high/medium. Findings low/informational documentados como aceptados.
- [ ] **Reporte de auditoría público** antes del deploy.
- [ ] **Bug bounty activo** en Immunefi (critical: rango $50k-$250k) a partir del día D.
- [ ] **Multisig operacional.** Gnosis Safe con ≥4 signatarios geográficamente distribuidos. Threshold 3/5 o 4/7. Signatarios con reputación pública.
- [ ] **Test en Sepolia por ≥ 14 días** corriendo el mismo perfil de producción — incluyendo `acceptOwnership` + 3 propuestas reales.
- [ ] **Monitoreo on-chain** configurado antes del deploy: Forta, Tenderly, OZ Defender. Eventos críticos: `CapExceeded`, `SanityCapExceeded`, `RoundClosed(earlyClose=true)`, `Transferred` (Treasury), `RoleGranted`, `RoleRevoked`.
- [ ] **Runbook de incidente** escrito: quién apaga el fuego, quién cancela propuesta, quién comunica a holders.

### Contratos externos dependientes

Estos **no** están en el módulo principal y necesitan existir antes del deploy:

- **Vesting (team)** — usa `TeamVesting` del propio repo (auditado junto con el resto).
- **Sale contract (public sale)** — a definir por propuesta. Bonding curve, fixed-price, LBP etc.
- **Liquidity pool** — dirección y configuración del pool Uniswap V2/V3 o Balancer donde los 10% de liquidity bootstrap serán provisionados.

### Revisión de `production.json`

Archivo en `ignition/parameters/production.json`. Valores default:

- `timelockMinDelay: 172800` (2 días)
- `probationDuration: 2592000` (30 días)
- `roundDuration: 604800` (7 días)
- `votingDelay: 7200` (~1d)
- `votingPeriod: 50400` (~7d)
- `proposalThreshold: 10000e18` GOV
- `quorumNumerator: 4` (4%)
- `sanityCap: 10_000_000e18` CREDIT
- `capMax: 5_000_000e18` CREDIT
- `alpha: 0.95e18`

Cualquier cambio debe estar documentado en changelog y revisado por 2 personas además de quien cambió.

## F1 — Deploy

### Pre-vuelo

- [ ] El multi-sig tiene ≥ 0.5 ETH para gas (~0.3 ETH realista + margen para retry).
- [ ] RPC provider principal + fallback configurados.
- [ ] `hardhat.config.ts` con mainnet RPC.
- [ ] Gas price monitoreado; deploy ideal < 20 gwei.

### Comando

```bash
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/production.json \
  --network mainnet \
  --verify
```

Ignition es idempotente — si hay error en medio, retoma desde el último paso confirmado. **No borrar** `ignition/deployments/chain-1/` hasta tener certeza de que completó.

### Fases del módulo Ignition

El `Dao.ts` se estructura en 4 sub-fases:

- **A**: deploy de todos los contratos (deployer = admin temporal).
- **B**: role grants funcionales (MINTER → distributor, BURNER → tracker, RECORDER → feeRouter, PROPOSER/CANCELLER → governor) + genesis mint de 10M CREDIT al Treasury.
- **C**: roles de gobernanza para el Timelock (`GOVERNANCE_ROLE` + `DEFAULT_ADMIN_ROLE` en todos los contratos económicos) + `transferOwnership(timelock)` en el GovernanceToken.
- **D**: el deployer renuncia a todos sus roles. `DEFAULT_ADMIN_ROLE` del Timelock renuncia **al último** — si renuncia antes, el deployer pierde poder de conceder el resto.

El genesis mint ocurre **antes** de la renuncia del `DEFAULT_ADMIN_ROLE` en el CreditToken (`mintGenesis` es `onlyRole(DEFAULT_ADMIN_ROLE)`).

### Verificación post-deploy — ANTES de cualquier otra acción

Cada ítem es un assert obligatorio vía `cast` o hardhat console:

- [ ] **12 contratos verificados en Etherscan**.
- [ ] **El Timelock tiene `PROPOSER_ROLE` y `CANCELLER_ROLE`**:
  ```
  cast call $TIMELOCK 'hasRole(bytes32,address)(bool)' $(cast keccak "PROPOSER_ROLE") $GOVERNOR
  # → true
  cast call $TIMELOCK 'hasRole(bytes32,address)(bool)' $(cast keccak "CANCELLER_ROLE") $GOVERNOR
  # → true
  ```
- [ ] **El deployer NO tiene `DEFAULT_ADMIN_ROLE`** en ningún contrato con AccessControl:
  ```
  cast call $REGISTRY 'hasRole(bytes32,address)(bool)' 0x00...0 $DEPLOYER
  # → false (em todos)
  ```
- [ ] **El Timelock TIENE `DEFAULT_ADMIN_ROLE`** en los contratos económicos.
- [ ] **`owner(GOV) == deployer`** (aún — esperado para bootstrap).
- [ ] **`pendingOwner(GOV) == timelock`**.
- [ ] **`CREDIT.balanceOf(treasury) == 10_000_000e18`** y **`CREDIT.totalSupply() == 10_000_000e18`**.
- [ ] **`GOV.totalSupply() == 0`** — nadie recibió GOV aún.
- [ ] **FeeRouter split = (9500, 0, 500)**.

Si **cualquiera** falla: para. No avances a F2. Investiga.

## F2 — Bootstrap de la gobernanza (D+1 a D+12)

### Mint mínimo para pasar threshold

El deployer (multi-sig) hace un único mint:

```solidity
gov.mint(
  multisigAddress,           // ou bootstrap address
  12_000e18,                  // um pouco acima do threshold de 10k
  "bootstrap"
);
```

**No** mintear 100M. **No** mintear los 30M de treasury aún. Solo el mínimo para permitir proponer.

A continuación, el multisig delega a sí mismo:

```solidity
gov.delegate(multisigAddress);
```

### Primera propuesta: `acceptOwnership()`

```solidity
targets    = [govTokenAddress]
values     = [0]
calldatas  = [gov.interface.encodeFunctionData("acceptOwnership")]
description = "Bootstrap 1: accept GOV ownership by Timelock"
```

Someter vía:

```solidity
governor.propose(targets, values, calldatas, description);
```

- Esperar `votingDelay` (~1d).
- Votar For (multisig).
- Esperar `votingPeriod` (~7d).
- `queue` + `execute` tras 2d.

### Verificación post-F2

- [ ] `gov.owner() == timelock`.
- [ ] `gov.pendingOwner() == address(0)`.
- [ ] El deployer multisig ya no tiene poder soberano sobre el GOV. Cualquier mint futuro exige propuesta.

## F3 — Distribución (D+12 a D+90)

Propuestas secuenciales para ejecutar los buckets. Recomendación:

1. **30% Treasury permanente (30M)**: `gov.mint(treasury, 30_000_000e18, "treasury")`.
2. **25% Team vía TeamVesting**: deploy de N instancias de `TeamVesting`, cada una con beneficiario específico. Transferir GOV del Treasury a cada instancia.
3. **20% Public sale**: `gov.mint(saleContract, 20_000_000e18, "publicSale")` tras el sale contract auditado y deployado.
4. **15% Community rewards**: `gov.mint(userSubsidy, 15_000_000e18, "community")` o para contrato de liquidity mining futuro.
5. **10% Liquidity**: `gov.mint(liquidityManager, 10_000_000e18, "liquidity")` para un contrato que provisione LP en DEX.

Cada bucket es una propuesta separada — revisable independientemente.

### Verificación post-F3

- [ ] `gov.totalSupply() == 100_000_000e18` (alcanza el cap).
- [ ] `gov.mint(anyone, 1, "try")` revierte con `CapExceeded`.
- [ ] Ningún holder individual (excepto Treasury y vesting contracts) tiene > 25% del voting power activo.
- [ ] La public sale sucede y se concluye.
- [ ] La liquidez es provisionada en DEX con rango razonable.

## F4 — Handoff completo (D+90+)

Señales de salud:

- La participación en propuestas sube a >10% del supply.
- El multi-sig pierde mayoría del voto activo (holders diversos entran).
- Burn rate orgánico emergente (apps empiezan a generar tráfico).
- Stakers entrando en múltiples proyectos, no solo uno.

La DAO puede entonces:

- Aprobar nuevas apps vía Registry.
- Ejecutar buybacks (cuando la integración DEX esté lista).
- Ajustar `alpha`, `capMax` según las métricas observadas.
- Contratar auditorías adicionales.

## Runbook de emergencia

Si detectas ataque:

1. **Comunicar** inmediatamente vía canales oficiales (Discord, Twitter, fórum).
2. **Proponer** acción correctiva vía Governor con `description` explicando urgencia.
3. Si la propuesta está en `Queued` y el atacante aún no ejecutó: llamar a `Governor.cancel` o `Timelock.cancel` (vía propuesta contraria).
4. Si contratos privilegiados (tokens, routers) están comprometidos: proponer `grantRole` revocatorio + deploy sustituto + migración.
5. **Sin guardian unilateral en v1** — cualquier pause exige propuesta. El delay es intencional.

## Post-mainnet

- Monitoreo activo por ≥ 30 días.
- Bug bounty activo permanentemente.
- Reevaluación de parámetros tras 3 meses de datos reales.
- La propuesta para agregar guardian multi-sig como `CANCELLER_ROLE` puede considerarse tras maduración.

---

**Siguiente →** [Modelo de seguridad](03-security-model.md)
