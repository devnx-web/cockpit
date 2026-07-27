#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${COCKPIT_WINVOICE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Cockpit/windows-voice}"
DOWNLOAD_DIR="$DATA_ROOT/downloads"
VM_DIR="$DATA_ROOT/vm"
SHARE_DIR="$DATA_ROOT/share"
ISO_PATH="${COCKPIT_WINVOICE_ISO:-$DOWNLOAD_DIR/Windows11-Enterprise-Eval-25H2-pt-BR-x64.iso}"
MSIX_PATH="${COCKPIT_CHATGPT_MSIX:-$DOWNLOAD_DIR/ChatGPT-x64.msix}"
DISK_PATH="$VM_DIR/windows11-codex.qcow2"
VARS_PATH="$VM_DIR/OVMF_VARS_4M.ms.fd"
DISK_SIZE="${COCKPIT_WINVOICE_DISK_SIZE:-120G}"
OVMF_VARS_SOURCE="/usr/share/OVMF/OVMF_VARS_4M.ms.fd"
ISO_EXPECTED_SIZE="${COCKPIT_WINVOICE_ISO_SIZE:-7033266176}"
ISO_EXPECTED_SHA256="${COCKPIT_WINVOICE_ISO_SHA256:-a5d6a86a9553bb730d1b723233108e90c1b9499f7284137218865919d4189ddd}"
MSIX_EXPECTED_SIZE="${COCKPIT_CHATGPT_MSIX_SIZE:-744080244}"
MSIX_EXPECTED_SHA256="${COCKPIT_CHATGPT_MSIX_SHA256:-f0c1d75045952a11a581d34f28f595d1d110fb13f8f7e5c5201802ed2bbd7093}"

verify_file() {
  local file_path="$1"
  local expected_size="$2"
  local expected_sha256="$3"
  local description="$4"
  local actual_size
  local actual_sha256

  actual_size="$(stat -c '%s' "$file_path")"
  if [[ "$actual_size" != "$expected_size" ]]; then
    echo "ERRO: $description incompleto ou inesperado: $actual_size de $expected_size bytes." >&2
    exit 1
  fi

  actual_sha256="$(sha256sum "$file_path" | cut -d ' ' -f 1)"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    echo "ERRO: SHA-256 inválido para $description." >&2
    echo "  esperado: $expected_sha256" >&2
    echo "  recebido: $actual_sha256" >&2
    exit 1
  fi
}

for command_name in qemu-img qemu-system-x86_64 swtpm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERRO: comando obrigatório não encontrado: $command_name" >&2
    exit 1
  fi
done

if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  echo "ERRO: o usuário atual não possui acesso de leitura/escrita a /dev/kvm." >&2
  exit 1
fi

if [[ ! -f "$OVMF_VARS_SOURCE" ]]; then
  echo "ERRO: firmware UEFI Microsoft não encontrado em $OVMF_VARS_SOURCE" >&2
  exit 1
fi

if [[ ! -f "$ISO_PATH" ]]; then
  echo "ERRO: ISO do Windows ainda não está disponível: $ISO_PATH" >&2
  exit 1
fi

echo "Verificando mídia oficial do Windows..."
verify_file "$ISO_PATH" "$ISO_EXPECTED_SIZE" "$ISO_EXPECTED_SHA256" "ISO do Windows"

if [[ -f "$MSIX_PATH" ]]; then
  echo "Verificando pacote oficial do ChatGPT..."
  verify_file "$MSIX_PATH" "$MSIX_EXPECTED_SIZE" "$MSIX_EXPECTED_SHA256" "ChatGPT-x64.msix"
fi

mkdir -p "$VM_DIR" "$SHARE_DIR"
chmod 700 "$VM_DIR"

if [[ ! -f "$DISK_PATH" ]]; then
  qemu-img create -f qcow2 "$DISK_PATH" "$DISK_SIZE"
fi

if [[ ! -f "$VARS_PATH" ]]; then
  cp "$OVMF_VARS_SOURCE" "$VARS_PATH"
  chmod 600 "$VARS_PATH"
fi

cp "$(dirname "$0")/install-chatgpt.ps1" "$SHARE_DIR/install-chatgpt.ps1"
cp "$(dirname "$0")/PRIMEIRO-BOOT.txt" "$SHARE_DIR/PRIMEIRO-BOOT.txt"
cp "$(dirname "$0")/Autounattend.xml" "$SHARE_DIR/Autounattend.xml"

echo "VM preparada:"
echo "  disco:     $DISK_PATH"
echo "  firmware:  $VARS_PATH"
echo "  ISO:       $ISO_PATH"
echo "  share:     $SHARE_DIR"
echo
echo "Inicie com:"
echo "  $(dirname "$0")/run-vm.sh"
