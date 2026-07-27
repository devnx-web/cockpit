import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalLicenseRetry,
  formatTerminalLicenseDelay,
  requireFreshTerminalSelections,
  terminalLicenseRetryDelay,
} from "../lib/team-terminal-license.js";

test("terminal license retries use 10s, 30s, 1min, 2min, then every minute", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(terminalLicenseRetryDelay),
    [10_000, 30_000, 60_000, 120_000, 60_000, 60_000],
  );
  assert.equal(formatTerminalLicenseDelay(10_000), "10s");
  assert.equal(formatTerminalLicenseDelay(30_000), "30s");
  assert.equal(formatTerminalLicenseDelay(60_000), "1min");
  assert.equal(formatTerminalLicenseDelay(120_000), "2min");
});

test("a terminal requires both internal provider selections but exposes only Ailiv branding", () => {
  assert.throws(
    () => requireFreshTerminalSelections({ connected: false, selections: [] }),
    /não conectado/,
  );
  assert.throws(
    () => requireFreshTerminalSelections({
      connected: true,
      selections: [{ provider: "openai" }],
      warnings: ["serviço central indisponível"],
    }),
    /licenças Ailiv: serviço central indisponível/,
  );
  assert.doesNotThrow(() => requireFreshTerminalSelections({
    connected: true,
    selections: [{ provider: "openai" }, { provider: "claude" }],
    warnings: [],
  }));
});

test("retry controller keeps trying until online licenses arrive and can be cancelled", async () => {
  const scheduled = [];
  const failures = [];
  const attempts = [];
  let calls = 0;
  let successes = 0;
  const retry = createTerminalLicenseRetry({
    attempt: async () => {
      calls += 1;
      if (calls < 4) throw new Error(`offline-${calls}`);
      return { connected: true };
    },
    onAttempt: (state) => attempts.push(state.attempt),
    onFailure: (error, state) => failures.push([error.message, state.delayMs]),
    onSuccess: () => { successes += 1; },
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule: (timer) => { timer.cancelled = true; },
  });

  retry.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [["offline-1", 10_000]]);

  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(attempts, [1, 2, 3, 4]);
  assert.deepEqual(failures, [
    ["offline-1", 10_000],
    ["offline-2", 30_000],
    ["offline-3", 60_000],
  ]);
  assert.equal(successes, 1);
  assert.deepEqual(retry.status(), {
    cancelled: false,
    running: false,
    failures: 0,
    scheduled: false,
  });

  const pending = [];
  const cancellable = createTerminalLicenseRetry({
    attempt: async () => { throw new Error("offline"); },
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      pending.push(timer);
      return timer;
    },
    cancelSchedule: (timer) => { timer.cancelled = true; },
  });
  cancellable.start();
  await new Promise((resolve) => setImmediate(resolve));
  cancellable.cancel();
  assert.equal(pending[0].cancelled, true);
  pending[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellable.status().cancelled, true);
});
