/**
 * Worker de coleta de uso — o ÚNICO escritor do `usage.db`.
 *
 * Por que uma thread separada: `node:sqlite` é síncrono e cada COMMIT com fsync
 * bloqueia por 1–20 ms. No processo principal, com PTYs em streaming, isso vira
 * gagueira visível ao digitar no terminal. Aqui o pior caso é o worker atrasar a
 * si mesmo. O `server.js` abre o mesmo arquivo com `readOnly: true` — o WAL permite
 * 1 escritor e N leitores concorrentes.
 *
 * Protocolo (main → worker): projects | scan_now | sync_now | refresh_prices | stop
 * Protocolo (worker → main): ready | progress | scan_done | prices | sync | error
 */

import path from "path";
import { parentPort, workerData } from "worker_threads";

import { UsageDb } from "./db.js";
import { PriceBook, PriceUpdater } from "./prices.js";
import { ProjectResolver, UsageReader } from "./reader.js";
import { UsageSync } from "./sync.js";

const SCAN_INTERVAL_MS = 20_000;
const PRICE_INTERVAL_MS = 6 * 60 * 60 * 1000; // o TTL de 24 h decide de fato; isto só reavalia
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const {
  dbPath,
  homeDir,
  cachePath = path.join(homeDir, ".cockpit", "cache", "model_prices.json"),
  projects = [],
  scanIntervalMs = SCAN_INTERVAL_MS,
  syncIntervalMs = SYNC_INTERVAL_MS,
  appVersion = "cockpit",
  sendProjectPaths = false,
} = workerData ?? {};

const post = (message) => parentPort?.postMessage(message);

const db = new UsageDb({ dbPath }).open();
const priceUpdater = new PriceUpdater({ db, cachePath });
const priceBook = new PriceBook({ db });
const reader = new UsageReader({
  db,
  homeDir,
  priceBook,
  projectResolver: new ProjectResolver(projects, { db, homeDir }),
});
const sync = new UsageSync({ db, homeDir, appVersion, sendProjectPaths });

let scanning = false;
let sincronizando = false;
let pararSolicitado = false;
let scanTimer = null;
let priceTimer = null;
let syncTimer = null;
let nomesDeProjeto = projects;

/**
 * Reprecifica eventos que ficaram sem custo — acontece quando um modelo novo aparece
 * antes de entrar na tabela do LiteLLM. Sem isso, o custo daquele período ficaria
 * eternamente subestimado mesmo depois do preço chegar.
 */
function reprecificarPendentes() {
  const pendentes = db.unpricedEvents(5000);
  if (!pendentes.length) return 0;

  const atualizados = [];
  for (const row of pendentes) {
    const evento = db.raw
      .prepare(`SELECT id, model, hour_utc, project_id, provider, input_tokens, cache_read_tokens,
                       cache_write_5m_tokens, cache_write_1h_tokens, output_tokens
                  FROM events WHERE id = ?`)
      .get(row.id);
    const preco = priceBook.priceEvent(evento);
    if (preco.cost_usd === null) continue;
    atualizados.push({ ...evento, ...preco });
  }
  if (!atualizados.length) return 0;
  db.applyPricing(atualizados);
  return atualizados.length;
}

async function atualizarPrecos({ force = false } = {}) {
  try {
    const resultado = await priceUpdater.refresh({ force });
    priceBook.reload();
    const reprecificados = reprecificarPendentes();
    post({ type: "prices", ...resultado, reprecificados });
    return resultado;
  } catch (error) {
    post({ type: "error", scope: "prices", message: String(error?.message ?? error) });
    return null;
  }
}

function varrer({ motivo = "timer" } = {}) {
  if (scanning || pararSolicitado) return;
  scanning = true;
  const iniciadoEm = Date.now();
  try {
    const stats = reader.runOnce({
      onProgress: (progresso) => post({ type: "progress", ...progresso }),
    });
    post({
      type: "scan_done",
      motivo,
      ...stats,
      durationMs: Date.now() - iniciadoEm,
      pendingSync: db.pendingCount(),
      totalEvents: db.countEvents(),
    });
  } catch (error) {
    post({ type: "error", scope: "scan", message: String(error?.message ?? error) });
  } finally {
    scanning = false;
  }
}

/**
 * Mapa `project_id → {name, path}` para o payload do Control.
 *
 * O `ProjectResolver` guarda só `{id, path}` — quem sabe o nome legível é a lista
 * de projetos do `server.js`, e para os derivados, o `label` do cadastro local.
 * Sem isto o painel mostraria `~220-api` no lugar de `220-api`.
 */
function mapaDeProjetos() {
  const mapa = new Map();
  for (const derivado of db.derivedProjects()) {
    mapa.set(derivado.project_id, { name: derivado.label, path: derivado.path });
  }
  for (const projeto of nomesDeProjeto ?? []) {
    if (projeto?.id) mapa.set(projeto.id, { name: projeto.name ?? projeto.id, path: projeto.path });
  }
  return mapa;
}

/**
 * Envia o que estiver pendente. Só roda depois do backfill: antes disso a fila
 * ainda muda a cada passada e o primeiro envio seria um burst inútil.
 */
async function sincronizar({ motivo = "timer", force = false } = {}) {
  if (sincronizando || pararSolicitado) return null;
  if (!db.getMeta("backfill_done_at")) return null;
  sincronizando = true;
  try {
    const resultado = await sync.runOnce({ projectNames: mapaDeProjetos(), force });
    // `backoff` e `idle` são o estado normal na maior parte do tempo; avisar o
    // main a cada 5 min só encheria o log.
    if (resultado.status !== "idle" && resultado.status !== "backoff") {
      post({ type: "sync", motivo, ...resultado });
    }
    return resultado;
  } catch (error) {
    post({ type: "error", scope: "sync", message: String(error?.message ?? error) });
    return null;
  } finally {
    sincronizando = false;
  }
}

async function iniciar() {
  const primeiraVez = !db.getMeta("backfill_done_at");
  await atualizarPrecos();

  post({
    type: "ready",
    dbPath,
    roots: reader.roots.map((r) => ({ tag: r.tag, dir: r.dir })),
    backfill: primeiraVez,
    totalEvents: db.countEvents(),
  });

  varrer({ motivo: primeiraVez ? "backfill" : "inicial" });

  if (primeiraVez) {
    db.setMeta("backfill_done_at", String(Date.now()));
    // O WAL cresce muito no backfill; truncar aqui devolve o espaço de uma vez.
    db.checkpoint();
    post({ type: "backfill_done", totalEvents: db.countEvents() });
  }

  scanTimer = setInterval(() => varrer(), scanIntervalMs);
  scanTimer.unref?.();
  priceTimer = setInterval(() => { atualizarPrecos(); }, PRICE_INTERVAL_MS);
  priceTimer.unref?.();
  syncTimer = setInterval(() => { sincronizar(); }, syncIntervalMs);
  syncTimer.unref?.();
  sincronizar({ motivo: "inicial" });
}

parentPort?.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "projects":
      // Projeto criado, removido ou com caminho alterado: as regras mudam e os eventos
      // que ficaram sem dono podem agora ter um.
      nomesDeProjeto = msg.projects ?? [];
      reader.setProjects(nomesDeProjeto);
      reatribuirSemProjeto();
      break;
    case "scan_now":
      varrer({ motivo: "manual" });
      break;
    case "sync_now":
      sincronizar({ motivo: "manual", force: true });
      break;
    case "refresh_prices":
      atualizarPrecos({ force: true });
      break;
    case "stop":
      pararSolicitado = true;
      clearInterval(scanTimer);
      clearInterval(priceTimer);
      clearInterval(syncTimer);
      try { db.checkpoint(); } catch {}
      try { db.close(); } catch {}
      post({ type: "stopped" });
      break;
    default:
      break;
  }
});

/**
 * Reatribui eventos sem dono definitivo depois que a lista de projetos muda.
 *
 * Alcança duas categorias: os órfãos ('__none__') e os de projeto derivado ('~…'),
 * porque cadastrar no Cockpit um repositório que já vinha sendo medido deve migrar
 * o histórico dele para o id oficial. Eventos já atribuídos a um projeto do Cockpit
 * ficam onde estão — é o que se espera se o projeto for renomeado ou movido.
 */
function reatribuirSemProjeto() {
  const orfaos = db.raw
    .prepare(`SELECT id, cwd, hour_utc, provider, model, project_id FROM events
               WHERE (project_id = '__none__' OR project_id LIKE '~%')
                 AND cwd IS NOT NULL LIMIT 20000`)
    .all();
  if (!orfaos.length) return 0;

  const update = db.raw.prepare("UPDATE events SET project_id = ? WHERE id = ?");
  const movidos = [];
  db.transaction(() => {
    for (const evento of orfaos) {
      const projectId = reader.projectResolver.resolve(evento.cwd);
      if (projectId === evento.project_id) continue;
      update.run(projectId, evento.id);
      // Os dois buckets ficam sujos: o de origem perde as métricas, o destino ganha.
      movidos.push({ hour_utc: evento.hour_utc, project_id: evento.project_id, provider: evento.provider, model: evento.model });
      movidos.push({ hour_utc: evento.hour_utc, project_id: projectId, provider: evento.provider, model: evento.model });
    }
    if (movidos.length) db.markHoursDirty(movidos);
  });

  if (movidos.length) {
    while (db.pendingDirtyCount() > 0 && db.rollupDirty()) { /* drena */ }
    post({ type: "reassigned", events: movidos.length / 2 });
  }
  return movidos.length / 2;
}

iniciar().catch((error) => {
  post({ type: "error", scope: "start", message: String(error?.message ?? error) });
});
