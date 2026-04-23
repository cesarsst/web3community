# web3community Documentation

Welcome to the public documentation of the **web3community** DAO — a multi-app platform with a dual-token economy (GOV + CREDIT), staking directed per project, and an economic cycle sustained by real consumption inside the ecosystem's apps.

This doc is **code-first**: everything you read here is verifiable in the contracts under `contracts/`. If the docs and the code diverge, the code wins — divergences are bugs in the docs, not features.

## Reading paths

Every reader has a different entry point. Use the right track for your case.

### I'm new to web3community — I want to understand the basics

1. [What is web3community](01-getting-started/01-what-is-web3community.md)
2. [Mental model](01-getting-started/02-mental-model.md)
3. [Glossary](01-getting-started/03-glossary.md)
4. [Recommended reading paths](01-getting-started/04-reading-paths.md)

### I'm a user — I want to participate

1. [How to participate](04-for-users/01-participate.md)
2. [Holding GOV](04-for-users/02-holding-gov.md)
3. [Staking in projects](04-for-users/03-staking-in-projects.md)
4. [Voting on proposals](04-for-users/04-voting.md)
5. [Claiming rewards](04-for-users/05-claiming-rewards.md)

### I'm a dev — I want to integrate an app into the ecosystem

1. [Integration overview](05-for-developers/01-integration-overview.md)
2. [Contract addresses](05-for-developers/02-contract-addresses.md)
3. [Submitting a project](05-for-developers/03-submitting-a-project.md)
4. [Querying on-chain state](05-for-developers/04-querying-state.md)
5. [Local environment](05-for-developers/05-local-dev.md)

### I want to understand the economy before any exposure

1. [Dual-token: GOV and CREDIT](02-core-concepts/01-dual-token-economy.md)
2. [Tokenomics](06-for-investors/01-tokenomics.md)
3. [Value accrual](06-for-investors/02-value-accrual.md)
4. [Risk and security](06-for-investors/03-risk-and-security.md)
5. [Metrics that matter](06-for-investors/04-metrics-that-matter.md)

### I want to look up a specific contract

Go straight to [`08-contracts-reference/`](08-contracts-reference/). One file per contract.

## Full tree

| Section | Content |
|---|---|
| [01-getting-started](01-getting-started/) | Introduction, mental model, glossary |
| [02-core-concepts](02-core-concepts/) | Dual-token, directed staking, burn-to-mint, rewards, governance, projects, treasury |
| [03-protocol-overview](03-protocol-overview/) | Architecture, user flows, value flow |
| [04-for-users](04-for-users/) | Step-by-step guides for end users |
| [05-for-developers](05-for-developers/) | Integration, addresses, local environment |
| [06-for-investors](06-for-investors/) | Tokenomics, value accrual, risks, metrics |
| [07-governance](07-governance/) | Proposal lifecycle, voting power, parameters |
| [08-contracts-reference](08-contracts-reference/) | Per-contract reference (one per file) |
| [09-advanced](09-advanced/) | Deep dives, mainnet deploy, security model |
| [10-reference](10-reference/) | FAQ, resources, changelog |

## Conventions

- **All pages are in English.**
- **Numeric parameters** cited here (quorum, minimum lock, supply cap, etc.) come from the code — constants in the `.sol` files, constructors, or Ignition deploy parameters. Nothing is guessed.
- **Diagrams are ASCII**. Deliberate choice: they version in git, don't depend on a CDN, and work in any markdown renderer.
- **Internal links** are relative to the `docs/` root. The hub's renderer converts them to web routes at build time.

## Protocol status

- 12 contracts in production (see [08-contracts-reference](08-contracts-reference/)).
- Solidity 0.8.24 with `viaIR` enabled.
- OpenZeppelin Contracts 5.0.2 pinned.
- Ready for Sepolia deploy after external audit.
