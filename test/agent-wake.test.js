import assert from "node:assert/strict";
import test from "node:test";

import { createAgentWake } from "../lib/agent-wake.js";

const SILENT = { log: () => {} };

/** A entrega vive numa promessa à parte; isto deixa a fila drenar. */
const drena = () => new Promise((r) => setImmediate(r));

/** Relógio de mentira: o dedupe e o teto por hora são regras de tempo. */
function relogio(inicio = 1_700_000_000_000) {
  let agora = inicio;
  return { now: () => agora, avanca: (ms) => { agora += ms; } };
}

function bancada(overrides = {}) {
  const enviados = [];
  const tempo = relogio();
  const wake = createAgentWake({
    notifyLifeAi: async (payload) => { enviados.push(payload); return { triggered: [] }; },
    log: SILENT,
    now: tempo.now,
    ...overrides,
  });
  const session = { proj: { id: "educari" } };
  const terminal = { id: "t1", name: "Auditoria Educari - retomada" };
  return { wake, enviados, tempo, session, terminal };
}

function trabalhaEPara(wake, session, terminal) {
  wake.onTerminalStatus(session, terminal, "running", "processando…");
  return wake.onTerminalStatus(session, terminal, "idle", "ocioso · 30s");
}

test("terminal que nunca trabalhou não acorda ninguém", () => {
  const { wake, enviados, session, terminal } = bancada();

  // Sem esta regra, um terminal parado desde ontem dispara acordada a cada
  // evento de status — e o server emite status o tempo todo.
  const resultado = wake.onTerminalStatus(session, terminal, "idle", "ocioso · 9h");

  assert.equal(resultado.sent, false);
  assert.equal(resultado.reason, "sem trabalho novo");
  assert.deepEqual(enviados, []);
});

test("terminal que trabalhou e parou avisa uma vez só", async () => {
  const { wake, enviados, session, terminal } = bancada();

  assert.equal(trabalhaEPara(wake, session, terminal).sent, true);
  await drena();
  assert.equal(enviados.length, 1);
  assert.deepEqual(enviados[0], {
    project: "educari",
    terminal_id: "t1",
    terminal_title: "Auditoria Educari - retomada",
    event: "ocioso",
  });

  // Segundo "ocioso" sem trabalho no meio: o mesmo fato, não um novo.
  assert.equal(wake.onTerminalStatus(session, terminal, "idle", "ocioso · 1m").sent, false);
  await drena();
  assert.equal(enviados.length, 1);
});

test("hook e heurística contando o mesmo fim de turno viram um aviso", async () => {
  const { wake, enviados, tempo, session, terminal } = bancada();

  wake.onTerminalStatus(session, terminal, "running", "processando…");
  assert.equal(wake.onTerminalStatus(session, terminal, "waiting", "aguardando").sent, true);

  // O hook Stop chega segundos depois — e o terminal voltou a "rodar" no meio,
  // que é o que o PTY faz ao ecoar. Sem o dedupe, seriam duas acordadas.
  tempo.avanca(5_000);
  wake.onTerminalStatus(session, terminal, "running", "processando…");
  const segundo = wake.onTerminalStatus(session, terminal, "idle", "ocioso · 30s");

  assert.equal(segundo.sent, false);
  assert.equal(segundo.reason, "repetido");
  await drena();
  assert.equal(enviados.length, 1);

  // Passada a janela, um fim de turno de verdade volta a avisar.
  tempo.avanca(20_000);
  wake.onTerminalStatus(session, terminal, "running", "processando…");
  assert.equal(wake.onTerminalStatus(session, terminal, "idle", "ocioso · 30s").sent, true);
  await drena();
  assert.equal(enviados.length, 2);
});

test("o teto da hora corta o laço de retroalimentação", async () => {
  const { wake, enviados, tempo, session, terminal } = bancada({ hourlyCap: 3 });

  // "ela manda → ele responde em 2s → ela manda": cada volta é trabalho novo e
  // passa pelo dedupe. Só o teto segura.
  for (let i = 0; i < 10; i += 1) {
    trabalhaEPara(wake, session, terminal);
    tempo.avanca(25_000);
  }
  await drena();
  assert.equal(enviados.length, 3);

  // Virou a hora, a régua zera e o evento volta a valer.
  tempo.avanca(60 * 60 * 1000);
  assert.equal(trabalhaEPara(wake, session, terminal).sent, true);
  await drena();
  assert.equal(enviados.length, 4);
});

test("o teto é por terminal, não do Cockpit inteiro", async () => {
  const { wake, enviados, tempo, session, terminal } = bancada({ hourlyCap: 1 });
  const outro = { id: "t2", name: "BI e indicadores" };

  trabalhaEPara(wake, session, terminal);
  tempo.avanca(25_000);
  trabalhaEPara(wake, session, terminal);   // barrado pelo teto
  trabalhaEPara(wake, session, outro);      // frente diferente, régua própria

  await drena();
  assert.deepEqual(enviados.map((p) => p.terminal_id), ["t1", "t2"]);
});

test("LifeAi fora do ar é silêncio, não exceção", async () => {
  const { wake, session, terminal } = bancada({
    notifyLifeAi: async () => { throw new Error("service_down"); },
  });

  assert.equal(trabalhaEPara(wake, session, terminal).sent, true);
  // A entrega vive numa promessa à parte: se o catch não existisse, isto viraria
  // unhandled rejection e derrubaria o server.
  await new Promise((r) => setImmediate(r));
});

test("POST /wake sem token não acorda nada", async () => {
  const { wake, enviados, session, terminal } = bancada({ resolveToken: () => null });
  wake.onTerminalStatus(session, terminal, "running", "processando…");

  const res = respostaFalsa();
  const tratou = wake.handle(pedidoFalso({ authorization: "Bearer chute" }), res, { pathname: "/wake" });

  assert.equal(tratou, true);
  await res.pronto;
  assert.equal(res.status, 401);
  assert.deepEqual(enviados, []);
});

test("POST /wake com o token do terminal avisa em nome dele", async () => {
  const { wake, enviados, session, terminal } = bancada({
    resolveToken: (token) => (token === "segredo" ? { session, terminal } : null),
  });
  wake.onTerminalStatus(session, terminal, "running", "processando…");

  const res = respostaFalsa();
  wake.handle(
    pedidoFalso({ authorization: "Bearer segredo" }, JSON.stringify({ event: "stop" })),
    res,
    { pathname: "/wake" },
  );

  await res.pronto;
  assert.equal(res.status, 204);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].event, "hook:stop");
  assert.equal(enviados[0].terminal_id, "t1");
});

test("o nome do evento vindo de fora é higienizado", async () => {
  const { wake, enviados, session, terminal } = bancada({
    resolveToken: () => ({ session, terminal }),
  });
  wake.onTerminalStatus(session, terminal, "running", "processando…");

  const res = respostaFalsa();
  wake.handle(
    pedidoFalso({ authorization: "Bearer x" }, JSON.stringify({ event: "stop\n; rm -rf /" })),
    res,
    { pathname: "/wake" },
  );

  await res.pronto;
  // Este texto acaba em log e em campo de payload: nada de espaço nem pontuação.
  assert.equal(enviados[0].event, "hook:stoprm-rf");
});

test("a ponte não responde por rota que não é dela", () => {
  const { wake } = bancada();
  assert.equal(wake.handle(pedidoFalso({}), respostaFalsa(), { pathname: "/status" }), false);
});

// --- dublês de http.IncomingMessage / ServerResponse -----------------------

function pedidoFalso(headers = {}, corpo = "", method = "POST") {
  const ouvintes = new Map();
  return {
    method,
    headers,
    on(evento, fn) {
      ouvintes.set(evento, fn);
      if (evento === "end") {
        // Entrega o corpo assim que alguém termina de assinar os eventos.
        setImmediate(() => {
          if (corpo) ouvintes.get("data")?.(corpo);
          ouvintes.get("end")?.();
        });
      }
      return this;
    },
    destroy() {},
  };
}

function respostaFalsa() {
  const res = { status: 0, headers: null };
  res.pronto = new Promise((resolve) => {
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers || null; };
    res.end = () => resolve();
  });
  return res;
}
