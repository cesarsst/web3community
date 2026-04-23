# Web3Community — Relatorio de Simulacao Economica

Simulacao multi-rodada (52 rodadas) do modelo economico. Validada
on-chain contra a fixture Ignition DEV — os contratos deployados sao
exatamente os mesmos que irao pra producao, apenas com parametros DEV.

**Parametros**:

- Alice: 80_000 GOV, lock 30 dias
- Bob: 40_000 GOV, lock 90 dias
- Split FeeRouter: 95/0/5 (burn/treasury/app)
- Alpha: 0.95 | CapMax: 1M CREDIT | SanityCap: 1M CREDIT/round/projeto
- Floor schedule: decay linear 400_000e18 -> 16_666e18 ao longo de 24 rounds

APR e calculado com moving window de 4 rounds, anualizado assumindo 52 rounds/ano.

**Nota importante sobre as % de APR**: os valores aparecem enormes
(>30_000%) porque APR aqui e TOKEN-on-TOKEN: CREDIT recebido / GOV
stakeado, ambos em 1e18 precision. Em USD, o APR real depende do
preco relativo dos dois tokens, que o simulador nao conhece. O que
interessa comparar entre cenarios e a DINAMICA (crescimento, queda,
estabilizacao), nao o numero absoluto.

## Cenario A — Bootstrap saudavel — uso crescente estabilizado

### Amostragem (1 em cada 4 rounds)

| Round | Burn_R (M) | Emission_R+1 (M) | CREDIT Supply (M) | Alice APR | Bob APR   |
| ----- | ---------- | ---------------- | ----------------- | --------- | --------- |
| 0     | 0.000      | 0.383            | 70.399            | 15067.53% | 21864.92% |
| 4     | 0.762      | 0.724            | 70.139            | 15673.77% | 22744.64% |
| 8     | 0.950      | 0.902            | 69.771            | 32318.69% | 46898.55% |
| 12    | 0.950      | 0.902            | 69.581            | 33996.13% | 49332.73% |
| 16    | 0.950      | 0.902            | 69.391            | 33996.13% | 49332.73% |
| 20    | 0.950      | 0.902            | 69.201            | 33996.13% | 49332.73% |
| 24    | 0.950      | 0.902            | 69.011            | 33996.13% | 49332.73% |
| 28    | 0.950      | 0.902            | 68.821            | 33996.13% | 49332.73% |
| 32    | 0.950      | 0.902            | 68.631            | 33996.13% | 49332.73% |
| 36    | 0.950      | 0.902            | 68.441            | 33996.13% | 49332.73% |
| 40    | 0.950      | 0.902            | 68.251            | 33996.13% | 49332.73% |
| 44    | 0.950      | 0.902            | 68.061            | 33996.13% | 49332.73% |
| 48    | 0.950      | 0.902            | 67.871            | 33996.13% | 49332.73% |
| 51    | 0.950      | 0.902            | 67.728            | 33996.13% | 49332.73% |

### Insights

- APR medio Alice rounds 10-19: 33996.13%
- APR medio Alice ultimos 5 rounds: 33996.13%
- Supply CREDIT: inicio=70399999.99 CREDIT -> fim=67728749.99 CREDIT (delta -2671250.00 CREDIT)
- Ratio emissao/burn acumulado (rounds 0-50): 97.36% (menor que 100% = deflacionario)
- APR estavel ao longo da simulacao — modelo saudavel.

## Cenario B — Death spiral — uso cai drasticamente

### Amostragem (1 em cada 4 rounds)

| Round | Burn_R (M) | Emission_R+1 (M) | CREDIT Supply (M) | Alice APR | Bob APR   |
| ----- | ---------- | ---------------- | ----------------- | --------- | --------- |
| 0     | 0.000      | 0.383            | 70.399            | 15067.53% | 21864.92% |
| 4     | 0.760      | 0.722            | 70.152            | 15561.94% | 22582.36% |
| 8     | 0.828      | 0.787            | 69.906            | 31753.15% | 46077.89% |
| 12    | 0.585      | 0.556            | 70.001            | 26391.75% | 38297.80% |
| 16    | 0.342      | 0.325            | 70.145            | 17701.00% | 25686.42% |
| 20    | 0.100      | 0.094            | 70.338            | 9010.27%  | 13075.05% |
| 24    | 0.050      | 0.047            | 70.375            | 2236.58%  | 3245.57%  |
| 28    | 0.050      | 0.047            | 70.365            | 1789.27%  | 2596.45%  |
| 32    | 0.050      | 0.047            | 70.355            | 1789.27%  | 2596.45%  |
| 36    | 0.050      | 0.047            | 70.345            | 1789.27%  | 2596.45%  |
| 40    | 0.050      | 0.047            | 70.335            | 1789.27%  | 2596.45%  |
| 44    | 0.050      | 0.047            | 70.325            | 1789.27%  | 2596.45%  |
| 48    | 0.050      | 0.047            | 70.315            | 1789.27%  | 2596.45%  |
| 51    | 0.050      | 0.047            | 70.308            | 1789.27%  | 2596.45%  |

### Insights

- APR medio Alice rounds 10-19: 20960.03%
- APR medio Alice ultimos 5 rounds: 1789.27%
- Supply CREDIT: inicio=70399999.99 CREDIT -> fim=70308249.69 CREDIT (delta -91750.30 CREDIT)
- Ratio emissao/burn acumulado (rounds 0-50): 96.91% (menor que 100% = deflacionario)
- WARN: APR colapsou 91.5% do meio pro fim — death spiral se uso nao voltar. Floor schedule (24 rounds) exauriu e emissao agora e dominada por alpha\*burn baixo.

## Cenario C — Wash-burn — projeto tenta queimar 10M num round (acima do sanityCap)

### Amostragem (1 em cada 4 rounds)

| Round | Burn_R (M) | Emission_R+1 (M) | CREDIT Supply (M) | Alice APR | Bob APR   |
| ----- | ---------- | ---------------- | ----------------- | --------- | --------- |
| 0     | 0.000      | 0.383            | 70.399            | 15067.53% | 21864.92% |
| 4     | 0.762      | 0.724            | 70.139            | 15673.77% | 22744.64% |
| 8     | 0.950      | 0.902            | 70.118            | 26644.82% | 38665.04% |
| 12    | 0.950      | 0.902            | 69.928            | 33996.13% | 49332.73% |
| 16    | 0.950      | 0.902            | 69.738            | 33996.13% | 49332.73% |
| 20    | 0.950      | 0.902            | 69.548            | 33996.13% | 49332.73% |
| 24    | 0.950      | 0.902            | 69.358            | 33996.13% | 49332.73% |
| 28    | 0.950      | 0.902            | 69.168            | 33996.13% | 49332.73% |
| 32    | 0.950      | 0.902            | 68.978            | 33996.13% | 49332.73% |
| 36    | 0.950      | 0.902            | 68.788            | 33996.13% | 49332.73% |
| 40    | 0.950      | 0.902            | 68.598            | 33996.13% | 49332.73% |
| 44    | 0.950      | 0.902            | 68.408            | 33996.13% | 49332.73% |
| 48    | 0.950      | 0.902            | 68.218            | 33996.13% | 49332.73% |
| 51    | 0.950      | 0.902            | 68.076            | 33996.13% | 49332.73% |

### Insights

- APR medio Alice rounds 10-19: 33996.13%
- APR medio Alice ultimos 5 rounds: 33996.13%
- Supply CREDIT: inicio=70399999.99 CREDIT -> fim=68076249.99 CREDIT (delta -2323750.00 CREDIT)
- Ratio emissao/burn acumulado (rounds 0-50): 80.14% (menor que 100% = deflacionario)
- APR estavel ao longo da simulacao — modelo saudavel.

### Eventos especiais (notes)

- round=5: wash-burn de 10000000.00 CREDIT REJEITADO (esperado). Revert: VM Exception while processing transaction: reverted with custom error 'SanityCapExceeded(1, 99999999

## Conclusoes

- **Cenario A** (bootstrap saudavel): APR estabiliza, supply estabiliza. Modelo OK quando o uso cresce e se mantem.
- **Cenario B** (death spiral): floor decay protege nos primeiros ~24 rounds. Depois, se o uso nao voltar, emissao cai drasticamente, APR converge para perto de zero. Floor cumpre seu papel de safety-net de bootstrap. DAO precisa monitorar e possivelmente intervir via Governor (reduzir capMax, ajustar alpha) se vir sinal de decadencia prolongada.
- **Cenario C** (wash-burn): SanityCap rejeitou o ataque; agregados nao corrompidos. Validacao on-chain do limite de 1M CREDIT/round/projeto funciona como esperado.

## Como reproduzir

```bash
npm run sim
# ou
npx hardhat run scripts/simulation/economicSim.ts
```
