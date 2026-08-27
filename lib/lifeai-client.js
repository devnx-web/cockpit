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

import { defaultRuntimeDir, LIFEAI_SERVICE_NAME, lifeaiConsoleUrl } from "./lifeai-service.js";
import { createLifeAiApi } from "./lifeai-api.js";

const HEALTH_TIMEOUT_MS = 2_000;
const CONSOLE_TIMEOUT_MS = 1_500;

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
  const consoleBase = lifeaiConsoleUrl(env);
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
        // O console é outro processo: continua valendo oferecer o botão mesmo
        // com o serviço parado — quem diz o que houve é o próprio console.
        consoleUrl: consoleBase,
      };
    }
    try {
      await found.api.health({ timeoutMs: HEALTH_TIMEOUT_MS });
      return {
        running: true,
        startedAt: found.startedAt,
        service: LIFEAI_SERVICE_NAME,
        consoleUrl: consoleBase,
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
        consoleUrl: consoleBase,
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
   * Endereço do console, conferido antes de abrir. O console é um projeto à
   * parte (lifeai-console) com sessão própria: o Cockpit não emite mais ticket
   * nem serve arquivo — só checa que há alguém atendendo, porque uma janela com
   * ERR_CONNECTION_REFUSED não diz ao usuário o que fazer e uma frase diz.
   *
   * Qualquer resposta HTTP conta como "de pé", inclusive 401: pedir login é o
   * console funcionando, não o console fora do ar.
   */
  async function consoleUrl() {
    try {
      await fetch(consoleBase, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
      });
    } catch (error) {
      log.log?.(`[lifeai] console não respondeu em ${consoleBase}: ${error.message}`);
      throw new LifeAiUnavailable(
        "console_down",
        `o console não está no ar em ${consoleBase} — suba o lifeai-console (npm start) `
        + "ou aponte LIFEAI_CONSOLE_URL para onde ele atende",
      );
    }
    return { url: consoleBase };
  }

  return { state, ask, approve, stopRun, consoleUrl, descriptorPath };
}
