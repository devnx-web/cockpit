import assert from "node:assert/strict";
import test from "node:test";

import { findProjects, normalizeText, tokenize } from "../lib/project-search.js";

const PHD = [
  { id: "academia-phd-ia", name: "PHD IA", description: "Agente de vendas da PHD" },
  { id: "academi-phd", name: "PHD Financeiro", description: "Financeiro da academia PHD" },
  { id: "phd-control", name: "PHD Control", description: "Painel central da PHD" },
  { id: "phd-control-back", name: "PHD Control Back", description: "API do painel da PHD" },
  { id: "phd-copa", name: "PHD Copa", description: "Site da copa 2027" },
  { id: "phd-envios", name: "PHD Envios", description: "Campanhas de envio" },
  { id: "phd-call", name: "PHD Call", description: "Discador" },
  { id: "phd-sports-vendas", name: "PHD Sports Vendas", description: "Loja" },
];

test("normalizeText tira acento, caixa e pontuação", () => {
  assert.equal(normalizeText("Análise de Créditos!"), "analise de creditos");
  assert.equal(normalizeText("PHD—Control"), "phd control");
  assert.equal(normalizeText(null), "");
  assert.deepEqual(tokenize("  Rede   Urbana "), ["rede", "urbana"]);
});

test("busca genérica entre projetos parecidos é ambígua", () => {
  const { candidates, ambiguous } = findProjects(PHD, "phd");
  assert.equal(ambiguous, true);
  assert.ok(candidates.length > 1);
  // todos empatam: nenhum se destaca o bastante para agir sozinho
  assert.ok(candidates[1].score >= candidates[0].score * 0.85);
});

test("nome completo desempata e deixa de ser ambíguo", () => {
  const { candidates, ambiguous } = findProjects(PHD, "PHD Financeiro");
  assert.equal(candidates[0].project.id, "academi-phd");
  assert.equal(ambiguous, false);
});

test("acento na busca não impede o match", () => {
  const projects = [{ id: "credito", name: "Análise de Crédito", description: "motor de score" }];
  const { candidates, ambiguous } = findProjects(projects, "analise de credito");
  assert.equal(candidates[0].project.id, "credito");
  assert.equal(ambiguous, false);
});

test("alias exato vence nome parcial", () => {
  const projects = [
    { id: "rede-urbana", name: "Rede Urbana", description: "portal" },
    { id: "urbana-ia", name: "Rede Urbana IA", aliases: ["gralha"], description: "agente" },
  ];
  const { candidates, ambiguous } = findProjects(projects, "gralha");
  assert.equal(candidates[0].project.id, "urbana-ia");
  assert.equal(candidates.length, 1);
  assert.equal(ambiguous, false);
});

test("stack e descrição pontuam menos que nome", () => {
  const projects = [
    { id: "loja", name: "Loja", stack: ["next", "supabase"], description: "e-commerce" },
    { id: "next-docs", name: "Next Docs", description: "documentação" },
  ];
  const { candidates } = findProjects(projects, "next");
  assert.equal(candidates[0].project.id, "next-docs");
  assert.deepEqual(candidates[1].matchedOn, ["stack"]);
});

test("projeto sem descrição nunca é resposta confiável", () => {
  const projects = [{ id: "cockpit", name: "Cockpit" }];
  const { candidates, ambiguous } = findProjects(projects, "cockpit");
  assert.equal(candidates[0].project.id, "cockpit");
  assert.equal(ambiguous, true, "sem descrição não dá para confirmar que é o projeto certo");
});

test("busca vazia ou sem match devolve lista vazia e ambiguidade", () => {
  for (const query of ["", "   ", "!!!", "projeto-que-nao-existe"]) {
    const { candidates, ambiguous } = findProjects(PHD, query);
    assert.deepEqual(candidates, [], `query ${JSON.stringify(query)}`);
    assert.equal(ambiguous, true);
  }
  assert.deepEqual(findProjects(null, "phd").candidates, []);
});

test("limit é respeitado e sanitizado", () => {
  assert.equal(findProjects(PHD, "phd", { limit: 3 }).candidates.length, 3);
  assert.equal(findProjects(PHD, "phd", { limit: 0 }).candidates.length, 5);
  assert.ok(findProjects(PHD, "phd", { limit: 999 }).candidates.length <= 8);
});
