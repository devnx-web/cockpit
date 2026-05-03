#!/usr/bin/env bash
# Inicia o daemon do Claude Voice em background
set -euo pipefail
cd "$(dirname "$0")"
PY=/home/ftgk/Documents/omnivoice-test/.venv/bin/python
mkdir -p logs
nohup "$PY" daemon.py >> logs/daemon.stdout.log 2>&1 &
echo "daemon iniciado (PID $!) — log em logs/daemon.stdout.log"
