import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const PROVIDER_ALIASES = new Map([
  ["openai", "openai"],
  ["codex", "openai"],
  ["claude", "claude"],
  ["anthropic", "claude"],
]);

const SENSITIVE_KEY = /^(?:authorization|password|device_?token|plain_?text_?token|setup_?token|token|tokens|client|credentials?|oauth_?token|access_?token|refresh_?token|id_?token|api_?key|openai_api_key|client_?secret|secret)$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CODEX_STATIC_DIRS = Object.freeze(["skills", "rules", "plugins", "packages", "agents", "hooks", "themes"]);
const SAFE_ACCOUNT_KEYS = new Set([
  "id",
  "uuid",
  "public_id",
  "provider",
  "label",
  "plan",
  "credential_type",
  "credential_version",
  "status",
  "is_enabled",
  "usage",
  "expires_at",
  "last_synced_at",
  "last_refreshed_at",
  "last_selected_at",
  "priority",
]);

export const TEAM_API_PATHS = Object.freeze({
  login: "/api/login",
  deviceTokens: "/api/cockpit-ai/device-tokens",
  revokeDeviceToken: "/api/cockpit-ai/device-token",
  accounts: "/api/cockpit-ai/accounts",
  select: "/api/cockpit-ai/select",
  upsert: "/api/cockpit-ai/accounts/upsert",
  refresh: (accountId) => `/api/cockpit-ai/accounts/${encodeURIComponent(accountId)}/refresh`,
  syncAccountUsage: (accountId) => `/api/cockpit-ai/accounts/${encodeURIComponent(accountId)}/sync-usage`,
  syncUsage: "/api/cockpit-ai/sync-usage",
});

export class TeamAccountsError extends Error {
  constructor(message, { code = "TEAM_ACCOUNTS_ERROR", status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "TeamAccountsError";
    this.code = code;
    this.status = status;
  }
}

function normalizeProvider(provider) {
  const normalized = PROVIDER_ALIASES.get(String(provider || "").trim().toLowerCase());
  if (!normalized) {
    throw new TeamAccountsError("Plataforma inválida; use openai ou claude.", {
      code: "INVALID_PROVIDER",
    });
  }
  return normalized;
}

function envEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

/**
 * Validates a DevNX Control origin. HTTPS is always accepted. Plain HTTP is
 * limited to loopback during development, unless the explicit insecure
 * override is set for an isolated local environment.
 */
export function normalizeBaseUrl(input, env = process.env) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new TeamAccountsError("URL do DevNX Control inválida.", { code: "INVALID_BASE_URL" });
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new TeamAccountsError("A URL do DevNX Control não pode conter credenciais, query ou fragmento.", {
      code: "INVALID_BASE_URL",
    });
  }

  const isHttps = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  const development = String(env.NODE_ENV || "development").toLowerCase() !== "production";
  const allowLocalHttp = development || envEnabled(env.COCKPIT_TEAM_ALLOW_LOCAL_HTTP);
  const allowInsecureOverride = envEnabled(env.COCKPIT_TEAM_ALLOW_INSECURE_HTTP);

  if (!isHttps && !(isLoopbackHttp && allowLocalHttp) && !allowInsecureOverride) {
    throw new TeamAccountsError(
      "O DevNX Control deve usar HTTPS; HTTP só é permitido em loopback no desenvolvimento.",
      { code: "INSECURE_BASE_URL" },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TeamAccountsError("A URL do DevNX Control deve usar HTTP ou HTTPS.", {
      code: "INVALID_BASE_URL",
    });
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function apiUrl(baseUrl, apiPath) {
  const base = new URL(baseUrl);
  const route = new URL(apiPath, "https://cockpit.invalid");
  const basePath = base.pathname.replace(/\/+$/, "");
  let suffix = route.pathname;
  // Accept both https://control.example and https://control.example/api.
  if (basePath.endsWith("/api") && suffix.startsWith("/api/")) suffix = suffix.slice(4);
  base.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, "/");
  base.search = route.search;
  return base.toString();
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function secureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function atomicWriteFile(file, content) {
  const dir = path.dirname(file);
  secureDirectory(dir);
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    try {
      const dirFd = fs.openSync(dir, "r");
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {}
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temp); } catch {}
  }
}

function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function deleteFile(file) {
  try { fs.unlinkSync(file); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function redactText(input) {
  return String(input || "")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:access|refresh|id|device)[_-]?token|password|api[_-]?key|client[_-]?secret)(\s*[=:]\s*)[^\s,;}]+/gi, "$1$2[redacted]")
    .replace(/\b(?:sk|sess|eyJ)[-_A-Za-z0-9.]{16,}\b/g, "[redacted]")
    .slice(0, 240);
}

function safeServerMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  const message = typeof payload.message === "string" ? payload.message : "";
  return redactText(message).replace(/[\r\n]+/g, " ").trim();
}

function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    clean[key] = sanitizePublic(item);
  }
  return clean;
}

async function readLimitedResponse(response, maxBytes) {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw new TeamAccountsError("Resposta grande demais do DevNX Control.", {
      code: "RESPONSE_TOO_LARGE",
      status: response.status,
    });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new TeamAccountsError("Resposta grande demais do DevNX Control.", {
          code: "RESPONSE_TOO_LARGE",
          status: response.status,
        });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function accountIdOf(account) {
  const id = account?.id || account?.uuid || account?.public_id || account?.publicId;
  return id == null ? null : String(id);
}

function usagePercent(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeAccount(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    throw new TeamAccountsError("Resposta de conta inválida do DevNX Control.", {
      code: "INVALID_SERVER_RESPONSE",
    });
  }
  const safe = {};
  for (const [key, value] of Object.entries(account)) {
    if (!SAFE_ACCOUNT_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    if (key === "usage") {
      safe.usage = {
        five_hour: {
          percent: usagePercent(value?.five_hour?.percent),
          resets_at: isoFromUnknown(value?.five_hour?.resets_at),
        },
        weekly: {
          percent: usagePercent(value?.weekly?.percent),
          resets_at: isoFromUnknown(value?.weekly?.resets_at),
        },
      };
      continue;
    }
    if (key === "expires_at") {
      safe.expires_at = {
        access_token: isoFromUnknown(value?.access_token),
        refresh_token: isoFromUnknown(value?.refresh_token),
        subscription: isoFromUnknown(value?.subscription),
      };
      continue;
    }
    safe[key] = sanitizePublic(value);
  }
  return safe;
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function isoFromUnknown(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function expiresInSeconds(value) {
  const iso = isoFromUnknown(value);
  if (!iso) return 3600;
  return Math.max(60, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

function requireString(value, description) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TeamAccountsError(`Resposta sem ${description}.`, { code: "INVALID_SERVER_RESPONSE" });
  }
  return value;
}

function normalizeOpenAiClient(client, accountId) {
  if (!client || typeof client !== "object") {
    throw new TeamAccountsError("Resposta sem material de autenticação OpenAI.", {
      code: "INVALID_SERVER_RESPONSE",
    });
  }
  const serverPlaceholder = requireString(client.refresh_token, "placeholder de refresh OpenAI");
  if (!serverPlaceholder.startsWith("cockpit:")) {
    throw new TeamAccountsError("O servidor tentou fornecer um refresh token OpenAI não brokerado.", {
      code: "UNSAFE_SERVER_RESPONSE",
    });
  }
  return {
    type: client.type || "codex_oauth",
    auth_mode: client.auth_mode || "chatgpt",
    access_token: requireString(client.access_token, "access token OpenAI"),
    id_token: requireString(client.id_token, "ID token OpenAI"),
    account_id: requireString(client.account_id, "account ID OpenAI"),
    account_uuid: accountId,
    last_refresh: isoFromUnknown(client.last_refresh) || new Date().toISOString(),
    expires_at: isoFromUnknown(client.expires_at),
  };
}

function normalizeClaudeClient(client) {
  if (!client || typeof client !== "object") {
    throw new TeamAccountsError("Resposta sem material de autenticação Claude.", {
      code: "INVALID_SERVER_RESPONSE",
    });
  }
  return {
    type: client.type || "claude_setup_token",
    oauth_token: requireString(client.oauth_token || client.access_token, "token OAuth Claude"),
    expires_at: isoFromUnknown(client.expires_at),
  };
}

function makeCapability(accountId) {
  return `cockpit:${accountId}:${crypto.randomBytes(16).toString("base64url")}`;
}

function makeClaudeProxyCapability() {
  return `cockpit-claude:${crypto.randomBytes(24).toString("base64url")}`;
}

function bearerToken(value) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value || "").trim());
  return match?.[1] || null;
}

function secretsEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class TeamAccountsClient {
  #fetch;
  #env;
  #timeoutMs;
  #maxResponseBytes;
  #paths;
  #homeDir;
  #configPath;
  #sourceCodexAuthPath;
  #sourceCodexHome;
  #sourceClaudeCredentialsPath;
  #sourceClaudeConfigPaths;
  #brokerCodexHome;
  #brokerClaudeHome;
  #brokerClaudeAuthPath;
  #unavailableCodexHome;
  #brokerCodexAuthPath;
  #brokerMarkerPath;
  #config = null;
  #selected = new Map();
  #openAiCapabilities = new Map();
  #claudeProxyCapability = makeClaudeProxyCapability();
  #claudeRefreshPromise = null;
  #ownedAuthPaths = new Set();
  #pendingCodexAuthPaths = new Set();

  constructor({
    fetchImpl = globalThis.fetch,
    env = process.env,
    timeoutMs = Number(env.COCKPIT_TEAM_HTTP_TIMEOUT_MS) || 30_000,
    maxResponseBytes = Number(env.COCKPIT_TEAM_MAX_RESPONSE_BYTES) || 1_048_576,
    homeDir = os.homedir(),
    configPath = env.COCKPIT_TEAM_CONFIG_PATH || path.join(homeDir, ".cockpit", "team-auth.json"),
    sourceCodexAuthPath = path.join(homeDir, ".codex", "auth.json"),
    sourceClaudeCredentialsPath = path.join(homeDir, ".claude", ".credentials.json"),
    sourceClaudeConfigPaths = [
      path.join(homeDir, ".claude", ".claude.json"),
      path.join(homeDir, ".claude.json"),
    ],
    brokerCodexHome = env.COCKPIT_TEAM_CODEX_HOME || path.join(homeDir, ".cockpit", "codex"),
    brokerClaudeHome = env.COCKPIT_TEAM_CLAUDE_HOME || path.join(homeDir, ".cockpit", "claude"),
    paths = {},
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TeamAccountsError("Fetch indisponível neste ambiente.", { code: "FETCH_UNAVAILABLE" });
    }
    this.#fetch = fetchImpl;
    this.#env = env;
    this.#timeoutMs = Math.max(1_000, Math.min(Number(timeoutMs) || 30_000, 120_000));
    this.#maxResponseBytes = Math.max(16_384, Math.min(Number(maxResponseBytes) || 1_048_576, 8_388_608));
    this.#paths = { ...TEAM_API_PATHS, ...paths };
    this.#homeDir = path.resolve(homeDir);
    this.#configPath = path.resolve(configPath);
    this.#sourceCodexAuthPath = path.resolve(sourceCodexAuthPath);
    this.#sourceCodexHome = path.dirname(this.#sourceCodexAuthPath);
    this.#sourceClaudeCredentialsPath = path.resolve(sourceClaudeCredentialsPath);
    this.#sourceClaudeConfigPaths = sourceClaudeConfigPaths.map((item) => path.resolve(item));
    this.#brokerCodexHome = path.resolve(brokerCodexHome);
    this.#brokerClaudeHome = path.resolve(brokerClaudeHome);
    this.#brokerClaudeAuthPath = path.join(this.#brokerClaudeHome, ".credentials.json");
    this.#unavailableCodexHome = path.join(this.#brokerCodexHome, "unavailable");
    this.#brokerCodexAuthPath = path.join(this.#brokerCodexHome, "auth.json");
    this.#brokerMarkerPath = path.join(this.#brokerCodexHome, ".cockpit-team-broker.json");
    this.#config = this.#loadConfig();
  }

  #loadConfig() {
    const stored = readJson(this.#configPath);
    if (!stored || typeof stored.baseUrl !== "string" || typeof stored.deviceToken !== "string") {
      return null;
    }
    try {
      return {
        baseUrl: normalizeBaseUrl(stored.baseUrl, this.#env),
        deviceToken: stored.deviceToken.trim(),
      };
    } catch {
      return null;
    }
  }

  #requireConfig() {
    if (!this.#config?.baseUrl || !this.#config?.deviceToken) {
      throw new TeamAccountsError("Cockpit não está conectado ao DevNX Control.", {
        code: "NOT_CONNECTED",
      });
    }
    return this.#config;
  }

  async #request(apiPath, {
    method = "GET",
    body,
    token,
    baseUrl,
    requireAuth = true,
    timeoutMs = this.#timeoutMs,
  } = {}) {
    const config = requireAuth ? this.#requireConfig() : null;
    const requestBase = normalizeBaseUrl(baseUrl || config?.baseUrl, this.#env);
    const authToken = token || (requireAuth ? config.deviceToken : null);
    const controller = new AbortController();
    const effectiveTimeout = Math.max(1_000, Math.min(Number(timeoutMs) || this.#timeoutMs, 120_000));
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    timer.unref?.();
    try {
      const response = await this.#fetch(apiUrl(requestBase, apiPath), {
        method,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });

      let payload = null;
      const text = await readLimitedResponse(response, this.#maxResponseBytes);
      if (text) {
        try { payload = JSON.parse(text); } catch {
          throw new TeamAccountsError("Resposta inválida do DevNX Control.", {
            code: "INVALID_SERVER_RESPONSE",
            status: response.status,
          });
        }
      }
      if (!response.ok) {
        const detail = safeServerMessage(payload);
        throw new TeamAccountsError(
          `DevNX Control respondeu HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          { code: "HTTP_ERROR", status: response.status },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof TeamAccountsError) throw error;
      if (controller.signal.aborted) {
        throw new TeamAccountsError("Tempo limite ao contatar o DevNX Control.", {
          code: "REQUEST_TIMEOUT",
        });
      }
      throw new TeamAccountsError("Não foi possível contatar o DevNX Control.", {
        code: "NETWORK_ERROR",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    const selected = {};
    for (const [provider, entry] of this.#selected.entries()) {
      selected[provider] = safeAccount(entry.account);
    }
    let suggestedBaseUrl = null;
    if (!this.#config?.baseUrl) {
      const configured = this.#env.COCKPIT_TEAM_BASE_URL || this.#env.DEVNX_CONTROL_URL;
      if (configured) {
        try { suggestedBaseUrl = normalizeBaseUrl(configured, this.#env); } catch { /* invalid env is not a saved connection */ }
      }
    }
    return {
      connected: Boolean(this.#config?.deviceToken),
      baseUrl: this.#config?.baseUrl || suggestedBaseUrl,
      selected,
    };
  }

  async connect({ baseUrl, email, password, deviceName } = {}) {
    const normalizedBase = normalizeBaseUrl(
      baseUrl || this.#env.COCKPIT_TEAM_BASE_URL || this.#env.DEVNX_CONTROL_URL,
      this.#env,
    );
    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
      throw new TeamAccountsError("E-mail e senha são obrigatórios.", { code: "INVALID_LOGIN" });
    }

    const login = await this.#request(this.#paths.login, {
      method: "POST",
      body: { email: email.trim(), password },
      baseUrl: normalizedBase,
      requireAuth: false,
    });
    const jwt = requireString(login?.access_token || login?.token, "JWT de login");
    const issued = await this.#request(this.#paths.deviceTokens, {
      method: "POST",
      body: { name: String(deviceName || `Cockpit - ${os.hostname()}`).slice(0, 120) },
      token: jwt,
      baseUrl: normalizedBase,
      requireAuth: false,
    });
    const deviceToken = requireString(
      issued?.token || issued?.plain_text_token || issued?.access_token,
      "token do dispositivo",
    ).replace(/^Bearer\s+/i, "");

    const previousConfig = this.#config;
    atomicWriteJson(this.#configPath, { baseUrl: normalizedBase, deviceToken });
    this.#config = { baseUrl: normalizedBase, deviceToken };
    if (previousConfig?.deviceToken) {
      try {
        await this.#request(this.#paths.revokeDeviceToken, {
          method: "DELETE",
          token: previousConfig.deviceToken,
          baseUrl: previousConfig.baseUrl,
          requireAuth: false,
        });
      } catch {
        // The new device token is already safe locally; old-token cleanup is best effort.
      }
    }
    this.#clearBrokerFiles({ all: true });
    this.#selected.clear();
    this.#openAiCapabilities.clear();
    return this.status();
  }

  async logout() {
    if (this.#config) {
      try {
        await this.#request(this.#paths.revokeDeviceToken, { method: "DELETE" });
      } catch {
        // Best effort: local revocation must still happen while offline.
      }
    }
    this.#config = null;
    this.#selected.clear();
    this.#openAiCapabilities.clear();
    deleteFile(this.#configPath);
    this.#clearBrokerFiles({ all: true });
    return this.status();
  }

  // Call only after PTYs have been stopped. Keeps the paired device token but
  // removes short-lived provider material written for this process.
  cleanupRuntime() {
    this.#selected.clear();
    this.#openAiCapabilities.clear();
    this.#clearBrokerFiles();
    return this.status();
  }

  clearSelected(provider) {
    if (provider == null) {
      this.#selected.clear();
      return this.status();
    }
    const normalized = normalizeProvider(provider);
    this.#selected.delete(normalized);
    return this.status();
  }

  async listAccounts(provider) {
    const normalized = provider == null ? null : normalizeProvider(provider);
    const query = normalized ? `?provider=${encodeURIComponent(normalized)}` : "";
    const payload = await this.#request(`${this.#paths.accounts}${query}`);
    const accounts = Array.isArray(payload) ? payload : payload?.accounts;
    if (!Array.isArray(accounts)) {
      throw new TeamAccountsError("Resposta de contas inválida do DevNX Control.", {
        code: "INVALID_SERVER_RESPONSE",
      });
    }
    return accounts.map(safeAccount);
  }

  async #select(provider, accountId) {
    const normalized = normalizeProvider(provider);
    const payload = await this.#request(this.#paths.select, {
      method: "POST",
      body: {
        provider: normalized,
        ...(accountId ? { account_id: String(accountId) } : {}),
      },
      timeoutMs: Math.max(this.#timeoutMs, 30_000),
    });
    return this.#rememberSelection(normalized, payload);
  }

  async selectBest(provider) {
    return this.#select(provider);
  }

  async selectAccount(provider, accountId) {
    if (typeof accountId !== "string" || !accountId.trim()) {
      throw new TeamAccountsError("ID da conta é obrigatório.", { code: "INVALID_ACCOUNT_ID" });
    }
    return this.#select(provider, accountId.trim());
  }

  #rememberSelection(provider, payload) {
    const account = safeAccount(payload?.account);
    if (normalizeProvider(account.provider) !== provider) {
      throw new TeamAccountsError("Seleção retornou uma plataforma diferente da solicitada.", {
        code: "INVALID_SERVER_RESPONSE",
      });
    }
    const accountId = accountIdOf(account);
    if (!accountId) {
      throw new TeamAccountsError("Resposta sem ID público da conta.", {
        code: "INVALID_SERVER_RESPONSE",
      });
    }

    if (provider === "openai") {
      const client = normalizeOpenAiClient(payload?.client, accountId);
      const capability = makeCapability(accountId);
      // Persist runtime/history per provider account, while capabilities remain
      // ephemeral. Re-selecting the same account reuses its Codex history; a
      // different account receives another home and cannot switch an old PTY.
      const accountKey = crypto.createHash("sha256").update(accountId).digest("hex").slice(0, 32);
      const codexHome = path.join(this.#brokerCodexHome, "accounts", accountKey);
      const entry = {
        account,
        client,
        capability,
        codexHome,
        authPath: path.join(codexHome, "auth.json"),
        authPaths: new Set(),
      };
      this.#openAiCapabilities.set(capability, entry);
      this.#selected.set(provider, entry);
      return { account, clientType: client.type };
    }

    const client = normalizeClaudeClient(payload?.client);
    this.#selected.set(provider, { account, client });
    return { account, clientType: client.type };
  }

  async #refreshOpenAiPayload(accountId) {
    const payload = await this.#request(this.#paths.refresh(accountId), {
      method: "POST",
      body: {},
      timeoutMs: Math.max(this.#timeoutMs, 45_000),
    });
    const account = safeAccount(payload?.account);
    const resolvedId = accountIdOf(account);
    if (!resolvedId || resolvedId !== String(accountId)) {
      throw new TeamAccountsError("Refresh retornou uma conta diferente da solicitada.", {
        code: "INVALID_SERVER_RESPONSE",
      });
    }
    const client = normalizeOpenAiClient(payload?.client, resolvedId);
    for (const entry of this.#openAiCapabilities.values()) {
      if (entry.client.account_uuid === resolvedId) {
        entry.client = client;
        entry.account = account;
        const authPaths = entry.authPaths?.size ? entry.authPaths : new Set([entry.authPath]);
        for (const authPath of authPaths) {
          if (this.#ownedAuthPaths.has(authPath)) this.#writeCodexEntry(entry, authPath);
        }
      }
    }
    const selected = this.#selected.get("openai");
    if (selected?.client?.account_uuid === resolvedId) {
      selected.client = client;
      selected.account = account;
    }
    return { account, client };
  }

  async refreshOpenAi(accountId) {
    if (typeof accountId !== "string" || !accountId.trim()) {
      throw new TeamAccountsError("ID da conta OpenAI é obrigatório.", {
        code: "INVALID_ACCOUNT_ID",
      });
    }
    const { account, client } = await this.#refreshOpenAiPayload(accountId.trim());
    return { account, clientType: client.type };
  }

  async #refreshClaudePayload(accountId) {
    const payload = await this.#request(this.#paths.refresh(accountId), {
      method: "POST",
      body: {},
      timeoutMs: Math.max(this.#timeoutMs, 45_000),
    });
    const account = safeAccount(payload?.account);
    const resolvedId = accountIdOf(account);
    if (!resolvedId || resolvedId !== String(accountId)) {
      throw new TeamAccountsError("Refresh Claude retornou uma conta diferente da solicitada.", {
        code: "INVALID_SERVER_RESPONSE",
      });
    }
    const client = normalizeClaudeClient(payload?.client);
    const selected = this.#selected.get("claude");
    if (accountIdOf(selected?.account) === resolvedId) {
      selected.account = account;
      selected.client = client;
    }
    return { account, client };
  }

  async #recoverClaudeSelection(failedToken) {
    const current = this.#selected.get("claude");
    if (current?.client?.oauth_token && current.client.oauth_token !== failedToken) return;
    if (this.#claudeRefreshPromise) return this.#claudeRefreshPromise;

    this.#claudeRefreshPromise = (async () => {
      const accountId = accountIdOf(this.#selected.get("claude")?.account);
      if (accountId) {
        try {
          await this.#refreshClaudePayload(accountId);
          return;
        } catch {
          // A refresh token may also have been revoked. Let the central usage
          // sync mark that account unavailable and select another one.
        }
      }
      try { await this.syncUsage("claude"); } catch {}
      await this.selectBest("claude");
    })();
    try {
      await this.#claudeRefreshPromise;
    } finally {
      this.#claudeRefreshPromise = null;
    }
  }

  /**
   * Proxies Claude API traffic through the loopback Cockpit server. The CLI
   * only receives an ephemeral local capability; provider tokens never enter
   * the PTY environment and can therefore rotate without restarting Claude.
   */
  async handleClaudeProxyRequest({ authorization, method, requestPath, headers = {}, body } = {}) {
    const capability = bearerToken(authorization);
    if (!secretsEqual(capability, this.#claudeProxyCapability)) {
      throw new TeamAccountsError("Capability Claude inválida ou expirada.", {
        code: "INVALID_OAUTH_CAPABILITY",
        status: 401,
      });
    }
    const normalizedMethod = String(method || "POST").toUpperCase();
    if (!new Set(["GET", "POST"]).has(normalizedMethod)) {
      throw new TeamAccountsError("Método Claude não permitido.", {
        code: "INVALID_CLAUDE_PROXY_REQUEST",
        status: 405,
      });
    }
    const target = new URL(String(requestPath || ""), "https://api.anthropic.com");
    if (target.origin !== "https://api.anthropic.com" || !target.pathname.startsWith("/v1/")) {
      throw new TeamAccountsError("Rota Claude não permitida.", {
        code: "INVALID_CLAUDE_PROXY_REQUEST",
        status: 404,
      });
    }

    const forwardedHeaders = {};
    const safeHeader = /^(?:accept|content-type|anthropic-version|anthropic-beta|user-agent|x-app|x-stainless-[a-z0-9-]+)$/i;
    for (const [key, value] of Object.entries(headers || {})) {
      if (!safeHeader.test(key) || Array.isArray(value) || value == null) continue;
      forwardedHeaders[key] = String(value);
    }

    const send = async () => {
      const token = this.#selected.get("claude")?.client?.oauth_token;
      if (!token) {
        throw new TeamAccountsError("Nenhuma conta Claude foi selecionada.", {
          code: "NO_CLAUDE_SELECTION",
          status: 503,
        });
      }
      const response = await this.#fetch(target, {
        method: normalizedMethod,
        headers: {
          ...forwardedHeaders,
          Authorization: `Bearer ${token}`,
        },
        ...(normalizedMethod === "GET" || body == null ? {} : { body }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      return { response, token };
    };

    let attempt = await send();
    if (attempt.response.status === 401) {
      try { await attempt.response.body?.cancel(); } catch {}
      await this.#recoverClaudeSelection(attempt.token);
      attempt = await send();
    }
    return attempt.response;
  }

  /**
   * Sensitive server-side bridge for the loopback Codex OAuth endpoint.
   * Never expose this return value through renderer-facing account APIs.
   */
  async handleOpenAiRefreshRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TeamAccountsError("Corpo OAuth inválido.", { code: "INVALID_OAUTH_REQUEST" });
    }
    const allowedKeys = new Set(["grant_type", "refresh_token", "client_id", "scope"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      throw new TeamAccountsError("Parâmetros OAuth inválidos.", { code: "INVALID_OAUTH_REQUEST" });
    }
    if (body.grant_type !== "refresh_token" || typeof body.refresh_token !== "string") {
      throw new TeamAccountsError("Grant OAuth inválido.", { code: "INVALID_OAUTH_REQUEST" });
    }
    const registered = this.#openAiCapabilities.get(body.refresh_token);
    if (!registered) {
      throw new TeamAccountsError("Capability OAuth inválida ou expirada.", {
        code: "INVALID_OAUTH_CAPABILITY",
      });
    }

    const placeholder = body.refresh_token;
    const { client } = await this.#refreshOpenAiPayload(registered.client.account_uuid);
    return {
      access_token: client.access_token,
      id_token: client.id_token,
      account_id: client.account_id,
      refresh_token: placeholder,
      token_type: "Bearer",
      expires_in: expiresInSeconds(client.expires_at),
    };
  }

  async syncUsage(provider) {
    const normalized = provider == null ? null : normalizeProvider(provider);
    const payload = await this.#request(this.#paths.syncUsage, {
      method: "POST",
      body: normalized ? { provider: normalized } : {},
      timeoutMs: Math.max(this.#timeoutMs, 120_000),
    });
    const accounts = Array.isArray(payload) ? payload : payload?.accounts;
    if (!Array.isArray(accounts)) {
      throw new TeamAccountsError("Resposta de uso inválida do DevNX Control.", {
        code: "INVALID_SERVER_RESPONSE",
      });
    }
    return accounts.map(safeAccount);
  }

  async syncAccountUsage(accountId) {
    if (typeof accountId !== "string" || !accountId.trim()) {
      throw new TeamAccountsError("ID da conta é obrigatório.", { code: "INVALID_ACCOUNT_ID" });
    }
    const payload = await this.#request(this.#paths.syncAccountUsage(accountId.trim()), {
      method: "POST",
      body: {},
    });
    return safeAccount(payload?.account || payload);
  }

  async #upsert(body) {
    const payload = await this.#request(this.#paths.upsert, { method: "POST", body });
    return safeAccount(payload?.account || payload);
  }

  async publishCurrentOpenAi(options = {}) {
    const auth = readJson(options.authPath ? path.resolve(options.authPath) : this.#sourceCodexAuthPath);
    if (!auth) {
      throw new TeamAccountsError("Auth local do Codex não encontrada.", { code: "LOCAL_AUTH_NOT_FOUND" });
    }
    if (auth.auth_mode === "apikey" || auth.auth_mode === "api_key" || auth.OPENAI_API_KEY) {
      throw new TeamAccountsError("Contas por OPENAI_API_KEY não são publicadas no cofre de sessões.", {
        code: "API_KEY_NOT_SUPPORTED",
      });
    }

    const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
    const refreshToken = requireString(tokens.refresh_token, "refresh token local OpenAI");
    if (refreshToken.startsWith("cockpit:")) {
      throw new TeamAccountsError("O auth selecionado já pertence ao broker do Cockpit.", {
        code: "BROKERED_AUTH_NOT_PUBLISHABLE",
      });
    }
    const idToken = requireString(tokens.id_token, "ID token local OpenAI");
    const accountId = requireString(tokens.account_id, "account ID local OpenAI");
    const claims = decodeJwtPayload(idToken);
    const label = String(options.label || claims.email || accountId).trim();

    return this.#upsert({
      ...(options.id ? { id: String(options.id) } : {}),
      provider: "openai",
      label,
      ...(options.plan ? { plan: options.plan } : {}),
      credential_type: "oauth_refresh",
      credentials: {
        access_token: requireString(tokens.access_token, "access token local OpenAI"),
        id_token: idToken,
        account_id: accountId,
        refresh_token: refreshToken,
        last_refresh: auth.last_refresh || null,
        auth_mode: auth.auth_mode || "chatgpt",
      },
      ...(options.isEnabled !== undefined ? { is_enabled: Boolean(options.isEnabled) } : {}),
      ...(options.subscriptionExpiresAt ? { subscription_expires_at: options.subscriptionExpiresAt } : {}),
      ...(options.priority !== undefined ? { priority: Number(options.priority) } : {}),
    });
  }

  async publishClaudeSetupToken(setupToken, options = {}) {
    const oauthToken = requireString(setupToken, "setup-token Claude");
    const label = String(options.label || this.#localClaudeEmail() || "Claude local").trim();
    return this.#upsert({
      ...(options.id ? { id: String(options.id) } : {}),
      provider: "claude",
      label,
      ...(options.plan ? { plan: options.plan } : {}),
      credential_type: "setup_token",
      credentials: { oauth_token: oauthToken },
      ...(options.isEnabled !== undefined ? { is_enabled: Boolean(options.isEnabled) } : {}),
      ...(options.subscriptionExpiresAt ? { subscription_expires_at: options.subscriptionExpiresAt } : {}),
      ...(options.priority !== undefined ? { priority: Number(options.priority) } : {}),
    });
  }

  async publishCurrentClaudeOauth(options = {}) {
    const auth = readJson(
      options.authPath ? path.resolve(options.authPath) : this.#sourceClaudeCredentialsPath,
    );
    const oauth = auth?.claudeAiOauth;
    if (!oauth || typeof oauth !== "object") {
      throw new TeamAccountsError("Sessão claudeAiOauth local não encontrada.", {
        code: "LOCAL_AUTH_NOT_FOUND",
      });
    }
    const label = String(options.label || this.#localClaudeEmail() || "Claude local").trim();
    return this.#upsert({
      ...(options.id ? { id: String(options.id) } : {}),
      provider: "claude",
      label,
      plan: options.plan || oauth.subscriptionType || oauth.rateLimitTier || null,
      credential_type: "oauth_refresh",
      credentials: {
        access_token: requireString(oauth.accessToken, "access token local Claude"),
        refresh_token: requireString(oauth.refreshToken, "refresh token local Claude"),
        expires_at: oauth.expiresAt || null,
        scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
        subscription_type: oauth.subscriptionType || null,
        rate_limit_tier: oauth.rateLimitTier || null,
      },
      ...(options.isEnabled !== undefined ? { is_enabled: Boolean(options.isEnabled) } : {}),
      ...(options.subscriptionExpiresAt ? { subscription_expires_at: options.subscriptionExpiresAt } : {}),
      ...(options.priority !== undefined ? { priority: Number(options.priority) } : {}),
    });
  }

  async publishCurrent(provider, options = {}) {
    const normalized = normalizeProvider(provider);
    if (normalized === "openai") return this.publishCurrentOpenAi(options);
    if (options.setupToken) return this.publishClaudeSetupToken(options.setupToken, options);
    return this.publishCurrentClaudeOauth(options);
  }

  #localClaudeEmail() {
    for (const file of this.#sourceClaudeConfigPaths) {
      const config = readJson(file);
      const email = config?.oauthAccount?.emailAddress;
      if (typeof email === "string" && email.trim()) return email.trim();
    }
    return null;
  }

  #prepareClaudeHome(projectPath) {
    secureDirectory(this.#brokerClaudeHome);
    const configPath = path.join(this.#brokerClaudeHome, ".claude.json");
    const config = readJson(configPath) || {};
    let trustedProject = null;
    if (typeof projectPath === "string" && projectPath.trim()) {
      try {
        const resolved = fs.realpathSync(path.resolve(projectPath));
        if (fs.statSync(resolved).isDirectory()) trustedProject = resolved;
      } catch {}
    }

    // CLAUDE_CODE_OAUTH_TOKEN authenticates the process, but Claude Code still
    // opens its login wizard when a fresh CLAUDE_CONFIG_DIR has never completed
    // onboarding. This marker contains no account or credential material; it
    // only lets the CLI proceed to the already authenticated REPL.
    const existingProject = trustedProject ? config.projects?.[trustedProject] : null;
    const needsProjectTrust = trustedProject && (
      existingProject?.hasTrustDialogAccepted !== true
      || existingProject?.hasCompletedProjectOnboarding !== true
    );
    const settingsPath = path.join(this.#brokerClaudeHome, "settings.json");
    const settings = readJson(settingsPath) || {};

    // Cockpit's configured Claude command explicitly requests bypass mode. The
    // isolated profile must remember that confirmation independently from the
    // user's local ~/.claude profile, otherwise every launch stops at a safety
    // dialog even though the flag was intentionally supplied. A new isolated
    // profile starts with the ANSI theme so Claude uses Cockpit's Dracula
    // terminal palette; later choices made inside Claude remain untouched.
    if (settings.skipDangerousModePermissionPrompt !== true || !settings.theme) {
      atomicWriteJson(settingsPath, {
        ...settings,
        skipDangerousModePermissionPrompt: true,
        theme: settings.theme || "dark-ansi",
      });
    } else {
      try { fs.chmodSync(settingsPath, 0o600); } catch {}
    }

    if (config.hasCompletedOnboarding !== true || needsProjectTrust) {
      atomicWriteJson(configPath, {
        ...config,
        hasCompletedOnboarding: true,
        ...(trustedProject ? {
          projects: {
            ...(config.projects || {}),
            [trustedProject]: {
              ...(existingProject || {}),
              hasTrustDialogAccepted: true,
              hasCompletedProjectOnboarding: true,
            },
          },
        } : {}),
      });
      return;
    }

    try { fs.chmodSync(configPath, 0o600); } catch {}
  }

  enrichPtyEnv(baseEnv = {}, { codexRefreshUrl, claudeProxyUrl, claudeProjectPath } = {}) {
    const env = { ...baseEnv };

    // PTYs never inherit provider authentication from the host. Both CLIs are
    // pointed at Cockpit-owned homes even while disconnected, so a missing
    // central selection fails closed instead of falling back to ~/.claude or
    // ~/.codex. Local sessions remain untouched and are used only for the
    // explicit one-time publish action.
    this.#prepareClaudeHome(claudeProjectPath);
    secureDirectory(this.#unavailableCodexHome);
    env.CLAUDE_CONFIG_DIR = this.#brokerClaudeHome;
    env.CODEX_HOME = this.#unavailableCodexHome;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.OPENAI_API_KEY;
    delete env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;

    const claude = this.#selected.get("claude");
    if (claude?.client?.oauth_token) {
      if (!claudeProxyUrl) {
        throw new TeamAccountsError("URL loopback do broker Claude é obrigatória.", {
          code: "MISSING_CLAUDE_PROXY_URL",
        });
      }
      const proxyUrl = new URL(claudeProxyUrl);
      if (
        proxyUrl.protocol !== "http:"
        || !LOCAL_HOSTS.has(proxyUrl.hostname)
        || proxyUrl.username
        || proxyUrl.password
        || proxyUrl.search
        || proxyUrl.hash
      ) {
        throw new TeamAccountsError("Broker Claude deve usar endpoint HTTP loopback.", {
          code: "INVALID_CLAUDE_PROXY_URL",
        });
      }
      deleteFile(this.#brokerClaudeAuthPath);
      env.CLAUDE_CODE_OAUTH_TOKEN = this.#claudeProxyCapability;
      env.ANTHROPIC_BASE_URL = proxyUrl.toString().replace(/\/$/, "");
    } else {
      deleteFile(this.#brokerClaudeAuthPath);
    }

    const openai = this.#selected.get("openai");
    if (openai) {
      if (!codexRefreshUrl) {
        throw new TeamAccountsError("URL loopback de refresh Codex é obrigatória.", {
          code: "MISSING_CODEX_REFRESH_URL",
        });
      }
      const refreshUrl = new URL(codexRefreshUrl);
      if (
        refreshUrl.protocol !== "http:"
        || !LOCAL_HOSTS.has(refreshUrl.hostname)
        || refreshUrl.username
        || refreshUrl.password
        || refreshUrl.hash
      ) {
        throw new TeamAccountsError("Refresh Codex deve usar endpoint HTTP loopback.", {
          code: "INVALID_CODEX_REFRESH_URL",
        });
      }
      env.CODEX_HOME = openai.codexHome;
      env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = refreshUrl.toString();
    } else {
      // A PTY may outlive a temporary Control outage. Remember its fail-closed
      // home so the first later selection can promote that shell without
      // changing CODEX_HOME (process environments are immutable after spawn).
      const pendingAuthPath = path.join(this.#unavailableCodexHome, "auth.json");
      deleteFile(pendingAuthPath);
      this.#pendingCodexAuthPaths.add(pendingAuthPath);
    }
    return env;
  }

  materializeCodexAuth(authPath = this.#brokerCodexAuthPath) {
    const selected = this.#selected.get("openai");
    if (!selected?.client || !selected.capability) {
      throw new TeamAccountsError("Nenhuma conta OpenAI foi selecionada.", {
        code: "NO_OPENAI_SELECTION",
      });
    }
    const destination = authPath === this.#brokerCodexAuthPath
      ? selected.authPath
      : path.resolve(authPath);
    const relative = path.relative(this.#brokerCodexHome, destination);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new TeamAccountsError("Auth brokerado deve permanecer no CODEX_HOME exclusivo do Cockpit.", {
        code: "UNSAFE_CODEX_AUTH_PATH",
      });
    }
    if (destination !== selected.authPath) {
      selected.authPath = destination;
      selected.codexHome = path.dirname(destination);
    }
    this.#prepareCodexHome(selected.codexHome);
    this.#writeCodexEntry(selected, destination);
    this.#ownedAuthPaths.add(destination);
    selected.authPaths ||= new Set();
    selected.authPaths.add(destination);

    // Shells created while the central selection was temporarily unavailable
    // keep their original CODEX_HOME. Materialize the recovered capability in
    // those homes once, then leave them pinned to this account just like PTYs
    // that were created after selection.
    for (const pendingAuthPath of [...this.#pendingCodexAuthPaths]) {
      this.#prepareCodexHome(path.dirname(pendingAuthPath));
      this.#writeCodexEntry(selected, pendingAuthPath);
      this.#ownedAuthPaths.add(pendingAuthPath);
      selected.authPaths.add(pendingAuthPath);
      this.#pendingCodexAuthPaths.delete(pendingAuthPath);
    }
    return {
      path: destination,
      account: safeAccount(selected.account),
    };
  }

  #writeCodexEntry(selected, destination) {
    const client = selected.client;
    const output = {
      auth_mode: client.auth_mode || "chatgpt",
      last_refresh: client.last_refresh || new Date().toISOString(),
      tokens: {
        access_token: client.access_token,
        id_token: client.id_token,
        account_id: client.account_id,
        refresh_token: selected.capability,
      },
    };
    if (destination.startsWith(`${this.#brokerCodexHome}${path.sep}`)) {
      atomicWriteJson(this.#brokerMarkerPath, { kind: "cockpit-team-codex-root", version: 1 });
    }
    atomicWriteJson(destination, output);
  }

  #prepareCodexHome(codexHome) {
    secureDirectory(codexHome);

    // Snapshot user preferences, never the source authentication file. A
    // snapshot avoids changing a running terminal when global config changes.
    const sourceConfig = path.join(this.#sourceCodexHome, "config.toml");
    try {
      const stat = fs.statSync(sourceConfig);
      if (stat.isFile()) atomicWriteFile(path.join(codexHome, "config.toml"), fs.readFileSync(sourceConfig));
    } catch {}

    // Static extensions can be shared read-only by convention. Mutable state
    // (sessions, history, logs, SQLite, MCP OAuth state) is deliberately absent.
    for (const name of CODEX_STATIC_DIRS) {
      const source = path.join(this.#sourceCodexHome, name);
      const destination = path.join(codexHome, name);
      try {
        if (!fs.statSync(source).isDirectory() || fs.existsSync(destination)) continue;
        fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
      } catch {
        // Windows may deny symlinks without Developer Mode; an empty static
        // directory set is safer than copying an uncontrolled credential tree.
      }
    }
  }

  #clearBrokerFiles({ all = false } = {}) {
    try { deleteFile(this.#brokerClaudeAuthPath); } catch {}
    for (const authPath of this.#pendingCodexAuthPaths) {
      try { deleteFile(authPath); } catch {}
    }
    this.#pendingCodexAuthPaths.clear();
    for (const authPath of this.#ownedAuthPaths) {
      try { deleteFile(authPath); } catch {}
    }
    this.#ownedAuthPaths.clear();

    const marker = readJson(this.#brokerMarkerPath);
    const cockpitDir = path.join(this.#homeDir, ".cockpit");
    const insideCockpit = this.#brokerCodexHome.startsWith(`${cockpitDir}${path.sep}`);
    if (all && insideCockpit && marker?.kind === "cockpit-team-codex-root" && marker?.version === 1) {
      // Preserve account-specific sessions, history and SQLite state. Only
      // provider auth is ephemeral and must be removed on disconnect.
      for (const bucket of ["accounts", "sessions"]) {
        const bucketPath = path.join(this.#brokerCodexHome, bucket);
        let entries = [];
        try { entries = fs.readdirSync(bucketPath, { withFileTypes: true }); } catch {}
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          try { deleteFile(path.join(bucketPath, entry.name, "auth.json")); } catch {}
        }
      }
      try { deleteFile(path.join(this.#brokerCodexHome, "auth.json")); } catch {}
    }
  }
}

export function createTeamAccountsClient(options) {
  return new TeamAccountsClient(options);
}
