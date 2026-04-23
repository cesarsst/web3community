# FAQ

**Para quem é:** qualquer pessoa com uma pergunta específica.
**Pré-requisitos:** nenhum.

## Geral

### O que é a web3community?

Uma plataforma multi-aplicativos governada por DAO. Os apps aceitam CREDIT como pagamento; 95% do pagamento é queimado, 5% vai para o app. Stakers de GOV em projetos específicos recebem CREDIT emitido na próxima rodada em função do burn total. Detalhe em [O que é](../01-getting-started/01-what-is-web3community.md).

### Qual a diferença entre GOV e CREDIT?

GOV é governança (supply fixo 100M, vota). CREDIT é utilitário (supply elástico, queimado no uso). Detalhes em [Dual-token](../02-core-concepts/01-dual-token-economy.md).

### Onde estão os contratos?

12 contratos de produção em `contracts/*.sol`. Referência individual em [08-contracts-reference](../08-contracts-reference/). Endereços on-chain em [Contract addresses](../05-for-developers/02-contract-addresses.md).

### Qual rede está rodando?

Ver [Contract addresses](../05-for-developers/02-contract-addresses.md). Rede de produção principal será definida pós-auditoria externa.

## Uso

### Preciso saber programar?

Não. O hub tem UI para todas as operações. Você assina transações na sua wallet.

### Quanto custa participar?

Gas da rede + tokens necessários (GOV para stakar, CREDIT para pagar apps). Em testnet (Sepolia), gas é quase zero.

### Como recebo CREDIT?

- Compra em DEX externa (Uniswap, etc.).
- Recebe como reward se stakou em projeto que gerou burn.
- Recebe via `UserSubsidy` se era elegível em uma campanha.

### Como recebo GOV?

- Compra em DEX externa.
- Recebe via alocação aprovada pela DAO (public sale, airdrop, vesting se é equipe).

### Como voto?

1. Delegue voting power a si: `gov.delegate(you)`.
2. Espere proposta abrir.
3. Chame `governor.castVote(proposalId, support)` via UI ou direto.

Detalhe em [Votar em propostas](../04-for-users/04-voting.md).

### A DAO pode confiscar meu GOV stakado?

**Não.** O lock do staking protege mesmo contra a própria governança. Enquanto o lock está vigente, proposta aprovada **não destrava** seu stake. A única exceção é se o projeto for `Removed` — aí é liberação antecipada, pro-usuário (não contra).

### E se o protocolo morrer?

Se o uso cair a quase zero, emissão colapsa, APR vai a quase zero, stakers saem. A DAO pode intervir (ajustar α, abrir subsídio via Treasury, contratar novos apps). Mas tokenomics não salva produto ruim.

## Staking

### Qual o lock mínimo?

14 dias. Lock abaixo reverte com `LockTooShort`.

### Qual o lock máximo?

Não há máximo programático. Mas o multiplier satura em 4x a partir de 365 dias — lockar mais que isso imobiliza capital sem ganhar peso adicional.

### Posso sair antes do lock?

**Não**, exceto se o projeto for `Removed`. `Probation` (punitiva ou inicial) não bypassa lock.

### Posso stakar em múltiplos projetos?

Sim. Cada `projectId` é uma posição independente.

### Se eu increase_stake, o lock reseta?

**Não.** `increaseStake` preserva `lockStartAt` e `lockDuration`. Só `stake` numa posição existente reseta.

### Extend lock muda amount?

**Não.** `extendLock` só muda `lockDuration`.

## Rewards

### Quando posso reivindicar?

Após a rodada fechar (`closeRound` via governança) e ser finalizada (`finalizeRound` — permissionless). Detalhe em [Reivindicar rewards](../04-for-users/05-claiming-rewards.md).

### Perco reward se esquecer?

**Não.** Não há deadline. Uma vez finalizada, seu direito de claim persiste indefinidamente.

### Por que meu claim é zero?

Possíveis razões:

- Rodada não finalizada (`RoundNotFinalized`).
- Você já reivindicou (`AlreadyClaimed`).
- Seu peso era zero no `snapshotBlock`.
- Projeto não gerou burn nem tinha peso global.

Use `previewClaim(you, round, projectId)` para diagnosticar.

### Quanto vou receber?

Depende do burn do projeto × seu peso × total da rodada. Fórmula em [Rewards distribution](../02-core-concepts/04-rewards-distribution.md).

## Projetos / Apps

### Como listar meu app?

- Prepare metadata off-chain (IPFS).
- Consiga 10.000 GOV para colateral.
- Alguém com ≥ 10.000 GOV delegados propõe `registerProject` no Governor.
- Após aprovação e execução, `activateProject` (segunda proposta, pode ser batch).

Detalhe em [Submeter um projeto](../05-for-developers/03-submitting-a-project.md).

### Quanto recebo por pagamento?

5% por default. Ajustável por projeto via proposta (`setProjectSplit`).

### Se eu stakar no meu próprio projeto, ganho mais?

Sim. Você captura fatia da emissão proporcional ao peso do seu stake. Detalhe em [Fluxo de valor](../03-protocol-overview/03-economic-flows.md).

### Perco meu colateral se eu sair?

Não, se remoção for sem slash. Proposta `removeProject(id, slash=false, _)` devolve colateral ao owner.

Se remoção com slash (`slash=true`), colateral vai para Treasury.

## Governança

### Quanto de GOV preciso para propor?

10.000 GOV delegados (produção). Ajustável via proposta dentro de `[0, ilimitado]`.

### Quanto tempo leva uma proposta?

~10 dias em produção: 1d delay + 7d votação + 2d timelock.

### Posso cancelar minha proposta?

Sim, enquanto está `Pending` ou `Active`. Após `Succeeded`, precisa proposta contrária.

### Minha proposta foi aprovada mas ninguém queue/execute?

Qualquer um pode chamar `queue` e `execute`. Basta alguém fazer — tipicamente um holder engajado ou o proposer.

### Posso votar por delegação?

Sim. `gov.delegate(trustedAddress)` transfere voting power para quem você confia. Seu balance continua seu.

## Técnico

### Solidity qual versão?

0.8.24 com `viaIR: true`.

### Qual OpenZeppelin?

5.0.2 pinado exato.

### Tem upgrade path?

**Não.** Contratos são imutáveis. Substituição exige deploy novo + migração de roles.

### Tem pause?

**Não.** Decisão consciente — qualquer pause seria vetor de captura.

### Tem guardian multisig?

**Não no v1.** Timelock é self-administered. `CANCELLER_ROLE` é só do Governor (cancel via proposta). Guardian multisig pode ser adicionado em futura proposta da DAO.

### Há um bug bounty?

Previsto via Immunefi logo após mainnet. Faixa critical: $50k-$250k.

### Como testar localmente?

```bash
npm install
npx hardhat node                       # terminal 1
npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost                  # terminal 2
```

Detalhe em [Ambiente local](../05-for-developers/05-local-dev.md).

---

**Próximo →** [Recursos](02-resources.md)
