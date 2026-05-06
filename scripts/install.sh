#!/usr/bin/env bash
set -e

VERSION="0.6.6"
BASE_URL="https://arquivos.devnx.com.br/cockpit/v${VERSION}"
DEB_FILE="cockpit-devnx_${VERSION}_amd64.deb"
TMP="/tmp/${DEB_FILE}"

echo ""
echo "  Cockpit v${VERSION} — instalador"
echo ""

# Verifica arquitetura
ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  echo "  ERRO: apenas x86_64 suportado (detectado: $ARCH)"
  exit 1
fi

# Baixa
echo "  Baixando ${DEB_FILE}..."
curl -fsSL --progress-bar "${BASE_URL}/${DEB_FILE}" -o "$TMP"

# Instala
echo "  Instalando..."
dpkg -i "$TMP" 2>/dev/null || true
apt-get install -f -y -q 2>/dev/null || true

# Limpa
rm -f "$TMP"

echo ""
echo "  Cockpit v${VERSION} instalado."
echo "  Execute: cockpit"
echo ""
