import assert from "node:assert/strict";
import test from "node:test";

import { isClaudeCandidate, parseClaudeLine } from "../lib/usage/parse-claude.js";
import { createCodexCursor, isCodexCandidate, parseCodexLine } from "../lib/usage/parse-codex.js";

function claudeLine({ requestId = "req_1", messageId = "msg_1", model = "claude-opus-4-8", usage, ts = "2026-07-27T14:05:00.000Z" }) {
  return JSON.stringify({
    type: "assistant",
    requestId,
    timestamp: ts,
    sessionId: "sess-1",
    cwd: "/home/ftgk/cockpit",
    isSidechain: false,
    message: { id: messageId, model, usage },
  });
}

const BASE_USAGE = {
  input_tokens: 12,
  cache_creation_input_tokens: 1000,
  cache_read_tokens: 0,
  cache_read_input_tokens: 500,
  output_tokens: 40,
  cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
};

test("claude: linhas repetidas do mesmo message.id colapsam em uma requisição", () => {
  // O CLI grava uma linha por content block (thinking, text, tool_use) com usage idêntico.
  const lines = ["thinking", "text", "tool_use"].map(() => claudeLine({ usage: BASE_USAGE }));
  const keys = new Set(lines.map((line) => parseClaudeLine(line).event_key));
  assert.equal(keys.size, 1, "as três linhas precisam gerar a mesma chave de dedup");
  assert.equal([...keys][0], "c|req_1|msg_1");
});

test("claude: requests distintos geram chaves distintas", () => {
  const a = parseClaudeLine(claudeLine({ requestId: "req_1", messageId: "msg_1", usage: BASE_USAGE }));
  const b = parseClaudeLine(claudeLine({ requestId: "req_2", messageId: "msg_2", usage: BASE_USAGE }));
  assert.notEqual(a.event_key, b.event_key);
});

test("claude: cache creation é separado em 5m e 1h", () => {
  const event = parseClaudeLine(claudeLine({ usage: BASE_USAGE }));
  assert.equal(event.cache_write_5m_tokens, 400);
  assert.equal(event.cache_write_1h_tokens, 600);
  assert.equal(event.cache_read_tokens, 500);
  assert.equal(event.input_tokens, 12);
  assert.equal(event.output_tokens, 40);
});

test("claude: sem o detalhamento de cache_creation, tudo vai para o bucket de 5m", () => {
  const usage = { input_tokens: 1, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 2 };
  const event = parseClaudeLine(claudeLine({ usage }));
  assert.equal(event.cache_write_5m_tokens, 900);
  assert.equal(event.cache_write_1h_tokens, 0);
});

test("claude: <synthetic> e linhas não faturáveis são descartadas", () => {
  assert.equal(parseClaudeLine(claudeLine({ model: "<synthetic>", usage: BASE_USAGE })), null);
  assert.equal(parseClaudeLine(JSON.stringify({ type: "user", message: { content: "oi" } })), null);
  assert.equal(parseClaudeLine(JSON.stringify({ type: "last-prompt", leafUuid: "x" })), null);
  assert.equal(parseClaudeLine("{ isso não é json"), null);
});

test("claude: requisição sem requestId ainda deduplica pelo message.id", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-27T14:05:00.000Z",
    message: { id: "msg_9", model: "claude-sonnet-5", usage: BASE_USAGE },
  });
  assert.equal(parseClaudeLine(line).event_key, "c|-|msg_9");
});

test("claude: prefiltro aceita linhas faturáveis e rejeita o resto", () => {
  assert.ok(isClaudeCandidate(claudeLine({ usage: BASE_USAGE })));
  assert.ok(!isClaudeCandidate(JSON.stringify({ type: "user", message: { content: "oi" } })));
});

// ------------------------------------------------------------------ codex

function codexTokenCount({ total, last, ts = "2026-07-27T14:05:00.000Z" }) {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });
}

function usage(input, cached, output, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

const SESSION_META = JSON.stringify({
  timestamp: "2026-07-27T14:00:00.000Z",
  type: "session_meta",
  payload: { id: "roll-1", cwd: "/home/ftgk/cockpit", cli_version: "0.139.0" },
});

test("codex: sessão nova conta o primeiro turno e depois só os deltas", () => {
  const cursor = createCodexCursor();
  parseCodexLine(SESSION_META, cursor);
  parseCodexLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }), cursor);

  const first = parseCodexLine(codexTokenCount({ total: usage(100, 20, 10), last: usage(100, 20, 10) }), cursor);
  assert.ok(first, "o primeiro turno de uma sessão nova precisa ser contado");
  assert.equal(first.input_tokens, 80, "input faturável exclui o que veio do cache");
  assert.equal(first.cache_read_tokens, 20);
  assert.equal(first.output_tokens, 10);
  assert.equal(first.model, "gpt-5.5");

  const second = parseCodexLine(codexTokenCount({ total: usage(250, 50, 30), last: usage(150, 30, 20) }), cursor);
  assert.equal(second.input_tokens, 120, "delta de input (150) menos delta de cache (30)");
  assert.equal(second.cache_read_tokens, 30);
  assert.equal(second.output_tokens, 20);
});

test("codex: sessão retomada não recontabiliza o histórico herdado", () => {
  const cursor = createCodexCursor();
  parseCodexLine(SESSION_META, cursor);

  // total >> last: o CLI replicou o histórico do rollout anterior, que já foi cobrado lá.
  const replay = parseCodexLine(
    codexTokenCount({ total: usage(1_000_000, 900_000, 5_000), last: usage(200, 50, 10) }),
    cursor,
  );
  assert.equal(replay, null, "o total herdado não pode virar um evento");

  const real = parseCodexLine(
    codexTokenCount({ total: usage(1_000_300, 900_100, 5_040), last: usage(300, 100, 40) }),
    cursor,
  );
  assert.ok(real);
  assert.equal(real.input_tokens, 200, "delta de input (300) menos delta de cache (100)");
  assert.equal(real.output_tokens, 40);
});

test("codex: somar last_token_usage inflaria o total — o delta é a fonte", () => {
  const cursor = createCodexCursor();
  parseCodexLine(SESSION_META, cursor);
  const records = [
    { total: usage(100, 0, 10), last: usage(100, 0, 10) },
    { total: usage(300, 0, 25), last: usage(200, 0, 15) },
    { total: usage(300, 0, 25), last: usage(200, 0, 15) }, // replay: total congelado
    { total: usage(500, 0, 40), last: usage(200, 0, 15) },
  ];
  const events = records
    .map((r) => parseCodexLine(codexTokenCount(r), cursor))
    .filter(Boolean);

  const somaDeltas = events.reduce((acc, e) => acc + e.input_tokens + e.output_tokens, 0);
  const somaLast = records.reduce((acc, r) => acc + r.last.total_tokens, 0);

  assert.equal(events.length, 3, "o replay não gera evento");
  assert.equal(somaDeltas, 540, "500 de input + 40 de output = o total real acumulado");
  assert.ok(somaLast > somaDeltas, "somar last superestima — é exatamente o bug que evitamos");
});

test("codex: modelo muda no meio da sessão e cada evento leva o seu", () => {
  const cursor = createCodexCursor();
  parseCodexLine(SESSION_META, cursor);
  parseCodexLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }), cursor);
  const a = parseCodexLine(codexTokenCount({ total: usage(100, 0, 10), last: usage(100, 0, 10) }), cursor);
  parseCodexLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }), cursor);
  const b = parseCodexLine(codexTokenCount({ total: usage(200, 0, 20), last: usage(100, 0, 10) }), cursor);

  assert.equal(a.model, "gpt-5.5");
  assert.equal(b.model, "gpt-5.6-sol");
});

test("codex: info nulo, delta zero e linhas inválidas não geram eventos", () => {
  const cursor = createCodexCursor();
  parseCodexLine(SESSION_META, cursor);
  assert.equal(
    parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }), cursor),
    null,
  );
  parseCodexLine(codexTokenCount({ total: usage(100, 0, 10), last: usage(100, 0, 10) }), cursor);
  assert.equal(
    parseCodexLine(codexTokenCount({ total: usage(100, 0, 10), last: usage(100, 0, 10) }), cursor),
    null,
    "total inalterado = nada novo",
  );
  assert.equal(parseCodexLine("{quebrado", cursor), null);
});

test("codex: a chave de dedup usa o total acumulado, que é estritamente crescente", () => {
  const cursor = createCodexCursor();
  parseCodexLine(SESSION_META, cursor);
  const a = parseCodexLine(codexTokenCount({ total: usage(100, 0, 10), last: usage(100, 0, 10) }), cursor);
  const b = parseCodexLine(codexTokenCount({ total: usage(200, 0, 20), last: usage(100, 0, 10) }), cursor);
  assert.equal(a.event_key, "x|roll-1|110");
  assert.equal(b.event_key, "x|roll-1|220");
});

test("codex: prefiltro aceita as três linhas de interesse", () => {
  assert.ok(isCodexCandidate(SESSION_META));
  assert.ok(isCodexCandidate(codexTokenCount({ total: usage(1, 0, 1), last: usage(1, 0, 1) })));
  assert.ok(isCodexCandidate(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } })));
  assert.ok(!isCodexCandidate(JSON.stringify({ type: "response_item", payload: { text: "oi" } })));
});
