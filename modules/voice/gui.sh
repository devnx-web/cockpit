#!/usr/bin/env bash
# Abre o painel tkinter de configuração
set -euo pipefail
cd "$(dirname "$0")"
PY=/home/ftgk/Documents/omnivoice-test/.venv/bin/python
exec "$PY" gui.py
