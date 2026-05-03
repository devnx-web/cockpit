import http from "http";
import fs from "fs";
import path from "path";
import url from "url";
import { execFile } from "child_process";
import { WebSocketServer } from "ws";
import pkg from "node-pty";
import * as voice from "./lib/voice.js";
import * as dictation from "./lib/dictation.js";
import { attachLspWebSocket, shutdownAllLsp } from "./lib/lsp.js";
const { spawn } = pkg;

const PORT = 3737;
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PROJECTS = JSON.parse(fs.readFileSync(path.join(ROOT, "projects.json"), "utf8"));

// =========================================================
// SESSÕES — agora 1 projeto contém N terminais (PTYs)
// session = { proj, terminals: Map<tid, terminal>, nextId, slot }
// terminal = { id, name, pty, buffer[], lastOutputTime, status, statusText }
// =========================================================
const sessions = new Map();

function createTerminalIn(session, name = null) {
  const tid = `t${session.nextId++}`;
  const cwd = fs.existsSync(session.proj.path) ? session.proj.path : process.env.HOME;

  const pty = spawn(session.proj.shell || "bash", [], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env,
      ...(session.proj.env || {}),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COCKPIT_PROJECT: session.proj.id,
      COCKPIT_TERMINAL: tid,
      COCKPIT: "1",
    },
  });

  const terminal = {
    id: tid,
    name: name || `Terminal ${session.terminals.size + 1}`,
    pty,
    buffer: [],
    bufferSize: 0,
    maxBufferSize: 200 * 1024,
    lastOutputTime: Date.now(),
    status: "idle",
    statusText: "iniciando…",
  };

  pty.onData((data) => {
    terminal.lastOutputTime = Date.now();
    terminal.buffer.push(data);
    terminal.bufferSize += data.length;
    while (terminal.bufferSize > terminal.maxBufferSize && terminal.buffer.length > 1) {
      terminal.bufferSize -= terminal.buffer.shift().length;
    }
    broadcast({
      type: "output",
      projectId: session.proj.id,
      terminalId: tid,
      data,
    });
    updateTerminalStatus(session, terminal);
  });

  pty.onExit((evt) => {
    terminal.status = evt.exitCode === 0 ? "idle" : "error";
    terminal.statusText =
      evt.exitCode === 0 ? "shell encerrado" : `falhou (exit ${evt.exitCode})`;
    broadcastTerminalStatus(session, terminal);
  });

  session.terminals.set(tid, terminal);
  return terminal;
}

function createSession(proj) {
  const session = {
    proj,
    terminals: new Map(),
    nextId: 1,
  };
  sessions.set(proj.id, session);
  // cada projeto começa com 1 terminal default
  createTerminalIn(session, "Terminal 1");
  return session;
}

function killTerminal(session, tid) {
  const t = session.terminals.get(tid);
  if (!t) return false;
  try {
    t.pty.kill();
  } catch {}
  session.terminals.delete(tid);
  return true;
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
    projects: PROJECTS.map((p) => {
      const s = sessions.get(p.id);
      return {
        ...p,
        terminals: s ? Array.from(s.terminals.values()).map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          statusText: t.statusText,
          buffer: t.buffer.join(""),
        })) : [],
      };
    }),
  };
}

async function persistProjects() {
  const json = JSON.stringify(PROJECTS, null, 2) + "\n";
  await fs.promises.writeFile(path.join(ROOT, "projects.json"), json, "utf8");
}

function broadcastProjectsChanged() {
  // versão leve sem buffer (clientes mantêm o que já têm)
  broadcast({
    type: "projects_changed",
    projects: PROJECTS.map((p) => {
      const s = sessions.get(p.id);
      return {
        ...p,
        terminals: s ? Array.from(s.terminals.values()).map((t) => ({
          id: t.id, name: t.name, status: t.status, statusText: t.statusText,
        })) : [],
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
  if (isNew && PROJECTS.find((x) => x.id === p.id)) return `já existe um projeto com id "${p.id}"`;
  if (!isNew && p.id !== ignoreId && PROJECTS.find((x) => x.id === p.id))
    return `já existe um projeto com id "${p.id}"`;
  return null;
}

async function listDirs(absPath) {
  try {
    const target = absPath && absPath.trim() ? absPath : process.env.HOME;
    if (!path.isAbsolute(target)) return { ok: false, error: "caminho deve ser absoluto" };
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    return { ok: true, path: target, dirs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function terminalSummary(t) {
  return { id: t.id, name: t.name, status: t.status, statusText: t.statusText };
}

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(helloPayload()));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
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
      ]);
      const patch = {};
      const incoming = msg.patch || {};
      for (const [k, v] of Object.entries(incoming)) {
        if (ALLOWED.has(k)) patch[k] = v;
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
      };
      PROJECTS.push(newProj);
      try { await persistProjects(); } catch (e) {
        ws.send(JSON.stringify({ type: "project_admin_error", action: "add", error: "falha ao salvar: " + e.message }));
        PROJECTS.pop();
        return;
      }
      createSession(newProj);
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
      const merged = { ...before, ...msg.changes };
      // se group veio vazio, remove
      if (merged.group === "" || merged.group === null) delete merged.group;
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
          for (const t of oldSession.terminals.values()) try { t.pty.kill(); } catch {}
          sessions.delete(before.id);
        }
        createSession(merged);
      } else {
        const s = sessions.get(merged.id);
        if (s) {
          s.proj = merged;
          if (pathChanged) {
            for (const t of s.terminals.values()) try { t.pty.kill(); } catch {}
            s.terminals.clear();
            createTerminalIn(s, "Terminal 1");
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
        for (const t of s.terminals.values()) try { t.pty.kill(); } catch {}
        sessions.delete(removed.id);
      }
      PROJECTS.splice(idx, 1);
      try { await persistProjects(); } catch (e) {
        PROJECTS.splice(idx, 0, removed);
        createSession(removed);
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

    // ---- Ações com session ----
    const session = sessions.get(msg.projectId);
    if (!session) return;

    switch (msg.type) {
      case "input": {
        const t = session.terminals.get(msg.terminalId);
        if (t) t.pty.write(msg.data);
        break;
      }
      case "resize": {
        const t = session.terminals.get(msg.terminalId);
        if (t) {
          try {
            t.pty.resize(msg.cols || 120, msg.rows || 30);
          } catch {}
        }
        break;
      }
      case "create_terminal": {
        const fresh = createTerminalIn(session, msg.name);
        broadcast({
          type: "terminal_added",
          projectId: session.proj.id,
          terminal: { ...terminalSummary(fresh), buffer: "" },
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
          t.name = msg.name;
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
        try {
          t.pty.kill();
        } catch {}
        session.terminals.delete(msg.terminalId);
        broadcast({
          type: "terminal_closed",
          projectId: session.proj.id,
          terminalId: msg.terminalId,
        });
        const fresh = createTerminalIn(session, oldName);
        broadcast({
          type: "terminal_added",
          projectId: session.proj.id,
          terminal: { ...terminalSummary(fresh), buffer: "" },
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
      case "read_file": {
        const result = await readFileContent(session.proj.path, msg.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "read",
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
        ws.send(JSON.stringify({
          type: "files_result", action: "rename",
          projectId: msg.projectId, from: msg.from, to: msg.to, result,
        }));
        break;
      }
      case "delete_path": {
        const result = await deletePath(session.proj.path, msg.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "delete",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "create_file": {
        const result = await createFile(session.proj.path, msg.path, msg.content || "");
        ws.send(JSON.stringify({
          type: "files_result", action: "create_file",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "create_dir": {
        const result = await createDir(session.proj.path, msg.path);
        ws.send(JSON.stringify({
          type: "files_result", action: "create_dir",
          projectId: msg.projectId, path: msg.path, result,
        }));
        break;
      }
      case "duplicate_path": {
        const result = await duplicatePath(session.proj.path, msg.from, msg.to);
        ws.send(JSON.stringify({
          type: "files_result", action: "duplicate",
          projectId: msg.projectId, from: msg.from, to: msg.to, result,
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
// HTTP
// =========================================================
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const u = url.parse(req.url);
  if (u.pathname === "/projects.json") {
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify(PROJECTS));
    return;
  }
  let rel = u.pathname === "/" ? "/index.html" : u.pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
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
// BOOT
// =========================================================
console.log("\x1b[36m▸ cockpit\x1b[0m criando sessões…");
PROJECTS.forEach((p) => {
  const exists = fs.existsSync(p.path);
  console.log(
    `  \x1b[2m·\x1b[0m ${p.id.padEnd(12)} ${
      exists ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠\x1b[0m"
    } ${p.path}`
  );
  createSession(p);
});

server.listen(PORT, async () => {
  console.log(`\n\x1b[36m▸ cockpit\x1b[0m rodando em \x1b[1mhttp://localhost:${PORT}\x1b[0m\n`);
  // sobe o daemon de voz em background — não bloqueia o boot
  voice.start().catch((e) => console.log(`\x1b[31m▸ voice\x1b[0m falhou: ${e.message}`));
});

async function shutdown() {
  console.log("\n\x1b[36m▸ cockpit\x1b[0m encerrando sessões…");
  for (const s of sessions.values()) {
    for (const t of s.terminals.values()) {
      try {
        t.pty.kill();
      } catch {}
    }
  }
  dictation.stop();
  shutdownAllLsp();
  await voice.stop().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
