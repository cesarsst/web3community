# Recursos

**Para quem é:** quem quer aprofundar fora desta doc.
**Pré-requisitos:** nenhum.

## Código-fonte

- **Contratos**: `contracts/*.sol` no repositório público.
- **Testes**: `test/`.
- **Deploy scripts**: `ignition/modules/` + `ignition/parameters/`.
- **Simulação econômica**: `scripts/simulation/`.

## Documentação técnica referenciada

### OpenZeppelin 5.0.x

Todos os contratos OZ usados neste protocolo (versão pinada `5.0.2`):

- [ERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20) — base do GOV e CREDIT.
- [ERC20Permit](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Permit) — EIP-2612.
- [ERC20Votes](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Votes) — ERC-5805 snapshots.
- [ERC20Burnable](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Burnable).
- [AccessControl](https://docs.openzeppelin.com/contracts/5.x/api/access#AccessControl).
- [Ownable2Step](https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable2Step).
- [TimelockController](https://docs.openzeppelin.com/contracts/5.x/api/governance#TimelockController).
- [Governor + extensões](https://docs.openzeppelin.com/contracts/5.x/governance).
- [SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20).
- [ReentrancyGuard](https://docs.openzeppelin.com/contracts/5.x/api/utils#ReentrancyGuard).
- [Checkpoints](https://docs.openzeppelin.com/contracts/5.x/api/utils#Checkpoints) — `Trace208` usado em Staking.
- [MerkleProof](https://docs.openzeppelin.com/contracts/5.x/api/utils#MerkleProof) — UserSubsidy.

### EIPs

- [EIP-20 (ERC-20)](https://eips.ethereum.org/EIPS/eip-20).
- [EIP-2612 (Permit)](https://eips.ethereum.org/EIPS/eip-2612).
- [EIP-5805 (Voting)](https://eips.ethereum.org/EIPS/eip-5805).
- [EIP-712 (Typed data)](https://eips.ethereum.org/EIPS/eip-712).
- [EIP-165 (ERC-165 interface detection)](https://eips.ethereum.org/EIPS/eip-165).

### Ferramentas

- [Hardhat](https://hardhat.org/) — desenvolvimento e testes.
- [Hardhat Ignition](https://hardhat.org/ignition/docs/getting-started) — orquestração de deploy.
- [Slither](https://github.com/crytic/slither) — análise estática. Via pipx: `pipx install slither-analyzer`.
- [OpenZeppelin Defender](https://defender.openzeppelin.com/) — monitoramento on-chain.
- [Forta](https://forta.org/) — agents de detecção.
- [Tenderly](https://tenderly.co/) — simulação e alertas.

## Inspirações arquiteturais

DAOs cujas decisões foram estudadas ao desenhar este protocolo:

- [Uniswap](https://docs.uniswap.org/) — governança multi-nível, separação de poderes.
- [Aave](https://docs.aave.com/) — risk parameters ajustáveis, timelock.
- [Compound](https://docs.compound.finance/) — Governor canônico, proposal lifecycle.
- [MakerDAO](https://docs.makerdao.com/) — executive votes, módulos independentes.
- [Optimism](https://docs.optimism.io/) — bicameral governance (Token House + Citizens' House, não implementado aqui, mas inspiração de separação).
- [Curve](https://docs.curve.fi/) — gauge weights, veCRV (referência para peso direcionado).

## Padrões usados

- **Dual-token economy** — usada por Aave (AAVE + aTokens), Compound (COMP + cTokens), PoolTogether (POOL + utility), entre outros.
- **Directed staking** — inspirado em veCRV + gauges de Curve, adaptado para 1 stake = 1 projeto (não votação de gauge).
- **Burn-to-mint** — padrão emergente em protocolos com moeda utilitária (evolução de "fee to stakers" → "burn for mint").
- **Permissionless finalize** — padrão comum em protocolos pull-based (Aave liquidity mining, Compound rewards).
- **Timelock com delay** — adotado por todos os principais DAOs de DeFi como mitigação de risco de captura.

## Leituras recomendadas

- ["Why Governance Matters"](https://a16zcrypto.com/posts/article/progressive-decentralization/) — a16z crypto, progressive decentralization.
- ["Token Economies"](https://future.com/token-economies/) — Chris Dixon e outros.
- ["The Governance Paradox"](https://medium.com/compound-finance/the-governance-paradox-11b1d8b1e47d) — Compound.
- ["Protocol Sink Thesis"](https://www.placeholder.vc/blog/2020/2/25/stores-of-value) — Placeholder Ventures.
- ["Why Decentralization Matters"](https://onezero.medium.com/why-decentralization-matters-5e3f79f7638e) — Chris Dixon.

## Canais oficiais (a definir)

Endereços e perfis serão publicados conforme o protocolo evolui:

- Discord — a definir.
- Fórum de governança — a definir.
- Twitter — a definir.
- Newsletter técnica — a definir.

## Glossário rápido de siglas

- **DAO**: Decentralized Autonomous Organization.
- **ERC**: Ethereum Request for Comments (standard).
- **EIP**: Ethereum Improvement Proposal.
- **EOA**: Externally Owned Account (wallet de usuário, não contrato).
- **TVL**: Total Value Locked.
- **DEX**: Decentralized Exchange.
- **LP**: Liquidity Provider.
- **MEV**: Miner Extractable Value (ou Maximal Extractable Value).
- **TWAP**: Time-Weighted Average Price.
- **AMM**: Automated Market Maker.
- **CEI**: Checks-Effects-Interactions (padrão de segurança).
- **AA**: Account Abstraction (EIP-4337).

---

**Próximo →** [Changelog](03-changelog.md)
