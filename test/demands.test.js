import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDemandStore, demandStatusFromTerminal } from "../lib/demands.js";

function tmpFile(name = "demands.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-demands-"));
  return path.join(dir, name);
}

function newDemand(store, extra = {}) {
  return store.create({
    text: "vê o erro de build",
    projectId: "academi-phd",
    projectName: "PHD Financeiro",
    ...extra,
  });
}

/** Coloca a demanda no estado em que o dispatcher já entregou o texto. */
function handOff(store, demand, terminalId = "t1") {
  store.update(demand.id, { terminalId, terminalName: "Terminal 1", stage: "handed_off" });
  return store.get(demand.id);
}

test("mapeamento de status de terminal para demanda", () => {
  assert.equal(demandStatusFromTerminal("running", "processando…"), "working");
  assert.equal(demandStatusFromTerminal("waiting", "aguardando · 3s"), "waiting");
  assert.equal(demandStatusFromTerminal("error", "erro · 1s"), "error");
  assert.equal(demandStatusFromTerminal("idle", "ocioso · 40s"), "done");
  // pausa curta não fecha a demanda
  assert.equal(demandStatusFromTerminal("idle", "pausado · 5s"), null);
});

test("status do terminal só afeta a demanda depois do handoff", () => {
  const store = createDemandStore({});
  const demand = newDemand(store);
  store.update(demand.id, { terminalId: "t1", stage: "waiting_agent" });

  // banner de boot do agente costuma casar com ERROR_PATTERNS
  assert.equal(store.onTerminalStatus("academi-phd", "t1", "error", "erro · 1s"), null);
  assert.equal(store.get(demand.id).status, "queued");

  handOff(store, demand);
  store.onTerminalStatus("academi-phd", "t1", "running", "processando…");
  assert.equal(store.get(demand.id).status, "working");
});

test("erro não é estado terminal — a demanda volta a trabalhar", () => {
  const store = createDemandStore({});
  const demand = handOff(store, newDemand(store));

  store.onTerminalStatus("academi-phd", "t1", "error", "erro · 1s");
  assert.equal(store.get(demand.id).status, "error");

  store.onTerminalStatus("academi-phd", "t1", "running", "processando…");
  assert.equal(store.get(demand.id).status, "working");
  assert.equal(store.get(demand.id).endedAt, null);

  store.onTerminalStatus("academi-phd", "t1", "idle", "ocioso · 40s");
  assert.equal(store.get(demand.id).status, "done");
  assert.ok(store.get(demand.id).endedAt);
});

test("demanda fechada não volta atrás e libera o terminal", () => {
  const store = createDemandStore({});
  const demand = handOff(store, newDemand(store));
  store.onTerminalStatus("academi-phd", "t1", "idle", "ocioso · 40s");

  assert.equal(store.activeFor("academi-phd", "t1"), null);
  store.onTerminalStatus("academi-phd", "t1", "running", "processando…");
  assert.equal(store.get(demand.id).status, "done");
  assert.deepEqual(store.listActive(), []);
});

test("saída do terminal fecha a demanda conforme o exit code", () => {
  const ok = createDemandStore({});
  const a = handOff(ok, newDemand(ok));
  ok.onTerminalExit("academi-phd", "t1", 0);
  assert.equal(ok.get(a.id).status, "done");

  const bad = createDemandStore({});
  const b = handOff(bad, newDemand(bad));
  bad.onTerminalExit("academi-phd", "t1", 1);
  assert.equal(bad.get(b.id).status, "failed");
  assert.equal(bad.get(b.id).error, "exit 1");
});

test("status de terminal sem demanda ativa é ignorado", () => {
  const store = createDemandStore({});
  assert.equal(store.onTerminalStatus("qualquer", "t9", "running", ""), null);
  assert.equal(store.onTerminalExit("qualquer", "t9", 0), null);
});

test("revisão avança e changedSince devolve só o que mudou", () => {
  const store = createDemandStore({});
  const a = newDemand(store);
  const mark = store.revision;
  const b = newDemand(store, { text: "outra coisa" });

  const changed = store.changedSince(mark);
  assert.deepEqual(changed.map((d) => d.id), [b.id]);
  assert.ok(store.changedSince(0).some((d) => d.id === a.id));
});

test("waitForChange acorda na mutação e no timeout", async () => {
  const store = createDemandStore({});
  const before = store.revision;
  const pending = store.waitForChange(before, 1000);
  newDemand(store);
  const after = await pending;
  assert.ok(after > before);

  // o timer do waiter é unref() de propósito (não segura o processo do
  // Cockpit); aqui o loop precisa de algo ref'd para o teste chegar ao fim
  const keepAlive = setTimeout(() => {}, 500);
  const t0 = Date.now();
  await store.waitForChange(store.revision, 60);
  assert.ok(Date.now() - t0 >= 50);
  clearTimeout(keepAlive);

  // revisão já ultrapassada volta na hora
  assert.equal(await store.waitForChange(0, 5000), store.revision);
});

test("persiste, poda e reabre marcando as inacabadas como interrompidas", async () => {
  const filePath = tmpFile();
  // relógio controlado: a demanda velha nasce e fecha 30 dias atrás
  let clock = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const store = createDemandStore({ filePath, maxDemands: 2, now: () => clock });

  const velha = newDemand(store, { text: "demanda velha" });
  store.update(velha.id, { status: "done" });
  clock = Date.now();

  for (const text of ["um", "dois", "tres"]) {
    const d = newDemand(store, { text });
    store.update(d.id, { status: "done" });
  }
  const viva = handOff(store, newDemand(store, { text: "em andamento" }));
  await store.flushNow();

  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const textos = saved.demands.map((d) => d.text);
  assert.ok(!textos.includes("demanda velha"), "descarta o que passou de maxAgeMs");
  assert.equal(saved.demands.filter((d) => d.status === "done").length, 2, "respeita maxDemands");
  assert.ok(textos.includes("em andamento"), "ativas nunca são podadas");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const reaberto = createDemandStore({ filePath });
  reaberto.load();
  const restaurada = reaberto.get(viva.id);
  assert.equal(restaurada.status, "interrupted");
  assert.equal(restaurada.terminalId, null, "vínculo antigo de terminal é descartado");
  assert.deepEqual(reaberto.listActive(), []);
  await store.close();
});

test("arquivo corrompido não derruba o store", () => {
  const filePath = tmpFile();
  fs.writeFileSync(filePath, "{ isso não é json");
  const store = createDemandStore({ filePath });
  assert.doesNotThrow(() => store.load());
  assert.deepEqual(store.list(), []);
});

test("mutações durante a escrita não se perdem", async () => {
  const filePath = tmpFile();
  const store = createDemandStore({ filePath });
  const a = newDemand(store, { text: "primeira" });
  const pending = store.flushNow();
  const b = newDemand(store, { text: "segunda" });
  store.update(a.id, { status: "done" });
  await pending;
  await store.flushNow();

  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const ids = saved.demands.map((d) => d.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id));
  assert.equal(saved.demands.find((d) => d.id === a.id).status, "done");
  await store.close();
});
