# Docs changelog

**Audience:** anyone wanting to know what changed in the documentation.
**Prerequisites:** none.

This page lists notable changes in the **public documentation** (`/docs`). For the contracts changelog, see [`CHANGELOG.md`](https://github.com/web3community/web3community/blob/main/CHANGELOG.md) at the repo root.

## [Unreleased]

### Changed

- Complete restructuring of the docs tree into 10 progressive sections following Uniswap / Aave / Optimism patterns. Old routes `/docs/01-governancetoken` etc. now live in `/docs/contracts-reference/<Contract>`.
- Vue renderer (`DocsView.vue`) updated for hierarchical sidebar, multi-level breadcrumb, and prev/next footer navigation.
- Frontend `sync-docs.ts` updated for recursive walk preserving the full tree.

### Added

- Section `01-getting-started/` with introduction, mental model, glossary, and reading paths.
- Section `02-core-concepts/` with 7 pages covering dual-token, directed staking, burn-to-mint, rewards, governance, whitelist, treasury.
- Section `03-protocol-overview/` with architecture, user flows, and value flow.
- Sections `04-for-users/`, `05-for-developers/`, `06-for-investors/` with persona guides.
- Section `07-governance/` with proposal lifecycle, voting power, and adjustable parameters.
- Section `08-contracts-reference/` with 12 files (one per `.sol`).
- Section `09-advanced/` with deep dives, mainnet deployment, and security model.
- Section `10-reference/` with FAQ, resources, and this changelog.
- Documentation of `TeamVesting` and `UserSubsidy` contracts (previously absent from the public doc).

### Removed

- Old files at the root of `docs/` (numbered 01-10 + ADVANCED.md + MAINNET-DEPLOY.md + concepts/) migrated to the new tree.

## History (contracts)

For changes in the contracts themselves, consult the `CHANGELOG.md` file at the repository root, which follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) + [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

Recent topics (extracted from CHANGELOG):

- v0.1.0 (2026-04-19): Added complete `TeamVesting` and `UserSubsidy` + test suites.
- Flakiness fixes in vesting tests.
- Branch coverage raised to 95%+ in `UserSubsidy` and 96.81% in `RewardDistributor`.

---

See also: [FAQ](01-faq.md), [Resources](02-resources.md).
