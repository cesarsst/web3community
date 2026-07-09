#!/bin/bash
# boot-node.sh — inicia hardhat node + deploy Ignition + escreve /shared/config.json
set -euo pipefail

SHARED_DIR="${SHARED_DIR:-/shared}"
PUBLIC_RPC_URL="${PUBLIC_RPC_URL:-http://127.0.0.1:8545}"
CHAIN_ID="${CHAIN_ID:-31337}"

mkdir -p "$SHARED_DIR"
rm -f "$SHARED_DIR/config.json" "$SHARED_DIR/ready"

# 1) inicia hardhat node
echo "[boot] iniciando hardhat node em 0.0.0.0:8545…"
npx hardhat node --hostname 0.0.0.0 --port 8545 &
NODE_PID=$!

# 2) espera RPC ficar pronto (até ~60s)
for i in $(seq 1 60); do
  if curl -fsS -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
       http://127.0.0.1:8545 | grep -q 0x; then
    echo "[boot] RPC ok"
    break
  fi
  sleep 1
done

# 3) deploy fresh (sempre) — stack completa do remodel, com USDC mock local
echo "[boot] deployando Ignition (dev.json, USDC mock)…"
rm -rf ignition/deployments
DEPLOY_USDC_MOCK=true npx hardhat ignition deploy ./ignition/modules/Dao.ts \
  --parameters ignition/parameters/dev.json \
  --network localhost

# 3b) seeds de dev (projetos demo, faucet ETH+USDC, rodada de captação)
echo "[boot] provisionando seeds de dev (deploy-prod-sim)…"
npx hardhat run scripts/deploy-prod-sim.ts --network localhost

# 4) exporta config.json pra o volume compartilhado
echo "[boot] exportando /shared/config.json…"
CHAIN_ID="$CHAIN_ID" PUBLIC_RPC_URL="$PUBLIC_RPC_URL" \
  npx tsx scripts/export-runtime-config.ts "$SHARED_DIR/config.json"

touch "$SHARED_DIR/ready"
echo "[boot] tudo pronto — mantendo hardhat node em foreground"

# 5) segue o node
wait $NODE_PID
