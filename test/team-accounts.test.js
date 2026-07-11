import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TeamAccountsError,
  createTeamAccountsClient,
  normalizeBaseUrl,
} from "../lib/team-accounts.js";

const OPENAI_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OPENAI_ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const CLAUDE_ACCOUNT = "33333333-3333-4333-8333-333333333333";

function json(payload, status = 200) {
  return new Response(payload == null ? null : JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function openAiSelection(id = OPENAI_ACCOUNT, suffix = "one") {
  return {
    account: {
      id,
      provider: "openai",
      label: `OpenAI ${suffix}`,
      usage: { five_hour: { percent: 12, resets_at: null } },
    },
    client: {
      type: "codex_oauth",
      auth_mode: "chatgpt",
      access_token: `access-${suffix}`,
      id_token: `id-${suffix}`,
      account_id: `chatgpt-${suffix}`,
      refresh_token: `cockpit:${id}`,
      last_refresh: "2026-07-10T10:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
    },
  };
}

function claudeSelection() {
  return {
    account: { id: CLAUDE_ACCOUNT, provider: "claude", label: "Claude principal" },
    client: {
      type: "claude_setup_token",
      oauth_token: "claude-secret-token",
      expires_at: "2099-01-01T00:00:00Z",
    },
  };
}

function makeFixture(t, handler, options = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-team-test-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return handler({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : null, calls });
  };
  const client = createTeamAccountsClient({
    homeDir,
    fetchImpl,
    env: { NODE_ENV: "development" },
    ...options,
  });
  return { client, calls, homeDir };
}

async function connect(client) {
  return client.connect({
    baseUrl: "http://127.0.0.1:8000",
    email: "dev@example.test",
    password: "password-that-must-not-be-saved",
    deviceName: "Teste Cockpit",
  });
}

test("base URL requires HTTPS outside explicit local development", () => {
  assert.equal(normalizeBaseUrl("https://control.example/api/", { NODE_ENV: "production" }), "https://control.example/api");
  assert.equal(normalizeBaseUrl("http://localhost:8000", { NODE_ENV: "development" }), "http://localhost:8000");
  assert.throws(
    () => normalizeBaseUrl("http://control.example", { NODE_ENV: "production" }),
    (error) => error instanceof TeamAccountsError && error.code === "INSECURE_BASE_URL",
  );
  assert.throws(
    () => normalizeBaseUrl("https://user:pass@control.example?token=x", {}),
    (error) => error.code === "INVALID_BASE_URL",
  );
});

test("status exposes the configured server as a connection suggestion without claiming it is connected", (t) => {
  const { client } = makeFixture(t, () => json({}), {
    env: { NODE_ENV: "development", DEVNX_CONTROL_URL: "http://127.0.0.1:8044/" },
  });
  assert.deepEqual(client.status(), {
    connected: false,
    baseUrl: "http://127.0.0.1:8044",
    selected: {},
  });
});

test("PTY environment fails closed and never inherits local Claude or Codex authentication", (t) => {
  const { client, homeDir } = makeFixture(t, () => json({}));
  const claudeHome = path.join(homeDir, ".cockpit", "claude");
  const unavailableCodexHome = path.join(homeDir, ".cockpit", "codex", "unavailable");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(unavailableCodexHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, ".credentials.json"), '{"local":true}');
  fs.writeFileSync(path.join(unavailableCodexHome, "auth.json"), '{"local":true}');

  const env = client.enrichPtyEnv({
    CLAUDE_CODE_OAUTH_TOKEN: "host-claude-token",
    ANTHROPIC_API_KEY: "host-anthropic-key",
    OPENAI_API_KEY: "host-openai-key",
    CODEX_HOME: path.join(homeDir, ".codex"),
  });

  assert.equal(env.CLAUDE_CONFIG_DIR, claudeHome);
  assert.equal(env.CODEX_HOME, unavailableCodexHome);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(fs.existsSync(path.join(claudeHome, ".credentials.json")), false);
  assert.equal(fs.existsSync(path.join(unavailableCodexHome, "auth.json")), false);

  const isolatedClaudeConfig = JSON.parse(
    fs.readFileSync(path.join(claudeHome, ".claude.json"), "utf8"),
  );
  assert.equal(isolatedClaudeConfig.hasCompletedOnboarding, true);
  assert.equal(fs.statSync(path.join(claudeHome, ".claude.json")).mode & 0o777, 0o600);
  const isolatedClaudeSettings = JSON.parse(
    fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8"),
  );
  assert.equal(isolatedClaudeSettings.skipDangerousModePermissionPrompt, true);
  assert.equal(isolatedClaudeSettings.theme, "dark-ansi");
  assert.equal(fs.statSync(path.join(claudeHome, "settings.json")).mode & 0o777, 0o600);
});

test("Claude isolated profile preserves a theme selected after its first launch", (t) => {
  const { client, homeDir } = makeFixture(t, () => json({}));
  const claudeHome = path.join(homeDir, ".cockpit", "claude");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ theme: "light-ansi" }));

  client.enrichPtyEnv({});

  const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8"));
  assert.equal(settings.theme, "light-ansi");
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
});

test("connect exchanges JWT for a device token and persists only the minimum with mode 0600", async (t) => {
  const { client, calls, homeDir } = makeFixture(t, ({ url, init, body }) => {
    if (url.pathname === "/api/login") {
      assert.deepEqual(body, { email: "dev@example.test", password: "password-that-must-not-be-saved" });
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, undefined);
      return json({ access_token: "short-lived-jwt" });
    }
    assert.equal(url.pathname, "/api/cockpit-ai/device-tokens");
    assert.equal(init.headers.Authorization, "Bearer short-lived-jwt");
    assert.equal(body.name, "Teste Cockpit");
    return json({ token: "device-secret", token_type: "Bearer" });
  });

  const status = await connect(client);
  assert.deepEqual(status, {
    connected: true,
    baseUrl: "http://127.0.0.1:8000",
    selected: {},
  });
  assert.equal(calls.length, 2);

  const configFile = path.join(homeDir, ".cockpit", "team-auth.json");
  const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.deepEqual(stored, {
    baseUrl: "http://127.0.0.1:8000",
    deviceToken: "device-secret",
  });
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /password-that|short-lived-jwt|dev@example/);
  assert.doesNotMatch(JSON.stringify(client.status()), /device-secret/);
});

test("selection keeps secrets in memory, writes an isolated Codex auth and enriches PTY env", async (t) => {
  const { client, homeDir } = makeFixture(t, ({ url, body }) => {
    if (url.pathname === "/api/login") return json({ access_token: "jwt" });
    if (url.pathname === "/api/cockpit-ai/device-tokens") return json({ token: "device" });
    if (url.pathname === "/api/cockpit-ai/select" && body.provider === "openai") {
      return json(openAiSelection());
    }
    if (url.pathname === "/api/cockpit-ai/select" && body.provider === "claude") {
      return json(claudeSelection());
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  fs.mkdirSync(path.join(homeDir, ".codex", "skills"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".codex", "themes"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".codex", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "model = \"gpt-5\"\n", { mode: 0o600 });
  fs.writeFileSync(path.join(homeDir, ".codex", "themes", "devnx.tmTheme"), "<plist />\n");
  await connect(client);

  const openai = await client.selectBest("codex");
  assert.equal(openai.account.id, OPENAI_ACCOUNT);
  assert.equal(openai.clientType, "codex_oauth");
  assert.doesNotMatch(JSON.stringify(openai), /access-one|id-one|cockpit:/);
  await client.selectAccount("claude", CLAUDE_ACCOUNT);
  const claudeProjectPath = path.join(homeDir, "project");
  fs.mkdirSync(claudeProjectPath);

  const materialized = client.materializeCodexAuth();
  const auth = JSON.parse(fs.readFileSync(materialized.path, "utf8"));
  assert.match(
    materialized.path,
    new RegExp(`${path.join(homeDir, ".cockpit", "codex", "accounts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-f0-9]{32}/auth\\.json$`),
  );
  assert.equal(fs.statSync(materialized.path).mode & 0o777, 0o600);
  const isolatedHome = path.dirname(materialized.path);
  assert.equal(fs.readFileSync(path.join(isolatedHome, "config.toml"), "utf8"), "model = \"gpt-5\"\n");
  assert.equal(fs.statSync(path.join(isolatedHome, "config.toml")).mode & 0o777, 0o600);
  if (process.platform !== "win32") {
    assert.equal(fs.realpathSync(path.join(isolatedHome, "skills")), path.join(homeDir, ".codex", "skills"));
    assert.equal(fs.realpathSync(path.join(isolatedHome, "themes")), path.join(homeDir, ".codex", "themes"));
  }
  assert.equal(fs.existsSync(path.join(isolatedHome, "sessions")), false);
  assert.equal(auth.tokens.access_token, "access-one");
  assert.match(auth.tokens.refresh_token, new RegExp(`^cockpit:${OPENAI_ACCOUNT}:[A-Za-z0-9_-]{22}$`));
  assert.doesNotMatch(JSON.stringify(client.status()), /access-one|claude-secret|cockpit:/);

  const env = client.enrichPtyEnv({ TERM: "xterm-256color" }, {
    codexRefreshUrl: "http://127.0.0.1:47817/team/openai/oauth/token",
    claudeProjectPath,
  });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "claude-secret-token");
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(homeDir, ".cockpit", "claude"));
  assert.equal(env.CODEX_HOME, path.dirname(materialized.path));
  assert.equal(env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, "http://127.0.0.1:47817/team/openai/oauth/token");
  const claudeConfig = JSON.parse(
    fs.readFileSync(path.join(homeDir, ".cockpit", "claude", ".claude.json"), "utf8"),
  );
  assert.deepEqual(claudeConfig.projects?.[claudeProjectPath], {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  });
  assert.throws(
    () => client.materializeCodexAuth(path.join(homeDir, ".cockpit", "auth.json")),
    (error) => error.code === "UNSAFE_CODEX_AUTH_PATH",
  );
  const rollout = path.join(isolatedHome, "sessions", "2026", "rollout.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, "persist me\n");
  client.cleanupRuntime();
  assert.equal(fs.existsSync(materialized.path), false);
  assert.equal(fs.readFileSync(rollout, "utf8"), "persist me\n");
});

test("Codex refresh capabilities remain valid after another account becomes current", async (t) => {
  const { client, calls } = makeFixture(t, ({ url, body }) => {
    if (url.pathname === "/api/login") return json({ access_token: "jwt" });
    if (url.pathname === "/api/cockpit-ai/device-tokens") return json({ token: "device" });
    if (url.pathname === "/api/cockpit-ai/select") {
      return json(body.account_id === OPENAI_ACCOUNT_B
        ? openAiSelection(OPENAI_ACCOUNT_B, "two")
        : openAiSelection());
    }
    if (url.pathname === `/api/cockpit-ai/accounts/${OPENAI_ACCOUNT}/refresh`) {
      return json(openAiSelection(OPENAI_ACCOUNT, "refreshed"));
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  await connect(client);
  await client.selectAccount("openai", OPENAI_ACCOUNT);
  const firstMaterialized = client.materializeCodexAuth();
  const firstAuth = JSON.parse(fs.readFileSync(firstMaterialized.path, "utf8"));
  const firstCapability = firstAuth.tokens.refresh_token;
  const firstEnv = client.enrichPtyEnv({}, {
    codexRefreshUrl: "http://localhost:47817/team/openai/oauth/token",
  });

  await client.selectAccount("openai", OPENAI_ACCOUNT_B);
  const secondMaterialized = client.materializeCodexAuth();
  const secondEnv = client.enrichPtyEnv({}, {
    codexRefreshUrl: "http://localhost:47817/team/openai/oauth/token",
  });
  assert.notEqual(firstMaterialized.path, secondMaterialized.path);
  assert.notEqual(firstEnv.CODEX_HOME, secondEnv.CODEX_HOME);
  assert.equal(JSON.parse(fs.readFileSync(firstMaterialized.path, "utf8")).tokens.access_token, "access-one");

  const tokenResponse = await client.handleOpenAiRefreshRequest({
    grant_type: "refresh_token",
    refresh_token: firstCapability,
    client_id: "public-codex-client",
  });

  assert.equal(tokenResponse.access_token, "access-refreshed");
  assert.equal(tokenResponse.refresh_token, firstCapability);
  assert.equal(tokenResponse.token_type, "Bearer");
  assert.ok(tokenResponse.expires_in >= 60);
  assert.equal(JSON.parse(fs.readFileSync(firstMaterialized.path, "utf8")).tokens.access_token, "access-refreshed");
  assert.equal(JSON.parse(fs.readFileSync(secondMaterialized.path, "utf8")).tokens.access_token, "access-two");
  assert.ok(calls.some((call) => new URL(call.url).pathname.endsWith(`/${OPENAI_ACCOUNT}/refresh`)));
  await assert.rejects(
    client.handleOpenAiRefreshRequest({
      grant_type: "refresh_token",
      refresh_token: `cockpit:${OPENAI_ACCOUNT}:guessed-capability`,
    }),
    (error) => error.code === "INVALID_OAUTH_CAPABILITY",
  );
});

test("account provider is sent as a real query string, never encoded into pathname", async (t) => {
  let observed;
  const { client } = makeFixture(t, ({ url }) => {
    if (url.pathname === "/api/login") return json({ access_token: "jwt" });
    if (url.pathname === "/api/cockpit-ai/device-tokens") return json({ token: "device" });
    observed = url;
    return json({ accounts: [{
      id: OPENAI_ACCOUNT,
      provider: "openai",
      label: "Principal",
      usage: {
        five_hour: { percent: null, resets_at: null },
        weekly: { percent: "", resets_at: null },
      },
    }] });
  });
  await connect(client);
  const accounts = await client.listAccounts("openai");
  assert.equal(observed.pathname, "/api/cockpit-ai/accounts");
  assert.equal(observed.searchParams.get("provider"), "openai");
  assert.equal(accounts[0].id, OPENAI_ACCOUNT);
  assert.equal(accounts[0].usage.five_hour.percent, null);
  assert.equal(accounts[0].usage.weekly.percent, null);
});

test("publishing local sessions uses strict allowlists and never sends API keys or mcpOAuth", async (t) => {
  const upserts = [];
  const { client, homeDir } = makeFixture(t, ({ url, body }) => {
    if (url.pathname === "/api/login") return json({ access_token: "jwt" });
    if (url.pathname === "/api/cockpit-ai/device-tokens") return json({ token: "device" });
    if (url.pathname === "/api/cockpit-ai/accounts/upsert") {
      upserts.push(body);
      return json({ account: { id: body.id || OPENAI_ACCOUNT, provider: body.provider, label: body.label } });
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  await connect(client);

  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: "2026-07-10T10:00:00Z",
    ignored_secret: "do-not-send",
    tokens: {
      access_token: "local-openai-access",
      id_token: jwt({ email: "openai@example.test" }),
      account_id: "chatgpt-account",
      refresh_token: "real-openai-refresh",
      extra_token: "do-not-send",
    },
  }));
  await client.publishCurrentOpenAi();

  const claudeDir = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: "local-claude-access",
      refreshToken: "local-claude-refresh",
      expiresAt: 1_900_000_000_000,
      scopes: ["user:inference"],
      subscriptionType: "pro",
      rateLimitTier: "pro",
      unexpectedSecret: "do-not-send",
    },
    mcpOAuth: {
      figma: { accessToken: "figma-access", clientSecret: "figma-client-secret" },
    },
  }));
  await client.publishCurrentClaudeOauth({ label: "Claude compartilhado" });

  assert.equal(upserts.length, 2);
  assert.deepEqual(Object.keys(upserts[0].credentials).sort(), [
    "access_token", "account_id", "auth_mode", "id_token", "last_refresh", "refresh_token",
  ]);
  assert.deepEqual(Object.keys(upserts[1].credentials).sort(), [
    "access_token", "expires_at", "rate_limit_tier", "refresh_token", "scopes", "subscription_type",
  ]);
  const sent = JSON.stringify(upserts);
  assert.doesNotMatch(sent, /do-not-send|figma-access|figma-client-secret|OPENAI_API_KEY/);
});

test("server errors are redacted and logout revokes best-effort before deleting local material", async (t) => {
  let failList = false;
  let revoked = false;
  const { client, homeDir } = makeFixture(t, ({ url }) => {
    if (url.pathname === "/api/login") return json({ access_token: "jwt" });
    if (url.pathname === "/api/cockpit-ai/device-tokens") return json({ token: "device-secret" });
    if (url.pathname === "/api/cockpit-ai/accounts" && failList) {
      return json({ message: "access_token=super-secret-value password=hunter2" }, 422);
    }
    if (url.pathname === "/api/cockpit-ai/select") return json(openAiSelection());
    if (url.pathname === "/api/cockpit-ai/device-token") {
      revoked = true;
      return json({ message: "revoked" });
    }
    return json({ accounts: [] });
  });
  await connect(client);
  await client.selectBest("openai");
  const authPath = client.materializeCodexAuth().path;
  failList = true;
  await assert.rejects(client.listAccounts(), (error) => {
    assert.doesNotMatch(error.message, /super-secret-value|hunter2/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });

  const status = await client.logout();
  assert.equal(revoked, true);
  assert.deepEqual(status, { connected: false, baseUrl: null, selected: {} });
  assert.equal(fs.existsSync(path.join(homeDir, ".cockpit", "team-auth.json")), false);
  assert.equal(fs.existsSync(authPath), false);
});
