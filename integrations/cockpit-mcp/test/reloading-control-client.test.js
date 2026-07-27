import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createConfiguredControlClient } from "../src/reloading-control-client.js";

const TOKEN_ONE = "instance-one-control-token-0000000001";
const TOKEN_TWO = "instance-two-control-token-0000000002";
const INSTANCE_ONE = "11111111-1111-4111-8111-111111111111";
const INSTANCE_TWO = "22222222-2222-4222-8222-222222222222";

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    controlUrl: `http://127.0.0.1:${port}/internal/control/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function replaceDescriptor(
  descriptorPath,
  { controlUrl, token, instanceId },
) {
  const temporaryPath = `${descriptorPath}.${instanceId}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify({
      schemaVersion: 1,
      controlUrl,
      token,
      instanceId,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
  fs.renameSync(temporaryPath, descriptorPath);
}

function configFromDescriptor(descriptorPath) {
  return loadConfig(
    { COCKPIT_CONTROL_DESCRIPTOR: descriptorPath },
    { transport: "stdio" },
  );
}

test("reloads a rotated descriptor before the next call", async (t) => {
  let firstCalls = 0;
  let secondCalls = 0;
  const first = await startServer((req, res) => {
    firstCalls += 1;
    assert.equal(req.headers.authorization, `Bearer ${TOKEN_ONE}`);
    sendJson(res, 200, {
      ok: true,
      data: { projects: [{ id: "one", name: "Instance one" }] },
      cursor: `${INSTANCE_ONE}:1`,
    });
  });
  const second = await startServer((req, res) => {
    secondCalls += 1;
    assert.equal(req.headers.authorization, `Bearer ${TOKEN_TWO}`);
    sendJson(res, 200, {
      ok: true,
      data: { projects: [{ id: "two", name: "Instance two" }] },
      cursor: `${INSTANCE_TWO}:1`,
    });
  });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
  });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-reload-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const descriptorPath = path.join(temp, "control.json");
  replaceDescriptor(descriptorPath, {
    controlUrl: first.controlUrl,
    token: TOKEN_ONE,
    instanceId: INSTANCE_ONE,
  });

  const client = createConfiguredControlClient(
    configFromDescriptor(descriptorPath),
  );
  const before = await client.listProjects();
  assert.equal(before.projects[0].id, "one");

  replaceDescriptor(descriptorPath, {
    controlUrl: second.controlUrl,
    token: TOKEN_TWO,
    instanceId: INSTANCE_TWO,
  });
  const after = await client.listProjects();

  assert.equal(after.projects[0].id, "two");
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
});

test("retries a mutation after pre-dispatch 401 with the same requestId", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-race-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const descriptorPath = path.join(temp, "control.json");
  const requestIds = [];
  let firstCalls = 0;
  let secondCalls = 0;
  let second;

  const first = await startServer(async (req, res) => {
    firstCalls += 1;
    const body = await readJson(req);
    requestIds.push({
      header: req.headers["idempotency-key"],
      body: body.requestId,
    });
    replaceDescriptor(descriptorPath, {
      controlUrl: second.controlUrl,
      token: TOKEN_TWO,
      instanceId: INSTANCE_TWO,
    });
    sendJson(res, 401, {
      ok: false,
      error: { code: "UNAUTHORIZED", message: "stale control token" },
    });
  });
  second = await startServer(async (req, res) => {
    secondCalls += 1;
    assert.equal(req.headers.authorization, `Bearer ${TOKEN_TWO}`);
    const body = await readJson(req);
    requestIds.push({
      header: req.headers["idempotency-key"],
      body: body.requestId,
    });
    sendJson(res, 200, {
      ok: true,
      requestId: body.requestId,
      ack: {
        accepted: true,
        completed: true,
        at: "2026-07-25T12:00:00.000Z",
      },
      cursor: `${INSTANCE_TWO}:2`,
    });
  });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
  });

  replaceDescriptor(descriptorPath, {
    controlUrl: first.controlUrl,
    token: TOKEN_ONE,
    instanceId: INSTANCE_ONE,
  });
  const client = createConfiguredControlClient(
    configFromDescriptor(descriptorPath),
  );

  const result = await client.sendInput("alpha", "term-1", "echo ok\n");

  assert.equal(result.ack.accepted, true);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0].header, requestIds[0].body);
  assert.deepEqual(requestIds[1], requestIds[0]);
  assert.equal(result.requestId, requestIds[0].body);
});

test("does not retry a mutation after an ambiguous network failure", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-ambiguous-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const descriptorPath = path.join(temp, "control.json");
  let firstCalls = 0;
  let secondCalls = 0;
  let second;

  const first = await startServer(async (req) => {
    firstCalls += 1;
    await readJson(req);
    replaceDescriptor(descriptorPath, {
      controlUrl: second.controlUrl,
      token: TOKEN_TWO,
      instanceId: INSTANCE_TWO,
    });
    req.socket.destroy();
  });
  second = await startServer((_req, res) => {
    secondCalls += 1;
    sendJson(res, 500, {
      ok: false,
      error: { code: "SHOULD_NOT_RUN", message: "duplicate mutation" },
    });
  });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
  });

  replaceDescriptor(descriptorPath, {
    controlUrl: first.controlUrl,
    token: TOKEN_ONE,
    instanceId: INSTANCE_ONE,
  });
  const client = createConfiguredControlClient(
    configFromDescriptor(descriptorPath),
  );

  await assert.rejects(
    client.interruptTerminal("alpha", "term-1"),
    (error) => error?.code === "CONTROL_UNAVAILABLE",
  );
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
});
