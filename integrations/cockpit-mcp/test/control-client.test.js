import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ControlApiError, ControlClient } from "../src/control-client.js";

const CONTROL_TOKEN = "control-token-abcdefghijklmnopqrstuvwxyz-123";

async function startControlStub(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  return {
    baseUrl: new URL(
      `http://127.0.0.1:${port}/internal/control/v1/`,
    ),
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, payload) {
  const encoded = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

test("control client authenticates reads and preserves cursors", async (t) => {
  const stub = await startControlStub((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${CONTROL_TOKEN}`);
    assert.equal(req.headers["x-cockpit-control-version"], "1");
    if (req.url === "/internal/control/v1/projects") {
      sendJson(res, 200, {
        ok: true,
        cursor: "projects:8",
        data: {
          projects: [
            {
              id: "alpha",
              name: "Alpha",
              env: { SECRET: "must-not-cross-adapter" },
              path: "/private/path",
            },
            { id: "hidden", name: "Hidden" },
          ],
        },
      });
      return;
    }
    if (
      req.url ===
      "/internal/control/v1/projects/alpha/terminals/t1/output?max_bytes=3&wait_ms=0"
    ) {
      sendJson(res, 200, {
        ok: true,
        cursor: "c:5",
        data: {
          status: "busy",
          events: [
            {
              cursor: "c:5",
              stream: "stdout",
              data: "feito",
            },
          ],
        },
      });
      return;
    }
    if (
      req.url ===
      "/internal/control/v1/projects/alpha/terminals/t1/output?after=c%3A4&max_bytes=4096&wait_ms=250"
    ) {
      sendJson(res, 200, {
        ok: true,
        cursor: "c:5",
        data: {
          status: "busy",
          events: [
            {
              cursor: "c:5",
              stream: "stdout",
              data: "feito",
              ts: "2026-07-25T12:00:00Z",
            },
          ],
        },
      });
      return;
    }
    sendJson(res, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: "not found" },
    });
  });
  t.after(stub.close);

  const client = new ControlClient({
    baseUrl: stub.baseUrl,
    token: CONTROL_TOKEN,
    allowedProjects: new Set(["alpha"]),
  });
  assert.deepEqual(await client.listProjects(), {
    cursor: "projects:8",
    projects: [{ id: "alpha", name: "Alpha", color: null }],
  });
  const output = await client.readTerminal("alpha", "t1", {
    afterCursor: "c:4",
    maxBytes: 4096,
    waitMs: 250,
  });
  assert.equal(output.cursor, "c:5");
  assert.equal(output.events[0].data, "feito");
  await assert.rejects(
    client.readTerminal("alpha", "t1", {
      maxBytes: 3,
      waitMs: 0,
    }),
    (error) => error.code === "CONTROL_OUTPUT_TOO_LARGE",
  );
});

test("control actions require matching requestId and accepted ACK", async (t) => {
  let observedRequestId;
  const stub = await startControlStub(async (req, res) => {
    const body = await readJson(req);
    observedRequestId = body.requestId;
    assert.equal(req.headers["idempotency-key"], body.requestId);
    assert.equal(body.confirm, true);
    assert.equal(body.data, "pwd\n");
    sendJson(res, 202, {
      ok: true,
      requestId: body.requestId,
      ack: {
        accepted: true,
        completed: false,
        at: "2026-07-25T12:00:00Z",
      },
      cursor: "terminal:t1:90",
      data: null,
    });
  });
  t.after(stub.close);

  const client = new ControlClient({
    baseUrl: stub.baseUrl,
    token: CONTROL_TOKEN,
  });
  const result = await client.sendInput("alpha", "t1", "pwd\n");
  assert.equal(result.requestId, observedRequestId);
  assert.equal(result.ack.accepted, true);
});

test("create and interrupt use dedicated endpoints and sanitize action data", async (t) => {
  const observed = [];
  const stub = await startControlStub(async (req, res) => {
    const body = await readJson(req);
    observed.push([req.url, body]);
    const common = {
      ok: true,
      requestId: body.requestId,
      ack: {
        accepted: true,
        completed: true,
        at: "2026-07-25T12:00:00Z",
        internalSecret: "must-not-cross-adapter",
      },
    };
    if (req.url.endsWith("/terminals")) {
      sendJson(res, 201, {
        ...common,
        data: {
          terminal: {
            id: "t2",
            name: body.name,
            status: "idle",
            env: { SECRET: "must-not-cross-adapter" },
          },
        },
      });
      return;
    }
    sendJson(res, 202, common);
  });
  t.after(stub.close);
  const client = new ControlClient({
    baseUrl: stub.baseUrl,
    token: CONTROL_TOKEN,
  });

  const created = await client.createTerminal("alpha", "Agent");
  assert.deepEqual(created.data, {
    terminal: {
      id: "t2",
      name: "Agent",
      status: "idle",
      statusText: "",
      exited: false,
      exitCode: null,
    },
  });
  assert.deepEqual(created.ack, {
    accepted: true,
    completed: true,
    at: "2026-07-25T12:00:00Z",
  });
  const interrupted = await client.interruptTerminal("alpha", "t2");
  assert.equal(interrupted.ack.accepted, true);
  assert.deepEqual(observed.map(([url]) => url), [
    "/internal/control/v1/projects/alpha/terminals",
    "/internal/control/v1/projects/alpha/terminals/t2/interrupt",
  ]);
  assert.equal(observed[0][1].confirm, true);
  assert.equal(observed[1][1].kind, "interrupt");
});

test("control client rejects mismatched ACK and oversized responses", async (t) => {
  let mode = "ack";
  const stub = await startControlStub(async (req, res) => {
    if (mode === "ack") {
      await readJson(req);
      sendJson(res, 202, {
        ok: true,
        requestId: "wrong-request-id",
        ack: { accepted: true },
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      data: { projects: [{ id: "x", padding: "z".repeat(1000) }] },
    });
  });
  t.after(stub.close);

  const client = new ControlClient({
    baseUrl: stub.baseUrl,
    token: CONTROL_TOKEN,
    maxResponseBytes: 256,
  });
  await assert.rejects(
    client.createTerminal("alpha", "Term"),
    (error) =>
      error instanceof ControlApiError && error.code === "CONTROL_INVALID_ACK",
  );
  mode = "large";
  await assert.rejects(
    client.listProjects(),
    (error) =>
      error instanceof ControlApiError &&
      error.code === "CONTROL_RESPONSE_TOO_LARGE",
  );
});

test("control client blocks projects outside the configured scope", async () => {
  const client = new ControlClient({
    baseUrl: "http://127.0.0.1:9/internal/control/v1/",
    token: CONTROL_TOKEN,
    allowedProjects: new Set(["alpha"]),
  });
  await assert.rejects(
    client.listTerminals("beta"),
    (error) => error.code === "PROJECT_FORBIDDEN",
  );
});
