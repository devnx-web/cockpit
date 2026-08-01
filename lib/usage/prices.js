/**
 * Tabela de preços dos modelos.
 *
 * Fonte primária: `model_prices_and_context_window.json` do LiteLLM — a mesma que o
 * ccusage usa, atualizada pela comunidade poucas horas depois de cada anúncio de preço.
 * Buscada 1×/24 h com `If-None-Match`, cacheada em disco e persistida em `model_prices`.
 * Sem rede, cai no cache; sem cache, cai no fallback embutido por família.
 *
 * Regra que não se negocia: **modelo sem preço conhecido produz `cost_usd = null`**,
 * nunca 0. Um zero silencioso vira "esse projeto não custou nada" no dashboard, que é
 * pior do que admitir que não sabemos.
 */

import fs from "fs";
import path from "path";

import { fallbackPriceFor } from "./prices-fallback.js";

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const PRICE_TTL_MS = 24 * 60 * 60 * 1000;

/** Só nos interessam os providers que rodam dentro do Cockpit. */
const KEEP_PROVIDERS = new Set(["anthropic", "openai"]);

/** Sufixo de data que a Anthropic acopla ao nome: `claude-haiku-4-5-20251001`. */
const DATE_SUFFIX = /-\d{8}$/;

function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Converte o JSON do LiteLLM na forma que guardamos em `model_prices`.
 * Descarta entradas com prefixo de provider (`bedrock/…`, `vertex_ai/…`) porque os
 * CLIs gravam o nome puro do modelo.
 */
export function normalizeLitellm(json) {
  if (!json || typeof json !== "object") return [];
  const rows = [];
  for (const [model, entry] of Object.entries(json)) {
    if (!entry || typeof entry !== "object") continue;
    if (model.includes("/")) continue;
    if (!KEEP_PROVIDERS.has(entry.litellm_provider)) continue;
    const input = num(entry.input_cost_per_token);
    const output = num(entry.output_cost_per_token);
    if (input === null && output === null) continue;
    rows.push({
      model,
      provider: entry.litellm_provider,
      input_cost: input,
      output_cost: output,
      cache_read_cost: num(entry.cache_read_input_token_cost),
      cache_write_5m_cost: num(entry.cache_creation_input_token_cost),
      cache_write_1h_cost: num(entry.cache_creation_input_token_cost_above_1hr),
    });
  }
  return rows;
}

/**
 * Custo de um evento. `reasoning_tokens` NÃO entra: é subconjunto de `output_tokens`
 * e somá-lo cobraria os tokens de raciocínio duas vezes.
 *
 * @returns {number|null} null quando não há preço para o modelo.
 */
export function costOfEvent(event, price) {
  if (!price) return null;
  const input = price.input_cost;
  const output = price.output_cost;
  if (input === null || input === undefined || output === null || output === undefined) return null;

  // Cache read sem preço próprio cai no preço de input (é o pior caso, nunca subestima).
  const cacheRead = price.cache_read_cost ?? input;
  const write5m = price.cache_write_5m_cost ?? 0;
  const write1h = price.cache_write_1h_cost ?? 0;

  return (event.input_tokens || 0) * input
    + (event.cache_read_tokens || 0) * cacheRead
    + (event.cache_write_5m_tokens || 0) * write5m
    + (event.cache_write_1h_tokens || 0) * write1h
    + (event.output_tokens || 0) * output;
}

/**
 * Resolve nome de modelo → preços, com memo. Uma instância por ciclo de ingestão;
 * `reload()` depois de atualizar a tabela.
 */
export class PriceBook {
  #prices = new Map();
  #aliases = new Map();
  #memo = new Map();

  constructor({ db, rev = 0 } = {}) {
    this.db = db ?? null;
    this.rev = rev;
    if (this.db) this.reload();
  }

  reload() {
    const { prices, aliases } = this.db.loadPrices();
    this.#prices = prices;
    this.#aliases = aliases;
    this.#memo.clear();
    const revs = [...prices.values()].map((row) => row.rev ?? 0);
    this.rev = revs.length ? Math.max(...revs) : 0;
    return this;
  }

  /** Injeção direta, para testes e para o modo sem banco. */
  setPrices(rows) {
    this.#prices = new Map(rows.map((row) => [row.model, row]));
    this.#memo.clear();
    return this;
  }

  /**
   * Ordem de resolução: alias explícito → nome exato → nome sem sufixo de data →
   * família embutida. Uma vez resolvido, memoiza (inclusive o negativo).
   */
  resolve(model) {
    if (!model) return null;
    if (this.#memo.has(model)) return this.#memo.get(model);

    const canonical = this.#aliases.get(model) ?? model;
    let price = this.#prices.get(canonical) ?? null;

    if (!price && DATE_SUFFIX.test(canonical)) {
      price = this.#prices.get(canonical.replace(DATE_SUFFIX, "")) ?? null;
    }
    if (!price) price = fallbackPriceFor(canonical);

    this.#memo.set(model, price);
    return price;
  }

  /** @returns {{cost_usd: number|null, price_source: string, price_rev: number}} */
  priceEvent(event) {
    const price = this.resolve(event.model);
    const cost = costOfEvent(event, price);
    if (cost === null) return { cost_usd: null, price_source: "unknown", price_rev: this.rev };
    return { cost_usd: cost, price_source: price.source ?? "litellm", price_rev: this.rev };
  }
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Busca e persiste a tabela de preços. `fetchImpl` é injetável para teste.
 */
export class PriceUpdater {
  constructor({ db, cachePath, fetchImpl = globalThis.fetch, url = LITELLM_URL, now = () => Date.now() } = {}) {
    if (!cachePath) throw new Error("PriceUpdater requer cachePath.");
    this.db = db ?? null;
    this.cachePath = cachePath;
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.now = now;
  }

  #readCache() {
    try {
      const cache = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      if (cache && typeof cache === "object" && cache.data) return cache;
    } catch {}
    return null;
  }

  /**
   * @param {{force?: boolean}} options
   * @returns {Promise<{status: string, count: number, rev: number, error?: string}>}
   *   status ∈ {fresh, not-modified, cached, offline, fallback}
   */
  async refresh({ force = false } = {}) {
    const cache = this.#readCache();
    const age = cache ? this.now() - (cache.fetched_at ?? 0) : Infinity;

    if (!force && cache && age < PRICE_TTL_MS) {
      return this.#persist(cache.data, "cached", cache.fetched_at);
    }

    let response;
    try {
      const headers = { accept: "application/json" };
      if (cache?.etag) headers["if-none-match"] = cache.etag;
      response = await this.fetchImpl(this.url, { headers });
    } catch (error) {
      // Sem rede: o cache velho ainda é melhor que nada, e o fallback cobre o resto.
      if (cache) return this.#persist(cache.data, "offline", cache.fetched_at);
      return { status: "fallback", count: 0, rev: 0, error: String(error?.message ?? error) };
    }

    if (response.status === 304 && cache) {
      const fetchedAt = this.now();
      atomicWriteJson(this.cachePath, { ...cache, fetched_at: fetchedAt });
      return this.#persist(cache.data, "not-modified", fetchedAt);
    }

    if (!response.ok) {
      if (cache) return this.#persist(cache.data, "offline", cache.fetched_at);
      return { status: "fallback", count: 0, rev: 0, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const fetchedAt = this.now();
    const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
    atomicWriteJson(this.cachePath, { fetched_at: fetchedAt, etag, data });
    return this.#persist(data, "fresh", fetchedAt);
  }

  #persist(data, status, fetchedAt) {
    const rows = normalizeLitellm(data);
    // `rev` é o timestamp da coleta: monotônico e legível, serve para saber se um
    // evento foi precificado antes ou depois de uma mudança de tabela.
    const rev = Math.floor((fetchedAt ?? this.now()) / 1000);
    if (this.db && rows.length) this.db.savePrices(rows, { source: "litellm", rev });
    return { status, count: rows.length, rev };
  }
}
