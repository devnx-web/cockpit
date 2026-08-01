import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageDb } from "../lib/usage/db.js";
import { PriceBook, PriceUpdater, costOfEvent, normalizeLitellm } from "../lib/usage/prices.js";
import { fallbackPriceFor } from "../lib/usage/prices-fallback.js";

const LITELLM_SAMPLE = {
  "claude-opus-5": {
    litellm_provider: "anthropic",
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 0.5e-6,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 10e-6,
  },
  "claude-haiku-4-5": {
    litellm_provider: "anthropic",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 0.1e-6,
    cache_creation_input_token_cost: 1.25e-6,
    cache_creation_input_token_cost_above_1hr: 2e-6,
  },
  "gpt-5.5": {
    litellm_provider: "openai",
    input_cost_per_token: 5e-6,
    output_cost_per_token: 30e-6,
    cache_read_input_token_cost: 0.5e-6,
  },
  "bedrock/claude-opus-5": { litellm_provider: "bedrock", input_cost_per_token: 9e-6 },
  "gemini-3-pro": { litellm_provider: "vertex_ai", input_cost_per_token: 1e-6 },
  "text-embedding-3-small": { litellm_provider: "openai", input_cost_per_token: 2e-8 },
  quebrado: null,
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-prices-"));
}

function fakeResponse({ status = 200, body = LITELLM_SAMPLE, etag = 'W/"v1"' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "etag" ? etag : null) },
    json: async () => body,
  };
}

test("prices: normaliza só os providers que rodam no Cockpit", () => {
  const rows = normalizeLitellm(LITELLM_SAMPLE);
  const models = rows.map((r) => r.model).sort();
  assert.deepEqual(models, ["claude-haiku-4-5", "claude-opus-5", "gpt-5.5", "text-embedding-3-small"]);
  const opus = rows.find((r) => r.model === "claude-opus-5");
  assert.equal(opus.cache_write_1h_cost, 10e-6);
  const gpt = rows.find((r) => r.model === "gpt-5.5");
  assert.equal(gpt.cache_write_5m_cost, null, "OpenAI não cobra escrita em cache");
});

test("prices: custo soma os cinco buckets e ignora reasoning", () => {
  const price = normalizeLitellm(LITELLM_SAMPLE).find((r) => r.model === "claude-opus-5");
  const event = {
    input_tokens: 1_000_000,
    cache_read_tokens: 1_000_000,
    cache_write_5m_tokens: 1_000_000,
    cache_write_1h_tokens: 1_000_000,
    output_tokens: 1_000_000,
    reasoning_tokens: 900_000,
  };
  // 5 + 0,5 + 6,25 + 10 + 25 = 46,75 USD
  assert.equal(Number(costOfEvent(event, price).toFixed(6)), 46.75);

  const semReasoning = { ...event, reasoning_tokens: 0 };
  assert.equal(
    costOfEvent(event, price),
    costOfEvent(semReasoning, price),
    "reasoning é subconjunto de output — contá-lo cobraria duas vezes",
  );
});

test("prices: sem preço o custo é null, nunca zero", () => {
  assert.equal(costOfEvent({ input_tokens: 10 }, null), null);
  assert.equal(costOfEvent({ input_tokens: 10 }, { input_cost: null, output_cost: 1e-6 }), null);
});

test("prices: resolução por nome exato, sufixo de data e família", () => {
  const book = new PriceBook().setPrices(normalizeLitellm(LITELLM_SAMPLE));

  assert.equal(book.resolve("claude-opus-5").input_cost, 5e-6, "nome exato");
  assert.equal(
    book.resolve("claude-haiku-4-5-20251001").input_cost,
    1e-6,
    "sufixo de data cai no nome base",
  );

  // gpt-5.3-codex-spark não existe na tabela do LiteLLM hoje.
  const spark = book.resolve("gpt-5.3-codex-spark");
  assert.equal(spark.source, "fallback");
  assert.equal(Number((spark.input_cost * 1e6).toFixed(6)), 1.75, "casou com a família codex");

  assert.equal(book.resolve("modelo-que-nao-existe"), null);
  assert.equal(book.resolve(""), null);
});

test("prices: fallback cobre todos os modelos vistos nesta base", () => {
  const vistos = [
    "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5",
    "claude-haiku-4-5-20251001",
    "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini",
    "gpt-5.3-codex-spark", "gpt-5.2-codex",
  ];
  for (const model of vistos) {
    assert.ok(fallbackPriceFor(model), `sem fallback para ${model}`);
  }
  assert.equal(fallbackPriceFor("unknown"), null);
  assert.equal(fallbackPriceFor(null), null);
});

test("prices: fallback é mais específico antes de mais genérico", () => {
  // Comparado por milhão de tokens, que é como o preço é cotado.
  const porMilhao = (model) => Number((fallbackPriceFor(model).input_cost * 1e6).toFixed(6));

  assert.equal(porMilhao("gpt-5.4-nano"), 0.2);
  assert.equal(porMilhao("gpt-5.4-mini"), 0.75);
  assert.equal(porMilhao("gpt-5.2-codex"), 1.75);
  assert.equal(porMilhao("gpt-5.5"), 5, "nenhum padrão específico casou antes");
  assert.equal(porMilhao("claude-fable-5"), 10, "fable não pode virar opus");
  assert.equal(porMilhao("claude-opus-4-8"), 5);
});

test("prices: priceEvent marca a origem do preço", () => {
  const book = new PriceBook().setPrices(normalizeLitellm(LITELLM_SAMPLE));
  book.rev = 42;

  const litellm = book.priceEvent({ model: "claude-opus-5", input_tokens: 1_000_000 });
  assert.equal(Number(litellm.cost_usd.toFixed(6)), 5);
  assert.equal(litellm.price_source, "litellm");
  assert.equal(litellm.price_rev, 42);

  const fb = book.priceEvent({ model: "gpt-5.3-codex-spark", input_tokens: 1_000_000 });
  assert.equal(fb.price_source, "fallback");

  const nada = book.priceEvent({ model: "coisa-nenhuma", input_tokens: 1_000_000 });
  assert.deepEqual(nada, { cost_usd: null, price_source: "unknown", price_rev: 42 });
});

test("prices: updater busca, persiste no banco e cacheia em disco", async () => {
  const dir = tempDir();
  const db = new UsageDb({ dbPath: path.join(dir, "usage.db") }).open();
  try {
    const cachePath = path.join(dir, "cache", "model_prices.json");
    let chamadas = 0;
    const updater = new PriceUpdater({
      db,
      cachePath,
      fetchImpl: async () => { chamadas += 1; return fakeResponse(); },
      now: () => 1_000_000_000_000,
    });

    const primeira = await updater.refresh();
    assert.equal(primeira.status, "fresh");
    assert.equal(primeira.count, 4);
    assert.equal(chamadas, 1);
    assert.ok(fs.existsSync(cachePath));

    const book = new PriceBook({ db });
    assert.equal(book.resolve("claude-opus-5").input_cost, 5e-6);
    assert.equal(book.resolve("claude-opus-5").source, "litellm");

    // Dentro do TTL não toca na rede.
    const segunda = await updater.refresh();
    assert.equal(segunda.status, "cached");
    assert.equal(chamadas, 1, "TTL de 24h respeitado");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prices: 304 mantém o cache e renova o TTL", async () => {
  const dir = tempDir();
  try {
    const cachePath = path.join(dir, "model_prices.json");
    let agora = 1_000_000_000_000;
    const enviados = [];
    const updater = new PriceUpdater({
      cachePath,
      fetchImpl: async (_url, init) => {
        enviados.push(init?.headers?.["if-none-match"] ?? null);
        return enviados.length === 1 ? fakeResponse() : fakeResponse({ status: 304 });
      },
      now: () => agora,
    });

    await updater.refresh();
    agora += 25 * 60 * 60 * 1000; // TTL vencido
    const r = await updater.refresh();

    assert.equal(r.status, "not-modified");
    assert.equal(r.count, 4, "o cache continua utilizável");
    assert.deepEqual(enviados, [null, 'W/"v1"'], "o ETag é reenviado");

    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(cache.fetched_at, agora, "TTL renovado sem baixar de novo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prices: sem rede usa o cache; sem cache admite o fallback", async () => {
  const dir = tempDir();
  try {
    const cachePath = path.join(dir, "model_prices.json");
    const semRede = new PriceUpdater({
      cachePath,
      fetchImpl: async () => { throw new Error("ENOTFOUND"); },
    });

    const primeiro = await semRede.refresh();
    assert.equal(primeiro.status, "fallback");
    assert.equal(primeiro.count, 0);
    assert.match(primeiro.error, /ENOTFOUND/);

    // Com cache em disco a queda de rede é transparente.
    fs.writeFileSync(cachePath, JSON.stringify({ fetched_at: 0, etag: null, data: LITELLM_SAMPLE }));
    const segundo = await semRede.refresh();
    assert.equal(segundo.status, "offline");
    assert.equal(segundo.count, 4);

    const http500 = new PriceUpdater({ cachePath, fetchImpl: async () => fakeResponse({ status: 500 }) });
    assert.equal((await http500.refresh()).status, "offline");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prices: alias do banco tem prioridade sobre tudo", () => {
  const dir = tempDir();
  const db = new UsageDb({ dbPath: path.join(dir, "usage.db") }).open();
  try {
    db.savePrices(normalizeLitellm(LITELLM_SAMPLE), { source: "litellm", rev: 7 });
    db.raw.prepare("INSERT INTO model_alias (raw, model, note) VALUES (?, ?, ?)")
      .run("gpt-5.3-codex-spark", "gpt-5.5", "apontado à mão até entrar no LiteLLM");

    const book = new PriceBook({ db });
    assert.equal(book.rev, 7);
    const price = book.resolve("gpt-5.3-codex-spark");
    assert.equal(price.input_cost, 5e-6, "o alias venceu o fallback de família");
    assert.equal(price.source, "litellm");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
