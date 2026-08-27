#!/usr/bin/env bash
# Sobe o Maestro em console mode: mic e alto-falante locais, sem servidor
# LiveKit e sem conta LiveKit. Ctrl+T alterna para modo texto.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env.local ]; then
  echo "falta .env.local (OPENAI_API_KEY)" >&2
  exit 1
fi

exec uv run agent.py console "$@"
