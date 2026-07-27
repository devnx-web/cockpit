#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${COCKPIT_WINVOICE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Cockpit/windows-voice}"
BRIDGE_DIR="$DATA_ROOT/bridge"
SSHD_BIN="$BRIDGE_DIR/openssh/usr/sbin/sshd"
SSHD_CONFIG="$BRIDGE_DIR/sshd_config"

if [[ ! -x "$SSHD_BIN" ]]; then
  echo "sshd user-mode não instalado; execute setup-host.sh." >&2
  exit 1
fi

exec "$SSHD_BIN" -D -e -f "$SSHD_CONFIG"
