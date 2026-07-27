#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DATA_ROOT="${COCKPIT_WINVOICE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Cockpit/windows-voice}"
BRIDGE_DIR="$DATA_ROOT/bridge"
SHARE_BRIDGE_DIR="$DATA_ROOT/share/bridge"
OPENSSH_DIR="$BRIDGE_DIR/openssh"
HOST_KEY="$BRIDGE_DIR/ssh_host_ed25519_key"
AUTHORIZED_KEYS="$BRIDGE_DIR/authorized_keys"
SSHD_CONFIG="$BRIDGE_DIR/sshd_config"
MCP_ENV="$BRIDGE_DIR/mcp.env"
SSH_PORT="${COCKPIT_WINVOICE_SSH_PORT:-22222}"
ENROLLMENT_PORT="${COCKPIT_WINVOICE_ENROLLMENT_PORT:-18081}"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SSHD_UNIT="$USER_UNIT_DIR/cockpit-windows-voice-sshd.service"
MCP_UNIT="$USER_UNIT_DIR/cockpit-windows-voice-mcp.service"
POLICY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Cockpit"
POLICY_PATH="$POLICY_DIR/mcp-policy.json"

for command_name in apt-get dpkg-deb node npm openssl ssh-keygen systemctl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERRO: comando obrigatório ausente: $command_name" >&2
    exit 1
  fi
done

if [[ ! "$SSH_PORT" =~ ^[0-9]+$ ]] ||
   (( SSH_PORT < 1024 || SSH_PORT > 65535 )); then
  echo "ERRO: COCKPIT_WINVOICE_SSH_PORT deve ser uma porta alta válida." >&2
  exit 1
fi
if [[ ! "$ENROLLMENT_PORT" =~ ^[0-9]+$ ]] ||
   (( ENROLLMENT_PORT < 1024 || ENROLLMENT_PORT > 65535 )); then
  echo "ERRO: COCKPIT_WINVOICE_ENROLLMENT_PORT deve ser uma porta alta válida." >&2
  exit 1
fi

mkdir -p "$BRIDGE_DIR" "$SHARE_BRIDGE_DIR" "$USER_UNIT_DIR" "$POLICY_DIR"
chmod 700 "$BRIDGE_DIR"

if [[ ! -x "$OPENSSH_DIR/usr/sbin/sshd" ]]; then
  echo "Baixando o OpenSSH Server oficial do Ubuntu para instalação user-mode..."
  download_dir="$(mktemp -d "$BRIDGE_DIR/.openssh-download.XXXXXX")"
  cleanup_download() {
    rm -rf -- "$download_dir"
  }
  trap cleanup_download EXIT
  (
    cd "$download_dir"
    apt-get download openssh-server openssh-sftp-server
  )
  mkdir -p "$download_dir/root"
  for package_path in "$download_dir"/*.deb; do
    dpkg-deb -x "$package_path" "$download_dir/root"
  done
  if [[ ! -x "$download_dir/root/usr/sbin/sshd" ]]; then
    echo "ERRO: o pacote baixado não contém usr/sbin/sshd." >&2
    exit 1
  fi
  mv "$download_dir/root" "$OPENSSH_DIR"
  cleanup_download
  trap - EXIT
fi

if [[ ! -f "$HOST_KEY" ]]; then
  ssh-keygen \
    -q \
    -t ed25519 \
    -N '' \
    -C 'cockpit-windows-voice-host' \
    -f "$HOST_KEY"
fi
chmod 600 "$HOST_KEY"
chmod 644 "$HOST_KEY.pub"

touch "$AUTHORIZED_KEYS"
chmod 600 "$AUTHORIZED_KEYS"

sshd_tmp="$(mktemp "$BRIDGE_DIR/.sshd_config.XXXXXX")"
cat > "$sshd_tmp" <<EOF
Port $SSH_PORT
AddressFamily inet
ListenAddress 127.0.0.1
HostKey $HOST_KEY
PidFile $BRIDGE_DIR/sshd.pid
AuthorizedKeysFile $AUTHORIZED_KEYS
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
PermitRootLogin no
StrictModes no
AllowUsers $(id -un)
AllowTcpForwarding local
AllowStreamLocalForwarding no
GatewayPorts no
PermitOpen any
PermitListen none
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PermitUserRC no
PrintMotd no
PrintLastLog no
TCPKeepAlive yes
ClientAliveInterval 30
ClientAliveCountMax 3
MaxAuthTries 3
MaxSessions 8
UseDNS no
LogLevel ERROR
Subsystem sftp internal-sftp
EOF
install -m 600 "$sshd_tmp" "$SSHD_CONFIG"
rm -f -- "$sshd_tmp"

if [[ ! -f "$MCP_ENV" ]]; then
  mcp_token="$(openssl rand -hex 32)"
  mcp_env_tmp="$(mktemp "$BRIDGE_DIR/.mcp.env.XXXXXX")"
  cat > "$mcp_env_tmp" <<EOF
COCKPIT_MCP_TOKEN=$mcp_token
COCKPIT_MCP_TRANSPORT=http
COCKPIT_MCP_HOST=127.0.0.1
COCKPIT_MCP_PORT=3740
COCKPIT_MCP_ALLOWED_PROJECTS=cockpit
COCKPIT_MCP_ACTIONS=create_terminal,send_input,interrupt_terminal
EOF
  install -m 600 "$mcp_env_tmp" "$MCP_ENV"
  rm -f -- "$mcp_env_tmp"
  unset mcp_token
fi
chmod 600 "$MCP_ENV"

policy_tmp="$(mktemp "$POLICY_DIR/.mcp-policy.json.XXXXXX")"
cat > "$policy_tmp" <<'EOF'
{
  "enabled": true,
  "projects": ["cockpit"],
  "capabilities": ["read", "create", "input", "interrupt"],
  "terminalAccess": "owned"
}
EOF
if [[ -e "$POLICY_PATH" ]]; then
  if [[ ! -f "$POLICY_PATH" || -L "$POLICY_PATH" ]]; then
    echo "ERRO: política existente não é um arquivo regular: $POLICY_PATH" >&2
    rm -f -- "$policy_tmp"
    exit 1
  fi
  if ! node -e '
    const fs = require("node:fs");
    const policy = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const sameSet = (actual, expected) =>
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value) => actual.includes(value));
    if (
      policy.enabled !== true ||
      !sameSet(policy.projects, ["cockpit"]) ||
      !sameSet(
        policy.capabilities,
        ["read", "create", "input", "interrupt"],
      ) ||
      policy.terminalAccess !== "owned"
    ) {
      process.exit(1);
    }
  ' "$POLICY_PATH"; then
    echo "ERRO: preservei a política MCP existente, que não atende à ponte." >&2
    echo "Revise manualmente: $POLICY_PATH" >&2
    rm -f -- "$policy_tmp"
    exit 1
  fi
else
  install -m 600 "$policy_tmp" "$POLICY_PATH"
fi
rm -f -- "$policy_tmp"
chmod 600 "$POLICY_PATH"

sshd_unit_tmp="$(mktemp "$USER_UNIT_DIR/.windows-voice-sshd.XXXXXX")"
cat > "$sshd_unit_tmp" <<EOF
[Unit]
Description=Cockpit Windows Voice user-mode SSH
After=network.target

[Service]
Type=simple
ExecStart=$SCRIPT_DIR/start-sshd.sh
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
install -m 644 "$sshd_unit_tmp" "$SSHD_UNIT"
rm -f -- "$sshd_unit_tmp"

mcp_unit_tmp="$(mktemp "$USER_UNIT_DIR/.windows-voice-mcp.XXXXXX")"
cat > "$mcp_unit_tmp" <<EOF
[Unit]
Description=Cockpit MCP loopback server for Windows Voice
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT/integrations/cockpit-mcp
EnvironmentFile=$MCP_ENV
ExecStart=/usr/bin/npm run start:http
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=default.target
EOF
install -m 644 "$mcp_unit_tmp" "$MCP_UNIT"
rm -f -- "$mcp_unit_tmp"

known_hosts_line="[10.0.2.2]:$SSH_PORT $(cut -d' ' -f1,2 "$HOST_KEY.pub")"
printf '%s\n' "$known_hosts_line" > "$SHARE_BRIDGE_DIR/cockpit-linux-known_hosts"
chmod 644 "$SHARE_BRIDGE_DIR/cockpit-linux-known_hosts"

bridge_info_tmp="$(mktemp "$SHARE_BRIDGE_DIR/.bridge-info.XXXXXX")"
cat > "$bridge_info_tmp" <<EOF
{
  "host": "10.0.2.2",
  "port": $SSH_PORT,
  "user": "$(id -un)",
  "repoPath": "$REPO_ROOT",
  "tokenCommand": "$SCRIPT_DIR/print-mcp-token.sh",
  "enrollmentPort": $ENROLLMENT_PORT
}
EOF
install -m 644 "$bridge_info_tmp" "$SHARE_BRIDGE_DIR/bridge-info.json"
rm -f -- "$bridge_info_tmp"

for client_file in \
  setup-windows.ps1 \
  start-mcp-tunnel.ps1 \
  config.toml.example \
  PASSO-FINAL-WINDOWS.txt; do
  install -m 644 "$SCRIPT_DIR/$client_file" "$SHARE_BRIDGE_DIR/$client_file"
done

chmod 755 \
  "$SCRIPT_DIR/forced-command.sh" \
  "$SCRIPT_DIR/print-mcp-token.sh" \
  "$SCRIPT_DIR/start-enrollment.sh" \
  "$SCRIPT_DIR/start-sshd.sh"

"$OPENSSH_DIR/usr/sbin/sshd" -t -f "$SSHD_CONFIG"
systemctl --user daemon-reload
systemctl --user enable --now cockpit-windows-voice-sshd.service
systemctl --user enable --now cockpit-windows-voice-mcp.service

host_fingerprint="$(ssh-keygen -lf "$HOST_KEY.pub" -E sha256 | awk '{print $2}')"
echo "Ponte Linux preparada:"
echo "  SSH user-mode: 127.0.0.1:$SSH_PORT (VM: 10.0.2.2:$SSH_PORT)"
echo "  host key:      $host_fingerprint"
echo "  MCP:           127.0.0.1:3740"
echo "  política:      $POLICY_PATH"
echo "  bootstrap:     $SHARE_BRIDGE_DIR"
echo
if systemctl --user is-active --quiet cockpit-windows-voice-mcp.service; then
  echo "MCP ativo. Execute agora:"
else
  echo "MCP aguardando o Cockpit recriar o descriptor de controle."
  echo "Reinicie o Cockpit Linux antes da validação final."
fi
echo "  $SCRIPT_DIR/start-enrollment.sh"
