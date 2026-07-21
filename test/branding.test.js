import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Cockpit presents managed engines as Ailiv C and Ailiv G while retaining internal commands", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const projects = JSON.parse(fs.readFileSync(path.join(ROOT, "projects.json"), "utf8"));
  const ailivCCommands = projects.flatMap((project) => project.commands || [])
    .filter((command) => command.cmd.startsWith("claude"));
  const ailivGCommands = projects.flatMap((project) => project.commands || [])
    .filter((command) => command.cmd.startsWith("codex"));

  assert.ok(ailivCCommands.length > 0);
  assert.ok(ailivGCommands.length > 0);
  assert.ok(ailivCCommands.every((command) => command.label === "ailiv c"));
  assert.ok(ailivGCommands.every((command) => command.label === "ailiv g"));
  assert.ok(projects.every((project) => !/claude/i.test(project.name)));
  assert.match(html, /Iniciar Ailiv C aqui/);
  assert.match(html, /\["claude", "Ailiv C", selected\.claude\]/);
  assert.match(html, /\["codex", "Ailiv G", selected\.openai\]/);
  assert.doesNotMatch(html, /Iniciar agente Claude Code aqui/);
});

test("consumption panel removed — never renders managed account identities", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  // A seção "Consumo" foi removida em definitivo (o backend cuida do consumo).
  assert.doesNotMatch(html, /<span>Consumo<\/span>/);
  assert.doesNotMatch(html, /id="usageRows"/);
  // Continua valendo: nenhuma identidade de conta gerenciada é renderizada.
  assert.doesNotMatch(html, /usage-acc-name/);
  assert.doesNotMatch(html, /title="\$\{acc\.email\}"/);
});
