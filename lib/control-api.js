import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { findProjects } from "./project-search.js";
import { defaultRuntimeDir } from "./runtime-dir.js";

export const CONTROL_API_PREFIX = "/internal/control/v1";
export const CONTROL_API_VERSION = "1";
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_WAIT_MS = 30_000;
export const MAX_INPUT_CHARS = 8192;

const JSON_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// "dispatch" é create+input compostos: a rota exige as três, senão despachar
// seria um jeito de furar uma política que nega escrever em terminal.
const CAPABILITIES = new Set(["read", "create", "input", "interrupt", "dispatch"]);
const MAX_DEMANDS_PER_PAGE = 50;
const MAX_SEARCH_RESULTS = 10;
const TERMINAL_ACCESS = new Set(["owned", "all"]);
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 512;

class ControlHttpError extends Error {
  constructor(statusCode, code, message, data = undefined) {
    super(message);
    this.name = "ControlHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.data = data;
  }
}

function publicError(error) {
  if (error instanceof ControlHttpError) return error;
  return new ControlHttpError(
    503,
    "CONTROL_UNAVAILABLE",
    "controle do Cockpit indisponível",
  );
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...JSON_HEADERS,
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, instanceId, error) {
  const safe = publicError(error);
  const payload = {
    ok: false,
    instanceId,
    error: {
      code: safe.code,
      message: String(safe.message || "requisição inválida")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 240),
    },
  };
  if (safe.data !== undefined) payload.data = safe.data;
  sendJson(
    res,
    safe.statusCode,
    payload,
    safe.statusCode === 401
      ? { "WWW-Authenticate": 'Bearer realm="cockpit-control"' }
      : {},
  );
}

function isLoopbackAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function constantTimeTokenEqual(expected, provided) {
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  const providedHash = crypto
    .createHash("sha256")
    .update(provided || "")
    .digest();
  return crypto.timingSafeEqual(expectedHash, providedHash);
}

function parseBearer(header) {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(String(header || ""));
  return match?.[1] || null;
}

function parseInteger(value, fallback, { min, max, name }) {
  if (value === null || value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new ControlHttpError(400, "INVALID_REQUEST", `${name} inválido`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ControlHttpError(400, "INVALID_REQUEST", `${name} inválido`);
  }
  return parsed;
}

function readJsonBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        tooLarge = true;
        raw = "";
      } else if (!tooLarge) {
        raw += chunk;
      }
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) {
        reject(
          new ControlHttpError(
            413,
            "OUTPUT_LIMIT_EXCEEDED",
            "corpo da requisição muito grande",
          ),
        );
        return;
      }
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(
          new ControlHttpError(400, "INVALID_REQUEST", "JSON inválido"),
        );
      }
    });
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function actionFingerprint(method, pathname, body) {
  return crypto
    .createHash("sha256")
    .update(`${method}\n${pathname}\n${JSON.stringify(stableValue(body))}`)
    .digest("hex");
}

function sanitizeName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.slice(0, 120) || fallback;
}

function safeProject(project) {
  return {
    id: String(project.id),
    name: String(project.name || project.id),
    color: typeof project.color === "string" ? project.color : null,
  };
}

// Candidato de busca: o suficiente para o orquestrador confirmar que é o
// projeto certo. Nunca `path`, `env` ou `shell` — nada disso ajuda a decidir e
// tudo isso vaza a máquina. Fica separado de `safeProject` de propósito: o
// cliente MCP sanitiza a lista de projetos campo a campo e descartaria o resto.
function safeProjectCandidate(entry, { busyTerminals = 0, freeTerminals = 0, activeDemands = 0 } = {}) {
  const project = entry.project;
  return {
    id: String(project.id),
    name: String(project.name || project.id),
    color: typeof project.color === "string" ? project.color : null,
    description: typeof project.description === "string" ? project.description : "",
    aliases: Array.isArray(project.aliases) ? project.aliases.map(String).slice(0, 12) : [],
    stack: Array.isArray(project.stack) ? project.stack.map(String).slice(0, 12) : [],
    defaultAgent: typeof project.defaultAgent === "string" ? project.defaultAgent : "",
    hasDescription: Boolean(String(project.description || "").trim()),
    score: Number(entry.score) || 0,
    matchedOn: Array.isArray(entry.matchedOn) ? entry.matchedOn.map(String) : [],
    busyTerminals,
    freeTerminals,
    activeDemands,
  };
}

// `text` fica de fora: o pedido inteiro só volta em `cockpit_list_demands`,
// que o passa pelo envelope de texto não confiável.
function safeDemand(demand) {
  return {
    id: String(demand.id),
    title: String(demand.title || ""),
    projectId: String(demand.projectId || ""),
    projectName: String(demand.projectName || ""),
    terminalId: demand.terminalId ? String(demand.terminalId) : null,
    terminalName: String(demand.terminalName || ""),
    agentLabel: String(demand.agentLabel || ""),
    status: String(demand.status || "unknown"),
    statusText: String(demand.statusText || ""),
    stage: String(demand.stage || ""),
    error: demand.error ? String(demand.error) : null,
    createdAt: Number(demand.createdAt) || 0,
    lastChangeAt: Number(demand.lastChangeAt) || 0,
    endedAt: Number(demand.endedAt) || null,
  };
}

function safeTerminal(terminal) {
  return {
    id: String(terminal.id),
    name: String(terminal.name || terminal.id),
    status: String(terminal.status || "unknown"),
    statusText:
      typeof terminal.statusText === "string" ? terminal.statusText : "",
    exited: terminal.exited === true,
    exitCode: Number.isInteger(terminal.exitCode) ? terminal.exitCode : null,
  };
}

export function sanitizeTerminalOutput(value) {
  return String(value ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-2A-B]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function takeUtf8Prefix(value, maxBytes) {
  if (!value || maxBytes <= 0) return { text: "", chars: 0, bytes: 0 };
  let chars = 0;
  let bytes = 0;
  for (const symbol of value) {
    const symbolBytes = Buffer.byteLength(symbol, "utf8");
    if (bytes + symbolBytes > maxBytes) break;
    chars += symbol.length;
    bytes += symbolBytes;
  }
  return { text: value.slice(0, chars), chars, bytes };
}

function cursorFor(instanceId, terminal, sequence, offset = 0) {
  return [
    "terminal",
    instanceId,
    "generation",
    terminal.controlGeneration,
    "sequence",
    sequence,
    "offset",
    offset,
  ].join(":");
}

function parseCursor(instanceId, terminal, value) {
  if (value === null || value === undefined || value === "") {
    const first = terminal.outputEvents?.[0];
    return {
      sequence: first ? first.sequence - 1 : terminal.outputSequence || 0,
      offset: 0,
    };
  }
  if (typeof value !== "string" || value.length > 512) {
    throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado");
  }
  const match =
    /^terminal:([0-9a-f-]+):generation:([0-9a-f-]+):sequence:(\d+):offset:(\d+)$/i.exec(
      value,
    );
  if (
    !match ||
    match[1] !== instanceId ||
    match[2] !== terminal.controlGeneration
  ) {
    throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado");
  }
  const sequence = Number(match[3]);
  const offset = Number(match[4]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(offset)) {
    throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado");
  }
  const first = terminal.outputEvents?.[0];
  const earliestSequence = first
    ? first.sequence - 1
    : terminal.outputSequence || 0;
  if (
    sequence < earliestSequence ||
    sequence > (terminal.outputSequence || 0)
  ) {
    throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado", {
      earliestCursor: cursorFor(
        instanceId,
        terminal,
        earliestSequence,
        0,
      ),
    });
  }
  if (offset > 0) {
    const target = terminal.outputEvents?.find(
      (event) => event.sequence === sequence + 1,
    );
    if (!target || offset > sanitizeTerminalOutput(target.data).length) {
      throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado");
    }
  }
  return { sequence, offset };
}

export function readTerminalEvents(
  instanceId,
  terminal,
  { after = null, maxBytes = DEFAULT_MAX_OUTPUT_BYTES } = {},
) {
  const start = parseCursor(instanceId, terminal, after);
  const outputEvents = terminal.outputEvents || [];
  let sequence = start.sequence;
  let offset = start.offset;
  let remaining = maxBytes;
  const events = [];

  for (const stored of outputEvents) {
    if (stored.sequence <= sequence) continue;
    if (stored.sequence > sequence + 1 && offset > 0) {
      throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado");
    }
    const sanitized = sanitizeTerminalOutput(stored.data);
    const initialOffset =
      stored.sequence === sequence + 1 ? Math.min(offset, sanitized.length) : 0;
    const rest = sanitized.slice(initialOffset);
    if (!rest) {
      sequence = stored.sequence;
      offset = 0;
      continue;
    }
    const taken = takeUtf8Prefix(rest, remaining);
    if (!taken.text) {
      throw new ControlHttpError(
        413,
        "OUTPUT_LIMIT_EXCEEDED",
        "max_bytes é menor que o próximo caractere UTF-8",
      );
    }
    const completed = initialOffset + taken.chars >= sanitized.length;
    if (completed) {
      sequence = stored.sequence;
      offset = 0;
    } else {
      sequence = stored.sequence - 1;
      offset = initialOffset + taken.chars;
    }
    const eventCursor = cursorFor(instanceId, terminal, sequence, offset);
    events.push({
      cursor: eventCursor,
      stream: stored.stream || "stdout",
      data: taken.text,
      ts: stored.ts,
    });
    remaining -= taken.bytes;
    if (remaining <= 0 || !completed) break;
  }

  return {
    cursor: cursorFor(instanceId, terminal, sequence, offset),
    events,
  };
}

export function appendControlOutputEvent(
  terminal,
  data,
  { stream = "stdout", ts = new Date().toISOString() } = {},
) {
  const value = String(data || "");
  if (!value) return;
  terminal.outputSequence = (terminal.outputSequence || 0) + 1;
  terminal.outputEvents ||= [];
  terminal.outputEventBytes ||= 0;
  terminal.outputEvents.push({
    sequence: terminal.outputSequence,
    stream,
    data: value,
    ts,
  });
  terminal.outputEventBytes += Buffer.byteLength(value, "utf8");
  const maxBytes = terminal.maxBufferSize || 200 * 1024;
  while (
    terminal.outputEventBytes > maxBytes &&
    terminal.outputEvents.length > 1
  ) {
    const removed = terminal.outputEvents.shift();
    terminal.outputEventBytes -= Buffer.byteLength(removed.data, "utf8");
  }
}

/**
 * `projects: "all"` libera qualquer projeto do catálogo, inclusive os criados
 * depois. Uma lista explícita continua sendo lista explícita — quem restringiu
 * quis restringir —, mas ela deixou de ser filtrada pelo catálogo do boot: um
 * id só entra em vigor quando o projeto passa a existir, e o `requireProject`
 * já devolve 404 enquanto isso. Antes, autorizar um projeto exigia reiniciar o
 * Cockpit na ordem certa, e projeto novo nascia invisível para o MCP.
 */
const TODOS_OS_PROJETOS = Object.freeze({ all: true, has: () => true });

export function normalizeControlPolicy(value, {} = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const requestedProjects = Array.isArray(raw.projects) ? raw.projects : [];
  const projects =
    raw.projects === "all"
      ? TODOS_OS_PROJETOS
      : new Set(
          requestedProjects.map(String).filter((id) => /^[a-z0-9_-]+$/.test(id)),
        );
  const requestedCapabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities
    : ["read"];
  const capabilities = new Set(
    requestedCapabilities.map(String).filter((item) => CAPABILITIES.has(item)),
  );
  capabilities.add("read");
  return {
    enabled: raw.enabled !== false,
    projects,
    capabilities,
    terminalAccess: TERMINAL_ACCESS.has(raw.terminalAccess)
      ? raw.terminalAccess
      : "owned",
  };
}

export function loadControlPolicy(policyPath, { log = console } = {}) {
  if (!policyPath) return normalizeControlPolicy({});
  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    return normalizeControlPolicy(parsed);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log.warn?.(
        `[cockpit/control] política inválida; usando negação padrão: ${error.message}`,
      );
    }
    return normalizeControlPolicy({});
  }
}

/**
 * Política que se relê sozinha quando o arquivo muda.
 *
 * O Cockpit fica aberto por dias com agentes trabalhando dentro dele: exigir um
 * restart para liberar um projeto significa matar todo mundo para mudar uma
 * linha de JSON. A conferência é um `statSync` por requisição — barato — e um
 * arquivo quebrado no meio da escrita mantém a política anterior no ar em vez
 * de derrubar o acesso para negação total.
 */
export function createControlPolicySource(policyPath, { log = console } = {}) {
  let atual = loadControlPolicy(policyPath, { log });
  let marca = assinatura();

  function assinatura() {
    if (!policyPath) return "";
    try {
      const st = fs.statSync(policyPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "ausente";
    }
  }

  return () => {
    const agora = assinatura();
    if (agora === marca) return atual;
    marca = agora;
    try {
      const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
      atual = normalizeControlPolicy(parsed);
      log.log?.("[cockpit/control] política recarregada");
    } catch (error) {
      // Aqui a política anterior é mantida de propósito. Um editor que salva em
      // duas etapas, ou uma vírgula a mais, cortaria o acesso de todos os
      // agentes no meio do trabalho — e o susto seria pior que a proteção.
      // Sumiço do arquivo é diferente: aí a intenção é revogar.
      if (error?.code === "ENOENT") {
        atual = normalizeControlPolicy({});
        log.warn?.("[cockpit/control] política removida; acesso revogado");
      } else {
        log.warn?.(
          `[cockpit/control] política inválida; mantendo a anterior: ${error.message}`,
        );
      }
    }
    return atual;
  };
}


export function writeControlDescriptor(
  descriptor,
  { runtimeDir = defaultRuntimeDir() } = {},
) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const descriptorPath = path.join(runtimeDir, "control.json");
  const tempPath = path.join(
    runtimeDir,
    `.control.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify(descriptor, null, 2)}\n`;
  fs.writeFileSync(tempPath, body, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, descriptorPath);
  fs.chmodSync(descriptorPath, 0o600);
  return descriptorPath;
}

export function removeControlDescriptor(descriptorPath, instanceId) {
  if (!descriptorPath) return false;
  try {
    const current = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (current.instanceId !== instanceId) return false;
    fs.unlinkSync(descriptorPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

function terminalAllowed(policy, terminal) {
  return policy.terminalAccess === "all" || terminal.owner === "mcp";
}

function projectCursor(instanceId, projects) {
  const revision = crypto
    .createHash("sha256")
    .update(JSON.stringify(projects))
    .digest("hex")
    .slice(0, 16);
  return `projects:${instanceId}:revision:${revision}`;
}

function terminalsCursor(instanceId, projectId, terminals) {
  const revision = crypto
    .createHash("sha256")
    .update(JSON.stringify(terminals))
    .digest("hex")
    .slice(0, 16);
  return `project:${projectId}:${instanceId}:terminals:${revision}`;
}

function demandsCursor(instanceId, revision) {
  return `demands:${instanceId}:revision:${revision}`;
}

/**
 * Cursor de demandas. Sem cursor significa "só o que mudar a partir de agora" —
 * quem acaba de conectar não quer ser inundado com o histórico inteiro.
 * Cursor de outra instância é recusado, igual ao de terminal.
 */
function parseDemandCursor(value, { instanceId, currentRevision }) {
  if (value === null || value === undefined || value === "") return currentRevision;
  if (typeof value !== "string" || value.length > 512) {
    throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado");
  }
  const match = /^demands:([^:]+):revision:(\d+)$/.exec(value);
  // outra instância = outro Cockpit: as revisões não são comparáveis
  if (!match || match[1] !== instanceId) {
    throw new ControlHttpError(410, "CURSOR_EXPIRED", "cursor expirado");
  }
  return Number(match[2]);
}

function actionEnvelope(instanceId, requestId, data, cursor = undefined) {
  return {
    ok: true,
    instanceId,
    requestId,
    ...(cursor ? { cursor } : {}),
    ack: {
      accepted: true,
      completed: false,
      at: new Date().toISOString(),
    },
    data,
  };
}

export function createControlApi({
  token = crypto.randomBytes(32).toString("base64url"),
  instanceId = crypto.randomUUID(),
  cockpitVersion = "?",
  policy,
  adapter,
  // registro de demandas e despachante: opcionais — sem eles as rotas de
  // orquestração respondem 503 em vez de derrubar o resto do controle
  demands = null,
  dispatcher = null,
  log = console,
} = {}) {
  if (!adapter) throw new TypeError("adapter de controle é obrigatório");
  // `policy` pode ser uma função: é assim que a política recarregada em disco
  // chega até aqui sem que nada guarde uma cópia velha em closure.
  const politica = typeof policy === "function" ? policy : () => policy;
  const primeira = politica();
  if (!primeira?.projects || !primeira?.capabilities) {
    throw new TypeError("política de controle normalizada é obrigatória");
  }
  const idempotency = new Map();

  function requireCapability(capability) {
    const p = politica();
    if (!p.enabled || !p.capabilities.has(capability)) {
      throw new ControlHttpError(
        403,
        "PROJECT_FORBIDDEN",
        "ação fora da política de controle",
      );
    }
  }

  function requireDemands() {
    if (!demands) {
      throw new ControlHttpError(
        503,
        "CONTROL_UNAVAILABLE",
        "registro de demandas indisponível",
      );
    }
    return demands;
  }

  /** Quantos terminais do projeto estão ocupados, livres e com demanda ativa. */
  function projectLoad(projectId) {
    const terminals = adapter
      .listTerminals(projectId)
      .filter((terminal) => !terminal.exited);
    const busy = terminals.filter((terminal) =>
      terminal.status === "running" || terminal.status === "waiting",
    ).length;
    const activeDemands = demands
      ? demands.listActive().filter((demand) => demand.projectId === projectId).length
      : 0;
    return {
      busyTerminals: busy,
      freeTerminals: terminals.length - busy,
      activeDemands,
    };
  }

  function requireProject(projectId) {
    const p = politica();
    if (!p.enabled || !p.projects.has(projectId)) {
      throw new ControlHttpError(
        403,
        "PROJECT_FORBIDDEN",
        "projeto fora da política de controle",
      );
    }
    const project = adapter.getProject(projectId);
    if (!project) {
      throw new ControlHttpError(
        404,
        "PROJECT_NOT_FOUND",
        "projeto não encontrado",
      );
    }
    return project;
  }

  function requireTerminal(projectId, terminalId) {
    requireProject(projectId);
    const terminal = adapter.getTerminal(projectId, terminalId);
    if (!terminal || !terminalAllowed(politica(), terminal)) {
      throw new ControlHttpError(
        404,
        "TERMINAL_NOT_FOUND",
        "terminal não encontrado",
      );
    }
    return terminal;
  }

  function cleanupIdempotency(now = Date.now()) {
    for (const [key, entry] of idempotency) {
      if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) idempotency.delete(key);
    }
    while (idempotency.size >= IDEMPOTENCY_MAX_ENTRIES) {
      idempotency.delete(idempotency.keys().next().value);
    }
  }

  async function executeIdempotent(req, pathname, body, task) {
    const headerId = String(req.headers["idempotency-key"] || "");
    if (
      !UUID_PATTERN.test(headerId) ||
      body.requestId !== headerId ||
      body.confirm !== true
    ) {
      throw new ControlHttpError(
        400,
        "INVALID_REQUEST",
        "requestId, Idempotency-Key e confirm=true são obrigatórios",
      );
    }
    const fingerprint = actionFingerprint(req.method, pathname, body);
    cleanupIdempotency();
    const existing = idempotency.get(headerId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ControlHttpError(
          409,
          "REQUEST_ID_CONFLICT",
          "requestId já usado por outra ação",
        );
      }
      return existing.promise;
    }
    const promise = Promise.resolve().then(task);
    idempotency.set(headerId, {
      createdAt: Date.now(),
      fingerprint,
      promise,
    });
    try {
      return await promise;
    } catch (error) {
      idempotency.delete(headerId);
      throw error;
    }
  }

  async function waitForEvents(terminal, after, maxBytes, waitMs) {
    const initialStatus = `${terminal.status}\0${terminal.statusText}\0${terminal.exited}`;
    const deadline = Date.now() + waitMs;
    do {
      const result = readTerminalEvents(instanceId, terminal, {
        after,
        maxBytes,
      });
      const status = `${terminal.status}\0${terminal.statusText}\0${terminal.exited}`;
      if (result.events.length || status !== initialStatus || waitMs === 0) {
        return { ...result, timedOut: false };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...result, timedOut: true };
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(50, remaining));
        timer.unref?.();
      });
    } while (true);
  }

  async function dispatch(req, parsedUrl) {
    const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    const relative = pathname.slice(CONTROL_API_PREFIX.length);
    const rawSegments = relative.split("/").filter(Boolean);
    let segments;
    try {
      segments = rawSegments.map(decodeURIComponent);
    } catch {
      throw new ControlHttpError(400, "INVALID_REQUEST", "URL inválida");
    }

    if (req.method === "GET" && segments.length === 1 && segments[0] === "health") {
      return {
        statusCode: 200,
        payload: {
          ok: true,
          instanceId,
          data: { version: "v1", cockpitVersion },
        },
      };
    }

    requireCapability("read");
    if (
      req.method === "GET" &&
      segments.length === 1 &&
      segments[0] === "projects"
    ) {
      const projects = adapter
        .listProjects()
        .filter((project) => politica().projects.has(project.id))
        .map(safeProject);
      return {
        statusCode: 200,
        payload: {
          ok: true,
          instanceId,
          cursor: projectCursor(instanceId, projects),
          data: { projects },
        },
      };
    }

    // Busca de projeto: o passo que transforma "manda pra PHD" num id. Sempre
    // filtra pela política antes de pontuar — o que está fora dela não existe.
    if (
      req.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "projects" &&
      segments[1] === "search"
    ) {
      const limit = parseInteger(parsedUrl.searchParams.get("limit"), 5, {
        min: 1,
        max: MAX_SEARCH_RESULTS,
        name: "limit",
      });
      const allowed = adapter
        .listProjects()
        .filter((project) => politica().projects.has(project.id));
      const result = findProjects(allowed, parsedUrl.searchParams.get("q") || "", { limit });
      const candidates = result.candidates.map((entry) =>
        safeProjectCandidate(entry, projectLoad(entry.project.id)),
      );
      return {
        statusCode: 200,
        payload: {
          ok: true,
          instanceId,
          data: { query: result.query, ambiguous: result.ambiguous, candidates },
        },
      };
    }

    // Demandas são globais de propósito: elas cruzam projetos, e o orquestrador
    // quer uma fila só para acompanhar.
    if (req.method === "GET" && segments.length === 1 && segments[0] === "demands") {
      const store = requireDemands();
      const waitMs = parseInteger(parsedUrl.searchParams.get("wait_ms"), 0, {
        min: 0,
        max: MAX_WAIT_MS,
        name: "wait_ms",
      });
      const after = parseDemandCursor(parsedUrl.searchParams.get("after"), {
        instanceId,
        currentRevision: store.revision,
      });
      if (waitMs > 0) await store.waitForChange(after, waitMs);
      const changed = store
        .changedSince(after)
        .filter((demand) => politica().projects.has(demand.projectId))
        .slice(-MAX_DEMANDS_PER_PAGE);
      return {
        statusCode: 200,
        payload: {
          ok: true,
          instanceId,
          cursor: demandsCursor(instanceId, store.revision),
          data: {
            revision: store.revision,
            timedOut: changed.length === 0,
            demands: changed.map(safeDemand),
          },
        },
      };
    }

    const isProjectRoute = segments[0] === "projects" && segments[1];
    if (!isProjectRoute) {
      throw new ControlHttpError(404, "NOT_FOUND", "rota não encontrada");
    }
    const projectId = segments[1];

    if (
      req.method === "GET" &&
      segments.length === 3 &&
      segments[2] === "terminals"
    ) {
      requireProject(projectId);
      const terminals = adapter
        .listTerminals(projectId)
        .filter((terminal) => terminalAllowed(politica(), terminal))
        .map(safeTerminal);
      return {
        statusCode: 200,
        payload: {
          ok: true,
          instanceId,
          cursor: terminalsCursor(instanceId, projectId, terminals),
          data: { terminals },
        },
      };
    }

    if (
      req.method === "GET" &&
      segments.length === 5 &&
      segments[2] === "terminals" &&
      segments[4] === "output"
    ) {
      const terminal = requireTerminal(projectId, segments[3]);
      const maxBytes = parseInteger(
        parsedUrl.searchParams.get("max_bytes"),
        DEFAULT_MAX_OUTPUT_BYTES,
        { min: 1, max: MAX_OUTPUT_BYTES, name: "max_bytes" },
      );
      const waitMs = parseInteger(
        parsedUrl.searchParams.get("wait_ms"),
        0,
        { min: 0, max: MAX_WAIT_MS, name: "wait_ms" },
      );
      const result = await waitForEvents(
        terminal,
        parsedUrl.searchParams.get("after"),
        maxBytes,
        waitMs,
      );
      return {
        statusCode: 200,
        payload: {
          ok: true,
          instanceId,
          cursor: result.cursor,
          data: {
            status: terminal.status,
            statusText: terminal.statusText,
            exited: terminal.exited === true,
            timedOut: result.timedOut,
            events: result.events,
          },
        },
      };
    }

    if (req.method !== "POST") {
      throw new ControlHttpError(405, "METHOD_NOT_ALLOWED", "método não permitido");
    }
    const body = await readJsonBody(req);
    const pathnameKey = parsedUrl.pathname;

    if (
      segments.length === 3 &&
      segments[2] === "terminals"
    ) {
      requireCapability("create");
      return executeIdempotent(req, pathnameKey, body, async () => {
        requireProject(projectId);
        const terminal = await adapter.createTerminal(
          projectId,
          sanitizeName(body.name, "MCP Terminal"),
        );
        const payload = actionEnvelope(
          instanceId,
          body.requestId,
          { terminal: safeTerminal(terminal) },
          cursorFor(instanceId, terminal, 0, 0),
        );
        log.info?.(
          `[cockpit/control] create project=${projectId} terminal=${terminal.id} request=${body.requestId}`,
        );
        return { statusCode: 202, payload };
      });
    }

    // Despacho: abre terminal, sobe o agente e entrega o pedido. Roda em
    // segundo plano — a resposta é 202 e o acompanhamento sai por /demands.
    if (segments.length === 3 && segments[2] === "dispatch") {
      requireCapability("dispatch");
      requireCapability("create");
      requireCapability("input");
      if (!dispatcher) {
        throw new ControlHttpError(503, "CONTROL_UNAVAILABLE", "despacho indisponível");
      }
      const store = requireDemands();
      if (
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > MAX_INPUT_CHARS ||
        body.text.includes("\0")
      ) {
        throw new ControlHttpError(
          400,
          "INVALID_REQUEST",
          "text deve ser texto sem NUL de até 8192 caracteres",
        );
      }
      return executeIdempotent(req, pathnameKey, body, async () => {
        const project = requireProject(projectId);
        let preset;
        try {
          preset = dispatcher.pickAgentPreset(project, body.agent || "");
        } catch (error) {
          // sem preset o certo é perguntar qual agente, não chutar um comando
          throw new ControlHttpError(409, "NO_AGENT_PRESET", error.message);
        }
        const demand = store.create({
          text: body.text,
          title: sanitizeName(body.title, "") || body.text,
          projectId: project.id,
          projectName: project.name || project.id,
          agentLabel: preset.label,
          agentCmd: preset.cmd,
          requestId: body.requestId,
        });
        // sem await: a idempotência memoiza a promise da rota, e segurar o
        // despacho inteiro aqui faria o cliente esperar minutos por um 202
        dispatcher.run(demand, project, preset).catch((error) => {
          store.update(demand.id, {
            status: "failed",
            statusText: error.message,
            error: "DISPATCH_FAILED",
          });
        });
        log.info?.(
          `[cockpit/control] dispatch project=${project.id} agent=${preset.label} demand=${demand.id} request=${body.requestId}`,
        );
        return {
          statusCode: 202,
          payload: actionEnvelope(
            instanceId,
            body.requestId,
            { demand: safeDemand(demand) },
            demandsCursor(instanceId, store.revision),
          ),
        };
      });
    }

    if (
      segments.length === 5 &&
      segments[2] === "terminals" &&
      segments[4] === "input"
    ) {
      requireCapability("input");
      if (
        typeof body.data !== "string" ||
        body.data.length > MAX_INPUT_CHARS ||
        body.data.includes("\0")
      ) {
        throw new ControlHttpError(
          400,
          "INVALID_REQUEST",
          "input deve ser texto sem NUL de até 8192 caracteres",
        );
      }
      return executeIdempotent(req, pathnameKey, body, async () => {
        const terminal = requireTerminal(projectId, segments[3]);
        if (!terminal.pty || terminal.exited) {
          throw new ControlHttpError(
            409,
            "CONTROL_UNAVAILABLE",
            "terminal ainda não aceita input",
          );
        }
        await adapter.writeInput(projectId, terminal.id, body.data);
        const payload = actionEnvelope(
          instanceId,
          body.requestId,
          {},
          cursorFor(instanceId, terminal, terminal.outputSequence || 0, 0),
        );
        log.info?.(
          `[cockpit/control] input project=${projectId} terminal=${terminal.id} request=${body.requestId} chars=${body.data.length}`,
        );
        return { statusCode: 202, payload };
      });
    }

    if (
      segments.length === 5 &&
      segments[2] === "terminals" &&
      segments[4] === "interrupt"
    ) {
      requireCapability("interrupt");
      if (body.kind !== "interrupt") {
        throw new ControlHttpError(
          400,
          "INVALID_REQUEST",
          "kind=interrupt é obrigatório",
        );
      }
      return executeIdempotent(req, pathnameKey, body, async () => {
        const terminal = requireTerminal(projectId, segments[3]);
        if (!terminal.pty || terminal.exited) {
          throw new ControlHttpError(
            409,
            "CONTROL_UNAVAILABLE",
            "terminal ainda não pode ser interrompido",
          );
        }
        await adapter.interruptTerminal(projectId, terminal.id);
        const payload = actionEnvelope(
          instanceId,
          body.requestId,
          {},
          cursorFor(instanceId, terminal, terminal.outputSequence || 0, 0),
        );
        log.info?.(
          `[cockpit/control] interrupt project=${projectId} terminal=${terminal.id} request=${body.requestId}`,
        );
        return { statusCode: 202, payload };
      });
    }

    throw new ControlHttpError(404, "NOT_FOUND", "rota não encontrada");
  }

  function assertRequest(req) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      throw new ControlHttpError(
        403,
        "PROJECT_FORBIDDEN",
        "controle disponível somente em loopback",
      );
    }
    if (req.headers.origin || req.headers.referer) {
      throw new ControlHttpError(
        403,
        "PROJECT_FORBIDDEN",
        "origem de navegador não permitida",
      );
    }
    const provided = parseBearer(req.headers.authorization);
    if (!provided || !constantTimeTokenEqual(token, provided)) {
      throw new ControlHttpError(401, "UNAUTHORIZED", "não autorizado");
    }
    if (
      String(req.headers["x-cockpit-control-version"] || "") !==
      CONTROL_API_VERSION
    ) {
      throw new ControlHttpError(
        400,
        "INVALID_REQUEST",
        "X-Cockpit-Control-Version: 1 é obrigatório",
      );
    }
    const accept = String(req.headers.accept || "");
    if (!accept.toLowerCase().includes("application/json")) {
      throw new ControlHttpError(
        406,
        "INVALID_REQUEST",
        "Accept application/json é obrigatório",
      );
    }
    if (req.method === "POST") {
      const contentType = String(req.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw new ControlHttpError(
          415,
          "INVALID_REQUEST",
          "Content-Type application/json é obrigatório",
        );
      }
    }
  }

  return {
    instanceId,
    token,
    // getter, não valor: quem inspeciona a política tem de ver a que está
    // valendo agora, não a que foi lida quando o Cockpit subiu.
    get policy() {
      return politica();
    },
    handle(req, res) {
      let parsedUrl;
      try {
        parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
      } catch {
        return false;
      }
      if (
        parsedUrl.pathname !== CONTROL_API_PREFIX &&
        !parsedUrl.pathname.startsWith(`${CONTROL_API_PREFIX}/`)
      ) {
        return false;
      }
      Promise.resolve()
        .then(() => {
          assertRequest(req);
          return dispatch(req, parsedUrl);
        })
        .then(({ statusCode, payload }) => sendJson(res, statusCode, payload))
        .catch((error) => sendError(res, instanceId, error));
      return true;
    },
  };
}

export const controlApiInternals = {
  ControlHttpError,
  constantTimeTokenEqual,
  cursorFor,
  isLoopbackAddress,
  parseCursor,
  takeUtf8Prefix,
};
