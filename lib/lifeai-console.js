// Console Ailiv — a cara web da LifeAi.
//
// Sobe junto com o daemon (bin/lifeaid.js) e faz duas coisas:
//
//   1. serve os arquivos de integrations/lifeai/web/ (HTML, CSS e ESM nativo,
//      sem etapa de build: são servidos como estão no disco);
//   2. faz proxy autenticado de /api/* e /v1/* para o API server da LifeAi.
//
// A chave da LifeAi nunca chega ao navegador: quem a injeta é este proxy, no
// servidor. O navegador carrega só um cookie de sessão, obtido trocando um
// ticket de uso único que o `lifeaictl console` pede ao daemon.
//
// Tudo aqui é loopback: escuta em 127.0.0.1, exige Host local (bloqueia DNS
// rebinding) e Origin próprio em qualquer método que não seja GET.

import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(AQUI, "..", "integrations", "lifeai", "web");

const PORTA_PADRAO = 4747;
const TICKET_TTL_MS = 60_000;
const SESSAO_TTL_MS = 12 * 60 * 60 * 1_000;
const COOKIE = "lifeai_console";

// Allowlist: só estes tipos saem do disco. Sem entrada aqui, o arquivo não
// existe para o console — nem que esteja dentro da pasta.
const TIPOS = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
  [".png", "image/png"],
]);

// Sem CDN, sem inline: só o que veio desta origem. `connect-src 'self'` cobre
// o fetch e o EventSource do proxy.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function hostLocal(header) {
  if (!header) return false;
  const host = String(header).split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function lerCookie(header, nome) {
  for (const parte of String(header || "").split(";")) {
    const corte = parte.indexOf("=");
    if (corte === -1) continue;
    if (parte.slice(0, corte).trim() !== nome) continue;
    return parte.slice(corte + 1).trim();
  }
  return null;
}

function igual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {object} deps
 * @param {() => ({url: string, key: string}|null)} deps.resolveApi
 *   Onde o API server da LifeAi atende agora. Devolve null enquanto ela sobe —
 *   o console fica de pé e responde 503, em vez de cair junto.
 * @param {Console} [deps.log]
 * @param {object} [deps.env]
 */
export function createLifeAiConsole({ resolveApi, log = console, env = process.env } = {}) {
  if (typeof resolveApi !== "function") throw new TypeError("resolveApi é obrigatório");

  const portaPedida = Number(env.LIFEAI_CONSOLE_PORT || PORTA_PADRAO);
  const webRoot = env.LIFEAI_CONSOLE_WEB || WEB_ROOT;

  let server = null;
  let base = null;
  const tickets = new Map();   // ticket → expira em
  const sessoes = new Map();   // cookie  → expira em

  function limpar(mapa) {
    const agora = Date.now();
    for (const [chave, expira] of mapa) if (expira <= agora) mapa.delete(chave);
  }

  /** Ticket de uso único: vale 60s e some no primeiro uso. */
  function issueTicket() {
    limpar(tickets);
    const ticket = crypto.randomBytes(24).toString("base64url");
    tickets.set(ticket, Date.now() + TICKET_TTL_MS);
    return { ticket, url: `${base}/?t=${ticket}` };
  }

  function trocarTicket(ticket) {
    limpar(tickets);
    if (!ticket || !tickets.has(ticket)) return null;
    tickets.delete(ticket);
    const sessao = crypto.randomBytes(32).toString("base64url");
    sessoes.set(sessao, Date.now() + SESSAO_TTL_MS);
    return sessao;
  }

  function sessaoValida(req) {
    limpar(sessoes);
    const cookie = lerCookie(req.headers.cookie, COOKIE);
    return Boolean(cookie && sessoes.has(cookie));
  }

  /** A chave do descriptor (0600) é o que autoriza pedir ticket pelo CLI. */
  function chaveConfere(req) {
    const alvo = resolveApi();
    if (!alvo?.key) return false;
    const header = String(req.headers.authorization || "");
    return header.startsWith("Bearer ") && igual(header.slice(7), alvo.key);
  }

  function json(res, status, corpo) {
    const texto = JSON.stringify(corpo);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(texto);
  }

  function servirArquivo(res, rota) {
    const relativo = rota === "/" ? "index.html" : rota.replace(/^\/+/, "");
    const alvo = path.resolve(webRoot, relativo);
    // Confinar na pasta: `path.resolve` já normaliza "..", então basta checar o
    // prefixo — é o mesmo cuidado do serve_spa do núcleo.
    if (alvo !== webRoot && !alvo.startsWith(webRoot + path.sep)) {
      json(res, 403, { erro: "fora do console" });
      return;
    }
    const tipo = TIPOS.get(path.extname(alvo).toLowerCase());
    if (!tipo) {
      json(res, 404, { erro: "não encontrado" });
      return;
    }
    let corpo;
    try {
      corpo = fs.readFileSync(alvo);
    } catch {
      json(res, 404, { erro: "não encontrado" });
      return;
    }
    res.writeHead(200, {
      "content-type": tipo,
      // Sem hash no nome: revalidar sempre é o que faz um arquivo editado
      // aparecer no próximo F5 em vez de daqui a um ano.
      "cache-control": "no-store",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(corpo);
  }

  /**
   * Repassa a requisição ao API server com a credencial da LifeAi. O corpo da
   * resposta vai por pipe: SSE precisa chegar em pedaços, e bufferizar faria
   * todos os message.delta aparecerem juntos no fim do run.
   */
  function proxy(req, res, rota) {
    const alvo = resolveApi();
    if (!alvo) {
      json(res, 503, { erro: "LifeAi ainda não está atendendo" });
      return;
    }
    const destino = new URL(rota, alvo.url);
    const upstream = http.request({
      hostname: destino.hostname,
      port: destino.port,
      path: destino.pathname + destino.search,
      method: req.method,
      headers: {
        authorization: `Bearer ${alvo.key}`,
        accept: req.headers.accept || "*/*",
        ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
      },
    }, (resposta) => {
      const cabecalhos = { ...resposta.headers };
      // A resposta não é cacheável nem pode ser reinterpretada pelo navegador.
      delete cabecalhos["content-encoding"];
      cabecalhos["cache-control"] = "no-store";
      cabecalhos["x-content-type-options"] = "nosniff";
      res.writeHead(resposta.statusCode || 502, cabecalhos);
      resposta.pipe(res);
    });
    upstream.on("error", (error) => {
      log.log?.(`[console] proxy ${rota} falhou: ${error.message}`);
      if (!res.headersSent) json(res, 502, { erro: "LifeAi não respondeu" });
      else res.end();
    });
    req.pipe(upstream);
    res.on("close", () => { upstream.destroy(); });
  }

  function handle(req, res) {
    // DNS rebinding: um nome externo apontando para 127.0.0.1 chegaria aqui com
    // outro Host. Mesma checagem do broker (lib/team-router.js).
    if (!hostLocal(req.headers.host)) {
      json(res, 403, { erro: "console é local" });
      return;
    }
    const url = new URL(req.url || "/", base || "http://127.0.0.1");
    const rota = url.pathname;

    if (rota === "/_ticket") {
      if (req.method !== "POST" || !chaveConfere(req)) {
        json(res, 401, { erro: "sem credencial da LifeAi" });
        return;
      }
      json(res, 200, issueTicket());
      return;
    }

    // Ticket na URL: troca por cookie e reentra limpo, para o ticket usado não
    // ficar no histórico do navegador nem no Referer de nenhum pedido.
    const ticket = url.searchParams.get("t");
    if (ticket) {
      const sessao = trocarTicket(ticket);
      if (!sessao) {
        json(res, 401, { erro: "ticket expirado — rode: lifeaictl console" });
        return;
      }
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${COOKIE}=${sessao}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSAO_TTL_MS / 1000)}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    if (!sessaoValida(req)) {
      json(res, 401, { erro: "abra o console com: lifeaictl console" });
      return;
    }

    if (rota.startsWith("/api/") || rota.startsWith("/v1/") || rota === "/health/detailed") {
      // CSRF: com cookie SameSite=Strict o navegador já não manda de outra
      // origem, mas um Origin estrangeiro em POST é sinal de que algo tentou.
      if (req.method !== "GET" && req.headers.origin && req.headers.origin !== base) {
        json(res, 403, { erro: "origem inesperada" });
        return;
      }
      proxy(req, res, url.pathname + url.search);
      return;
    }

    if (req.method !== "GET") {
      json(res, 405, { erro: "método não suportado" });
      return;
    }
    servirArquivo(res, rota);
  }

  async function escutar(porta) {
    const candidato = http.createServer(handle);
    await new Promise((resolve, reject) => {
      candidato.once("error", reject);
      candidato.listen(porta, "127.0.0.1", resolve);
    });
    return candidato;
  }

  async function start() {
    if (server) return { url: base };
    try {
      server = await escutar(portaPedida);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      // Porta tomada por outro processo: subir numa efêmera é melhor do que
      // derrubar o serviço inteiro. O endereço real sai no descriptor.
      log.log?.(`[console] porta ${portaPedida} ocupada — subindo numa porta livre`);
      server = await escutar(0);
    }
    base = `http://127.0.0.1:${server.address().port}`;
    log.log?.(`[console] em ${base}`);
    return { url: base };
  }

  async function stop() {
    tickets.clear();
    sessoes.clear();
    const atual = server;
    server = null;
    base = null;
    if (!atual) return;
    await new Promise((resolve) => atual.close(resolve));
  }

  return {
    start,
    stop,
    issueTicket,
    url: () => base,
    // exposto para teste: exercitar o roteamento sem abrir porta
    handle,
  };
}
