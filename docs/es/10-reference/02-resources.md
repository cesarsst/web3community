# Recursos

**Audiencia:** quien quiera profundizar fuera de esta doc.
**Requisitos previos:** ninguno.

## Código fuente

- **Contratos**: `contracts/*.sol` en el repositorio público.
- **Tests**: `test/`.
- **Deploy scripts**: `ignition/modules/` + `ignition/parameters/`.
- **Simulación económica**: `scripts/simulation/`.

## Documentación técnica referenciada

### OpenZeppelin 5.0.x

Todos los contratos OZ usados en este protocolo (versión pinada `5.0.2`):

- [ERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20) — base de GOV y CREDIT.
- [ERC20Permit](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Permit) — EIP-2612.
- [ERC20Votes](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Votes) — ERC-5805 snapshots.
- [ERC20Burnable](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Burnable).
- [AccessControl](https://docs.openzeppelin.com/contracts/5.x/api/access#AccessControl).
- [Ownable2Step](https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable2Step).
- [TimelockController](https://docs.openzeppelin.com/contracts/5.x/api/governance#TimelockController).
- [Governor + extensiones](https://docs.openzeppelin.com/contracts/5.x/governance).
- [SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20).
- [ReentrancyGuard](https://docs.openzeppelin.com/contracts/5.x/api/utils#ReentrancyGuard).
- [Checkpoints](https://docs.openzeppelin.com/contracts/5.x/api/utils#Checkpoints) — `Trace208` usado en Staking.
- [MerkleProof](https://docs.openzeppelin.com/contracts/5.x/api/utils#MerkleProof) — UserSubsidy.

### EIPs

- [EIP-20 (ERC-20)](https://eips.ethereum.org/EIPS/eip-20).
- [EIP-2612 (Permit)](https://eips.ethereum.org/EIPS/eip-2612).
- [EIP-5805 (Voting)](https://eips.ethereum.org/EIPS/eip-5805).
- [EIP-712 (Typed data)](https://eips.ethereum.org/EIPS/eip-712).
- [EIP-165 (ERC-165 interface detection)](https://eips.ethereum.org/EIPS/eip-165).

### Herramientas

- [Hardhat](https://hardhat.org/) — desarrollo y tests.
- [Hardhat Ignition](https://hardhat.org/ignition/docs/getting-started) — orquestación de deploy.
- [Slither](https://github.com/crytic/slither) — análisis estático. Vía pipx: `pipx install slither-analyzer`.
- [OpenZeppelin Defender](https://defender.openzeppelin.com/) — monitoreo on-chain.
- [Forta](https://forta.org/) — agents de detección.
- [Tenderly](https://tenderly.co/) — simulación y alertas.

## Inspiraciones arquitectónicas

DAOs cuyas decisiones fueron estudiadas al diseñar este protocolo:

- [Uniswap](https://docs.uniswap.org/) — gobernanza multi-nivel, separación de poderes.
- [Aave](https://docs.aave.com/) — risk parameters ajustables, timelock.
- [Compound](https://docs.compound.finance/) — Governor canónico, proposal lifecycle.
- [MakerDAO](https://docs.makerdao.com/) — executive votes, módulos independientes.
- [Optimism](https://docs.optimism.io/) — bicameral governance (Token House + Citizens' House, no implementado aquí, pero inspiración de separación).
- [Curve](https://docs.curve.fi/) — gauge weights, veCRV (referencia para peso dirigido).

## Patrones usados

- **Dual-token economy** — usado por Aave (AAVE + aTokens), Compound (COMP + cTokens), PoolTogether (POOL + utility), entre otros.
- **Directed staking** — inspirado en veCRV + gauges de Curve, adaptado para 1 stake = 1 proyecto (no votación de gauge).
- **Burn-to-mint** — patrón emergente en protocolos con moneda utilitaria (evolución de "fee to stakers" → "burn for mint").
- **Permissionless finalize** — patrón común en protocolos pull-based (Aave liquidity mining, Compound rewards).
- **Timelock con delay** — adoptado por todas las principales DAOs de DeFi como mitigación de riesgo de captura.

## Lecturas recomendadas

- ["Why Governance Matters"](https://a16zcrypto.com/posts/article/progressive-decentralization/) — a16z crypto, progressive decentralization.
- ["Token Economies"](https://future.com/token-economies/) — Chris Dixon y otros.
- ["The Governance Paradox"](https://medium.com/compound-finance/the-governance-paradox-11b1d8b1e47d) — Compound.
- ["Protocol Sink Thesis"](https://www.placeholder.vc/blog/2020/2/25/stores-of-value) — Placeholder Ventures.
- ["Why Decentralization Matters"](https://onezero.medium.com/why-decentralization-matters-5e3f79f7638e) — Chris Dixon.

## Canales oficiales (a definir)

Direcciones y perfiles serán publicados conforme el protocolo evoluciona:

- Discord — a definir.
- Fórum de gobernanza — a definir.
- Twitter — a definir.
- Newsletter técnica — a definir.

## Glosario rápido de siglas

- **DAO**: Decentralized Autonomous Organization.
- **ERC**: Ethereum Request for Comments (standard).
- **EIP**: Ethereum Improvement Proposal.
- **EOA**: Externally Owned Account (wallet de usuario, no contrato).
- **TVL**: Total Value Locked.
- **DEX**: Decentralized Exchange.
- **LP**: Liquidity Provider.
- **MEV**: Miner Extractable Value (o Maximal Extractable Value).
- **TWAP**: Time-Weighted Average Price.
- **AMM**: Automated Market Maker.
- **CEI**: Checks-Effects-Interactions (patrón de seguridad).
- **AA**: Account Abstraction (EIP-4337).

---

**Siguiente →** [Changelog](03-changelog.md)
