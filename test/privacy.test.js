import assert from "node:assert/strict";
import test from "node:test";

import { redactStream, neutralizeLabel, redactCells } from "../public/privacy.js";

test("redactStream: desligado retorna o texto intacto", () => {
  const input = "Claude Code v2.1.206 · Opus 4.8 (1M context)";
  assert.equal(redactStream(input, false), input);
});

test("redactStream: entrada vazia/nula é segura", () => {
  assert.equal(redactStream("", true), "");
  assert.equal(redactStream(null, true), null);
});

test("redactStream: redige o banner do Claude Code", () => {
  const out = redactStream("Claude Code v2.1.206", true);
  assert.doesNotMatch(out, /Claude/i);
  assert.match(out, /v2\.1\.206/); // versão preservada
});

test("redactStream: redige a statusline do Claude", () => {
  const out = redactStream("Opus 4.8 (1M context) with high effort · Claude Max", true);
  assert.doesNotMatch(out, /Opus/i);
  assert.doesNotMatch(out, /Claude/i);
  assert.doesNotMatch(out, /1M context/i);
  assert.doesNotMatch(out, /effort/i);
});

test("redactStream: redige o box do Codex", () => {
  const out = redactStream("OpenAI Codex (v0.144.1)", true);
  assert.doesNotMatch(out, /Codex/i);
  assert.doesNotMatch(out, /OpenAI/i);
});

test("redactStream: redige o modelo gpt e o YOLO mode", () => {
  const out = redactStream("gpt-5.6-sol default · YOLO mode", true);
  assert.doesNotMatch(out, /gpt-5/i);
  assert.doesNotMatch(out, /YOLO/i);
});

test("redactStream: redige Kimi", () => {
  assert.doesNotMatch(redactStream("Kimi --yolo", true), /Kimi/i);
});

test("neutralizeLabel: rótulos de marca viram Agent numerado", () => {
  assert.equal(neutralizeLabel("claude", true), "Agent 1");
  assert.equal(neutralizeLabel("codex", true), "Agent 2");
  assert.equal(neutralizeLabel("kimi", true), "Agent 3");
});

test("neutralizeLabel: rótulo não-marca passa intacto", () => {
  assert.equal(neutralizeLabel("npm dev", true), "npm dev");
});

test("neutralizeLabel: desligado passa intacto", () => {
  assert.equal(neutralizeLabel("claude", false), "claude");
});

test("neutralizeLabel: string composta com marca é redigida via patterns", () => {
  const out = neutralizeLabel("claude --dangerously-skip-permissions", true);
  assert.doesNotMatch(out, /claude/i);
});

// redactCells: usado na sobrescrita de células do xterm (TUI). Precisa BLANKAR a
// marca preservando EXATAMENTE o comprimento, para não deslocar as colunas.
test("redactCells: blanka a marca preservando o comprimento", () => {
  const inp = "Opus 4.8 (1M context) with high effort · Claude Max";
  const out = redactCells(inp, true);
  assert.equal(out.length, inp.length);
  assert.doesNotMatch(out, /Opus|Claude|1M context|effort/i);
});

test("redactCells: statusline do codex blanqueada", () => {
  const inp = "gpt-5.6-sol default · YOLO mode";
  const out = redactCells(inp, true);
  assert.equal(out.length, inp.length);
  assert.doesNotMatch(out, /gpt-5|YOLO/i);
});

test("redactCells: desligado passa intacto", () => {
  assert.equal(redactCells("Opus 4.8", false), "Opus 4.8");
});

test("redactCells: texto sem marca fica idêntico", () => {
  assert.equal(redactCells("npm run dev", true), "npm run dev");
});

test("redactStream: redige identificadores do Kimi/Moonshot", () => {
  const out = redactStream("Kimi Code v0.20.2 · Model: K2.7 Code · moonshotai.github.io", true);
  assert.doesNotMatch(out, /Kimi/i);
  assert.doesNotMatch(out, /moonshot/i);
  assert.doesNotMatch(out, /\bK2\b|K2\.7/);
});

test("redactStream: redige ChatGPT e Anthropic", () => {
  assert.doesNotMatch(redactStream("Signed in with ChatGPT", true), /ChatGPT/i);
  assert.doesNotMatch(redactStream("Anthropic · Claude", true), /Anthropic|Claude/i);
});

test("redactStream: K2 minúsculo comum não é redigido (evita falso positivo)", () => {
  // 'k2s' como variável/rota não deve virar Agent — só o modelo K2 maiúsculo
  assert.equal(redactStream("const k2s = load()", true), "const k2s = load()");
});
