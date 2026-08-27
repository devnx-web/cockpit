import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendControlOutputEvent,
  createControlApi,
  createControlPolicySource,
  ControlHttpError,
  normalizeControlPolicy,
  readTerminalEvents,
  removeControlDescriptor,
  sanitizeTerminalOutput,
  writeControlDescriptor,
} from "../lib/control-api.js";
import { createDemandStore } from "../lib/demands.js";
import { pickAgentPreset } from "../lib/dispatch.js";

const TOKEN = "control-token-with-at-least-thirty-two-characters";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

function terminal({
  id,
  owner = "mcp",
  generation = crypto.randomUUID(),
  status = "idle",
  pty = { write() {} },
} = {}) {
  return {
    id,
    name: `Terminal ${id}`,
    owner,
    controlGeneration: generation,
    outputSequence: 0,
    outputEvents: [],
    outputEventBytes: 0,
    maxBufferSize: 200 * 1024,
    status,
    statusText: "ocioso",
    exited: false,
    exitCode: null,
    pty,
  };
}

function fixture() {
  const projects = [
    {
      id: "alpha",
      name: "Alpha",
      color: "#123456",
      path: "/secret/alpha",
      env: { SECRET: "never-return" },
    },
    { id: "beta", name: "Beta", color: "#abcdef", path: "/secret/beta" },
  ];
  const terminals = new Map([
    ["alpha", new Map([
      ["t-ui", terminal({ id: "t-ui", owner: "ui" })],
      ["t-mcp", terminal({ id: "t-mcp" })],
    ])],
    ["beta", new Map([["t-beta", terminal({ id: "t-beta" })]])],
  ]);
  const calls = { create: 0, input: [], interrupt: [] };
  const adapter = {
    listProjects: () => projects,
    getProject: (projectId) =>
      projects.find((project) => project.id === projectId),
    listTerminals: (projectId) =>
      Array.from(terminals.get(projectId)?.values() || []),
    getTerminal: (projectId, terminalId) =>
      terminals.get(projectId)?.get(terminalId) || null,
    createTerminal: async (projectId, name) => {
      calls.create += 1;
      const created = terminal({ id: `t-created-${calls.create}` });
      created.name = name;
      terminals.get(projectId).set(created.id, created);
      return created;
    },
    writeInput: async (projectId, terminalId, data) => {
      calls.input.push({ projectId, terminalId, data });
    },
    interruptTerminal: async (projectId, terminalId) => {
      calls.interrupt.push({ projectId, terminalId });
    },
  };
  const policy = normalizeControlPolicy(
    {
      projects: ["alpha"],
      capabilities: ["read", "create", "input", "interrupt"],
      terminalAccess: "owned",
    },
    { availableProjectIds: projects.map((project) => project.id) },
  );
  const api = createControlApi({
    token: TOKEN,
    instanceId: INSTANCE_ID,
    cockpitVersion: "test",
    policy,
    adapter,
    log: { info() {}, warn() {} },
  });
  return { api, calls, projects, terminals };
}

async function startFixtureServer(api) {
  const server = http.createServer((req, res) => {
    if (!api.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/internal/control/v1`,
  };
}

function headers(extra = {}) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${TOKEN}`,
    "X-Cockpit-Control-Version": "1",
    ...extra,
  };
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}/${route}`, options);
  const body = await response.json();
  return { response, body };
}

test("control API authenticates and exposes only policy-safe metadata", async (t) => {
  const { api } = fixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const unauthorized = await jsonRequest(baseUrl, "health", {
    headers: {
      Accept: "application/json",
      "X-Cockpit-Control-Version": "1",
    },
  });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.error.code, "UNAUTHORIZED");
  assert.match(
    unauthorized.response.headers.get("www-authenticate"),
    /^Bearer/,
  );

  const health = await jsonRequest(baseUrl, "health", { headers: headers() });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.instanceId, INSTANCE_ID);
  assert.equal(health.body.data.version, "v1");

  const listed = await jsonRequest(baseUrl, "projects", { headers: headers() });
  assert.deepEqual(listed.body.data.projects, [
    { id: "alpha", name: "Alpha", color: "#123456" },
  ]);
  assert.equal(JSON.stringify(listed.body).includes("/secret"), false);
  assert.equal(JSON.stringify(listed.body).includes("never-return"), false);

  const terminalList = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals",
    { headers: headers() },
  );
  assert.equal(terminalList.response.status, 200);
  assert.deepEqual(
    terminalList.body.data.terminals.map((item) => item.id),
    ["t-mcp"],
  );

  const forbidden = await jsonRequest(
    baseUrl,
    "projects/beta/terminals",
    { headers: headers() },
  );
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.error.code, "PROJECT_FORBIDDEN");
});

test("terminal output cursor is incremental, UTF-8 bounded, and sanitized", async () => {
  const term = terminal({
    id: "t1",
    generation: "22222222-2222-4222-8222-222222222222",
  });
  appendControlOutputEvent(
    term,
    "\x1b[31mfeito\x1b[0m\n\x1b]52;c;clipboard-secret\x07ç",
    { ts: "2026-07-25T12:00:00.000Z" },
  );

  const first = readTerminalEvents(INSTANCE_ID, term, { maxBytes: 5 });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].data, "feito");
  assert.equal(Buffer.byteLength(first.events[0].data), 5);

  const second = readTerminalEvents(INSTANCE_ID, term, {
    after: first.cursor,
    maxBytes: 3,
  });
  assert.equal(second.events.map((event) => event.data).join(""), "\nç");
  assert.equal(
    second.events.some((event) => event.data.includes("clipboard-secret")),
    false,
  );

  const exhausted = readTerminalEvents(INSTANCE_ID, term, {
    after: second.cursor,
    maxBytes: 10,
  });
  assert.deepEqual(exhausted.events, []);
  assert.equal(exhausted.cursor, second.cursor);
});

test("output HTTP endpoint preserves cursors and supports bounded long-poll", async (t) => {
  const { api, terminals } = fixture();
  const term = terminals.get("alpha").get("t-mcp");
  appendControlOutputEvent(term, "\x1b[32mpronto\x1b[0m\n");
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const first = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals/t-mcp/output?max_bytes=64&wait_ms=0",
    { headers: headers() },
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.events[0].data, "pronto\n");
  assert.equal(first.body.data.timedOut, false);

  const waited = await jsonRequest(
    baseUrl,
    `projects/alpha/terminals/t-mcp/output?after=${encodeURIComponent(
      first.body.cursor,
    )}&max_bytes=64&wait_ms=25`,
    { headers: headers() },
  );
  assert.equal(waited.response.status, 200);
  assert.deepEqual(waited.body.data.events, []);
  assert.equal(waited.body.data.timedOut, true);
  assert.equal(waited.body.cursor, first.body.cursor);
});

test("expired output cursors fail closed after ring rotation", () => {
  const term = terminal({
    id: "t1",
    generation: "33333333-3333-4333-8333-333333333333",
  });
  appendControlOutputEvent(term, "old");
  const oldCursor = readTerminalEvents(INSTANCE_ID, term, {
    maxBytes: 1,
  }).cursor;
  appendControlOutputEvent(term, "new");
  const removed = term.outputEvents.shift();
  term.outputEventBytes -= Buffer.byteLength(removed.data);

  assert.throws(
    () =>
      readTerminalEvents(INSTANCE_ID, term, {
        after: oldCursor,
        maxBytes: 10,
      }),
    (error) => error.code === "CURSOR_EXPIRED" && error.statusCode === 410,
  );
});

test("mutations require confirmation and are idempotent", async (t) => {
  const { api, calls } = fixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const requestId = crypto.randomUUID();
  const createBody = {
    requestId,
    confirm: true,
    name: "Agente MCP",
  };
  const options = {
    method: "POST",
    headers: headers({
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    }),
    body: JSON.stringify(createBody),
  };

  const created = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals",
    options,
  );
  assert.equal(created.response.status, 202);
  assert.equal(created.body.requestId, requestId);
  assert.equal(created.body.ack.accepted, true);
  assert.equal(created.body.data.terminal.id, "t-created-1");

  const replay = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals",
    options,
  );
  assert.equal(replay.body.data.terminal.id, "t-created-1");
  assert.equal(calls.create, 1);

  const conflict = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals",
    {
      ...options,
      body: JSON.stringify({ ...createBody, name: "Outro nome" }),
    },
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "REQUEST_ID_CONFLICT");

  const missingConfirmationId = crypto.randomUUID();
  const missingConfirmation = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals",
    {
      method: "POST",
      headers: headers({
        "Content-Type": "application/json",
        "Idempotency-Key": missingConfirmationId,
      }),
      body: JSON.stringify({
        requestId: missingConfirmationId,
        confirm: false,
      }),
    },
  );
  assert.equal(missingConfirmation.response.status, 400);
});

test("input and interrupt are restricted to live MCP-owned terminals", async (t) => {
  const { api, calls, terminals } = fixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const action = async (suffix, body) => {
    const requestId = crypto.randomUUID();
    const request = {
      method: "POST",
      headers: headers({
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      }),
      body: JSON.stringify({ requestId, confirm: true, ...body }),
    };
    return {
      requestId,
      request,
      result: await jsonRequest(
      baseUrl,
      `projects/alpha/terminals/t-mcp/${suffix}`,
        request,
      ),
    };
  };

  const input = await action("input", { data: "pwd\n" });
  assert.equal(input.result.response.status, 202);
  assert.deepEqual(calls.input, [
    { projectId: "alpha", terminalId: "t-mcp", data: "pwd\n" },
  ]);
  terminals.get("alpha").get("t-mcp").exited = true;
  const replay = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals/t-mcp/input",
    input.request,
  );
  assert.equal(replay.response.status, 202);
  assert.equal(replay.body.requestId, input.requestId);
  assert.equal(calls.input.length, 1);
  terminals.get("alpha").get("t-mcp").exited = false;

  const interrupted = await action("interrupt", { kind: "interrupt" });
  assert.equal(interrupted.result.response.status, 202);
  assert.deepEqual(calls.interrupt, [
    { projectId: "alpha", terminalId: "t-mcp" },
  ]);

  const uiRequestId = crypto.randomUUID();
  const uiTerminal = await jsonRequest(
    baseUrl,
    "projects/alpha/terminals/t-ui/input",
    {
      method: "POST",
      headers: headers({
        "Content-Type": "application/json",
        "Idempotency-Key": uiRequestId,
      }),
      body: JSON.stringify({
        requestId: uiRequestId,
        confirm: true,
        data: "nope\n",
      }),
    },
  );
  assert.equal(uiTerminal.response.status, 404);
  assert.equal(uiTerminal.body.error.code, "TERMINAL_NOT_FOUND");
});

test("descriptor is atomically published as 0600 and removed by instance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-control-test-"));
  try {
    const descriptorPath = writeControlDescriptor(
      {
        schemaVersion: 1,
        controlUrl: "http://127.0.0.1:1234/internal/control/v1",
        token: TOKEN,
        instanceId: INSTANCE_ID,
        pid: process.pid,
      },
      { runtimeDir: path.join(root, "runtime") },
    );
    assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(descriptorPath)).mode & 0o777, 0o700);
    const published = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    assert.equal(published.schemaVersion, 1);
    assert.equal(
      published.controlUrl,
      "http://127.0.0.1:1234/internal/control/v1",
    );
    assert.equal(
      removeControlDescriptor(
        descriptorPath,
        "99999999-9999-4999-8999-999999999999",
      ),
      false,
    );
    assert.equal(fs.existsSync(descriptorPath), true);
    assert.equal(removeControlDescriptor(descriptorPath, INSTANCE_ID), true);
    assert.equal(fs.existsSync(descriptorPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default policy denies every project and mutation capability", () => {
  const policy = normalizeControlPolicy(
    {},
    { availableProjectIds: ["alpha", "beta"] },
  );
  assert.deepEqual([...policy.projects], []);
  assert.deepEqual([...policy.capabilities], ["read"]);
  assert.equal(policy.terminalAccess, "owned");
});

test("sanitizer removes terminal control sequences but preserves text layout", () => {
  assert.equal(
    sanitizeTerminalOutput(
      "a\x1b[2Jb\x1b]52;c;secret\x07c\0d\n\t",
    ),
    "abcd\n\t",
  );
});

// --- orquestração: busca, despacho e fila de demandas -----------------------

// a rota exige Idempotency-Key em formato UUID, igual às outras ações
const KEY_DISPATCH = "33333333-3333-4333-8333-333333333333";
const KEYS = [
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
];

function orchestrationFixture({
  capabilities = ["read", "create", "input", "interrupt", "dispatch"],
  // `null` imita um adaptador sem interface (o gate de janela não existe);
  // `false` imita o Cockpit fechado, que é onde a recusa tem de aparecer.
  janelaAberta = true,
} = {}) {
  const projects = [
    {
      id: "phd-financeiro",
      name: "PHD Financeiro",
      color: "#111111",
      path: "/secret/phd-fin",
      env: { SECRET: "never-return" },
      description: "Painel financeiro do doutorado",
      aliases: ["financas do doutorado"],
      stack: ["next"],
      defaultAgent: "ailiv c",
      commands: [{ label: "ailiv c", cmd: "claude" }],
    },
    {
      id: "phd-artigos",
      name: "PHD Artigos",
      color: "#222222",
      path: "/secret/phd-art",
      description: "Escrita dos artigos do doutorado",
      commands: [],
    },
    { id: "fora", name: "Fora da política", path: "/secret/fora", commands: [] },
  ];
  const terminals = new Map([
    ["phd-financeiro", new Map([["t-mcp", terminal({ id: "t-mcp", status: "running" })]])],
    ["phd-artigos", new Map()],
    ["fora", new Map()],
  ]);
  const calls = { create: 0 };
  const reveals = [];
  const adapter = {
    ...(janelaAberta === null
      ? {}
      : {
          revealProject: async (projectId, info) => {
            if (!janelaAberta) {
              throw new ControlHttpError(
                409,
                "NO_VISIBLE_WINDOW",
                "nenhuma janela do Cockpit pode mostrar este projeto",
              );
            }
            reveals.push({ projectId, ...info });
          },
        }),
    listProjects: () => projects,
    getProject: (projectId) => projects.find((project) => project.id === projectId),
    listTerminals: (projectId) => Array.from(terminals.get(projectId)?.values() || []),
    getTerminal: (projectId, terminalId) => terminals.get(projectId)?.get(terminalId) || null,
    createTerminal: async (projectId, name) => {
      calls.create += 1;
      const created = terminal({ id: `t-created-${calls.create}` });
      created.name = name;
      terminals.get(projectId).set(created.id, created);
      return created;
    },
    writeInput: async () => {},
    interruptTerminal: async () => {},
  };
  const demands = createDemandStore({});
  const runs = [];
  const dispatcher = {
    pickAgentPreset,
    run: (demand, project, preset) => {
      const promise = (async () => {
        const created = await adapter.createTerminal(project.id, demand.title);
        demands.update(demand.id, {
          terminalId: created.id,
          stage: "handed_off",
          status: "working",
          statusText: `entregue para ${preset.label}`,
        });
      })();
      runs.push(promise);
      return promise;
    },
  };
  const policy = normalizeControlPolicy(
    {
      projects: ["phd-financeiro", "phd-artigos"],
      capabilities,
      terminalAccess: "owned",
    },
    { availableProjectIds: projects.map((project) => project.id) },
  );
  const api = createControlApi({
    token: TOKEN,
    instanceId: INSTANCE_ID,
    cockpitVersion: "test",
    policy,
    adapter,
    demands,
    dispatcher,
    log: { info() {}, warn() {} },
  });
  return { api, adapter, calls, demands, runs, reveals };
}

test("busca de projeto nunca devolve caminho ou env e admite ambiguidade", async (t) => {
  const { api } = orchestrationFixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const found = await jsonRequest(baseUrl, "projects/search?q=phd", {
    headers: headers(),
  });
  assert.equal(found.response.status, 200);
  const raw = JSON.stringify(found.body);
  assert.equal(raw.includes("/secret"), false, "caminho local nunca sai daqui");
  assert.equal(raw.includes("never-return"), false, "env nunca sai daqui");
  assert.equal(raw.includes("shell"), false);

  const ids = found.body.data.candidates.map((c) => c.id);
  assert.deepEqual(ids.sort(), ["phd-artigos", "phd-financeiro"]);
  assert.equal(found.body.data.ambiguous, true, "dois nomes parecidos: pergunte");
  assert.equal(raw.includes("fora"), false, "projeto fora da política não existe");

  const top = found.body.data.candidates.find((c) => c.id === "phd-financeiro");
  assert.equal(top.hasDescription, true);
  assert.equal(top.busyTerminals, 1, "informa que o projeto já tem agente ocupado");
});

test("despacho abre um terminal só, mesmo com retry da mesma chave", async (t) => {
  const { api, calls, demands, runs } = orchestrationFixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const send = () =>
    jsonRequest(baseUrl, "projects/phd-financeiro/dispatch", {
      method: "POST",
      headers: headers({
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_DISPATCH,
      }),
      body: JSON.stringify({
        requestId: KEY_DISPATCH,
        confirm: true,
        text: "vê o erro de build",
        title: "erro de build",
      }),
    });

  const first = await send();
  assert.equal(first.response.status, 202);
  assert.equal(first.body.ack.completed, false);
  const demandId = first.body.data.demand.id;
  assert.equal(first.body.data.demand.projectId, "phd-financeiro");
  assert.equal(
    JSON.stringify(first.body).includes("vê o erro de build"),
    false,
    "o texto do pedido só volta na listagem, pelo envelope de texto não confiável",
  );
  assert.match(first.body.cursor, /^demands:/);

  const retry = await send();
  assert.equal(retry.response.status, 202);
  assert.equal(retry.body.data.demand.id, demandId, "retry devolve a mesma demanda");

  await Promise.all(runs);
  assert.equal(calls.create, 1, "retry não abre um segundo terminal");
  assert.equal(demands.get(demandId).status, "working");
});

test("despacho recusa texto inválido e projeto sem agente", async (t) => {
  const { api } = orchestrationFixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const post = (projectId, body, key) =>
    jsonRequest(baseUrl, `projects/${projectId}/dispatch`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", "Idempotency-Key": key }),
      body: JSON.stringify({ requestId: key, confirm: true, ...body }),
    });

  const vazio = await post("phd-financeiro", { text: "   " }, KEYS[0]);
  assert.equal(vazio.response.status, 400);
  assert.equal(vazio.body.error.code, "INVALID_REQUEST");

  const semAgente = await post("phd-artigos", { text: "faz aí" }, KEYS[1]);
  assert.equal(semAgente.response.status, 409);
  assert.equal(semAgente.body.error.code, "NO_AGENT_PRESET");

  const foraDaPolitica = await post("fora", { text: "faz aí" }, KEYS[2]);
  assert.equal(foraDaPolitica.response.status, 403);
});

test("despachar não fura uma política que nega escrever em terminal", async (t) => {
  const { api } = orchestrationFixture({ capabilities: ["read", "create", "dispatch"] });
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const blocked = await jsonRequest(baseUrl, "projects/phd-financeiro/dispatch", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", "Idempotency-Key": KEYS[3] }),
    body: JSON.stringify({ requestId: KEYS[3], confirm: true, text: "faz aí" }),
  });
  assert.equal(blocked.response.status, 403, "dispatch é create+input compostos");
});

test("fila de demandas respeita cursor, instância e política", async (t) => {
  const { api, demands } = orchestrationFixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  demands.create({ text: "antiga", projectId: "phd-financeiro", projectName: "PHD" });
  // sem cursor: só o que mudar daqui pra frente, nunca o histórico inteiro
  const agora = await jsonRequest(baseUrl, "demands", { headers: headers() });
  assert.equal(agora.response.status, 200);
  assert.deepEqual(agora.body.data.demands, []);
  assert.equal(agora.body.data.timedOut, true);

  const cursor = agora.body.cursor;
  demands.create({ text: "nova", projectId: "phd-financeiro", projectName: "PHD" });
  demands.create({ text: "escondida", projectId: "fora", projectName: "Fora" });
  const depois = await jsonRequest(
    baseUrl,
    `demands?after=${encodeURIComponent(cursor)}`,
    { headers: headers() },
  );
  assert.deepEqual(
    depois.body.data.demands.map((d) => d.projectId),
    ["phd-financeiro"],
    "demanda de projeto fora da política não aparece",
  );
  assert.equal(JSON.stringify(depois.body).includes("escondida"), false);

  const outraInstancia = await jsonRequest(
    baseUrl,
    "demands?after=demands%3Aoutra%3Arevision%3A2",
    { headers: headers() },
  );
  assert.equal(outraInstancia.response.status, 410);
  assert.equal(outraInstancia.body.error.code, "CURSOR_EXPIRED");
});

test("a lista de capabilities não muda sem quem depende dela saber", () => {
  // Espelho de KNOWN_ACTIONS em integrations/cockpit-mcp/src/config.js. Os dois
  // pacotes não se importam, então a lista é repetida de propósito: adicionar
  // uma capability sem atualizar o outro lado quebra um destes dois testes.
  const policy = normalizeControlPolicy(
    {
      projects: ["alpha"],
      capabilities: ["read", "create", "input", "interrupt", "dispatch", "inventada"],
    },
    { availableProjectIds: ["alpha"] },
  );
  assert.deepEqual(
    [...policy.capabilities].sort(),
    ["create", "dispatch", "input", "interrupt", "read"],
    "capability desconhecida é descartada em silêncio",
  );
});

test('projects: "all" libera projeto que nem existia quando a política foi lida', () => {
  const policy = normalizeControlPolicy({ projects: "all", capabilities: ["read"] });
  assert.equal(policy.projects.has("nascido-agora"), true);
  assert.equal(policy.projects.has("qualquer-outro"), true);
});

test("lista explícita não é podada pelo catálogo do boot", () => {
  // Antes, um id ausente do catálogo no momento da leitura era descartado para
  // sempre: criar o projeto depois não o liberava, e ele nascia invisível para
  // o MCP. Agora só o formato do id importa; quem não existe morre no 404.
  const policy = normalizeControlPolicy({ projects: ["alpha", "ainda-nao-criado", "MAIÚSCULO"] });
  assert.equal(policy.projects.has("ainda-nao-criado"), true);
  assert.equal(policy.projects.has("MAIÚSCULO"), false, "id fora do formato continua fora");
});

test("política em arquivo é relida quando o arquivo muda, sem reiniciar", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, "mcp-policy.json");
  const escrever = (dados) => {
    fs.writeFileSync(arquivo, JSON.stringify(dados));
    // mtime tem granularidade grossa em alguns sistemas de arquivos: sem
    // empurrar o relógio, uma escrita no mesmo instante passaria despercebida.
    const futuro = new Date(Date.now() + 2000);
    fs.utimesSync(arquivo, futuro, futuro);
  };

  escrever({ projects: ["alpha"], capabilities: ["read"] });
  const fonte = createControlPolicySource(arquivo, { log: { log() {}, warn() {} } });
  assert.equal(fonte().projects.has("beta"), false);

  escrever({ projects: ["alpha", "beta"], capabilities: ["read"] });
  assert.equal(fonte().projects.has("beta"), true, "o projeto novo entrou sem restart");

  fs.writeFileSync(arquivo, "{ isto não é json");
  fs.utimesSync(arquivo, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
  assert.equal(
    fonte().projects.has("alpha"),
    true,
    "arquivo quebrado no meio da escrita mantém a política anterior no ar",
  );
});

test("a API enxerga a política que vale agora, não a do boot", async (t) => {
  let atual = normalizeControlPolicy({ projects: [], capabilities: ["read"] });
  const vivo = createControlApi({
    token: TOKEN,
    instanceId: INSTANCE_ID,
    cockpitVersion: "test",
    policy: () => atual,
    adapter: { listProjects: () => [{ id: "alpha", name: "Alpha" }], getProject: () => null, listTerminals: () => [] },
    log: { info() {}, warn() {} },
  });
  const { server, baseUrl } = await startFixtureServer(vivo);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const antes = await jsonRequest(baseUrl, "projects", { headers: headers() });
  assert.deepEqual(antes.body.data.projects, []);

  atual = normalizeControlPolicy({ projects: ["alpha"], capabilities: ["read"] });
  const depois = await jsonRequest(baseUrl, "projects", { headers: headers() });
  assert.deepEqual(depois.body.data.projects.map((p) => p.id), ["alpha"]);
});

// ── Nada acontece num projeto que ninguém está vendo ──────────────────────
//
// O servidor mantém uma sessão para cada projeto do catálogo desde o boot, e
// isso bastava para um agente nascer, trabalhar e commitar num projeto que não
// estava em janela nenhuma. O gate é o `revealProject` do adaptador: ou ele
// traz o projeto para a frente, ou recusa a chamada.

test("sem janela que mostre o projeto, despachar é recusado e nem demanda nasce", async (t) => {
  const { api, calls, demands } = orchestrationFixture({ janelaAberta: false });
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const recusa = await jsonRequest(baseUrl, "projects/phd-financeiro/dispatch", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", "Idempotency-Key": KEY_DISPATCH }),
    body: JSON.stringify({
      requestId: KEY_DISPATCH,
      confirm: true,
      text: "publica isso no repositório",
      title: "publicar",
    }),
  });

  assert.equal(recusa.response.status, 409);
  assert.equal(recusa.body.error.code, "NO_VISIBLE_WINDOW");
  assert.equal(calls.create, 0, "nenhum terminal foi aberto às escondidas");
  assert.equal(demands.list().length, 0, "nem demanda natimorta fica na lista");
});

test("sem janela, abrir terminal e escrever num que já existe também param", async (t) => {
  const { api, calls } = orchestrationFixture({ janelaAberta: false });
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const criar = await jsonRequest(baseUrl, "projects/phd-financeiro/terminals", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", "Idempotency-Key": KEYS[0] }),
    body: JSON.stringify({ requestId: KEYS[0], confirm: true, name: "às escondidas" }),
  });
  assert.equal(criar.response.status, 409);
  assert.equal(criar.body.error.code, "NO_VISIBLE_WINDOW");
  assert.equal(calls.create, 0);

  const escrever = await jsonRequest(
    baseUrl,
    "projects/phd-financeiro/terminals/t-mcp/input",
    {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", "Idempotency-Key": KEYS[1] }),
      body: JSON.stringify({ requestId: KEYS[1], confirm: true, data: "git push\r" }),
    },
  );
  assert.equal(escrever.response.status, 409, "terminal já aberto não é porta dos fundos");
  assert.equal(escrever.body.error.code, "NO_VISIBLE_WINDOW");
});

test("com janela aberta, o projeto vem para a frente antes de o trabalho começar", async (t) => {
  const { api, calls, reveals, runs } = orchestrationFixture();
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const enviado = await jsonRequest(baseUrl, "projects/phd-financeiro/dispatch", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", "Idempotency-Key": KEY_DISPATCH }),
    body: JSON.stringify({ requestId: KEY_DISPATCH, confirm: true, text: "confere os testes", title: "testes" }),
  });
  assert.equal(enviado.response.status, 202);
  await Promise.all(runs);

  assert.deepEqual(
    reveals.map((r) => [r.projectId, r.reason]),
    [["phd-financeiro", "dispatch"]],
    "revelou o projeto uma vez, antes do despacho",
  );
  assert.equal(calls.create, 1, "e só então abriu o terminal");
});

test("adaptador sem interface segue funcionando: o gate é da janela, não da API", async (t) => {
  const { api, calls } = orchestrationFixture({ janelaAberta: null });
  const { server, baseUrl } = await startFixtureServer(api);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const criado = await jsonRequest(baseUrl, "projects/phd-financeiro/terminals", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", "Idempotency-Key": KEYS[2] }),
    body: JSON.stringify({ requestId: KEYS[2], confirm: true, name: "sem janela nenhuma" }),
  });
  assert.equal(criado.response.status, 202);
  assert.equal(calls.create, 1);
});
