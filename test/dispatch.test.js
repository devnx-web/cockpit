import assert from "node:assert/strict";
import test from "node:test";

import { createDemandStore } from "../lib/demands.js";
import {
  DispatchError,
  createDispatcher,
  detectAgentReady,
  pickAgentPreset,
  sanitizeDemandText,
  sanitizeTerminalName,
} from "../lib/dispatch.js";

const TIMEOUTS = {
  createTerminalMs: 1000,
  waitShellMs: 1000,
  waitPromptMs: 500,
  promptQuietMs: 100,
  waitAgentMs: 2000,
  agentQuietMs: 300,
  agentMinBytes: 20,
  demandGapMs: 5,
};

const PROJECT = {
  id: "academi-phd",
  name: "PHD Financeiro",
  defaultAgent: "ailiv c",
  commands: [
    { label: "dev", cmd: "npm run dev" },
    { label: "ailiv c", cmd: "claude" },
    { label: "ailiv g", cmd: "codex" },
  ],
};

/**
 * Terminal falso com relógio virtual: o dispatcher só enxerga tempo pelo `now`
 * injetado, então dá para simular 60s de espera sem esperar 60s.
 */
function createHarness({ shellDelay = 0, script = [] } = {}) {
  let clock = 0;
  const terminals = new Map();
  const writes = [];
  let created = 0;
  let text = "";
  const pending = [...script];

  const adapter = {
    createTerminal: async (projectId, name) => {
      created += 1;
      const terminal = { id: `t${created}`, name, pty: shellDelay === 0 ? {} : null, exited: false };
      terminals.set(terminal.id, terminal);
      if (shellDelay > 0) {
        terminal.readyAt = clock + shellDelay;
      }
      return terminal;
    },
    getTerminal: (projectId, terminalId) => {
      const terminal = terminals.get(terminalId);
      if (terminal?.readyAt !== undefined && clock >= terminal.readyAt) terminal.pty = {};
      return terminal || null;
    },
    writeInput: async (projectId, terminalId, data) => {
      writes.push(data);
    },
  };

  return {
    adapter,
    writes,
    terminals,
    get created() {
      return created;
    },
    // cada "sleep" avança o relógio virtual e roda o próximo passo do roteiro
    build(demands) {
      return createDispatcher({
        adapter,
        demands,
        readTail: () => text,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          const step = pending[0];
          if (step && clock >= step.at) {
            pending.shift();
            if (step.append) text += step.append;
            if (step.exit) terminals.get(step.exit).exited = true;
          }
        },
        timeouts: TIMEOUTS,
        // no teste, "tempo de parede" nunca estoura: quem manda é o relógio virtual
        wallClockTimeout: () => new Promise(() => {}),
      });
    },
  };
}

function newStore() {
  return createDemandStore({});
}

function newDemand(store) {
  return store.create({
    text: "vê o erro de build",
    title: "erro de build",
    projectId: PROJECT.id,
    projectName: PROJECT.name,
  });
}

test("pickAgentPreset respeita pedido, defaultAgent e palpite", () => {
  assert.equal(pickAgentPreset(PROJECT, "ailiv g").cmd, "codex");
  assert.equal(pickAgentPreset(PROJECT, "AILIV G").cmd, "codex", "casa sem caixa/acento");
  assert.equal(pickAgentPreset(PROJECT).cmd, "claude", "cai no defaultAgent");

  const semDefault = { ...PROJECT, defaultAgent: "" };
  assert.equal(pickAgentPreset(semDefault).cmd, "claude", "palpita pelo nome do comando");
});

test("pickAgentPreset falha em vez de inventar comando", () => {
  assert.throws(() => pickAgentPreset({ commands: [] }), (e) => e.code === "NO_AGENT_PRESET");
  assert.throws(
    () => pickAgentPreset(PROJECT, "não existe"),
    (e) => e instanceof DispatchError && e.code === "NO_AGENT_PRESET",
  );
  assert.throws(
    () => pickAgentPreset({ commands: [{ label: "dev", cmd: "npm run dev" }] }),
    (e) => e.code === "NO_AGENT_PRESET",
  );
});

test("detectAgentReady: silêncio prova, regex só encurta", () => {
  const t = TIMEOUTS;
  assert.deepEqual(detectAgentReady("oi", { bytes: 5, quietMs: 9999, timeouts: t }), {
    ready: false,
    failed: false,
  }, "pouca saída não conta, por mais silêncio que tenha");

  assert.equal(detectAgentReady("banner longo…", { bytes: 500, quietMs: 400, timeouts: t }).ready, true);
  assert.equal(
    detectAgentReady("│ > ", { bytes: 500, quietMs: 0, timeouts: t }).via,
    "prompt",
    "prompt conhecido dispensa esperar o silêncio",
  );
  const failed = detectAgentReady("bash: claude: command not found", {
    bytes: 500,
    quietMs: 0,
    timeouts: t,
  });
  assert.equal(failed.failed, true);
});

test("sanitizadores", () => {
  assert.equal(sanitizeTerminalName("  erro  de   build  "), "erro de build");
  assert.equal(sanitizeTerminalName(""), "Demanda");
  assert.equal(sanitizeDemandText("linha um\nlinha dois\r\x00"), "linha um linha dois");
  assert.equal(sanitizeDemandText("x".repeat(5000)).length, 4000);
});

test("caminho feliz: terminal, agente e demanda entregue", async () => {
  const store = newStore();
  const demand = newDemand(store);
  const harness = createHarness({
    script: [{ at: 300, append: "banner do agente ".repeat(10) }],
  });
  const dispatcher = harness.build(store);

  const result = await dispatcher.run(demand, PROJECT, { label: "ailiv c", cmd: "claude" });

  assert.equal(result.status, "working");
  assert.equal(result.stage, "handed_off");
  assert.equal(result.terminalId, "t1");
  assert.notEqual(result.dispatchedAt, null, "registra quando o despacho começou");
  assert.deepEqual(harness.writes, ["claude\r", "vê o erro de build", "\r"]);
  // a partir daqui o status do terminal passa a mandar na demanda
  store.onTerminalStatus(PROJECT.id, "t1", "idle", "ocioso · 40s");
  assert.equal(store.get(demand.id).status, "done");
});

test("shell que não sobe falha sem matar o terminal", async () => {
  const store = newStore();
  const demand = newDemand(store);
  const harness = createHarness({ shellDelay: 999_999 });
  const dispatcher = harness.build(store);

  const result = await dispatcher.run(demand, PROJECT, { label: "ailiv c", cmd: "claude" });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "SHELL_TIMEOUT");
  assert.equal(result.terminalId, "t1", "o terminal continua de pé para assumir na mão");
  assert.equal(harness.terminals.get("t1").exited, false);
  assert.deepEqual(harness.writes, [], "nada foi digitado num shell inexistente");
});

test("comando inexistente falha na hora, sem esperar o timeout do agente", async () => {
  const store = newStore();
  const demand = newDemand(store);
  const harness = createHarness({
    script: [{ at: 300, append: "bash: claude: command not found\n".repeat(5) }],
  });
  const dispatcher = harness.build(store);

  const result = await dispatcher.run(demand, PROJECT, { label: "ailiv c", cmd: "claude" });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "AGENT_FAILED");
  assert.equal(harness.writes.length, 1, "a demanda não foi digitada");
});

test("agente que só imprime banner e cala é dado como pronto", async () => {
  const store = newStore();
  const demand = newDemand(store);
  // nenhuma regex de prompt casa: quem resolve é o portão de silêncio
  const harness = createHarness({
    script: [{ at: 200, append: "=== agente exótico sem prompt conhecido ===\n" }],
  });
  const dispatcher = harness.build(store);

  const result = await dispatcher.run(demand, PROJECT, { label: "ailiv c", cmd: "claude" });

  assert.equal(result.status, "working");
  assert.equal(harness.writes.at(-1), "\r");
});

test("terminal que morre durante o boot do agente vira falha", async () => {
  const store = newStore();
  const demand = newDemand(store);
  const harness = createHarness({
    script: [{ at: 200, append: "subindo…", exit: "t1" }],
  });
  const dispatcher = harness.build(store);

  const result = await dispatcher.run(demand, PROJECT, { label: "ailiv c", cmd: "claude" });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "TERMINAL_EXITED");
});

test("demanda falha não é reaberta por status posterior do terminal", async () => {
  const store = newStore();
  const demand = newDemand(store);
  const harness = createHarness({ shellDelay: 999_999 });
  await harness.build(store).run(demand, PROJECT, { label: "ailiv c", cmd: "claude" });

  store.onTerminalStatus(PROJECT.id, "t1", "running", "processando…");
  assert.equal(store.get(demand.id).status, "failed");
});
