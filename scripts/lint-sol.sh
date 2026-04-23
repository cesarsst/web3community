#!/usr/bin/env bash
# Roda solhint apenas se existir pelo menos um .sol em contracts/.
# Evita o exit 255 do solhint quando a pasta esta vazia (scaffold inicial).
set -euo pipefail

mapfile -t files < <(find contracts -type f -name '*.sol' 2>/dev/null || true)

if [ "${#files[@]}" -eq 0 ]; then
  echo "solhint: nenhum arquivo .sol em contracts/ — pulando."
  exit 0
fi

exec npx solhint "${files[@]}"
