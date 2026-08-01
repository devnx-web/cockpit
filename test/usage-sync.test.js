import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageDb, hourOf } from "../lib/usage/db.js";
import { UsageSync, montarUrl } from "../lib/usage/sync.js";

const HORA = Date.UTC(2026, 6, 27, 14, 5, 0);

async function withSync(fn, { respostas = [], sendProjectPaths = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-sync-"));
  const db = new UsageDb({ dbPath: path.join(dir, "usage.db") }).open();
  fs.mkdirSync(path.join(dir, ".cockpit"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".cockpit", "team-auth.json"),
    JSON.stringify({ baseUrl: "https://control.example.test", deviceToken: "tok-123" }),
  );

  const chamadas = [];
  const fetchImpl = async (url, init) => {
    chamadas.push({ url, init, body: JSON.parse(init.body) });
    const resposta = respostas.shift();
    if (typeof resposta === "function") return resposta();
    const { status = 200, payload = { results: [] } } = resposta ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };

  const sync = new UsageSync({ db, homeDir: dir, fetchImpl, sendProjectPaths });
  try {
    return await fn({ db, sync, chamadas, dir });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function evento(overrides = {}) {
  return {
    event_key: "c|req|msg",
    provider: "claude",
    model: "claude-opus-5",
    ts_ms: HORA,
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

/** Popula `hourly` com N buckets pendentes, um por projeto. */
function semear(db, projetos = ["cockpit"]) {
  db.insertEvents(projetos.map((p, i) => evento({ event_key: `k-${i}`, project_id: p })));
  while (db.pendingDirtyCount() > 0 && db.rollupDirty()) { /* drena */ }
}

const ok = (n, status = "upserted") => ({
  status: 200,
  payload: { device_id: 1, schema_version: 1, results: Array.from({ length: n }, () => ({ status })) },
});

test("sync: monta a URL tanto de uma base raiz quanto de uma já terminada em /api", () => {
  assert.equal(
    montarUrl("https://control.example.test", "/api/cockpit-ai/usage/hourly"),
    "https://control.example.test/api/cockpit-ai/usage/hourly",
  );
  assert.equal(
    montarUrl("https://control.example.test/api/", "/api/cockpit-ai/usage/hourly"),
    "https://control.example.test/api/cockpit-ai/usage/hourly",
  );
});

test("sync: sem credencial de pareamento não tenta enviar nada", async () => {
  await withSync(async ({ db, sync, chamadas, dir }) => {
    fs.rmSync(path.join(dir, ".cockpit", "team-auth.json"));
    semear(db);
    const r = await sync.runOnce();
    assert.equal(r.status, "not_connected");
    assert.equal(chamadas.length, 0);
    assert.equal(db.pendingCount(), 1, "a fila continua intacta para quando parear");
  });
});

test("sync: o device_uid é sorteado uma vez e reusado nas execuções seguintes", async () => {
  await withSync(({ sync, dir }) => {
    const primeiro = sync.device();
    assert.match(primeiro.device_uid, /^[0-9a-f-]{36}$/);

    const gravado = JSON.parse(fs.readFileSync(path.join(dir, ".cockpit", "device.json"), "utf8"));
    assert.equal(gravado.device_uid, primeiro.device_uid);

    // Instância nova, mesma máquina: tem de continuar sendo o mesmo dispositivo,
    // senão cada reinício viraria uma estação nova no painel.
    const outra = new UsageSync({ db: null, homeDir: dir });
    assert.equal(outra.device().device_uid, primeiro.device_uid);
  });
});

test("sync: envia os pendentes e não reenvia o que já foi confirmado", async () => {
  await withSync(async ({ db, sync, chamadas }) => {
    semear(db, ["cockpit", "~220-api"]);
    assert.equal(db.pendingCount(), 2);

    const r = await sync.runOnce({
      projectNames: new Map([["cockpit", { name: "Cockpit", path: "/home/ftgk/cockpit" }]]),
    });
    assert.equal(r.status, "sent");
    assert.equal(r.sent, 2);
    assert.equal(db.pendingCount(), 0);

    const corpo = chamadas[0].body;
    assert.equal(corpo.schema_version, 1);
    assert.equal(corpo.buckets.length, 2);
    assert.equal(corpo.buckets[0].hour_utc, "2026-07-27T14:00:00.000Z", "hora truncada e em ISO");
    assert.equal(chamadas[0].init.headers.Authorization, "Bearer tok-123");

    const cockpit = corpo.buckets.find((b) => b.project_key === "cockpit");
    assert.equal(cockpit.project_name, "Cockpit");
    assert.equal(cockpit.project_path, undefined, "caminho não sai da máquina por padrão");

    // Nada mudou desde o envio: a segunda passada não tem o que mandar.
    const segunda = await sync.runOnce({ force: true });
    assert.equal(segunda.status, "idle");
    assert.equal(chamadas.length, 1);
  }, { respostas: [ok(2)] });
});

test("sync: um bucket corrigido depois do envio volta para a fila", async () => {
  await withSync(async ({ db, sync, chamadas }) => {
    semear(db);
    await sync.runOnce();
    assert.equal(db.pendingCount(), 0);

    // É o que um backfill produz: mais eventos caindo numa hora já enviada.
    db.insertEvents([evento({ event_key: "novo", output_tokens: 999 })]);
    while (db.pendingDirtyCount() > 0 && db.rollupDirty()) { /* drena */ }
    assert.equal(db.pendingCount(), 1, "payload_hash mudou, logo divergiu do synced_hash");

    await sync.runOnce({ force: true });
    assert.equal(chamadas.length, 2);
    assert.equal(chamadas[1].body.buckets[0].output_tokens, 1039, "valor absoluto, não incremento");
  }, { respostas: [ok(1), ok(1)] });
});

test("sync: resposta parcial marca só os buckets confirmados", async () => {
  await withSync(async ({ db, sync }) => {
    semear(db, ["a", "b", "c"]);

    const r = await sync.runOnce();
    assert.equal(r.sent, 1);
    assert.equal(r.unchanged, 1, "o backend já tinha esse bucket idêntico");
    assert.equal(r.rejected, 1);
    // O terceiro não veio na resposta: continua pendente e vai na próxima rodada.
    assert.equal(db.pendingCount(), 1);
  }, { respostas: [{ status: 200, payload: { results: [{ status: "upserted" }, { status: "unchanged" }] } }] });
});

test("sync: um bucket recusado entra em quarentena e não trava a fila", async () => {
  await withSync(async ({ db, sync }) => {
    semear(db, ["ruim"]);
    const recusa = { status: 200, payload: { results: [{ status: "rejected" }] } };

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await sync.runOnce({ force: true });
      assert.equal(r.rejected, 1);
      recusa.payload.results = [{ status: "rejected" }];
    }

    // `fail_count` chegou a 5: o bucket sai da fila em vez de ser reenviado para
    // sempre, bloqueando tudo o que vier depois dele.
    assert.equal(db.pendingCount(), 0);
    const r = await sync.runOnce({ force: true });
    assert.equal(r.status, "idle");
  }, {
    respostas: Array.from({ length: 6 }, () => ({
      status: 200,
      payload: { results: [{ status: "rejected" }] },
    })),
  });
});

test("sync: falha de rede gera backoff persistido e crescente", async () => {
  await withSync(async ({ db, sync, chamadas }) => {
    semear(db);

    const primeira = await sync.runOnce();
    assert.equal(primeira.status, "failed");
    assert.equal(primeira.failures, 1);
    assert.ok(primeira.retryInMs > 20_000 && primeira.retryInMs < 40_000, "≈30 s com jitter");

    // Enquanto o backoff corre, nem tenta — é o que segura três estações sem rede.
    const durante = await sync.runOnce();
    assert.equal(durante.status, "backoff");
    assert.equal(chamadas.length, 1);

    const forcada = await sync.runOnce({ force: true });
    assert.equal(forcada.failures, 2);
    assert.ok(forcada.retryInMs > primeira.retryInMs, "a espera dobra a cada falha");

    // O estado sobrevive a um restart do Cockpit: está no banco, não em memória.
    assert.equal(db.getSyncState().consecutive_failures, 2);
    assert.equal(db.pendingCount(), 1, "nada se perde");
  }, {
    respostas: [
      () => { throw new Error("ECONNREFUSED"); },
      () => { throw new Error("ECONNREFUSED"); },
    ],
  });
});

test("sync: um sucesso zera o backoff acumulado", async () => {
  await withSync(async ({ db, sync }) => {
    semear(db);
    await sync.runOnce();
    assert.equal(db.getSyncState().consecutive_failures, 1);

    await sync.runOnce({ force: true });
    const estado = db.getSyncState();
    assert.equal(estado.consecutive_failures, 0);
    assert.equal(estado.next_attempt_at, 0);
    assert.ok(estado.last_success_at > 0);
  }, { respostas: [{ status: 503 }, ok(1)] });
});

test("sync: schema incompatível para o cliente em vez de martelar o servidor", async () => {
  await withSync(async ({ db, sync }) => {
    semear(db);
    const r = await sync.runOnce();
    assert.equal(r.status, "schema_mismatch");
    assert.equal(db.pendingCount(), 1, "os dados ficam guardados até o Cockpit ser atualizado");
    assert.ok(db.getSyncState().next_attempt_at > Date.now() + 20 * 60_000);
  }, { respostas: [{ status: 409, payload: { expected_schema_version: 2 } }] });
});

test("sync: o caminho do projeto só vai quando explicitamente habilitado", async () => {
  await withSync(async ({ db, sync, chamadas }) => {
    semear(db);
    await sync.runOnce({
      projectNames: new Map([["cockpit", { name: "Cockpit", path: "/home/ftgk/cockpit" }]]),
    });
    assert.equal(chamadas[0].body.buckets[0].project_path, "/home/ftgk/cockpit");
  }, { respostas: [ok(1)], sendProjectPaths: true });
});

test("sync: bucket sem projeto conhecido vai com rótulo legível", async () => {
  await withSync(async ({ db, sync, chamadas }) => {
    semear(db, ["__none__"]);
    await sync.runOnce();
    assert.equal(chamadas[0].body.buckets[0].project_key, "__none__");
    assert.equal(chamadas[0].body.buckets[0].project_name, "Sem projeto");
  }, { respostas: [ok(1)] });
});

test("sync: hour_utc é índice de hora, não milissegundos", () => {
  // Guarda contra a confusão mais fácil do módulo: `hour_utc` é índice de hora,
  // não milissegundos. Tratá-lo como ms jogaria tudo para 1970.
  const indice = hourOf(HORA);
  assert.equal(new Date(indice * 3600_000).toISOString(), "2026-07-27T14:00:00.000Z");
});
