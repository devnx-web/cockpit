import { randomUUID } from "node:crypto";

export class ControlApiError extends Error {
  constructor(message, code = "CONTROL_API_ERROR", status = null) {
    super(message);
    this.name = "ControlApiError";
    this.code = code;
    this.status = status;
  }
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function assertProjectAllowed(allowedProjects, projectId) {
  if (allowedProjects && !allowedProjects.has(projectId)) {
    throw new ControlApiError(
      `projeto fora do escopo permitido: ${projectId}`,
      "PROJECT_FORBIDDEN",
      403,
    );
  }
}

function safeApiMessage(body, fallback) {
  const candidate = body?.error?.message;
  if (typeof candidate !== "string" || !candidate.trim()) return fallback;
  return candidate
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(token|password|authorization|credential)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ControlApiError(
          "resposta da API de controle excede o limite",
          "CONTROL_RESPONSE_TOO_LARGE",
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function sanitizeProject(project) {
  return {
    id: String(project?.id || ""),
    name: String(project?.name || ""),
    color: typeof project?.color === "string" ? project.color : null,
  };
}

function clampString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function sanitizeProjectCandidate(candidate) {
  return {
    id: String(candidate?.id || ""),
    name: clampString(candidate?.name, 120),
    color: typeof candidate?.color === "string" ? candidate.color : null,
    description: clampString(candidate?.description, 400),
    aliases: Array.isArray(candidate?.aliases)
      ? candidate.aliases.slice(0, 12).map((alias) => clampString(alias, 40))
      : [],
    stack: Array.isArray(candidate?.stack)
      ? candidate.stack.slice(0, 12).map((item) => clampString(item, 40))
      : [],
    defaultAgent: clampString(candidate?.defaultAgent, 80),
    hasDescription: candidate?.hasDescription === true,
    score: Number(candidate?.score) || 0,
    matchedOn: Array.isArray(candidate?.matchedOn)
      ? candidate.matchedOn.slice(0, 8).map((item) => clampString(item, 24))
      : [],
    busyTerminals: Number(candidate?.busyTerminals) || 0,
    freeTerminals: Number(candidate?.freeTerminals) || 0,
    activeDemands: Number(candidate?.activeDemands) || 0,
  };
}

function sanitizeDemand(demand) {
  return {
    id: String(demand?.id || ""),
    title: clampString(demand?.title, 120),
    projectId: String(demand?.projectId || ""),
    projectName: clampString(demand?.projectName, 120),
    terminalId: demand?.terminalId ? String(demand.terminalId) : null,
    terminalName: clampString(demand?.terminalName, 120),
    agentLabel: clampString(demand?.agentLabel, 80),
    status: clampString(demand?.status, 32) || "unknown",
    statusText: clampString(demand?.statusText, 240),
    stage: clampString(demand?.stage, 32),
    error: demand?.error ? clampString(demand.error, 120) : null,
    createdAt: Number(demand?.createdAt) || 0,
    lastChangeAt: Number(demand?.lastChangeAt) || 0,
    endedAt: Number(demand?.endedAt) || null,
  };
}

function sanitizeTerminal(terminal) {
  return {
    id: String(terminal?.id || ""),
    name: String(terminal?.name || ""),
    status: String(terminal?.status || "unknown"),
    statusText:
      typeof terminal?.statusText === "string" ? terminal.statusText : "",
    exited: terminal?.exited === true,
    exitCode: Number.isInteger(terminal?.exitCode)
      ? terminal.exitCode
      : null,
  };
}

function sanitizeAck(ack) {
  return {
    accepted: ack?.accepted === true,
    completed: ack?.completed === true,
    at: typeof ack?.at === "string" ? ack.at : null,
  };
}

function safeVersion(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._+-]{1,64}$/.test(value)
    ? value
    : null;
}

function sanitizeEvents(events, maxBytes) {
  let totalBytes = 0;
  return events.map((event) => {
    if (
      typeof event?.cursor !== "string" ||
      event.cursor.length > 512 ||
      !["stdout", "stderr", "system"].includes(event?.stream) ||
      typeof event?.data !== "string"
    ) {
      throw new ControlApiError(
        "evento de terminal inválido",
        "CONTROL_INVALID_RESPONSE",
      );
    }
    totalBytes += Buffer.byteLength(event.data, "utf8");
    if (totalBytes > maxBytes) {
      throw new ControlApiError(
        "output retornado excede max_bytes",
        "CONTROL_OUTPUT_TOO_LARGE",
      );
    }
    return {
      cursor: event.cursor,
      stream: event.stream,
      data: event.data,
      ts: typeof event.ts === "string" ? event.ts : null,
    };
  });
}

export class ControlClient {
  constructor({
    baseUrl,
    token,
    timeoutMs = 5000,
    maxResponseBytes = 1048576,
    allowedProjects = null,
    fetchImpl = fetch,
  }) {
    this.baseUrl = new URL(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.allowedProjects = allowedProjects;
    this.fetchImpl = fetchImpl;
  }

  async #request(
    relativePath,
    {
      method = "GET",
      body,
      requestId,
      timeoutMs = this.timeoutMs,
      query,
    } = {},
  ) {
    const url = new URL(relativePath.replace(/^\/+/, ""), this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "X-Cockpit-Control-Version": "1",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(requestId ? { "Idempotency-Key": requestId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      const timeout = error?.name === "AbortError";
      throw new ControlApiError(
        timeout
          ? `API de controle não respondeu em ${timeoutMs}ms`
          : `API de controle indisponível: ${error.message}`,
        timeout ? "CONTROL_TIMEOUT" : "CONTROL_UNAVAILABLE",
      );
    } finally {
      clearTimeout(timer);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxResponseBytes
    ) {
      await response.body?.cancel().catch(() => {});
      throw new ControlApiError(
        "resposta da API de controle excede o limite",
        "CONTROL_RESPONSE_TOO_LARGE",
        response.status,
      );
    }

    const bytes = await readLimitedBody(response, this.maxResponseBytes);
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ControlApiError(
        "API de controle retornou JSON inválido",
        "CONTROL_INVALID_JSON",
        response.status,
      );
    }

    if (!response.ok || payload?.ok !== true) {
      throw new ControlApiError(
        safeApiMessage(payload, `API de controle retornou HTTP ${response.status}`),
        payload?.error?.code || "CONTROL_REQUEST_FAILED",
        response.status,
      );
    }
    return payload;
  }

  async health() {
    const response = await this.#request("health");
    return {
      ok: true,
      data: {
        version: safeVersion(response.data?.version),
        cockpitVersion: safeVersion(response.data?.cockpitVersion),
      },
    };
  }

  async listProjects() {
    const response = await this.#request("projects");
    const projects = response.data?.projects;
    if (!Array.isArray(projects)) {
      throw new ControlApiError(
        "resposta de projects não contém data.projects",
        "CONTROL_INVALID_RESPONSE",
      );
    }
    const safeProjects = projects.map(sanitizeProject);
    return {
      cursor: response.cursor ?? null,
      projects: this.allowedProjects
        ? safeProjects.filter((project) =>
            this.allowedProjects.has(project.id),
          )
        : safeProjects,
    };
  }

  async listTerminals(projectId) {
    assertProjectAllowed(this.allowedProjects, projectId);
    const response = await this.#request(
      `projects/${encodeSegment(projectId)}/terminals`,
    );
    if (!Array.isArray(response.data?.terminals)) {
      throw new ControlApiError(
        "resposta de terminals não contém data.terminals",
        "CONTROL_INVALID_RESPONSE",
      );
    }
    return {
      cursor: response.cursor ?? null,
      projectId,
      terminals: response.data.terminals.map(sanitizeTerminal),
    };
  }

  async readTerminal(
    projectId,
    terminalId,
    { afterCursor, maxBytes, waitMs = 0 } = {},
  ) {
    assertProjectAllowed(this.allowedProjects, projectId);
    const response = await this.#request(
      `projects/${encodeSegment(projectId)}/terminals/${encodeSegment(
        terminalId,
      )}/output`,
      {
        query: {
          after: afterCursor,
          max_bytes: maxBytes,
          wait_ms: waitMs,
        },
        timeoutMs: this.timeoutMs + waitMs,
      },
    );
    if (!Array.isArray(response.data?.events)) {
      throw new ControlApiError(
        "resposta de output não contém data.events",
        "CONTROL_INVALID_RESPONSE",
      );
    }
    const safeEvents = sanitizeEvents(
      response.data.events,
      maxBytes ?? this.maxResponseBytes,
    );
    return {
      projectId,
      terminalId,
      cursor: response.cursor ?? afterCursor ?? null,
      status:
        typeof response.data.status === "string"
          ? response.data.status.slice(0, 64)
          : null,
      statusText:
        typeof response.data.statusText === "string"
          ? response.data.statusText.slice(0, 240)
          : "",
      exited: response.data.exited === true,
      events: safeEvents,
      timedOut: response.data.timedOut === true,
    };
  }

  async findProjects(query, { limit } = {}) {
    const response = await this.#request("projects/search", {
      query: { q: query, limit },
    });
    const candidates = response.data?.candidates;
    if (!Array.isArray(candidates)) {
      throw new ControlApiError(
        "resposta de search não contém data.candidates",
        "CONTROL_INVALID_RESPONSE",
      );
    }
    const safeCandidates = candidates.map(sanitizeProjectCandidate);
    return {
      query: clampString(response.data?.query, 200),
      // o filtro local repete o do servidor: escopo do MCP pode ser menor
      candidates: this.allowedProjects
        ? safeCandidates.filter((candidate) => this.allowedProjects.has(candidate.id))
        : safeCandidates,
      ambiguous: response.data?.ambiguous !== false,
    };
  }

  async listDemands({ afterCursor, waitMs = 0 } = {}) {
    const response = await this.#request("demands", {
      query: { after: afterCursor, wait_ms: waitMs },
      // o long-poll é do servidor: o timeout local precisa cobrir a espera
      timeoutMs: this.timeoutMs + waitMs,
    });
    const demands = response.data?.demands;
    if (!Array.isArray(demands)) {
      throw new ControlApiError(
        "resposta de demands não contém data.demands",
        "CONTROL_INVALID_RESPONSE",
      );
    }
    const safeDemands = demands.map(sanitizeDemand);
    return {
      cursor: response.cursor ?? afterCursor ?? null,
      revision: Number(response.data?.revision) || 0,
      timedOut: response.data?.timedOut === true,
      demands: this.allowedProjects
        ? safeDemands.filter((demand) => this.allowedProjects.has(demand.projectId))
        : safeDemands,
    };
  }

  async #action(relativePath, actionData, { requestId = randomUUID() } = {}) {
    const response = await this.#request(relativePath, {
      method: "POST",
      requestId,
      body: {
        requestId,
        confirm: true,
        ...actionData,
      },
    });
    if (
      response.requestId !== requestId ||
      response.ack?.accepted !== true
    ) {
      throw new ControlApiError(
        "ação sem requestId/ACK correspondente",
        "CONTROL_INVALID_ACK",
      );
    }
    return {
      requestId,
      ack: sanitizeAck(response.ack),
      data: response.data ?? null,
      cursor: response.cursor ?? null,
    };
  }

  async createTerminal(projectId, name, options) {
    assertProjectAllowed(this.allowedProjects, projectId);
    const result = await this.#action(
      `projects/${encodeSegment(projectId)}/terminals`,
      { name },
      options,
    );
    return {
      requestId: result.requestId,
      ack: result.ack,
      cursor: result.cursor,
      data: result.data?.terminal
        ? { terminal: sanitizeTerminal(result.data.terminal) }
        : null,
    };
  }

  async dispatchDemand(projectId, { text, title, agent } = {}, options) {
    assertProjectAllowed(this.allowedProjects, projectId);
    const result = await this.#action(
      `projects/${encodeSegment(projectId)}/dispatch`,
      {
        text,
        ...(title ? { title } : {}),
        ...(agent ? { agent } : {}),
      },
      options,
    );
    return {
      requestId: result.requestId,
      ack: result.ack,
      cursor: result.cursor,
      data: result.data?.demand
        ? { demand: sanitizeDemand(result.data.demand) }
        : null,
    };
  }

  async sendInput(projectId, terminalId, data, options) {
    assertProjectAllowed(this.allowedProjects, projectId);
    const result = await this.#action(
      `projects/${encodeSegment(projectId)}/terminals/${encodeSegment(
        terminalId,
      )}/input`,
      { data },
      options,
    );
    return {
      requestId: result.requestId,
      ack: result.ack,
      cursor: result.cursor,
    };
  }

  async interruptTerminal(projectId, terminalId, options) {
    assertProjectAllowed(this.allowedProjects, projectId);
    const result = await this.#action(
      `projects/${encodeSegment(projectId)}/terminals/${encodeSegment(
        terminalId,
      )}/interrupt`,
      { kind: "interrupt" },
      options,
    );
    return {
      requestId: result.requestId,
      ack: result.ack,
      cursor: result.cursor,
    };
  }
}

export const controlClientInternals = {
  assertProjectAllowed,
  readLimitedBody,
  safeApiMessage,
  sanitizeAck,
  sanitizeDemand,
  sanitizeEvents,
  sanitizeProject,
  sanitizeProjectCandidate,
  sanitizeTerminal,
  safeVersion,
};
