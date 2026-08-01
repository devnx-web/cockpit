import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOUR_MS, NO_PROJECT, SCHEMA_VERSION, UsageDb, hourOf, payloadHash } from "../lib/usage/db.js";

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-db-"));
  const db = new UsageDb({ dbPath: path.join(dir, "usage.db") }).open();
  try {
    return fn(db, dir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HOUR = hourOf(Date.UTC(2026, 6, 27, 14, 0, 0));

function event(overrides = {}) {
  return {
    event_key: "c|req|msg",
    provider: "claude",
    model: "claude-opus-5",
    ts_ms: Date.UTC(2026, 6, 27, 14, 5, 0),
    project_id: "cockpit",
    cwd: "/home/ftgk/cockpit",
    session_id: "sess-1",
    input_tokens: 10,
    cache_read_tokens: 100,
    cache_write_5m_tokens: 20,
    cache_write_1h_tokens: 5,
    output_tokens: 40,
    reasoning_tokens: 0,
    cost_usd: 0.25,
    price_source: "litellm",
    price_rev: 1,
    is_sidechain: false,
    ...overrides,
  };
}

test("db: abre, aplica o schema e registra a versão", () => {
  withDb((db) => {
    assert.equal(db.getMeta("schema_version"), String(SCHEMA_VERSION));
    assert.equal(db.countEvents(), 0);
    assert.equal(db.getSyncState().id, 1);
  });
});

test("db: event_key repetido é ignorado e não suja a hora de novo", () => {
  withDb((db) => {
    assert.equal(db.insertEvents([event(), event()]), 1, "o segundo é o mesmo evento");
    assert.equal(db.countEvents(), 1);
    assert.equal(db.pendingDirtyCount(), 1);

    assert.equal(db.insertEvents([event()]), 0, "reprocessar o arquivo não recria nada");
    assert.equal(db.countEvents(), 1);
  });
});

test("db: rollup recomputa e é idempotente", () => {
  withDb((db) => {
    db.insertEvents([
      event({ event_key: "a" }),
      event({ event_key: "b", output_tokens: 60, cost_usd: 0.5 }),
    ]);
    assert.equal(db.rollupDirty(), 1, "os dois eventos caem no mesmo bucket");

    const first = db.raw.prepare("SELECT * FROM hourly").all();
    assert.equal(first.length, 1);
    assert.equal(first[0].requests, 2);
    assert.equal(first[0].output_tokens, 100);
    assert.equal(Number(first[0].cost_usd.toFixed(6)), 0.75);
    assert.equal(db.pendingDirtyCount(), 0);

    // Rodar o rollup de novo sobre os mesmos eventos não pode dobrar nada.
    db.markHoursDirty([{ hour_utc: HOUR, project_id: "cockpit", provider: "claude", model: "claude-opus-5" }]);
    db.rollupDirty();
    const second = db.raw.prepare("SELECT * FROM hourly").all();
    assert.equal(second[0].requests, 2, "recomputa, não incrementa");
    assert.equal(second[0].payload_hash, first[0].payload_hash, "payload_hash estável");
  });
});

test("db: bucket que perdeu todos os eventos é removido do rollup", () => {
  withDb((db) => {
    db.insertEvents([event({ event_key: "a" })]);
    db.rollupDirty();
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM hourly").get().n, 1);

    // Reatribuição de projeto: o evento migra e o bucket antigo fica vazio.
    db.raw.exec("UPDATE events SET project_id = 'outro'");
    db.markHoursDirty([
      { hour_utc: HOUR, project_id: "cockpit", provider: "claude", model: "claude-opus-5" },
      { hour_utc: HOUR, project_id: "outro", provider: "claude", model: "claude-opus-5" },
    ]);
    db.rollupDirty();

    const rows = db.raw.prepare("SELECT project_id FROM hourly").all();
    assert.deepEqual(rows.map((r) => r.project_id), ["outro"]);
  });
});

test("db: evento sem preço vira unpriced_requests, não custo zero", () => {
  withDb((db) => {
    db.insertEvents([
      event({ event_key: "a", cost_usd: null, price_source: "unknown" }),
      event({ event_key: "b", cost_usd: 0.25 }),
    ]);
    db.rollupDirty();
    const row = db.raw.prepare("SELECT * FROM hourly").get();
    assert.equal(row.requests, 2);
    assert.equal(row.unpriced_requests, 1);
    assert.equal(Number(row.cost_usd.toFixed(6)), 0.25, "o custo conhecido não é diluído");

    const unpriced = db.unpricedModels(HOUR, HOUR);
    assert.equal(unpriced.length, 1);
    assert.equal(unpriced[0].model, "claude-opus-5");
  });
});

test("db: reprecificação atualiza o evento e refaz o bucket", () => {
  withDb((db) => {
    db.insertEvents([event({ event_key: "a", cost_usd: null, price_source: "unknown" })]);
    db.rollupDirty();
    assert.equal(db.raw.prepare("SELECT unpriced_requests FROM hourly").get().unpriced_requests, 1);

    const pending = db.unpricedEvents();
    assert.equal(pending.length, 1);
    db.applyPricing(pending.map((row) => ({ ...row, cost_usd: 1.5, price_source: "litellm", price_rev: 2 })));
    db.rollupDirty();

    const row = db.raw.prepare("SELECT * FROM hourly").get();
    assert.equal(row.unpriced_requests, 0);
    assert.equal(Number(row.cost_usd.toFixed(6)), 1.5);
  });
});

test("db: a outbox é a própria hourly — pendente enquanto o hash não bate", () => {
  withDb((db) => {
    db.insertEvents([event({ event_key: "a" })]);
    db.rollupDirty();
    assert.equal(db.pendingCount(), 1, "nunca enviado");

    const [bucket] = db.pendingBuckets();
    db.markSynced(bucket, bucket.payload_hash);
    assert.equal(db.pendingCount(), 0);

    // Backfill traz um evento antigo para a mesma hora: o bucket volta a ficar pendente.
    db.insertEvents([event({ event_key: "b" })]);
    db.rollupDirty();
    assert.equal(db.pendingCount(), 1, "enviado e depois alterado ≠ já sincronizado");
  });
});

test("db: uma hora que muda N vezes gera um envio, não N", () => {
  withDb((db) => {
    for (let i = 0; i < 20; i += 1) {
      db.insertEvents([event({ event_key: `k${i}` })]);
      db.rollupDirty();
    }
    assert.equal(db.pendingCount(), 1, "a fila coalesce sozinha");
    assert.equal(db.raw.prepare("SELECT requests FROM hourly").get().requests, 20);
  });
});

test("db: bucket rejeitado entra em quarentena e não trava a fila", () => {
  withDb((db) => {
    db.insertEvents([
      event({ event_key: "a" }),
      event({ event_key: "b", project_id: "outro", cwd: "/home/ftgk/outro" }),
    ]);
    db.rollupDirty();
    assert.equal(db.pendingCount(), 2);

    const ruim = db.pendingBuckets().find((b) => b.project_id === "cockpit");
    for (let i = 0; i < 5; i += 1) db.markBucketFailed(ruim);

    assert.equal(db.pendingCount(), 1, "o quarentenado sai da fila");
    assert.deepEqual(db.pendingBuckets().map((b) => b.project_id), ["outro"]);

    // Se o bucket mudar (backfill/reprecificação), o hash muda e a quarentena é perdoada.
    db.insertEvents([event({ event_key: "c" })]);
    db.rollupDirty();
    assert.equal(db.raw.prepare("SELECT fail_count FROM hourly WHERE project_id = 'cockpit'").get().fail_count, 0);
    assert.equal(db.pendingCount(), 2);
  });
});

test("db: sync_state persiste o backoff entre aberturas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-db-"));
  const dbPath = path.join(dir, "usage.db");
  try {
    const a = new UsageDb({ dbPath }).open();
    a.setSyncState({ consecutive_failures: 3, next_attempt_at: 1_800_000, last_error: "ECONNREFUSED" });
    a.close();

    const b = new UsageDb({ dbPath }).open();
    const state = b.getSyncState();
    assert.equal(state.consecutive_failures, 3);
    assert.equal(state.next_attempt_at, 1_800_000);
    assert.equal(state.last_error, "ECONNREFUSED");
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("db: cursor de arquivo sobrevive ao ciclo de gravação", () => {
  withDb((db) => {
    const file = db.upsertFile({
      path: "/home/ftgk/.codex/sessions/rollout-1.jsonl",
      provider: "codex",
      rootTag: "codex",
      ino: "66:1234",
      size: 0,
      mtimeMs: 0,
    });
    db.saveFileCursor(file.id, {
      offset: 4096,
      size: 8192,
      mtimeMs: 1_700_000_000_000,
      ino: "66:1234",
      headSig: "abc",
      cursorJson: JSON.stringify({ prev: null, model: "gpt-5.5" }),
      badLines: 2,
      state: "active",
      lastError: null,
    });

    const reloaded = db.getFile("/home/ftgk/.codex/sessions/rollout-1.jsonl");
    assert.equal(reloaded.offset, 4096);
    assert.equal(reloaded.bad_lines, 2);
    assert.equal(JSON.parse(reloaded.cursor_json).model, "gpt-5.5");
    assert.deepEqual(db.listActiveFiles().map((f) => f.id), [file.id]);

    db.markFileState(file.id, "missing", "ENOENT");
    assert.deepEqual(db.listActiveFiles(), [], "arquivo sumido sai do scan");
    assert.equal(db.getFile("/home/ftgk/.codex/sessions/rollout-1.jsonl").offset, 4096, "sem apagar o cursor");
  });
});

test("db: consultas de leitura agregam pelo intervalo de horas", () => {
  withDb((db) => {
    db.insertEvents([
      event({ event_key: "a" }),
      event({ event_key: "b", project_id: "outro", provider: "codex", model: "gpt-5.5", cost_usd: 1 }),
      event({
        event_key: "c",
        ts_ms: Date.UTC(2026, 6, 27, 16, 5, 0),
        cost_usd: 2,
      }),
    ]);
    db.rollupDirty();

    const totais = db.totals(HOUR, HOUR + 2);
    assert.equal(totais.requests, 3);
    assert.equal(Number(totais.cost_usd.toFixed(6)), 3.25);

    const janela = db.totals(HOUR, HOUR);
    assert.equal(janela.requests, 2, "a hora 16h fica de fora");

    assert.deepEqual(
      db.totalsByProject(HOUR, HOUR + 2).map((r) => r.project_id).sort(),
      ["cockpit", "outro"],
    );
    assert.deepEqual(
      db.totalsByModel(HOUR, HOUR + 2).map((r) => r.provider).sort(),
      ["claude", "codex"],
    );
    assert.deepEqual(db.seriesByHour(HOUR, HOUR + 2).map((r) => r.hour_utc), [HOUR, HOUR + 2]);
  });
});

test("db: leitor readOnly enxerga o que o writer gravou", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-db-"));
  const dbPath = path.join(dir, "usage.db");
  let writer;
  let reader;
  try {
    writer = new UsageDb({ dbPath }).open();
    writer.insertEvents([event({ event_key: "a" })]);
    writer.rollupDirty();
    writer.checkpoint();

    reader = new UsageDb({ dbPath, readOnly: true }).open();
    assert.equal(reader.totals(HOUR, HOUR).requests, 1);
    assert.throws(() => reader.raw.exec("DELETE FROM events"), /readonly/i);
  } finally {
    reader?.close();
    writer?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("db: hourOf e payloadHash são estáveis", () => {
  assert.equal(hourOf(Date.UTC(2026, 6, 27, 14, 59, 59)), hourOf(Date.UTC(2026, 6, 27, 14, 0, 0)));
  assert.equal(hourOf(Date.UTC(2026, 6, 27, 15, 0, 0)) * HOUR_MS, Date.UTC(2026, 6, 27, 15, 0, 0));

  const base = { requests: 2, input_tokens: 10, output_tokens: 40, cost_usd: 0.1 };
  assert.equal(payloadHash(base), payloadHash({ ...base }));
  // Ruído de ponto flutuante abaixo da 6ª casa não pode disparar reenvio.
  assert.equal(payloadHash(base), payloadHash({ ...base, cost_usd: 0.1 + 1e-12 }));
  assert.notEqual(payloadHash(base), payloadHash({ ...base, output_tokens: 41 }));
  assert.equal(payloadHash({ requests: 1 }), payloadHash({ requests: 1, unpriced_requests: 0 }));
});

test("db: eventos sem projeto caem no bucket reservado", () => {
  withDb((db) => {
    db.insertEvents([event({ event_key: "a", project_id: undefined, cwd: "/fora/de/tudo" })]);
    db.rollupDirty();
    assert.equal(db.raw.prepare("SELECT project_id FROM hourly").get().project_id, NO_PROJECT);
  });
});
