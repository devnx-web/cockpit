import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("file panel exposes an accessible quick-open search", () => {
  assert.match(html, /id="fileSearchInput"[^>]+role="combobox"/);
  assert.match(html, /aria-controls="fileTree"/);
  assert.match(html, /id="fileSearchStatus"[^>]+aria-live="polite"/);
  assert.match(html, /id="fileSearchClear"[^>]+aria-label="Limpar busca"/);
});

test("file search supports keyboard quick open and stale-response protection", () => {
  assert.match(html, /e\.key\.toLowerCase\(\) === "p"/);
  assert.match(html, /moveFileSearchSelection\(1\)/);
  assert.match(html, /openSelectedFileSearchResult\(\)/);
  assert.match(html, /msg\.requestId !== search\.requestId/);
  assert.match(html, /type: "search_files"/);
});

test("server handles search requests and refreshes its index after file changes", () => {
  assert.match(server, /case "search_files"/);
  assert.match(server, /fileSearch\.search\(session\.proj\.path/);
  assert.match(server, /fileSearch\.invalidate\(session\.proj\.path\)/);
});
