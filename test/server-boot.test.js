// O teste que faltava: alguém carrega o `server.js`.
//
// A suíte inteira passava com o Cockpit incapaz de subir — `server.js`
// importava `constantTimeTokenEqual` de `lib/control-api.js`, que nunca
// exportou o nome, e o boot morria em `ERR_MODULE_NOT_FOUND`. Nenhum teste
// tocava no arquivo de entrada, então nada estourava: 225 verdes e o programa
// no chão. Um `import()` do módulo já é o bastante para essa classe inteira de
// erro — nome que não existe, caminho errado, ciclo de import.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import url from "node:url";

const RAIZ = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

/**
 * O topo do `server.js` arma dois `setInterval` sem `unref` — o ticker de
 * status e o reaper de terminais ociosos. Em produção é o que se quer; aqui
 * seguraria o processo do test runner para sempre. Capturamos os handles em vez
 * de pedir ao servidor que mude por causa do teste.
 */
async function carregaServidor() {
  const original = globalThis.setInterval;
  const pendentes = [];
  globalThis.setInterval = (...args) => {
    const handle = original(...args);
    pendentes.push(handle);
    return handle;
  };
  try {
    return await import(url.pathToFileURL(path.join(RAIZ, "server.js")).href);
  } finally {
    globalThis.setInterval = original;
    for (const handle of pendentes) clearInterval(handle);
  }
}

test("o server.js carrega e expõe startServer", async () => {
  const mod = await carregaServidor();

  assert.equal(typeof mod.startServer, "function");
});

test("o electron-main só importa do server.js nomes que existem", async () => {
  // O `server.js` não é executado direto no dia a dia: quem o carrega é o
  // processo do Electron. Um nome que ele importa e o servidor não exporta
  // quebra o app do mesmo jeito, e também em silêncio para a suíte.
  const fonte = fs.readFileSync(path.join(RAIZ, "electron-main.js"), "utf8");
  const trecho = fonte.match(/import\s*\{([^}]+)\}\s*from\s*["']\.\/server\.js["']/);
  assert.ok(trecho, "electron-main.js deveria importar do ./server.js");

  const nomes = trecho[1]
    .split(",")
    .map((n) => n.split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  assert.ok(nomes.length > 0);

  const mod = await carregaServidor();
  for (const nome of nomes) {
    assert.ok(nome in mod, `server.js não exporta "${nome}"`);
  }
});
