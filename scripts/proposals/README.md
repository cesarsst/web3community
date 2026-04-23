# Templates de propostas do Governor

Scripts utilitários que **codificam** as chamadas que compõem propostas
on-chain e submetem ao `CommunityGovernor`. O objetivo é ser o "calldata
gerador" da DAO — você edita um JSON de entrada, roda o script, ele
imprime o `proposalId`, as calldatas e um descriptionHash pronto pra
auditoria, e abre a proposta.

Os scripts **não** executam o ciclo `vote → queue → execute` automaticamente
(isso já é tratado por [`scripts/deploy-dev.ts`](../deploy-dev.ts) como
referência de fluxo). A ideia é que em produção o ciclo passe pelas UIs
de governança (Tally, Snapshot, `Governor` direto via Etherscan).

## O que tem aqui

| Script                        | Gera                                                                                                                      | Input (JSON)                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `deploy-user-subsidy.ts`      | Deploy do singleton `UserSubsidy` (sem proposta — é um-time setup).                                                       | `configs/userSubsidy.json`          |
| `propose-team-vesting.ts`     | Deploy de uma instância de `TeamVesting` (owner = Timelock) + proposta `gov.mint(vesting, alloc, "team:<nome>")`.         | `configs/teamVesting.<nome>.json`   |
| `propose-subsidy-campaign.ts` | Proposta batch `[treasury.transfer(credit, subsidy, budget), subsidy.createCampaign(root, amount, maxClaims, deadline)]`. | `configs/subsidyCampaign.<id>.json` |

## Por que `TeamVesting` é deploy + proposta separadas

O Timelock não deploy contratos em uma chamada atômica — ele só invoca
funções em endereços já conhecidos. Logo:

1. **Script deploy a instância do `TeamVesting` primeiro** (via Ignition,
   owner já apontado pro Timelock). Se algo falhar nesse passo, é só
   redeploy — o contrato não tem GOV ainda e não é funcional.
2. **Proposta mint do GOV** pro endereço da instância recém-deployada.
   Se a proposta reprovar, a instância fica orfã (sem GOV, sem uso) — a
   DAO pode simplesmente ignorar ou repropor com novos parâmetros.

A alternativa seria um contrato `VestingFactory` com `createVesting`
chamável pelo Timelock em uma única proposta. Não foi implementado
porque: (a) adiciona 1 contrato à superfície auditada pra salvar 1 tx
off-chain no fluxo; (b) a separação atual torna o review de cada
proposta trivial (sabe-se exatamente quanto GOV tá sendo mintado e pra
que endereço concreto).

## Como usar

Pre-requisitos:

- Core DAO já deployado (via `npx hardhat ignition deploy ./ignition/modules/Dao.ts`).
- `GovernanceToken.acceptOwnership()` já executado (primeira proposta obrigatória — ver `deploy-dev.ts`).
- Em prod: para abrir qualquer proposta, o chamador precisa de ≥ `proposalThreshold` GOV delegado (10k por default).

Fluxo típico (dev):

```bash
# 1. bootstrap do DAO
npm run deploy:local

# 2. deploy do UserSubsidy (singleton, uma vez só)
npx hardhat run scripts/proposals/deploy-user-subsidy.ts --network localhost

# 3. criar uma proposta de vesting pra um membro do time
npx hardhat run scripts/proposals/propose-team-vesting.ts --network localhost
# (edita configs/teamVesting.alice.json antes — o script lê esse path)

# 4. criar uma campanha de subsídio
npx hardhat run scripts/proposals/propose-subsidy-campaign.ts --network localhost
# (edita configs/subsidyCampaign.chatapp-launch.json antes)
```

Cada script imprime ao final:

- `proposalId` (uint256)
- Lista de `targets[]`, `values[]`, `calldatas[]`
- `descriptionHash` (usado em `queue()`/`execute()`)

Salve essa saída — é o que você precisa pra chamar
`governor.queue(targets, values, calldatas, descriptionHash)` e depois
`governor.execute(...)` com os mesmos argumentos.
