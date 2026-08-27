import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const TRANSPORTS = new Set(["stdio", "http"]);
const KNOWN_ACTIONS = new Set([
  "create_terminal",
  "send_input",
  "interrupt_terminal",
  // despachar é criar terminal + digitar nele, numa ação só
  "dispatch",
]);

function parseInteger(value, fallback, name, { min, max }) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} deve ser um número inteiro`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} deve estar entre ${min} e ${max}`);
  }
  return parsed;
}

function parseToken(value, name) {
  if (!value) {
    throw new Error(`${name} é obrigatório`);
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(value)) {
    throw new Error(
      `${name} deve ter 32–512 caracteres ASCII visíveis, sem espaços`,
    );
  }
  const weak = new Set([
    "change-me-change-me-change-me-change-me",
    "replace-me-replace-me-replace-me-00",
  ]);
  if (weak.has(value.toLowerCase())) {
    throw new Error(`${name} usa um valor de exemplo inseguro`);
  }
  return value;
}

function parseActions(value = "") {
  const actions = new Set();
  for (const raw of value.split(",")) {
    const action = raw.trim();
    if (!action) continue;
    if (!KNOWN_ACTIONS.has(action)) {
      throw new Error(
        `COCKPIT_MCP_ACTIONS contém ação desconhecida: ${action}`,
      );
    }
    actions.add(action);
  }
  return actions;
}

function parseAllowedProjects(value = "*") {
  if (value.trim() === "*") return null;
  const projects = new Set();
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (!id) continue;
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error(`ID inválido em COCKPIT_MCP_ALLOWED_PROJECTS: ${id}`);
    }
    projects.add(id);
  }
  if (projects.size === 0) {
    throw new Error(
      "COCKPIT_MCP_ALLOWED_PROJECTS deve ser * ou uma lista não vazia",
    );
  }
  return projects;
}

export function parseControlUrl(
  value = "http://127.0.0.1:3737/internal/control/v1",
) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("COCKPIT_CONTROL_URL não é uma URL válida");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname.replace(/\/+$/, "") !== "/internal/control/v1" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "COCKPIT_CONTROL_URL deve ser http://127.0.0.1:<porta>/internal/control/v1",
    );
  }
  if (!parsed.port) {
    throw new Error("COCKPIT_CONTROL_URL deve declarar a porta do Cockpit");
  }
  parsed.pathname = "/internal/control/v1/";
  return parsed;
}

function descriptorCandidates(env) {
  if (env.COCKPIT_CONTROL_DESCRIPTOR) {
    return [path.resolve(env.COCKPIT_CONTROL_DESCRIPTOR)];
  }
  const candidates = [];
  if (env.XDG_RUNTIME_DIR) {
    candidates.push(
      path.join(env.XDG_RUNTIME_DIR, "cockpit", "control.json"),
    );
  }
  const home = env.HOME || os.homedir();
  if (home) {
    candidates.push(path.join(home, ".local", "state", "cockpit", "control.json"));
    candidates.push(path.join(home, ".config", "cockpit", "control.json"));
  }
  return [...new Set(candidates)];
}

function readDescriptorFile(descriptorPath) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(descriptorPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("descriptor não é um arquivo regular");
    }
    if (stat.size <= 0 || stat.size > 16 * 1024) {
      throw new Error("descriptor deve ter entre 1 e 16384 bytes");
    }
    if (typeof process.getuid === "function") {
      if (stat.uid !== process.getuid()) {
        throw new Error("descriptor pertence a outro usuário");
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error("descriptor deve usar permissão 0600");
      }
    }
    const raw = fs.readFileSync(fd, "utf8");
    const descriptor = JSON.parse(raw);
    if (
      descriptor?.schemaVersion !== 1 ||
      typeof descriptor.controlUrl !== "string" ||
      typeof descriptor.token !== "string"
    ) {
      throw new Error(
        "descriptor requer schemaVersion=1, controlUrl e token",
      );
    }
    if (descriptor.expiresAt !== undefined) {
      if (typeof descriptor.expiresAt !== "string") {
        throw new Error("expiresAt inválido no descriptor");
      }
      const expiresAt = Date.parse(descriptor.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        throw new Error("expiresAt inválido no descriptor");
      }
      if (expiresAt <= Date.now()) {
        throw new Error("descriptor de controle expirou");
      }
    }
    return descriptor;
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("descriptor não pode ser link simbólico");
    }
    if (error instanceof SyntaxError) {
      throw new Error("descriptor contém JSON inválido");
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseInstanceId(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)
  ) {
    throw new Error("instanceId inválido no descriptor");
  }
  return value;
}

export function loadControlDescriptor(descriptorPath) {
  const descriptor = readDescriptorFile(descriptorPath);
  return {
    controlUrl: parseControlUrl(descriptor.controlUrl),
    controlToken: parseToken(descriptor.token, "token do control.json"),
    controlInstanceId: parseInstanceId(descriptor.instanceId),
    descriptorPath,
  };
}

export function discoverControl(env = process.env) {
  const hasUrl = Boolean(env.COCKPIT_CONTROL_URL);
  const hasToken = Boolean(env.COCKPIT_CONTROL_TOKEN);
  if (hasUrl || hasToken) {
    if (!hasUrl || !hasToken) {
      throw new Error(
        "COCKPIT_CONTROL_URL e COCKPIT_CONTROL_TOKEN devem ser definidos juntos",
      );
    }
    return {
      controlUrl: parseControlUrl(env.COCKPIT_CONTROL_URL),
      controlToken: parseToken(
        env.COCKPIT_CONTROL_TOKEN,
        "COCKPIT_CONTROL_TOKEN",
      ),
      controlInstanceId: null,
      descriptorPath: null,
    };
  }

  const candidates = descriptorCandidates(env);
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) {
    throw new Error(
      "control.json não encontrado; defina COCKPIT_CONTROL_DESCRIPTOR ou o par COCKPIT_CONTROL_URL/COCKPIT_CONTROL_TOKEN",
    );
  }
  return loadControlDescriptor(selected);
}

export function loadConfig(
  env = process.env,
  { transport = env.COCKPIT_MCP_TRANSPORT || "stdio" } = {},
) {
  if (!TRANSPORTS.has(transport)) {
    throw new Error("transporte deve ser stdio ou http");
  }
  const host = env.COCKPIT_MCP_HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      "COCKPIT_MCP_HOST deve ser loopback (127.0.0.1 ou ::1); exposição pública é recusada",
    );
  }
  const control = discoverControl(env);

  return Object.freeze({
    transport,
    host,
    port: parseInteger(env.COCKPIT_MCP_PORT, 3740, "COCKPIT_MCP_PORT", {
      min: 1,
      max: 65535,
    }),
    token:
      transport === "http"
        ? parseToken(env.COCKPIT_MCP_TOKEN, "COCKPIT_MCP_TOKEN")
        : null,
    ...control,
    timeoutMs: parseInteger(
      env.COCKPIT_MCP_TIMEOUT_MS,
      5000,
      "COCKPIT_MCP_TIMEOUT_MS",
      { min: 250, max: 30000 },
    ),
    maxOutputBytes: parseInteger(
      env.COCKPIT_MCP_MAX_OUTPUT_BYTES,
      65536,
      "COCKPIT_MCP_MAX_OUTPUT_BYTES",
      { min: 1024, max: 1048576 },
    ),
    maxWaitMs: parseInteger(
      env.COCKPIT_MCP_MAX_WAIT_MS,
      20000,
      "COCKPIT_MCP_MAX_WAIT_MS",
      { min: 1000, max: 30000 },
    ),
    maxControlResponseBytes: parseInteger(
      env.COCKPIT_MCP_MAX_CONTROL_RESPONSE_BYTES,
      1048576,
      "COCKPIT_MCP_MAX_CONTROL_RESPONSE_BYTES",
      { min: 16384, max: 4194304 },
    ),
    maxSessions: parseInteger(
      env.COCKPIT_MCP_MAX_SESSIONS,
      32,
      "COCKPIT_MCP_MAX_SESSIONS",
      { min: 1, max: 256 },
    ),
    actions: parseActions(env.COCKPIT_MCP_ACTIONS),
    allowedProjects: parseAllowedProjects(
      env.COCKPIT_MCP_ALLOWED_PROJECTS,
    ),
  });
}

export const configInternals = {
  descriptorCandidates,
  KNOWN_ACTIONS,
  LOOPBACK_HOSTS,
  parseInstanceId,
  readDescriptorFile,
  TRANSPORTS,
};
