// Cliente da LifeAi para o Cockpit.
//
// A LifeAi não é mais filha do Cockpit: ela roda como serviço próprio
// (bin/lifeaid.js sob systemd) e publica onde atende num descriptor em
// $XDG_RUNTIME_DIR/lifeai/control.json. O Cockpit apenas lê esse arquivo e
// conversa — nunca sobe, nunca desliga e nunca supervisiona nada.
//
// Se o serviço não estiver de pé, todas as operações falham com
// `service_down`, e o painel mostra isso em vez de tentar consertar sozinho.

import fs from "fs";
import path from "path";

import { defaultRuntimeDir, LIFEAI_SERVICE_NAME } from "./lifeai-service.js";
import { createLifeAiApi } from "./lifeai-api.js";

const HEALTH_TIMEOUT_MS = 2_000;

export class LifeAiUnavailable extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "LifeAiUnavailable";
    this.reason = reason;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Inclui EPERM: o processo existe mas é de outro usuário, então não é o
    // nosso serviço — o descriptor é 0600 e nunca deveria vir de fora.
    return false;
  }
}

export function createLifeAiClient({ env = process.env, log = console } = {}) {
  const runtimeDir = env.LIFEAI_RUNTIME_DIR || defaultRuntimeDir("lifeai");
  const descriptorPath = path.join(runtimeDir, "control.json");
  let cached = null;

  /**
   * Lê o descriptor e devolve um cliente pronto, ou null se o serviço não
   * estiver de pé. O `pid` é conferido porque um descriptor órfão (daemon
   * morto de SIGKILL) aponta para uma porta que pode ter virado de outro
   * processo — falar com ela seria pior do que dizer que está desligado.
   */
  function resolve() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    } catch {
      cached = null;
      return null;
    }
    if (!raw?.apiUrl || !raw?.apiKey || !processAlive(raw.pid)) {
      cached = null;
      return null;
    }
    if (cached?.instanceId !== raw.instanceId || cached?.apiUrl !== raw.apiUrl) {
      cached = {
        instanceId: raw.instanceId,
        apiUrl: raw.apiUrl,
        apiKey: raw.apiKey,
        consoleUrl: raw.consoleUrl || null,
        startedAt: raw.startedAt || null,
        api: createLifeAiApi({ url: raw.apiUrl, key: raw.apiKey }),
      };
    }
    return cached;
  }

  function require_() {
    const found = resolve();
    if (!found) {
      throw new LifeAiUnavailable(
        "service_down",
        `LifeAi não está rodando — ligue com: systemctl --user start ${LIFEAI_SERVICE_NAME}`,
      );
    }
    return found.api;
  }

  /** Estado para o painel. Nunca lança: desligada é uma resposta, não um erro. */
  async function state() {
    const found = resolve();
    if (!found) {
      return {
        running: false,
        reason: "service_down",
        service: LIFEAI_SERVICE_NAME,
        startCommand: `systemctl --user start ${LIFEAI_SERVICE_NAME}`,
      };
    }
    try {
      await found.api.health({ timeoutMs: HEALTH_TIMEOUT_MS });
      return {
        running: true,
        startedAt: found.startedAt,
        service: LIFEAI_SERVICE_NAME,
        consoleUrl: found.consoleUrl,
      };
    } catch (error) {
      // Serviço de pé mas ainda subindo (carrega modelos, conecta MCPs) ou
      // travado: os dois se parecem daqui, e os dois significam "espere".
      log.log?.(`[lifeai] serviço não respondeu: ${error.message}`);
      return {
        running: false,
        reason: "starting",
        service: LIFEAI_SERVICE_NAME,
        startCommand: `systemctl --user status ${LIFEAI_SERVICE_NAME}`,
      };
    }
  }

  async function ask(prompt, options) {
    return require_().ask(prompt, { sessionKey: "cockpit-panel", ...options });
  }

  async function approve(runId, choice) {
    return require_().approve(runId, choice);
  }

  async function stopRun(runId) {
    return require_().stopRun(runId);
  }

  /**
   * Pede ao console um endereço de uso único para abrir no navegador. Quem
   * autoriza é a chave do descriptor (0600): ler o arquivo já é a prova de que
   * o pedido veio do dono da máquina.
   */
  async function consoleTicket() {
    const found = resolve();
    if (!found) {
      throw new LifeAiUnavailable(
        "service_down",
        `LifeAi não está rodando — ligue com: systemctl --user start ${LIFEAI_SERVICE_NAME}`,
      );
    }
    if (!found.consoleUrl) {
      throw new LifeAiUnavailable("console_down", "o console não subiu nesta instância");
    }
    const response = await fetch(`${found.consoleUrl}/_ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${found.apiKey}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`console recusou o ticket (${response.status})`);
    return response.json();
  }

  return { state, ask, approve, stopRun, consoleTicket, descriptorPath };
}
