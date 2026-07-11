import assert from "node:assert/strict";
import test from "node:test";

import { interactiveTerminalEnv } from "../lib/terminal-env.js";

test("interactive terminals do not inherit no-color flags from the launcher", () => {
  const env = interactiveTerminalEnv(
    { PATH: "/bin", NO_COLOR: "1", COLOR: "0", TERM: "dumb" },
    {},
    { COCKPIT: "1" },
  );

  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.COLOR, undefined);
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.COCKPIT, "1");
});

test("a project may explicitly opt out of terminal colors", () => {
  const env = interactiveTerminalEnv(
    { NO_COLOR: "1", COLOR: "0" },
    { NO_COLOR: "1", COLOR: "0" },
  );

  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.COLOR, "0");
});
