#!/usr/bin/env node
// lifeaid — o serviço da LifeAi.
//
// Roda como systemd user unit, independente da janela do Cockpit. Faz três
// coisas e nada além disso:
//
//   1. sobe um broker Claude próprio, em loopback, com o mesmo código que o
//      Cockpit usa (lib/team-router.js). É o que torna a independência real:
//      o servidor do Cockpit vive dentro do Electron (electron-main.js), então
//      depender do broker dele seria depender da janela estar aberta;
//   2. supervisiona o processo do núcleo da LifeAi (lib/lifeai.js);
//   3. publica onde ela atende em $XDG_RUNTIME_DIR/lifeai/control.json, para o
//      Cockpit — e só o Cockpit, o arquivo é 0600 — conseguir conversar.
//
// O broker usa homes próprias (~/.lifeai/broker/...) e lê o mesmo
// ~/.cockpit/team-auth.json que o Cockpit escreveu: é o mesmo dispositivo, o
// mesmo deviceToken. Separar as homes evita qualquer corrida de arquivo com o
// Cockpit aberto ao mesmo tempo.

import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

import { createLifeAi } from "../lib/lifeai.js";
import { createTeamAccountsClient } from "../lib/team-accounts.js";
import { createTeamRouter } from "../lib/team-router.js";

const HOME = os.homedir();
const BROKER_ROOT = process.env.LIFEAI_BROKER_HOME || path.join(HOME, ".lifeai", "broker");
const TEAM_CONFIG = process.env.COCKPIT_TEAM_CONFIG_PATH
  || path.join(HOME, ".cockpit", "team-auth.json");
// Debounce do fs.watch: um save costuma disparar mais de um evento, e
// reinstanciar o client três vezes seguidas só gasta requisição no Control.
const RELOAD_DEBOUNCE_MS = 1_000;

const log = {
  log: (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`),
};

function brokerEnv(port) {
  return {
    ...process.env,
    COCKPIT_TEAM_CONFIG_PATH: TEAM_CONFIG,
    COCKPIT_TEAM_CLAUDE_HOME: path.join(BROKER_ROOT, "claude"),
    COCKPIT_TEAM_CODEX_HOME: path.join(BROKER_ROOT, "codex"),
    LIFEAI_BROKER_PORT: String(port),
  };
}

async function main() {
  fs.mkdirSync(BROKER_ROOT, { recursive: true, mode: 0o700 });

  // O broker escuta numa porta efêmera e o próprio router exige que o Host da
  // requisição bata com esta URL (assertLocalRequest), então ela precisa ser
  // conhecida antes de instanciar o router.
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const brokerUrl = `http://127.0.0.1:${port}`;
  const env = brokerEnv(port);

  // O client lê o team-auth.json no construtor e nunca mais. Reconectar o time
  // pelo Cockpit reescreve esse arquivo — sem reinstanciar aqui, a LifeAi
  // ficaria muda com um deviceToken velho até alguém reiniciar o serviço.
  let teamRouter = null;
  function loadTeam() {
    teamRouter = createTeamRouter({
      client: createTeamAccountsClient({ env }),
      brokerUrl: () => brokerUrl,
      log,
    });
  }
  loadTeam();

  server.on("request", (req, res) => {
    const url = new URL(req.url || "/", brokerUrl);
    if (teamRouter.handle(req, res, url)) return;
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "rota não encontrada" }));
  });

  // Ponte entre o broker e o supervisor: o supervisor não sabe (nem precisa
  // saber) de onde vem a credencial da assinatura.
  const claudeAccess = {
    connected: () => teamRouter.status().connected,
    issue: (label, ttlMs) => teamRouter.issueClaudeAccess(label, ttlMs),
    renew: (capability, options) => teamRouter.renewClaudeAccess(capability, options),
    revoke: (capability) => teamRouter.revokeClaudeAccess(capability),
  };

  // A cara web da LifeAi é o projeto lifeai-console, com servidor próprio: o
  // daemon não serve mais HTML nem faz proxy autenticado. Aqui sobra o núcleo.
  const lifeai = createLifeAi({ claudeAccess, log, env });

  /**
   * No boot o serviço sobe antes da rede estar de fato utilizável, e aí a
   * seleção de conta no Control falha. Uma tentativa só deixaria a LifeAi de
   * pé porém muda (todo pedido vira 503 no broker) até o primeiro heartbeat,
   * meia hora depois. Insiste com recuo até conseguir uma conta.
   */
  async function bootstrapComRetry() {
    let espera = 5_000;
    for (let tentativa = 1; tentativa <= 8; tentativa += 1) {
      try {
        const resultado = await teamRouter.bootstrap({ syncUsage: tentativa === 1 });
        // Sem sessão de time não adianta insistir: falta um login, não a rede.
        if (!resultado.connected) return;
        if (resultado.selections.length) {
          if (tentativa > 1) log.log(`[lifeaid] conta do time selecionada na tentativa ${tentativa}`);
          return;
        }
        log.log(`[lifeaid] time sem conta utilizável (tentativa ${tentativa})`);
      } catch (error) {
        log.log(`[lifeaid] bootstrap do time falhou (tentativa ${tentativa}): ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, espera));
      espera = Math.min(espera * 2, 60_000);
    }
    log.log("[lifeaid] segue sem conta do time — o heartbeat continua tentando");
  }

  await bootstrapComRetry();
  log.log(`[lifeaid] broker em ${brokerUrl}, descriptor em ${lifeai.runtimeDir}`);
  const inicial = await lifeai.start();
  // Não subir agora não é fatal — o supervisor tenta de novo sozinho. Mas o
  // motivo precisa aparecer no journalctl, senão o serviço fica "ativo e mudo".
  if (!inicial.running) log.log(`[lifeaid] LifeAi ainda não subiu: ${inicial.lastError}`);

  let reloadTimer = null;
  try {
    fs.watch(path.dirname(TEAM_CONFIG), (_event, filename) => {
      if (filename && filename !== path.basename(TEAM_CONFIG)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        log.log("[lifeaid] sessão do time mudou — recarregando e reemitindo o lease");
        loadTeam();
        await bootstrapComRetry();
        // Reiniciar é o que entrega o lease novo: o filho leu a credencial do
        // env quando nasceu e não tem como reler.
        await lifeai.restart().catch((error) => {
          log.log(`[lifeaid] restart após troca de sessão falhou: ${error.message}`);
        });
      }, RELOAD_DEBOUNCE_MS);
      reloadTimer.unref?.();
    });
  } catch (error) {
    // Sem watch o serviço continua servindo; só perde o reload automático.
    log.log(`[lifeaid] não consegui observar ${TEAM_CONFIG}: ${error.message}`);
  }

  let encerrando = false;
  async function shutdown(signal) {
    if (encerrando) return;
    encerrando = true;
    log.log(`[lifeaid] ${signal} — encerrando`);
    clearTimeout(reloadTimer);
    await lifeai.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  }
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });
}

main().catch((error) => {
  log.log(`[lifeaid] falhou ao subir: ${error.stack || error.message}`);
  process.exit(1);
});
