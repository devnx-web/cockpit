import http from "http";
import fs from "fs";
import path from "path";
import url from "url";
import os from "os";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "child_process";
import { WebSocketServer } from "ws";
import pkg from "node-pty";
import * as voice from "./lib/voice.js";
import * as dictation from "./lib/dictation.js";
import * as stt from "./lib/stt.js";
import { attachLspWebSocket, shutdownAllLsp } from "./lib/lsp.js";
import { createTeamAccountsClient } from "./lib/team-accounts.js";
import { createTeamRouter } from "./lib/team-router.js";
import { createLifeAiClient } from "./lib/lifeai-client.js";
import { interactiveTerminalEnv } from "./lib/terminal-env.js";
import { createAgentWake } from "./lib/agent-wake.js";
import {
  createTerminalLicenseRetry,
  formatTerminalLicenseDelay,
  requireFreshTerminalSelections,
} from "./lib/team-terminal-license.js";
import { createFileSearchService } from "./lib/file-search.js";
import { pickProjectFields, validateCatalogFields } from "./lib/project-search.js";
import { createDemandStore, defaultDemandsPath } from "./lib/demands.js";
import { createFrontStore, defaultFrontsPath } from "./lib/fronts.js";
import { createInventoryWriter, readDevice } from "./lib/inventory.js";
import { createDispatcher } from "./lib/dispatch.js";
import { createUsageService } from "./lib/usage/service.js";
import {
  appendControlOutputEvent,
  CONTROL_API_PREFIX,
  createControlApi,
  createControlPolicySource,
  ControlHttpError,
  constantTimeTokenEqual,
  normalizeControlPolicy,
  removeControlDescriptor,
  writeControlDescriptor,
} from "./lib/control-api.js";
const { spawn } = pkg;

// === config dinâmica — populada por startServer() ===
const DEFAULT_ROOT = path.dirname(url.fileURLToPath(import.meta.url));
let PORT = 3737;
let ROOT = DEFAULT_ROOT;
let PUBLIC_DIR = path.join(DEFAULT_ROOT, "public");
let PROJECTS_PATH = path.join(DEFAULT_ROOT, "projects.json");
let PROJECTS = []; // populado em startServer()
let SERVER_URL = null;
let controlApi = null;
let controlDescriptorPath = null;
let usage = null; // coletor de uso de tokens; null se não subir (opcional)
let demands = null; // registro de demandas do orquestrador; null antes do boot
// Frentes de trabalho: a identidade que sobrevive ao terminal. `t1` é reciclado
// a cada reinício; o uid da frente, não. Null antes do boot.
let fronts = null;
let inventory = null; // snapshot em disco de device + frentes; null antes do boot
const teamAccounts = createTeamAccountsClient();
const teamRouter = createTeamRouter({
  client: teamAccounts,
  brokerUrl: () => SERVER_URL,
});
// A LifeAi roda como serviço próprio (bin/lifeaid.js, systemd --user). Aqui o
// Cockpit é só mais um cliente dela: lê onde ela atende e conversa. Nunca sobe,
// nunca desliga — fechar a janela não pode calar o agente no Telegram.
const lifeai = createLifeAiClient();
// Ponte "o agente parou": avisa a LifeAi na hora em que o turno acaba, em vez
// de deixá-la descobrir na próxima batida do cron. Só entrega o fato — quem
// decide se algum vigia se importa é ela.
const agentWake = createAgentWake({
  notifyLifeAi: (payload) => lifeai.cronWake(payload),
  resolveToken: (token) => findTerminalByWakeToken(token),
  device: () => readDevice(),
  log: console,
});
const fileSearch = createFileSearchService();
const TEAM_SELECTION_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const TEAM_AUTH_RECOVERY_COOLDOWN_MS = 30 * 1000;
const TEAM_AUTH_ERROR_PATTERN = /(?:not logged in[\s\S]{0,120}please run \/login|sign in with chatgpt[\s\S]{0,360}provide your own api key|please run \/login[\s\S]{0,180}(?:api error:\s*)?401|(?:api error:\s*)?401[\s\S]{0,180}(?:invalid authentication credentials|authentication credentials))/i;
let teamSelectionSyncTimer = null;
let teamAuthRecoveryPromise = null;
let lastTeamAuthRecoveryAt = 0;
let terminalSelectionQueue = Promise.resolve();
// Versão do app — lida uma vez do package.json e enviada ao cliente no hello.
// Evita ter o número hardcoded em vários lugares e sair de sincronia.
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DEFAULT_ROOT, "package.json"), "utf8"));
    return pkg.version || "?";
  } catch {
    return "?";
  }
})();

// shell padrão por SO — usado quando o projeto não especifica
function defaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

// =========================================================
// SESSÕES — agora 1 projeto contém N terminais (PTYs)
// session = { proj, terminals: Map<tid, terminal>, nextId, slot }
// terminal = { id, name, pty, buffer[], lastOutputTime, status, statusText }
// =========================================================
const sessions = new Map();

/**
 * Acha o terminal dono de um token de wake. Percorre todos porque a comparação
 * tem de ser em tempo constante: parar no primeiro prefixo que casa contaria
 * quantos caracteres o palpite acertou.
 */
function findTerminalByWakeToken(token) {
  if (!token) return null;
  let achado = null;
  for (const session of sessions.values()) {
    for (const terminal of session.terminals.values()) {
      if (terminal.wakeToken && constantTimeTokenEqual(terminal.wakeToken, token)) {
        achado = { session, terminal };
      }
    }
  }
  return achado;
}

async function syncTeamSelections(log = console) {
  if (!teamRouter.status().connected) return;
  try {
    const result = await teamRouter.bootstrap({ syncUsage: true });
    for (const warning of result.warnings || []) {
      log.log(`  \x1b[33m⚠\x1b[0m ${safeVisibleAilivMessage(warning)}`);
    }
  } catch (error) {
    log.log(`\x1b[33m▸ cockpit pool\x1b[0m sincronização indisponível: ${safeVisibleAilivMessage(error)}`);
  }
}

function recoverTeamAuthAfterError(terminal, data, log = console) {
  terminal.authErrorTail = `${terminal.authErrorTail || ""}${String(data || "")}`.slice(-512);
  if (!TEAM_AUTH_ERROR_PATTERN.test(terminal.authErrorTail)) return;
  terminal.authErrorTail = "";
  if (!teamRouter.status().connected) return;
  if (teamAuthRecoveryPromise) return;
  if (Date.now() - lastTeamAuthRecoveryAt < TEAM_AUTH_RECOVERY_COOLDOWN_MS) return;

  lastTeamAuthRecoveryAt = Date.now();
  teamAuthRecoveryPromise = teamRouter.refreshSelectionsIfStale({
    maxAgeMs: 0,
    retryMissingProviders: 1,
    syncUsage: true,
  })
    .then((result) => {
      const openai = result.selections?.find((selection) => selection.provider === "openai");
      if (openai) {
        log.log(`\x1b[32m▸ cockpit pool\x1b[0m credencial Ailiv recuperada após falha de autenticação`);
      }
      const claude = result.selections?.find((selection) => selection.provider === "claude");
      if (claude) {
        log.log(`\x1b[32m▸ cockpit pool\x1b[0m credencial Ailiv atualizada após 401; a sessão aberta usará a nova seleção`);
      }
      for (const warning of result.warnings || []) {
        log.log(`  \x1b[33m⚠\x1b[0m ${safeVisibleAilivMessage(warning)}`);
      }
    })
    .catch((error) => {
      log.log(`\x1b[33m▸ cockpit pool\x1b[0m recuperação de autenticação indisponível: ${safeVisibleAilivMessage(error)}`);
    })
    .finally(() => {
      teamAuthRecoveryPromise = null;
    });
}

function startTeamSelectionSync(log = console) {
  if (teamSelectionSyncTimer) clearInterval(teamSelectionSyncTimer);
  teamSelectionSyncTimer = setInterval(() => {
    syncTeamSelections(log).catch(() => {});
  }, TEAM_SELECTION_SYNC_INTERVAL_MS);
  teamSelectionSyncTimer.unref?.();
}

function appendTerminalOutput(session, terminal, data) {
  const output = String(data || "");
  if (!output) return;
  terminal.lastOutputTime = Date.now();
  appendControlOutputEvent(terminal, output);
  terminal.buffer.push(output);
  terminal.bufferSize += output.length;
  while (terminal.bufferSize > terminal.maxBufferSize && terminal.buffer.length > 1) {
    terminal.bufferSize -= terminal.buffer.shift().length;
  }
  broadcast({
    type: "output",
    projectId: session.proj.id,
    terminalId: terminal.id,
    data: output,
  });
}

function setTerminalStatus(session, terminal, status, statusText) {
  terminal.status = status;
  terminal.statusText = statusText;
  broadcastTerminalStatus(session, terminal);
}

function safeVisibleAilivMessage(value) {
  const message = typeof value === "string" ? value : value?.message;
  return String(message || "serviço central indisponível")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|password|authorization|credential)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\b(?:Claude|Codex|OpenAI|Anthropic)\b/gi, "Ailiv")
    .replace(/~\/\.(?:claude|codex)\b/gi, "perfil local Ailiv")
    .slice(0, 240);
}

function safeTerminalAuthError(error) {
  return safeVisibleAilivMessage(error);
}

function serializeTerminalSelection(task) {
  const queued = terminalSelectionQueue.then(task);
  terminalSelectionQueue = queued.catch(() => {});
  return queued;
}

function attachTerminalPty(session, terminal, { cwd, pathOk }) {
  if (terminal.authCancelled || session.terminals.get(terminal.id) !== terminal) return;

  const baseEnv = interactiveTerminalEnv(process.env, session.proj.env, {
    COCKPIT_PROJECT: session.proj.id,
    COCKPIT_TERMINAL: terminal.id,
    // O endereço que sobrevive a fechar, reabrir e renomear — ao contrário de
    // COCKPIT_TERMINAL, que é reciclado a cada sessão.
    ...(terminal.frontUid ? { COCKPIT_FRONT: terminal.frontUid } : {}),
    COCKPIT: "1",
    // Onde o hook "o agente parou" bate. Sem SERVER_URL (PTY nascido antes da
    // porta ser conhecida) o hook fica sem endereço e sai calado.
    ...(SERVER_URL
      ? { COCKPIT_WAKE_URL: `${SERVER_URL}/wake`, COCKPIT_WAKE_TOKEN: terminal.wakeToken }
      : {}),
  });
  // This call is intentionally strict. If broker environment preparation
  // fails, no host shell is spawned and the online retry loop remains active.
  const terminalEnv = teamRouter.enrichPtyEnv(baseEnv, {
    claudeProjectPath: pathOk ? cwd : undefined,
  });
  const pty = spawn(session.proj.shell || defaultShell(), [], {
    name: "xterm-256color",
    cols: terminal.cols,
    rows: terminal.rows,
    cwd,
    env: terminalEnv,
  });

  terminal.pty = pty;
  terminal.exited = false;
  terminal.exitCode = null;
  terminal.exitSignal = null;

  pty.onData((data) => {
    recoverTeamAuthAfterError(terminal, data);
    appendTerminalOutput(session, terminal, data);
    updateTerminalStatus(session, terminal);
  });

  pty.onExit((evt) => {
    terminal.exited = true;
    terminal.exitCode = Number.isInteger(evt.exitCode) ? evt.exitCode : null;
    terminal.exitSignal = evt.signal ?? null;
    terminal.status = evt.exitCode === 0 ? "idle" : "error";
    terminal.statusText =
      evt.exitCode === 0 ? "shell encerrado" : `falhou (exit ${evt.exitCode})`;
    broadcastTerminalStatus(session, terminal);
    demands?.onTerminalExit(session.proj.id, terminal.id, terminal.exitCode);
  });

  appendTerminalOutput(
    session,
    terminal,
    "\x1b[32m[cockpit] Licenças Ailiv recebidas do backend. Iniciando terminal…\x1b[0m\r\n",
  );
  setTerminalStatus(
    session,
    terminal,
    pathOk ? "idle" : "error",
    pathOk ? "iniciando…" : "path do projeto não existe",
  );
}

function startTerminalLicenseProvisioning(session, terminal, context) {
  const retry = createTerminalLicenseRetry({
    attempt: () => serializeTerminalSelection(async () => {
      const result = await teamRouter.refreshSelectionsIfStale({
        maxAgeMs: 0,
        retryMissingProviders: 0,
      });
      requireFreshTerminalSelections(result);
      if (terminal.authCancelled || session.terminals.get(terminal.id) !== terminal) return result;
      attachTerminalPty(session, terminal, context);
      return result;
    }),
    onAttempt: ({ attempt }) => {
      if (terminal.authCancelled) return;
      appendTerminalOutput(
        session,
        terminal,
        `\x1b[36m[cockpit] Tentativa ${attempt}: solicitando licenças Ailiv ao backend…\x1b[0m\r\n`,
      );
      setTerminalStatus(session, terminal, "waiting", `buscando licença online · tentativa ${attempt}`);
    },
    onFailure: (error, { delayMs }) => {
      if (terminal.authCancelled) return;
      const delay = formatTerminalLicenseDelay(delayMs);
      appendTerminalOutput(
        session,
        terminal,
        `\x1b[31m[cockpit] Licenças online indisponíveis: ${safeTerminalAuthError(error)}\x1b[0m\r\n`
          + `\x1b[33m[cockpit] Nova tentativa em ${delay}. Nenhuma licença local será usada.\x1b[0m\r\n`,
      );
      setTerminalStatus(session, terminal, "waiting", `licença online · nova tentativa em ${delay}`);
    },
    onSuccess: () => {
      terminal.authRetry = null;
    },
  });
  terminal.authRetry = retry;
  const startTimer = setTimeout(() => retry.start(), 0);
  startTimer.unref?.();
}

async function createTerminalIn(session, name = null, meta = {}) {
  const tid = `t${session.nextId++}`;
  const projPath = session.proj.path;
  // meta.cwd: gancho para abrir o terminal em outro diretório do mesmo projeto
  // (worktree, subpasta). Só vale se for um diretório que existe de verdade —
  // caminho inválido cai no path do projeto em vez de virar erro de spawn.
  const requestedCwd =
    typeof meta.cwd === "string" && meta.cwd
      ? (() => {
          try {
            return fs.statSync(meta.cwd).isDirectory() ? meta.cwd : null;
          } catch {
            return null;
          }
        })()
      : null;
  const pathOk = Boolean(requestedCwd) || (projPath && fs.existsSync(projPath));
  const cwd = requestedCwd || (pathOk ? projPath : process.env.HOME);

  if (!pathOk) {
    console.warn(
      `[cockpit] projeto "${session.proj.id}" tem path inexistente: ${projPath} — usando ${cwd} como fallback`,
    );
  }

  const titulo = name || `Terminal ${session.terminals.size + 1}`;
  // A frente é o endereço que dura: o terminal se pluga nela e pode morrer.
  const frente = fronts?.ensure(session.proj.id, titulo) || null;

  const terminal = {
    id: tid,
    name: titulo,
    frontUid: frente?.uid || null,
    pty: null,
    cols: 120,
    rows: 30,
    buffer: [],
    bufferSize: 0,
    maxBufferSize: 200 * 1024,
    owner: meta.owner === "mcp" ? "mcp" : "ui",
    cwd,
    // Credencial do hook "o agente parou". Nasce e morre com o terminal, e não
    // dá poder nenhum além de identificar quem está avisando.
    wakeToken: randomBytes(32).toString("base64url"),
    controlGeneration: randomUUID(),
    outputSequence: 0,
    outputEvents: [],
    outputEventBytes: 0,
    startedAt: Date.now(),     // painel "Aberto agora": desde quando o terminal existe
    lastOutputTime: Date.now(),
    lastInputTime: Date.now(), // reaper: atividade = max(output, input)
    lastSeenTime: Date.now(),  // reaper: última vez visível num cliente
    reapWarned: false,         // reaper: já avisou que vai encerrar
    exited: false,             // shell morreu (onExit) → reapável
    exitCode: null,
    exitSignal: null,
    status: "waiting",
    statusText: "aguardando licença online…",
    authErrorTail: "",
    authRetry: null,
    authCancelled: false,
  };

  session.terminals.set(tid, terminal);
  inventory?.schedule();

  if (!pathOk) {
    const warn =
      `\x1b[33m[cockpit] Path do projeto não existe: ${projPath}\r\n` +
      `[cockpit] Abrindo em ${cwd} (fallback)\x1b[0m\r\n`;
    appendTerminalOutput(session, terminal, warn);
  }

  startTerminalLicenseProvisioning(session, terminal, { cwd, pathOk });
  return terminal;
}

async function createSession(proj, { autoTerminal = true } = {}) {
  const session = {
    proj,
    terminals: new Map(),
    nextId: 1,
  };
  sessions.set(proj.id, session);
  if (!autoTerminal) return session;
  // cada projeto começa com 1 terminal default
  try {
    await createTerminalIn(session, "Terminal 1");
  } catch (error) {
    // Um shell inválido em um projeto não pode derrubar o servidor inteiro
    // depois que ele já começou a escutar. O usuário ainda pode corrigir o
    // projeto ou tentar abrir outro terminal pela interface.
    console.error(`[cockpit] falha ao abrir terminal de "${proj.id}": ${error.message}`);
    session.bootError = error.message;
  }
  return session;
}

/**
 * Toda a descendência de um pid, via /proc (Linux). Precisa varrer todas as
 * tasks porque um processo multi-thread (node, por exemplo) registra os filhos
 * sob a thread que fez o fork, não necessariamente sob a principal.
 */
function collectDescendants(pid, out = [], depth = 0) {
  if (depth > 20) return out;
  let tasks;
  try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch { return out; }
  for (const task of tasks) {
    let raw;
    try { raw = fs.readFileSync(`/proc/${pid}/task/${task}/children`, "utf8"); } catch { continue; }
    for (const part of raw.trim().split(/\s+/)) {
      const child = parseInt(part, 10);
      if (!Number.isFinite(child) || out.includes(child)) continue;
      out.push(child);
      collectDescendants(child, out, depth + 1);
    }
  }
  return out;
}

/**
 * Matar só o PTY não basta: o job control do bash põe cada comando em seu
 * próprio process group, então um agente (`claude`) ou dev server sobrevive ao
 * SIGHUP do shell, é reparentado pro init e continua consumindo RAM — e, no
 * caso do agente, tokens. Aqui a árvore é coletada ANTES de derrubar o shell
 * (depois o vínculo pai/filho se perde) e encerrada das folhas pra raiz.
 */
function killTerminal(session, tid, { hard = false } = {}) {
  const t = session.terminals.get(tid);
  if (!t) return false;
  t.authCancelled = true;
  t.authRetry?.cancel();
  t.authRetry = null;

  const pid = t.pty?.pid;
  const tree = pid ? collectDescendants(pid) : [];
  try { t.pty?.kill(); } catch {}

  // folhas primeiro: evita que um pai respawne filho enquanto derrubamos
  for (const child of [...tree].reverse()) {
    try { process.kill(child, hard ? "SIGKILL" : "SIGTERM"); } catch {}
  }
  if (!hard && tree.length) {
    // quem ignorou o SIGTERM leva SIGKILL — inclusive o shell, se travou
    const timer = setTimeout(() => {
      for (const child of [...tree].reverse()) {
        try { process.kill(child, "SIGKILL"); } catch {}
      }
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }, 2000);
    timer.unref?.();
  }

  session.terminals.delete(tid);
  agentWake.forget(session.proj.id, tid);
  // A frente continua no registro: ela é o slot, e o terminal é só quem passou
  // por ele. Apagá-la aqui devolveria o uid instável que este registro resolve.
  inventory?.schedule();
  return true;
}

function killAllTerminals(session, opts = {}) {
  for (const tid of [...session.terminals.keys()]) killTerminal(session, tid, opts);
}

// Detecta se há um comando rodando em foreground no PTY (dev server, build,
// agente…) lendo os processos-filho do shell via /proc (Linux). Usado pelo
// reaper pra NUNCA encerrar um terminal ocupado. Conservador: em caso de dúvida
// num PTY vivo, considera ocupado (não reapa). Shell já morto = não ocupado.
function hasForegroundChild(terminal) {
  if (terminal.exited) return false;
  const pid = terminal.pty?.pid;
  if (!pid) return true; // sem pid → não arrisca
  try {
    const raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    return raw.trim().length > 0;
  } catch (e) {
    // ENOENT = processo sumiu (shell morreu) → não ocupado; qualquer outro erro
    // (permissão, kernel sem CONFIG_PROC_CHILDREN) → conservador: ocupado.
    if (e && e.code === "ENOENT") return false;
    return true;
  }
}

// =========================================================
// DETECÇÃO DE STATUS
// =========================================================
const WAITING_PATTERNS = [
  /\([sySY]\/[nN]\)/,
  /\([yY]\/[nN]\)/,
  /\([nN]\/[yY]\)/,
  /\bQuer que eu\b/i,
  /\bDevo (continuar|aplicar|executar)\b/i,
  /\bContinue\?/i,
  /\bApply changes\?/i,
  /\bShould I\b/i,
  /\bDo you want\b/i,
  /❯ Continuar/i,
  /❯ Aceitar/i,
  /\? +.+\?\s*$/m,
];

const ERROR_PATTERNS = [
  /^\s*✗\s/m,
  /\bBuild failed\b/i,
  /\bFalha (de|no) (compilação|build)\b/i,
  /\bErro de tipo:/i,
  /\bFailed to compile\b/i,
  /\bsegmentation fault\b/i,
  /\bnpm ERR!/,
  /\bSyntaxError:/,
  /\bTypeError:/,
];

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][AB012]/g, "");
}

function recentText(terminal, bytes = 4096) {
  let acc = "";
  for (let i = terminal.buffer.length - 1; i >= 0; i--) {
    acc = terminal.buffer[i] + acc;
    if (acc.length >= bytes) break;
  }
  return stripAnsi(acc.slice(-bytes));
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}min`;
}

function updateTerminalStatus(session, terminal) {
  if (terminal.exited) return;
  if (!terminal.pty && terminal.status === "waiting") return;
  const tail = recentText(terminal, 2000);
  const lastLines = tail.split("\n").slice(-8).join("\n");
  const sinceOutput = Date.now() - terminal.lastOutputTime;

  let status, text;
  if (WAITING_PATTERNS.some((re) => re.test(lastLines))) {
    status = "waiting";
    text = `aguardando · ${fmtElapsed(sinceOutput)}`;
  } else if (ERROR_PATTERNS.some((re) => re.test(lastLines)) && sinceOutput < 60000) {
    status = "error";
    text = `erro · ${fmtElapsed(sinceOutput)}`;
  } else if (sinceOutput < 2500) {
    status = "running";
    text = "processando…";
  } else if (sinceOutput < 30000) {
    status = "idle";
    text = `pausado · ${fmtElapsed(sinceOutput)}`;
  } else {
    status = "idle";
    text = `ocioso · ${fmtElapsed(sinceOutput)}`;
  }

  if (status !== terminal.status || text !== terminal.statusText) {
    terminal.status = status;
    terminal.statusText = text;
    broadcastTerminalStatus(session, terminal);
    // a demanda deriva daqui — nenhuma heurística nova, mesma leitura
    demands?.onTerminalStatus(session.proj.id, terminal.id, status, text);
    // e o vigia da LifeAi acorda daqui, quando o agente não avisa sozinho
    agentWake.onTerminalStatus(session, terminal, status, text);
    inventory?.schedule();
  }
}

// =========================================================
// GIT — operações via execFile (sem shell injection)
// =========================================================
function git(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 30000, ...opts },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || "",
          stderr: stderr || "",
          code: err?.code ?? 0,
          error: err?.message,
        });
      }
    );
  });
}

const REPO_SCAN_SKIP = new Set([
  "node_modules", "vendor", "dist", "build", "out", "target",
  ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache", ".pnpm-store",
  "coverage", ".venv", "venv", "__pycache__",
]);

function hasGitDir(absPath) {
  try {
    return fs.existsSync(path.join(absPath, ".git"));
  } catch {
    return false;
  }
}

async function discoverRepos(projPath) {
  const repos = [];
  if (hasGitDir(projPath)) {
    repos.push({ relPath: ".", absPath: projPath, name: path.basename(projPath) });
  }
  let entries = [];
  try {
    entries = await fs.promises.readdir(projPath, { withFileTypes: true });
  } catch {
    return repos;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (REPO_SCAN_SKIP.has(e.name)) continue;
    const child = path.join(projPath, e.name);
    if (hasGitDir(child)) {
      repos.push({ relPath: e.name, absPath: child, name: e.name });
    }
  }
  return repos;
}

function resolveRepoPath(projPath, repoRelPath) {
  const target = (!repoRelPath || repoRelPath === ".")
    ? projPath
    : path.resolve(projPath, repoRelPath);
  const rooted = projPath.endsWith(path.sep) ? projPath : projPath + path.sep;
  if (target !== projPath && !target.startsWith(rooted)) return null;
  if (!hasGitDir(target)) return null;
  return target;
}

async function repoStatus(absPath) {
  const branchRes = await git(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branchRes.ok) return { error: branchRes.stderr?.trim() || "git error" };
  const branch = branchRes.stdout.trim();

  let ahead = 0,
    behind = 0,
    hasUpstream = false;
  const trackRes = await git(absPath, [
    "rev-list",
    "--left-right",
    "--count",
    `${branch}...@{upstream}`,
  ]);
  if (trackRes.ok) {
    const parts = trackRes.stdout.trim().split(/\s+/).map(Number);
    if (parts.length === 2 && !isNaN(parts[0])) {
      ahead = parts[0];
      behind = parts[1];
      hasUpstream = true;
    }
  }

  const statusRes = await git(absPath, ["status", "--porcelain=v1", "-uall"]);
  const files = [];
  if (statusRes.ok) {
    for (const line of statusRes.stdout.split("\n")) {
      if (!line) continue;
      const idx = line.charAt(0); // staged
      const wt = line.charAt(1); // working tree
      const file = line.slice(3);
      let bucket;
      if (idx !== " " && idx !== "?") bucket = "staged";
      else if (wt === "?") bucket = "untracked";
      else bucket = "modified";
      files.push({
        path: file,
        index: idx,
        worktree: wt,
        bucket,
        display: bucket === "staged" ? idx : wt === "?" ? "?" : wt,
      });
    }
  }

  return { branch, ahead, behind, hasUpstream, files };
}

async function gitStatus(projPath) {
  const discovered = await discoverRepos(projPath);
  const repos = await Promise.all(
    discovered.map(async (r) => {
      const st = await repoStatus(r.absPath);
      return { id: r.relPath, name: r.name, relPath: r.relPath, ...st };
    })
  );
  return { isGit: repos.length > 0, repos };
}

// =========================================================
// FILES — listar, ler, gravar (com proteção a path traversal)
// =========================================================
function safePath(projectPath, relativePath) {
  const abs = path.resolve(projectPath, relativePath || ".");
  const rooted = projectPath.endsWith(path.sep) ? projectPath : projectPath + path.sep;
  if (abs !== projectPath && !abs.startsWith(rooted)) return null;
  return abs;
}

async function listFiles(projectPath, relPath) {
  const abs = safePath(projectPath, relPath);
  if (!abs) return { ok: false, error: "caminho inválido" };
  try {
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    return {
      ok: true,
      entries: entries
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name, "pt-BR");
        }),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Abre um arquivo no app padrão do SO (xdg-open / open / explorer).
// Usa execFile (sem shell) e safePath para evitar injection/path traversal.
function openExternalFile(projectPath, relPath) {
  return new Promise((resolve) => {
    const abs = safePath(projectPath, relPath);
    if (!abs) { resolve({ ok: false, error: "caminho inválido" }); return; }
    if (!fs.existsSync(abs)) { resolve({ ok: false, error: "arquivo não existe" }); return; }
    const plat = os.platform();
    const cmd = plat === "darwin" ? "open" : plat === "win32" ? "explorer.exe" : "xdg-open";
    execFile(cmd, [abs], { windowsHide: true }, (err) => {
      // xdg-open/open retornam antes de a app abrir; basta o spawn ter sucesso
      if (err && err.code !== undefined) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
}

async function readFileContent(projectPath, relPath) {
  const abs = safePath(projectPath, relPath);
  if (!abs) return { ok: false, error: "caminho inválido" };
  try {
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile()) return { ok: false, error: "não é arquivo" };
    if (stat.size > 5 * 1024 * 1024) return { ok: false, error: "arquivo > 5MB", size: stat.size };
    const buf = await fs.promises.readFile(abs);
    // detecta binário pelo null byte nos primeiros 8KB
    const head = buf.subarray(0, Math.min(8000, buf.length));
    let isBinary = false;
    for (let i = 0; i < head.length; i++) if (head[i] === 0) { isBinary = true; break; }
    if (isBinary) return { ok: false, error: "arquivo binário", size: stat.size };
    return {
      ok: true,
      content: buf.toString("utf8"),
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function writeFileContent(projectPath, relPath, content) {
  const abs = safePath(projectPath, relPath);
  if (!abs) return { ok: false, error: "caminho inválido" };
  try {
    await fs.promises.writeFile(abs, content, "utf8");
    const stat = await fs.promises.stat(abs);
    return { ok: true, size: stat.size, mtime: stat.mtimeMs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function renamePath(projectPath, fromRel, toRel) {
  const fromAbs = safePath(projectPath, fromRel);
  const toAbs = safePath(projectPath, toRel);
  if (!fromAbs || !toAbs) return { ok: false, error: "caminho inválido" };
  if (fromAbs === projectPath || toAbs === projectPath) {
    return { ok: false, error: "não pode operar na raiz" };
  }
  try {
    try {
      await fs.promises.access(toAbs);
      return { ok: false, error: "destino já existe" };
    } catch {}
    await fs.promises.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.promises.rename(fromAbs, toAbs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deletePath(projectPath, rel) {
  const abs = safePath(projectPath, rel);
  if (!abs || abs === projectPath) return { ok: false, error: "caminho inválido" };
  try {
    const stat = await fs.promises.lstat(abs);
    if (stat.isDirectory()) {
      await fs.promises.rm(abs, { recursive: true, force: false });
    } else {
      await fs.promises.unlink(abs);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function createFile(projectPath, rel, content = "") {
  const abs = safePath(projectPath, rel);
  if (!abs || abs === projectPath) return { ok: false, error: "caminho inválido" };
  try {
    try {
      await fs.promises.access(abs);
      return { ok: false, error: "arquivo já existe" };
    } catch {}
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
    const stat = await fs.promises.stat(abs);
    return { ok: true, size: stat.size, mtime: stat.mtimeMs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function createDir(projectPath, rel) {
  const abs = safePath(projectPath, rel);
  if (!abs || abs === projectPath) return { ok: false, error: "caminho inválido" };
  try {
    await fs.promises.mkdir(abs);
    return { ok: true };
  } catch (e) {
    if (e.code === "EEXIST") return { ok: false, error: "pasta já existe" };
    return { ok: false, error: e.message };
  }
}

// Importa um arquivo/pasta externo (path absoluto do SO) pra dentro do projeto.
// srcAbs vem do client (drag&drop do file manager); só validamos que existe.
// dstRel passa por safePath pra evitar escape pra fora do project root.
// overwrite=true: substitui o destino existente. Sem isso, retorna exists=true
// pra o renderer perguntar ao usuário antes de chamar de novo.
async function importExternal(projectPath, srcAbs, dstRel, overwrite) {
  if (typeof srcAbs !== "string" || !path.isAbsolute(srcAbs)) {
    return { ok: false, error: "origem inválida" };
  }
  const dstAbs = safePath(projectPath, dstRel);
  if (!dstAbs || dstAbs === projectPath) return { ok: false, error: "destino inválido" };
  try {
    // não deixa importar de dentro do próprio projeto pra ele mesmo
    // (vira duplicate_path com lógica diferente)
    const srcReal = await fs.promises.realpath(srcAbs).catch(() => srcAbs);
    const dstReal = path.resolve(dstAbs);
    if (srcReal === dstReal) return { ok: false, error: "origem e destino iguais" };
    // sanity check: origem existe
    const srcStat = await fs.promises.lstat(srcAbs).catch(() => null);
    if (!srcStat) return { ok: false, error: "origem não existe" };
    // colisão de nome
    let exists = false;
    try { await fs.promises.access(dstAbs); exists = true; } catch {}
    if (exists && !overwrite) {
      return { ok: false, exists: true, error: "destino já existe" };
    }
    await fs.promises.mkdir(path.dirname(dstAbs), { recursive: true });
    if (exists && overwrite) {
      // remove o destino antes de copiar (fs.cp com force ainda pode falhar
      // em troca de tipo arquivo↔pasta)
      await fs.promises.rm(dstAbs, { recursive: true, force: true });
    }
    if (srcStat.isDirectory()) {
      await fs.promises.cp(srcAbs, dstAbs, { recursive: true, force: true, errorOnExist: false });
    } else {
      await fs.promises.copyFile(srcAbs, dstAbs);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function duplicatePath(projectPath, fromRel, toRel) {
  const fromAbs = safePath(projectPath, fromRel);
  const toAbs = safePath(projectPath, toRel);
  if (!fromAbs || !toAbs) return { ok: false, error: "caminho inválido" };
  if (fromAbs === projectPath || toAbs === projectPath) {
    return { ok: false, error: "não pode operar na raiz" };
  }
  try {
    try {
      await fs.promises.access(toAbs);
      return { ok: false, error: "destino já existe" };
    } catch {}
    const stat = await fs.promises.lstat(fromAbs);
    await fs.promises.mkdir(path.dirname(toAbs), { recursive: true });
    if (stat.isDirectory()) {
      await fs.promises.cp(fromAbs, toAbs, { recursive: true });
    } else {
      await fs.promises.copyFile(fromAbs, toAbs);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function gitDiff(repoAbsPath, file, staged) {
  const args = staged
    ? ["diff", "--cached", "--", file]
    : ["diff", "--", file];
  const res = await git(repoAbsPath, args);
  return { ok: res.ok, diff: res.stdout, error: res.stderr };
}


const wss = new WebSocketServer({ noServer: true });
const lspWss = new WebSocketServer({ noServer: true });
const clients = new Set();

function helloPayload() {
  return {
    type: "hello",
    version: APP_VERSION,
    system: {
      home: os.homedir(),
      platform: process.platform,
      sep: path.sep,
      commonPaths: detectCommonPaths(),
    },
    projects: PROJECTS.map((p) => {
      const s = sessions.get(p.id);
      return {
        ...p,
        terminals: s ? Array.from(s.terminals.values()).map((t) => ({
          ...terminalSummary(t),
          buffer: t.buffer.join(""),
        })) : [],
      };
    }),
  };
}

async function persistProjects() {
  const json = JSON.stringify(PROJECTS, null, 2) + "\n";
  await fs.promises.writeFile(PROJECTS_PATH, json, "utf8");
}

/**
 * O banco de uso guarda só o `project_id`. O nome, a cor e o ícone vivem aqui, em
 * PROJECTS — juntar na saída evita duplicar esses dados no SQLite e mantê-los
 * desatualizados quando o projeto é renomeado. Para os repositórios descobertos
 * automaticamente o próprio banco traz um `label`.
 */
function withProjectNames(dados) {
  if (!dados?.byProject) return dados;
  const porId = new Map(PROJECTS.map((p) => [p.id, p]));
  return {
    ...dados,
    byProject: dados.byProject.map((linha) => {
      const projeto = porId.get(linha.project_id);
      return {
        ...linha,
        name: projeto?.name ?? linha.label ?? (linha.project_id === "__none__" ? "Sem projeto" : linha.project_id),
        color: projeto?.color ?? null,
        icon: projeto?.icon ?? null,
        // Repositório medido mas não cadastrado: a UI pode oferecer "adicionar projeto".
        derived: !projeto && linha.project_id !== "__none__",
      };
    }),
  };
}

function broadcastProjectsChanged() {
  // As regras de atribuição de uso derivam de PROJECTS[].path: cadastrar um projeto
  // promove o histórico que já vinha sendo medido como repositório avulso.
  usage?.setProjects(PROJECTS);
  // versão leve sem buffer (clientes mantêm o que já têm)
  broadcast({
    type: "projects_changed",
    projects: PROJECTS.map((p) => {
      const s = sessions.get(p.id);
      return {
        ...p,
        terminals: s ? Array.from(s.terminals.values()).map(terminalSummary) : [],
      };
    }),
  });
}

function validateProjectShape(p, { isNew = true, ignoreId = null } = {}) {
  if (!p || typeof p !== "object") return "objeto inválido";
  if (!p.id || typeof p.id !== "string") return "id é obrigatório";
  if (!/^[a-z0-9_-]+$/.test(p.id)) return "id deve conter apenas letras minúsculas, números, - e _";
  if (!p.name || typeof p.name !== "string") return "nome é obrigatório";
  if (!p.path || typeof p.path !== "string") return "caminho é obrigatório";
  if (!fs.existsSync(p.path)) return `caminho não existe: ${p.path}`;
  try {
    const st = fs.statSync(p.path);
    if (!st.isDirectory()) return "caminho não é uma pasta";
  } catch (e) {
    return "caminho inacessível: " + e.message;
  }
  const catalogError = validateCatalogFields(p);
  if (catalogError) return catalogError;
  if (isNew && PROJECTS.find((x) => x.id === p.id)) return `já existe um projeto com id "${p.id}"`;
  if (!isNew && p.id !== ignoreId && PROJECTS.find((x) => x.id === p.id))
    return `já existe um projeto com id "${p.id}"`;
  return null;
}

async function listDirs(absPath) {
  try {
    const home = os.homedir();
    const target = absPath && absPath.trim() ? absPath : home;
    if (!path.isAbsolute(target)) return { ok: false, error: "caminho deve ser absoluto" };
    const raw = await fs.promises.readdir(target, { withFileTypes: true });
    const entries = await Promise.all(
      raw
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map(async (e) => {
          const name = e.name;
          const full = path.join(target, name);
          let isGit = false;
          try {
            const st = await fs.promises.stat(path.join(full, ".git"));
            isGit = st.isDirectory() || st.isFile();
          } catch {}
          return { name, hidden: name.startsWith("."), isGit };
        })
    );
    entries.sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return a.name.localeCompare(b.name, "pt-BR");
    });
    // o pai existe sempre que não estamos na raiz; serve pra UI desabilitar o botão "subir"
    const parent = path.dirname(target);
    const isGitDir = await (async () => {
      try { return (await fs.promises.stat(path.join(target, ".git"))).isDirectory(); } catch { return false; }
    })();
    return {
      ok: true,
      path: target,
      parent: parent === target ? null : parent,
      home,
      isGitDir,
      entries,
      // legado: campo `dirs` (array de strings) — mantido para compat com clientes antigos
      dirs: entries.filter((e) => !e.hidden).map((e) => e.name),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Lista de "lugares conhecidos" que existem no SO atual. Usado pelo picker
// pra montar atalhos sem hardcodar caminhos do desenvolvedor (ex.: /home/ftgk).
function detectCommonPaths() {
  const home = os.homedir();
  const candidates = [
    { label: "Home", path: home, kind: "home" },
    { label: "Desktop", path: path.join(home, "Desktop"), kind: "desktop" },
    { label: "Área de Trabalho", path: path.join(home, "Área de Trabalho"), kind: "desktop" },
    { label: "Documents", path: path.join(home, "Documents"), kind: "documents" },
    { label: "Documentos", path: path.join(home, "Documentos"), kind: "documents" },
    { label: "Downloads", path: path.join(home, "Downloads"), kind: "downloads" },
    { label: "Projects", path: path.join(home, "Projects"), kind: "projects" },
    { label: "Projetos", path: path.join(home, "Projetos"), kind: "projects" },
    { label: "code", path: path.join(home, "code"), kind: "projects" },
    { label: "dev", path: path.join(home, "dev"), kind: "projects" },
    { label: "src", path: path.join(home, "src"), kind: "projects" },
    { label: "workspace", path: path.join(home, "workspace"), kind: "projects" },
    { label: "GitHub", path: path.join(home, "Documents", "GitHub"), kind: "projects" },
    { label: "GitHub", path: path.join(home, "Documentos", "GitHub"), kind: "projects" },
    { label: "GitHub", path: path.join(home, "GitHub"), kind: "projects" },
  ];
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    try {
      if (fs.statSync(c.path).isDirectory()) {
        out.push(c);
        seen.add(c.path);
      }
    } catch {}
  }
  return out;
}

function terminalSummary(t) {
  return {
    id: t.id, name: t.name, status: t.status, statusText: t.statusText,
    // O painel "Aberto agora" mostra "aberto às HH:MM · parado há Xh" pra dar
    // pra decidir o que encerrar sem entrar em cada aba. `lastActivity` é o
    // mesmo relógio que o reaper usa (max de output e input).
    startedAt: t.startedAt,
    lastActivity: Math.max(t.lastOutputTime, t.lastInputTime),
  };
}

/**
 * O que o inventário em disco publica: as frentes conhecidas, cada uma com o
 * terminal que a ocupa **agora** — ou nenhum, que é informação igualmente boa
 * ("essa frente existe e está sem janela aberta"). Só rótulo e status: nenhuma
 * saída de terminal, nenhum token, nenhum caminho de credencial.
 */
function collectInventoryFronts() {
  if (!fronts) return [];
  const ocupadas = new Map();
  for (const session of sessions.values()) {
    for (const terminal of session.terminals.values()) {
      if (terminal.frontUid) ocupadas.set(terminal.frontUid, terminal);
    }
  }
  return fronts.list().map((frente) => {
    const terminal = ocupadas.get(frente.uid) || null;
    return {
      uid: frente.uid,
      projectId: frente.projectId,
      title: frente.title,
      terminalId: terminal?.id || null,
      status: terminal?.status || "closed",
      statusText: terminal?.statusText || "",
      lastSeenAt: frente.lastSeenAt || null,
    };
  });
}

/**
 * Última vez que cada projeto foi trazido para a frente, para não repetir o
 * pedido a cada tecla de uma mesma rajada de escrita. A janela é curta de
 * propósito: se o usuário sair do projeto no meio, a próxima escrita traz de
 * volta em vez de continuar acontecendo fora de vista.
 */
const reveladoEm = new Map();
const REVELAR_DEBOUNCE_MS = 3_000;

/**
 * As janelas que **podem** mostrar este projeto.
 *
 * Uma janela desacoplada é presa a um projeto só (`?detach=<id>`) e ignora
 * `selectProject` de qualquer outro — contá-la como plateia de um projeto que
 * ela nunca vai exibir seria o mesmo buraco com outro nome.
 */
function janelasQueMostram(projectId) {
  let total = 0;
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    if (ws.__detachedProject && ws.__detachedProject !== projectId) continue;
    total += 1;
  }
  return total;
}

function createControlAdapter() {
  return {
    /**
     * Ou o projeto aparece na janela, ou a chamada não acontece.
     *
     * O servidor mantém uma sessão para cada projeto do catálogo desde o boot,
     * então até aqui um agente podia nascer, trabalhar e commitar num projeto
     * que ninguém tinha aberto. A regra agora é uma só: agente trabalha no que
     * está à vista — e se não estiver, o Cockpit traz para a frente antes de
     * deixar o trabalho começar.
     */
    revealProject: async (projectId, { reason = "", terminalId = null } = {}) => {
      if (janelasQueMostram(projectId) === 0) {
        throw new ControlHttpError(
          409,
          "NO_VISIBLE_WINDOW",
          "nenhuma janela do Cockpit pode mostrar este projeto — abra o Cockpit no projeto antes de trabalhar nele",
        );
      }
      const agora = Date.now();
      const anterior = reveladoEm.get(projectId) || 0;
      // Terminal novo sempre revela: é o momento em que o trabalho começa e o
      // dono precisa ver, mesmo que a rajada anterior tenha sido há um segundo.
      if (reason !== "input" || agora - anterior >= REVELAR_DEBOUNCE_MS) {
        reveladoEm.set(projectId, agora);
        broadcast({ type: "reveal_project", projectId, terminalId, reason });
      }
    },
    listProjects: () => PROJECTS,
    getProject: (projectId) => PROJECTS.find((project) => project.id === projectId),
    listTerminals: (projectId) =>
      Array.from(sessions.get(projectId)?.terminals.values() || []),
    getTerminal: (projectId, terminalId) =>
      sessions.get(projectId)?.terminals.get(terminalId) || null,
    createTerminal: async (projectId, name) => {
      const session = sessions.get(projectId);
      if (!session) throw new Error("sessão do projeto indisponível");
      const terminal = await createTerminalIn(session, name, { owner: "mcp" });
      broadcast({
        type: "terminal_added",
        projectId,
        terminal: { ...terminalSummary(terminal), buffer: terminal.buffer.join("") },
      });
      return terminal;
    },
    writeInput: async (projectId, terminalId, data) => {
      const terminal = sessions.get(projectId)?.terminals.get(terminalId);
      if (!terminal?.pty || terminal.exited) {
        throw new Error("terminal ainda não aceita input");
      }
      terminal.lastInputTime = Date.now();
      terminal.pty.write(data);
    },
    interruptTerminal: async (projectId, terminalId) => {
      const terminal = sessions.get(projectId)?.terminals.get(terminalId);
      if (!terminal?.pty || terminal.exited) {
        throw new Error("terminal ainda não pode ser interrompido");
      }
      terminal.lastInputTime = Date.now();
      terminal.pty.write("\x03");
    },
  };
}

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(helloPayload()));

  ws.on("message", async (raw, isBinary) => {
    // STT: o cliente manda primeiro um JSON {type:"stt_meta", projectId, terminalId, ext}
    // e logo em seguida o frame binário com o áudio (webm/opus do MediaRecorder).
    // Aqui pegamos o binário, transcrevemos via daemon Python e injetamos o texto
    // direto no PTY do terminal alvo — mesmo caminho que `case "input"` usa.
    if (isBinary) {
      const meta = ws.__sttMeta;
      ws.__sttMeta = null;
      if (!meta) {
        ws.send(JSON.stringify({ type: "stt_result", ok: false, error: "sem stt_meta antes do áudio" }));
        return;
      }
      const audioBuffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      try {
        const r = await stt.transcribe(audioBuffer, meta.ext || "webm");
        if (r.ok && r.text) {
          const sess = sessions.get(meta.projectId);
          const t = sess?.terminals.get(meta.terminalId);
          if (t?.pty) {
            try { t.pty.write(r.text); } catch {}
          }
        }
        ws.send(JSON.stringify({
          type: "stt_result",
          projectId: meta.projectId,
          terminalId: meta.terminalId,
          ...r,
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "stt_result", ok: false, error: e.message }));
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Janela desacoplada só mostra o projeto dela; a principal mostra qualquer
    // um. É o que decide se um projeto tem plateia na hora de autorizar um
    // agente a trabalhar nele.
    if (msg.type === "window_scope") {
      ws.__detachedProject =
        typeof msg.detachedProject === "string" && msg.detachedProject
          ? msg.detachedProject
          : null;
      return;
    }

    // ---- Uso de tokens (global, sem projeto) ----
    if (msg.type === "usage_stats") {
      const dados = usage
        ? usage.stats({ days: Number(msg.days) > 0 ? Number(msg.days) : 1 })
        : { available: false, status: null };
      ws.send(JSON.stringify({ type: "usage_stats", ...withProjectNames(dados) }));
      return;
    }

    if (msg.type === "usage_scan_now") {
      usage?.scanNow();
      ws.send(JSON.stringify({ type: "usage_scan_started", ok: Boolean(usage) }));
      return;
    }

    if (msg.type === "usage_sync_now") {
      usage?.syncNow();
      ws.send(JSON.stringify({ type: "usage_sync_started", ok: Boolean(usage) }));
      return;
    }

    if (msg.type === "usage_refresh_prices") {
      usage?.refreshPrices();
      ws.send(JSON.stringify({ type: "usage_prices_refreshing", ok: Boolean(usage) }));
      return;
    }

    // ---- Voice (módulo de áudio global, sem projeto) ----
    if (msg.type === "voice_status") {
      const st = await voice.status();
      const cfg = voice.getConfig();
      ws.send(JSON.stringify({
        type: "voice_status",
        alive: st.alive,
        managed: st.managed,
        pid: st.pid,
        enabled: cfg?.enabled !== false,
        speechMode: cfg?.speech_mode || null,
      }));
      return;
    }
    if (msg.type === "voice_speak") {
      const text = (msg.text || "").toString();
      const preempt = msg.preempt !== false;
      const r = await voice.send("speak", { text, preempt });
      ws.send(JSON.stringify({ type: "voice_result", action: "speak", result: r }));
      return;
    }
    if (msg.type === "voice_stop") {
      const r = await voice.send("stop", {});
      ws.send(JSON.stringify({ type: "voice_result", action: "stop", result: r }));
      return;
    }
    if (msg.type === "voice_reload") {
      voice.loadConfig();
      const r = await voice.send("reload", {});
      ws.send(JSON.stringify({ type: "voice_result", action: "reload", result: r }));
      return;
    }
    if (msg.type === "voice_set_enabled") {
      const cfg = voice.getConfig() || voice.loadConfig();
      if (!cfg) {
        ws.send(JSON.stringify({ type: "voice_result", action: "set_enabled",
          result: { ok: false, error: "config não carregada" } }));
        return;
      }
      const next = typeof msg.enabled === "boolean" ? msg.enabled : !cfg.enabled;
      const r = voice.patchConfig({ enabled: next });
      if (r.ok) {
        if (!next) {
          // desativando: encerra o daemon de vez (não só silencia)
          await voice.stop();
        } else {
          // ativando: garante daemon vivo e recarrega config
          await voice.start();
          await voice.send("reload", {});
        }
      }
      ws.send(JSON.stringify({ type: "voice_result", action: "set_enabled",
        result: { ...r, enabled: next } }));
      return;
    }
    // ---- STT (ditado integrado ao cockpit) ----
    if (msg.type === "stt_status") {
      const st = await stt.status();
      ws.send(JSON.stringify({ type: "stt_status", ...st }));
      return;
    }
    if (msg.type === "stt_meta") {
      // marca esse ws como aguardando o próximo frame binário pra transcrever
      ws.__sttMeta = {
        projectId: msg.projectId,
        terminalId: msg.terminalId,
        ext: msg.ext || "webm",
      };
      return;
    }

    if (msg.type === "dictation_status") {
      ws.send(JSON.stringify({ type: "dictation_status", ...dictation.status() }));
      return;
    }
    if (msg.type === "dictation_start") {
      const r = dictation.start();
      ws.send(JSON.stringify({ type: "voice_result", action: "dictation_start", result: r }));
      return;
    }
    if (msg.type === "dictation_stop") {
      const r = dictation.stop();
      ws.send(JSON.stringify({ type: "voice_result", action: "dictation_stop", result: r }));
      return;
    }
    if (msg.type === "voice_patch_config") {
      // whitelist de chaves que o front pode editar via WS — campos
      // sensíveis (api_key, socket_path, voice_ref) ficam de fora.
      const ALLOWED = new Set([
        "enabled", "volume", "speed", "speech_mode",
        "max_chars", "seed", "voice_ref_text",
        "tts_engine", "openai_voice", "openai_model",
        "tts_instructions", "summary_min_chars", "pcm_cache_size",
      ]);
      // sub-objetos com merge raso (front manda só os campos que mudaram)
      const ALLOWED_OBJ = {
        summarize: new Set([
          "enabled", "provider", "model", "max_tokens", "timeout", "system_prompt",
          // api_key: entra no patch mas NUNCA é devolvida no voice_get_config
          // (mascarada como api_key_hint). Front nunca vê a chave inteira.
          "api_key",
        ]),
        // pronunciation é dict livre key→value; substituição completa
        pronunciation: null,
      };
      const patch = {};
      const incoming = msg.patch || {};
      for (const [k, v] of Object.entries(incoming)) {
        if (ALLOWED.has(k)) {
          patch[k] = v;
        } else if (k in ALLOWED_OBJ) {
          const allowedSub = ALLOWED_OBJ[k];
          if (allowedSub === null) {
            // dict livre (pronunciation) — aceita objeto inteiro
            if (v && typeof v === "object" && !Array.isArray(v)) {
              patch[k] = v;
            }
          } else {
            // merge raso com filtro de chaves. Spread inicial preserva tudo
            // que não está no patch (incluindo api_key se o front não mandou).
            // Quando o front MANDA explicitamente uma chave (mesmo vazia),
            // respeitamos a intenção — string vazia em api_key = remover.
            const current = (voice.getConfig() || {})[k] || {};
            const merged = { ...current };
            for (const [sk, sv] of Object.entries(v || {})) {
              if (allowedSub.has(sk)) merged[sk] = sv;
            }
            // limpar entrada vazia em api_key (mantém objeto enxuto)
            if (merged.api_key === "") delete merged.api_key;
            patch[k] = merged;
          }
        }
      }
      if (Object.keys(patch).length === 0) {
        ws.send(JSON.stringify({ type: "voice_result", action: "patch",
          result: { ok: false, error: "nenhuma chave válida" } }));
        return;
      }
      const r = voice.patchConfig(patch);
      if (r.ok) await voice.send("reload", {});
      ws.send(JSON.stringify({ type: "voice_result", action: "patch",
        result: { ...r, applied: patch } }));
      return;
    }
    if (msg.type === "voice_get_config") {
      const cfg = voice.loadConfig();
      if (!cfg) {
        ws.send(JSON.stringify({ type: "voice_config", ok: false, error: "config não carregada" }));
        return;
      }
      // mascara segredos antes de enviar pro front
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.summarize?.api_key) {
        const k = safe.summarize.api_key;
        safe.summarize.api_key_set = true;
        safe.summarize.api_key_hint = k.length > 8 ? k.slice(0, 4) + "…" + k.slice(-4) : "•••";
        delete safe.summarize.api_key;
      } else if (safe.summarize) {
        safe.summarize.api_key_set = false;
      }
      ws.send(JSON.stringify({ type: "voice_config", ok: true, config: safe }));
      return;
    }

    // ---- Project admin (sem session) ----
    if (msg.type === "list_dirs") {
      const result = await listDirs(msg.path);
      ws.send(JSON.stringify({ type: "dirs_result", request: msg.path || "", result }));
      return;
    }
    if (msg.type === "add_project") {
      const np = msg.project || {};
      const err = validateProjectShape(np, { isNew: true });
      if (err) {
        ws.send(JSON.stringify({ type: "project_admin_error", action: "add", error: err }));
        return;
      }
      const newProj = {
        id: np.id,
        name: np.name,
        path: np.path,
        color: np.color || "#5b8def",
        icon: np.icon || "cog",
        shell: np.shell || "bash",
        ...(np.group ? { group: np.group } : {}),
        commands: Array.isArray(np.commands) ? np.commands : [],
        // catálogo: só entram quando preenchidos, para não poluir o projects.json
        ...(np.description ? { description: np.description } : {}),
        ...(Array.isArray(np.aliases) && np.aliases.length ? { aliases: np.aliases } : {}),
        ...(Array.isArray(np.stack) && np.stack.length ? { stack: np.stack } : {}),
        ...(np.defaultAgent ? { defaultAgent: np.defaultAgent } : {}),
      };
      PROJECTS.push(newProj);
      try { await persistProjects(); } catch (e) {
        ws.send(JSON.stringify({ type: "project_admin_error", action: "add", error: "falha ao salvar: " + e.message }));
        PROJECTS.pop();
        return;
      }
      await createSession(newProj);
      broadcastProjectsChanged();
      ws.send(JSON.stringify({ type: "project_admin_ok", action: "add", id: newProj.id }));
      return;
    }
    if (msg.type === "update_project") {
      const idx = PROJECTS.findIndex((p) => p.id === msg.id);
      if (idx < 0) {
        ws.send(JSON.stringify({ type: "project_admin_error", action: "update", error: "projeto não encontrado" }));
        return;
      }
      const before = PROJECTS[idx];
      const merged = { ...before, ...pickProjectFields(msg.changes) };
      // se group veio vazio, remove
      if (merged.group === "" || merged.group === null) delete merged.group;
      // idem para o catálogo: campo apagado na tela sai do arquivo
      for (const field of ["description", "defaultAgent"]) {
        if (merged[field] === "" || merged[field] === null) delete merged[field];
      }
      for (const field of ["aliases", "stack"]) {
        if (Array.isArray(merged[field]) && merged[field].length === 0) delete merged[field];
      }
      const err = validateProjectShape(merged, { isNew: false, ignoreId: before.id });
      if (err) {
        ws.send(JSON.stringify({ type: "project_admin_error", action: "update", error: err }));
        return;
      }
      const idChanged = merged.id !== before.id;
      const pathChanged = merged.path !== before.path;
      PROJECTS[idx] = merged;
      try { await persistProjects(); } catch (e) {
        PROJECTS[idx] = before;
        ws.send(JSON.stringify({ type: "project_admin_error", action: "update", error: "falha ao salvar: " + e.message }));
        return;
      }
      // ajusta sessão
      if (idChanged) {
        const oldSession = sessions.get(before.id);
        if (oldSession) {
          killAllTerminals(oldSession);
          sessions.delete(before.id);
        }
        await createSession(merged);
      } else {
        const s = sessions.get(merged.id);
        if (s) {
          s.proj = merged;
          if (pathChanged) {
            killAllTerminals(s);
            await createTerminalIn(s, "Terminal 1");
          }
        }
      }
      broadcastProjectsChanged();
      ws.send(JSON.stringify({ type: "project_admin_ok", action: "update", id: merged.id }));
      return;
    }
    if (msg.type === "remove_project") {
      const idx = PROJECTS.findIndex((p) => p.id === msg.id);
      if (idx < 0) return;
      const removed = PROJECTS[idx];
      const s = sessions.get(removed.id);
      if (s) {
        killAllTerminals(s);
        sessions.delete(removed.id);
      }
      PROJECTS.splice(idx, 1);
      try { await persistProjects(); } catch (e) {
        PROJECTS.splice(idx, 0, removed);
        await createSession(removed);
        ws.send(JSON.stringify({ type: "project_admin_error", action: "remove", error: "falha ao salvar: " + e.message }));
        return;
      }
      broadcastProjectsChanged();
      ws.send(JSON.stringify({ type: "project_admin_ok", action: "remove", id: removed.id }));
      return;
    }
    if (msg.type === "reorder_projects") {
      if (!Array.isArray(msg.order)) return;
      const sorted = msg.order
        .map((id) => PROJECTS.find((p) => p.id === id))
        .filter(Boolean);
      if (sorted.length !== PROJECTS.length) return;
      PROJECTS.length = 0;
      PROJECTS.push(...sorted);
      try { await persistProjects(); } catch (e) {
        ws.send(JSON.stringify({ type: "project_admin_error", action: "reorder", error: e.message }));
        return;
      }
      broadcastProjectsChanged();
      return;
    }
    // ---- Reaper de terminais ociosos (podem abranger vários projetos) ----
    if (msg.type === "visible_terminals") {
      // cliente informa quais terminais estão à vista (aba ativa / cards do mosaico)
      const now = Date.now();
      if (Array.isArray(msg.ids)) {
        for (const pair of msg.ids) {
          const [pid, tid] = Array.isArray(pair) ? pair : [];
          const t = sessions.get(pid)?.terminals.get(tid);
          if (t) t.lastSeenTime = now;
        }
      }
      return;
    }
    if (msg.type === "keep_terminal") {
      // usuário clicou "Manter ativo" no aviso → reseta a ociosidade
      const t = sessions.get(msg.projectId)?.terminals.get(msg.terminalId);
      if (t) { t.lastInputTime = Date.now(); t.reapWarned = false; }
      return;
    }
    if (msg.type === "idle_reap_config") {
      idleReapEnabled = !!msg.enabled;
      return;
    }

    // ---- LifeAi ----
    // Sem projectId: é um agente global, não pertence a um terminal. Tudo vai
    // por broadcast para o painel sobreviver a uma reconexão do cliente.
    if (msg.type === "lifeai_status") {
      ws.send(JSON.stringify({ type: "lifeai_status", state: await lifeai.state() }));
      return;
    }
    // O console é outro projeto (lifeai-console), com servidor e sessão
    // próprios. Aqui só abrimos uma janela no endereço dele — e se ninguém
    // atender, o painel diz isso em vez de deixar o navegador reclamar.
    if (msg.type === "lifeai_console") {
      try {
        const { url } = await lifeai.consoleUrl();
        // Abrir endereço é ação privilegiada: só loopback sai daqui, mesmo que
        // alguém tenha apontado LIFEAI_CONSOLE_URL para fora.
        if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url)) {
          throw new Error("o endereço configurado está fora do loopback");
        }
        const plat = os.platform();
        const cmd = plat === "darwin" ? "open" : plat === "win32" ? "explorer.exe" : "xdg-open";
        execFile(cmd, [url], { windowsHide: true }, () => {});
      } catch (error) {
        // scope: o painel não pode pintar a bolinha da LifeAi de verde só
        // porque o console (outro processo) não atendeu.
        ws.send(JSON.stringify({
          type: "lifeai_error", scope: "console", message: `console: ${error.message}`,
        }));
      }
      return;
    }
    if (msg.type === "lifeai_ask") {
      const texto = String(msg.text || "").trim();
      if (!texto) return;
      try {
        const runId = await lifeai.ask(texto, {
          // Evento do agente é dado a exibir: o painel renderiza, nunca executa.
          onEvent: (event) => broadcast({ type: "lifeai_event", event }),
        });
        broadcast({ type: "lifeai_run_started", runId, text: texto });
      } catch (error) {
        broadcast({ type: "lifeai_error", message: error.message });
      }
      return;
    }
    if (msg.type === "lifeai_approval") {
      try {
        await lifeai.approve(String(msg.runId), String(msg.choice));
      } catch (error) {
        broadcast({ type: "lifeai_error", message: error.message });
      }
      return;
    }
    if (msg.type === "lifeai_stop_run") {
      try {
        await lifeai.stopRun(String(msg.runId));
      } catch (error) {
        broadcast({ type: "lifeai_error", message: error.message });
      }
      return;
    }

    // ---- Ações com session ----
    const session = sessions.get(msg.projectId);
    if (!session) return;

    switch (msg.type) {
      case "input": {
        const t = session.terminals.get(msg.terminalId);
        if (t?.pty) {
          t.lastInputTime = Date.now();
          t.pty.write(msg.data);
        }
        break;
      }
      case "resize": {
        const t = session.terminals.get(msg.terminalId);
        if (t) {
          t.cols = Math.max(1, Number(msg.cols) || 120);
          t.rows = Math.max(1, Number(msg.rows) || 30);
          try {
            t.pty?.resize(t.cols, t.rows);
          } catch {}
        }
        break;
      }
      case "create_terminal": {
        const fresh = await createTerminalIn(session, msg.name);
        broadcast({
          type: "terminal_added",
          projectId: session.proj.id,
          terminal: { ...terminalSummary(fresh), buffer: fresh.buffer.join("") },
        });
        break;
      }
      case "close_terminal": {
        const ok = killTerminal(session, msg.terminalId);
        if (ok) {
          broadcast({
            type: "terminal_closed",
            projectId: session.proj.id,
            terminalId: msg.terminalId,
          });
        }
        break;
      }
      case "rename_terminal": {
        const t = session.terminals.get(msg.terminalId);
        if (t && msg.name) {
          // O uid acompanha o terminal, não o nome: renomear na interface não
          // pode fazer o vigia parar de acordar esta frente em silêncio.
          const frente = t.frontUid
            ? fronts?.rename(t.frontUid, msg.name)
            : fronts?.ensure(session.proj.id, msg.name);
          if (frente) t.frontUid = frente.uid;
          t.name = msg.name;
          inventory?.schedule();
          broadcast({
            type: "terminal_renamed",
            projectId: session.proj.id,
            terminalId: msg.terminalId,
            name: msg.name,
          });
        }
        break;
      }
      case "restart": {
        const t = session.terminals.get(msg.terminalId);
        if (!t) break;
        const oldName = t.name;
        killTerminal(session, msg.terminalId);
        broadcast({
          type: "terminal_closed",
          projectId: session.proj.id,
          terminalId: msg.terminalId,
        });
        const fresh = await createTerminalIn(session, oldName);
        broadcast({
          type: "terminal_added",
          projectId: session.proj.id,
          terminal: { ...terminalSummary(fresh), buffer: fresh.buffer.join("") },
        });
        break;
      }
      case "clear": {
        broadcast({
          type: "cleared",
          projectId: session.proj.id,
          terminalId: msg.terminalId,
        });
        break;
      }
      case "git_status": {
        const result = await gitStatus(session.proj.path);
        ws.send(
          JSON.stringify({
            type: "git_result",
            action: "status",
            projectId: msg.projectId,
            result,
          })
        );
        break;
      }
      case "git_diff": {
        const repoPath = msg.repoPath || ".";
        const repoAbs = resolveRepoPath(session.proj.path, repoPath);
        if (!repoAbs) {
          ws.send(
            JSON.stringify({
              type: "git_result",
              action: "diff",
              projectId: msg.projectId,
              repoPath,
              file: msg.file,
              staged: !!msg.staged,
              result: { ok: false, error: "repositório inválido" },
            })
          );
          break;
        }
        const result = await gitDiff(repoAbs, msg.file, !!msg.staged);
        ws.send(
          JSON.stringify({
            type: "git_result",
            action: "diff",
            projectId: msg.projectId,
            repoPath,
            file: msg.file,
            staged: !!msg.staged,
            result,
          })
        );
        break;
      }
      case "list_files": {
        const result = await listFiles(session.proj.path, msg.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "list",
          projectId: msg.projectId, path: msg.path || "", result,
        }));
        break;
      }
      case "search_files": {
        const result = await fileSearch.search(session.proj.path, msg.query, {
          refresh: msg.refresh === true,
        });
        ws.send(JSON.stringify({
          type: "files_result", action: "search",
          projectId: msg.projectId,
          requestId: Number(msg.requestId) || 0,
          result,
        }));
        break;
      }
      case "read_file": {
        const result = await readFileContent(session.proj.path, msg.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "read",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "open_external": {
        const result = await openExternalFile(session.proj.path, msg.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "open_external",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "write_file": {
        const result = await writeFileContent(session.proj.path, msg.path, msg.content);
        ws.send(JSON.stringify({
          type: "files_result", action: "write",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "rename_path": {
        const result = await renamePath(session.proj.path, msg.from, msg.to);
        if (result.ok) fileSearch.invalidate(session.proj.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "rename",
          projectId: msg.projectId, from: msg.from, to: msg.to, result,
        }));
        break;
      }
      case "delete_path": {
        const result = await deletePath(session.proj.path, msg.path);
        if (result.ok) fileSearch.invalidate(session.proj.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "delete",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "create_file": {
        const result = await createFile(session.proj.path, msg.path, msg.content || "");
        if (result.ok) fileSearch.invalidate(session.proj.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "create_file",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "create_dir": {
        const result = await createDir(session.proj.path, msg.path);
        if (result.ok) fileSearch.invalidate(session.proj.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "create_dir",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "duplicate_path": {
        const result = await duplicatePath(session.proj.path, msg.from, msg.to);
        if (result.ok) fileSearch.invalidate(session.proj.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "duplicate",
          projectId: msg.projectId, from: msg.from, to: msg.to, result,
        }));
        break;
      }
      case "import_external": {
        const result = await importExternal(session.proj.path, msg.src, msg.to, !!msg.overwrite);
        if (result.ok) fileSearch.invalidate(session.proj.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "import_external",
          projectId: msg.projectId, src: msg.src, to: msg.to, result,
        }));
        break;
      }
      case "git_command": {
        // msg.args é array, ex: ['add', 'arquivo.js']
        if (!Array.isArray(msg.args) || msg.args.length === 0) break;
        const repoPath = msg.repoPath || ".";
        const repoAbs = resolveRepoPath(session.proj.path, repoPath);
        if (!repoAbs) {
          ws.send(
            JSON.stringify({
              type: "git_result",
              action: "command",
              projectId: msg.projectId,
              repoPath,
              args: msg.args,
              result: { ok: false, error: "repositório inválido" },
            })
          );
          break;
        }
        const result = await git(repoAbs, msg.args);
        ws.send(
          JSON.stringify({
            type: "git_result",
            action: "command",
            projectId: msg.projectId,
            repoPath,
            args: msg.args,
            result,
          })
        );
        break;
      }
    }
  });

  ws.on("close", () => clients.delete(ws));
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(str);
}

function broadcastTerminalStatus(session, terminal) {
  broadcast({
    type: "status",
    projectId: session.proj.id,
    terminalId: terminal.id,
    status: terminal.status,
    statusText: terminal.statusText,
  });
}

// ticker pra atualizar status idle ao longo do tempo
setInterval(() => {
  for (const s of sessions.values()) {
    for (const t of s.terminals.values()) updateTerminalStatus(s, t);
  }
}, 2000);

// =========================================================
// REAPER — encerra terminais ociosos há muito tempo (economia de memória).
// Nunca encerra terminais com processo rodando, "aguardando" (agente), ou
// visíveis. Avisa ~2min antes; o usuário pode "Manter ativo".
// =========================================================
const IDLE_REAP_MS = (() => {
  const v = parseInt(process.env.COCKPIT_IDLE_REAP_MS, 10);
  return Number.isFinite(v) ? v : 2 * 60 * 60 * 1000; // 2h padrão; 0 desliga
})();
const envMs = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) ? v : def; };
const REAP_WARN_MS = envMs("COCKPIT_IDLE_REAP_WARN_MS", 2 * 60 * 1000);   // avisa 2 min antes
const REAP_SEEN_GRACE = envMs("COCKPIT_IDLE_REAP_SEEN_MS", 90 * 1000);    // protege visto nos últimos 90s
const REAP_TICK = envMs("COCKPIT_IDLE_REAP_TICK_MS", 20 * 1000);          // frequência da varredura
let idleReapEnabled = IDLE_REAP_MS > 0; // toggle via ws idle_reap_config

setInterval(() => {
  if (!idleReapEnabled || IDLE_REAP_MS <= 0) return;
  const now = Date.now();
  for (const s of sessions.values()) {
    for (const [tid, t] of s.terminals) {
      const idle = now - Math.max(t.lastOutputTime, t.lastInputTime);
      const seen = now - t.lastSeenTime;
      const candidate =
        idle >= IDLE_REAP_MS - REAP_WARN_MS &&
        t.status !== "waiting" &&        // agente aguardando você — nunca matar
        seen > REAP_SEEN_GRACE &&        // proteção do visível
        !hasForegroundChild(t);          // processo rodando — nunca matar

      if (!candidate) {
        if (t.reapWarned) {
          t.reapWarned = false;
          broadcast({ type: "terminal_reap_cancel", projectId: s.proj.id, terminalId: tid });
        }
        continue;
      }

      if (idle >= IDLE_REAP_MS) {
        killTerminal(s, tid);
        broadcast({ type: "terminal_closed", projectId: s.proj.id, terminalId: tid, reason: "idle" });
      } else if (!t.reapWarned) {
        t.reapWarned = true;
        const deadline = Math.max(t.lastOutputTime, t.lastInputTime) + IDLE_REAP_MS;
        broadcast({ type: "terminal_reap_warning", projectId: s.proj.id, terminalId: tid, name: t.name, deadline });
      }
    }
  }
}, REAP_TICK);

// =========================================================
// HTTP
// =========================================================
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".ttc": "font/collection",
};

const server = http.createServer((req, res) => {
  const u = url.parse(req.url);
  if (controlApi?.handle(req, res)) return;
  if (teamRouter.handle(req, res, u)) return;
  if (agentWake.handle(req, res, u)) return;
  if (u.pathname === "/projects.json") {
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify(PROJECTS));
    return;
  }
  // /accounts/usage — somente o pool central. Quando desconectado, retorna
  // vazio deliberadamente: nunca faça fallback para credenciais do host.
  if (u.pathname === "/accounts/usage") {
    const usage = teamRouter.status().connected
      ? teamRouter.usageTable()
      : Promise.resolve({ claude: [], codex: [], central: true, connected: false });
    usage
      .then((table) => {
        res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
        res.end(JSON.stringify(table));
      })
      .catch((err) => {
        console.warn(`[cockpit/accounts] uso indisponível: ${err?.message || "erro"}`);
        res.writeHead(503, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "uso das contas indisponível" }));
      });
    return;
  }
  // /file/<projectId>/<relPath...> — serve conteúdo bruto de arquivos do
  // projeto para preview de imagens/PDFs no editor. safePath impede escape.
  if (u.pathname && u.pathname.startsWith("/file/")) {
    let rest;
    try {
      rest = decodeURIComponent(u.pathname.slice("/file/".length));
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("invalid file path");
      return;
    }
    const slash = rest.indexOf("/");
    const projectId = slash >= 0 ? rest.slice(0, slash) : rest;
    const relPath = slash >= 0 ? rest.slice(slash + 1) : "";
    const proj = PROJECTS.find((p) => p.id === projectId);
    if (!proj) { res.writeHead(404); res.end("project not found"); return; }
    const abs = safePath(proj.path, relPath);
    if (!abs) { res.writeHead(403); res.end("forbidden"); return; }
    fs.stat(abs, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end("not found"); return; }
      const ext = path.extname(abs).toLowerCase();
      const previewable = new Set([
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg", ".pdf",
      ]);
      if (!previewable.has(ext)) {
        res.writeHead(415, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("preview not supported");
        return;
      }
      const mime = MIME[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(abs).pipe(res);
    });
    return;
  }
  let rel = u.pathname === "/" ? "/index.html" : u.pathname;
  const publicRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(publicRoot, `.${rel}`);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "text/plain" });
    res.end(data);
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!SERVER_URL) {
    socket.destroy();
    return;
  }
  const expected = new URL(SERVER_URL);
  const fetchSite = String(req.headers["sec-fetch-site"] || "");
  const allowed = String(req.headers.host || "") === expected.host
    && req.headers.origin === expected.origin
    && (!fetchSite || ["same-origin", "none"].includes(fetchSite));
  if (!allowed) {
    try { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); } catch {}
    socket.destroy();
    return;
  }
  const u = url.parse(req.url, true);
  if (u.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (u.pathname === "/lsp") {
    const projectId = u.query.project;
    const language = u.query.lang || "typescript";
    const proj = PROJECTS.find((p) => p.id === projectId);
    if (!proj) {
      socket.destroy();
      return;
    }
    lspWss.handleUpgrade(req, socket, head, (ws) => {
      attachLspWebSocket(ws, {
        projectId: proj.id,
        projectPath: proj.path,
        language,
      });
    });
  } else {
    socket.destroy();
  }
});

// =========================================================
// BOOT — exportado pra Electron e CLI
// =========================================================
async function shutdown(opts = {}) {
  const log = opts.log || console;
  log.log("\x1b[36m▸ cockpit\x1b[0m encerrando sessões…");
  if (controlApi) {
    removeControlDescriptor(controlDescriptorPath, controlApi.instanceId);
    controlDescriptorPath = null;
    controlApi = null;
  }
  for (const s of sessions.values()) {
    // no shutdown não há segundo tempo pro SIGKILL de cortesia: o processo sai
    // antes do timer, então derruba a árvore direto
    killAllTerminals(s, { hard: true });
  }
  if (teamSelectionSyncTimer) {
    clearInterval(teamSelectionSyncTimer);
    teamSelectionSyncTimer = null;
  }
  teamAccounts.cleanupRuntime();
  try { dictation.stop(); } catch {}
  shutdownAllLsp();
  // A LifeAi não é encerrada aqui de propósito: ela é um serviço à parte e
  // precisa continuar respondendo (Telegram, demandas fora do Cockpit).
  await voice.stop().catch(() => {});
  await stt.stop().catch(() => {});
  await usage?.stop().catch(() => {});
  usage = null;
  await demands?.close().catch(() => {});
  demands = null;
  // O inventário fecha depois dos terminais: a última escrita mostra as frentes
  // sem janela, que é a verdade de quem lê o arquivo com o Cockpit desligado.
  await inventory?.close().catch(() => {});
  inventory = null;
  await fronts?.close().catch(() => {});
  fronts = null;
  if (opts.exit !== false) process.exit(0);
}

export async function startServer({
  port = 3737,
  rootDir = DEFAULT_ROOT,
  publicDir = path.join(rootDir, "public"),
  projectsPath = path.join(rootDir, "projects.json"),
  voiceConfigPath = null,
  voiceLogsDir = null,
  voiceEnabled = true,
  dictationEnabled = true,
  usageEnabled = process.env.COCKPIT_USAGE !== "0",
  controlPolicy = null,
  controlPolicyPath = null,
  controlRuntimeDir = null,
  log = console,
} = {}) {
  PORT = port;
  ROOT = rootDir;
  PUBLIC_DIR = publicDir;
  PROJECTS_PATH = projectsPath;

  // Em produção (Electron empacotado) o config e os logs do voice ficam no
  // userData, fora do asar (que é read-only). O electron-main injeta os caminhos.
  if (voiceConfigPath || voiceLogsDir) {
    voice.init({ configPath: voiceConfigPath, logsDir: voiceLogsDir });
  }
  // STT reusa o mesmo diretório de logs do voice
  if (voiceLogsDir) {
    stt.init({ logsDir: voiceLogsDir });
  }

  // carrega projetos do path configurado
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
  } catch (e) {
    log.log(`\x1b[31m▸ cockpit\x1b[0m falha ao ler ${projectsPath}: ${e.message}`);
    raw = [];
  }
  PROJECTS.length = 0;
  for (const p of raw) PROJECTS.push(p);

  // registro de demandas: precisa existir antes da Control API, que despacha
  // por ele, e depois dos projetos, para o arquivo morar ao lado do projects.json
  demands = createDemandStore({
    filePath: defaultDemandsPath(projectsPath),
    log: (msg) => log.log?.(msg),
  });
  demands.load();

  // Registro de frentes: precisa estar carregado antes do primeiro terminal
  // nascer, senão o terminal abre sem uid e a frente vira nova a cada boot.
  fronts = createFrontStore({
    filePath: defaultFrontsPath(projectsPath),
    log: (msg) => log.log?.(msg),
  });
  fronts.load();

  // Inventário em disco: o que existe nesta máquina, endereçável por frente.
  inventory = createInventoryWriter({
    collect: () => collectInventoryFronts(),
    log: (msg) => log.log?.(msg),
  });

  // Política injetada (testes) fica fixa; a que vem de arquivo se relê sozinha
  // quando o JSON muda. O Cockpit fica aberto por dias com agentes dentro: sem
  // isso, liberar um projeto para o MCP custaria um restart, e restart mata
  // todos os terminais.
  const effectiveControlPolicy = controlPolicy
    ? normalizeControlPolicy(controlPolicy)
    : createControlPolicySource(
        controlPolicyPath || path.join(path.dirname(projectsPath), "mcp-policy.json"),
        { log },
      );
  const controlAdapter = createControlAdapter();
  controlApi = createControlApi({
    cockpitVersion: APP_VERSION,
    policy: effectiveControlPolicy,
    adapter: controlAdapter,
    demands,
    dispatcher: createDispatcher({
      adapter: controlAdapter,
      demands,
      // mesma leitura de scrollback do status de terminal — sem cursor próprio
      readTail: (projectId, terminalId) => {
        const terminal = sessions.get(projectId)?.terminals.get(terminalId);
        return terminal ? recentText(terminal, 4096) : "";
      },
      log: (msg) => log.log?.(msg),
    }),
    log,
  });
  // A fonte que se relê é uma função; a política injetada nos testes é um
  // objeto. Aqui só interessa o retrato do boot, para o aviso abaixo.
  const politicaDoBoot =
    typeof effectiveControlPolicy === "function"
      ? effectiveControlPolicy()
      : effectiveControlPolicy;
  // Sem `.size` quando é "all" — aí não há o que avisar.
  if (politicaDoBoot.projects.size === 0) {
    log.log(
      "\x1b[33m▸ cockpit control\x1b[0m política sem projetos; acesso MCP negado por padrão",
    );
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const serverUrl = `http://127.0.0.1:${actualPort}`;
  SERVER_URL = serverUrl;
  log.log(`\n\x1b[36m▸ cockpit\x1b[0m rodando em \x1b[1m${serverUrl}\x1b[0m\n`);

  // Cada terminal faz sua própria seleção no backend. Não bloqueie o boot com
  // uma seleção global: falhas e retentativas precisam aparecer dentro do
  // terminal correspondente, sempre sem fallback para credenciais do host.
  // O Electron costuma permanecer aberto por dias. Rebaixe a seleção em
  // memória periodicamente para que novos/reiniciados PTYs nunca dependam do
  // token carregado no boot do aplicativo.
  startTeamSelectionSync(log);

  // Só cria PTYs depois que a porta real é conhecida. Além de impedir PTYs
  // órfãos quando a porta fixa está ocupada, isso permite injetar nos novos
  // terminais o endpoint loopback usado pelo broker de autenticação.
  log.log("\x1b[36m▸ cockpit\x1b[0m criando sessões…");
  for (const p of PROJECTS) {
    const exists = fs.existsSync(p.path);
    log.log(
      `  \x1b[2m·\x1b[0m ${p.id.padEnd(12)} ${
        exists ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠\x1b[0m"
      } ${p.path}`
    );
    await createSession(p, { autoTerminal: false });
  }

  // Só publique a capability depois que todas as sessions existirem. Assim,
  // encontrar control.json também significa que a API está pronta para uso.
  try {
    controlDescriptorPath = writeControlDescriptor(
      {
        schemaVersion: 1,
        controlUrl: `${serverUrl}${CONTROL_API_PREFIX}`,
        token: controlApi.token,
        instanceId: controlApi.instanceId,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      },
      controlRuntimeDir ? { runtimeDir: controlRuntimeDir } : undefined,
    );
  } catch (error) {
    controlDescriptorPath = null;
    log.warn?.(
      `[cockpit/control] descriptor runtime indisponível: ${error.message}`,
    );
  }

  // Coletor de uso de tokens: worker próprio, único escritor do usage.db.
  // Best-effort como voz/ditado — se não subir, o Cockpit funciona sem métricas.
  if (!usageEnabled) {
    log.log?.(`\x1b[33m▸ uso\x1b[0m coleta desligada (COCKPIT_USAGE=0)`);
  } else try {
    usage = createUsageService({
      log,
      appVersion: `cockpit/${APP_VERSION}`,
      // Caminho absoluto do projeto sai da máquina só se pedirem: nome de pasta
      // de cliente não precisa aparecer no painel para a conta fechar.
      sendProjectPaths: process.env.COCKPIT_USAGE_PATHS === "1",
      onEvent: (evento) => {
        // Só o que a UI precisa ver: progresso do backfill e fim de varredura.
        if (evento?.type === "progress" || evento?.type === "scan_done" || evento?.type === "backfill_done") {
          broadcast({ type: "usage_progress", ...evento });
        }
      },
    });
    usage.start({ projects: PROJECTS });
  } catch (error) {
    usage = null;
    log.warn?.(`[cockpit/uso] coletor indisponível: ${error.message}`);
  }

  // voz/ditado opt-in — não derrubam o boot se faltar binário
  if (voiceEnabled && process.platform === "linux") {
    voice.start().catch((e) =>
      log.log(`\x1b[33m▸ voice\x1b[0m offline: ${e.message}`)
    );
  } else if (voiceEnabled) {
    log.log(`\x1b[33m▸ voice\x1b[0m disponível só em Linux por enquanto`);
  }
  // STT: também só em Linux por enquanto (depende do venv com faster-whisper).
  // Falha silenciosa — o UI mostra o estado e o usuário decide.
  if (dictationEnabled && process.platform === "linux") {
    stt.start().catch((e) =>
      log.log(`\x1b[33m▸ stt\x1b[0m offline: ${e.message}`)
    );
  }

  return {
    url: serverUrl,
    port: actualPort,
    shutdown: (opts) => shutdown({ exit: false, ...opts }),
    server,
    PROJECTS,
    control: {
      instanceId: controlApi.instanceId,
      descriptorPath: controlDescriptorPath,
    },
  };
}

// CLI mode — `node server.js`
const isCLI = (() => {
  try {
    const argvPath = process.argv[1] && fs.realpathSync(process.argv[1]);
    const modPath = fs.realpathSync(url.fileURLToPath(import.meta.url));
    return argvPath === modPath;
  } catch {
    return false;
  }
})();
if (isCLI) {
  await startServer();
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}
