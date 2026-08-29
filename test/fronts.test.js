import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFrontStore, defaultFrontsPath, normalizeTitle } from "../lib/fronts.js";

function bancada() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fronts-"));
  const filePath = path.join(dir, "fronts.json");
  const store = createFrontStore({ filePath, log: () => {} });
  store.load();
  return { dir, filePath, store };
}

test("o mesmo título no mesmo projeto reencontra o mesmo uid", () => {
  const { store } = bancada();

  const a = store.ensure("educari", "BI e indicadores");
  const b = store.ensure("educari", "BI e indicadores");

  assert.equal(b.uid, a.uid);
  assert.equal(store.list("educari").length, 1);
});

test("caixa e espaço não fazem frente nova", () => {
  const { store } = bancada();

  // Quem digita "  BI  e  Indicadores " está reabrindo a mesma janela de
  // trabalho, não abrindo uma segunda.
  const a = store.ensure("educari", "BI e indicadores");
  const b = store.ensure("educari", "  BI  e  Indicadores ");

  assert.equal(b.uid, a.uid);
  assert.equal(normalizeTitle("  BI  e  Indicadores "), "bi e indicadores");
});

test("projetos diferentes com o mesmo título são frentes diferentes", () => {
  const { store } = bancada();

  const a = store.ensure("educari", "BI e indicadores");
  const b = store.ensure("cockpit", "BI e indicadores");

  assert.notEqual(b.uid, a.uid);
});

test("renomear preserva o uid", () => {
  const { store } = bancada();

  // É o motivo do arquivo existir: antes, renomear na interface fazia o vigia
  // parar de acordar em silêncio, porque a chave era o próprio título.
  const antes = store.ensure("educari", "BI e indicadores");
  const depois = store.rename(antes.uid, "BI e indicadores (fase 2)");

  assert.equal(depois.uid, antes.uid);
  assert.equal(depois.title, "BI e indicadores (fase 2)");
  // E o título velho deixa de endereçar a frente: pedir por ele cria outra.
  assert.notEqual(store.ensure("educari", "BI e indicadores").uid, antes.uid);
});

test("renomear para o título de outra frente devolve aquela frente", () => {
  const { store } = bancada();

  const bi = store.ensure("educari", "BI e indicadores");
  const auditoria = store.ensure("educari", "Auditoria");

  const resultado = store.rename(auditoria.uid, "BI e indicadores");

  assert.equal(resultado.uid, bi.uid);
  // A frente renomeada continua existindo com o nome antigo — nada é apagado.
  assert.equal(store.byUid(auditoria.uid).title, "Auditoria");
});

test("o registro sobrevive a recarregar do disco", async () => {
  const { filePath, store } = bancada();

  const antes = store.ensure("educari", "BI e indicadores");
  await store.close();

  const outro = createFrontStore({ filePath, log: () => {} });
  outro.load();

  // Reiniciar o Cockpit recicla `t1`; a frente é justamente o que não recicla.
  assert.equal(outro.ensure("educari", "BI e indicadores").uid, antes.uid);
});

test("arquivo ilegível não impede o Cockpit de abrir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fronts-"));
  const filePath = path.join(dir, "fronts.json");
  fs.writeFileSync(filePath, "{ isto não é json");

  const store = createFrontStore({ filePath, log: () => {} });
  store.load();

  assert.deepEqual(store.list(), []);
  assert.ok(store.ensure("educari", "BI e indicadores").uid);
});

test("o arquivo fica ao lado do projects.json", () => {
  assert.equal(
    defaultFrontsPath("/home/alguem/.cockpit/projects.json"),
    "/home/alguem/.cockpit/fronts.json",
  );
});
