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
  sanitizeEvents,
  sanitizeProject,
  sanitizeTerminal,
  safeVersion,
};
