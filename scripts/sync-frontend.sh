#!/bin/bash
# sync-frontend.sh — sincroniza o frontend com o ultimo deploy feito DO HOST.
#
# Contexto: o hardhat node roda no container `web3c-hardhat` (porta 8545 via
# Traefik). O front (`web3c-frontend`, nginx) serve /config.json a partir do
# volume compartilhado `swarm_web3c_shared` (montado ro em /shared). O boot do
# container gera esse config apontando pro deploy DEV do proprio boot; deploys
# feitos do host (ex.: scripts/deploy-prod-sim.ts) registram enderecos em
# ignition/deployments/chain-31337/deployed_addresses.json — este script
# exporta esses enderecos e regrava /shared/config.json no container.
#
# Uso:
#   npm run sync:frontend            # apos qualquer deploy do host
#   npm run deploy:prod-sim:sync     # deploy prod-sim + sync em um passo
#
# Atencao: chain do container e in-memory. `docker restart web3c-hardhat`
# zera tudo e o boot regrava o config com um deploy dev fresh — rode o
# deploy do host + este sync de novo depois.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${WEB3C_CONTAINER:-web3c-hardhat}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[sync] container $CONTAINER nao existe — nada a sincronizar" >&2
  exit 1
fi

# Preserva o rpcUrl publico (HOST_IP) que o boot do container gerou; fallback
# localhost se o config ainda nao existir.
RPC_URL=$(docker exec "$CONTAINER" cat /shared/config.json 2>/dev/null |
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).rpcUrl)}catch{process.exit(1)}})" ||
  echo "http://127.0.0.1:8545")

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
CHAIN_ID="${CHAIN_ID:-31337}" PUBLIC_RPC_URL="$RPC_URL" \
  npx tsx scripts/export-runtime-config.ts "$TMP"

# mktemp cria 0600 e docker cp preserva modo — sem isso o nginx do front
# (worker nao-root) recebe 403 ao servir /config.json.
chmod 644 "$TMP"
docker cp "$TMP" "$CONTAINER":/shared/config.json

echo "[sync] /shared/config.json atualizado no container $CONTAINER (rpcUrl=$RPC_URL)"
echo "[sync] front serve o volume direto — basta recarregar o browser"
