# Ter GOV

**Para quem é:** usuário que quer entender o que o token GOV representa e como usá-lo.
**Pré-requisitos:** [Dual-token](../02-core-concepts/01-dual-token-economy.md).

## O que GOV faz por você

Ter GOV na wallet te dá três capacidades:

1. **Votar em propostas** (se você delegar voting power a si mesmo).
2. **Stakar em projetos** (trava GOV e gera peso de rewards em CREDIT).
3. **Registrar um projeto** como owner (se você tiver `minCollateral` disponível e conseguir aprovação da governança).

Sem GOV, você ainda pode ser usuário (gastar CREDIT em apps), mas não participa das decisões nem do staking.

## Ativando voting power com `delegate`

GOV é ERC-20 com extensão ERC20Votes. Para votar, você precisa **delegar voting power**. Ter balance não basta.

```
GovernanceToken.delegate(yourAddress)
```

Se você quer votar você mesmo, delegue para si. Se você quer que alguém vote no seu lugar (um delegate que você confia), delegue para o endereço dele.

A delegação:

- É **gratuita** (só paga gas).
- Pode ser **transferida** a qualquer momento (`delegate(newDelegatee)`).
- Segue seu balance automaticamente — se você recebe mais GOV, seu delegate ganha mais peso.
- Se você vende GOV, seu delegate perde peso na mesma proporção.

**Importante**: a mudança de delegação entra em vigor no bloco seguinte. Propostas que já tinham snapshot anterior usam a delegação vigente **no bloco do snapshot**.

## Snapshot e anti-flashloan

Quando uma proposta abre, o Governor grava o bloco de snapshot. A função de voto consulta:

```solidity
uint256 votingPower = GovernanceToken.getPastVotes(account, snapshotBlock);
```

`getPastVotes` é histórico — imune a flash-loans. Quem pegar empréstimo relâmpago de GOV **após** o snapshot não tem voting power na proposta.

## Como adquirir GOV

GOV em circulação vem de:

- Alocações iniciais aprovadas pela DAO (genesis distribution: treasury, team, public sale, community rewards, liquidity).
- Staking rewards (fora do escopo do v1 — a emissão de CREDIT como reward não cunha GOV).
- Compra em DEX externa.

Detalhes da distribuição em [Tokenomics](../06-for-investors/01-tokenomics.md).

## Usar GOV como colateral para listar projeto

Se você é dono de um app e quer listá-lo no Registry:

1. Aguarde a DAO aceitar a proposta de listagem.
2. Faça `GovernanceToken.approve(registry, collateralAmount)` (mínimo 10.000 GOV em produção).
3. Quando a proposta de `registerProject` executar, o `registerProject` vai puxar o GOV via `transferFrom`.

O GOV fica **travado no Registry** até o projeto ser `Removed`:

- Se remoção for sem slash: volta para você.
- Se remoção for com slash: vai para a tesouraria.

Mais detalhe em [Submeter um projeto](../05-for-developers/03-submitting-a-project.md).

## Transferindo GOV

GOV é ERC-20 padrão. Transferências seguem o fluxo normal:

```
gov.transfer(recipient, amount)
gov.approve(spender, amount)
gov.transferFrom(owner, recipient, amount)
```

**Atenção à delegação quando transfere**: se você delega para X e depois transfere todo seu GOV para Y, o voting power de X cai a zero. Y **não** recebe automaticamente voting power — precisa delegar explicitamente.

## Permit (EIP-2612)

GOV herda `ERC20Permit`. Você pode assinar um "approve sem tx" via `permit(owner, spender, value, deadline, v, r, s)`. Útil para UX em que você quer aprovar e usar numa tx única (gasless approve).

## Supply cap

100M GOV é o teto absoluto, imutável. Quando `totalSupply() == 100M`, chamadas `mint` revertem com `CapExceeded`. Isso significa que **a emissão de GOV é previsível** — tudo que existe ou já existirá de GOV sai do processo de aprovação da DAO até atingir o cap.

Verificar o supply atual: `GovernanceToken.totalSupply()` / `GovernanceToken.cap()`.

## Sobre yield (não) garantido

Ter GOV **não paga yield por si só**. Você ganha reward em CREDIT **apenas se stakar em um projeto que gera burn**. Manter GOV parado na wallet te dá apenas direito de voto — não distribui CREDIT.

Se você quer participar do incentivo econômico, precisa ir para [Staking em projetos](03-staking-in-projects.md).

---

**Próximo →** [Staking em projetos](03-staking-in-projects.md)
