/**
 * Fachada do coletor de uso para o `server.js`.
 *
 * Dono do worker (único escritor) e de uma conexão `readOnly` para as consultas da UI.
 * O leitor é aberto sob demanda: no primeiro boot o arquivo do banco só existe depois
 * que o worker roda, e abrir `readOnly` num arquivo inexistente falha.
 *
 * Tudo aqui é best-effort: se o worker não subir, o Cockpit continua funcionando sem
 * métricas. Nenhuma falha de coleta pode derrubar terminal.
 */

import os from "os";
import path from "path";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";

import { HOUR_MS, UsageDb, hourOf } from "./db.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));

export function defaultDbPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".cockpit", "usage.db");
}

export function createUsageService({
  homeDir = os.homedir(),
  dbPath = defaultDbPath(homeDir),
  appVersion = "cockpit",
  sendProjectPaths = false,
  log = console,
  onEvent = null,
} = {}) {
  let worker = null;
  let reader = null;
  let readerFalhou = false;

  const state = {
    running: false,
    ready: false,
    backfilling: false,
    lastScan: null,
    lastError: null,
    progress: null,
    prices: null,
    totalEvents: 0,
    pendingSync: 0,
    lastSync: null,
    roots: [],
  };

  function leitor() {
    if (reader) return reader;
    if (readerFalhou) return null;
    try {
      reader = new UsageDb({ dbPath, readOnly: true }).open();
      return reader;
    } catch {
      // Ainda não existe: tentaremos de novo na próxima consulta, sem poluir o log.
      return null;
    }
  }

  function tratarMensagem(msg) {
    switch (msg?.type) {
      case "ready":
        state.ready = true;
        state.roots = msg.roots ?? [];
        state.backfilling = Boolean(msg.backfill);
        state.totalEvents = msg.totalEvents ?? 0;
        log.log?.(
          `\x1b[36m▸ uso\x1b[0m coletor ativo · ${state.roots.length} fontes · ${state.totalEvents} eventos`
          + (state.backfilling ? " · backfill inicial em curso" : ""),
        );
        break;
      case "progress":
        state.progress = msg;
        break;
      case "scan_done":
        state.lastScan = msg;
        state.progress = null;
        state.totalEvents = msg.totalEvents ?? state.totalEvents;
        state.pendingSync = msg.pendingSync ?? 0;
        break;
      case "backfill_done":
        state.backfilling = false;
        state.totalEvents = msg.totalEvents ?? state.totalEvents;
        log.log?.(`\x1b[36m▸ uso\x1b[0m backfill concluído · ${state.totalEvents} eventos`);
        break;
      case "prices":
        state.prices = msg;
        break;
      case "sync":
        state.lastSync = { ...msg, at: Date.now() };
        if (typeof msg.remaining === "number") state.pendingSync = msg.remaining;
        if (msg.status === "sent") {
          log.log?.(
            `\x1b[36m▸ uso\x1b[0m enviados ${msg.sent} bucket(s) ao Control`
            + (msg.remaining ? ` · ${msg.remaining} na fila` : ""),
          );
        }
        break;
      case "error":
        state.lastError = { scope: msg.scope, message: msg.message, at: Date.now() };
        log.warn?.(`[cockpit/uso] ${msg.scope}: ${msg.message}`);
        break;
      default:
        break;
    }
    onEvent?.(msg);
  }

  return {
    get state() {
      return { ...state };
    },

    start({ projects = [] } = {}) {
      if (worker) return true;
      try {
        worker = new Worker(WORKER_PATH, {
          workerData: { dbPath, homeDir, projects, appVersion, sendProjectPaths },
        });
        worker.on("message", tratarMensagem);
        worker.on("error", (error) => {
          state.lastError = { scope: "worker", message: error.message, at: Date.now() };
          log.warn?.(`[cockpit/uso] worker caiu: ${error.message}`);
        });
        worker.on("exit", () => {
          worker = null;
          state.running = false;
          state.ready = false;
        });
        // Não segura o processo: o Cockpit fecha sem esperar a coleta.
        worker.unref();
        state.running = true;
        return true;
      } catch (error) {
        worker = null;
        state.lastError = { scope: "start", message: error.message, at: Date.now() };
        log.warn?.(`[cockpit/uso] coletor indisponível: ${error.message}`);
        return false;
      }
    },

    async stop() {
      if (!worker) return;
      const alvo = worker;
      alvo.postMessage({ type: "stop" });
      // Curto de propósito: o WAL já é durável, então esperar não protege nada.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        alvo.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      try { await alvo.terminate(); } catch {}
      worker = null;
      state.running = false;
      try { reader?.close(); } catch {}
      reader = null;
    },

    setProjects(projects) {
      worker?.postMessage({ type: "projects", projects });
    },

    scanNow() {
      worker?.postMessage({ type: "scan_now" });
    },

    refreshPrices() {
      worker?.postMessage({ type: "refresh_prices" });
    },

    /** Força uma tentativa de envio, ignorando o backoff em curso. */
    syncNow() {
      worker?.postMessage({ type: "sync_now" });
    },

    /**
     * Consulta agregada para a UI.
     * @param {{days?: number, hours?: number, now?: number}} options
     */
    stats({ days = 1, hours = null, now = Date.now() } = {}) {
      const db = leitor();
      if (!db) {
        return { available: false, status: this.status() };
      }
      const span = hours ?? days * 24;
      const to = hourOf(now);
      const from = to - Math.max(0, span - 1);
      try {
        return {
          available: true,
          from,
          to,
          fromMs: from * HOUR_MS,
          toMs: (to + 1) * HOUR_MS,
          totals: db.totals(from, to),
          byProject: db.totalsByProject(from, to),
          byModel: db.totalsByModel(from, to),
          series: db.seriesByHour(from, to),
          unpriced: db.unpricedModels(from, to),
          status: this.status(),
        };
      } catch (error) {
        // O banco pode estar sendo recriado; devolver erro é melhor que derrubar o WS.
        readerFalhou = false;
        try { reader?.close(); } catch {}
        reader = null;
        return { available: false, error: error.message, status: this.status() };
      }
    },

    status() {
      return {
        running: state.running,
        ready: state.ready,
        backfilling: state.backfilling,
        totalEvents: state.totalEvents,
        pendingSync: state.pendingSync,
        lastSync: state.lastSync,
        progress: state.progress,
        lastScanAt: state.lastScan?.durationMs ? Date.now() : null,
        lastError: state.lastError,
        prices: state.prices ? { status: state.prices.status, count: state.prices.count } : null,
        roots: state.roots,
      };
    },
  };
}
