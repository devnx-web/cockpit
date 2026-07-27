#!/usr/bin/env bash
set -euo pipefail

# This key exists only to hold the loopback MCP port forward open. It must
# never become a shell or a generic SSH transport.
if [[ "${SSH_ORIGINAL_COMMAND:-}" != "cockpit-mcp-tunnel" ]]; then
  echo "A chave MCP aceita somente cockpit-mcp-tunnel." >&2
  exit 126
fi

exec /usr/bin/sleep infinity
