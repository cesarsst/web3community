# Referência de contratos

**Para quem é:** devs/auditores. Interface exata dos contratos do protocolo web3community — **modelo vigente (remodel 2026-07-08)**, extraída dos `.sol` em `contracts/`.

Cada página segue o estilo código-primeiro: cabeçalho, Papel, Interface pública, Eventos, Erros, Roles e Invariantes.

| # | Contrato | Uma linha |
|---|---|---|
| 01 | [GovernanceToken](01-GovernanceToken.md) | Token de governança e colateral GOV: ERC20Votes, cap imutável de 100M, `Ownable2Step`. |
| 02 | [CreditToken](02-CreditToken.md) | Token utilitário CREDIT: ERC-20 com `MINTER_ROLE`/`BURNER_ROLE` — no modelo vigente só o CreditPSM detém essas roles. |
| 03 | [CreditPSM](03-CreditPSM.md) | Peg Stability Module USDC ↔ CREDIT 1:1: `buy` minta, `sell` queima; lastro segregado, sem função de saque. |
| 04 | [ProjectRegistry](04-ProjectRegistry.md) | Whitelist de projetos com colateral GOV, status Pending/Active/Probation/Removed e governança via Timelock. |
| 05 | [Staking](05-Staking.md) | Stake de GOV por projeto (lock 14d–365d, mult 1–4x): gate de investimento + curadoria. |
| 06 | [FeeRouterV2](06-FeeRouterV2.md) | Trilho de pagamento `pay(projectId, amount)`: fee 2,5% (cap 5%), split 40/40/20 e rev-share aos investidores. |
| 07 | [ProjectFunding](07-ProjectFunding.md) | Rodadas de captação all-or-nothing com rev-share 1%–30% e redistribuição de receita via acumulador MasterChef. |
| 08 | [Treasury](08-Treasury.md) | Cofre simples multi-ativo: saídas de ERC20/ETH gated por `GOVERNANCE_ROLE` (Timelock). Sem POL/oracle/buyback. |
| 09 | [CommunityTimelock](09-CommunityTimelock.md) | `TimelockController` da OZ: executa com delay as decisões aprovadas pelo Governor. |
| 10 | [CommunityGovernor](10-CommunityGovernor.md) | Governor da OZ com supermaioria de 75% para gestão de roles no Treasury/Timelock. |
| 11 | [TeamVesting](11-TeamVesting.md) | Vesting linear de GOV com cliff, revogável pelo Timelock (uma instância por membro). |
| 12 | [DevFaucet](12-DevFaucet.md) | Faucet dev-only (rede local): drip de ETH + USDC; CREDIT compra-se no PSM. |
