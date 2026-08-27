// Despacho de demanda: abrir terminal, subir o agente e entregar o pedido.
//
// Isso existe como ação composta no servidor porque, feito por fora (4 chamadas
// MCP com sleeps chutados), o timing erra: o shell demora a aparecer, o agente
// demora a mostrar o prompt, e o texto acaba digitado no vazio.
//
// A parte frágil é saber que o agente está pronto. A resposta primária é
// agnóstica a qual TUI: depois que ele imprimiu alguma coisa, um período de
// silêncio significa que parou de desenhar e está esperando. As regexes abaixo
// só encurtam essa espera — nunca são a única condição.
//
// Em qualquer falha o terminal fica de pé: quem pediu assume dali na mão.

const DEFAULT_TIMEOUTS = Object.freeze({
  createTerminalMs: 10_000,
  // licença online pode retryar antes do PTY existir (startTerminalLicenseProvisioning)
  waitShellMs: 45_000,
  waitPromptMs: 10_000,
  promptQuietMs: 400,
  waitAgentMs: 60_000,
  agentQuietMs: 1_500,
  agentMinBytes: 200,
  demandGapMs: 150,
});

const AGENT_HINT = /\b(ailiv|claude|codex|kimi|gemini|aider)\b/i;

/** Saída que prova que o comando não subiu — falha na hora, sem esperar timeout. */
const COMMAND_FAILED = /command not found|não encontrado|no such file or directory|permission denied/i;

/** Atalhos de "prompt pronto" de TUIs conhecidos. Otimização, não requisito. */
const AGENT_READY_HINTS = [/[│|]\s*>\s/, /^\s*[>❯]\s*$/m, /\? for shortcuts/i];

export function readTimeoutsFromEnv(env = process.env) {
  const read = (key, fallback) => {
    const raw = Number(env[`COCKPIT_DISPATCH_${key}`]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return Object.freeze({
    createTerminalMs: read("CREATE_MS", DEFAULT_TIMEOUTS.createTerminalMs),
    waitShellMs: read("SHELL_MS", DEFAULT_TIMEOUTS.waitShellMs),
    waitPromptMs: read("PROMPT_MS", DEFAULT_TIMEOUTS.waitPromptMs),
    promptQuietMs: read("PROMPT_QUIET_MS", DEFAULT_TIMEOUTS.promptQuietMs),
    waitAgentMs: read("AGENT_MS", DEFAULT_TIMEOUTS.waitAgentMs),
    agentQuietMs: read("AGENT_QUIET_MS", DEFAULT_TIMEOUTS.agentQuietMs),
    agentMinBytes: read("AGENT_MIN_BYTES", DEFAULT_TIMEOUTS.agentMinBytes),
    demandGapMs: read("DEMAND_GAP_MS", DEFAULT_TIMEOUTS.demandGapMs),
  });
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim();
}

export class DispatchError extends Error {
  constructor(code, message, stage) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Escolhe qual comando do projeto sobe o agente.
 * Nunca inventa comando: sem candidato, quem chamou deve perguntar.
 */
export function pickAgentPreset(project, requested = "") {
  const commands = Array.isArray(project?.commands) ? project.commands : [];
  if (commands.length === 0) {
    throw new DispatchError("NO_AGENT_PRESET", "projeto não tem comandos cadastrados", "preset");
  }

  const wanted = normalize(requested);
  if (wanted) {
    const match = commands.find(
      (c) => normalize(c.label) === wanted || normalize(c.cmd) === wanted,
    );
    if (match) return match;
    throw new DispatchError(
      "NO_AGENT_PRESET",
      `nenhum comando com o rótulo "${requested}" nesse projeto`,
      "preset",
    );
  }

  const preferred = normalize(project?.defaultAgent);
  if (preferred) {
    const match = commands.find((c) => normalize(c.label) === preferred);
    if (match) return match;
  }

  const guessed = commands.find((c) => AGENT_HINT.test(c.label) || AGENT_HINT.test(c.cmd));
  if (guessed) return guessed;

  throw new DispatchError(
    "NO_AGENT_PRESET",
    "nenhum comando do projeto parece subir um agente",
    "preset",
  );
}

/**
 * Decide se o agente já está pronto para receber a demanda.
 * `quietMs` é o tempo desde a última saída; `bytes`, o quanto já foi impresso
 * desde o comando.
 */
export function detectAgentReady(text, { bytes, quietMs, timeouts = DEFAULT_TIMEOUTS }) {
  if (COMMAND_FAILED.test(text)) {
    return { ready: false, failed: true, reason: "o comando do agente não existe nesse ambiente" };
  }
  if (bytes < timeouts.agentMinBytes) return { ready: false, failed: false };
  if (quietMs >= timeouts.agentQuietMs) return { ready: true, failed: false, via: "silêncio" };
  if (AGENT_READY_HINTS.some((re) => re.test(text))) return { ready: true, failed: false, via: "prompt" };
  return { ready: false, failed: false };
}

/** Nome de terminal legível a partir do título da demanda. */
export function sanitizeTerminalName(title) {
  const clean = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return clean || "Demanda";
}

/** O que é digitado no PTY: sem controle, sem quebra de linha, com teto. */
export function sanitizeDemandText(text) {
  return String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

export function createDispatcher({
  adapter,
  demands,
  readTail,
  now = () => Date.now(),
  // unref: uma espera pendente não pode ser o motivo de o processo continuar vivo
  sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  // Relógio de parede, separado do `sleep`: serve só para cortar uma chamada
  // que pode nunca voltar. Os testes trocam `sleep` por um relógio virtual e
  // este continua sendo tempo de verdade.
  wallClockTimeout = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  timeouts = readTimeoutsFromEnv(),
  log = () => {},
}) {
  function stage(demand, name, statusText) {
    demands.update(demand.id, { stage: name, statusText });
  }

  async function pollUntil(check, { timeoutMs, stepMs = 100, code, message, stageName }) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (now() >= deadline) throw new DispatchError(code, message, stageName);
      await sleep(stepMs);
    }
  }

  async function waitForShell(projectId, terminalId) {
    return pollUntil(
      async () => {
        const terminal = adapter.getTerminal(projectId, terminalId);
        if (!terminal) {
          throw new DispatchError("TERMINAL_GONE", "o terminal sumiu antes de iniciar", "waiting_shell");
        }
        if (terminal.exited) {
          throw new DispatchError("TERMINAL_EXITED", "o terminal encerrou antes de iniciar", "waiting_shell");
        }
        return terminal.pty ? terminal : null;
      },
      {
        timeoutMs: timeouts.waitShellMs,
        code: "SHELL_TIMEOUT",
        message: "o shell não subiu a tempo",
        stageName: "waiting_shell",
      },
    );
  }

  // Espera o shell parar de imprimir (motd, prompt do zsh, etc.) antes de
  // digitar — comando enviado no meio do desenho do prompt se perde.
  async function waitForPrompt(projectId, terminalId) {
    const deadline = now() + timeouts.waitPromptMs;
    let lastText = readTail(projectId, terminalId);
    let quietSince = now();
    for (;;) {
      await sleep(100);
      const text = readTail(projectId, terminalId);
      if (text !== lastText) {
        lastText = text;
        quietSince = now();
      } else if (now() - quietSince >= timeouts.promptQuietMs) {
        return;
      }
      if (now() >= deadline) return; // shell tagarela: segue mesmo assim
    }
  }

  async function waitForAgent(projectId, terminalId, baselineLength) {
    const deadline = now() + timeouts.waitAgentMs;
    let lastText = readTail(projectId, terminalId);
    let quietSince = now();
    for (;;) {
      await sleep(100);
      const terminal = adapter.getTerminal(projectId, terminalId);
      if (!terminal || terminal.exited) {
        throw new DispatchError("TERMINAL_EXITED", "o terminal encerrou ao subir o agente", "waiting_agent");
      }
      const text = readTail(projectId, terminalId);
      if (text !== lastText) {
        lastText = text;
        quietSince = now();
      }
      const verdict = detectAgentReady(text, {
        bytes: Math.max(0, text.length - baselineLength),
        quietMs: now() - quietSince,
        timeouts,
      });
      if (verdict.failed) {
        throw new DispatchError("AGENT_FAILED", verdict.reason, "waiting_agent");
      }
      if (verdict.ready) return verdict;
      if (now() >= deadline) {
        throw new DispatchError("AGENT_TIMEOUT", "o agente não ficou pronto a tempo", "waiting_agent");
      }
    }
  }

  /**
   * Executa o despacho inteiro. Resolve com a demanda entregue; em falha,
   * marca a demanda como `failed` e **preserva o terminal** — quem pediu
   * continua de onde parou, na mão.
   */
  async function run(demand, project, preset) {
    const projectId = project.id;
    let terminalId = null;
    try {
      stage(demand, "creating_terminal", "abrindo terminal…");
      const terminal = await Promise.race([
        adapter.createTerminal(projectId, sanitizeTerminalName(demand.title)),
        wallClockTimeout(timeouts.createTerminalMs).then(() => {
          throw new DispatchError("CREATE_TIMEOUT", "não consegui abrir o terminal", "creating_terminal");
        }),
      ]);
      terminalId = terminal.id;
      demands.update(demand.id, {
        terminalId,
        terminalName: terminal.name,
        dispatchedAt: now(),
      });

      stage(demand, "waiting_shell", "esperando o shell…");
      await waitForShell(projectId, terminalId);

      stage(demand, "waiting_prompt", "esperando o prompt…");
      await waitForPrompt(projectId, terminalId);

      stage(demand, "sending_command", `subindo ${preset.label}…`);
      const baselineLength = readTail(projectId, terminalId).length;
      await adapter.writeInput(projectId, terminalId, `${preset.cmd}\r`);

      stage(demand, "waiting_agent", `esperando ${preset.label} ficar pronto…`);
      const ready = await waitForAgent(projectId, terminalId, baselineLength);
      log(`[dispatch] ${preset.label} pronto em ${projectId}/${terminalId} (${ready.via})`);

      stage(demand, "sending_demand", "entregando a demanda…");
      // Dois writes: colar texto e "\r" juntos faz vários TUIs com bracketed
      // paste engolirem o Enter e a demanda fica digitada sem enviar.
      await adapter.writeInput(projectId, terminalId, sanitizeDemandText(demand.text));
      await sleep(timeouts.demandGapMs);
      await adapter.writeInput(projectId, terminalId, "\r");

      demands.update(demand.id, {
        stage: "handed_off",
        status: "working",
        statusText: `entregue para ${preset.label}`,
      });
      return demands.get(demand.id);
    } catch (error) {
      const code = error instanceof DispatchError ? error.code : "DISPATCH_FAILED";
      demands.update(demand.id, {
        status: "failed",
        statusText: error.message,
        error: code,
        // o terminal continua vivo de propósito: dá pra assumir na mão
        terminalId,
      });
      log(`[dispatch] falhou em ${projectId}: ${code} — ${error.message}`);
      return demands.get(demand.id);
    }
  }

  return { run, pickAgentPreset, timeouts };
}
