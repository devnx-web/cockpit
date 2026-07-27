import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const MCP_TOKEN = "mcp-token-abcdefghijklmnopqrstuvwxyz-123456";
const CONTROL_TOKEN = "control-token-abcdefghijklmnopqrstuvwxyz-123";

function validEnv(overrides = {}) {
  return {
    COCKPIT_MCP_TOKEN: MCP_TOKEN,
    COCKPIT_CONTROL_TOKEN: CONTROL_TOKEN,
    COCKPIT_CONTROL_URL:
      "http://127.0.0.1:3737/internal/control/v1",
    ...overrides,
  };
}

test("config defaults to loopback and disables every action", () => {
  const config = loadConfig(validEnv());
  assert.equal(config.transport, "stdio");
  assert.equal(config.token, null);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3740);
  assert.equal(
    config.controlUrl.href,
    "http://127.0.0.1:3737/internal/control/v1/",
  );
  assert.deepEqual([...config.actions], []);
});

test("HTTP requires an MCP token; STDIO does not", () => {
  assert.throws(
    () =>
      loadConfig(
        validEnv({ COCKPIT_MCP_TOKEN: undefined }),
        { transport: "http" },
      ),
    /COCKPIT_MCP_TOKEN é obrigatório/,
  );
  assert.equal(
    loadConfig(validEnv({ COCKPIT_MCP_TOKEN: undefined })).token,
    null,
  );
});

test("direct control configuration requires URL and strong token together", () => {
  assert.throws(
    () =>
      loadConfig({
        COCKPIT_CONTROL_URL:
          "http://127.0.0.1:3737/internal/control/v1",
      }),
    /devem ser definidos juntos/,
  );
  assert.throws(
    () =>
      loadConfig(
        validEnv({
          COCKPIT_CONTROL_TOKEN: "short",
        }),
      ),
    /32–512/,
  );
});

test("config refuses public binds and non-loopback control APIs", () => {
  assert.throws(
    () => loadConfig(validEnv({ COCKPIT_MCP_HOST: "0.0.0.0" })),
    /exposição pública é recusada/,
  );
  assert.throws(
    () =>
      loadConfig(
        validEnv({
          COCKPIT_CONTROL_URL:
            "http://192.168.1.10:3737/internal/control/v1",
        }),
      ),
    /deve ser http:\/\/127\.0\.0\.1/,
  );
});

test("config validates the control path and action allowlist", () => {
  assert.throws(
    () =>
      loadConfig(
        validEnv({
          COCKPIT_CONTROL_URL: "http://127.0.0.1:3737/ws",
        }),
      ),
    /internal\/control\/v1/,
  );
  assert.throws(
    () =>
      loadConfig(
        validEnv({
          COCKPIT_MCP_ACTIONS: "send_input,delete_project",
        }),
      ),
    /ação desconhecida/,
  );
  const config = loadConfig(
    validEnv({
      COCKPIT_MCP_ACTIONS:
        "create_terminal,send_input,interrupt_terminal",
      COCKPIT_MCP_ALLOWED_PROJECTS: "alpha,beta-2",
    }),
  );
  assert.deepEqual(
    [...config.actions],
    ["create_terminal", "send_input", "interrupt_terminal"],
  );
  assert.deepEqual([...config.allowedProjects], ["alpha", "beta-2"]);
});

test("discovers a secure explicit control.json descriptor", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-config-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const descriptorPath = path.join(temp, "control.json");
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      schemaVersion: 1,
      controlUrl: "http://127.0.0.1:4567/internal/control/v1/",
      token: CONTROL_TOKEN,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { mode: 0o600 },
  );

  const config = loadConfig({
    HOME: temp,
    COCKPIT_CONTROL_DESCRIPTOR: descriptorPath,
  });
  assert.equal(config.controlUrl.port, "4567");
  assert.equal(config.controlToken, CONTROL_TOKEN);
  assert.equal(config.descriptorPath, descriptorPath);
});

test("rejects insecure, expired and symlinked descriptors", (t) => {
  if (process.platform === "win32") return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-config-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const descriptorPath = path.join(temp, "control.json");
  const descriptor = {
    schemaVersion: 1,
    controlUrl: "http://127.0.0.1:4567/internal/control/v1/",
    token: CONTROL_TOKEN,
  };
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), {
    mode: 0o644,
  });
  assert.throws(
    () =>
      loadConfig({
        HOME: temp,
        COCKPIT_CONTROL_DESCRIPTOR: descriptorPath,
      }),
    /permissão 0600/,
  );

  fs.chmodSync(descriptorPath, 0o600);
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      ...descriptor,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  );
  assert.throws(
    () =>
      loadConfig({
        HOME: temp,
        COCKPIT_CONTROL_DESCRIPTOR: descriptorPath,
      }),
    /expirou/,
  );

  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  const symlinkPath = path.join(temp, "linked-control.json");
  fs.symlinkSync(descriptorPath, symlinkPath);
  assert.throws(
    () =>
      loadConfig({
        HOME: temp,
        COCKPIT_CONTROL_DESCRIPTOR: symlinkPath,
      }),
    /link simbólico/,
  );
});
