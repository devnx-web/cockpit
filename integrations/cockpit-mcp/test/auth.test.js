import assert from "node:assert/strict";
import test from "node:test";
import { hasValidBearer } from "../src/auth.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyz-1234567890";

test("Bearer auth accepts only the exact case-sensitive token", () => {
  assert.equal(hasValidBearer(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(hasValidBearer(`bearer ${TOKEN}`, TOKEN), false);
  assert.equal(hasValidBearer(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(hasValidBearer(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
  assert.equal(hasValidBearer(undefined, TOKEN), false);
});

test("Bearer auth rejects whitespace and alternate schemes", () => {
  assert.equal(hasValidBearer(`Bearer  ${TOKEN}`, TOKEN), false);
  assert.equal(hasValidBearer(`Bearer ${TOKEN} `, TOKEN), false);
  assert.equal(hasValidBearer(`Basic ${TOKEN}`, TOKEN), false);
});
