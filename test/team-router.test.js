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

test("bootstrap materializes OpenAI before PTY environment enrichment", async () => {
  let materialized = false;
  const router = createTeamRouter({
    client: fakeClient({
      materializeCodexAuth: async () => { materialized = true; },
    }),
    brokerUrl: () => BROKER_URL,
  });

  const result = await router.bootstrap();
  assert.equal(result.selections.length, 2);
  assert.equal(materialized, true);
  assert.equal(
    router.enrichPtyEnv({ TERM: "xterm" }).CODEX_REFRESH_TOKEN_URL_OVERRIDE,
    `${BROKER_URL}/team/openai/oauth/token`,
  );
});
