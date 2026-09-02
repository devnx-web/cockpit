// A lista de projetos desacoplados é do servidor, e não sobrevive à janela.
//
// Antes isto vivia no localStorage do renderer, e a janela desacoplada se
// desmarcava no `pagehide`. Quando o processo morria de uma vez — o app.exit do
// quit, um kill, um crash —, o pagehide não rodava e a marca ficava presa: o
// projeto sumia do seletor do mosaico para sempre, sem janela nenhuma aberta
// para justificar. Agora quem responde é o conjunto de WebSockets vivos.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import url from "node:url";
import WebSocket from "ws";

const RAIZ = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

/**
 * Um servidor para o arquivo inteiro: o `server.js` é um módulo com estado
 * global (um `server`, um conjunto de clientes), então dois `startServer` no
 * mesmo processo brigam pelo mesmo objeto.
 *
 * Os `setInterval` do topo do módulo — ticker de status e reaper de ociosos —
 * não têm `unref` e segurariam o test runner para sempre; capturamos os handles
 * na subida e os limpamos no fim, como em `server-boot.test.js`.
 */
let SERVIDOR = null;
const TIMERS = [];

async function sobeServidor() {
  if (SERVIDOR) return SERVIDOR;
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const handle = originalInterval(...args);
    TIMERS.push(handle);
    return handle;
  };
  try {
    const { startServer } = await import(url.pathToFileURL(path.join(RAIZ, "server.js")).href);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-detach-"));
    fs.writeFileSync(path.join(dir, "projects.json"), "[]\n");
    SERVIDOR = await startServer({
      port: 0,
      rootDir: RAIZ,
      projectsPath: path.join(dir, "projects.json"),
      voiceEnabled: false,
      dictationEnabled: false,
      usageEnabled: false,
      controlRuntimeDir: dir,
      log: { log() {} },
    });
  } finally {
    globalThis.setInterval = originalInterval;
  }
  return SERVIDOR;
}

test.after(() => {
  for (const t of TIMERS) clearInterval(t);
  try { SERVIDOR?.server?.close(); } catch {}
});

function conecta(serverUrl) {
  const origin = new URL(serverUrl).origin;
  const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws`, { origin });
  const mensagens = [];
  ws.on("message", (raw) => {
    try { mensagens.push(JSON.parse(raw.toString())); } catch {}
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, mensagens }));
    ws.once("error", reject);
  });
}

// Espera até `fn()` devolver algo verdadeiro, ou desiste.
async function ate(fn, { timeout = 2000 } = {}) {
  const fim = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > fim) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ultimaLista = (msgs) => [...msgs].reverse().find((m) => m.type === "detached_projects");

test("desacoplar avisa as outras janelas, e fechar a janela desfaz o aviso", async () => {
  const inst = await sobeServidor();

  const principal = await conecta(inst.url);
  const desacoplada = await conecta(inst.url);

  // ninguém desacoplado ainda: o hello chega com a lista vazia
  const hello = await ate(() => principal.mensagens.find((m) => m.type === "hello"));
  assert.ok(hello, "a janela deveria receber o hello");
  assert.deepEqual(hello.detachedProjects, []);

  desacoplada.ws.send(JSON.stringify({ type: "window_scope", detachedProject: "loja" }));

  const aviso = await ate(() => {
    const m = ultimaLista(principal.mensagens);
    return m && m.ids.includes("loja") ? m : null;
  });
  assert.ok(aviso, "a janela principal deveria saber que 'loja' foi desacoplado");

  // a janela morre sem despedida — é o kill/crash que deixava a marca presa
  desacoplada.ws.terminate();

  const solto = await ate(() => {
    const m = ultimaLista(principal.mensagens);
    return m && !m.ids.includes("loja") ? m : null;
  });
  assert.ok(solto, "com a janela fora, 'loja' volta a ser fixável no mosaico");

  principal.ws.close();
});

test("uma janela nova nasce sabendo quem está desacoplado", async () => {
  const inst = await sobeServidor();

  const desacoplada = await conecta(inst.url);
  desacoplada.ws.send(JSON.stringify({ type: "window_scope", detachedProject: "loja" }));
  // dá tempo do servidor registrar o escopo antes da próxima conexão
  await ate(() => ultimaLista(desacoplada.mensagens));

  const nova = await conecta(inst.url);
  const hello = await ate(() => nova.mensagens.find((m) => m.type === "hello"));
  assert.ok(hello);
  assert.deepEqual(hello.detachedProjects, ["loja"]);

  desacoplada.ws.close();
  nova.ws.close();
});
