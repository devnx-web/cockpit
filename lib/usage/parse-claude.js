/**
 * Parser das linhas JSONL do Claude Code.
 *
 * Formato: ~/.claude/projects/<slug>/<sessionId>.jsonl (e .../<sessionId>/subagents/*.jsonl).
 * Cada requisição faturável aparece em uma linha `type:"assistant"` com `message.usage`.
 *
 * ATENÇÃO — o CLI grava UMA LINHA POR CONTENT BLOCK (thinking, text, tool_use) repetindo
 * o mesmo `message.id` e o mesmo `usage`. Medido nesta base: 2,11 linhas por requisição real,
 * com `usage` idêntico em 100% dos pares. Contar linhas dobraria o consumo — por isso o
 * dedup por (requestId, message.id) é obrigatório, não uma otimização.
 */

/** Prefiltro barato: evita JSON.parse em ~90% das linhas durante o backfill. */
export function isClaudeCandidate(line) {
  return line.includes('"usage"') && line.includes('"assistant"');
}

function toInt(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * @param {string} line linha crua do JSONL
 * @returns {object|null} evento normalizado, ou null se a linha não for faturável
 */
export function parseClaudeLine(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  return parseClaudeRecord(record);
}

export function parseClaudeRecord(record) {
  if (!record || record.type !== "assistant") return null;

  const message = record.message;
  if (!message || typeof message !== "object") return null;

  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;

  const model = typeof message.model === "string" ? message.model : "";
  // `<synthetic>` são mensagens fabricadas pelo próprio CLI (erros, avisos), não chamadas de API.
  if (!model || model === "<synthetic>") return null;

  const messageId = typeof message.id === "string" ? message.id : "";
  if (!messageId) return null;

  const tsMs = Date.parse(record.timestamp);
  if (!Number.isFinite(tsMs)) return null;

  // O split 5m/1h vem explícito do CLI; se faltar (versões antigas), todo o cache
  // creation cai no bucket de 5 minutos, que é o default da Anthropic.
  const creation = usage.cache_creation;
  const totalCreation = toInt(usage.cache_creation_input_tokens);
  let write5m = totalCreation;
  let write1h = 0;
  if (creation && typeof creation === "object") {
    write5m = toInt(creation.ephemeral_5m_input_tokens);
    write1h = toInt(creation.ephemeral_1h_input_tokens);
    // Se o detalhamento não fecha com o total, o total manda e a diferença vai pro 5m.
    if (write5m + write1h === 0 && totalCreation > 0) write5m = totalCreation;
  }

  const requestId = typeof record.requestId === "string" && record.requestId ? record.requestId : "-";

  return {
    event_key: `c|${requestId}|${messageId}`,
    provider: "claude",
    model,
    ts_ms: tsMs,
    cwd: typeof record.cwd === "string" ? record.cwd : null,
    session_id: typeof record.sessionId === "string" ? record.sessionId : null,
    input_tokens: toInt(usage.input_tokens),
    cache_read_tokens: toInt(usage.cache_read_input_tokens),
    cache_write_5m_tokens: write5m,
    cache_write_1h_tokens: write1h,
    output_tokens: toInt(usage.output_tokens),
    reasoning_tokens: 0,
    is_sidechain: record.isSidechain === true,
  };
}
