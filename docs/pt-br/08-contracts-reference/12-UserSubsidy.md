# UserSubsidy

**Para quem é:** apps criando campanhas de subsídio, auditores, usuários elegíveis.
**Pré-requisitos:** [Tokenomics](../06-for-investors/01-tokenomics.md).

## Visão rápida

Distribui CREDIT pré-financiado para primeiros usuários dos apps via Merkle drops com cap de claims. Subsidia **demanda** (não oferta) durante o bootstrap (~6 meses), até que o burn orgânico sustente a emissão via `RewardDistributor`.

Campanhas múltiplas simultâneas com IDs monotônicos, uma por app/rodada. DAO aprova root + budget via proposta; usuários elegíveis claim via Merkle proof.

## Herança

```
AccessControl (OZ)
ReentrancyGuard (OZ)
```

Usa `SafeERC20`, `MerkleProof`.

## Parâmetros e storage

| Nome | Tipo | Descrição |
|---|---|---|
| `credit` | `IERC20` immutable | CreditToken |
| `nextCampaignId` | uint256 | Contador monotônico |
| `campaigns` | mapping | `id → Campaign` |
| `hasClaimed` | mapping | `id → user → bool` |

### Struct `Campaign`

```solidity
struct Campaign {
    bytes32 merkleRoot;
    uint128 amountPerUser;
    uint64 deadline;
    uint64 createdAt;
    uint32 maxClaims;
    uint32 claimed;
    bool closed;
}
```

Empacotado em 3 slots.

## Roles e permissões

| Role | Em produção |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `CommunityTimelock` |
| `GOVERNANCE_ROLE` | `CommunityTimelock` |

## Funções externas

### Governance-gated

#### `createCampaign(bytes32 merkleRoot, uint128 amountPerUser, uint32 maxClaims, uint64 deadline) → uint256 campaignId`

Abre nova campanha. **Não** move fundos — DAO deve transferir `maxClaims × amountPerUser` de CREDIT para este contrato em chamada separada da mesma proposta.

- **Reverte**: `ZeroRoot`, `ZeroAmount`, `ZeroMaxClaims`, `DeadlineInPast`.
- **Eventos**: `CampaignCreated(campaignId, merkleRoot, amountPerUser, maxClaims, deadline)`.

#### `closeCampaign(uint256 campaignId, address returnTo)`

Fecha campanha e devolve sobras para `returnTo` (tipicamente Treasury).

- **Reverte**: `ZeroAddress`, `CampaignNotFound`, `CampaignAlreadyClosed`.
- **Eventos**: `CampaignClosed(campaignId, returnedTo, unclaimedReturned)`.

Calcula `remainingBudget = (maxClaims - claimed) * amountPerUser`.

### User-facing

#### `claim(uint256 campaignId, bytes32[] calldata proof)`

Exerce claim. `msg.sender` é sempre o destinatário.

- **Reverte**: `CampaignNotFound`, `CampaignAlreadyClosed`, `CampaignExpired`, `AlreadyClaimed`, `CapReached`, `InvalidProof`.
- **Eventos**: `Claimed(campaignId, user, amount)`.

Leaf esperado:

```solidity
leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))
```

Double-hash padrão OZ contra second-preimage em nós intermediários.

### Views

- `campaigns(uint256 id) → Campaign`.
- `hasClaimed(uint256 id, address user) → bool`.
- `isEligible(uint256 campaignId, address user, bytes32[] proof) → bool` — sem consumir claim.

## Eventos

| Evento | Indexados |
|---|---|
| `CampaignCreated(campaignId, merkleRoot, amountPerUser, maxClaims, deadline)` | `campaignId` |
| `Claimed(campaignId, user, amount)` | `campaignId`, `user` |
| `CampaignClosed(campaignId, returnedTo, unclaimedReturned)` | `campaignId`, `returnedTo` |

## Erros customizados

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `credit`, `admin` ou `returnTo` zero |
| `ZeroAmount()` | `amountPerUser == 0` |
| `ZeroRoot()` | `merkleRoot == 0` |
| `ZeroMaxClaims()` | `maxClaims == 0` |
| `DeadlineInPast()` | `deadline <= block.timestamp` |
| `CampaignNotFound()` | ID não existe |
| `CampaignAlreadyClosed()` | Campanha fechada |
| `CampaignExpired()` | `now > deadline` |
| `AlreadyClaimed()` | User já claim |
| `CapReached()` | `claimed >= maxClaims` |
| `InvalidProof()` | Proof não valida contra root |

## Invariantes

- **Merkle root gate**: só endereços no Merkle tree podem claim.
- **Cap por campanha**: `claimed <= maxClaims` sempre.
- **One-claim-per-user**: `hasClaimed[id][user]` bloqueia re-claim.
- **msg.sender = recipient**: claim sempre vai para quem assinou.
- **CEI**: checks → effect (`hasClaimed = true`, `claimed++`) → interaction (`safeTransfer`).
- **ReentrancyGuard**: `claim` e `closeCampaign`.

## Observações importantes

### Merkle (não assinatura por app)

Mantém o app off-chain — qualquer seletor de "quem é usuário real" (wallets com interação > X, tempo > Y) é computado fora da cadeia, e só a raiz compactada entra on-chain via proposta. DAO aprova a raiz, não a lógica de seleção.

### Double-hash leaf

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(user))))
```

Padrão OZ para prevenir second-preimage em nós intermediários (um nó interno de 64 bytes poderia coincidir com hash single-hash de `abi.encode(address)`).

### Budget implícito

Contrato **não** reserva saldo por campanha separadamente. DAO deve transferir `maxClaims × amountPerUser` antes de criar. Se saldo acabar (ex.: múltiplas campanhas compartilhando pool), `claim` reverte no `safeTransfer` — DAO precisa re-fundar.

Por que? Tokens são fungíveis, overhead de "reservar" não traz garantia real contra mis-funding.

### `closeCampaign` antes do deadline

Permitido — cenários de emergência (merkle comprometido, lista sybil descoberta). Governance-gated + timelock-gated (2d), então usuários têm 2 dias de aviso antes do close efetivar.

### `msg.sender` = recipient obrigatório

Sem parâmetro `to`. Impede "claim em nome de outro", que combinado com listas grandes viraria ferramenta para sybil operator claim de usuários desatentos.

Relayer/AA que queira gasless claim usa `msg.sender` da conta do usuário — recipient sempre é a mesma conta que assinou.

### `isEligible` — view útil para UI

Verifica elegibilidade sem consumir claim. Retorna `true` se (existe) + (não fechada) + (dentro do deadline) + (não claim ainda) + (cap não atingido) + (proof valida).

### Imutabilidade do `credit`

Setado no constructor. Simplifica modelo mental (um UserSubsidy = um token) e remove vetor de swap-token-on-the-fly.

---

**Ver também**: [Treasury](04-Treasury.md), [CreditToken](02-CreditToken.md).
