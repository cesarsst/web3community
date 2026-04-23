# Modelo mental

**Audiencia:** lector que ya sabe que es una DAO multi-app (ver [Qué es](01-what-is-web3community.md)) y ahora quiere entender cómo **piensa** el sistema.
**Requisitos previos:** [Qué es web3community](01-what-is-web3community.md).

Esta página da los cuatro modelos mentales que usa el protocolo. Si internalizas los cuatro, el resto de la doc se lee rápido — la mayoría de los detalles son consecuencias de estos modelos.

## 1. Dos tokens, dos roles totalmente distintos

La primera trampa es tratar GOV y CREDIT como "dos tokens de una DAO". **No son simétricos**. Cada uno sirve un papel que el otro no puede servir.

```
  GOV (Governance)                     CREDIT (Utility)
  -----------------                    -----------------
  Supply FIJO 100M                     Supply ELASTICO
  (cap inmutable)                      (mint/burn via roles)

  Vota en propuestas                   NO vota

  Colateral de staking                 Quemado cuando un usuario
  (lock para ganar peso)               paga en una app

  NO es quemado en el uso              Acuñado como reward

  Se valoriza (si) por                 Desinfla por
  apreciacion del ecosistema           formula burn > mint
```

GOV es **derecho político y peso económico de largo plazo**. CREDIT es **dinero operacional de la plataforma**. Nunca mezcles los dos en el razonamiento — un error común es pensar "stakear más CREDIT" (no existe — stakeas GOV) o "vender voto con CREDIT" (no existe — solo GOV vota).

Referencia: [Dual-token economy](../02-core-concepts/01-dual-token-economy.md). Contratos: [GovernanceToken](../08-contracts-reference/01-GovernanceToken.md), [CreditToken](../08-contracts-reference/02-CreditToken.md).

## 2. El staking es dirigido, no genérico

En Uniswap, Aave, Curve: stakeas un token y recibes reward "del protocolo". Indefinido. Aquí es diferente.

Cuando stakeas GOV, **eliges un proyecto**. Tu peso de voto en rewards queda atado al éxito de ese proyecto. Si ChatApp es el proyecto elegido y ChatApp genera mucho burn, capturas mucho reward. Si ChatApp desaparece del mapa, tu peso se vuelve cero reward — incluso si otros proyectos están explotando.

```
  stake(projectId=ChatApp, amount=100 GOV, lock=180 dias)
                 |
                 v
  Generas peso SOLO en ChatApp. Peso = 100 * multiplier(180 dias).
  El multiplier varia de 1x (14 dias) a 4x (365 dias).

  Cuando la ronda cierra:
     tu_reward = emision_ronda
               * (burn_de_ChatApp / burn_total)
               * (tu_peso / peso_total_en_ChatApp)
```

**Consecuencia práctica**: necesitas elegir proyectos. La selección activa es parte del modelo — no es pasivo. Ser staker aquí es como ser un "curador de apps": asignas capital donde crees que va a generar uso.

Referencia: [Directed staking](../02-core-concepts/02-directed-staking.md). Contrato: [Staking](../08-contracts-reference/05-Staking.md).

## 3. Los rewards vienen del burn — no del aire

Muchos protocolos acuñan reward usando supply nuevo sin contrapartida ("diluye a quien no stakeó para pagar a quien stakeó"). Eso tiende a crear una espiral inflacionaria.

Aquí la fórmula es explícitamente **post-pagada**:

```
  emision de la ronda R = min( max( alpha * burn_{R-1}, floor(R) ), capMax )
```

Traduciendo:

- `burn_{R-1}` — cuánto CREDIT fue quemado en la ronda anterior. Fuente verificable on-chain en [`BurnTracker`](../08-contracts-reference/06-BurnTracker.md).
- `alpha` — multiplicador. En producción 0.95 (`950000000000000000` wei del archivo `ignition/parameters/production.json`), es decir, se emite **levemente menos** de lo que fue quemado. El sistema es **levemente deflacionario si el uso es constante**.
- `floor(R)` — piso de emisión de la ronda R. Tabla decreciente con 24 entradas (~6 meses si `roundDuration = 7 dias`). Existe solo para el bootstrap — garantiza algún reward mientras el uso aún no existe.
- `capMax` — techo duro. Default 5M CREDIT por ronda en producción (`capMax: 5000000000000000000000000`).

**Implicación**: si nadie usa las apps, no hay burn, y después de la ronda 24 no hay floor — por lo tanto, no hay emisión. Los stakers solo ganan si el ecosistema genera uso real. Es un puente entre utilidad on-chain y reward, no un pozo sin fondo.

Referencia: [Burn-to-mint](../02-core-concepts/03-burn-to-mint.md). Contrato: [RewardDistributor](../08-contracts-reference/07-RewardDistributor.md).

## 4. Todo cambio político pasa por delay

Ninguna función privilegiada de los contratos económicos acepta llamada directa. Todas exigen `GOVERNANCE_ROLE`, que en producción solo lo tiene [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Y el Timelock solo ejecuta lo que antes fue aprobado por [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) y esperó el delay (en producción, 172800 segundos = 2 días).

```
  Alice propone    Delay 1d      Votacion 7d     Cola timelock    Delay 2d      Ejecucion
  (requiere   ->  (anti-MEV)  -> (quorum 4%,  -> (encola en    -> (tiempo de -> (cualquiera
   10k GOV                         >= 50% For)    el timelock)     respuesta)    hace clic)
   delegados
   a si)
```

Esto garantiza que **ningún actor aislado puede drenar fondos, sustituir contratos o cambiar parámetros de forma unilateral**. El costo es latencia: las propuestas tardan ~10 días en ejecutarse. Es intencional — la latencia es el mecanismo de seguridad.

Referencia: [Proposal lifecycle](../07-governance/01-proposal-lifecycle.md). Contratos: [CommunityGovernor](../08-contracts-reference/10-CommunityGovernor.md), [CommunityTimelock](../08-contracts-reference/09-CommunityTimelock.md).

## Lo que NO es el modelo

Para evitar confusiones comunes:

- **No es yield-farming.** El staking aquí bloquea GOV dirigido a un proyecto. Los rewards son en CREDIT y vienen de uso real, no de dilución.
- **No es AMM.** No hay pool de liquidez interno. El intercambio de CREDIT por stable ocurre fuera de web3community (DEX externa).
- **No es launchpad.** El Registry es una whitelist de apps que aceptan CREDIT, no un distribuidor de tokens nuevos.
- **No es ICO de CREDIT.** El genesis de 10M CREDIT se acuña una única vez para la tesorería (`mintGenesis`, one-shot). La emisión posterior solo viene del `RewardDistributor`, atada al burn.

---

**Siguiente →** [Glosario](03-glossary.md)
