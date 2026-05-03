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

# 3. (X11) remove a barra de título do sistema assim que a janela aparecer.
#    Roda em background; quando o Chrome cria a janela, aplica _MOTIF_WM_HINTS.
#    Se xdotool/xprop não estiverem instalados, simplesmente pula sem erro.
if [ "${XDG_SESSION_TYPE:-x11}" = "x11" ] && command -v xdotool > /dev/null && command -v xprop > /dev/null; then
  (
    for i in $(seq 1 80); do
      sleep 0.1
      WIN_ID=$(xdotool search --class '^[Cc]ockpit$' 2>/dev/null | head -1)
      if [ -n "$WIN_ID" ]; then
        xprop -id "$WIN_ID" -f _MOTIF_WM_HINTS 32c \
          -set _MOTIF_WM_HINTS "0x2, 0, 0, 0, 0" 2>/dev/null
        exit 0
      fi
    done
  ) &
fi

# 4. Abre em modo --app (janela isolada, sem chrome do navegador)
exec "$BROWSER" \
  --app=http://localhost:3737 \
  --window-size=1500,950 \
  --user-data-dir="$HOME/.cockpit-app-profile" \
  --class=Cockpit \
  --name=Cockpit \
  --no-default-browser-check \
  --no-first-run \
  > /dev/null 2>&1
