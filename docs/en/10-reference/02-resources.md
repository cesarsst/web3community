# Resources

**Audience:** anyone who wants to dig deeper beyond this doc.
**Prerequisites:** none.

## Source code

- **Contracts**: `contracts/*.sol` in the public repo.
- **Tests**: `test/`.
- **Deploy scripts**: `ignition/modules/` + `ignition/parameters/`.
- **Economic simulation**: `scripts/simulation/`.

## Referenced technical documentation

### OpenZeppelin 5.0.x

Every OZ contract used in this protocol (pinned version `5.0.2`):

- [ERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20) — base for GOV and CREDIT.
- [ERC20Permit](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Permit) — EIP-2612.
- [ERC20Votes](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Votes) — ERC-5805 snapshots.
- [ERC20Burnable](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Burnable).
- [AccessControl](https://docs.openzeppelin.com/contracts/5.x/api/access#AccessControl).
- [Ownable2Step](https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable2Step).
- [TimelockController](https://docs.openzeppelin.com/contracts/5.x/api/governance#TimelockController).
- [Governor + extensions](https://docs.openzeppelin.com/contracts/5.x/governance).
- [SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20).
- [ReentrancyGuard](https://docs.openzeppelin.com/contracts/5.x/api/utils#ReentrancyGuard).
- [Checkpoints](https://docs.openzeppelin.com/contracts/5.x/api/utils#Checkpoints) — `Trace208` used in Staking.
- [MerkleProof](https://docs.openzeppelin.com/contracts/5.x/api/utils#MerkleProof) — UserSubsidy.

### EIPs

- [EIP-20 (ERC-20)](https://eips.ethereum.org/EIPS/eip-20).
- [EIP-2612 (Permit)](https://eips.ethereum.org/EIPS/eip-2612).
- [EIP-5805 (Voting)](https://eips.ethereum.org/EIPS/eip-5805).
- [EIP-712 (Typed data)](https://eips.ethereum.org/EIPS/eip-712).
- [EIP-165 (ERC-165 interface detection)](https://eips.ethereum.org/EIPS/eip-165).

### Tools

- [Hardhat](https://hardhat.org/) — development and tests.
- [Hardhat Ignition](https://hardhat.org/ignition/docs/getting-started) — deploy orchestration.
- [Slither](https://github.com/crytic/slither) — static analysis. Via pipx: `pipx install slither-analyzer`.
- [OpenZeppelin Defender](https://defender.openzeppelin.com/) — on-chain monitoring.
- [Forta](https://forta.org/) — detection agents.
- [Tenderly](https://tenderly.co/) — simulation and alerts.

## Architectural inspirations

DAOs whose decisions were studied when designing this protocol:

- [Uniswap](https://docs.uniswap.org/) — multi-level governance, separation of powers.
- [Aave](https://docs.aave.com/) — adjustable risk parameters, timelock.
- [Compound](https://docs.compound.finance/) — canonical Governor, proposal lifecycle.
- [MakerDAO](https://docs.makerdao.com/) — executive votes, independent modules.
- [Optimism](https://docs.optimism.io/) — bicameral governance (Token House + Citizens' House, not implemented here, but inspiration for separation).
- [Curve](https://docs.curve.fi/) — gauge weights, veCRV (reference for directed weight).

## Patterns used

- **Dual-token economy** — used by Aave (AAVE + aTokens), Compound (COMP + cTokens), PoolTogether (POOL + utility), among others.
- **Directed staking** — inspired by Curve's veCRV + gauges, adapted for 1 stake = 1 project (not gauge voting).
- **Burn-to-mint** — emerging pattern in protocols with utility currency (evolution of "fee to stakers" → "burn for mint").
- **Permissionless finalize** — common pattern in pull-based protocols (Aave liquidity mining, Compound rewards).
- **Timelock with delay** — adopted by all major DeFi DAOs as a mitigation of capture risk.

## Recommended readings

- ["Why Governance Matters"](https://a16zcrypto.com/posts/article/progressive-decentralization/) — a16z crypto, progressive decentralization.
- ["Token Economies"](https://future.com/token-economies/) — Chris Dixon and others.
- ["The Governance Paradox"](https://medium.com/compound-finance/the-governance-paradox-11b1d8b1e47d) — Compound.
- ["Protocol Sink Thesis"](https://www.placeholder.vc/blog/2020/2/25/stores-of-value) — Placeholder Ventures.
- ["Why Decentralization Matters"](https://onezero.medium.com/why-decentralization-matters-5e3f79f7638e) — Chris Dixon.

## Official channels (TBD)

Addresses and profiles will be published as the protocol evolves:

- Discord — TBD.
- Governance forum — TBD.
- Twitter — TBD.
- Technical newsletter — TBD.

## Quick acronym glossary

- **DAO**: Decentralized Autonomous Organization.
- **ERC**: Ethereum Request for Comments (standard).
- **EIP**: Ethereum Improvement Proposal.
- **EOA**: Externally Owned Account (user wallet, not a contract).
- **TVL**: Total Value Locked.
- **DEX**: Decentralized Exchange.
- **LP**: Liquidity Provider.
- **MEV**: Miner Extractable Value (or Maximal Extractable Value).
- **TWAP**: Time-Weighted Average Price.
- **AMM**: Automated Market Maker.
- **CEI**: Checks-Effects-Interactions (security pattern).
- **AA**: Account Abstraction (EIP-4337).

---

**Next →** [Changelog](03-changelog.md)
