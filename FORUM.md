# 💬 FORUM — mapa e protocolo do fórum (Flarum)

> Documento-irmão do `BRAIN.md`. Descreve a estrutura do fórum da comunidade, o mapa de tópicos/postagens e a **regra de emparelhamento**: toda feature, bug relevante ou decisão de regra gera uma postagem no fórum.
> Mapeado em 2026-07-27 via API. Ao criar/alterar tags ou publicar posts de marco, atualize este arquivo.

---

## 1. O que é / onde roda

| Item | Valor |
|---|---|
| Software | Flarum (fórum externo ao hub) |
| URL dev/local | `http://<hostname>:5191` (frontend usa `VITE_FORUM_URL`) |
| API | `http://localhost:5191/api` (JSON:API) |
| Containers | `web3c-forum` (app) + `web3c-forum-db` (MySQL) — orquestrados em `/home/ubuntu/swarm/docker-compose.production.yml` |
| Credenciais admin | `/home/ubuntu/swarm/.env` (`FORUM_ADMIN_USER` / `FORUM_ADMIN_PASSWORD`) — usadas p/ postar via API |

**Papel do fórum no projeto:** é o *changelog público conversável* e a área de troca sobre implementações. O desenvolvimento anda emparelhado com ele — o BRAIN.md registra o estado técnico; o fórum conta a mesma história em linguagem acessível e abre espaço para discussão.

## 2. Estrutura do Flarum (conceitos)

- **Tag primária (pai)** = categoria. 8 categorias hoje.
- **Tag filha** = tópico dentro da categoria. Uma discussão recebe **pai + filha** (as duas tags).
- **Discussão** = thread com título; **post** = mensagem dentro da thread (o 1º post é o corpo da discussão).
- Padrão do projeto: threads longevas por assunto, atualizadas com replies de marco (ver §4), em vez de muitas threads pequenas.

## 3. Mapa de categorias e tópicos (tag IDs)

| Categoria (tag pai) | ID | Tópicos filhos (ID) |
|---|---|---|
| 🤝 Comunidade | 7 | Apresentação dos membros (27) · Feedback geral (28) · Parcerias e colaborações (29) · Eventos e anúncios (30) |
| 🧠 Fundamentos (Onboarding) | 3 | O que é a DAO? (10) · Como funciona o ecossistema econômico (11) · Guia para iniciantes (12) · Glossário de termos (13) |
| 🏛️ Governança | 4 | Como funcionam as votações (14) · Propostas ativas (15) · Como criar uma proposta (16) · Histórico de decisões (17) |
| 💰 Economia & Tokenomics | 5 | Modelo econômico da DAO (18) · Distribuição de tokens (19) · Utilidade do token (20) · Sustentabilidade a longo prazo (21) · Discussões abertas sobre melhorias econômicas (22) |
| 🚀 Desenvolvimento & Produto | 6 | Roadmap do projeto (23) · Atualizações e releases (24) · Sugestões de funcionalidades (25) · Relatórios de progresso (26) |
| 📊 Incentivos & Participação | 8 | Recompensas por contribuição (31) · Programas de incentivos (32) · Bounties e tarefas abertas (33) |
| ❓ Suporte | 9 | Dúvidas gerais (34) · Problemas técnicos (35) · Ajuda com carteira / onboarding (36) |
| DAO Ecosystem – General Discussion | 2 | *(legado em inglês, sem filhos, sem posição — não usar; candidata a remoção no painel admin)* |

## 4. Conteúdo atual (2026-07-27)

**Discussão #2 — "O fórum agora anda junto com o desenvolvimento"** (2026-07-27)
Tags: 🏛️ Governança → Histórico de decisões. Post inaugural anunciando a regra de emparelhamento (§5) à comunidade.

**Discussão #1 — "Segurança do modelo: onde os números do protocolo podem ser mentidos"** — **modelo de referência** de linguagem e formato.
Tags: 💰 Economia & Tokenomics → Modelo econômico da DAO. 5 posts:

| Post | Data | Conteúdo |
|---|---|---|
| 1 | 2026-07-11 | Parecer wash-signal traduzido p/ leigo: "o dinheiro não pode ser roubado, mas os números podem ser mentidos por ~2,5%/ciclo". Analogia + contrato exato lado a lado |
| 2 | 2026-07-11 | Resposta às perguntas: as 4 correções em camadas (D1–D4) com trechos de código e simulação de custo |
| 3 | 2026-07-12 | `✅ Medidas tomadas — D1 e D2 implementados` (anti-self-payment + uniquePayersOf, decisão "ignorar, não reverter") |
| 4 | 2026-07-25 | `✅ Medida tomada — D3 implementado` (piso minInvestWeight, por que encarece o sybil) |
| 5 | 2026-07-26 | `✅ Medida tomada — D4 implementado (vetor fechado)` (recentVolumeOf com decaimento, grossVolume vira auditoria) |

**Padrão que emerge daí (seguir):**
- Thread abre com o problema/tema explicado para **qualquer pessoa** — conclusão em 1 frase logo no início.
- Cada avanço de código vira **reply de marco** na mesma thread, prefixado `✅ Medida tomada — X implementado`.
- Sempre: analogia do dia a dia + o nome exato do contrato/função/parâmetro. Decisões de desenho explicadas ("por que ignorar em vez de reverter").
- Sem jargão sem explicação; números concretos ("1 CREDIT de fee = 40 de GMV falso").

## 5. 📌 REGRA DE EMPARELHAMENTO (obrigatória)

> **Toda mudança significativa que entra no BRAIN.md (📌 Updates ou Decisões) gera também uma postagem no fórum.** O fórum é o changelog conversável do projeto — nunca deixá-lo para trás.

Fluxo ao concluir uma mudança:
1. Atualizar BRAIN.md (como já manda o protocolo).
2. **Postar no fórum**: se já existe thread do assunto → reply de marco (`✅ ...`); se é assunto novo → nova discussão (tags pai+filha).
3. Registrar a thread/post criado na tabela do §4 deste arquivo quando for discussão nova.

Roteamento por tipo de mudança:

| Tipo de mudança | Categoria → tópico (tag IDs) |
|---|---|
| Feature nova / release / redeploy | 🚀 Desenvolvimento & Produto → Atualizações e releases (6+24) |
| Feature em discussão / RFC | 🚀 Desenvolvimento & Produto → Sugestões de funcionalidades (6+25) |
| Bug / incidente / correção de segurança | ❓ Suporte → Problemas técnicos (9+35) — ou reply na thread do tema se existir (ex.: wash-signal → disc. #1) |
| Mudança econômica (fee, split, PSM, funding) | 💰 Economia & Tokenomics → Modelo econômico da DAO (5+18) |
| Regra/decisão de governança ou de projeto | 🏛️ Governança → Histórico de decisões (4+17) |
| Marco de roadmap / relatório de progresso | 🚀 Desenvolvimento & Produto → Roadmap (6+23) ou Relatórios de progresso (6+26) |

**Linguagem dos posts:** acessível, seguindo o modelo dos posts atuais (§4). Escrever para o membro da comunidade, não para o dev: começar pela conclusão em 1 frase, usar analogia, e só então o detalhe técnico com nomes exatos. PT-BR.

## 6. Como postar via API

```bash
# 1. Token (credenciais em /home/ubuntu/swarm/.env — nunca commitar)
U=$(grep '^FORUM_ADMIN_USER=' /home/ubuntu/swarm/.env | cut -d= -f2-)
P=$(grep '^FORUM_ADMIN_PASSWORD=' /home/ubuntu/swarm/.env | cut -d= -f2-)
TOKEN=$(curl -s -X POST http://localhost:5191/api/token \
  -H 'Content-Type: application/json' \
  -d "{\"identification\":\"$U\",\"password\":\"$P\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

# 2a. Nova discussão (tags pai+filha; ex.: 6=Desenvolvimento, 24=Atualizações e releases)
curl -s -X POST http://localhost:5191/api/discussions \
  -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":{"type":"discussions","attributes":{"title":"...","content":"markdown aqui"},
       "relationships":{"tags":{"data":[{"type":"tags","id":"6"},{"type":"tags","id":"24"}]}}}}'

# 2b. Reply de marco numa thread existente (ex.: discussão 1)
curl -s -X POST http://localhost:5191/api/posts \
  -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":{"type":"posts","attributes":{"content":"✅ Medida tomada — ..."},
       "relationships":{"discussion":{"data":{"type":"discussions","id":"1"}}}}}'
```

Conteúdo aceita markdown. Para conferir tags/discussões atuais: `GET /api/tags` e `GET /api/discussions` (públicos, sem token).
