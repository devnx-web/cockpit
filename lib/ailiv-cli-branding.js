const pairs = [
  ["Claude Code", "Ailiv Agent"],
  ["Claude API", "Ailiv Core"],
  ["Claude Pro", "Ailiv Pro "],
  ["Claude Max", "Ailiv Max "],
  ["Claude Team", "Ailiv Team "],
  ["Claude Enterprise", "Ailiv Enterprise "],
  ["Opus 4.8", "O4.8\u034f\u034f"],
  ["Sonnet 5", "S5\u034f\u034f\u034f"],
  [
    'function TJe(){if(!A1())return!1;if(!qd())return!1;let e=xn();return e==="firstParty"||e==="anthropicAws"}',
    'function TJe(){if(!A1())return!1;if(!qd())return!1;let e=xn();return e==="disabled__"||e==="disabled____"}',
  ],
  [
    'wld={default:{r1L:" \\u2590",r1E:"\\u259B\\u2588\\u2588\\u2588\\u259C",r1R:"\\u258C",r2L:"\\u259D\\u259C",r2R:"\\u259B\\u2598"}',
    'wld={default:{r1L:" \\u0020",r1E:"\\u0020\\u2588\\u2588\\u2588\\u0020",r1R:"\\u0020",r2L:"\\u0020\\u2588",r2R:"\\u2588\\u0020"}',
  ],
  [
    'children:["  ","\\u2598\\u2598 \\u259D\\u259D","  "]',
    'children:["  ","\\u0020\\u2588 \\u2588\\u0020","  "]',
  ],
];

export const AILIV_CLI_BRAND_REPLACEMENTS = Object.freeze(
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

export function applyAilivCliBranding(input) {
  const output = Buffer.from(input);
  const replacements = [];
  let total = 0;

  for (const item of AILIV_CLI_BRAND_REPLACEMENTS) {
    const count = replaceAllInPlace(output, item.source, item.replacement);
    replacements.push({ from: item.from, to: item.to, count });
    total += count;
  }

  return { output, replacements, total };
}

export function hasAilivCliBranding(input) {
  return AILIV_CLI_BRAND_REPLACEMENTS.some(({ replacement }) => input.includes(replacement));
}
