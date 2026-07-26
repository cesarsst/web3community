# Ter GOV

**Para quem é:** quem quer participar da governança e/ou investir em projetos — os dois exigem GOV.
**Pré-requisitos:** [Como participar](01-participate.md).

## O que GOV faz por você

[`GOV`](../08-contracts-reference/01-GovernanceToken.md) é o token político do protocolo (ERC-20 com `ERC20Votes`), com cap **imutável de 100M**. Segurar GOV te habilita a três coisas — mas cada uma exige uma ação além de simplesmente ter o token:

| Poder | O que exige |
|---|---|
| **Votar em propostas** | GOV **delegado** (a si mesmo ou a outra conta) |
| **Investir em projetos** | GOV **stakeado** naquele projeto |
| **Capturar valorização** | apenas segurar (buyback financiado pela fee valoriza o GOV) |

## Delegar: o passo que a maioria esquece

No `ERC20Votes`, **ter GOV não te dá voto automaticamente**. O poder de voto só existe depois que você **delega** — inclusive quando delega a si mesmo:

```solidity
GovernanceToken.delegate(suaPropriaConta);   // ativa seu voto
// ou
GovernanceToken.delegate(outraConta);        // delega a um representante
```

Sem delegação, seu `getVotes` é zero e você não conta para quorum nem consegue votar. Delegue **antes** do snapshot da proposta que você quer votar (o snapshot é tirado no bloco de referência da proposta — voto delegado depois não vale para ela).

## Como obter GOV

- **Mercado** — GOV é um ERC-20 negociável.
- **Distribuição da DAO** — mints controlados pela governança (o `owner` do token, em produção, é o Timelock; cada mint passa por proposta).
- **Vesting do time** — membros do time recebem GOV liberado gradualmente via [`TeamVesting`](../08-contracts-reference/11-TeamVesting.md) (cliff + linear).

Não há inflação além do cap de 100M — o `_update` do token reverte qualquer mint que ultrapasse o cap.

## Segurar vs. stakar: não confunda

Segurar GOV na carteira e **stakar** GOV são coisas diferentes:

- **Segurar (+ delegar)** → mantém o token na sua carteira, te dá **voto**.
- **Stakar** → transfere o GOV para o contrato [`Staking`](../08-contracts-reference/05-Staking.md), gera **peso num projeto** (gate de investimento). Enquanto stakeado, o GOV **não está na sua carteira**.

> **Atenção à delegação ao stakar.** Ao stakar, a custódia do GOV vai para o contrato `Staking`, o que afeta seu poder de voto (o token deixa sua carteira). Se você quer votar **e** stakar, planeje: mantenha uma parcela de GOV delegada na carteira para governança e stake o restante nos projetos que quer financiar. As duas funções não compartilham o mesmo GOV ao mesmo tempo.

## O que segurar GOV NÃO te dá

- **Não rende juros nem emissão.** Não há reward por simplesmente ter (ou stakar) GOV. A valorização vem do buyback financiado pela fee, não de emissão.
- **Não dá rev-share sozinho.** Rev-share exige stakar num projeto **e** investir na rodada dele — ver [Staking em projetos](03-staking-in-projects.md).

---

**Próximo →** [Staking em projetos](03-staking-in-projects.md)
