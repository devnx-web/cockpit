import { randomUUID } from "node:crypto";
import { loadControlDescriptor } from "./config.js";
import { ControlClient } from "./control-client.js";

function sameConnection(left, right) {
  return (
    left.controlUrl === right.controlUrl &&
    left.controlToken === right.controlToken &&
    left.controlInstanceId === right.controlInstanceId
  );
}

function isUnauthorized(error) {
  return error?.status === 401 || error?.code === "UNAUTHORIZED";
}

function isRetryableReadError(error) {
  return (
    isUnauthorized(error) ||
    error?.code === "CONTROL_UNAVAILABLE" ||
    error?.code === "CONTROL_TIMEOUT" ||
    [502, 503, 504].includes(error?.status)
  );
}

export class ReloadingControlClient {
  constructor(
    config,
    { fetchImpl, ControlClientImpl = ControlClient } = {},
  ) {
    this.config = config;
    this.descriptorPath = config.descriptorPath;
    this.fetchImpl = fetchImpl;
    this.ControlClientImpl = ControlClientImpl;
    this.current = this.#createConnection({
      controlUrl: config.controlUrl,
      controlToken: config.controlToken,
      controlInstanceId: config.controlInstanceId ?? null,
    });
  }

  #createConnection(descriptor) {
    const connection = {
      controlUrl: new URL(descriptor.controlUrl).href,
      controlToken: descriptor.controlToken,
      controlInstanceId: descriptor.controlInstanceId ?? null,
    };
    return {
      ...connection,
      client: new this.ControlClientImpl({
        baseUrl: connection.controlUrl,
        token: connection.controlToken,
        timeoutMs: this.config.timeoutMs,
        maxResponseBytes: this.config.maxControlResponseBytes,
        allowedProjects: this.config.allowedProjects,
        fetchImpl: this.fetchImpl,
      }),
    };
  }

  #refresh() {
    if (!this.descriptorPath) return this.current;
    const descriptor = loadControlDescriptor(this.descriptorPath);
    const candidate = {
      controlUrl: descriptor.controlUrl.href,
      controlToken: descriptor.controlToken,
      controlInstanceId: descriptor.controlInstanceId,
    };
    if (!sameConnection(this.current, candidate)) {
      this.current = this.#createConnection(candidate);
    }
    return this.current;
  }

  async #read(method, args) {
    const attempted = this.#refresh();
    try {
      return await attempted.client[method](...args);
    } catch (error) {
      if (!isRetryableReadError(error) || !this.descriptorPath) throw error;
      const refreshed = this.#refresh();
      if (sameConnection(attempted, refreshed)) throw error;
      return refreshed.client[method](...args);
    }
  }

  async #mutate(method, args) {
    const requestId = randomUUID();
    const attempted = this.#refresh();
    try {
      return await attempted.client[method](...args, { requestId });
    } catch (error) {
      // A 401 is safe to repeat: the control API authenticates before
      // dispatching mutations. Network and 5xx failures remain ambiguous.
      if (!isUnauthorized(error) || !this.descriptorPath) throw error;
      const refreshed = this.#refresh();
      if (sameConnection(attempted, refreshed)) throw error;
      return refreshed.client[method](...args, { requestId });
    }
  }

  health() {
    return this.#read("health", []);
  }

  listProjects() {
    return this.#read("listProjects", []);
  }

  listTerminals(projectId) {
    return this.#read("listTerminals", [projectId]);
  }

  readTerminal(projectId, terminalId, options) {
    return this.#read("readTerminal", [projectId, terminalId, options]);
  }

  findProjects(query, options) {
    return this.#read("findProjects", [query, options]);
  }

  listDemands(options) {
    return this.#read("listDemands", [options]);
  }

  dispatchDemand(projectId, demand) {
    return this.#mutate("dispatchDemand", [projectId, demand]);
  }

  createTerminal(projectId, name) {
    return this.#mutate("createTerminal", [projectId, name]);
  }

  sendInput(projectId, terminalId, data) {
    return this.#mutate("sendInput", [projectId, terminalId, data]);
  }

  interruptTerminal(projectId, terminalId) {
    return this.#mutate("interruptTerminal", [projectId, terminalId]);
  }
}

export function createConfiguredControlClient(config, dependencies = {}) {
  return new ReloadingControlClient(config, dependencies);
}

export const reloadingControlClientInternals = {
  isRetryableReadError,
  isUnauthorized,
  sameConnection,
};
