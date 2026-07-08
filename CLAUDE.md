# web3community — contratos (backend)

@BRAIN.md

## Regras deste repo

- **BRAIN.md é o cérebro do projeto** (compartilhado com o frontend). Antes de qualquer tarefa, considere o contexto dele como verdade vigente.
- **Manutenção obrigatória:** ao concluir mudança significativa (contrato novo/alterado, mudança econômica, redeploy, decisão de arquitetura), atualize a seção relevante do `BRAIN.md` e adicione entrada no topo de "📌 Updates" (data absoluta YYYY-MM-DD).
- Decisões de design/economia vão na tabela "Decisões registradas" do BRAIN.md — nunca só no chat.
- Pipeline Solidity: usar agente `dao-dev` (impl → test → NatSpec → slither → coverage ≥90%). Economia: `dao-economist`. Docs: `dao-docs` (pt-br fonte de verdade, paridade en/es).
- Após redeploy local, lembrar de sincronizar o frontend (`npm run sync:contracts` em `/home/ubuntu/web3community-frontend`) e o SDK (`sync-abis.mjs`).
