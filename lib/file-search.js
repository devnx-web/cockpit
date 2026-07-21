import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
]);

export function normalizeFileSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\\/g, "/")
    .toLocaleLowerCase("pt-BR");
}

function fuzzyTokenScore(token, candidate) {
  let previous = -1;
  let score = 0;
  let streak = 0;

  for (const char of token) {
    const index = candidate.indexOf(char, previous + 1);
    if (index < 0) return null;
    const gap = index - previous - 1;
    streak = gap === 0 ? streak + 1 : 0;
    score += gap * 4 - Math.min(streak, 4);
    if (index === 0 || /[\/_\-.]/.test(candidate[index - 1])) score -= 5;
    previous = index;
  }

  return score + (candidate.length - token.length) * 0.08;
}

function tokenScore(token, basename, filePath) {
  if (basename === token) return -120;
  if (basename.startsWith(token)) return -80 + (basename.length - token.length) * 0.04;

  const basenameIndex = basename.indexOf(token);
  if (basenameIndex >= 0) return -45 + basenameIndex * 2;

  const pathIndex = filePath.indexOf(token);
  if (pathIndex >= 0) return -10 + pathIndex * 0.3;

  const basenameFuzzy = fuzzyTokenScore(token, basename);
  if (basenameFuzzy != null) return 25 + basenameFuzzy;
  const pathFuzzy = fuzzyTokenScore(token, filePath);
  return pathFuzzy == null ? null : 55 + pathFuzzy;
}

export function scoreFilePath(query, candidatePath) {
  const normalizedQuery = normalizeFileSearchText(query).trim();
  const normalizedPath = normalizeFileSearchText(candidatePath).replace(/^\/+/, "");
  if (!normalizedQuery || !normalizedPath) return null;

  const basename = normalizedPath.split("/").pop() || normalizedPath;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    const current = tokenScore(token, basename, normalizedPath);
    if (current == null) return null;
    score += current;
  }

  if (normalizedPath === normalizedQuery) score -= 180;
  else if (basename === normalizedQuery) score -= 100;
  score += (normalizedPath.split("/").length - 1) * 2;
  score += normalizedPath.length * 0.015;
  return Math.round(score * 1000) / 1000;
}

export function searchFilePaths(paths, query, { limit = 80 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 80, 200));
  const matches = [];
  for (const candidatePath of paths || []) {
    const score = scoreFilePath(query, candidatePath);
    if (score == null) continue;
    const normalizedPath = String(candidatePath).replace(/\\/g, "/").replace(/^\/+/, "");
    const slash = normalizedPath.lastIndexOf("/");
    matches.push({
      path: normalizedPath,
      name: slash >= 0 ? normalizedPath.slice(slash + 1) : normalizedPath,
      directory: slash >= 0 ? normalizedPath.slice(0, slash) : "",
      score,
    });
  }
  matches.sort((left, right) => left.score - right.score || left.path.localeCompare(right.path, "pt-BR"));
  return {
    entries: matches.slice(0, safeLimit),
    total: matches.length,
    truncated: matches.length > safeLimit,
  };
}

export async function collectProjectFiles(projectPath, {
  ignoredDirs = DEFAULT_IGNORED_DIRS,
  maxEntries = 50_000,
} = {}) {
  const root = path.resolve(projectPath);
  const safeMaxEntries = Math.max(100, Math.min(Number(maxEntries) || 50_000, 200_000));
  const paths = [];
  const stack = [{ absolute: root, relative: "" }];
  let scanned = 0;
  let truncated = false;

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      if (!current.relative) throw error;
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      scanned += 1;
      if (scanned > safeMaxEntries) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          stack.push({ absolute: path.join(current.absolute, entry.name), relative });
        }
      } else if (entry.isFile()) {
        paths.push(relative);
      }
    }
  }

  return { paths, scanned: Math.min(scanned, safeMaxEntries), truncated };
}

export function createFileSearchService({
  cacheTtlMs = 20_000,
  maxEntries = 50_000,
  limit = 80,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const loadIndex = async (projectPath, refresh) => {
    const root = path.resolve(projectPath);
    const cached = cache.get(root);
    if (!refresh && cached && Date.now() - cached.createdAt < cacheTtlMs) return cached;
    if (!refresh && inFlight.has(root)) return inFlight.get(root);

    const pending = collectProjectFiles(root, { maxEntries }).then((index) => {
      const next = { ...index, createdAt: Date.now() };
      cache.set(root, next);
      return next;
    }).finally(() => {
      inFlight.delete(root);
    });
    inFlight.set(root, pending);
    return pending;
  };

  return {
    async search(projectPath, query, { refresh = false } = {}) {
      const safeQuery = String(query || "").trim().slice(0, 160);
      if (!safeQuery) {
        return { ok: true, query: "", entries: [], total: 0, scanned: 0, truncated: false };
      }
      try {
        const index = await loadIndex(projectPath, refresh);
        const result = searchFilePaths(index.paths, safeQuery, { limit });
        return {
          ok: true,
          query: safeQuery,
          ...result,
          scanned: index.scanned,
          indexed: index.paths.length,
          truncated: index.truncated || result.truncated,
        };
      } catch (error) {
        return { ok: false, query: safeQuery, error: error.message || "busca indisponível" };
      }
    },
    invalidate(projectPath) {
      cache.delete(path.resolve(projectPath));
    },
  };
}
