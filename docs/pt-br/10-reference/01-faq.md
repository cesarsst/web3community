# FAQ

**Para quem é:** qualquer leitor com uma pergunta direta.
**Pré-requisitos:** nenhum. Cada resposta aponta para a página com o detalhe.

## Por que um app usaria o FeeRouterV2 em vez de cobrar sozinho?

Dois motivos concretos:

1. **Fee competitiva (2,5%).** O [`FeeRouterV2`](../08-contracts-reference/06-FeeRouterV2.md) cobra 2,5% (teto duro de 5% que nem a governança ultrapassa) e o app fica com ~89,5–97,5% de cada pagamento **na hora** — comparável ou melhor que gateways tradicionais, sem custódia intermediária. O pagamento é atômico e o app recebe CREDIT resgatável 1:1 em USDC no PSM quando quiser.
2. **Capital antecipado via rev-share.** Ao abrir uma rodada no [`ProjectFunding`](../08-contracts-reference/07-ProjectFunding.md), o app vende uma fatia (1%–30%) da receita bruta futura e recebe capital adiantado. É funding sem dívida e sem diluir equity — paga-se com receita real, à medida que ela chega.

Além disso, o app entra num ecossistema com moeda de uso compartilhada e base de usuários agregada. Ver [Visão geral de integração](../05-for-developers/01-integration-overview.md).

## O CREDIT valoriza? Vale a pena "investir" em CREDIT?

**Não.** O CREDIT é **estável 1:1 com USDC** por construção. Você compra no [`CreditPSM`](../08-contracts-reference/03-CreditPSM.md) (`buy`, sem taxa) e resgata a qualquer momento (`sell`, sem taxa), sempre 1:1. Cada CREDIT em circulação tem 1 USDC de lastro guardado no PSM (verificável em `backing()`), e não há função de saque desse lastro — nem para governança.

Comprar CREDIT é como **carregar um cartão pré-pago**: 10 CREDIT valem 10 USDC hoje, amanhã e daqui a um ano. Quem quer exposição à valorização do ecossistema deve olhar o **GOV**, não o CREDIT.

## Então como se captura valor?

Duas vias, ambas dependentes de uso real (ver [Value accrual](../06-for-investors/02-value-accrual.md)):

- **GOV valoriza via buyback.** 40% da fee (≈ 1% do GMV) é destinada a recomprar GOV, cujo supply tem cap imutável de 100M. Mais volume nos apps → mais demanda estrutural por GOV.
- **Rev-share paga receita real.** Uma posição numa rodada financiada recebe uma % da receita bruta do app, descontada automaticamente a cada pagamento.

## Como eu invisto?

O gate de investimento tem dois passos (ver [Staking em projetos](../04-for-users/03-staking-in-projects.md) e [ProjectFunding](../08-contracts-reference/07-ProjectFunding.md)):

1. **Stake GOV no projeto.** Você precisa ter GOV stakeado **naquele projeto** ([`Staking`](../08-contracts-reference/05-Staking.md)) para investir — é o gate `getWeight(investor, projectId) > 0`. O stake também dá peso (curadoria) e é exigido para sacar o rev-share depois.
2. **Invista CREDIT na rodada.** Com o stake ativo, deposite CREDIT via `invest(projectId, amount)` enquanto a rodada está aberta. All-or-nothing: bateu o alvo, o dono recebe e o rev-share ativa; venceu sem bater, você saca 100% via `refund`.

Depois, saque a receita acumulada com `claim(projectId)` (exige manter o GOV stakeado; o valor nunca expira).

## Isso é um Ponzi?

**Não.** Um Ponzi paga participantes com o aporte de novos participantes. Aqui (ver [Value accrual → Por que não é Ponzi](../06-for-investors/02-value-accrual.md#por-que-não-é-um-ponzi)):

- **A renda vem de receita real** — rev-share é fatia de pagamentos que usuários fazem para **usar os apps**, não de novos investidores entrando. Sem uso, não há renda; o sistema desacelera em vez de exigir mais entrantes.
- **Nenhum token é emitido como reward.** GOV tem cap fixo; CREDIT só é mintado contra USDC.
- **O CREDIT é lastreado 1:1.** Não é uma "moeda que sobe" — é meio de pagamento com resgate garantido.

A honestidade da resposta: **tokenomics não salva produto ruim.** Se os apps não geram utilidade, o GMV é baixo e o retorno seca. O valor é derivado do uso, não prometido.

## O CREDIT pode perder o peg?

O CREDIT é resgatável 1:1 no PSM enquanto houver lastro — e o lastro é **integral por invariante** (`backing >= mintedOutstanding`), sem função de saque. O risco residual é a **solvência do USDC** de reserva: se o próprio USDC perder o peg, o CREDIT herda esse risco. É um risco do ativo externo de lastro, não do desenho do PSM. Ver [Riscos e segurança](../06-for-investors/03-risk-and-security.md).

## Quem controla os contratos?

A DAO, via [`CommunityGovernor`](../08-contracts-reference/10-CommunityGovernor.md) + [`CommunityTimelock`](../08-contracts-reference/09-CommunityTimelock.md). Toda mudança governável passa por proposta + voto + delay de 2 dias. Nenhuma EOA tem poder unilateral em produção; gestão de roles do cofre exige supermaioria de 75%. Ver [Modelo de segurança](../09-advanced/03-security-model.md).

## Já dá para usar em mainnet?

**Ainda não.** O protocolo roda em rede local (31337) e Sepolia (11155111). Mainnet depende de dois bloqueadores: **auditoria externa** e **parecer jurídico** sobre o enquadramento do rev-share (que tem semelhança econômica com um valor mobiliário). Ver [Riscos e segurança](../06-for-investors/03-risk-and-security.md).

## Onde vejo os números reais?

Tudo é on-chain (ver [Métricas que importam](../06-for-investors/04-metrics-that-matter.md)): `grossVolumeOf` (GMV por projeto), `totalRevenueDistributed`/`pendingRevenue` (rev-share), `backing`/`mintedOutstanding` (lastro). Se a doc e o código divergirem, **o código ganha**.

---

**Próximo →** [Referência de contratos](../08-contracts-reference/)
