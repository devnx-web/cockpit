#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${COCKPIT_WINVOICE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Cockpit/windows-voice}"
DOWNLOAD_DIR="$DATA_ROOT/downloads"
VM_DIR="$DATA_ROOT/vm"

echo "Downloads:"
for file in \
  "$DOWNLOAD_DIR/Windows11-Enterprise-Eval-25H2-pt-BR-x64.iso" \
  "$DOWNLOAD_DIR/ChatGPT-x64.msix"; do
  if [[ -f "$file" ]]; then
    stat -c "  %n — %s bytes" "$file"
  else
    echo "  ausente: $file"
  fi
done

echo
echo "VM:"
if [[ -f "$VM_DIR/windows11-codex.qcow2" ]]; then
  qemu-img info --force-share "$VM_DIR/windows11-codex.qcow2"
else
  echo "  ainda não criada"
fi

echo
echo "Serviços:"
for unit in \
  cockpit-win11-iso-download.service \
  cockpit-chatgpt-msix-download.service \
  cockpit-release-0172-upload.service; do
  printf "  %-43s %s\n" "$unit" "$(systemctl --user is-active "$unit" 2>/dev/null || true)"
done

echo
echo "Ponte:"
for unit in \
  cockpit-windows-voice-sshd.service \
  cockpit-windows-voice-mcp.service; do
  printf "  %-43s %s\n" "$unit" "$(systemctl --user is-active "$unit" 2>/dev/null || true)"
done
if ss -lnt 2>/dev/null | rg -q '127\.0\.0\.1:22222'; then
  echo "  SSH user-mode:                            127.0.0.1:22222"
else
  echo "  SSH user-mode:                            inativo"
fi
if ss -lnt 2>/dev/null | rg -q '127\.0\.0\.1:3740'; then
  echo "  MCP HTTP:                                 127.0.0.1:3740"
else
  echo "  MCP HTTP:                                 inativo"
fi
