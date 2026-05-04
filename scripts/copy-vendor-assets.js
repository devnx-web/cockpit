// Copia assets de terceiros de node_modules para public/vendor/.
// Roda em postinstall — garante que public/ funcione offline e não dependa de CDN.
//
// Pacotes:
//   - @xterm/xterm + addons (UMDs + css)
//   - monaco-editor (min/vs inteiro)
//
// Fontes: usamos a fonte monospace nativa do sistema (ui-monospace, monospace).
// Decisão tomada após bug recorrente em que o atlas WebGL pré-rasterizava com
// fonte fallback antes da @font-face baixar — eliminar @font-face elimina o
// problema de raiz e ainda dá glyphs Unicode mais amplos (acentos, box-drawing,
// símbolos) que vêm com a fonte do SO.

import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VENDOR = path.join(ROOT, "public", "vendor");
const NM = path.join(ROOT, "node_modules");

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// ---------------- xterm ----------------
function copyXterm() {
  const dst = path.join(VENDOR, "xterm");
  fs.mkdirSync(dst, { recursive: true });
  const TARGETS = [
    ["@xterm/xterm/css/xterm.css", "xterm.css"],
    ["@xterm/xterm/lib/xterm.js", "xterm.js"],
    ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
    ["@xterm/addon-web-links/lib/addon-web-links.js", "addon-web-links.js"],
    ["@xterm/addon-search/lib/addon-search.js", "addon-search.js"],
    ["@xterm/addon-webgl/lib/addon-webgl.js", "addon-webgl.js"],
    ["@xterm/addon-unicode11/lib/addon-unicode11.js", "addon-unicode11.js"],
    ["@xterm/addon-clipboard/lib/addon-clipboard.js", "addon-clipboard.js"],
  ];
  let n = 0;
  for (const [from, to] of TARGETS) {
    const src = path.join(NM, from);
    if (!fs.existsSync(src)) {
      console.warn(`[vendor] xterm faltando: ${from}`);
      continue;
    }
    copyFile(src, path.join(dst, to));
    n++;
  }
  console.log(`[vendor] xterm: ${n} arquivo(s)`);
}

// ---------------- monaco ----------------
function copyMonaco() {
  const src = path.join(NM, "monaco-editor", "min", "vs");
  const dst = path.join(VENDOR, "monaco", "vs");
  if (!fs.existsSync(src)) {
    console.warn("[vendor] monaco-editor não encontrado");
    return;
  }
  rmrf(dst);
  copyDir(src, dst);
  console.log(`[vendor] monaco: copiado para ${path.relative(ROOT, dst)}`);
}

// ---------------- run ----------------
fs.mkdirSync(VENDOR, { recursive: true });
copyXterm();
copyMonaco();
// Garante que um diretório de fontes legado não fique para trás após o downgrade.
rmrf(path.join(VENDOR, "fonts"));
