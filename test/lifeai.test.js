import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLifeAi } from "../lib/lifeai.js";
import { createLifeAiClient } from "../lib/lifeai-client.js";

const SILENT = { log: () => {} };

// Um "bin/lifeai" que só fica vivo até levar SIGTERM. Basta para observar o
// ciclo de vida sem depender do Python da LifeAi.
function fakeInstall(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-lifeai-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const bin = path.join(root, "bin", "lifeai");
  // exec: sem ele o bash só trata o SIGTERM depois que o sleep retorna, e o
  // stop() teria de esperar o SIGKILL de cortesia em todo teste.
  fs.writeFileSync(bin, "#!/usr/bin/env bash\nexec sleep 60\n");
  fs.chmodSync(bin, 0o755);
  return root;
}

// Runtime dir isolado: sem isso o teste publicaria descriptor por cima do
// serviço real do usuário.
function fakeRuntime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-lifeai-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeAccess(overrides = {}) {
  return {
    issued: [],
    revoked: [],
    renewals: 0,
    connected: () => true,
    issue(label, ttlMs) {
      this.issued.push({ label, ttlMs });
      return {
        baseUrl: "http://127.0.0.1:47817/team/claude/anthropic",
        capability: `cc-cockpit-${this.issued.length}`,
      };
    },
    async renew() { this.renewals += 1; return true; },
    revoke(capability) { this.revoked.push(capability); return true; },
    ...overrides,
  };
}

test("o filho recebe o broker no env e nenhuma credencial Anthropic do host", async (t) => {
  const root = fakeInstall(t);
  const access = fakeAccess();
  const lifeai = createLifeAi({
    claudeAccess: access,
    log: SILENT,
    env: {
      LIFEAI_ROOT: root,
      LIFEAI_RUNTIME_DIR: fakeRuntime(t),
      ANTHROPIC_API_KEY: "chave-pessoal-do-host",
      ANTHROPIC_TOKEN: "token-pessoal-do-host",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-do-host",
    },
  });

  await lifeai.start();
  assert.equal(lifeai.state().running, true);
  // O lease vale o dobro do heartbeat: um tick perdido não mata a sessão.
  assert.equal(access.issued[0].ttlMs, 2 * lifeai.heartbeatIntervalMs);

  await lifeai.stop();
  assert.equal(lifeai.state().running, false);
  // Parar devolve o lease: um segredo vivo sem dono é superfície à toa.
  assert.deepEqual(access.revoked, ["cc-cockpit-1"]);
});

test("a primeira subida semeia config e persona, e nunca sobrescreve o que já existe", async (t) => {
  const root = fakeInstall(t);
  fs.mkdirSync(path.join(root, "ailiv"), { recursive: true });
  fs.writeFileSync(path.join(root, "ailiv", "config.template.yaml"), "model: {}\n");
  fs.writeFileSync(path.join(root, "ailiv", "SOUL.md"), "# LifeAi\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-lifeai-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const lifeai = createLifeAi({
    claudeAccess: fakeAccess(),
    log: SILENT,
    env: { LIFEAI_ROOT: root, LIFEAI_HOME: home, LIFEAI_RUNTIME_DIR: fakeRuntime(t) },
  });

  await lifeai.start();
  assert.equal(fs.readFileSync(path.join(home, "config.yaml"), "utf8"), "model: {}\n");
  assert.equal(fs.readFileSync(path.join(home, "SOUL.md"), "utf8"), "# LifeAi\n");

  // Ajuste manual do usuário tem que sobreviver a um restart do serviço.
  fs.writeFileSync(path.join(home, "config.yaml"), "model: {ajustado: true}\n");
  await lifeai.restart();
  assert.match(fs.readFileSync(path.join(home, "config.yaml"), "utf8"), /ajustado/);

  await lifeai.stop();
});

test("o filho recebe o caminho do MCP do Cockpit, que o config sozinho não sabe", async (t) => {
  const root = fakeInstall(t);
  // Um bin que só imprime a variável e sai: é a forma direta de ver o env real.
  fs.writeFileSync(path.join(root, "bin", "lifeai"), "#!/usr/bin/env bash\necho \"$LIFEAI_COCKPIT_MCP\"\n");
  fs.chmodSync(path.join(root, "bin", "lifeai"), 0o755);

  const linhas = [];
  const lifeai = createLifeAi({
    claudeAccess: fakeAccess(),
    log: { log: (msg) => linhas.push(msg) },
    env: { LIFEAI_ROOT: root, LIFEAI_RUNTIME_DIR: fakeRuntime(t) },
  });

  await lifeai.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await lifeai.stop();

  const caminho = linhas.find((l) => l.includes("cockpit-mcp"));
  assert.ok(caminho, `esperava o caminho do MCP na saída, recebi: ${linhas.join(" | ")}`);
  assert.ok(fs.existsSync(caminho.replace("[lifeai] ", "")), "o caminho apontado precisa existir");
});

test("sem sessão de time a LifeAi não sobe e diz por quê", async (t) => {
  const root = fakeInstall(t);
  const lifeai = createLifeAi({
    claudeAccess: fakeAccess({ connected: () => false }),
    log: SILENT,
    env: { LIFEAI_ROOT: root, LIFEAI_RUNTIME_DIR: fakeRuntime(t) },
  });

  const state = await lifeai.start();
  assert.equal(state.running, false);
  assert.match(state.lastError, /sess/i);
  await lifeai.stop();
});

test("o heartbeat renova o lease; lease morto reinicia o filho com um novo", async (t) => {
  const root = fakeInstall(t);
  let vivo = true;
  const access = fakeAccess({
    async renew() { this.renewals += 1; return vivo; },
  });
  const lifeai = createLifeAi({
    claudeAccess: access,
    log: SILENT,
    env: { LIFEAI_ROOT: root, LIFEAI_RUNTIME_DIR: fakeRuntime(t) },
  });

  await lifeai.start();
  await lifeai.tick();
  assert.equal(access.renewals, 1);
  assert.equal(access.issued.length, 1, "renovar não pode trocar o segredo que o filho já leu");

  // Lease irrecuperável: o filho segue vivo com um segredo que o broker recusa,
  // e a única forma de entregar outro é pelo env de um processo novo.
  vivo = false;
  await lifeai.tick();
  assert.equal(access.issued.length, 2);
  assert.equal(lifeai.state().running, true);

  await lifeai.stop();
});

test("o descriptor só aparece quando o API server responde, e some no stop", async (t) => {
  const root = fakeInstall(t);
  const runtimeDir = fakeRuntime(t);
  // Um bin que sobe um /v1/health de verdade na porta que o supervisor passou:
  // é essa resposta que autoriza publicar o descriptor.
  fs.writeFileSync(path.join(root, "bin", "lifeai"), [
    "#!/usr/bin/env bash",
    'exec node -e \'require("http").createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end("{}")}).listen(process.env.API_SERVER_PORT,"127.0.0.1")\'',
  ].join("\n"));
  fs.chmodSync(path.join(root, "bin", "lifeai"), 0o755);

  const lifeai = createLifeAi({
    claudeAccess: fakeAccess(),
    log: SILENT,
    env: { LIFEAI_ROOT: root, LIFEAI_RUNTIME_DIR: runtimeDir },
  });

  const descriptor = path.join(runtimeDir, "control.json");
  await lifeai.start();
  assert.equal(fs.existsSync(descriptor), false, "não pode anunciar antes de atender");

  await lifeai.waitReady();
  const publicado = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  assert.equal(publicado.pid, process.pid);
  assert.match(publicado.apiUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(publicado.apiKey, "o cliente precisa da chave para falar com ela");
  // 0600: o apiKey dá controle total do agente a quem o ler.
  assert.equal(fs.statSync(descriptor).mode & 0o777, 0o600);

  await lifeai.stop();
  assert.equal(fs.existsSync(descriptor), false, "descriptor órfão faria o painel falar com porta alheia");
});

test("o cliente do Cockpit relata serviço desligado em vez de tentar subir", async (t) => {
  const runtimeDir = fakeRuntime(t);
  const client = createLifeAiClient({ env: { LIFEAI_RUNTIME_DIR: runtimeDir }, log: SILENT });

  const semServico = await client.state();
  assert.equal(semServico.running, false);
  assert.equal(semServico.reason, "service_down");
  assert.match(semServico.startCommand, /systemctl --user start lifeai/);
  // Pedir algo com o serviço fora tem que falhar dizendo o que fazer.
  await assert.rejects(() => client.ask("oi"), /systemctl --user start lifeai/);

  // Descriptor de um processo que já morreu: a porta pode ter virado de outro
  // dono, então confiar nele seria pior do que dizer que está desligado.
  const morto = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-lifeai-pid-"));
  t.after(() => fs.rmSync(morto, { recursive: true, force: true }));
  fs.writeFileSync(path.join(runtimeDir, "control.json"), JSON.stringify({
    version: 1,
    instanceId: "morta",
    pid: 2 ** 22, // acima de qualquer pid_max usual
    apiUrl: "http://127.0.0.1:1",
    apiKey: "x",
  }));
  assert.equal((await client.state()).reason, "service_down");
});

test("o cliente conversa com o serviço quando o descriptor é válido", async (t) => {
  const runtimeDir = fakeRuntime(t);
  const chamadas = [];
  const server = http.createServer((req, res) => {
    chamadas.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  fs.writeFileSync(path.join(runtimeDir, "control.json"), JSON.stringify({
    version: 1,
    instanceId: "viva",
    pid: process.pid,
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "cc-teste",
    startedAt: "2026-08-25T12:00:00.000Z",
  }));

  const client = createLifeAiClient({ env: { LIFEAI_RUNTIME_DIR: runtimeDir }, log: SILENT });
  const state = await client.state();
  assert.equal(state.running, true);
  assert.equal(state.startedAt, "2026-08-25T12:00:00.000Z");
  assert.deepEqual(chamadas, [{ url: "/v1/health", auth: "Bearer cc-teste" }]);
});

test("o lease do filho que caiu não leva junto o do sucessor", async (t) => {
  // A regressão que isto trava: o handler de saída era anônimo e mexia no
  // estado global sem saber de qual filho era. Quando o exit de um processo já
  // substituído chegava atrasado, ele revogava a capability do sucessor vivo —
  // que passava a levar 401 do broker em toda chamada, sem ter como reler o
  // segredo do env. Foi assim que a LifeAi ficou dez horas cega.
  const root = fakeInstall(t);
  const access = fakeAccess();
  const lifeai = createLifeAi({
    claudeAccess: access,
    log: SILENT,
    env: { LIFEAI_ROOT: root, LIFEAI_RUNTIME_DIR: fakeRuntime(t) },
  });

  await lifeai.start();
  await lifeai.restart();
  t.after(() => lifeai.stop());

  const atual = access.issued.at(-1) && `cc-cockpit-${access.issued.length}`;
  assert.equal(access.issued.length, 2);
  assert.equal(lifeai.state().running, true);
  // O primeiro voltou; o que está de pé segue com o segredo que o broker aceita.
  assert.deepEqual(access.revoked, ["cc-cockpit-1"]);
  assert.ok(!access.revoked.includes(atual));
});

test("queda antes de atender não vira enxurrada de subidas", async (t) => {
  // O filho leva ~25s para abrir o API server. Reagendar em 5s fazia a
  // tentativa seguinte nascer em cima do irmão que ainda subia, e o `--replace`
  // degolava os dois — 1762 vezes numa noite.
  const root = fakeInstall(t);
  fs.writeFileSync(path.join(root, "bin", "lifeai"), "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(path.join(root, "bin", "lifeai"), 0o755);
  const access = fakeAccess();
  const lifeai = createLifeAi({
    claudeAccess: access,
    log: SILENT,
    env: { LIFEAI_ROOT: root, LIFEAI_RUNTIME_DIR: fakeRuntime(t) },
  });

  await lifeai.start();
  t.after(() => lifeai.stop());
  await new Promise((resolve) => setTimeout(resolve, 6_000));

  assert.equal(lifeai.state().running, false);
  // Uma subida, não uma cada 5s: a espera fria é maior que o boot.
  assert.equal(access.issued.length, 1);
});
