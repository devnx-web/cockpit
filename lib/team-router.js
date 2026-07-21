import os from "os";
import { Readable } from "node:stream";

const PROVIDERS = new Set(["openai", "claude"]);
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 64 * 1024) {
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
        return;
      }
      if (!tooLarge) raw += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(httpError(413, "corpo da requisição muito grande"));
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(httpError(400, "JSON inválido"));
      }
    });
  });
}

function readRawBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(httpError(413, "corpo da requisição Claude muito grande"));
      resolve(Buffer.concat(chunks, size));
    });
  });
}

function accountId(account) {
  return account?.id || account?.uuid || account?.public_id || null;
}

// Defesa adicional: ainda que o backend acrescente campos futuramente, estas
// rotas nunca encaminham credenciais para o renderer.
function safeAccount(account = {}) {
  return {
    id: accountId(account),
    provider: account.provider,
    label: account.label || account.name || account.email || "conta sem nome",
    plan: account.plan ?? null,
    credential_type: account.credential_type ?? null,
    status: account.status ?? "unknown",
    is_enabled: account.is_enabled !== false,
    usage: account.usage && typeof account.usage === "object" ? {
      five_hour: {
        percent: account.usage.five_hour?.percent ?? null,
        resets_at: account.usage.five_hour?.resets_at ?? null,
      },
      weekly: {
        percent: account.usage.weekly?.percent ?? null,
        resets_at: account.usage.weekly?.resets_at ?? null,
      },
    } : {
      five_hour: { percent: account.usage_5h_percent ?? null, resets_at: account.usage_5h_resets_at ?? null },
      weekly: { percent: account.usage_weekly_percent ?? null, resets_at: account.usage_weekly_resets_at ?? null },
    },
    expires_at: account.expires_at && typeof account.expires_at === "object" ? {
      access_token: account.expires_at.access_token ?? null,
      refresh_token: account.expires_at.refresh_token ?? null,
      subscription: account.expires_at.subscription ?? null,
    } : undefined,
    last_synced_at: account.last_synced_at ?? null,
    last_refreshed_at: account.last_refreshed_at ?? null,
    last_selected_at: account.last_selected_at ?? null,
    priority: account.priority ?? 0,
  };
}

function safeStatus(status = {}) {
  const selected = {};
  for (const provider of PROVIDERS) {
    const value = status.selected?.[provider];
    if (!value) continue;
    selected[provider] = {
      id: accountId(value) || (typeof value === "string" ? value : null),
      provider,
      label: typeof value === "object" ? (value.label || value.name || null) : null,
    };
  }
  return {
    connected: Boolean(status.connected),
    baseUrl: status.baseUrl || null,
    selected,
  };
}

function publicError(error) {
  const codeStatus = {
    NOT_CONNECTED: 401,
    INVALID_OAUTH_CAPABILITY: 401,
    INVALID_OAUTH_REQUEST: 400,
    INVALID_ACCOUNT_ID: 422,
    INVALID_PROVIDER: 422,
    INVALID_BASE_URL: 422,
    INSECURE_BASE_URL: 422,
  };
  const statusCode = Number(error?.statusCode || error?.status || codeStatus[error?.code] || 0);
  const allowedStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  let message = allowedStatus >= 500
    ? "serviço central indisponível"
    : String(error?.message || "requisição inválida");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|password|authorization|credential)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .slice(0, 240);
  return { statusCode: allowedStatus, message };
}

export class TeamRouter {
  constructor({ client, brokerUrl = () => null, log = console } = {}) {
    if (!client) throw new TypeError("client é obrigatório");
    this.client = client;
    this.brokerUrl = brokerUrl;
    this.log = log;
    this.lastBootstrapAt = 0;
    this.lastBootstrapResult = null;
    this.bootstrapPromise = null;
  }

  status() {
    return safeStatus(this.client.status());
  }

  assertLocalRequest(req, { sensitive = false } = {}) {
    const brokerUrl = this.brokerUrl();
    if (brokerUrl) {
      const expected = new URL(brokerUrl);
      if (String(req.headers.host || "") !== expected.host) {
        throw httpError(403, "host local inválido");
      }
      const origin = req.headers.origin;
      if (origin && origin !== expected.origin) {
        throw httpError(403, "origem não permitida");
      }
    }
    const fetchSite = String(req.headers["sec-fetch-site"] || "");
    if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
      throw httpError(403, "requisição cross-site bloqueada");
    }
    if ((req.method || "GET") === "POST") {
      const contentType = String(req.headers["content-type"] || "")
        .split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        throw httpError(415, "Content-Type application/json obrigatório");
      }
    }
    if (sensitive && (req.headers.origin || req.headers.referer)) {
      throw httpError(403, "origem não permitida para autenticação do broker");
    }
  }

  async accounts() {
    const status = this.status();
    if (!status.connected) throw httpError(401, "Cockpit não conectado ao DevNX Control");
    const selectedIds = Object.fromEntries(
      Object.entries(status.selected).map(([provider, account]) => [provider, account.id]),
    );
    return (await this.client.listAccounts()).map((raw) => {
      const account = safeAccount(raw);
      account.selected = selectedIds[account.provider] === account.id;
      account.active = account.selected;
      return account;
    });
  }

  async bootstrap({ syncUsage = false } = {}) {
    if (this.bootstrapPromise) return this.bootstrapPromise;

    this.bootstrapPromise = this.#bootstrap({ syncUsage });
    try {
      const result = await this.bootstrapPromise;
      this.lastBootstrapAt = Date.now();
      this.lastBootstrapResult = result;
      return result;
    } finally {
      this.bootstrapPromise = null;
    }
  }

  async #bootstrap({ syncUsage = false } = {}) {
    if (!this.status().connected) return { connected: false, selections: [], warnings: [] };
    const warnings = [];
    if (syncUsage) {
      try { await this.client.syncUsage(); }
      catch (error) { warnings.push(publicError(error).message); }
    }
    const settled = await Promise.allSettled(
      [...PROVIDERS].map(async (provider) => {
        const selected = await this.client.selectBest(provider);
        if (provider === "openai") await this.client.materializeCodexAuth();
        return { provider, account: safeAccount(selected.account) };
      }),
    );
    const selections = [];
    settled.forEach((result) => {
      if (result.status === "fulfilled") selections.push(result.value);
      else warnings.push(publicError(result.reason).message);
    });
    return { connected: true, selections, warnings };
  }

  async refreshSelectionsIfStale({
    maxAgeMs = 60_000,
    retryMissingProviders = 1,
    syncUsage = false,
  } = {}) {
    const age = Date.now() - this.lastBootstrapAt;
    const hasEveryProvider = () => {
      const selected = this.status().selected;
      return [...PROVIDERS].every((provider) => selected[provider]);
    };
    if (
      this.lastBootstrapResult
      && age >= 0
      && age < Math.max(0, Number(maxAgeMs) || 0)
      && hasEveryProvider()
    ) {
      // auth.json is runtime material and another Cockpit process may have
      // cleaned the shared path. Recreate it atomically before every new PTY.
      await this.client.materializeCodexAuth();
      return { ...this.lastBootstrapResult, cached: true };
    }

    let result = await this.bootstrap({ syncUsage });
    let retries = Math.max(0, Math.min(Number(retryMissingProviders) || 0, 3));
    while (this.status().connected && !hasEveryProvider() && retries > 0) {
      result = await this.bootstrap({ syncUsage: false });
      retries -= 1;
    }

    // A provider refresh can fail while a previously selected account remains
    // valid in memory. Ensure that selection still has material on disk.
    if (this.status().selected.openai && !result.selections?.some((item) => item.provider === "openai")) {
      await this.client.materializeCodexAuth();
    }
    return result;
  }

  enrichPtyEnv(env, { claudeProjectPath } = {}) {
    const baseUrl = this.brokerUrl();
    const codexRefreshUrl = baseUrl ? `${baseUrl}/team/openai/oauth/token` : undefined;
    const claudeProxyUrl = baseUrl ? `${baseUrl}/team/claude` : undefined;
    return this.client.enrichPtyEnv(env, { codexRefreshUrl, claudeProxyUrl, claudeProjectPath });
  }

  async usageTable() {
    const accounts = await this.accounts();
    const table = { claude: [], codex: [], central: true };
    for (const account of accounts) {
      const platform = account.provider === "openai" ? "codex" : "claude";
      const status = account.status === "available" ? "ok"
        : ["expired", "reauth_required", "auth_expired"].includes(account.status) ? "expired"
          : account.status;
      table[platform].push({
        platform,
        id: account.id,
        email: account.label,
        plan: account.plan,
        active: account.selected,
        status,
        fiveHour: account.usage.five_hour.percent,
        fiveHourReset: account.usage.five_hour.resets_at,
        weekly: account.usage.weekly.percent,
        weeklyReset: account.usage.weekly.resets_at,
      });
    }
    return table;
  }

  handle(req, res, parsedUrl) {
    if (!parsedUrl.pathname?.startsWith("/team/")) return false;
    if (parsedUrl.pathname.startsWith("/team/claude/")) {
      this.proxyClaude(req, res, parsedUrl).catch((error) => {
        const safe = publicError(error);
        if (safe.statusCode >= 500) this.log.warn?.(`[cockpit/team] ${safe.message}`);
        sendJson(res, safe.statusCode, { error: { type: "cockpit_broker_error", message: safe.message } });
      });
      return true;
    }
    this.dispatch(req, parsedUrl)
      .then(({ statusCode = 200, payload }) => sendJson(res, statusCode, payload))
      .catch((error) => {
        const safe = publicError(error);
        if (safe.statusCode >= 500) this.log.warn?.(`[cockpit/team] ${safe.message}`);
        sendJson(res, safe.statusCode, { error: safe.message });
      });
    return true;
  }

  async proxyClaude(req, res, parsedUrl) {
    this.assertLocalRequest(req, { sensitive: true });
    const requestPath = `${parsedUrl.pathname.slice("/team/claude".length)}${parsedUrl.search || ""}`;
    const body = ["GET", "HEAD"].includes(req.method || "GET") ? null : await readRawBody(req);
    const upstream = await this.client.handleClaudeProxyRequest({
      authorization: req.headers.authorization,
      method: req.method,
      requestPath,
      headers: req.headers,
      body,
    });
    const responseHeaders = {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": upstream.headers.get("cache-control") || "no-store",
    };
    for (const [key, value] of upstream.headers.entries()) {
      if (/^(?:content-type|request-id|retry-after|anthropic-ratelimit-[a-z0-9-]+|x-ratelimit-[a-z0-9-]+)$/i.test(key)) {
        responseHeaders[key] = value;
      }
    }
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
  }

  async dispatch(req, parsedUrl) {
    const route = parsedUrl.pathname;
    const method = req.method || "GET";
    this.assertLocalRequest(req, {
      sensitive: route === "/team/openai/oauth/token",
    });

    if (route === "/team/status" && method === "GET") {
      return { payload: this.status() };
    }
    if (route === "/team/openai/oauth/token" && method === "POST") {
      const payload = await this.client.handleOpenAiRefreshRequest(await readBody(req));
      return { payload };
    }

    if (method !== "POST") throw httpError(405, "método não permitido");
    const body = await readBody(req);

    if (route === "/team/connect") {
      if (!body.baseUrl || !body.email || !body.password) {
        throw httpError(422, "URL, e-mail e senha são obrigatórios");
      }
      await this.client.connect({
        baseUrl: body.baseUrl,
        email: body.email,
        password: body.password,
        deviceName: body.deviceName || `Cockpit · ${os.hostname()}`,
      });
      const optimized = await this.bootstrap();
      return { statusCode: 201, payload: { ...this.status(), warnings: optimized.warnings } };
    }

    if (route === "/team/disconnect") {
      await this.client.logout();
      return { payload: this.status() };
    }

    if (route === "/team/optimize") {
      return { payload: await this.bootstrap({ syncUsage: body.syncUsage !== false }) };
    }

    throw httpError(404, "rota não encontrada");
  }
}

export function createTeamRouter(options) {
  return new TeamRouter(options);
}
