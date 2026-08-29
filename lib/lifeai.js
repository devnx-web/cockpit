// LifeAi — supervisor do agente auxiliar da Ailiv.
//
// A LifeAi é um serviço próprio (bin/lifeaid.js, systemd user unit), não um
// filho da janela do Cockpit: ela precisa continuar de pé para responder no
// Telegram com o Cockpit fechado. Este módulo é o motor desse serviço — ele
// spawna o núcleo, o mantém vivo e publica um descriptor em $XDG_RUNTIME_DIR
// para quem quiser conversar com ela.
//
// A credencial da Anthropic vem de um `claudeAccess` injetado pelo daemon, que
// é dono do broker do time. Nada disso é persistido: a chave e a porta do API
// server nascem a cada subida e vivem em memória.
//
// A sessão da assinatura se mantém viva por um heartbeat: a cada 30 minutos o
// supervisor revalida a seleção de conta no DevNX Control (é a seleção corrente
// que o proxy usa em cada requisição) e empurra o vencimento do lease. O
// segredo no env do filho não muda — ele o leu uma vez, ao nascer, e não tem
// como reler.

import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import { removeControlDescriptor, writeControlDescriptor } from "./control-api.js";
import { createLifeAiApi } from "./lifeai-api.js";
import { defaultRuntimeDir, LIFEAI_DESCRIPTOR_VERSION } from "./lifeai-service.js";

const DEFAULT_ROOT = path.join(os.homedir(), "lifeai");
const HEARTBEAT_MS = 30 * 60 * 1000;
// Folga sobre o heartbeat: um tick perdido (máquina suspensa, Control fora do
// ar) não pode matar a sessão antes da próxima tentativa.
const LEASE_TTL_MS = 2 * HEARTBEAT_MS;
const RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 5 * 60_000;
// Piso quando o filho caiu sem nunca ter atendido: precisa ser maior que o boot
// (~25s carregando SQLite, MCPs, kanban), senão a tentativa seguinte nasce em
// cima de um irmão que ainda está subindo e o `--replace` degola os dois.
const COLD_RESTART_DELAY_MS = 45_000;
// Depois desta quantidade de quedas sem readiness, para de martelar e passa a
// tentar no intervalo máximo. Não desiste: 1762 reinícios numa noite não
// consertaram nada e ainda esconderam a causa no meio do próprio ruído.
const MAX_COLD_RESTARTS = 5;
// Desligar leva mais que os 5s de antes: o gateway fecha bancos ao sair. Quem
// leva SIGKILL não roda caminho de saída e deixa o lock órfão — que é
// justamente o que o `--replace` da subida seguinte vai tentar resolver.
const STOP_GRACE_MS = 30_000;
// O núcleo demora alguns segundos para abrir o API server (carrega modelos,
// conecta MCPs). Quem pergunta cedo demais espera aqui em vez de levar erro.
const API_READY_TIMEOUT_MS = 90_000;
// O heartbeat não pode desistir na primeira negativa de rede: o lease vale uma
// hora e o tick só volta em trinta minutos, então dois erros seguidos matam a
// sessão sem ninguém ter tentado de novo. As esperas (1min, 2min) cabem com
// folga dentro da janela do heartbeat.
const HEARTBEAT_TRIES = 3;
const HEARTBEAT_RETRY_DELAY_MS = 60_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function resolveRoot(env = process.env) {
  return env.LIFEAI_ROOT || DEFAULT_ROOT;
}

/**
 * @param {object} deps
 * @param {{issue:Function, renew:Function, revoke:Function, connected:Function}} deps.claudeAccess
 *   Fonte da credencial da assinatura. `issue()` devolve `{baseUrl, capability}`
 *   ou null; `renew(capability)` devolve false quando o lease morreu.
 * @param {Console} [deps.log]
 */
export function createLifeAi({
  claudeAccess,
  log = console,
  env = process.env,
  heartbeatRetryDelayMs = HEARTBEAT_RETRY_DELAY_MS,
} = {}) {
  if (!claudeAccess) throw new TypeError("claudeAccess é obrigatório");
  const root = resolveRoot(env);
  const bin = path.join(root, "bin", "lifeai");
  const home = env.LIFEAI_HOME || path.join(os.homedir(), ".lifeai");
  const runtimeDir = env.LIFEAI_RUNTIME_DIR || defaultRuntimeDir("lifeai");
  const instanceId = crypto.randomUUID();

  const cockpitMcp = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..", "integrations", "cockpit-mcp", "src", "index.js",
  );

  // Semeia config e persona na primeira subida e nunca sobrescreve: ajuste
  // manual do usuário tem que sobreviver a um restart do serviço.
  function seedHome() {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    for (const [origem, destino] of [
      [path.join(root, "ailiv", "config.template.yaml"), path.join(home, "config.yaml")],
      [path.join(root, "ailiv", "SOUL.md"), path.join(home, "SOUL.md")],
    ]) {
      if (fs.existsSync(destino) || !fs.existsSync(origem)) continue;
      fs.copyFileSync(origem, destino);
      fs.chmodSync(destino, 0o600);
      log.log(`[lifeai] ${path.basename(destino)} criado em ${home}`);
    }
  }

  let proc = null;
  // Chave e porta do API server local: nascem a cada subida, vivem em memória e
  // só chegam a outro processo pelo descriptor, que é 0600.
  let api = null;
  let apiReady = null;
  let descriptorPath = null;
  let capability = null;
  let heartbeat = null;
  let restartTimer = null;
  let restartDelay = RESTART_DELAY_MS;
  let stopping = false;
  let lastError = null;
  // Uma rodada de heartbeat por vez, retries inclusos.
  let ticking = false;
  // Quedas seguidas sem o API server ter atendido uma vez. Zera no primeiro
  // readiness; é o que distingue "caiu depois de trabalhar" de "não sobe".
  let coldRestarts = 0;

  function state() {
    return {
      running: Boolean(proc) && proc.exitCode === null,
      ready: Boolean(api?.ready),
      root,
      home,
      lastError,
    };
  }

  /**
   * Publica onde a LifeAi atende. Só depois do API server responder: um
   * descriptor apontando para uma porta que ainda não escuta faria todo cliente
   * levar ECONNREFUSED e concluir que o serviço está morto.
   */
  function publishDescriptor() {
    const alvo = api;
    try {
      descriptorPath = writeControlDescriptor({
        version: LIFEAI_DESCRIPTOR_VERSION,
        instanceId,
        pid: process.pid,
        apiUrl: `http://127.0.0.1:${alvo.port}`,
        apiKey: alvo.key,
        startedAt: new Date().toISOString(),
      }, { runtimeDir });
      alvo.ready = true;
      // Atendeu: a partir daqui uma queda é queda, não "não consegue subir".
      coldRestarts = 0;
      restartDelay = RESTART_DELAY_MS;
    } catch (error) {
      log.log(`[lifeai] não consegui publicar o descriptor: ${error.message}`);
    }
  }

  function unpublishDescriptor() {
    if (!descriptorPath) return;
    removeControlDescriptor(descriptorPath, instanceId);
    descriptorPath = null;
  }

  function childEnv(access) {
    // O env do host pode carregar credencial Anthropic pessoal; o filho fala só
    // pelo broker, então essas variáveis saem daqui antes de qualquer coisa. As
    // que o broker usa são redefinidas logo abaixo com o lease da conta de time;
    // o que este laço garante é que nada do host sobreviva por descuido.
    const clean = { ...env };
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      delete clean[key];
    }
    return {
      ...clean,
      HERMES_HOME: home,
      LIFEAI_HOME: home,
      LIFEAI_CLAUDE_BASE_URL: access.baseUrl,
      // Declara o broker como endpoint que repassa OAuth: sem isso o núcleo
      // trata qualquer base_url não-Anthropic como proxy de terceiro e manda
      // x-api-key, header que o broker não lê.
      LIFEAI_ANTHROPIC_OAUTH_PROXY: access.baseUrl,
      ANTHROPIC_API_KEY: access.capability,
      // O par canônico, o mesmo que `enrichPtyEnv` dá aos terminais
      // (lib/team-accounts.js). As duas variáveis acima só chegam ao cliente
      // pelo caminho que passa por `model:` no config.yaml; quem monta cliente
      // fora dele — o subagente do `delegate_task`, por exemplo — lia o default
      // público e saía para api.anthropic.com levando uma capability que só o
      // broker entende, tomando 401 e abortando a delegação inteira. Estas duas
      // o SDK lê sozinho, então todo caminho cai no broker.
      ANTHROPIC_BASE_URL: access.baseUrl,
      CLAUDE_CODE_OAUTH_TOKEN: access.capability,
      // O config referencia este caminho para subir o MCP do Cockpit. Fica no
      // env porque quem instala sabe onde o Cockpit está; o config, não.
      LIFEAI_COCKPIT_MCP: cockpitMcp,
      // API server só em loopback e sempre com chave: é por ele que o painel do
      // Cockpit conversa com a LifeAi.
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(api.port),
      API_SERVER_KEY: api.key,
    };
  }

  /** Resolve quando o API server responde; rejeita se o filho reiniciar antes. */
  function waitReady() {
    if (apiReady) return apiReady;
    if (!api) return Promise.reject(new Error("LifeAi não está de pé"));
    const alvo = api;
    apiReady = (async () => {
      const limite = Date.now() + API_READY_TIMEOUT_MS;
      while (Date.now() < limite) {
        if (api !== alvo) throw new Error("LifeAi reiniciou antes de ficar pronta");
        try {
          await alvo.client.health();
          publishDescriptor();
          return true;
        } catch { /* ainda subindo */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("LifeAi não abriu o API server a tempo");
    })();
    return apiReady;
  }

  function client() {
    if (!api) throw new Error("LifeAi não está de pé");
    return api.client;
  }

  async function ask(prompt, options) {
    await waitReady();
    return client().ask(prompt, options);
  }

  async function approve(runId, choice) {
    return client().approve(runId, choice);
  }

  async function stopRun(runId) {
    return client().stopRun(runId);
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    // Nunca agendar por cima de um filho vivo: o exit que chegou pode ser de um
    // irmão anterior, e nascer outro agora só daria mais um `--replace` para
    // degolar quem está subindo.
    if (proc && proc.exitCode === null) return;
    const espera = coldRestarts >= MAX_COLD_RESTARTS
      ? MAX_RESTART_DELAY_MS
      : Math.max(restartDelay, coldRestarts > 0 ? COLD_RESTART_DELAY_MS : 0);
    if (coldRestarts === MAX_COLD_RESTARTS) {
      log.log(`[lifeai] ${coldRestarts} subidas sem atender — espaçando para ${MAX_RESTART_DELAY_MS / 1000}s`);
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start().catch((error) => log.log(`[lifeai] restart falhou: ${error.message}`));
    }, espera);
    restartTimer.unref?.();
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
  }

  function pausa(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  async function tick() {
    // O interval não espera o tick anterior; sem esta trava, uma rodada de
    // retries em curso ganharia companhia e as duas renovariam em duplicata.
    if (ticking) return;
    ticking = true;
    try {
      for (let tentativa = 1; tentativa <= HEARTBEAT_TRIES; tentativa += 1) {
        // A capability é relida a cada volta: se um restart aconteceu no meio
        // da espera, o lease desta rodada já não é o que está no ar.
        const alvo = capability;
        if (!alvo) return;
        try {
          const renewed = await claudeAccess.renew(alvo, { ttlMs: LEASE_TTL_MS });
          if (renewed) return;
          // Lease morto: o filho segue vivo com um segredo que o broker já não
          // aceita. Reiniciar é a única forma de entregar um novo pelo env.
          log.log("[lifeai] lease da assinatura expirou — reiniciando para renovar");
          await restart();
          return;
        } catch (error) {
          log.log(`[lifeai] heartbeat falhou (${tentativa}/${HEARTBEAT_TRIES}): ${error.message}`);
          lastError = error.message;
          if (tentativa === HEARTBEAT_TRIES) return;
          await pausa(heartbeatRetryDelayMs * 2 ** (tentativa - 1));
          if (capability !== alvo) return;
        }
      }
    } finally {
      ticking = false;
    }
  }

  async function start() {
    if (proc && proc.exitCode === null) return state();
    if (!fs.existsSync(bin)) {
      lastError = `LifeAi não encontrada em ${bin}`;
      return state();
    }
    if (!claudeAccess.connected()) {
      lastError = "sem sessão de time — LifeAi aguarda o login da Ailiv";
      scheduleRestart();
      return state();
    }
    const access = claudeAccess.issue("lifeai", LEASE_TTL_MS);
    if (!access) {
      lastError = "broker indisponível — LifeAi sem endereço para a assinatura";
      scheduleRestart();
      return state();
    }
    capability = access.capability;
    lastError = null;
    stopping = false;
    const port = await freePort();
    const key = crypto.randomBytes(32).toString("base64url");
    api = {
      port,
      key,
      ready: false,
      client: createLifeAiApi({ url: `http://127.0.0.1:${port}`, key }),
    };
    apiReady = null;
    try {
      seedHome();
    } catch (error) {
      // Config ausente não impede subir: o núcleo tem defaults próprios.
      log.log(`[lifeai] não consegui preparar ${home}: ${error.message}`);
    }

    // --replace: se o serviço morreu sem desligar o filho (SIGKILL, queda de
    // energia), o gateway órfão segura o lock e a próxima subida falharia para
    // sempre — mesmo com o dono já morto.
    proc = spawn(bin, ["gateway", "run", "--replace"], {
      cwd: root,
      env: childEnv(access),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const relay = (chunk) => {
      const text = String(chunk).trim();
      // Saída de processo é dado, nunca instrução: só vai para o log.
      if (text) log.log(`[lifeai] ${text}`);
    };
    proc.stdout.on("data", relay);
    proc.stderr.on("data", relay);
    proc.on("error", (error) => { lastError = error.message; });
    // O handler precisa saber de qual filho ele é. Sem isso, o `exit` de um
    // processo que já foi substituído derruba o estado do sucessor: zera `proc`
    // e `api`, e revoga a capability de quem está vivo — que a partir daí leva
    // 401 do broker em toda chamada sem ter como reler o segredo do env.
    const meuProc = proc;
    const minhaCapability = access.capability;
    const meuApi = api;
    proc.on("exit", (code, signal) => {
      log.log(`[lifeai] encerrou code=${code} signal=${signal || "-"}`);
      claudeAccess.revoke(minhaCapability);
      if (proc !== meuProc) {
        // Filho substituído: já há outro de pé (ou a caminho). Não tocar no
        // estado atual e, principalmente, não agendar mais uma subida.
        return;
      }
      proc = null;
      if (api === meuApi) { api = null; apiReady = null; }
      if (capability === minhaCapability) capability = null;
      unpublishDescriptor();
      if (!meuApi?.ready) coldRestarts += 1;
      if (!stopping) scheduleRestart();
    });

    // O backoff só volta ao piso quando o filho atende de verdade
    // (`publishDescriptor`). Zerar aqui, no spawn, fazia toda tentativa nascer
    // com 5s de espera por mais que a anterior tivesse falhado.
    // O descriptor só sai quando o API server atende de verdade.
    waitReady().catch((error) => {
      lastError = error.message;
      log.log(`[lifeai] ${error.message}`);
    });
    if (!heartbeat) {
      heartbeat = setInterval(() => { tick(); }, HEARTBEAT_MS);
      heartbeat.unref?.();
    }
    return state();
  }

  async function stop() {
    stopping = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    api = null;
    apiReady = null;
    unpublishDescriptor();
    const child = proc;
    proc = null;
    // Quem revoga é o handler de saída do filho, que sabe qual capability é a
    // dele. Aqui só sobra o caso sem filho vivo para fazê-lo.
    if (!child || child.exitCode !== null) {
      if (capability) { claudeAccess.revoke(capability); capability = null; }
      return;
    }
    capability = null;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const forced = setTimeout(() => {
        log.log(`[lifeai] não saiu em ${STOP_GRACE_MS / 1000}s — SIGKILL (o lock pode ficar órfão)`);
        try { child.kill("SIGKILL"); } catch {}
        resolve();
      }, STOP_GRACE_MS);
      forced.unref?.();
      child.once("exit", () => { clearTimeout(forced); resolve(); });
    });
  }

  async function restart() {
    await stop();
    stopping = false;
    return start();
  }

  return {
    start, stop, restart, state, tick,
    ask, approve, stopRun, waitReady,
    runtimeDir,
    heartbeatIntervalMs: HEARTBEAT_MS,
  };
}
