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
  normalizeControlPolicy,
  readTerminalEvents,
  removeControlDescriptor,
  sanitizeTerminalOutput,
  writeControlDescriptor,
} from "../lib/control-api.js";

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
