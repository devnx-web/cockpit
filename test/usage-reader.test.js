import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NO_PROJECT, UsageDb } from "../lib/usage/db.js";
import { ProjectResolver, UsageReader, discoverRoots, ingestFile, scanRoots } from "../lib/usage/reader.js";

function sandbox(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-reader-"));
  const db = new UsageDb({ dbPath: path.join(dir, "usage.db") }).open();
  try {
    return fn({ db, dir });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let contador = 0;
function claudeLine({ id = `msg_${++contador}`, req = `req_${contador}`, cwd = "/home/ftgk/cockpit", out = 40 } = {}) {
  return `${JSON.stringify({
    type: "assistant",
    requestId: req,
    timestamp: "2026-07-27T14:05:00.000Z",
    sessionId: "sess-1",
    cwd,
    message: {
      id,
      model: "claude-opus-5",
      usage: { input_tokens: 10, cache_read_input_token: 0, cache_read_input_tokens: 100, output_tokens: out },
    },
  })}\n`;
}

function target(filePath, provider = "claude") {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    provider,
    rootTag: `${provider}-test`,
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    ino: `${stat.dev}:${stat.ino}`,
  };
}

test("reader: linha parcial fica no carry e só conta quando completa", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "sessao.jsonl");
    const completa = claudeLine({ id: "msg_a", req: "req_a" });
    const parcial = claudeLine({ id: "msg_b", req: "req_b" });

    // O agente está no meio de gravar a segunda linha.
    fs.writeFileSync(file, completa + parcial.slice(0, 40));
    const primeira = ingestFile(db, target(file));
    assert.equal(primeira.events, 1, "a linha incompleta não pode ser contada");
    const offsetParcial = db.getFile(file).offset;
    assert.equal(offsetParcial, Buffer.byteLength(completa), "offset para logo após o último \\n");

    // Agora ele termina de gravar.
    fs.writeFileSync(file, completa + parcial);
    const segunda = ingestFile(db, target(file));
    assert.equal(segunda.events, 1, "a linha completada entra agora");
    assert.equal(db.countEvents(), 2);
    assert.equal(db.getFile(file).offset, Buffer.byteLength(completa + parcial));
  });
});

test("reader: caractere multibyte cortado entre chunks não corrompe nada", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "acentos.jsonl");
    // Emojis e acentos ocupam 2–4 bytes; com chunk pequeno o corte cai no meio deles.
    const linhas = Array.from({ length: 60 }, (_, i) =>
      claudeLine({ id: `m${i}`, req: `r${i}`, cwd: `/home/ftgk/programação-🚀/módulo-${i}` }),
    );
    const conteudo = linhas.join("");
    fs.writeFileSync(file, conteudo);

    // 37 bytes força o corte no meio de sequências UTF-8 dezenas de vezes.
    const r = ingestFile(db, target(file), { chunkSize: 37 });
    assert.equal(r.events, 60);
    assert.equal(db.getFile(file).offset, Buffer.byteLength(conteudo));

    const cwds = db.raw.prepare("SELECT DISTINCT cwd FROM events ORDER BY cwd").all();
    assert.equal(cwds.length, 60);
    for (const row of cwds) {
      assert.ok(row.cwd.includes("programação-🚀"), `cwd corrompido: ${row.cwd}`);
      assert.ok(!row.cwd.includes("�"), "apareceu caractere de substituição");
    }
  });
});

test("reader: reprocessar o mesmo arquivo não duplica nada", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "sessao.jsonl");
    fs.writeFileSync(file, Array.from({ length: 20 }, (_, i) => claudeLine({ id: `m${i}`, req: `r${i}` })).join(""));

    assert.equal(ingestFile(db, target(file)).events, 20);
    assert.equal(ingestFile(db, target(file)).events, 0, "nada novo, o offset já cobre o arquivo");

    // Mesmo forçando releitura do zero, o dedup segura.
    db.raw.exec("UPDATE files SET offset = 0, head_sig = NULL");
    assert.equal(ingestFile(db, target(file)).events, 0, "UNIQUE(event_key) absorve");
    assert.equal(db.countEvents(), 20);
  });
});

test("reader: arquivo truncado reseta o cursor sem recontar", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "sessao.jsonl");
    const linhas = Array.from({ length: 10 }, (_, i) => claudeLine({ id: `m${i}`, req: `r${i}` }));
    fs.writeFileSync(file, linhas.join(""));
    ingestFile(db, target(file));
    assert.equal(db.countEvents(), 10);

    // O arquivo encolheu: rotação ou truncamento. O offset antigo aponta para lixo.
    fs.writeFileSync(file, linhas.slice(0, 3).join(""));
    const r = ingestFile(db, target(file));
    assert.equal(r.reset, true, "precisa detectar o encolhimento");
    assert.equal(r.events, 0, "os 3 eventos já eram conhecidos");
    assert.equal(db.countEvents(), 10, "os eventos antigos não somem");
  });
});

test("reader: reescrita que preserva o inode é pega pela assinatura do cabeçalho", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "sessao.jsonl");
    const antigo = Array.from({ length: 5 }, (_, i) => claudeLine({ id: `a${i}`, req: `ra${i}` })).join("");
    fs.writeFileSync(file, antigo);
    ingestFile(db, target(file));

    // Conteúdo totalmente diferente, mesmo tamanho aproximado — só o head_sig denuncia.
    const novo = Array.from({ length: 8 }, (_, i) => claudeLine({ id: `b${i}`, req: `rb${i}` })).join("");
    fs.writeFileSync(file, novo);
    const r = ingestFile(db, target(file));
    assert.equal(r.reset, true);
    assert.equal(r.events, 8, "o conteúdo novo foi lido desde o início");
  });
});

test("reader: arquivo que sumiu vira 'missing' sem perder os eventos", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "sessao.jsonl");
    fs.writeFileSync(file, claudeLine({ id: "m1", req: "r1" }));
    const alvo = target(file);
    ingestFile(db, alvo);
    assert.equal(db.countEvents(), 1);

    fs.rmSync(file);
    const r = ingestFile(db, alvo);
    assert.equal(r.events, 0);
    assert.equal(db.getFile(file).state, "missing");
    assert.equal(db.countEvents(), 1, "histórico preservado");
    assert.deepEqual(db.listActiveFiles(), [], "sai do scan ativo");
  });
});

test("reader: cursor do Codex atravessa chunks e execuções", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "rollout.jsonl");
    const meta = `${JSON.stringify({
      timestamp: "2026-07-27T14:00:00.000Z",
      type: "session_meta",
      payload: { id: "roll-1", cwd: "/home/ftgk/cockpit" },
    })}\n`;
    const ctx = `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } })}\n`;
    const tick = (total, last) => `${JSON.stringify({
      timestamp: "2026-07-27T14:05:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: total / 10, total_tokens: total },
          last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: last / 10, total_tokens: last },
        },
      },
    })}\n`;

    fs.writeFileSync(file, meta + ctx + tick(100, 100));
    assert.equal(ingestFile(db, target(file, "codex"), { chunkSize: 64 }).events, 1);

    // Nova execução, arquivo cresceu: o modelo e o `prev` vêm do cursor persistido.
    fs.appendFileSync(file, tick(300, 200));
    assert.equal(ingestFile(db, target(file, "codex"), { chunkSize: 64 }).events, 1);

    const rows = db.raw.prepare("SELECT model, input_tokens, output_tokens FROM events ORDER BY id").all();
    assert.deepEqual(rows.map((r) => r.model), ["gpt-5.5", "gpt-5.5"], "modelo sobreviveu ao reinício");
    assert.equal(rows[1].input_tokens, 200, "contou o delta, não o total");
    assert.equal(rows[1].output_tokens, 20);
  });
});

test("reader: JSON inválido incrementa bad_lines e não derruba a passada", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "sessao.jsonl");
    fs.writeFileSync(
      file,
      claudeLine({ id: "m1", req: "r1" })
        + '{"type":"assistant","message":{"usage":{ ISSO NÃO É JSON\n'
        + claudeLine({ id: "m2", req: "r2" }),
    );
    const r = ingestFile(db, target(file));
    assert.equal(r.events, 2, "as linhas boas passam");
    assert.equal(db.getFile(file).bad_lines, 1);
  });
});

test("reader: eventos saem precificados e atribuídos ao projeto", () => {
  sandbox(({ db, dir }) => {
    const file = path.join(dir, "sessao.jsonl");
    fs.writeFileSync(file, claudeLine({ id: "m1", req: "r1", cwd: "/home/ftgk/cockpit/lib/usage" }));

    const priceBook = {
      priceEvent: () => ({ cost_usd: 1.25, price_source: "litellm", price_rev: 9 }),
    };
    ingestFile(db, target(file), {
      priceBook,
      projectResolver: new ProjectResolver([{ id: "cockpit", path: "/home/ftgk/cockpit" }]),
    });

    const row = db.raw.prepare("SELECT * FROM events").get();
    assert.equal(row.project_id, "cockpit");
    assert.equal(row.cost_usd, 1.25);
    assert.equal(row.price_source, "litellm");
    assert.equal(row.price_rev, 9);
    assert.ok(row.hour_utc > 0);
  });
});

// -------------------------------------------------------------- ProjectResolver

test("resolver: prefixo mais longo vence e o separador impede casamento parcial", () => {
  const resolver = new ProjectResolver([
    { id: "raiz", path: "/home/ftgk/Documentos" },
    { id: "app", path: "/home/ftgk/Documentos/app" },
    { id: "proj", path: "/home/ftgk/proj" },
  ]);

  assert.equal(resolver.resolve("/home/ftgk/Documentos/app/src"), "app", "o aninhado vence o pai");
  assert.equal(resolver.resolve("/home/ftgk/Documentos/outro"), "raiz");
  assert.equal(resolver.resolve("/home/ftgk/proj"), "proj", "o próprio diretório do projeto");
  assert.equal(resolver.resolve("/home/ftgk/projeto2"), NO_PROJECT, "prefixo textual não basta");
  assert.equal(resolver.resolve("/tmp/fora"), NO_PROJECT);
  assert.equal(resolver.resolve(null), NO_PROJECT);
  assert.equal(resolver.resolve(""), NO_PROJECT);
});

test("resolver: normaliza barra final e caminhos relativos, e invalida o cache", () => {
  const resolver = new ProjectResolver([{ id: "cockpit", path: "/home/ftgk/cockpit/" }]);
  assert.equal(resolver.resolve("/home/ftgk/cockpit"), "cockpit");
  assert.equal(resolver.resolve("/home/ftgk/cockpit/lib/../public"), "cockpit");

  resolver.setProjects([{ id: "outro", path: "/home/ftgk/cockpit" }]);
  assert.equal(resolver.resolve("/home/ftgk/cockpit"), "outro", "o cache foi invalidado");

  resolver.setProjects([]);
  assert.equal(resolver.resolve("/home/ftgk/cockpit"), NO_PROJECT);
});

test("resolver: repositório não cadastrado vira projeto próprio, com id estável", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-resolver-"));
  const db = new UsageDb({ dbPath: path.join(home, "usage.db") }).open();
  const repo = path.join(home, "Documentos", "GitHub", "sigep");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "app", "src"), { recursive: true });

  const resolver = new ProjectResolver([], { db, homeDir: home });
  const id = resolver.resolve(path.join(repo, "app", "src"));

  assert.equal(id, "~sigep", "sobe do subdiretório até a raiz do repositório");
  assert.equal(resolver.resolve(repo), id, "a raiz e o subdiretório caem no mesmo projeto");

  const registro = db.derivedProjectByPath(repo);
  assert.equal(registro.label, "sigep");
  assert.equal(registro.path, repo);

  // Um resolver novo sobre o mesmo banco reencontra o id, em vez de recriar outro.
  assert.equal(new ProjectResolver([], { db, homeDir: home }).resolve(repo), "~sigep");

  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("resolver: projeto cadastrado vence o derivado, e o home não vira projeto", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-resolver-"));
  const db = new UsageDb({ dbPath: path.join(home, "usage.db") }).open();
  const repo = path.join(home, "cockpit");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const resolver = new ProjectResolver([{ id: "cockpit", path: repo }], { db, homeDir: home });
  assert.equal(resolver.resolve(repo), "cockpit", "o cadastro tem precedência");
  assert.equal(db.derivedProjectByPath(repo), null, "nem chega a registrar derivado");

  // O próprio home não é repositório: continua sem projeto.
  assert.equal(resolver.resolve(home), NO_PROJECT);
  assert.equal(resolver.resolve("/tmp"), NO_PROJECT, "fora do home também não");

  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("resolver: dois repositórios de mesmo nome não se misturam", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-resolver-"));
  const db = new UsageDb({ dbPath: path.join(home, "usage.db") }).open();
  const a = path.join(home, "clienteA", "painel");
  const b = path.join(home, "clienteB", "painel");
  for (const dir of [a, b]) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  const resolver = new ProjectResolver([], { db, homeDir: home });
  const idA = resolver.resolve(a);
  const idB = resolver.resolve(b);

  assert.equal(idA, "~painel");
  assert.notEqual(idB, idA, "o segundo ganha sufixo em vez de somar no custo do primeiro");
  assert.match(idB, /^~painel-[0-9a-f]{6}$/);
  assert.equal(resolver.resolve(b), idB, "o desempate é determinístico");

  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------- scan e roots

test("scan: acha os dois roots do Claude e ignora o que não existe", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-home-"));
  try {
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cockpit", "claude", "projects"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });

    const roots = discoverRoots(home);
    assert.deepEqual(roots.map((r) => r.tag).sort(), ["claude-cockpit", "claude-home", "codex-home"]);
    assert.equal(
      roots.filter((r) => r.provider === "claude").length,
      2,
      "o perfil isolado do broker guarda metade do histórico",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("scan: recursivo, só .jsonl, mais recentes primeiro", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-home-"));
  try {
    const base = path.join(home, ".claude", "projects", "-home-ftgk-cockpit");
    fs.mkdirSync(path.join(base, "sub", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(base, "a.jsonl"), "");
    fs.writeFileSync(path.join(base, "sub", "subagents", "b.jsonl"), "");
    fs.writeFileSync(path.join(base, "ignorar.json"), "");
    fs.writeFileSync(path.join(base, "README.md"), "");

    fs.utimesSync(path.join(base, "a.jsonl"), new Date(1000), new Date(1000));
    fs.utimesSync(path.join(base, "sub", "subagents", "b.jsonl"), new Date(9000), new Date(9000));

    const found = scanRoots(discoverRoots(home));
    assert.deepEqual(found.map((f) => path.basename(f.path)), ["b.jsonl", "a.jsonl"], "mtime desc");
    assert.ok(found.every((f) => f.provider === "claude" && f.ino));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("reader: passada completa ingere, agrega e reporta progresso", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-usage-home-"));
  const db = new UsageDb({ dbPath: path.join(home, "usage.db") }).open();
  try {
    const base = path.join(home, ".claude", "projects", "-p");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, "s.jsonl"),
      Array.from({ length: 12 }, (_, i) => claudeLine({ id: `x${i}`, req: `rx${i}` })).join(""),
    );

    const reader = new UsageReader({ db, homeDir: home })
      .setProjects([{ id: "cockpit", path: "/home/ftgk/cockpit" }]);

    const progresso = [];
    const stats = reader.runOnce({ onProgress: (p) => progresso.push(p), progressEveryMs: 0 });

    assert.equal(stats.events, 12);
    assert.equal(stats.pending, 1);
    assert.ok(stats.rolledBuckets >= 1, "o rollup rodou");
    assert.ok(progresso.at(-1).done, "o último progresso marca a conclusão");
    assert.equal(db.raw.prepare("SELECT requests FROM hourly").get().requests, 12);
    assert.equal(db.raw.prepare("SELECT project_id FROM hourly").get().project_id, "cockpit");

    // Segunda passada sem mudança no disco: nada a fazer.
    const segunda = reader.runOnce();
    assert.equal(segunda.pending, 0);
    assert.equal(segunda.events, 0);
  } finally {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
