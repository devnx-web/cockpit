import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createTeamRouter } from "../lib/team-router.js";

const BROKER_URL = "http://127.0.0.1:47817";

function request(method = "GET", body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = method;
  stream.headers = {
    host: "127.0.0.1:47817",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  };
  return stream;
}

function fakeClient(overrides = {}) {
  return {
    status: () => ({
      connected: true,
      baseUrl: "https://control.example",
      selected: { openai: { id: "openai-1", label: "Principal", access_token: "never" } },
    }),
    listAccounts: async () => [{
      id: "openai-1",
      provider: "openai",
      label: "Principal",
      status: "available",
      credentials: { refresh_token: "never" },
      client: { access_token: "never" },
      usage: {
        five_hour: { percent: 12, resets_at: "2026-07-10T12:00:00Z" },
        weekly: { percent: 35, resets_at: "2026-07-14T12:00:00Z" },
      },
    }],
    selectBest: async (provider) => ({
      account: { id: `${provider}-1`, provider, label: provider, status: "available" },
      clientType: provider === "openai" ? "codex_oauth" : "claude_setup_token",
    }),
    materializeCodexAuth: async () => ({ path: "/tmp/broker/auth.json" }),
    materializeGeminiSession: () => ({ path: "/tmp/broker/gemini/token" }),
    enrichPtyEnv: (env, { codexRefreshUrl }) => ({ ...env, CODEX_REFRESH_TOKEN_URL_OVERRIDE: codexRefreshUrl }),
    ...overrides,
  };
}

test("router exposes only allowlisted account metadata and marks the selected account", async () => {
  const router = createTeamRouter({ client: fakeClient(), brokerUrl: () => BROKER_URL });
  const accounts = await router.accounts();

  assert.equal(accounts[0].selected, true);
  assert.equal(accounts[0].usage.five_hour.percent, 12);
  assert.equal("credentials" in accounts[0], false);
  assert.equal("client" in accounts[0], false);
  assert.doesNotMatch(JSON.stringify(accounts), /never|refresh_token|access_token/);
});

test("sensitive Codex refresh rejects browser origins before invoking the client", async () => {
  let invoked = false;
  const router = createTeamRouter({
    client: fakeClient({
      handleOpenAiRefreshRequest: async () => {
        invoked = true;
        return { access_token: "short-lived" };
      },
    }),
    brokerUrl: () => BROKER_URL,
  });

  await assert.rejects(
    router.dispatch(
      request("POST", { grant_type: "refresh_token", refresh_token: "cap" }, { origin: BROKER_URL }),
      { pathname: "/team/openai/oauth/token" },
    ),
    (error) => error.statusCode === 403,
  );
  assert.equal(invoked, false);
});

test("bootstrap materializes Codex auth before PTY environment enrichment", async () => {
  let codexMaterialized = false;
  const router = createTeamRouter({
    client: fakeClient({
      materializeCodexAuth: async () => { codexMaterialized = true; },
    }),
    brokerUrl: () => BROKER_URL,
  });

  const result = await router.bootstrap();
  assert.equal(result.selections.length, 3);
  assert.equal(codexMaterialized, true);
  assert.equal(
    router.enrichPtyEnv({ TERM: "xterm" }).CODEX_REFRESH_TOKEN_URL_OVERRIDE,
    `${BROKER_URL}/team/openai/oauth/token`,
  );
});

test("stale PTY selections are refreshed once and concurrent refreshes are deduplicated", async () => {
  const selected = {};
  let selections = 0;
  let materializations = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = fakeClient({
    status: () => ({
      connected: true,
      baseUrl: "https://control.example",
      selected,
    }),
    selectBest: async (provider) => {
      selections += 1;
      await gate;
      const account = { id: `${provider}-fresh`, provider, label: `${provider} fresh` };
      selected[provider] = account;
      return { account };
    },
    materializeCodexAuth: async () => { materializations += 1; },
  });
  const router = createTeamRouter({ client, brokerUrl: () => BROKER_URL });

  const first = router.refreshSelectionsIfStale();
  const second = router.refreshSelectionsIfStale();
  release();
  await Promise.all([first, second]);

  assert.equal(selections, 3);
  const cached = await router.refreshSelectionsIfStale();
  assert.equal(cached.cached, true);
  assert.equal(selections, 3);
  assert.equal(materializations, 2);
});

test("maxAgeMs zero forces a fresh backend selection for every terminal", async () => {
  const selected = {};
  let selections = 0;
  const client = fakeClient({
    status: () => ({
      connected: true,
      baseUrl: "https://control.example",
      selected,
    }),
    selectBest: async (provider) => {
      selections += 1;
      const account = { id: `${provider}-${selections}`, provider, label: provider };
      selected[provider] = account;
      return { account };
    },
  });
  const router = createTeamRouter({ client, brokerUrl: () => BROKER_URL });

  await router.refreshSelectionsIfStale({ maxAgeMs: 0, retryMissingProviders: 0 });
  await router.refreshSelectionsIfStale({ maxAgeMs: 0, retryMissingProviders: 0 });

  assert.equal(selections, 6);
});

test("PTY preparation retries a transient missing provider selection", async () => {
  const selected = {};
  let openAiAttempts = 0;
  const client = fakeClient({
    status: () => ({
      connected: true,
      baseUrl: "https://control.example",
      selected,
    }),
    selectBest: async (provider) => {
      if (provider === "openai" && ++openAiAttempts === 1) {
        throw new Error("temporary selection failure");
      }
      const account = { id: `${provider}-fresh`, provider, label: `${provider} fresh` };
      selected[provider] = account;
      return { account };
    },
  });
  const router = createTeamRouter({ client, brokerUrl: () => BROKER_URL });

  const result = await router.refreshSelectionsIfStale();

  assert.equal(openAiAttempts, 2);
  assert.equal(result.selections.some((item) => item.provider === "openai"), true);
  assert.equal(Boolean(router.status().selected.openai), true);
});

test("manual optimize synchronizes usage before replacing provider selections", async () => {
  const events = [];
  const router = createTeamRouter({
    client: fakeClient({
      syncUsage: async () => { events.push("usage"); return []; },
      selectBest: async (provider) => {
        events.push(`select:${provider}`);
        return { account: { id: `${provider}-1`, provider, label: provider } };
      },
    }),
    brokerUrl: () => BROKER_URL,
  });

  await router.dispatch(request("POST", {}), { pathname: "/team/optimize" });

  assert.equal(events[0], "usage");
  assert.deepEqual(new Set(events.slice(1)), new Set(["select:openai", "select:claude", "select:gemini"]));
});

// O Gemini é opcional: uma frota sem conta Google livre não pode ficar sem
// terminal nem refazer o bootstrap a cada PTY por causa dele.
test("uma seleção Google indisponível não invalida o cache das seleções obrigatórias", async () => {
  const selected = {};
  let selections = 0;
  const client = fakeClient({
    status: () => ({ connected: true, baseUrl: "https://control.example", selected }),
    selectBest: async (provider) => {
      selections += 1;
      if (provider === "gemini") throw new Error("nenhuma conta Google disponível");
      const account = { id: `${provider}-fresh`, provider, label: provider };
      selected[provider] = account;
      return { account };
    },
  });
  const router = createTeamRouter({ client, brokerUrl: () => BROKER_URL });

  const first = await router.refreshSelectionsIfStale({ retryMissingProviders: 0 });
  assert.equal(first.selections.length, 2);
  assert.equal(selections, 3);

  const cached = await router.refreshSelectionsIfStale({ retryMissingProviders: 0 });
  assert.equal(cached.cached, true);
  assert.equal(selections, 3);
});

function collectResponse() {
  return {
    statusCode: null,
    headers: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end() { this.ended = true; },
  };
}

test("o sufixo /anthropic existe só para o cliente e não chega ao broker", async () => {
  const seen = [];
  const client = fakeClient({
    handleClaudeProxyRequest: async ({ requestPath }) => {
      seen.push(requestPath);
      return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: null };
    },
  });
  const router = createTeamRouter({ client, brokerUrl: () => BROKER_URL });

  for (const pathname of ["/team/claude/anthropic/v1/messages", "/team/claude/v1/messages"]) {
    const res = collectResponse();
    await router.proxyClaude(request("POST", { model: "x" }), res, { pathname, search: "?beta=true" });
    assert.equal(res.statusCode, 200);
  }

  // Os dois caminhos convergem: o Hermes/LifeAi precisa da base_url terminando
  // em /anthropic, o broker continua vendo /v1/... como sempre viu.
  assert.deepEqual(seen, ["/v1/messages?beta=true", "/v1/messages?beta=true"]);
});

test("credenciais para consumidor externo apontam para o sufixo aceito pelo cliente", () => {
  let label = null;
  const router = createTeamRouter({
    client: fakeClient({
      issueClaudeCapability: (received) => { label = received; return "cc-cockpit-fake"; },
    }),
    brokerUrl: () => BROKER_URL,
  });

  assert.deepEqual(router.issueClaudeAccess("lifeai"), {
    baseUrl: `${BROKER_URL}/team/claude/anthropic`,
    capability: "cc-cockpit-fake",
  });
  assert.equal(label, "lifeai");
  assert.equal(createTeamRouter({ client: fakeClient(), brokerUrl: () => null }).issueClaudeAccess("lifeai"), null);
});
