/**
 * Leitura incremental dos JSONL dos agentes.
 *
 * O ponto delicado é o cursor. São 4,8 GB de log que crescem enquanto lemos, e
 * reler tudo a cada varredura está fora de questão — então guardamos um offset em
 * bytes por arquivo. Quatro regras sustentam a corretude:
 *
 *  1. O offset só avança até o último `\n` completo. A linha parcial de um arquivo
 *     sendo escrito neste instante fica no carry e é relida na próxima passada.
 *  2. O carry é `Buffer`, nunca string. Decodificar um chunk cortado no meio de um
 *     caractere UTF-8 (e há acentuação em toda parte) corromperia o cursor em silêncio.
 *  3. Prefiltro por substring antes de `JSON.parse` — descarta ~90% das linhas.
 *  4. Eventos, offset e cursor do parser vão na MESMA transação. Se o processo morrer
 *     antes do commit, relemos o trecho e o `UNIQUE(event_key)` absorve a repetição.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { DERIVED_PREFIX, NO_PROJECT, hourOf } from "./db.js";
import { isClaudeCandidate, parseClaudeLine } from "./parse-claude.js";
import { createCodexCursor, isCodexCandidate, parseCodexLine } from "./parse-codex.js";

const CHUNK_SIZE = 1024 * 1024;
const HEAD_SIG_BYTES = 4096;
const NEWLINE = 0x0a;

/**
 * Roots conhecidos. O broker de contas isola o perfil do Claude em `~/.cockpit/claude`,
 * então há DOIS roots do Claude nesta máquina — varrer só `~/.claude` perderia metade
 * do histórico. O Codex usa o root compartilhado; o isolado é procurado mesmo assim
 * porque nada garante que continue assim.
 */
export function discoverRoots(homeDir) {
  const candidates = [
    { tag: "claude-home", provider: "claude", dir: path.join(homeDir, ".claude", "projects") },
    { tag: "claude-cockpit", provider: "claude", dir: path.join(homeDir, ".cockpit", "claude", "projects") },
    { tag: "codex-home", provider: "codex", dir: path.join(homeDir, ".codex", "sessions") },
    { tag: "codex-cockpit", provider: "codex", dir: path.join(homeDir, ".cockpit", "codex", "sessions") },
  ];
  return candidates.filter((root) => {
    try {
      return fs.statSync(root.dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function inodeKey(stat) {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Varre os roots. `readdirSync(recursive)` leva ~15 ms para os 2.833 arquivos desta
 * máquina — barato o bastante para rodar a cada 20 s e dispensar `fs.watch`, que
 * perde eventos sob carga de inotify e não serve como fonte de verdade.
 */
export function scanRoots(roots) {
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root.dir, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(entry.parentPath ?? entry.path, entry.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      found.push({
        path: filePath,
        provider: root.provider,
        rootTag: root.tag,
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        ino: inodeKey(stat),
      });
    }
  }
  // mtime desc: os últimos dias entram primeiro e a UI mostra dado útil em segundos,
  // enquanto o histórico completo ainda está sendo processado.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

function headSignature(fd) {
  const buf = Buffer.allocUnsafe(HEAD_SIG_BYTES);
  const read = fs.readSync(fd, buf, 0, HEAD_SIG_BYTES, 0);
  if (read <= 0) return null;
  return crypto.createHash("sha1").update(buf.subarray(0, read)).digest("hex");
}

/**
 * Atribui um `cwd` ao projeto do Cockpit que o contém, pelo prefixo mais longo.
 *
 * Não usamos o dir-slug do Claude (`-home-ftgk-cockpit`): a codificação é lossy —
 * `-` representa `/`, `_` e o próprio `-`, então o caminho não volta sem ambiguidade.
 * O `cwd` cru está em toda linha `assistant` e no `session_meta` do Codex (medido:
 * presente em 100% dos eventos), então a atribuição sai de graça e exata.
 */
/** Marcadores de raiz de repositório, na ordem em que ganham. */
const REPO_MARKERS = [".git", ".hg", ".svn"];

export class ProjectResolver {
  #rules = [];
  #cache = new Map();
  #db = null;
  #homeDir = null;

  /**
   * @param {Array} projects lista do `projects.json`
   * @param {{db?: UsageDb, homeDir?: string}} options `db` liga a descoberta de
   *   projetos não cadastrados; sem ele o comportamento é o de prefixo puro.
   */
  constructor(projects = [], { db = null, homeDir = null } = {}) {
    this.#db = db;
    this.#homeDir = homeDir ? path.resolve(homeDir) : null;
    this.setProjects(projects);
  }

  setProjects(projects) {
    this.#rules = (projects ?? [])
      .filter((p) => p && typeof p.path === "string" && p.path)
      .map((p) => ({ id: p.id, path: path.resolve(p.path).replace(/[/\\]+$/, "") }))
      // Prefixo mais longo primeiro: um projeto aninhado vence o pai que o contém.
      .sort((a, b) => b.path.length - a.path.length);
    this.#cache.clear();
    return this;
  }

  resolve(cwd) {
    if (typeof cwd !== "string" || !cwd) return NO_PROJECT;
    const cached = this.#cache.get(cwd);
    if (cached !== undefined) return cached;

    const target = path.resolve(cwd).replace(/[/\\]+$/, "");
    let hit = NO_PROJECT;
    for (const rule of this.#rules) {
      // O separador no sufixo evita que `/home/x/proj` engula `/home/x/projeto2`.
      if (target === rule.path || target.startsWith(rule.path + path.sep)) {
        hit = rule.id;
        break;
      }
    }
    if (hit === NO_PROJECT) hit = this.#derive(target);
    this.#cache.set(cwd, hit);
    return hit;
  }

  /**
   * Projeto não cadastrado: sobe até a raiz do repositório e cria um id estável
   * a partir dela. Sem isto, todo trabalho feito fora do `projects.json` cairia
   * num balde único — que é onde estavam 97% do custo desta máquina.
   */
  #derive(target) {
    if (!this.#db) return NO_PROJECT;
    const root = this.#repoRoot(target);
    if (!root) return NO_PROJECT;

    const existente = this.#db.derivedProjectByPath(root);
    if (existente) return existente.project_id;

    const label = path.basename(root);
    let projectId = DERIVED_PREFIX + label;
    const colisao = this.#db.derivedProjectById(projectId);
    if (colisao && colisao.path !== root) {
      // Dois repositórios com o mesmo nome em pastas diferentes: desempata com um
      // sufixo determinístico do caminho, em vez de misturar o custo dos dois.
      const sufixo = crypto.createHash("sha1").update(root).digest("hex").slice(0, 6);
      projectId = `${DERIVED_PREFIX}${label}-${sufixo}`;
    }
    this.#db.saveDerivedProject({ projectId, path: root, label });
    return projectId;
  }

  /**
   * Raiz do repositório que contém `target`, ou null. Para acima de `homeDir`
   * para não transformar `/home` ou `/` num "projeto".
   */
  #repoRoot(target) {
    const limite = this.#homeDir;
    let dir = target;
    for (let i = 0; i < 40; i += 1) {
      if (limite && (dir === limite || !dir.startsWith(limite + path.sep))) {
        // Chegou no home (ou fora dele) sem achar marcador: não é projeto.
        return dir === limite ? null : (limite ? null : dir);
      }
      for (const marker of REPO_MARKERS) {
        if (fs.existsSync(path.join(dir, marker))) return dir;
      }
      const pai = path.dirname(dir);
      if (pai === dir) return null;
      dir = pai;
    }
    return null;
  }
}

/**
 * Consome um arquivo a partir do offset guardado e grava os eventos novos.
 *
 * @returns {{events: number, bytes: number, reset: boolean, badLines: number}}
 */
export function ingestFile(db, target, { priceBook, projectResolver, chunkSize = CHUNK_SIZE } = {}) {
  const record = db.upsertFile(target);
  const isClaude = target.provider === "claude";

  let fd;
  try {
    fd = fs.openSync(target.path, "r");
  } catch (error) {
    // Arquivo sumiu entre o scan e agora: marca e segue. Os eventos já colhidos ficam.
    db.markFileState(record.id, "missing", String(error?.code ?? error?.message ?? error));
    return { events: 0, bytes: 0, reset: false, badLines: 0 };
  }

  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const signature = headSignature(fd);

    // Truncamento, rotação ou reescrita que preservou o inode: o offset antigo aponta
    // para lixo, então recomeçamos do zero. O dedup impede contagem dupla.
    const rotated =
      size < record.offset
      || (record.ino && target.ino && record.ino !== target.ino)
      || (record.head_sig && signature && record.head_sig !== signature);

    let offset = rotated ? 0 : record.offset;
    let badLines = rotated ? 0 : record.bad_lines;
    const reset = rotated;

    let cursor = null;
    if (!isClaude) {
      cursor = createCodexCursor();
      if (!rotated && record.cursor_json) {
        try {
          Object.assign(cursor, JSON.parse(record.cursor_json));
        } catch {}
      }
    }

    if (offset >= size) {
      // Nada novo, mas registramos o que foi observado para o próximo scan comparar.
      db.saveFileCursor(record.id, {
        offset, size, mtimeMs: target.mtimeMs, ino: target.ino,
        headSig: signature, cursorJson: cursor ? JSON.stringify(cursor) : record.cursor_json,
        badLines, state: "active", lastError: null,
      });
      return { events: 0, bytes: 0, reset, badLines: 0 };
    }

    const buffer = Buffer.allocUnsafe(chunkSize);
    let carry = Buffer.alloc(0);
    let totalEvents = 0;
    let novasBadLines = 0;

    // Duas posições distintas, e confundi-las corrompe tudo: `readPos` é por onde a
    // leitura já passou; `offset` é até onde há linhas completas processadas. O que
    // está entre as duas é exatamente o carry — se lêssemos de novo a partir de
    // `offset`, esses bytes entrariam duplicados (uma vez no carry, outra no chunk).
    let readPos = offset;

    while (readPos < size) {
      const read = fs.readSync(fd, buffer, 0, chunkSize, readPos);
      if (read <= 0) break;
      readPos += read;

      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      const lastNewline = data.lastIndexOf(NEWLINE);

      if (lastNewline < 0) {
        // Nenhuma linha completa ainda. Guardamos uma CÓPIA: `buffer` é reusado.
        carry = Buffer.from(data);
        continue;
      }

      const complete = data.subarray(0, lastNewline);
      carry = Buffer.from(data.subarray(lastNewline + 1));

      const events = [];
      for (const line of complete.toString("utf8").split("\n")) {
        if (!line) continue;
        if (isClaude) {
          if (!isClaudeCandidate(line)) continue;
          const event = parseClaudeLine(line);
          if (event) events.push(event);
          else if (line.includes('"usage"')) novasBadLines += 1;
        } else {
          if (!isCodexCandidate(line)) continue;
          const event = parseCodexLine(line, cursor);
          if (event) events.push(event);
        }
      }

      for (const event of events) {
        event.file_id = record.id;
        event.hour_utc = hourOf(event.ts_ms);
        event.project_id = projectResolver ? projectResolver.resolve(event.cwd) : NO_PROJECT;
        if (priceBook) Object.assign(event, priceBook.priceEvent(event));
      }

      // O offset avança só até depois do último `\n`; o resto fica no carry e será
      // reprocessado junto do próximo chunk, sem reler o arquivo.
      offset = readPos - carry.length;
      const cursorOffset = offset;

      db.transaction(() => {
        if (events.length) totalEvents += db.insertEvents(events);
        db.saveFileCursor(record.id, {
          offset: cursorOffset,
          size,
          mtimeMs: target.mtimeMs,
          ino: target.ino,
          headSig: signature,
          cursorJson: cursor ? JSON.stringify(cursor) : null,
          badLines: badLines + novasBadLines,
          state: "active",
          lastError: null,
        });
      });
    }

    return { events: totalEvents, bytes: offset - (rotated ? 0 : record.offset), reset, badLines: novasBadLines };
  } catch (error) {
    db.markFileState(record.id, "error", String(error?.message ?? error));
    return { events: 0, bytes: 0, reset: false, badLines: 0, error };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/** Orquestra uma varredura completa: scan → ingestão → rollup. */
export class UsageReader {
  constructor({ db, homeDir, priceBook = null, projectResolver = null } = {}) {
    if (!db) throw new Error("UsageReader requer db.");
    this.db = db;
    this.homeDir = homeDir;
    this.priceBook = priceBook;
    this.projectResolver = projectResolver ?? new ProjectResolver([], { db, homeDir });
    this.roots = discoverRoots(homeDir);
  }

  setProjects(projects) {
    this.projectResolver.setProjects(projects);
    return this;
  }

  /**
   * @param {{onProgress?: (p: object) => void, progressEveryMs?: number}} options
   */
  runOnce({ onProgress = null, progressEveryMs = 500 } = {}) {
    const known = new Map();
    for (const row of this.db.listActiveFiles()) known.set(row.path, row);

    const targets = scanRoots(this.roots);
    // Só reabrimos o que mudou de tamanho, mtime ou inode desde a última passada.
    const pending = targets.filter((t) => {
      const row = known.get(t.path);
      if (!row) return true;
      return row.size !== t.size || row.mtime_ms !== t.mtimeMs || row.ino !== t.ino || row.offset < t.size;
    });

    const stats = { files: targets.length, processed: 0, pending: pending.length, events: 0, bytes: 0, resets: 0 };
    let lastReport = 0;

    for (const target of pending) {
      const result = ingestFile(this.db, target, {
        priceBook: this.priceBook,
        projectResolver: this.projectResolver,
      });
      stats.processed += 1;
      stats.events += result.events;
      stats.bytes += result.bytes;
      if (result.reset) stats.resets += 1;

      const now = Date.now();
      if (onProgress && now - lastReport >= progressEveryMs) {
        lastReport = now;
        onProgress({ ...stats });
      }
    }

    // Rollup em lotes: uma varredura de backfill pode sujar dezenas de milhares de horas.
    let rolled = 0;
    while (this.db.pendingDirtyCount() > 0) {
      const done = this.db.rollupDirty();
      if (!done) break;
      rolled += done;
    }
    stats.rolledBuckets = rolled;

    if (onProgress) onProgress({ ...stats, done: true });
    return stats;
  }
}
