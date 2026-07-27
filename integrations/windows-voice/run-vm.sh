#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${COCKPIT_WINVOICE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Cockpit/windows-voice}"
DOWNLOAD_DIR="$DATA_ROOT/downloads"
VM_DIR="$DATA_ROOT/vm"
SHARE_DIR="$DATA_ROOT/share"
ISO_PATH="${COCKPIT_WINVOICE_ISO:-$DOWNLOAD_DIR/Windows11-Enterprise-Eval-25H2-pt-BR-x64.iso}"
DISK_PATH="$VM_DIR/windows11-codex.qcow2"
VARS_PATH="$VM_DIR/OVMF_VARS_4M.ms.fd"
TPM_DIR="$VM_DIR/tpm"
TPM_SOCKET="$VM_DIR/swtpm.sock"
TPM_PID="$VM_DIR/swtpm.pid"
TPM_LOG="$VM_DIR/swtpm.log"
QEMU_LOG="$VM_DIR/qemu.log"
QEMU_MONITOR_SOCKET="$VM_DIR/qemu-monitor.sock"
INSTALLER_SERVER_PID="$VM_DIR/installer-server.pid"
INSTALLER_SERVER_LOG="$VM_DIR/installer-server.log"
BOOT_HELPER_PID="$VM_DIR/boot-helper.pid"
WINDOW_HELPER_PID="$VM_DIR/window-helper.pid"
OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.ms.fd"
MEMORY_MB="${COCKPIT_WINVOICE_MEMORY_MB:-12288}"
VCPUS="${COCKPIT_WINVOICE_VCPUS:-6}"
MSIX_PATH="${COCKPIT_CHATGPT_MSIX:-$DOWNLOAD_DIR/ChatGPT-x64.msix}"
WINDOW_WIDTH="${COCKPIT_WINVOICE_WINDOW_WIDTH:-1280}"
WINDOW_HEIGHT="${COCKPIT_WINVOICE_WINDOW_HEIGHT:-800}"
WINDOW_X="${COCKPIT_WINVOICE_WINDOW_X:-100}"
WINDOW_Y="${COCKPIT_WINVOICE_WINDOW_Y:-100}"

required_files=(
  "$ISO_PATH"
  "$DISK_PATH"
  "$VARS_PATH"
  "$OVMF_CODE"
  "$MSIX_PATH"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "ERRO: arquivo necessário ausente: $required_file" >&2
    echo "Execute primeiro: $(dirname "$0")/create-vm.sh" >&2
    exit 1
  fi
done

if [[ -z "${DISPLAY:-}" ]]; then
  echo "ERRO: DISPLAY não definido; execute dentro da sessão gráfica." >&2
  exit 1
fi

mkdir -p "$TPM_DIR" "$SHARE_DIR"
rm -f "$TPM_SOCKET" "$TPM_PID" "$INSTALLER_SERVER_PID" "$BOOT_HELPER_PID" "$WINDOW_HELPER_PID" "$QEMU_MONITOR_SOCKET"

cleanup() {
  if [[ -f "$WINDOW_HELPER_PID" ]]; then
    read -r window_helper_pid < "$WINDOW_HELPER_PID" || true
    if [[ "$window_helper_pid" =~ ^[0-9]+$ ]]; then
      kill "$window_helper_pid" 2>/dev/null || true
    fi
  fi
  if [[ -f "$BOOT_HELPER_PID" ]]; then
    read -r boot_helper_pid < "$BOOT_HELPER_PID" || true
    if [[ "$boot_helper_pid" =~ ^[0-9]+$ ]]; then
      kill "$boot_helper_pid" 2>/dev/null || true
    fi
  fi
  if [[ -f "$INSTALLER_SERVER_PID" ]]; then
    read -r installer_server_pid < "$INSTALLER_SERVER_PID" || true
    if [[ "$installer_server_pid" =~ ^[0-9]+$ ]]; then
      kill "$installer_server_pid" 2>/dev/null || true
    fi
  fi
  if [[ -f "$TPM_PID" ]]; then
    read -r swtpm_pid < "$TPM_PID" || true
    if [[ "$swtpm_pid" =~ ^[0-9]+$ ]]; then
      kill "$swtpm_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$TPM_SOCKET" "$TPM_PID" "$INSTALLER_SERVER_PID" "$BOOT_HELPER_PID" "$WINDOW_HELPER_PID" "$QEMU_MONITOR_SOCKET"
}
trap cleanup EXIT INT TERM

node "$(dirname "$0")/serve-installer.cjs" "$MSIX_PATH" >"$INSTALLER_SERVER_LOG" 2>&1 &
echo "$!" > "$INSTALLER_SERVER_PID"
for _ in $(seq 1 50); do
  [[ "$(curl -fsS http://127.0.0.1:18080/health 2>/dev/null || true)" == "ok" ]] && break
  sleep 0.1
done
if [[ "$(curl -fsS http://127.0.0.1:18080/health 2>/dev/null || true)" != "ok" ]]; then
  echo "ERRO: servidor local do instalador não iniciou; consulte $INSTALLER_SERVER_LOG" >&2
  exit 1
fi

swtpm socket \
  --tpm2 \
  --tpmstate "dir=$TPM_DIR" \
  --ctrl "type=unixio,path=$TPM_SOCKET" \
  --pid "file=$TPM_PID" \
  --log "file=$TPM_LOG,level=1" \
  --flags not-need-init,startup-clear \
  --daemon

for _ in $(seq 1 50); do
  [[ -S "$TPM_SOCKET" ]] && break
  sleep 0.1
done
if [[ ! -S "$TPM_SOCKET" ]]; then
  echo "ERRO: o TPM virtual não iniciou; consulte $TPM_LOG" >&2
  exit 1
fi

disk_allocated_bytes="$(( $(stat -c '%b' "$DISK_PATH") * 512 ))"
if (( disk_allocated_bytes < 67108864 )); then
  (
    for _ in $(seq 1 100); do
      [[ -S "$QEMU_MONITOR_SOCKET" ]] && break
      sleep 0.1
    done
    for _ in $(seq 1 15); do
      printf 'sendkey spc\n' | nc -U -N "$QEMU_MONITOR_SOCKET" >/dev/null 2>&1 || true
      sleep 0.35
    done
  ) &
  echo "$!" > "$BOOT_HELPER_PID"
fi

if command -v xdotool >/dev/null 2>&1; then
  (
    window_id=""
    for _ in $(seq 1 100); do
      # GTK exposes both the decorated frame and its client window. The final
      # match is the client that accepts the requested content dimensions.
      window_id="$(xdotool search --class Qemu-system-x86_64 --name 'Cockpit Voice' 2>/dev/null | tail -1 || true)"
      [[ "$window_id" =~ ^[0-9]+$ ]] && break
      sleep 0.1
    done
    if [[ "$window_id" =~ ^[0-9]+$ ]]; then
      # Windows renegotiates the guest resolution several times while booting.
      # Reapply the size through that period so a late resize cannot leave the
      # emulator larger than the monitor.
      for _ in $(seq 1 90); do
        xdotool windowsize "$window_id" "$WINDOW_WIDTH" "$WINDOW_HEIGHT" 2>/dev/null || true
        sleep 0.5
      done
      xdotool windowmove "$window_id" "$WINDOW_X" "$WINDOW_Y" 2>/dev/null || true
    fi
  ) &
  echo "$!" > "$WINDOW_HELPER_PID"
fi

qemu-system-x86_64 \
  -name "Cockpit Voice · Windows 11" \
  -enable-kvm \
  -machine q35,accel=kvm,smm=on,vmport=off \
  -cpu host,hv_relaxed,hv_vapic,hv_spinlocks=0x1fff,hv_vpindex,hv_synic,hv_stimer,hv_time,hv_frequencies \
  -smp "$VCPUS",sockets=1,cores="$VCPUS",threads=1 \
  -m "$MEMORY_MB" \
  -rtc base=localtime,clock=host \
  -boot menu=on \
  -drive "if=pflash,format=raw,readonly=on,file=$OVMF_CODE" \
  -drive "if=pflash,format=raw,file=$VARS_PATH" \
  -drive "file=$DISK_PATH,if=none,id=osdisk,format=qcow2,discard=unmap" \
  -device nvme,drive=osdisk,serial=COCKPITVOICE001 \
  -drive "file=$ISO_PATH,media=cdrom,readonly=on" \
  -drive "if=none,id=voiceshare,file=fat:ro:$SHARE_DIR,format=raw,readonly=on" \
  -chardev "socket,id=chrtpm,path=$TPM_SOCKET" \
  -tpmdev emulator,id=tpm0,chardev=chrtpm \
  -device tpm-tis,tpmdev=tpm0 \
  -device virtio-rng-pci \
  -device qemu-xhci \
  -device usb-tablet \
  -device usb-storage,drive=voiceshare,removable=on,serial=AILIVVOICE \
  -device intel-hda \
  -device hda-duplex,audiodev=voiceaudio \
  -audiodev pipewire,id=voiceaudio \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:3390-:3389 \
  -device e1000e,netdev=net0 \
  -display gtk,gl=off,show-cursor=on,zoom-to-fit=on \
  -vga std \
  -monitor "unix:$QEMU_MONITOR_SOCKET,server=on,wait=off" \
  -D "$QEMU_LOG"
