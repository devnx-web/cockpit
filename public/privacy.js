// Modo Discreto — lógica pura de redação (sem DOM).
// Usada pelo browser (via window.CockpitPrivacy) e pelos testes (node --test).

// Ordem importa: padrões mais específicos primeiro (ex.: "Claude Code" antes de "Claude").
export const PRIVACY_PATTERNS = [
  { re: /Claude Code/gi, repl: "AI Agent" },
  { re: /Claude Max/gi, repl: "Pro" },
  { re: /OpenAI Codex/gi, repl: "AI Agent" },
  { re: /\(1M context\)/gi, repl: "" },
  { re: /with (high|medium|low) effort/gi, repl: "" },
  { re: /Opus 4\.8/gi, repl: "Agent" },
  { re: /\b(Opus|Sonnet|Haiku)\b/gi, repl: "Agent" },
  { re: /gpt-[\w.\-]+/gi, repl: "agent-model" },
  { re: /\bGPT-\d[\w.\-]*/gi, repl: "Agent" },
  { re: /YOLO mode/gi, repl: "Auto mode" },
  { re: /\bYOLO\b/gi, repl: "Auto" },
  { re: /\bCodex\b/gi, repl: "Agent" },
  { re: /\bClaude\b/gi, repl: "Agent" },
  { re: /\bKimi\b/gi, repl: "Agent" },
];

// Redige um trecho do stream cru da CLI. Fail-open: qualquer erro devolve o
// texto original — nunca quebra a renderização do terminal.
export function redactStream(data, on) {
  if (!on || !data) return data;
  try {
    let out = data;
    for (const { re, repl } of PRIVACY_PATTERNS) out = out.replace(re, repl);
    return out;
  } catch {
    return data;
  }
}

// Redação no nível das CÉLULAS renderizadas do xterm (para TUIs como o claude/codex,
// que desenham a statusline com posicionamento de cursor — o texto só é contíguo
// DEPOIS de renderizado). Blanka cada trecho de marca com espaços do MESMO tamanho,
// para não deslocar as colunas ao sobrescrever. Fail-open.
export function redactCells(text, on) {
  if (!on || !text) return text;
  try {
    let out = text;
    for (const { re } of PRIVACY_PATTERNS) {
      out = out.replace(re, (m) => " ".repeat(m.length));
    }
    return out;
  } catch {
    return text;
  }
}

// Rótulos discretos de chrome (botões do launcher, nome do terminal no header/abas).
// Marca exata → "Agent N" (preserva a distinção entre os botões); demais strings
// caem no redactStream para cobrir casos compostos (ex.: linha de comando).
const LABEL_MAP = { claude: "Agent 1", codex: "Agent 2", kimi: "Agent 3" };

export function neutralizeLabel(label, on) {
  if (!on || !label) return label;
  const key = String(label).trim().toLowerCase();
  if (LABEL_MAP[key]) return LABEL_MAP[key];
  return redactStream(label, on);
}
