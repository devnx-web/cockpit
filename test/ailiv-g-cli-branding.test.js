import assert from "node:assert/strict";
import test from "node:test";

import {
  AILIV_G_CLI_BRAND_REPLACEMENTS,
  applyAilivGCliBranding,
  hasAilivGCliBranding,
} from "../lib/ailiv-g-cli-branding.js";

test("Ailiv G CLI branding preserves binary length and replaces visual signatures", () => {
  for (const { source, replacement } of AILIV_G_CLI_BRAND_REPLACEMENTS) {
    assert.equal(source.length, replacement.length);
  }

  const fixture = Buffer.concat(
    AILIV_G_CLI_BRAND_REPLACEMENTS.flatMap(({ source }) => [source, Buffer.from("\0")]),
  );
  const result = applyAilivGCliBranding(fixture);

  assert.equal(result.output.length, fixture.length);
  assert.equal(result.total, AILIV_G_CLI_BRAND_REPLACEMENTS.length);
  assert.equal(hasAilivGCliBranding(result.output), true);
  for (const { source, replacement } of AILIV_G_CLI_BRAND_REPLACEMENTS) {
    assert.equal(result.output.includes(source), false);
    assert.equal(result.output.includes(replacement), true);
  }
  assert.match(result.output.toString("utf8"), /Ailiv G\u034f/);
});
