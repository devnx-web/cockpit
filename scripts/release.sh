#!/usr/bin/env bash
# =============================================================
# scripts/release.sh — pipeline de release do Cockpit
# =============================================================
# Faz, na ordem:
#   1. bump de versão em package.json, scripts/install.sh, README.md,
#      installer.md (todas as ocorrências de vX.Y.Z)
#   2. npm run dist:linux  (gera .deb + AppImage em dist/)
#   3. copia install.sh para dist/ com a versão nova
#   4. sobe os 4 artefatos para Wasabi (S3-compatível)
#
# Pré-requisitos:
#   - aws-cli v2 instalado e profile configurado
#   - credencial com permissão s3:PutObject em
#     s3://arquivos.devnx.com.br/cockpit/v*/
#
# Configurações (env vars — todas têm default):
#   COCKPIT_S3_BUCKET    bucket Wasabi             (default: arquivos.devnx.com.br)
#   COCKPIT_S3_ENDPOINT  endpoint Wasabi           (default: https://s3.us-central-1.wasabisys.com)
#   COCKPIT_S3_REGION    região Wasabi             (default: us-central-1)
#   COCKPIT_AWS_PROFILE  profile do ~/.aws/...     (default: wasabi)
#   COCKPIT_SKIP_BUILD   "1" para pular o build    (default: vazio)
#   COCKPIT_SKIP_UPLOAD  "1" para pular o upload   (default: vazio)
#
# Uso:
#   ./scripts/release.sh 0.6.12         # bump → build → upload
#   COCKPIT_SKIP_UPLOAD=1 ./scripts/release.sh 0.6.12   # só local
#
# IMPORTANTE: o bucket é "arquivos.devnx.com.br" (sem "c" no fim).
# Em buckets diferentes (arquivosc.*) o URL público do CDN não resolve.
# =============================================================

set -euo pipefail

# ---------- 1. argumentos ----------
NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  echo "uso: $0 <nova-versão>    (ex: $0 0.6.12)"
  exit 1
fi
if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERRO: versão precisa ser X.Y.Z (recebi: $NEW_VERSION)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CUR_VERSION="$(node -p "require('./package.json').version")"

BUCKET="${COCKPIT_S3_BUCKET:-arquivos.devnx.com.br}"
ENDPOINT="${COCKPIT_S3_ENDPOINT:-https://s3.us-central-1.wasabisys.com}"
REGION="${COCKPIT_S3_REGION:-us-central-1}"
PROFILE="${COCKPIT_AWS_PROFILE:-wasabi}"

echo ""
echo "  ────────────────────────────────────────────"
echo "  Cockpit release"
echo "  ────────────────────────────────────────────"
echo "  versão atual:  $CUR_VERSION"
echo "  versão nova:   $NEW_VERSION"
echo "  bucket:        $BUCKET"
echo "  endpoint:      $ENDPOINT"
echo "  profile:       $PROFILE"
echo "  ────────────────────────────────────────────"
echo ""

# ---------- 2. bump de versão ----------
if [[ "$CUR_VERSION" != "$NEW_VERSION" ]]; then
  echo "▸ bumpando versão $CUR_VERSION → $NEW_VERSION…"
  node -e "
    const fs = require('fs');
    const p = require('./package.json');
    p.version = '$NEW_VERSION';
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
    if (fs.existsSync('./package-lock.json')) {
      const lock = require('./package-lock.json');
      lock.version = '$NEW_VERSION';
      if (lock.packages?.['']) lock.packages[''].version = '$NEW_VERSION';
      fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    }
  "
  # bump em todos os docs/scripts que referenciam a versão
  for f in scripts/install.sh README.md installer.md; do
    if [[ -f "$f" ]]; then
      sed -i "s/${CUR_VERSION//./\\.}/$NEW_VERSION/g" "$f"
    fi
  done
  echo "  ✓ package.json + package-lock.json + scripts/install.sh + README.md + installer.md"
else
  echo "▸ versão já é $NEW_VERSION, pulando bump"
fi

# ---------- 3. build ----------
if [[ "${COCKPIT_SKIP_BUILD:-}" != "1" ]]; then
  echo ""
  echo "▸ rodando npm run dist:linux…"
  npm run dist:linux
  cp scripts/install.sh dist/install.sh
  echo "  ✓ dist/install.sh sincronizado"
else
  echo "▸ build pulado (COCKPIT_SKIP_BUILD=1)"
fi

DEB="dist/cockpit-devnx_${NEW_VERSION}_amd64.deb"
APP="dist/Cockpit-${NEW_VERSION}.AppImage"
SH="dist/install.sh"
CHG="CHANGELOG.md"

for f in "$DEB" "$APP" "$SH" "$CHG"; do
  if [[ ! -f "$f" ]]; then
    echo "ERRO: arquivo esperado não existe: $f"
    exit 1
  fi
done

# ---------- 4. upload ----------
if [[ "${COCKPIT_SKIP_UPLOAD:-}" == "1" ]]; then
  echo ""
  echo "▸ upload pulado (COCKPIT_SKIP_UPLOAD=1)"
  echo ""
  echo "  artefatos prontos em $ROOT/dist/:"
  echo "    · $DEB"
  echo "    · $APP"
  echo "    · $SH"
  exit 0
fi

DEST="s3://${BUCKET}/cockpit/v${NEW_VERSION}/"

echo ""
echo "▸ subindo para $DEST"

# Notas sobre as flags:
#   --endpoint-url + --region: precisam ser passados explicitamente; o
#     endpoint_url aninhado em ~/.aws/config NÃO é aplicado pelo aws-cli v2.
#   sem --acl: o bucket usa Bucket Policy (não Object ACLs); passar --acl
#     resulta em AccessDenied no Wasabi mesmo com permissão de PUT.
AWS_OPTS=(--profile "$PROFILE" --region "$REGION" --endpoint-url "$ENDPOINT")

upload() {
  local src="$1"
  local content_type="${2:-}"
  local extra=()
  if [[ -n "$content_type" ]]; then
    extra+=(--content-type "$content_type")
  fi
  echo "  · $(basename "$src")"
  aws "${AWS_OPTS[@]}" s3 cp "$src" "$DEST" "${extra[@]}"
}

upload "$DEB" "application/vnd.debian.binary-package"
upload "$APP" "application/x-executable"
upload "$SH"  "text/x-shellscript"
upload "$CHG" "text/markdown; charset=utf-8"

echo ""
echo "  ✓ release v$NEW_VERSION publicada"
echo ""
echo "  URLs:"
echo "    https://${BUCKET}/cockpit/v${NEW_VERSION}/install.sh"
echo "    https://${BUCKET}/cockpit/v${NEW_VERSION}/cockpit-devnx_${NEW_VERSION}_amd64.deb"
echo "    https://${BUCKET}/cockpit/v${NEW_VERSION}/Cockpit-${NEW_VERSION}.AppImage"
echo ""
echo "  Instalar:"
echo "    curl -fsSL https://${BUCKET}/cockpit/v${NEW_VERSION}/install.sh | sudo bash"
echo ""
