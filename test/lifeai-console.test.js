import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLifeAiConsole } from "../lib/lifeai-console.js";

const SILENT = { log: () => {} };
const CHAVE = "chave-secreta-da-lifeai";

/** Pasta web de mentira: o console serve o disco, não um bundle. */
function fakeWeb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-console-web-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>console</title>");
  fs.writeFileSync(path.join(dir, "ui", "app.js"), "export const oi = 1;\n");
  fs.writeFileSync(path.join(dir, "segredo.env"), "TOKEN=nao-servir");
  return dir;
}

/**
 * API server de mentira. Guarda o que recebeu para o teste conferir que a
 * credencial foi injetada — e que ela não voltou no corpo da resposta.
 */
async function fakeApi(t) {
  const recebidos = [];
  const server = http.createServer((req, res) => {
    recebidos.push({ url: req.url, method: req.method, auth: req.headers.authorization });
    if (req.url === "/v1/runs/r1/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ event: "message.delta", delta: "oi" })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ event: "run.completed" })}\n\n`);
        res.end();
      }, 30);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rota: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { recebidos, url: `http://127.0.0.1:${server.address().port}` };
}

async function subir(t, { web, api, viva = true }) {
  const console_ = createLifeAiConsole({
    resolveApi: () => (viva && api ? { url: api.url, key: CHAVE } : null),
    log: SILENT,
    env: { LIFEAI_CONSOLE_PORT: "0", LIFEAI_CONSOLE_WEB: web },
  });
  await console_.start();
  t.after(() => console_.stop());
  return console_;
}

/** fetch sem seguir redirect, para poder olhar o Set-Cookie da troca. */
function buscar(base, rota, opcoes = {}) {
  return fetch(`${base}${rota}`, { redirect: "manual", ...opcoes });
}

async function abrirSessao(console_) {
  const { url } = console_.issueTicket();
  const resposta = await fetch(url, { redirect: "manual" });
  const cookie = resposta.headers.getSetCookie()[0].split(";")[0];
  return cookie;
}

test("serve os arquivos da pasta web para quem tem sessão", async (t) => {
  const web = fakeWeb(t);
  const console_ = await subir(t, { web });
  const cookie = await abrirSessao(console_);

  const raiz = await buscar(console_.url(), "/", { headers: { cookie } });
  assert.equal(raiz.status, 200);
  assert.match(raiz.headers.get("content-type"), /text\/html/);
  assert.match(await raiz.text(), /console/);

  const modulo = await buscar(console_.url(), "/ui/app.js", { headers: { cookie } });
  assert.equal(modulo.status, 200);
  assert.match(modulo.headers.get("content-type"), /javascript/);
  assert.equal(modulo.headers.get("x-content-type-options"), "nosniff");
});

test("sem cookie não sai interface nenhuma, só a instrução", async (t) => {
  const web = fakeWeb(t);
  const console_ = await subir(t, { web });

  const resposta = await buscar(console_.url(), "/");
  assert.equal(resposta.status, 401);
  assert.match((await resposta.json()).erro, /lifeaictl console/);
});

test("extensão fora da allowlist não é servida nem com sessão", async (t) => {
  const web = fakeWeb(t);
  const console_ = await subir(t, { web });
  const cookie = await abrirSessao(console_);

  const resposta = await buscar(console_.url(), "/segredo.env", { headers: { cookie } });
  assert.equal(resposta.status, 404);
});

test("travessia de caminho não escapa da pasta web", async (t) => {
  const web = fakeWeb(t);
  const console_ = await subir(t, { web });
  const cookie = await abrirSessao(console_);

  // O fetch normaliza "..", então o pedido é montado na mão.
  const bruto = await new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: new URL(console_.url()).port,
      path: "/../../package.json",
      headers: { cookie },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.end();
  });
  assert.ok(bruto === 403 || bruto === 404, `esperava recusa, veio ${bruto}`);
});

test("ticket vale uma vez só", async (t) => {
  const web = fakeWeb(t);
  const console_ = await subir(t, { web });
  const { url } = console_.issueTicket();

  const primeira = await fetch(url, { redirect: "manual" });
  assert.equal(primeira.status, 302);
  assert.match(primeira.headers.get("set-cookie"), /HttpOnly/);
  assert.match(primeira.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(primeira.headers.get("location"), "/");

  const segunda = await fetch(url, { redirect: "manual" });
  assert.equal(segunda.status, 401);
});

test("ticket só sai para quem tem a chave da LifeAi", async (t) => {
  const web = fakeWeb(t);
  const api = await fakeApi(t);
  const console_ = await subir(t, { web, api });

  const semChave = await buscar(console_.url(), "/_ticket", { method: "POST" });
  assert.equal(semChave.status, 401);

  const chaveErrada = await buscar(console_.url(), "/_ticket", {
    method: "POST",
    headers: { authorization: "Bearer chave-errada-de-tamanho-igual!" },
  });
  assert.equal(chaveErrada.status, 401);

  const certa = await buscar(console_.url(), "/_ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${CHAVE}` },
  });
  assert.equal(certa.status, 200);
  assert.match((await certa.json()).url, /\?t=/);
});

test("Host estrangeiro é barrado (DNS rebinding)", async (t) => {
  const web = fakeWeb(t);
  const console_ = await subir(t, { web });

  // `fetch` não deixa forjar Host (header proibido): vai de http.request.
  const status = await new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: new URL(console_.url()).port,
      path: "/",
      headers: { host: "malicioso.example" },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.end();
  });
  assert.equal(status, 403);
});

test("proxy injeta a credencial e não a devolve ao navegador", async (t) => {
  const web = fakeWeb(t);
  const api = await fakeApi(t);
  const console_ = await subir(t, { web, api });
  const cookie = await abrirSessao(console_);

  const resposta = await buscar(console_.url(), "/api/sessions?limit=2", { headers: { cookie } });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.text();
  assert.match(corpo, /"rota":"\/api\/sessions\?limit=2"/);
  assert.ok(!corpo.includes(CHAVE), "a chave vazou no corpo");
  for (const [, valor] of resposta.headers) {
    assert.ok(!String(valor).includes(CHAVE), "a chave vazou num header");
  }
  assert.equal(api.recebidos.at(-1).auth, `Bearer ${CHAVE}`);
});

test("SSE chega em pedaços, não tudo no fim", async (t) => {
  const web = fakeWeb(t);
  const api = await fakeApi(t);
  const console_ = await subir(t, { web, api });
  const cookie = await abrirSessao(console_);

  const resposta = await buscar(console_.url(), "/v1/runs/r1/events", { headers: { cookie } });
  assert.equal(resposta.status, 200);
  const leitor = resposta.body.getReader();
  const primeiro = new TextDecoder().decode((await leitor.read()).value);
  // O delta tem de chegar antes de o run terminar: bufferizar mataria o stream.
  assert.match(primeiro, /message\.delta/);
  assert.ok(!primeiro.includes("run.completed"));
  await leitor.cancel();
});

test("Origin estrangeiro não passa em método de escrita", async (t) => {
  const web = fakeWeb(t);
  const api = await fakeApi(t);
  const console_ = await subir(t, { web, api });
  const cookie = await abrirSessao(console_);

  const resposta = await buscar(console_.url(), "/v1/runs", {
    method: "POST",
    headers: { cookie, origin: "http://evil.example", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(resposta.status, 403);
});

test("LifeAi ainda subindo responde 503, o console não cai", async (t) => {
  const web = fakeWeb(t);
  const api = await fakeApi(t);
  const console_ = createLifeAiConsole({
    resolveApi: () => null,
    log: SILENT,
    env: { LIFEAI_CONSOLE_PORT: "0", LIFEAI_CONSOLE_WEB: web },
  });
  await console_.start();
  t.after(() => console_.stop());
  void api;

  // Sem chave não há ticket: a sessão é aberta pelo caminho interno.
  const { ticket } = console_.issueTicket();
  const troca = await fetch(`${console_.url()}/?t=${ticket}`, { redirect: "manual" });
  const cookie = troca.headers.getSetCookie()[0].split(";")[0];

  const resposta = await buscar(console_.url(), "/api/sessions", { headers: { cookie } });
  assert.equal(resposta.status, 503);
  const estatico = await buscar(console_.url(), "/", { headers: { cookie } });
  assert.equal(estatico.status, 200);
});
