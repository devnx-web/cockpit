#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${COCKPIT_WINVOICE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Cockpit/windows-voice}"
TOKEN_FILE="$DATA_ROOT/bridge/mcp.env"

if [[ ! -f "$TOKEN_FILE" || -L "$TOKEN_FILE" ]]; then
  echo "Credencial MCP indisponível no host." >&2
  exit 1
fi

token_mode="$(stat -c '%a' "$TOKEN_FILE")"
token_owner="$(stat -c '%u' "$TOKEN_FILE")"
if [[ "$token_owner" != "$(id -u)" || "$token_mode" != "600" ]]; then
  echo "Permissões inseguras no arquivo de credencial MCP." >&2
  exit 1
fi

token=""
while IFS='=' read -r name value; do
  if [[ "$name" == "COCKPIT_MCP_TOKEN" ]]; then
    token="$value"
    break
  fi
done < "$TOKEN_FILE"

if [[ ! "$token" =~ ^[[:graph:]]{32,512}$ ]]; then
  echo "Credencial MCP inválida no host." >&2
  exit 1
fi

printf '%s' "$token"
