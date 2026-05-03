#!/usr/bin/env bash
# Inicia o serviço de dictation (push-to-talk com Left Ctrl)
set -euo pipefail
cd "$(dirname "$0")"
PY=/home/ftgk/Documents/omnivoice-test/.venv/bin/python
mkdir -p logs
setsid "$PY" dictation.py >> logs/dictation.stdout.log 2>&1 < /dev/null &
disown
echo "dictation iniciado (PID $!) — log em logs/dictation.stdout.log"
echo "Hold Left Ctrl por 1s pra começar a falar."
