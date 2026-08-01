/**
 * Envio dos agregados horários para o DevNX Control.
 *
 * A fila é a própria tabela `hourly`: pendente é todo bucket cujo `synced_hash`
 * difere do `payload_hash`. Isso se auto-coalesce — uma hora recomputada quarenta
 * vezes durante o backfill vira UM envio, não quarenta — e distingue "nunca
 * enviado" de "enviado e depois corrigido", coisa que um `synced_at IS NULL` não faz.
 *
 * Roda dentro do worker porque marcar `synced_hash` é escrita, e o worker é o
 * único escritor do banco.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { NO_PROJECT } from "./db.js";

const HORA_MS = 3600_000;
const LOTE = 500;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** Versão do contrato. Precisa bater com AiUsageController::SCHEMA_VERSION no Laravel. */
export const SYNC_SCHEMA_VERSION = 1;

const CAMINHO_API = "/api/cockpit-ai/usage/hourly";

function lerJson(arquivo) {
  try {
    const valor = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    return valor && typeof valor === "object" && !Array.isArray(valor) ? valor : null;
  } catch {
    return null;
  }
}

/** Escrita atômica com permissão restrita, no mesmo molde de `lib/team-accounts.js`. */
function escreverJson(arquivo, valor) {
  const dir = path.dirname(arquivo);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(arquivo)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(valor, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, arquivo);
}

/** Junta base e rota aceitando tanto `https://control.exemplo` quanto `.../api`. */
export function montarUrl(baseUrl, apiPath) {
  const base = new URL(baseUrl);
  const raiz = base.pathname.replace(/\/+$/, "");
  const sufixo = raiz.endsWith("/api") && apiPath.startsWith("/api/") ? apiPath.slice(4) : apiPath;
  base.pathname = `${raiz}${sufixo}`.replace(/\/{2,}/g, "/");
  return base.toString();
}

export class UsageSync {
  #db;
  #fetch;
  #configPath;
  #devicePath;
  #appVersion;
  #enviarCaminhos;
  #lote;
  #timeoutMs;
  #log;
  #device = null;

  /**
   * @param {object} options
   * @param {import('./db.js').UsageDb} options.db banco aberto para escrita
   * @param {Function} [options.fetchImpl] injetável nos testes
   * @param {boolean} [options.sendProjectPaths] envia o caminho absoluto do projeto;
   *   desligado por padrão — nome de pasta de cliente não precisa sair da máquina
   */
  constructor({
    db,
    homeDir = os.homedir(),
    fetchImpl = globalThis.fetch,
    configPath = path.join(homeDir, ".cockpit", "team-auth.json"),
    devicePath = path.join(homeDir, ".cockpit", "device.json"),
    appVersion = "cockpit",
    sendProjectPaths = false,
    batchSize = LOTE,
    timeoutMs = 30_000,
    log = console,
  } = {}) {
    this.#db = db;
    this.#fetch = fetchImpl;
    this.#configPath = configPath;
    this.#devicePath = devicePath;
    this.#appVersion = appVersion;
    this.#enviarCaminhos = Boolean(sendProjectPaths);
    this.#lote = Math.max(1, Math.min(Number(batchSize) || LOTE, LOTE));
    this.#timeoutMs = timeoutMs;
    this.#log = log;
  }

  /**
   * Identidade da máquina. UUID sorteado uma vez e guardado fora do `usage.db`,
   * para sobreviver a um wipe do banco. Não deriva de MAC nem de hostname: os dois
   * mudam com dock/VPN e fragmentariam o histórico da mesma estação.
   */
  device() {
    if (this.#device) return this.#device;
    const guardado = lerJson(this.#devicePath);
    if (guardado?.device_uid && typeof guardado.device_uid === "string") {
      this.#device = {
        device_uid: guardado.device_uid,
        device_name: guardado.device_name || os.hostname(),
      };
      return this.#device;
    }
    this.#device = { device_uid: crypto.randomUUID(), device_name: os.hostname() };
    try {
      escreverJson(this.#devicePath, this.#device);
    } catch (error) {
      // Sem persistir, cada reinício viraria um dispositivo novo no painel — mas
      // ainda é melhor reportar do que abortar a coleta por causa disso.
      this.#log?.warn?.(`[usage] não foi possível gravar ${this.#devicePath}: ${error?.message ?? error}`);
    }
    return this.#device;
  }

  /** Credenciais do pareamento com o Control, relidas a cada tentativa. */
  #credenciais() {
    const stored = lerJson(this.#configPath);
    if (!stored?.baseUrl || !stored?.deviceToken) return null;
    try {
      return { baseUrl: new URL(stored.baseUrl).toString(), token: String(stored.deviceToken).trim() };
    } catch {
      return null;
    }
  }

  /**
   * Uma tentativa de envio.
   *
   * @param {{projectNames?: Map<string, {name: string, path?: string}>}} contexto
   * @returns {Promise<{status: string, sent?: number, unchanged?: number, rejected?: number}>}
   */
  async runOnce({ projectNames = new Map(), force = false } = {}) {
    const estado = this.#db.getSyncState() ?? {};
    const agora = Date.now();
    if (!force && estado.next_attempt_at && agora < estado.next_attempt_at) {
      return { status: "backoff", retryInMs: estado.next_attempt_at - agora };
    }

    const credenciais = this.#credenciais();
    if (!credenciais) return { status: "not_connected" };

    const pendentes = this.#db.pendingBuckets(this.#lote);
    if (!pendentes.length) return { status: "idle" };

    const corpo = this.#montarCorpo(pendentes, projectNames);
    this.#db.setSyncState({ ...estado, last_attempt_at: agora });

    let resposta;
    try {
      resposta = await this.#enviar(credenciais, corpo);
    } catch (error) {
      return this.#falhar(estado, String(error?.message ?? error));
    }

    if (resposta.status === 409) {
      // Contrato incompatível: repetir não resolve. Espera o máximo e deixa o
      // erro visível para que alguém atualize o Cockpit ou o backend.
      this.#db.setSyncState({
        ...estado,
        last_attempt_at: agora,
        consecutive_failures: (estado.consecutive_failures ?? 0) + 1,
        next_attempt_at: agora + BACKOFF_MAX_MS,
        last_error: "schema incompatível com o DevNX Control",
      });
      return { status: "schema_mismatch" };
    }

    if (!resposta.ok) {
      return this.#falhar(estado, `HTTP ${resposta.status}`);
    }

    const resultados = Array.isArray(resposta.payload?.results) ? resposta.payload.results : [];
    let enviados = 0;
    let iguais = 0;
    let rejeitados = 0;

    this.#db.transaction(() => {
      pendentes.forEach((bucket, indice) => {
        const situacao = resultados[indice]?.status;
        if (situacao === "upserted" || situacao === "unchanged") {
          this.#db.markSynced(this.#chave(bucket), bucket.payload_hash);
          if (situacao === "unchanged") iguais += 1;
          else enviados += 1;
          return;
        }
        // Inclui `rejected` e a ausência de resposta para o índice: conta falha
        // para que a quarentena por `fail_count` tire o bucket da fila e ele não
        // trave tudo o que vem depois.
        this.#db.markBucketFailed(this.#chave(bucket));
        rejeitados += 1;
      });
    });

    this.#db.setSyncState({
      last_attempt_at: agora,
      last_success_at: agora,
      consecutive_failures: 0,
      next_attempt_at: 0,
      last_error: rejeitados ? `${rejeitados} bucket(s) recusado(s)` : null,
    });

    return { status: "sent", sent: enviados, unchanged: iguais, rejected: rejeitados, remaining: this.#db.pendingCount() };
  }

  #chave(bucket) {
    return {
      hour_utc: bucket.hour_utc,
      project_id: bucket.project_id,
      provider: bucket.provider,
      model: bucket.model,
    };
  }

  #montarCorpo(buckets, projectNames) {
    const device = this.device();
    return {
      schema_version: SYNC_SCHEMA_VERSION,
      device_uid: device.device_uid,
      device_name: device.device_name,
      platform: process.platform,
      app_version: this.#appVersion,
      buckets: buckets.map((bucket) => {
        const projeto = projectNames.get(bucket.project_id);
        return {
          hour_utc: new Date(bucket.hour_utc * HORA_MS).toISOString(),
          project_key: bucket.project_id,
          project_name: projeto?.name
            ?? (bucket.project_id === NO_PROJECT ? "Sem projeto" : bucket.project_id),
          ...(this.#enviarCaminhos && projeto?.path ? { project_path: projeto.path } : {}),
          provider: bucket.provider,
          model: bucket.model,
          requests: bucket.requests,
          input_tokens: bucket.input_tokens,
          cache_read_tokens: bucket.cache_read_tokens,
          cache_write_5m_tokens: bucket.cache_write_5m_tokens,
          cache_write_1h_tokens: bucket.cache_write_1h_tokens,
          output_tokens: bucket.output_tokens,
          reasoning_tokens: bucket.reasoning_tokens,
          cost_usd: bucket.cost_usd,
          unpriced_requests: bucket.unpriced_requests,
          price_source: "litellm",
          payload_hash: bucket.payload_hash,
        };
      }),
    };
  }

  async #enviar({ baseUrl, token }, corpo) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      const resposta = await this.#fetch(montarUrl(baseUrl, CAMINHO_API), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(corpo),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      let payload = null;
      try {
        payload = await resposta.json();
      } catch { /* corpo vazio ou não-JSON: o status já decide */ }
      return { ok: resposta.ok, status: resposta.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Backoff exponencial com jitter, persistido para sobreviver a um restart. */
  #falhar(estado, mensagem) {
    const falhas = (estado.consecutive_failures ?? 0) + 1;
    const espera = Math.min(BACKOFF_BASE_MS * 2 ** (falhas - 1), BACKOFF_MAX_MS);
    // Jitter de ±20%: três estações que perderam a rede juntas não voltam no mesmo instante.
    const jitter = espera * (Math.random() * 0.4 - 0.2);
    const proxima = Date.now() + Math.max(1000, Math.round(espera + jitter));
    this.#db.setSyncState({
      ...estado,
      last_attempt_at: Date.now(),
      consecutive_failures: falhas,
      next_attempt_at: proxima,
      last_error: mensagem.slice(0, 240),
    });
    return { status: "failed", failures: falhas, retryInMs: proxima - Date.now(), error: mensagem };
  }
}
