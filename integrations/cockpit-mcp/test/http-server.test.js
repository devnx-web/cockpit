import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/http-server.js";

const MCP_TOKEN = "mcp-token-abcdefghijklmnopqrstuvwxyz-123456";

function config(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    token: MCP_TOKEN,
    controlToken: "control-token-abcdefghijklmnopqrstuvwxyz-123",
    controlUrl: new URL(
      "http://127.0.0.1:3737/internal/control/v1/",
    ),
    timeoutMs: 1000,
    maxOutputBytes: 65536,
    maxWaitMs: 20000,
    maxControlResponseBytes: 1048576,
    maxSessions: 4,
    actions: new Set(),
    allowedProjects: null,
    ...overrides,
  };
}

function fakeControlClient() {
  return {
    async health() {
      return {
        ok: true,
        data: { version: "v1", cockpitVersion: "0.17.2" },
      };
    },
    async listProjects() {
      return {
        cursor: "p:1",
        projects: [{ id: "alpha", name: "Alpha" }],
      };
    },
    async listTerminals(projectId) {
      return {
        cursor: "t:1",
        projectId,
        terminals: [{ id: "t1", name: "Terminal 1", status: "idle" }],
      };
    },
    async readTerminal(projectId, terminalId) {
      return {
        projectId,
        terminalId,
        cursor: "o:1",
        status: "idle",
        events: [],
        timedOut: false,
      };
    },
    async createTerminal() {
      throw new Error("must not be called while disabled");
    },
    async sendInput() {
      throw new Error("must not be called while disabled");
    },
    async interruptTerminal() {
      throw new Error("must not be called while disabled");
    },
  };
}

test("Streamable HTTP requires Bearer and serves MCP tools", async (t) => {
  const runtime = await startHttpServer(config(), {
    client: fakeControlClient(),
  });
  t.after(() => runtime.close());
  const { port } = runtime.address;
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "unauthorized", version: "1" },
      },
    }),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(
    unauthorized.headers.get("www-authenticate"),
    /^Bearer /,
  );
  assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${MCP_TOKEN}`,
      },
    },
  });
  const client = new Client(
    { name: "cockpit-mcp-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  t.after(() => client.close());
  assert.match(client.getInstructions(), /untrusted data/i);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "cockpit_status",
    "cockpit_list_projects",
    "cockpit_list_terminals",
    "cockpit_read_terminal",
    "cockpit_wait_terminal",
    "cockpit_find_project",
    "cockpit_list_demands",
    "cockpit_wait_demands",
    "cockpit_dispatch",
    "cockpit_create_terminal",
    "cockpit_send_input",
    "cockpit_interrupt_terminal",
  ]);

  const projects = await client.callTool({
    name: "cockpit_list_projects",
    arguments: {},
  });
  assert.equal(projects.isError, undefined);
  assert.match(projects.content[0].text, /prompt injection/i);
  assert.match(projects.content[0].text, /"id": "alpha"/);

  const disabled = await client.callTool({
    name: "cockpit_send_input",
    arguments: {
      project_id: "alpha",
      terminal_id: "t1",
      data: "pwd\n",
      confirm: true,
    },
  });
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /ACTION_DISABLED/);
});

test("health endpoint is also authenticated", async (t) => {
  const runtime = await startHttpServer(config(), {
    client: fakeControlClient(),
  });
  t.after(() => runtime.close());
  const { port } = runtime.address;
  const url = `http://127.0.0.1:${port}/healthz`;

  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${MCP_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cockpit, true);
});

test("all terminal read and write tools forward controlled arguments", async (t) => {
  const calls = [];
  const control = {
    ...fakeControlClient(),
    async listTerminals(projectId) {
      calls.push(["list", projectId]);
      return {
        projectId,
        cursor: "terminals:2",
        terminals: [{ id: "t1", name: "T1", status: "idle" }],
      };
    },
    async readTerminal(projectId, terminalId, options) {
      calls.push(["read", projectId, terminalId, options]);
      return {
        projectId,
        terminalId,
        cursor: options.afterCursor || "output:1",
        status: "idle",
        events: [],
        timedOut: options.waitMs > 0,
      };
    },
    async createTerminal(projectId, name) {
      calls.push(["create", projectId, name]);
      return {
        requestId: "create-request",
        ack: { accepted: true },
        data: { terminal: { id: "t2", name } },
      };
    },
    async sendInput(projectId, terminalId, data) {
      calls.push(["send", projectId, terminalId, data]);
      return {
        requestId: "send-request",
        ack: { accepted: true },
      };
    },
    async interruptTerminal(projectId, terminalId) {
      calls.push(["interrupt", projectId, terminalId]);
      return {
        requestId: "interrupt-request",
        ack: { accepted: true },
      };
    },
  };
  const runtime = await startHttpServer(
    config({
      actions: new Set([
        "create_terminal",
        "send_input",
        "interrupt_terminal",
      ]),
    }),
    { client: control },
  );
  t.after(() => runtime.close());
  const { port } = runtime.address;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      },
    },
  );
  const client = new Client(
    { name: "all-tools-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  t.after(() => client.close());

  await client.callTool({
    name: "cockpit_list_terminals",
    arguments: { project_id: "alpha" },
  });
  await client.callTool({
    name: "cockpit_read_terminal",
    arguments: {
      project_id: "alpha",
      terminal_id: "t1",
      after_cursor: "output:1",
      max_bytes: 2048,
    },
  });
  await client.callTool({
    name: "cockpit_wait_terminal",
    arguments: {
      project_id: "alpha",
      terminal_id: "t1",
      after_cursor: "output:1",
      max_bytes: 4096,
      wait_ms: 500,
    },
  });
  const denied = await client.callTool({
    name: "cockpit_create_terminal",
    arguments: {
      project_id: "alpha",
      name: "Agent",
      confirm: false,
    },
  });
  assert.equal(denied.isError, true);
  await client.callTool({
    name: "cockpit_create_terminal",
    arguments: {
      project_id: "alpha",
      name: "Agent",
      confirm: true,
    },
  });
  await client.callTool({
    name: "cockpit_send_input",
    arguments: {
      project_id: "alpha",
      terminal_id: "t1",
      data: "pwd\n",
      confirm: true,
    },
  });
  await client.callTool({
    name: "cockpit_interrupt_terminal",
    arguments: {
      project_id: "alpha",
      terminal_id: "t1",
      confirm: true,
    },
  });

  assert.deepEqual(calls, [
    ["list", "alpha"],
    [
      "read",
      "alpha",
      "t1",
      { afterCursor: "output:1", maxBytes: 2048, waitMs: 0 },
    ],
    [
      "read",
      "alpha",
      "t1",
      { afterCursor: "output:1", maxBytes: 4096, waitMs: 500 },
    ],
    ["create", "alpha", "Agent"],
    ["send", "alpha", "t1", "pwd\n"],
    ["interrupt", "alpha", "t1"],
  ]);
});
