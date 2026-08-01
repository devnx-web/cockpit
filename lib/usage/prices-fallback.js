/**
 * Preços embutidos por família, em USD por token.
 *
 * Rede de segurança para dois casos: primeira execução sem internet e modelo que
 * ainda não entrou na tabela do LiteLLM (`gpt-5.3-codex-spark`, por exemplo, não
 * está lá hoje). Os valores foram extraídos do próprio LiteLLM em 2026-07-28 a
 * partir do membro mais representativo de cada família.
 *
 * A ordem importa: o primeiro padrão que casa vence, então o mais específico vem
 * primeiro. Todo custo derivado daqui é marcado com `source: "fallback"` para que
 * a UI possa avisar que aquele número é aproximado.
 */

// Os preços de referência são cotados por milhão de tokens; guardamos por token.
// Dividir por 1e6 é mais exato que multiplicar por 1e-6 (que introduz ULP de erro).
const perToken = (perMillion) => perMillion / 1e6;

function family(pattern, provider, [input, output, cacheRead, write5m, write1h]) {
  return {
    pattern,
    provider,
    input_cost: perToken(input),
    output_cost: perToken(output),
    cache_read_cost: perToken(cacheRead),
    cache_write_5m_cost: perToken(write5m ?? 0),
    cache_write_1h_cost: perToken(write1h ?? 0),
  };
}

export const FALLBACK_FAMILIES = Object.freeze([
  family(/^claude-fable/, "anthropic", [10, 50, 1, 12.5, 20]),
  family(/^claude-opus/, "anthropic", [5, 25, 0.5, 6.25, 10]),
  family(/^claude-sonnet/, "anthropic", [2, 10, 0.2, 2.5, 4]),
  family(/^claude-haiku/, "anthropic", [1, 5, 0.1, 1.25, 2]),

  // OpenAI não cobra escrita em cache — os buckets de write ficam zerados.
  family(/^gpt-.*nano/, "openai", [0.2, 1.25, 0.02]),
  family(/^gpt-.*mini/, "openai", [0.75, 4.5, 0.075]),
  family(/^gpt-.*codex/, "openai", [1.75, 14, 0.175]),
  family(/^gpt-5/, "openai", [5, 30, 0.5]),
]);

/** @returns {object|null} preços por token, ou null se a família for desconhecida. */
export function fallbackPriceFor(model) {
  if (typeof model !== "string" || !model) return null;
  const name = model.toLowerCase();
  for (const entry of FALLBACK_FAMILIES) {
    if (entry.pattern.test(name)) {
      return {
        model,
        provider: entry.provider,
        input_cost: entry.input_cost,
        output_cost: entry.output_cost,
        cache_read_cost: entry.cache_read_cost,
        cache_write_5m_cost: entry.cache_write_5m_cost,
        cache_write_1h_cost: entry.cache_write_1h_cost,
        source: "fallback",
      };
    }
  }
  return null;
}
