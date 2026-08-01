import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

export const SCHEMA_VERSION = 2;
export const NO_PROJECT = "__none__";
/** Prefixo dos projetos descobertos por `cwd`; ids do Cockpit nunca o usam. */
export const DERIVED_PREFIX = "~";

/** Colunas de métrica, na ordem canônica usada pelo rollup e pelo payload_hash. */
export const METRIC_COLUMNS = Object.freeze([
  "requests",
  "input_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cost_usd",
  "unpriced_requests",
]);

const EVENT_COLUMNS = Object.freeze([
  "event_key",
  "provider",
  "model",
  "ts_ms",
  "hour_utc",
  "project_id",
  "cwd",
  "session_id",
  "file_id",
  "input_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cost_usd",
  "price_source",
  "price_rev",
  "is_sidechain",
  "created_at",
]);

export const HOUR_MS = 3600000;

export function hourOf(tsMs) {
  return Math.floor(tsMs / HOUR_MS);
}

/**
 * Hash estável das métricas de um bucket. O custo entra arredondado em 6 casas
 * para que ruído de ponto flutuante não gere reenvios espúrios.
 */
export function payloadHash(bucket) {
  const parts = METRIC_COLUMNS.map((key) => {
    const value = bucket[key] ?? 0;
    return key === "cost_usd" ? Number(value).toFixed(6) : String(value);
  });
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

function secureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

export class UsageDb {
  #db = null;
  #statements = new Map();

  constructor({ dbPath, readOnly = false } = {}) {
    if (!dbPath) throw new Error("UsageDb requer dbPath.");
    this.dbPath = dbPath;
    this.readOnly = readOnly;
  }

  open() {
    if (this.#db) return this;
    if (!this.readOnly) secureDirectory(path.dirname(this.dbPath));
    this.#db = new DatabaseSync(this.dbPath, { readOnly: this.readOnly });
    if (this.readOnly) {
      this.#db.exec("PRAGMA busy_timeout = 5000;");
    } else {
      this.#db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA wal_autocheckpoint = 1000;
      `);
      this.#db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
      try { fs.chmodSync(this.dbPath, 0o600); } catch {}
      this.setMeta("schema_version", String(SCHEMA_VERSION));
    }
    return this;
  }

  close() {
    this.#statements.clear();
    try { this.#db?.close(); } catch {}
    this.#db = null;
  }

  get raw() {
    if (!this.#db) throw new Error("UsageDb não está aberto.");
    return this.#db;
  }

  /** Prepared statements são cacheados: o caminho quente prepara uma vez só. */
  #stmt(sql) {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  transaction(fn) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.raw.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  // ---------------------------------------------------------------- meta

  getMeta(key, fallback = null) {
    const row = this.#stmt("SELECT v FROM meta WHERE k = ?").get(key);
    return row ? row.v : fallback;
  }

  setMeta(key, value) {
    this.#stmt(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ).run(key, String(value));
  }

  // --------------------------------------------------------------- files

  getFile(filePath) {
    return this.#stmt("SELECT * FROM files WHERE path = ?").get(filePath) ?? null;
  }

  listActiveFiles() {
    return this.#stmt("SELECT * FROM files WHERE state = 'active'").all();
  }

  upsertFile({ path: filePath, provider, rootTag, ino, size, mtimeMs }) {
    this.#stmt(`
      INSERT INTO files (path, provider, root_tag, ino, size, mtime_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET provider = excluded.provider, root_tag = excluded.root_tag
    `).run(filePath, provider, rootTag, ino ?? null, size ?? 0, mtimeMs ?? 0, Date.now());
    return this.getFile(filePath);
  }

  /**
   * Grava o cursor de leitura. Chamado SEMPRE dentro da mesma transação dos
   * eventos correspondentes — se o processo morrer antes do commit, o offset
   * antigo faz reler o trecho e o UNIQUE(event_key) absorve as repetições.
   */
  saveFileCursor(id, { offset, size, mtimeMs, ino, headSig, cursorJson, badLines, state, lastError }) {
    this.#stmt(`
      UPDATE files SET offset = ?, size = ?, mtime_ms = ?, ino = ?, head_sig = ?,
                       cursor_json = ?, bad_lines = ?, state = ?, last_error = ?, updated_at = ?
       WHERE id = ?
    `).run(
      offset, size, mtimeMs, ino ?? null, headSig ?? null,
      cursorJson ?? null, badLines ?? 0, state ?? "active", lastError ?? null,
      Date.now(), id,
    );
  }

  markFileState(id, state, lastError = null) {
    this.#stmt("UPDATE files SET state = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(state, lastError, Date.now(), id);
  }

  // -------------------------------------------------------------- events

  /**
   * Insere eventos deduplicados e marca as horas afetadas como sujas.
   * Retorna quantos eventos eram realmente novos.
   */
  insertEvents(events) {
    if (!events.length) return 0;
    const placeholders = EVENT_COLUMNS.map(() => "?").join(", ");
    const insert = this.#stmt(
      `INSERT INTO events (${EVENT_COLUMNS.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(event_key) DO NOTHING`,
    );
    const dirty = this.#stmt(
      `INSERT INTO dirty_hours (hour_utc, project_id, provider, model) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    const now = Date.now();
    let inserted = 0;
    for (const event of events) {
      const row = insert.run(
        event.event_key,
        event.provider,
        event.model,
        event.ts_ms,
        event.hour_utc ?? hourOf(event.ts_ms),
        event.project_id ?? NO_PROJECT,
        event.cwd ?? null,
        event.session_id ?? null,
        event.file_id ?? null,
        event.input_tokens | 0,
        event.cache_read_tokens | 0,
        event.cache_write_5m_tokens | 0,
        event.cache_write_1h_tokens | 0,
        event.output_tokens | 0,
        event.reasoning_tokens | 0,
        event.cost_usd ?? null,
        event.price_source ?? "unknown",
        event.price_rev ?? 0,
        event.is_sidechain ? 1 : 0,
        now,
      );
      if (row.changes > 0) {
        inserted += 1;
        dirty.run(
          event.hour_utc ?? hourOf(event.ts_ms),
          event.project_id ?? NO_PROJECT,
          event.provider,
          event.model,
        );
      }
    }
    return inserted;
  }

  markHoursDirty(rows) {
    const dirty = this.#stmt(
      `INSERT INTO dirty_hours (hour_utc, project_id, provider, model) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    for (const r of rows) dirty.run(r.hour_utc, r.project_id, r.provider, r.model);
  }

  countEvents() {
    return this.#stmt("SELECT COUNT(*) AS n FROM events").get().n;
  }

  // -------------------------------------------------------------- rollup

  /**
   * Recomputa (não incrementa) cada bucket sujo a partir de `events`.
   * Recomputar torna o rollup idempotente e auto-corretivo: reprocessamento,
   * reprecificação e correções de bug se resolvem sozinhos.
   */
  rollupDirty(limit = 5000) {
    const dirty = this.#stmt(
      "SELECT hour_utc, project_id, provider, model FROM dirty_hours LIMIT ?",
    ).all(limit);
    if (!dirty.length) return 0;

    const aggregate = this.#stmt(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0)          AS input_tokens,
             COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
             COALESCE(SUM(cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
             COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
             COALESCE(SUM(output_tokens), 0)         AS output_tokens,
             COALESCE(SUM(reasoning_tokens), 0)      AS reasoning_tokens,
             COALESCE(SUM(cost_usd), 0)              AS cost_usd,
             COALESCE(SUM(cost_usd IS NULL), 0)      AS unpriced_requests
        FROM events
       WHERE hour_utc = ? AND project_id = ? AND provider = ? AND model = ?
    `);
    const upsert = this.#stmt(`
      INSERT INTO hourly (hour_utc, project_id, provider, model,
                          requests, input_tokens, cache_read_tokens,
                          cache_write_5m_tokens, cache_write_1h_tokens,
                          output_tokens, reasoning_tokens, cost_usd, unpriced_requests,
                          payload_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour_utc, project_id, provider, model) DO UPDATE SET
        requests = excluded.requests,
        input_tokens = excluded.input_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_5m_tokens = excluded.cache_write_5m_tokens,
        cache_write_1h_tokens = excluded.cache_write_1h_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cost_usd = excluded.cost_usd,
        unpriced_requests = excluded.unpriced_requests,
        payload_hash = excluded.payload_hash,
        fail_count = CASE WHEN hourly.payload_hash <> excluded.payload_hash THEN 0 ELSE hourly.fail_count END,
        updated_at = excluded.updated_at
    `);
    const clearEmpty = this.#stmt(
      "DELETE FROM hourly WHERE hour_utc = ? AND project_id = ? AND provider = ? AND model = ?",
    );
    const clearDirty = this.#stmt(
      "DELETE FROM dirty_hours WHERE hour_utc = ? AND project_id = ? AND provider = ? AND model = ?",
    );

    const now = Date.now();
    this.transaction(() => {
      for (const key of dirty) {
        const agg = aggregate.get(key.hour_utc, key.project_id, key.provider, key.model);
        if (!agg || agg.requests === 0) {
          // Bucket ficou sem eventos (re-atribuição de projeto moveu tudo).
          clearEmpty.run(key.hour_utc, key.project_id, key.provider, key.model);
        } else {
          upsert.run(
            key.hour_utc, key.project_id, key.provider, key.model,
            agg.requests, agg.input_tokens, agg.cache_read_tokens,
            agg.cache_write_5m_tokens, agg.cache_write_1h_tokens,
            agg.output_tokens, agg.reasoning_tokens, agg.cost_usd, agg.unpriced_requests,
            payloadHash(agg), now,
          );
        }
        clearDirty.run(key.hour_utc, key.project_id, key.provider, key.model);
      }
    });
    return dirty.length;
  }

  pendingDirtyCount() {
    return this.#stmt("SELECT COUNT(*) AS n FROM dirty_hours").get().n;
  }

  // -------------------------------------------------------------- outbox

  pendingBuckets(limit = 500, maxFailures = 5) {
    return this.#stmt(`
      SELECT * FROM hourly
       WHERE (synced_hash IS NULL OR synced_hash <> payload_hash)
         AND fail_count < ?
       ORDER BY hour_utc ASC
       LIMIT ?
    `).all(maxFailures, limit);
  }

  pendingCount(maxFailures = 5) {
    return this.#stmt(`
      SELECT COUNT(*) AS n FROM hourly
       WHERE (synced_hash IS NULL OR synced_hash <> payload_hash) AND fail_count < ?
    `).get(maxFailures).n;
  }

  markSynced(key, hash) {
    this.#stmt(`
      UPDATE hourly SET synced_hash = ?, synced_at = ?, fail_count = 0
       WHERE hour_utc = ? AND project_id = ? AND provider = ? AND model = ?
    `).run(hash, Date.now(), key.hour_utc, key.project_id, key.provider, key.model);
  }

  markBucketFailed(key) {
    this.#stmt(`
      UPDATE hourly SET fail_count = fail_count + 1
       WHERE hour_utc = ? AND project_id = ? AND provider = ? AND model = ?
    `).run(key.hour_utc, key.project_id, key.provider, key.model);
  }

  getSyncState() {
    return this.#stmt("SELECT * FROM sync_state WHERE id = 1").get();
  }

  setSyncState(patch) {
    const current = this.getSyncState() ?? {};
    const next = { ...current, ...patch };
    this.#stmt(`
      UPDATE sync_state SET last_attempt_at = ?, last_success_at = ?,
             consecutive_failures = ?, next_attempt_at = ?, last_error = ?
       WHERE id = 1
    `).run(
      next.last_attempt_at ?? null,
      next.last_success_at ?? null,
      next.consecutive_failures ?? 0,
      next.next_attempt_at ?? 0,
      next.last_error ?? null,
    );
  }

  // -------------------------------------------------------------- preços

  loadPrices() {
    const prices = new Map();
    for (const row of this.#stmt("SELECT * FROM model_prices").all()) prices.set(row.model, row);
    const aliases = new Map();
    for (const row of this.#stmt("SELECT * FROM model_alias").all()) aliases.set(row.raw, row.model);
    return { prices, aliases };
  }

  savePrices(rows, { source, rev }) {
    const upsert = this.#stmt(`
      INSERT INTO model_prices (model, provider, input_cost, output_cost, cache_read_cost,
                                cache_write_5m_cost, cache_write_1h_cost, source, rev, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        provider = excluded.provider, input_cost = excluded.input_cost,
        output_cost = excluded.output_cost, cache_read_cost = excluded.cache_read_cost,
        cache_write_5m_cost = excluded.cache_write_5m_cost,
        cache_write_1h_cost = excluded.cache_write_1h_cost,
        source = excluded.source, rev = excluded.rev, fetched_at = excluded.fetched_at
    `);
    const now = Date.now();
    this.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.model, row.provider ?? null,
          row.input_cost ?? null, row.output_cost ?? null, row.cache_read_cost ?? null,
          row.cache_write_5m_cost ?? null, row.cache_write_1h_cost ?? null,
          source, rev, now,
        );
      }
    });
  }

  /** Eventos que ainda não têm custo, para reprecificação quando os preços chegam. */
  unpricedEvents(limit = 5000) {
    return this.#stmt(
      "SELECT id, model, hour_utc, project_id, provider FROM events WHERE cost_usd IS NULL LIMIT ?",
    ).all(limit);
  }

  applyPricing(rows) {
    if (!rows.length) return 0;
    const update = this.#stmt(
      "UPDATE events SET cost_usd = ?, price_source = ?, price_rev = ? WHERE id = ?",
    );
    this.transaction(() => {
      for (const row of rows) update.run(row.cost_usd, row.price_source, row.price_rev, row.id);
      this.markHoursDirty(rows);
    });
    return rows.length;
  }

  // --------------------------------------------------- projetos derivados

  /** Registra (ou recupera) um projeto descoberto por `cwd`. */
  saveDerivedProject({ projectId, path: dir, label }) {
    this.#stmt(`
      INSERT INTO derived_projects (project_id, path, label, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING
    `).run(projectId, dir, label, Date.now());
    return projectId;
  }

  derivedProjectByPath(dir) {
    return this.#stmt("SELECT * FROM derived_projects WHERE path = ?").get(dir) ?? null;
  }

  /** Já usado por outro caminho? Sinaliza colisão de basename. */
  derivedProjectById(projectId) {
    return this.#stmt("SELECT * FROM derived_projects WHERE project_id = ?").get(projectId) ?? null;
  }

  derivedProjects() {
    return this.#stmt("SELECT * FROM derived_projects ORDER BY label").all();
  }

  // ------------------------------------------------------------- queries

  /**
   * Totais por projeto num intervalo de horas [fromHour, toHour].
   * O `label` sai do cadastro de derivados quando existe; para projetos do
   * Cockpit quem sabe o nome é o `server.js`, que preenche na resposta do WS.
   */
  totalsByProject(fromHour, toHour) {
    return this.#stmt(`
      SELECT h.project_id,
             d.label AS label,
             d.path  AS path,
             SUM(h.requests) AS requests,
             SUM(h.input_tokens + h.cache_read_tokens + h.cache_write_5m_tokens
                 + h.cache_write_1h_tokens + h.output_tokens) AS tokens,
             SUM(h.cost_usd) AS cost_usd,
             SUM(h.unpriced_requests) AS unpriced_requests
        FROM hourly h
        LEFT JOIN derived_projects d ON d.project_id = h.project_id
       WHERE h.hour_utc BETWEEN ? AND ?
       GROUP BY h.project_id ORDER BY cost_usd DESC
    `).all(fromHour, toHour);
  }

  totalsByModel(fromHour, toHour) {
    return this.#stmt(`
      SELECT provider, model,
             SUM(requests) AS requests,
             SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens
                 + cache_write_1h_tokens + output_tokens) AS tokens,
             SUM(cost_usd) AS cost_usd,
             SUM(unpriced_requests) AS unpriced_requests
        FROM hourly WHERE hour_utc BETWEEN ? AND ?
       GROUP BY provider, model ORDER BY cost_usd DESC
    `).all(fromHour, toHour);
  }

  seriesByHour(fromHour, toHour) {
    return this.#stmt(`
      SELECT hour_utc,
             SUM(requests) AS requests,
             SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens
                 + cache_write_1h_tokens + output_tokens) AS tokens,
             SUM(cost_usd) AS cost_usd
        FROM hourly WHERE hour_utc BETWEEN ? AND ?
       GROUP BY hour_utc ORDER BY hour_utc ASC
    `).all(fromHour, toHour);
  }

  totals(fromHour, toHour) {
    return this.#stmt(`
      SELECT COALESCE(SUM(requests), 0) AS requests,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
             COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             -- Mesma definição de "tokens" das outras consultas: os cinco baldes
             -- cobráveis. reasoning_tokens fica de fora por ser subconjunto do
             -- output — somá-lo contaria os mesmos tokens duas vezes.
             COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens
                          + cache_write_1h_tokens + output_tokens), 0) AS tokens,
             COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COALESCE(SUM(unpriced_requests), 0) AS unpriced_requests
        FROM hourly WHERE hour_utc BETWEEN ? AND ?
    `).get(fromHour, toHour);
  }

  /** Modelos sem preço, para a UI avisar em vez de mostrar custo subestimado. */
  unpricedModels(fromHour, toHour) {
    return this.#stmt(`
      SELECT model, provider, SUM(unpriced_requests) AS requests
        FROM hourly WHERE hour_utc BETWEEN ? AND ? AND unpriced_requests > 0
       GROUP BY provider, model ORDER BY requests DESC
    `).all(fromHour, toHour);
  }

  checkpoint() {
    try { this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  }
}
