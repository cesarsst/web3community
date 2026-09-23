# CommunityGovernor

**Para quem é:** devs/auditores.

Contrato: `contracts/CommunityGovernor.sol` · Solidity 0.8.24 · OpenZeppelin 5.

## Papel

Governor canônico da DAO, composto pelo stack OZ 5: `Governor` + `GovernorSettings` + `GovernorCountingSimple` + `GovernorVotes` + `GovernorVotesQuorumFraction` + `GovernorTimelockControl`.

Voting power é lida do [GovernanceToken](01-GovernanceToken.md) (ERC20Votes) — flash loans não influenciam propostas. Toda execução bem-sucedida é roteada via [CommunityTimelock](09-CommunityTimelock.md), que aplica delay.

### Tipos de proposta e supermaioria

O Governor classifica cada proposta em `ProposalType.Standard` ou `ProposalType.Supermajority`. No `propose`, escaneia os calldatas: qualquer chamada cujo selector esteja em `isSensitiveSelector` — gestão de roles (`grantRole`/`revokeRole`/`renounceRole`) em **qualquer** contrato, `updateDelay` do Timelock, `mint` de GOV ou CREDIT, `transferOwnership` do GOV, `transfer`/`transferETH` do Treasury, `setRecipients` do FeeRouterV2 e `removeProject` do Registry — marca a proposta inteira como `Supermajority`, e `_voteSucceeded` passa a exigir **`forVotes >= 3 * againstVotes`** (For ≥ 75% dos votos decisivos For/Against; Abstain fora da razão).

O scan é **por selector, em qualquer target** (desde 2026-09-23). A versão anterior só cobria gestão de roles com target Treasury/Timelock, o que deixava em maioria simples: `grantRole(MINTER_ROLE)` no CreditToken (CREDIT sem lastro → drena o USDC do PSM), `GovernanceToken.mint` (dilui até o cap), `Treasury.transfer` (esvazia o cofre), `updateDelay(0)` e `setRecipients` (`audit/economist/2026-09-23-conceptual-gaming-review.md` #2/#3/#8). Falso-positivo (um selector desses num contrato inocente) só encarece a proposta para 75%.

Clock mode: `block.number` (o token não sobrescreve `clock()`); toda aritmética de delay/period é em **blocos**.

## Interface pública

### Tipo

```solidity
enum ProposalType { Standard, Supermajority }
```

### Constantes / immutables / storage

| Nome | Tipo | Descrição |
|---|---|---|
| `GRANT_ROLE_SELECTOR` | `bytes4 constant` | `IAccessControl.grantRole.selector` (`0x2f2ff15d`). |
| `REVOKE_ROLE_SELECTOR` | `bytes4 constant` | `IAccessControl.revokeRole.selector` (`0xd547741f`). |
| `RENOUNCE_ROLE_SELECTOR` | `bytes4 constant` | `IAccessControl.renounceRole.selector` (`0x36568abe`). |
| `UPDATE_DELAY_SELECTOR` | `bytes4 constant` | `updateDelay(uint256)` do TimelockController. |
| `MINT_SELECTOR` | `bytes4 constant` | `mint(address,uint256,string)` — GovernanceToken **e** CreditToken. |
| `TRANSFER_OWNERSHIP_SELECTOR` | `bytes4 constant` | `transferOwnership(address)` (owner do GOV = quem minta). |
| `TREASURY_TRANSFER_SELECTOR` / `TREASURY_TRANSFER_ETH_SELECTOR` | `bytes4 constant` | `transfer(address,address,uint256)` / `transferETH(address,uint256)` do Treasury. |
| `SET_RECIPIENTS_SELECTOR` | `bytes4 constant` | `setRecipients(address,address,address)` do FeeRouterV2. |
| `REMOVE_PROJECT_SELECTOR` | `bytes4 constant` | `removeProject(uint256,bool,address)` do ProjectRegistry. |
| `TREASURY` | `address immutable public` | Endereço do Treasury (mantido por compatibilidade). `address(0)` (deploy dev sem treasury) desliga o scan — nenhuma proposta vira Supermajority. |
| `proposalRequiresSupermajority` | `mapping(uint256 => bool) public` | `true` se a proposta foi marcada Supermajority no `propose`. |

### Constructor

```solidity
constructor(
    IVotes token, TimelockController timelock, address treasury,
    uint48 initialVotingDelay, uint32 initialVotingPeriod,
    uint256 initialProposalThreshold, uint256 initialQuorumNumerator
)
```
`name` do EIP-712 é `"CommunityGovernor"` (fixo). `treasury` pode ser `address(0)`. Guards OZ: `GovernorInvalidVotingPeriod(0)`, `GovernorInvalidQuorumFraction(n, 100)`.

Parâmetros sugeridos — produção: delay `7200` (~1d), period `50400` (~7d), threshold `10_000e18` GOV, quorum `4%`. Dev: delay `1`, period `50`.

### Propostas

```solidity
function propose(address[] targets, uint256[] values, bytes[] calldatas, string description)
    public override returns (uint256)
```
Cria a proposta (via `super.propose`) e classifica o `ProposalType`. Escaneia cada call (`calldatas[i].length >= 4`): se `isSensitiveSelector(bytes4(calldatas[i]))`, marca `Supermajority` (independente do target). Emite `ProposalTypeSet` sempre (inclusive Standard).

```solidity
function isSensitiveSelector(bytes4 selector) public pure returns (bool)
```
Expõe o conjunto sensível para UI/indexadores (o frontend pode avisar o proposer antes de submeter).

```solidity
function _voteSucceeded(uint256 proposalId) internal view returns (bool)
```
Standard → regra do `GovernorCountingSimple` (For > Against). Supermajority → `forVotes > 0 && forVotes >= 3 * againstVotes`.

### Views / setters herdados relevantes

- **Governança (via propostas):** `castVote`, `castVoteWithReason`, `castVoteBySig`, `queue`, `execute`, `cancel`, `state`, `proposalVotes`, `proposalSnapshot`, `proposalDeadline`, `proposalProposer`, `hashProposal`, `proposalNeedsQueuing`.
- **Parâmetros (`onlyGovernance`):** `setVotingDelay`, `setVotingPeriod`, `setProposalThreshold`, `updateQuorumNumerator`.
- **Config views:** `votingDelay()`, `votingPeriod()`, `proposalThreshold()`, `quorum(timepoint)`, `token()`, `timelock()`, `clock()`, `CLOCK_MODE()`, `COUNTING_MODE()`.

## Eventos

| Evento | Emitido em | Indexados |
|---|---|---|
| `ProposalTypeSet(uint256 proposalId, ProposalType proposalType)` | `propose` (sempre) | `proposalId` |
| `ProposalCreated`, `ProposalQueued`, `ProposalExecuted`, `ProposalCanceled`, `VoteCast`, `VoteCastWithParams` | herdados OZ | conforme OZ |

## Erros

Herdados do stack OZ: `GovernorInvalidVotingPeriod`, `GovernorInvalidQuorumFraction`, `GovernorInsufficientProposerVotes`, `GovernorUnexpectedProposalState`, `GovernorNonexistentProposal`, `GovernorAlreadyCastVote`, `GovernorOnlyProposer`, `GovernorRestrictedProposer`, entre outros.

## Roles

Sem roles próprias. Autoridade dos setters é `onlyGovernance` (resolvida para o Timelock via `_executor()`). No Timelock, o Governor detém `PROPOSER_ROLE` + `CANCELLER_ROLE`.

## Invariantes

- **I4:** voting power isolada em `token()`; execução via Timelock; nenhuma função de bypass admin.
- **I5:** `getPastVotes` via ERC20Votes — snapshot imune a flash loan no bloco do voto. `quorum` usa `getPastTotalSupply`.
- **I7:** o Governor é o único autorizado a propor ações que o Timelock executa contra o `ProjectRegistry`.
- **Supermaioria em chamadas sensíveis:** qualquer call com selector em `isSensitiveSelector` (gestão de roles (`grantRole`/`revokeRole`/`renounceRole`) em **qualquer** contrato, `updateDelay` do Timelock, `mint` de GOV ou CREDIT, `transferOwnership` do GOV, `transfer`/`transferETH` do Treasury, `setRecipients` do FeeRouterV2 e `removeProject` do Registry) exige For ≥ 75% (`forVotes >= 3 * againstVotes` e `forVotes > 0`). Com `TREASURY == address(0)` o scan é pulado.
- **Anti-bypass:** o Timelock só executa exatamente os calldatas registrados na proposta aprovada; batch misto contamina a proposta inteira como Supermajority; nested calls falham no `AccessControl` (o intermediário nunca é o Timelock). `calldatas[i].length >= 4` evita falso-positivo de conversão `bytes4` sobre calldata curta.
- **Domain separator:** `name` `"CommunityGovernor"` é fixo — renomear invalida assinaturas de voto por sig.

## Ver também

[CommunityTimelock](09-CommunityTimelock.md) · [Treasury](08-Treasury.md) · [GovernanceToken](01-GovernanceToken.md)
