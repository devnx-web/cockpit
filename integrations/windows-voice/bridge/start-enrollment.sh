#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_ROOT="${COCKPIT_WINVOICE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Cockpit/windows-voice}"
BRIDGE_DIR="$DATA_ROOT/bridge"
BOOTSTRAP_DIR="$DATA_ROOT/share/bridge"
ENROLLMENT_PORT="${COCKPIT_WINVOICE_ENROLLMENT_PORT:-18081}"
TOKEN="$(openssl rand -hex 24)"

if [[ ! "$ENROLLMENT_PORT" =~ ^[0-9]+$ ]] ||
   (( ENROLLMENT_PORT < 1024 || ENROLLMENT_PORT > 65535 )); then
  echo "ERRO: COCKPIT_WINVOICE_ENROLLMENT_PORT deve ser uma porta alta válida." >&2
  exit 1
fi

if ! systemctl --user is-active --quiet cockpit-windows-voice-sshd.service; then
  echo "ERRO: o SSH da ponte não está ativo; execute setup-host.sh." >&2
  exit 1
fi

echo "No PowerShell da VM, execute setup-windows.ps1."
echo "Quando solicitado, informe este token de uso único:"
echo
echo "  $TOKEN"
echo
echo "A matrícula aceita exatamente uma dupla de chaves e expira em 10 minutos."
echo
echo "No PowerShell da VM, execute esta linha curta:"
echo
echo "  irm http://10.0.2.2:$ENROLLMENT_PORT/run/$TOKEN | iex"
echo

COCKPIT_BRIDGE_ENROLL_TOKEN="$TOKEN" \
COCKPIT_BRIDGE_ENROLL_PORT="$ENROLLMENT_PORT" \
COCKPIT_BRIDGE_AUTHORIZED_KEYS="$BRIDGE_DIR/authorized_keys" \
COCKPIT_BRIDGE_FORCED_COMMAND="$SCRIPT_DIR/forced-command.sh" \
COCKPIT_BRIDGE_BOOTSTRAP_DIR="$BOOTSTRAP_DIR" \
node "$SCRIPT_DIR/enroll-server.cjs"
