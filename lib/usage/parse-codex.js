/**
 * Parser dos rollouts JSONL do Codex.
 *
 * Formato: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   - `session_meta`  → id da sessão e cwd
 *   - `turn_context`  → modelo do turno (pode mudar no meio da sessão)
 *   - `event_msg` com payload.type `token_count` → contadores
 *
 * ATENÇÃO — o Codex emite DOIS contadores por evento:
 *   `total_token_usage` (acumulado da sessão) e `last_token_usage` (do último turno).
 * Somar `last_token_usage` parece natural e está ERRADO: numa sessão retomada o CLI
 * replica o histórico com `last` preenchido e `total` congelado. Medido nesta base:
 * somar `last` infla +2,5% frente ao crescimento real do acumulado.
 * Portanto contamos sempre o DELTA de `total_token_usage`, que é monotônico
 * (0 violações em 1.370 records medidos).
 */

const ZERO = Object.freeze({
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
});

/** Prefiltro barato: descarta as linhas de conteúdo, que são a maioria do arquivo. */
export function isCodexCandidate(line) {
  return line.includes('"token_count"')
    || line.includes('"turn_context"')
    || line.includes('"session_meta"');
}

export function createCodexCursor() {
  return { prev: null, model: null, cwd: null, uuid: null };
}

function toInt(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeUsage(raw) {
  return {
    input_tokens: toInt(raw?.input_tokens),
    cached_input_tokens: toInt(raw?.cached_input_tokens),
    output_tokens: toInt(raw?.output_tokens),
    reasoning_output_tokens: toInt(raw?.reasoning_output_tokens),
    total_tokens: toInt(raw?.total_tokens),
  };
}

/**
 * Consome uma linha e atualiza o cursor in-place.
 *
 * @param {string} line
 * @param {object} cursor estado acumulado do arquivo (persistido em files.cursor_json)
 * @returns {object|null} evento normalizado, ou null
 */
export function parseCodexLine(line, cursor) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  return parseCodexRecord(record, cursor);
}

export function parseCodexRecord(record, cursor) {
  if (!record || typeof record !== "object") return null;
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return null;

  if (record.type === "session_meta") {
    if (typeof payload.id === "string") cursor.uuid = payload.id;
    if (typeof payload.cwd === "string") cursor.cwd = payload.cwd;
    if (typeof payload.model === "string") cursor.model = payload.model;
    return null;
  }

  if (record.type === "turn_context") {
    if (typeof payload.model === "string") cursor.model = payload.model;
    if (typeof payload.cwd === "string") cursor.cwd = payload.cwd;
    return null;
  }

  if (payload.type !== "token_count") return null;

  const info = payload.info;
  // `info: null` aparece no início de muitos rollouts — não é erro, só não há contador ainda.
  if (!info || typeof info !== "object") return null;

  const total = info.total_token_usage;
  if (!total || typeof total !== "object") return null;
  const current = normalizeUsage(total);

  if (cursor.prev === null) {
    const last = info.last_token_usage;
    // Sessão nova: o primeiro evento É o primeiro turno (total == last), então conta a partir do zero.
    // Sessão retomada: o total já vem herdado do rollout pai e aquele consumo já foi cobrado lá.
    // Sem `last` para comparar, assumimos retomada — subcontar é preferível a superfaturar.
    const fresh = last && toInt(last.total_tokens) === current.total_tokens;
    cursor.prev = fresh ? { ...ZERO } : current;
    if (!fresh) return null;
  }

  const prev = cursor.prev;
  const delta = {
    input: current.input_tokens - prev.input_tokens,
    cached: current.cached_input_tokens - prev.cached_input_tokens,
    output: current.output_tokens - prev.output_tokens,
    reasoning: current.reasoning_output_tokens - prev.reasoning_output_tokens,
  };
  cursor.prev = current;

  // Replay de histórico e no-ops produzem delta zero.
  if (delta.input <= 0 && delta.output <= 0) return null;

  // Clamp defensivo: se uma versão futura do Codex quebrar a monotonicidade,
  // o pior caso passa a ser subcontar, nunca emitir número negativo.
  const cached = Math.max(0, delta.cached);
  const inputTotal = Math.max(0, delta.input);

  return {
    event_key: `x|${cursor.uuid ?? "-"}|${current.total_tokens}`,
    provider: "codex",
    model: cursor.model || "unknown",
    ts_ms: Date.parse(record.timestamp) || Date.now(),
    cwd: cursor.cwd,
    session_id: cursor.uuid,
    // `input_tokens` do Codex inclui o que foi lido do cache; o faturável é a diferença.
    input_tokens: Math.max(0, inputTotal - cached),
    cache_read_tokens: cached,
    cache_write_5m_tokens: 0, // o Codex não expõe cache write
    cache_write_1h_tokens: 0,
    output_tokens: Math.max(0, delta.output),
    reasoning_tokens: Math.max(0, delta.reasoning),
    is_sidechain: false,
  };
}
