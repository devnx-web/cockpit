/**
 * Integração da fachada: worker de verdade escrevendo, leitor `readOnly` lendo.
 * É o teste que cobre a fiação entre as duas conexões SQLite — o resto da suíte
 * exercita cada peça isolada, e nenhuma delas pegaria um erro de WAL ou de caminho.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createUsageService } from "../lib/usage/service.js";

const HORA = 3600_000;

function linhaClaude({ id, requestId, ts, model = "claude-sonnet-5", cwd }) {
  return JSON.stringify({
    type: "assistant",
    requestId,
    cwd,
    timestamp: new Date(ts).toISOString(),
    message: {
      id,
      model,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 },
    },
  });
}

/** Monta um home falso com um projeto cadastrado e um repositório avulso. */
function montarHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-svc-"));
  const projetos = path.join(home, ".claude", "projects", "sessao");
  fs.mkdirSync(projetos, { recursive: true });

  const cadastrado = path.join(home, "cockpit");
  const avulso = path.join(home, "repos", "sigep");
  for (const dir of [cadastrado, avulso]) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  const agora = Date.now();
  fs.writeFileSync(path.join(projetos, "a.jsonl"), [
    linhaClaude({ id: "msg_1", requestId: "req_1", ts: agora, cwd: cadastrado }),
    // Mesmo message.id repetido: o dedup tem de colapsar em um evento só.
    linhaClaude({ id: "msg_1", requestId: "req_1", ts: agora, cwd: cadastrado }),
    linhaClaude({ id: "msg_2", requestId: "req_2", ts: agora, cwd: avulso }),
  ].join("\n") + "\n");

  return { home, cadastrado, avulso };
}

/** Espera uma mensagem do worker chegar, com prazo — nada de sleep fixo. */
function esperar(eventos, tipo, prazoMs = 20_000) {
  return new Promise((resolve, reject) => {
    const inicio = Date.now();
    const timer = setInterval(() => {
      const achado = eventos.find((e) => e.type === tipo);
      if (achado) { clearInterval(timer); resolve(achado); return; }
      if (Date.now() - inicio > prazoMs) {
        clearInterval(timer);
        reject(new Error(`timeout esperando "${tipo}"; recebidos: ${eventos.map((e) => e.type).join(", ") || "(nenhum)"}`));
      }
    }, 25);
  });
}

test("service: worker ingere e o leitor readOnly enxerga os agregados", async (t) => {
  const { home, cadastrado, avulso } = montarHome();
  const eventos = [];
  const service = createUsageService({
    homeDir: home,
    dbPath: path.join(home, "usage.db"),
    log: { log() {}, warn() {} },
    onEvent: (e) => eventos.push(e),
  });
  t.after(async () => {
    await service.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  assert.equal(service.stats().available, false, "sem banco ainda, responde indisponível em vez de estourar");

  service.start({ projects: [{ id: "cockpit", path: cadastrado }] });
  await esperar(eventos, "ready");
  await esperar(eventos, "scan_done");

  const stats = service.stats({ days: 2 });
  assert.equal(stats.available, true);
  assert.equal(stats.totals.requests, 2, "a linha duplicada não foi contada duas vezes");

  const porProjeto = new Map(stats.byProject.map((p) => [p.project_id, p]));
  assert.equal(porProjeto.get("cockpit")?.requests, 1, "atribuído ao projeto cadastrado");
  assert.equal(porProjeto.get("~sigep")?.requests, 1, "repositório avulso vira projeto próprio");
  assert.ok(!porProjeto.has("__none__"), "nada caiu no balde genérico");

  assert.ok(stats.totals.cost_usd > 0, "custo calculado a partir do preço do modelo");
  assert.equal(service.status().running, true);
});

test("service: cadastrar o projeto promove o histórico do repositório avulso", async (t) => {
  const { home, avulso } = montarHome();
  const eventos = [];
  const service = createUsageService({
    homeDir: home,
    dbPath: path.join(home, "usage.db"),
    log: { log() {}, warn() {} },
    onEvent: (e) => eventos.push(e),
  });
  t.after(async () => {
    await service.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  service.start({ projects: [] });
  await esperar(eventos, "ready");
  await esperar(eventos, "scan_done");

  const antes = new Map(service.stats({ days: 2 }).byProject.map((p) => [p.project_id, p]));
  assert.equal(antes.get("~sigep")?.requests, 1);

  // É o que `broadcastProjectsChanged` dispara quando o usuário cadastra o projeto.
  service.setProjects([{ id: "sigep", path: avulso }]);
  await esperar(eventos, "reassigned");

  const depois = new Map(service.stats({ days: 2 }).byProject.map((p) => [p.project_id, p]));
  assert.equal(depois.get("sigep")?.requests, 1, "o histórico migrou para o id oficial");
  assert.ok(!depois.has("~sigep"), "o bucket derivado ficou vazio e foi removido");
});
