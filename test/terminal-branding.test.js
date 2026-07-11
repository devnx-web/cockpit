import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadBranding() {
  const context = vm.createContext({});
  const source = fs.readFileSync(path.join(ROOT, "public", "terminal-branding.js"), "utf8");
  vm.runInContext(source, context);
  return context.CockpitTerminalBranding;
}

test("Ailiv G terminal aliases are display-only and abbreviate future model families", () => {
  const branding = loadBranding();
  const key = "project:terminal";

  assert.equal(branding.transformOutput(key, "ordinary gpt-5.6-sol log"), "ordinary gpt-5.6-sol log");
  branding.observeInput(key, "codex --dangerously-bypass-approvals-and-sandbox\r");

  const branded = branding.transformOutput(
    key,
    "OpenAI Codex | Codex can now | gpt-5.6-sol xhigh | YOLO mode | gpt-6.1-terra",
  );

  assert.match(branded, /Ailiv G \| Ailiv G can now/);
  assert.match(branded, /g-5\.6-s\s+xhigh/);
  assert.match(branded, /modo automático/);
  assert.match(branded, /g-6\.1-t/);
  assert.equal(branding.modelAlias("gpt-5.1-codex-max").trimEnd(), "g-5.1-c-m");
});

test("Ailiv G header can activate aliases when replaying an existing terminal buffer", () => {
  const branding = loadBranding();
  const output = branding.transformOutput("project:replay", "Ailiv G (v1) model: gpt-5.6-sol");

  assert.match(output, /Ailiv G \(v1\) model: g-5\.6-s/);
});
