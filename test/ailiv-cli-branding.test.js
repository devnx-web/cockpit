import assert from "node:assert/strict";
import test from "node:test";

import {
  AILIV_CLI_BRAND_REPLACEMENTS,
  applyAilivCliBranding,
  hasAilivCliBranding,
} from "../lib/ailiv-cli-branding.js";

test("Ailiv CLI branding preserves every byte length and replaces known visual signatures", () => {
  for (const { source, replacement } of AILIV_CLI_BRAND_REPLACEMENTS) {
    assert.equal(source.length, replacement.length);
  }

  const fixture = Buffer.concat(
    AILIV_CLI_BRAND_REPLACEMENTS.flatMap(({ source }) => [source, Buffer.from("\0")]),
  );
  const result = applyAilivCliBranding(fixture);

  assert.equal(result.output.length, fixture.length);
  assert.equal(result.total, AILIV_CLI_BRAND_REPLACEMENTS.length);
  assert.equal(hasAilivCliBranding(result.output), true);
  for (const { source, replacement } of AILIV_CLI_BRAND_REPLACEMENTS) {
    assert.equal(result.output.includes(source), false);
    assert.equal(result.output.includes(replacement), true);
  }
  assert.match(result.output.toString("utf8"), /O4\.8\u034f\u034f/);
  assert.match(result.output.toString("utf8"), /S5\u034f\u034f\u034f/);
});
