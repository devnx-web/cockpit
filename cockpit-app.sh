#!/bin/bash
# Cockpit — abre como app desktop usando Chrome em modo --app
# (sem barra de URL, sem abas, parece app nativo)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Garante que o servidor está rodando
if ! curl -s -o /dev/null --max-time 1 http://localhost:3737/ 2>/dev/null; then
  echo "▸ subindo servidor cockpit…"
  nohup node server.js > /tmp/cockpit.log 2>&1 &
  for i in $(seq 1 20); do
    sleep 0.3
    if curl -s -o /dev/null --max-time 1 http://localhost:3737/ 2>/dev/null; then
      break
    fi
  done
fi

# 2. Detecta browser Chromium-based
BROWSER=""
for cmd in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$cmd" > /dev/null 2>&1; then
    BROWSER="$cmd"
    break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "Nenhum navegador Chromium encontrado."
  echo "Instale Google Chrome, Chromium, Brave ou Edge."
  echo "Ou abra manualmente: http://localhost:3737"
  exit 1
fi

# 3. Abre em modo --app (janela isolada, sem chrome do navegador)
exec "$BROWSER" \
  --app=http://localhost:3737 \
  --window-size=1500,950 \
  --user-data-dir="$HOME/.cockpit-app-profile" \
  --class=Cockpit \
  --name=Cockpit \
  --no-default-browser-check \
  --no-first-run \
  > /dev/null 2>&1
