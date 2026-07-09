# DevFaucet

**Para quem é:** devs/auditores.

Contrato: `contracts/dev/DevFaucet.sol` · Solidity 0.8.24 · OpenZeppelin 5.

> **Dev-only.** NÃO deployar em produção — o faucet é deliberadamente aberto (`claimFor` permissionless). Existe só na rede local (hardhat) para bootstrap de carteiras novas.

## Papel

Faucet de desenvolvimento: em um único claim entrega **ETH (gas) + USDC mock** para qualquer carteira, permitindo que contas novas transacionem imediatamente. **CREDIT não sai daqui de propósito** — compra-se 1:1 no [CreditPSM](03-CreditPSM.md) com o USDC do próprio faucet, mantendo todo CREDIT em circulação 100% lastreado.

`claimFor` é permissionless (resolve o bootstrap "sem ETH não há como clamar ETH": uma conta já financiada aciona o drip para uma carteira nova). O cooldown é contado **por destinatário**, então o permissionless não amplia o orçamento drenável por carteira. Cada perna entrega `min(drip, saldo disponível)` em vez de reverter; reverte só se as duas pernas derem zero.

Herança: `Ownable`, `ReentrancyGuard`. Usa `SafeERC20`.

## Interface pública

### Immutables / storage

| Nome | Tipo | Descrição |
|---|---|---|
| `USDC` | `IERC20 immutable public` | USDC mock entregue pelo faucet. |
| `dripEth` | `uint256 public` | ETH (wei) por claim. |
| `dripUsdc` | `uint256 public` | USDC (unidades mínimas, 6 dec no mock) por claim. |
| `cooldown` | `uint256 public` | Intervalo mínimo entre claims do mesmo destinatário. |
| `lastClaimAt` | `mapping(address => uint256) public` | Último claim por destinatário (unix). |

### Constructor

```solidity
constructor(address usdc_, address owner_, uint256 dripEth_, uint256 dripUsdc_, uint256 cooldown_)
```
Reverte `ZeroAddress` se `usdc_ == 0`. Emite `DripConfigured`.

### Claims

```solidity
function claim() external              // claim para o próprio msg.sender (chama claimFor)
function claimFor(address to) public nonReentrant
```
Executa o drip para `to` (permissionless). Reverte `ZeroAddress`, `CooldownActive`, `FaucetEmpty` (ambas as pernas zero), `EthTransferFailed`. Emite `Claimed(to, caller, eth, usdc)` com as quantias de fato entregues.

### Views

```solidity
function previewClaim() public view returns (uint256 ethOut, uint256 usdcOut)  // min(drip, saldo) por perna
function canClaim(address to) external view returns (bool)
function nextClaimAt(address to) external view returns (uint256)
```

### Admin

```solidity
function setDrip(uint256 dripEth_, uint256 dripUsdc_, uint256 cooldown_) external onlyOwner  // emite DripConfigured
receive() external payable                                                                    // financia com ETH; emite Funded
```

## Eventos

| Evento | Emitido em | Indexados |
|---|---|---|
| `Claimed(address to, address caller, uint256 eth, uint256 usdc)` | `claimFor` | `to`, `caller` |
| `DripConfigured(uint256 dripEth, uint256 dripUsdc, uint256 cooldown)` | constructor / `setDrip` | — |
| `Funded(address from, uint256 amount)` | `receive` | `from` |

## Erros

| Erro | Quando ocorre |
|---|---|
| `ZeroAddress()` | `usdc_`/`to` é `address(0)` |
| `CooldownActive(address to, uint256 availableAt)` | destinatário ainda em cooldown |
| `FaucetEmpty()` | ambas as pernas resultariam em zero |
| `EthTransferFailed(address to)` | `call` de ETH retornou falso |

## Roles

Sem `AccessControl`. Usa `Ownable`: `owner` (deployer em dev) ajusta drips/cooldown via `setDrip`.

## Invariantes

- **Cooldown por destinatário:** `claimFor` permissionless não amplia o orçamento drenável por carteira (o gate é `lastClaimAt[to] + cooldown`).
- **Best-effort por perna:** entrega `min(drip, saldo)`; só reverte (`FaucetEmpty`) se as duas pernas derem zero.
- **CREDIT via PSM:** o faucet nunca distribui CREDIT — mantém o lastro do modelo vigente.
- **CEI + `nonReentrant`** em `claimFor` (`lastClaimAt[to]` atualizado antes das transferências).

## Ver também

[CreditPSM](03-CreditPSM.md) · [CreditToken](02-CreditToken.md)
