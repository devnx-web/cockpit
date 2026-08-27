// Registro de demandas — o que foi pedido ao orquestrador, para qual projeto,
// em qual terminal, e como está indo.
//
// Não há heurística nova aqui: o status de terminal continua sendo decidido por
// `updateTerminalStatus` no server. A demanda *deriva* dele. Isso mantém uma
// fonte de verdade só e evita duas leituras divergentes do mesmo scrollback.
//
// Persistência é best-effort: o arquivo é conveniência entre reinícios, não
// banco. Se ele estiver corrompido, o store sobe vazio em vez de derrubar o app.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEMAND_SCHEMA_VERSION = 1;

/** Estados que fecham a demanda. Nenhum outro impede uma mudança posterior. */
export const TERMINAL_DEMAND_STATUSES = Object.freeze([
  "done",
  "failed",
  "interrupted",
]);

const DEFAULT_MAX_DEMANDS = 200;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 500;
const TEXT_MAX_CHARS = 4000;
const TITLE_MAX_CHARS = 80;

function isTerminalStatus(status) {
  return TERMINAL_DEMAND_STATUSES.includes(status);
}

function clampText(value, max) {
  return String(value ?? "")
    .replace(/\r\n?/g, " ")
    .replace(/\u0000/g, "")
    .slice(0, max);
}

function terminalKey(projectId, terminalId) {
  return `${projectId}/${terminalId}`;
}

/**
 * Traduz o status de um terminal para o status da demanda que o ocupa.
 * Devolve null quando a mudança não deve mexer na demanda.
 */
export function demandStatusFromTerminal(status, statusText = "") {
  if (status === "running") return "working";
  if (status === "waiting") return "waiting";
  if (status === "error") return "error";
  if (status === "idle") {
    // "pausado" é só uma pausa curta entre saídas — encerrar aqui faria a
    // demanda piscar entre done e working a cada bloco impresso pelo agente.
    if (/ocioso/i.test(statusText)) return "done";
    return null;
  }
  return null;
}

export function createDemandStore({
  filePath,
  maxDemands = DEFAULT_MAX_DEMANDS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  /** @type {Map<string, object>} */
  const demands = new Map();
  /** id do terminal → id da demanda ativa nele */
  const activeByTerminal = new Map();
  const waiters = [];

  let revision = 0;
  let dirty = false;
  let flushTimer = null;
  let writeQueue = Promise.resolve();
  let closed = false;

  function bumpRevision() {
    revision += 1;
    while (waiters.length > 0) {
      const waiter = waiters.pop();
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer || closed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }

  function touched(demand) {
    demand.revision = revision + 1;
    demand.lastChangeAt = now();
    bumpRevision();
    scheduleFlush();
    return demand;
  }

  function prune(list) {
    const cutoff = now() - maxAgeMs;
    const active = list.filter((d) => !isTerminalStatus(d.status));
    const ended = list
      .filter((d) => isTerminalStatus(d.status))
      .filter((d) => !d.endedAt || d.endedAt >= cutoff)
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
      .slice(0, maxDemands);
    return [...active, ...ended].sort((a, b) => a.createdAt - b.createdAt);
  }

  function serialize() {
    return JSON.stringify(
      {
        schemaVersion: DEMAND_SCHEMA_VERSION,
        revision,
        demands: prune(Array.from(demands.values())),
      },
      null,
      2,
    );
  }

  function writeAtomic(body) {
    if (!filePath) return Promise.resolve();
    const tmp = `${filePath}.${process.pid}.tmp`;
    return fs.promises
      .writeFile(tmp, body, { encoding: "utf8", mode: 0o600 })
      .then(() => fs.promises.rename(tmp, filePath))
      .catch((err) => {
        log(`[demands] falha ao salvar: ${err.message}`);
        fs.promises.unlink(tmp).catch(() => {});
      });
  }

  // A serialização é síncrona de propósito: congela o snapshot antes de
  // devolver o controle, então uma mutação que chegue durante a escrita só
  // marca `dirty` de novo em vez de embaralhar o JSON já em voo.
  function flush() {
    if (!filePath) {
      dirty = false;
      return writeQueue;
    }
    const body = serialize();
    dirty = false;
    writeQueue = writeQueue.then(() => writeAtomic(body)).then(() => {
      if (dirty && !closed) scheduleFlush();
    });
    return writeQueue;
  }

  function load() {
    demands.clear();
    activeByTerminal.clear();
    if (!filePath) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        log(`[demands] arquivo ilegível, começando vazio: ${err.message}`);
      }
      return;
    }
    if (!parsed || !Array.isArray(parsed.demands)) return;
    revision = Number.isInteger(parsed.revision) ? parsed.revision : 0;
    for (const raw of parsed.demands) {
      if (!raw || typeof raw.id !== "string") continue;
      const demand = { ...raw };
      // Ids de terminal reiniciam em "t1" a cada boot: manter o vínculo faria a
      // demanda velha reagir ao terminal novo de outra pessoa.
      demand.terminalId = null;
      if (!isTerminalStatus(demand.status)) {
        demand.status = "interrupted";
        demand.statusText = "o Cockpit reiniciou antes de terminar";
        demand.endedAt = demand.endedAt || now();
      }
      demands.set(demand.id, demand);
    }
  }

  function create({
    text,
    title = "",
    projectId,
    projectName = "",
    agentLabel = "",
    agentCmd = "",
    requestId = null,
  }) {
    const at = now();
    const demand = {
      id: randomUUID(),
      revision: revision + 1,
      text: clampText(text, TEXT_MAX_CHARS),
      title: clampText(title || text, TITLE_MAX_CHARS),
      projectId,
      projectName,
      terminalId: null,
      terminalName: "",
      agentLabel,
      agentCmd,
      status: "queued",
      statusText: "na fila",
      stage: "queued",
      requestId,
      error: null,
      createdAt: at,
      dispatchedAt: null,
      lastChangeAt: at,
      endedAt: null,
    };
    demands.set(demand.id, demand);
    touched(demand);
    return demand;
  }

  function get(id) {
    return demands.get(id) || null;
  }

  function list() {
    return Array.from(demands.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  function listActive() {
    return list().filter((d) => !isTerminalStatus(d.status));
  }

  function changedSince(afterRevision = 0) {
    return list().filter((d) => (d.revision || 0) > afterRevision);
  }

  function setStatus(demand, status, statusText) {
    demand.status = status;
    if (statusText !== undefined) demand.statusText = statusText;
    if (isTerminalStatus(status)) {
      demand.endedAt = demand.endedAt || now();
      if (demand.terminalId) {
        const key = terminalKey(demand.projectId, demand.terminalId);
        if (activeByTerminal.get(key) === demand.id) activeByTerminal.delete(key);
      }
    } else {
      demand.endedAt = null;
    }
  }

  /**
   * Atualiza uma demanda. Uma vez fechada (done/failed/interrupted) ela não
   * volta atrás — o terminal continua vivo e seguiria emitindo status.
   */
  function update(id, patch = {}) {
    const demand = demands.get(id);
    if (!demand) return null;
    if (isTerminalStatus(demand.status)) return demand;

    for (const [key, value] of Object.entries(patch)) {
      if (key === "status" || key === "statusText") continue;
      demand[key] = value;
    }
    if (patch.terminalId) {
      activeByTerminal.set(terminalKey(demand.projectId, patch.terminalId), demand.id);
    }
    if (patch.status) setStatus(demand, patch.status, patch.statusText);
    else if (patch.statusText !== undefined) demand.statusText = patch.statusText;

    return touched(demand);
  }

  function activeFor(projectId, terminalId) {
    const id = activeByTerminal.get(terminalKey(projectId, terminalId));
    if (!id) return null;
    const demand = demands.get(id);
    if (!demand || isTerminalStatus(demand.status)) return null;
    return demand;
  }

  function onTerminalStatus(projectId, terminalId, status, statusText = "") {
    const demand = activeFor(projectId, terminalId);
    if (!demand) return null;
    // Antes do handoff o terminal ainda está subindo o agente: o banner de boot
    // costuma casar com ERROR_PATTERNS e marcaria erro numa demanda que nem
    // chegou a ser entregue.
    if (demand.stage !== "handed_off") return null;

    const next = demandStatusFromTerminal(status, statusText);
    if (!next || next === demand.status) return null;
    return update(demand.id, { status: next, statusText });
  }

  function onTerminalExit(projectId, terminalId, exitCode) {
    const demand = activeFor(projectId, terminalId);
    if (!demand) return null;
    const ok = exitCode === 0;
    return update(demand.id, {
      status: ok ? "done" : "failed",
      statusText: ok ? "terminal encerrado" : `terminal falhou (exit ${exitCode})`,
      error: ok ? null : `exit ${exitCode}`,
    });
  }

  function waitForChange(afterRevision = 0, waitMs = 0) {
    if (revision > afterRevision || waitMs <= 0) return Promise.resolve(revision);
    return new Promise((resolve) => {
      const waiter = { resolve: () => resolve(revision) };
      waiter.timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        resolve(revision);
      }, waitMs);
      waiter.timer.unref?.();
      waiters.push(waiter);
    });
  }

  async function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();
    await writeQueue;
  }

  async function close() {
    closed = true;
    await flushNow();
    while (waiters.length > 0) {
      const waiter = waiters.pop();
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  return {
    get revision() {
      return revision;
    },
    get filePath() {
      return filePath;
    },
    load,
    create,
    get,
    update,
    list,
    listActive,
    activeFor,
    changedSince,
    onTerminalStatus,
    onTerminalExit,
    waitForChange,
    flushNow,
    close,
  };
}

export function defaultDemandsPath(projectsPath) {
  return path.join(path.dirname(projectsPath), "demands.json");
}
