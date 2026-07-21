import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectProjectFiles,
  createFileSearchService,
  scoreFilePath,
  searchFilePaths,
} from "../lib/file-search.js";

test("file search ranks exact names, paths and fuzzy matches", () => {
  const paths = [
    "lib/team-accounts.js",
    "test/team-accounts.test.js",
    "docs/accounts.md",
    "README.md",
  ];

  assert.ok(scoreFilePath("team acc", "lib/team-accounts.js") != null);
  assert.ok(scoreFilePath("tma", "lib/team-accounts.js") != null);
  assert.equal(scoreFilePath("inexistente", "lib/team-accounts.js"), null);
  assert.equal(searchFilePaths(paths, "README").entries[0].path, "README.md");
  assert.equal(searchFilePaths(paths, "test team").entries[0].path, "test/team-accounts.test.js");
});

test("project indexing skips dependency/build directories and never follows symlinks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-file-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.js"), "main");
  fs.writeFileSync(path.join(root, "src", "nested", "ação.js"), "nested");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "ignored.js"), "ignored");
  fs.writeFileSync(path.join(root, ".git", "config"), "ignored");
  if (process.platform !== "win32") fs.symlinkSync(root, path.join(root, "src", "loop"));

  const index = await collectProjectFiles(root);

  assert.deepEqual(index.paths.sort(), ["src/main.js", "src/nested/ação.js"]);
  assert.equal(index.truncated, false);
  assert.equal(searchFilePaths(index.paths, "acao").entries[0].path, "src/nested/ação.js");
});

test("file search cache is refreshed after invalidation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-file-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "first.js"), "first");
  const service = createFileSearchService({ cacheTtlMs: 60_000 });

  assert.equal((await service.search(root, "first")).total, 1);
  fs.writeFileSync(path.join(root, "second.js"), "second");
  assert.equal((await service.search(root, "second")).total, 0);
  service.invalidate(root);
  assert.equal((await service.search(root, "second")).entries[0].path, "second.js");
});
