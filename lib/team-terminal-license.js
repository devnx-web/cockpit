const REQUIRED_PROVIDERS = Object.freeze(["openai", "claude"]);

export const TERMINAL_LICENSE_RETRY_DELAYS_MS = Object.freeze([
  10_000,
  30_000,
  60_000,
  120_000,
]);

export function terminalLicenseRetryDelay(failureCount) {
  const count = Math.max(1, Number(failureCount) || 1);
  return TERMINAL_LICENSE_RETRY_DELAYS_MS[count - 1] ?? 60_000;
}

export function formatTerminalLicenseDelay(delayMs) {
  const seconds = Math.max(1, Math.round((Number(delayMs) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}min`;
}

export function requireFreshTerminalSelections(result) {
  if (!result?.connected) {
    throw new Error("Cockpit não conectado ao DevNX Control");
  }

  const selected = new Set(
    (Array.isArray(result.selections) ? result.selections : [])
      .map((item) => item?.provider)
      .filter(Boolean),
  );
  const missing = REQUIRED_PROVIDERS.filter((provider) => !selected.has(provider));
  if (missing.length === 0) return result;

  const warnings = [...new Set(
    (Array.isArray(result.warnings) ? result.warnings : [])
      .map((warning) => String(warning || "").trim())
      .filter(Boolean),
  )];
  const detail = warnings.length ? `: ${warnings.join(" · ")}` : "";
  throw new Error(`backend não retornou todas as licenças Ailiv${detail}`);
}

export function createTerminalLicenseRetry({
  attempt,
  onAttempt = () => {},
  onFailure = () => {},
  onSuccess = () => {},
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelSchedule = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof attempt !== "function") throw new TypeError("attempt é obrigatório");

  let cancelled = false;
  let running = false;
  let timer = null;
  let failures = 0;

  const run = async () => {
    if (cancelled || running) return;
    running = true;
    onAttempt({ attempt: failures + 1, failures });
    try {
      const result = await attempt();
      if (cancelled) return;
      failures = 0;
      onSuccess(result);
    } catch (error) {
      if (cancelled) return;
      failures += 1;
      const delayMs = terminalLicenseRetryDelay(failures);
      onFailure(error, { attempt: failures, failures, delayMs });
      timer = schedule(() => {
        timer = null;
        void run();
      }, delayMs);
      timer?.unref?.();
    } finally {
      running = false;
    }
  };

  return {
    start() {
      void run();
    },
    cancel() {
      cancelled = true;
      if (timer != null) cancelSchedule(timer);
      timer = null;
    },
    status() {
      return { cancelled, running, failures, scheduled: timer != null };
    },
  };
}
