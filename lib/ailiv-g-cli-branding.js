const pairs = [
  ["OpenAI Codex", "Ailiv G\u034f\u200b"],
  ["Codex CLI", "Ailiv G\u034f"],
];

export const AILIV_G_CLI_BRAND_REPLACEMENTS = Object.freeze(
  pairs.map(([from, to]) => {
    const source = Buffer.from(from);
    const replacement = Buffer.from(to);
    if (source.length !== replacement.length) {
      throw new Error(`Brand replacement changes binary length: ${from}`);
    }
    return Object.freeze({ from, to, source, replacement });
  }),
);

function replaceAllInPlace(buffer, source, replacement) {
  let count = 0;
  let offset = 0;
  while ((offset = buffer.indexOf(source, offset)) !== -1) {
    replacement.copy(buffer, offset);
    offset += replacement.length;
    count += 1;
  }
  return count;
}

export function applyAilivGCliBranding(input) {
  const output = Buffer.from(input);
  const replacements = [];
  let total = 0;

  for (const item of AILIV_G_CLI_BRAND_REPLACEMENTS) {
    const count = replaceAllInPlace(output, item.source, item.replacement);
    replacements.push({ from: item.from, to: item.to, count });
    total += count;
  }

  return { output, replacements, total };
}

export function hasAilivGCliBranding(input) {
  return AILIV_G_CLI_BRAND_REPLACEMENTS.some(({ replacement }) => input.includes(replacement));
}
