#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOWNLOAD_UNIT="${COCKPIT_WINVOICE_DOWNLOAD_UNIT:-cockpit-win11-iso-download.service}"

while systemctl --user is-active --quiet "$DOWNLOAD_UNIT"; do
  sleep 5
done

"$SCRIPT_DIR/create-vm.sh"
"$SCRIPT_DIR/run-vm.sh"
