// =========================================================
// MÓDULO DE CONTAS (Claude + Codex)
// Lê as contas gerenciadas pelos switchers (ccswitch / codexswitch) e
// consulta o consumo de cada uma:
//   - Claude: endpoint /api/oauth/usage (instantâneo, sem custo de cota)
//   - Codex:  lê o rate_limits mais recente gravado nos rollouts de sessão
//
// Read-only por enquanto: não troca conta nem altera arquivos de auth.
// Fontes da verdade:
//   ~/.claude/.credentials.json        (conta Claude ativa)
//   ~/.claude/.claude.json | ~/.claude.json  (oauthAccount.emailAddress = ativa)
//   ~/.claude-switch-backup/sequence.json    (contas Claude gerenciadas)
//   ~/.claude-switch-backup/credentials/...  (tokens das demais contas)
//   ~/.codex-switch-backup/state.json        (contas Codex + ativa)
//   ~/.codex/sessions/AAAA/MM/DD/*.jsonl     (rollouts c/ rate_limits)
// =========================================================

import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();

const CLAUDE_ACTIVE_CRED = path.join(HOME, ".claude", ".credentials.json");
const CLAUDE_CFG_PRIMARY = path.join(HOME, ".claude", ".claude.json");
const CLAUDE_CFG_FALLBACK = path.join(HOME, ".claude.json");
const CLAUDE_SEQ = path.join(HOME, ".claude-switch-backup", "sequence.json");
const CLAUDE_CRED_DIR = path.join(HOME, ".claude-switch-backup", "credentials");
const CLAUDE_CONFIGS_DIR = path.join(HOME, ".claude-switch-backup", "configs");

const CODEX_STATE = path.join(HOME, ".codex-switch-backup", "state.json");
const CODEX_STORE = path.join(HOME, ".codex-switch-backup", "accounts");
const CODEX_AUTH = path.join(HOME, ".codex", "auth.json");

const COCKPIT_DIR = path.join(HOME, ".cockpit");
const USAGE_CACHE = path.join(COCKPIT_DIR, "usage-cache.json");

// ---------- utilidades ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  if (mode) {
    try { fs.chmodSync(file, mode); } catch {}
  }
}

function readCache() {
  return readJson(USAGE_CACHE) || { claude: {}, codex: {} };
}
function writeCache(c) {
  writeJson(USAGE_CACHE, c);
}

function fmtTier(tier) {
  if (!tier) return "?";
  if (/max_20x/.test(tier)) return "Max 20x";
  if (/max_5x/.test(tier)) return "Max 5x";
  if (/pro/i.test(tier)) return "Pro";
  return tier;
}

// Formata o plan_type do Codex/ChatGPT em algo legível.
function fmtCodexPlan(plan) {
  if (!plan) return null;
  const map = {
    prolite: "Pro Lite 5x",
    pro: "Pro 20x",
    plus: "Plus",
    free: "Free",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  const key = String(plan).toLowerCase();
  if (map[key]) return map[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// ---------- Claude ----------

function claudeActiveEmail() {
  const primary = readJson(CLAUDE_CFG_PRIMARY);
  if (primary?.oauthAccount?.emailAddress) return primary.oauthAccount.emailAddress;
  const fb = readJson(CLAUDE_CFG_FALLBACK);
  return fb?.oauthAccount?.emailAddress || null;
}

const CLAUDE_OAUTH_TOKEN = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // client_id público do Claude Code

// Consulta o consumo de uma conta Claude pelo accessToken (mesmo dado do /status).
// Retorna { ok, status, usage }:
//   status: "ok" | "unauthorized" (401/403, token inválido) |
//           "ratelimited" (429) | "error" (rede/outro)
async function claudeFetchUsage(token) {
  if (!token) return { ok: false, status: "unauthorized" };
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "cockpit/accounts",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, status: "unauthorized" };
    if (res.status === 429) return { ok: false, status: "ratelimited" };
    if (!res.ok) return { ok: false, status: "error" };
    const j = await res.json();
    if (!j || !j.five_hour) return { ok: false, status: "error" };
    return { ok: true, status: "ok", usage: j };
  } catch {
    return { ok: false, status: "error" };
  }
}

// Renova o accessToken via refreshToken (OAuth). Atualiza o objeto cred e,
// se credPath for dado, persiste o novo par de tokens (o refresh rotaciona).
// Retorna o novo accessToken, ou null se o refresh falhar (sessão morta de fato).
async function claudeRefreshToken(cred, credPath) {
  const oauth = cred?.claudeAiOauth;
  if (!oauth?.refreshToken) return null;
  try {
    const res = await fetch(CLAUDE_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "cockpit/accounts" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.access_token) return null;
    oauth.accessToken = j.access_token;
    if (j.refresh_token) oauth.refreshToken = j.refresh_token;
    if (j.expires_in) oauth.expiresAt = Date.now() + j.expires_in * 1000;
    if (credPath) { try { writeJson(credPath, cred, 0o600); } catch {} }
    return oauth.accessToken;
  } catch {
    return null;
  }
}

// Obtém o uso de uma conta Claude com refresh automático do token quando necessário.
// credPath só é passado p/ contas de backup (não-ativas) — a ativa é renovada
// pelo próprio Claude Code, então não reescrevemos o .credentials.json dela.
// Retorna { status: "ok"|"expired"|"ratelimited"|"error", usage }.
async function claudeUsageWithRefresh(cred, credPath) {
  const oauth = cred?.claudeAiOauth;
  if (!oauth?.accessToken) return { status: "expired" };
  let token = oauth.accessToken;

  // refresh proativo se o token já expirou (ou está perto)
  if (oauth.expiresAt && oauth.expiresAt < Date.now() + 60000 && oauth.refreshToken) {
    const nt = await claudeRefreshToken(cred, credPath);
    if (nt) token = nt;
  }

  let r = await claudeFetchUsage(token);
  if (r.ok) return { status: "ok", usage: r.usage };

  // 429 (rate limit) e erros de rede NÃO são "sessão expirada"
  if (r.status === "ratelimited") return { status: "ratelimited" };
  if (r.status === "error") return { status: "error" };

  // 401/403 -> token inválido: tenta renovar via refreshToken
  if (r.status === "unauthorized" && oauth.refreshToken) {
    const nt = await claudeRefreshToken(cred, credPath);
    if (nt) {
      const r2 = await claudeFetchUsage(nt);
      if (r2.ok) return { status: "ok", usage: r2.usage };
      if (r2.status === "ratelimited") return { status: "ratelimited" };
    }
    return { status: "expired" }; // refresh também falhou: sessão realmente morta
  }
  return { status: "expired" };
}

function pctFloor(x) {
  return x == null ? null : Math.floor(x);
}

const CLAUDE_TTL_MS = 20 * 60 * 1000; // reusa resultado bom por 20min p/ evitar rate limit

// Lista contas Claude gerenciadas + consumo de cada uma.
// Usa cache de 20min para evitar 429; em rate limit/erro, serve o último valor bom.
// force=true ignora o cache (usado pelo botão ⟳ manual).
async function claudeAccounts(force = false) {
  const seq = readJson(CLAUDE_SEQ);
  if (!seq?.accounts) return [];
  const active = claudeActiveEmail();
  const cache = readCache();
  cache.claude = cache.claude || {};
  const now = Date.now();

  const entries = Object.entries(seq.accounts); // [num, {email,...}]
  const out = await Promise.all(
    entries.map(async ([num, info]) => {
      const email = info.email;
      const isActive = email === active;
      const credPath = isActive
        ? CLAUDE_ACTIVE_CRED
        : path.join(CLAUDE_CRED_DIR, `.claude-credentials-${num}-${email}.json`);
      const cred = readJson(credPath);
      const oauth = cred?.claudeAiOauth || {};
      const tier = fmtTier(oauth.rateLimitTier);
      const cached = cache.claude[email];

      const base = {
        platform: "claude", id: email, email, plan: tier, active: isActive,
      };

      // cache fresco (<TTL): devolve direto, sem bater no endpoint (salvo force)
      if (!force && cached && cached.status === "ok" && now - cached.at < CLAUDE_TTL_MS) {
        return { ...base, ...cached.data, status: "ok", cachedAgeMs: now - cached.at };
      }

      const r = await claudeUsageWithRefresh(cred, isActive ? null : credPath);
      const usage = r.usage;

      if (r.status === "ok") {
        const data = {
          fiveHour: pctFloor(usage.five_hour?.utilization),
          fiveHourReset: usage.five_hour?.resets_at || null,
          weekly: pctFloor(usage.seven_day?.utilization),
          weeklyReset: usage.seven_day?.resets_at || null,
          weeklyOpus: pctFloor(usage.seven_day_opus?.utilization),
          weeklySonnet: pctFloor(usage.seven_day_sonnet?.utilization),
        };
        cache.claude[email] = { status: "ok", at: now, data };
        return { ...base, ...data, status: "ok" };
      }

      // falha temporária (429/erro): serve o último valor bom marcado como "stale"
      if ((r.status === "ratelimited" || r.status === "error") && cached?.data) {
        return { ...base, ...cached.data, status: "ok", stale: true, cachedAgeMs: now - cached.at };
      }

      return {
        ...base, status: r.status,
        fiveHour: null, fiveHourReset: null, weekly: null, weeklyReset: null,
        weeklyOpus: null, weeklySonnet: null,
      };
    })
  );
  writeCache(cache);
  return out;
}

// ---------- Codex ----------
// Uso lido direto da API do ChatGPT (backend-api/wham/usage) com o token de cada
// conta — instantâneo, por conta, sem `codex exec`, sem trocar auth.json, sem
// cross-account. Mesma estratégia do Claude.

const CODEX_WHAM_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_TTL_MS = 20 * 60 * 1000;

// Consulta o uso de uma conta Codex pelo access_token + account_id do auth.json.
// Retorna { ok, status: "ok"|"unauthorized"|"ratelimited"|"error", usage }.
async function codexFetchUsage(token, accountId) {
  if (!token) return { ok: false, status: "unauthorized" };
  try {
    const res = await fetch(CODEX_WHAM_USAGE, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.50.0",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, status: "unauthorized" };
    if (res.status === 429) return { ok: false, status: "ratelimited" };
    if (!res.ok) return { ok: false, status: "error" };
    const j = await res.json();
    if (!j?.rate_limit) return { ok: false, status: "error" };
    return { ok: true, status: "ok", usage: j };
  } catch {
    return { ok: false, status: "error" };
  }
}

// Identidade (email/accountId) e token de uma conta a partir do seu auth.json.
function codexAuthOf(label, isActive) {
  const file = isActive ? CODEX_AUTH : path.join(CODEX_STORE, `${label}.json`);
  const j = readJson(file);
  return {
    token: j?.tokens?.access_token || null,
    accountId: j?.tokens?.account_id || null,
  };
}

// Lista contas Codex gerenciadas + consumo de cada uma (via HTTP, com cache 20min).
async function codexAccounts(force = false) {
  const state = readJson(CODEX_STATE);
  if (!state?.accounts) return [];
  const active = state.active;
  const cache = readCache();
  cache.codex = cache.codex || {};
  const now = Date.now();

  const out = await Promise.all(
    Object.entries(state.accounts).map(async ([label, info]) => {
      const isActive = label === active;
      const base = { platform: "codex", id: label, email: info.email || label, active: isActive };
      const cached = cache.codex[label];

      // cache fresco (<TTL): devolve sem bater na API (salvo force)
      if (!force && cached && cached.status === "ok" && now - cached.at < CODEX_TTL_MS) {
        return { ...base, ...cached.data, status: "ok", cachedAgeMs: now - cached.at };
      }

      const { token, accountId } = codexAuthOf(label, isActive);
      const r = await codexFetchUsage(token, accountId);

      if (r.ok) {
        const rl = r.usage.rate_limit || {};
        const p = rl.primary_window || {};
        const s = rl.secondary_window || {};
        const data = {
          plan: fmtCodexPlan(r.usage.plan_type),
          fiveHour: p.used_percent ?? null,
          fiveHourReset: p.reset_at ? p.reset_at * 1000 : null,
          weekly: s.used_percent ?? null,
          weeklyReset: s.reset_at ? s.reset_at * 1000 : null,
        };
        cache.codex[label] = { status: "ok", at: now, data };
        return { ...base, ...data, status: "ok" };
      }

      // falha temporária: serve último valor bom (stale)
      if ((r.status === "ratelimited" || r.status === "error") && cached?.data) {
        return { ...base, ...cached.data, status: "ok", stale: true, cachedAgeMs: now - (cached.at || now) };
      }

      const status = r.status === "ratelimited" ? "ratelimited"
        : r.status === "error" ? "error" : "expired";
      return { ...base, status, plan: null, fiveHour: null, fiveHourReset: null, weekly: null, weeklyReset: null };
    })
  );
  writeCache(cache);
  return out;
}

// ---------- AÇÕES (escrita) ----------

// Troca a conta Codex ativa (swap do auth.json). Reflete em novos terminais.
export function codexSwitch(label) {
  const target = path.join(CODEX_STORE, `${label}.json`);
  if (!fs.existsSync(target)) throw new Error(`conta Codex não encontrada: ${label}`);
  const state = readJson(CODEX_STATE) || { active: null, accounts: {} };
  // preserva o token atual da conta ativa antes de trocar (pode ter renovado)
  if (state.active && fs.existsSync(CODEX_AUTH)) {
    try { fs.copyFileSync(CODEX_AUTH, path.join(CODEX_STORE, `${state.active}.json`)); } catch {}
  }
  fs.copyFileSync(target, CODEX_AUTH);
  try { fs.chmodSync(CODEX_AUTH, 0o600); } catch {}
  state.active = label;
  state.lastSwitchAt = Date.now(); // invalida rollouts antigos de outras contas
  writeJson(CODEX_STATE, state);
  return { ok: true, platform: "codex", active: label };
}

function claudeConfigPath() {
  const j = readJson(CLAUDE_CFG_PRIMARY);
  if (j?.oauthAccount?.emailAddress) return CLAUDE_CFG_PRIMARY;
  return CLAUDE_CFG_FALLBACK;
}

// Troca a conta Claude ativa (espelha ccswitch: swap credentials + oauthAccount).
// Reflete em novos terminais; sessões já abertas continuam na conta anterior.
export function claudeSwitch(email) {
  const seq = readJson(CLAUDE_SEQ);
  if (!seq?.accounts) throw new Error("nenhuma conta Claude gerenciada");
  const target = Object.entries(seq.accounts).find(([, i]) => i.email === email);
  if (!target) throw new Error(`conta Claude não encontrada: ${email}`);
  const [num] = target;

  const cfgPath = claudeConfigPath();
  const curEmail = claudeActiveEmail();

  // 1) backup da conta atual (credentials + oauthAccount)
  const curEntry = curEmail && Object.entries(seq.accounts).find(([, i]) => i.email === curEmail);
  if (curEntry) {
    const [curNum] = curEntry;
    try { fs.copyFileSync(CLAUDE_ACTIVE_CRED, path.join(CLAUDE_CRED_DIR, `.claude-credentials-${curNum}-${curEmail}.json`)); } catch {}
    const curCfg = readJson(cfgPath);
    if (curCfg) writeJson(path.join(CLAUDE_CONFIGS_DIR, `.claude-config-${curNum}-${curEmail}.json`), curCfg);
  }

  // 2) lê os backups da conta alvo
  const tCred = readJson(path.join(CLAUDE_CRED_DIR, `.claude-credentials-${num}-${email}.json`));
  const tCfg = readJson(path.join(CLAUDE_CONFIGS_DIR, `.claude-config-${num}-${email}.json`));
  if (!tCred) throw new Error(`backup de credenciais ausente para ${email}`);
  if (!tCfg?.oauthAccount) throw new Error(`backup de oauthAccount ausente para ${email}`);

  // 3) ativa: escreve credentials da alvo e injeta o oauthAccount no config atual
  writeJson(CLAUDE_ACTIVE_CRED, tCred, 0o600);
  const cfg = readJson(cfgPath) || {};
  cfg.oauthAccount = tCfg.oauthAccount;
  writeJson(cfgPath, cfg);

  // 4) atualiza o estado do switcher
  seq.activeAccountNumber = Number(num);
  seq.lastUpdated = new Date().toISOString();
  writeJson(CLAUDE_SEQ, seq);

  return { ok: true, platform: "claude", active: email };
}


// Troca conta por plataforma (despacho usado pela rota).
export function switchAccount(platform, id) {
  if (platform === "codex") return codexSwitch(id);
  if (platform === "claude") return claudeSwitch(id);
  throw new Error(`plataforma desconhecida: ${platform}`);
}

// ---------- ADICIONAR / REMOVER ----------

function decodeJwtPayload(token) {
  try {
    let p = token.split(".")[1];
    p = p.replace(/-/g, "+").replace(/_/g, "/");
    while (p.length % 4) p += "=";
    return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function codexIdentity(authFile) {
  const j = readJson(authFile);
  const payload = j?.tokens?.id_token ? decodeJwtPayload(j.tokens.id_token) : null;
  if (!payload) return null;
  return {
    email: payload.email || payload["https://api.openai.com/profile"]?.email || null,
    accountId: payload["https://api.openai.com/auth"]?.chatgpt_account_id || null,
  };
}

// Captura a conta Codex logada AGORA (sync). Se já existe (mesmo accountId), atualiza.
export function codexAdd() {
  const id = codexIdentity(CODEX_AUTH);
  if (!id?.accountId) throw new Error("nenhuma conta Codex logada no momento");
  const state = readJson(CODEX_STATE) || { active: null, accounts: {} };
  fs.mkdirSync(CODEX_STORE, { recursive: true });

  // se já há um arquivo com o mesmo accountId, reutiliza o label
  let label = id.email || `conta-${id.accountId.slice(0, 8)}`;
  for (const f of safeReaddir(CODEX_STORE)) {
    if (!f.endsWith(".json")) continue;
    const fid = codexIdentity(path.join(CODEX_STORE, f));
    if (fid?.accountId === id.accountId) { label = f.replace(/\.json$/, ""); break; }
  }

  fs.copyFileSync(CODEX_AUTH, path.join(CODEX_STORE, `${label}.json`));
  try { fs.chmodSync(path.join(CODEX_STORE, `${label}.json`), 0o600); } catch {}
  state.accounts = state.accounts || {};
  state.accounts[label] = { email: id.email || label };
  state.active = label;
  writeJson(CODEX_STATE, state);
  return { ok: true, platform: "codex", added: label };
}

export function codexRemove(label) {
  const state = readJson(CODEX_STATE) || { active: null, accounts: {} };
  try { fs.unlinkSync(path.join(CODEX_STORE, `${label}.json`)); } catch {}
  if (state.accounts) delete state.accounts[label];
  if (state.active === label) state.active = null;
  writeJson(CODEX_STATE, state);
  const c = readCache();
  if (c.codex) { delete c.codex[label]; writeCache(c); }
  return { ok: true };
}

// Captura a conta Claude logada AGORA (espelha ccswitch --add-account).
export function claudeAdd() {
  const cfgPath = claudeConfigPath();
  const cfg = readJson(cfgPath);
  const email = cfg?.oauthAccount?.emailAddress;
  if (!email) throw new Error("nenhuma conta Claude logada no momento");
  const uuid = cfg.oauthAccount.accountUuid || null;
  const creds = readJson(CLAUDE_ACTIVE_CRED);
  if (!creds) throw new Error("credenciais ativas do Claude não encontradas");

  const seq = readJson(CLAUDE_SEQ) || { activeAccountNumber: null, lastUpdated: null, sequence: [], accounts: {} };
  seq.accounts = seq.accounts || {};
  seq.sequence = seq.sequence || [];

  // reaproveita o número se a conta já é gerenciada; senão pega o próximo
  const existing = Object.entries(seq.accounts).find(([, i]) => i.email === email);
  const num = existing ? existing[0] : String((Object.keys(seq.accounts).map(Number).reduce((a, b) => Math.max(a, b), 0)) + 1);

  fs.mkdirSync(CLAUDE_CRED_DIR, { recursive: true });
  fs.mkdirSync(CLAUDE_CONFIGS_DIR, { recursive: true });
  writeJson(path.join(CLAUDE_CRED_DIR, `.claude-credentials-${num}-${email}.json`), creds, 0o600);
  writeJson(path.join(CLAUDE_CONFIGS_DIR, `.claude-config-${num}-${email}.json`), cfg);

  seq.accounts[num] = { email, uuid, added: new Date().toISOString() };
  if (!seq.sequence.includes(Number(num))) seq.sequence.push(Number(num));
  seq.activeAccountNumber = Number(num);
  seq.lastUpdated = new Date().toISOString();
  writeJson(CLAUDE_SEQ, seq);
  return { ok: true, platform: "claude", added: email };
}

export function claudeRemove(email) {
  const seq = readJson(CLAUDE_SEQ);
  if (!seq?.accounts) throw new Error("nenhuma conta Claude gerenciada");
  const entry = Object.entries(seq.accounts).find(([, i]) => i.email === email);
  if (!entry) throw new Error(`conta Claude não encontrada: ${email}`);
  const [num] = entry;
  try { fs.unlinkSync(path.join(CLAUDE_CRED_DIR, `.claude-credentials-${num}-${email}.json`)); } catch {}
  try { fs.unlinkSync(path.join(CLAUDE_CONFIGS_DIR, `.claude-config-${num}-${email}.json`)); } catch {}
  delete seq.accounts[num];
  seq.sequence = (seq.sequence || []).filter((x) => x !== Number(num));
  seq.lastUpdated = new Date().toISOString();
  writeJson(CLAUDE_SEQ, seq);
  return { ok: true };
}

export function addAccount(platform) {
  if (platform === "codex") return codexAdd();
  if (platform === "claude") return claudeAdd();
  throw new Error(`plataforma desconhecida: ${platform}`);
}

export function removeAccount(platform, id) {
  if (platform === "codex") return codexRemove(id);
  if (platform === "claude") return claudeRemove(id);
  throw new Error(`plataforma desconhecida: ${platform}`);
}

// ---------- API pública ----------

// Tabela completa de uso (Claude + Codex). force ignora os caches (TTL 20min).
export async function getUsageTable(force = false) {
  const [claude, codex] = await Promise.all([
    claudeAccounts(force),
    codexAccounts(force),
  ]);
  return {
    generatedAt: Date.now(),
    claude,
    codex,
  };
}
