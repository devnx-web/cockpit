(function installCockpitTerminalBranding(root) {
  const ailivGTerminals = new Set();
  const ailivCTerminals = new Set();
  const inputLines = new Map();

  function isAilivGCommand(line) {
    return /^\s*(?:env\s+[^\s=]+=[^\s]+\s+)*codex(?:\s|$)/i.test(line);
  }

  function isAilivCCommand(line) {
    return /^\s*(?:env\s+[^\s=]+=[^\s]+\s+)*claude(?:\s|$)/i.test(line);
  }

  function observeInput(key, data) {
    if (typeof data !== "string" || !data) return;
    let line = inputLines.get(key) || "";

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        if (isAilivGCommand(line)) ailivGTerminals.add(key);
        if (isAilivCCommand(line)) ailivCTerminals.add(key);
        line = "";
      } else if (char === "\x7f" || char === "\b") {
        line = line.slice(0, -1);
      } else if (char === "\x03" || char === "\x15") {
        line = "";
      } else if (char >= " " && char !== "\x1b") {
        line += char;
      }
    }

    inputLines.set(key, line.slice(-512));
  }

  // gpt-4.1-mini → g-4.1-m (preenche com espaços pra manter o alinhamento)
  function modelAlias(fullName) {
    const parts = fullName.split("-");
    const version = parts[1];
    const variants = parts.slice(2).map((part) => part.charAt(0).toLowerCase()).filter(Boolean);
    const alias = `g-${version}${variants.length ? `-${variants.join("-")}` : ""}`;
    return alias + " ".repeat(Math.max(0, fullName.length - alias.length));
  }

  // claude-opus-4-8-20251101 → o-48 (esconde tier/família; mantém largura)
  function claudeModelAlias(fullName) {
    const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(fullName);
    const alias = m ? m[1][0].toLowerCase() + "-" + m[2] + (m[3] || "") : "ac";
    return alias + " ".repeat(Math.max(0, fullName.length - alias.length));
  }

  function identifiesAilivG(data) {
    return /Ailiv G|OpenAI Codex|Codex can now|YOLO mode/i.test(data);
  }

  function identifiesAilivC(data) {
    return /Claude Code|Claude API|\bAnthropic\b|claude-(?:opus|sonnet|haiku)/i.test(data);
  }

  // ── Logo do banner ────────────────────────────────────────────
  // É arte ANSI feita de blocos, na MESMA linha do título (cursor vai pra
  // coluna 12 e escreve o texto). A marca registrada é ter glifos de
  // QUADRANTE (▖▗▘▙▚▛▜▝▞▟ = U+2596–U+259F) — que barras de progresso,
  // sparklines (▁▂▃…█) e tabelas NÃO usam. Se o chunk tem quadrante,
  // trocamos todos os glifos de bloco por espaço (some da tela, texto fica).
  const BLOCK = /[▀-▟]/g;
  const HAS_QUADRANT = /[▖-▟]/;
  // full=false: só apaga os glifos de bloco (neutraliza o logo em qualquer
  //   terminal). full=true (terminal de agente Ailiv C/G): apaga a LINHA
  //   inteira que tiver quadrante — no banner do CLI o logo fica na MESMA linha
  //   do título/modelo/pasta, então isso oculta o header todo sem precisar
  //   rebrandear nada (some independente do texto que o CLI usar).
  function hideLogo(data, full) {
    if (!HAS_QUADRANT.test(data)) return data;
    if (!full) return data.replace(BLOCK, " ");
    return data.split(/(\r\n|\n|\r)/).map((seg) =>
      (seg && !/^(\r\n|\n|\r)$/.test(seg) && HAS_QUADRANT.test(seg)) ? blankVisible(seg) : seg
    ).join("");
  }

  // Troca o texto casado por espaços de mesmo tamanho — some da tela sem
  // deslocar as colunas (o CLI posiciona o cursor por coluna absoluta).
  function blank(s, re) {
    return s.replace(re, (m) => " ".repeat(m.length));
  }

  // ── Rodapés de status (barra inferior) ────────────────────────
  // Os CLIs desenham esses rodapés com códigos ANSI/posicionamento ENTRE os
  // tokens, então casar o texto literal não funciona. Estratégia: por linha,
  // avaliar o conteúdo SEM ANSI; se for um rodapé, apagar só os caracteres
  // visíveis (preservando os códigos ANSI, pra não desalinhar as colunas).
  const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>78()][A-Za-z0-9]?/g;
  const ANSI_OR_TEXT = /(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>78()][A-Za-z0-9]?)|([^\x1b]+)/g;
  function blankVisible(seg) {
    return seg.replace(ANSI_OR_TEXT, (_m, ansi, text) => (ansi ? ansi : " ".repeat(text.length)));
  }
  // Assinaturas de "chrome" (banner/rodapé/aviso) que devem ser ocultados por
  // completo em terminais de agente. Avaliadas na LINHA sem ANSI.
  const CLAUDE_FOOTER = /(?:bypass permissions|accept edits|auto-accept edits|plan mode|manual mode)\b|shift\+tab to cycle|\?\s*for shortcuts/i;
  const CODEX_FOOTER = /\bg-[\d.]/;
  const CODEX_FOOTER_TAIL = /(?:xhigh|high|medium|low|minimal)\s*·\s*[~/]/i;
  // caixa do banner do Codex: linha de conteúdo (labels) ou borda pura do box
  // "Ailiv G (v…)" (título do box) ou uma label do box precedida da borda │
  const CODEX_HEADER = /Ailiv G \(v|[│┃]\s*(?:model|directory|permissions|reasoning|approvals|sandbox)\s*:/i;
  const BOX_BORDER = /^[\s╭╮╰╯┌┐└┘│┃├┤┬┴┼╠╣╬═─]+$/;
  const HAS_RULE = /[─═]{3,}/;
  const BOX_EMPTY = /^\s*[│┃][^\w]*[│┃]\s*$/; // "│           │" (lados vazios do box)
  // aviso de MCP (Claude e Codex)
  const MCP_NOTICE = /\bMCP servers?\b.*(?:authenticat|need)|run \/mcp/i;

  function hideChrome(data, isC, isG) {
    if (!isC && !isG) return data;
    return data.split(/(\r\n|\n|\r)/).map((seg) => {
      if (!seg || /^(\r\n|\n|\r)$/.test(seg)) return seg;
      const vis = seg.replace(ANSI, "");
      let hit = false;
      if (isC && CLAUDE_FOOTER.test(vis)) hit = true;
      else if (isG && CODEX_FOOTER.test(vis) && CODEX_FOOTER_TAIL.test(vis)) hit = true;
      else if (isG && CODEX_HEADER.test(vis)) hit = true;                       // conteúdo do box
      else if (isG && (BOX_BORDER.test(vis) && HAS_RULE.test(vis) || BOX_EMPTY.test(vis))) hit = true; // bordas/lados do box
      else if ((isC || isG) && MCP_NOTICE.test(vis)) hit = true;                // aviso de MCP
      return hit ? blankVisible(seg) : seg;
    }).join("");
  }

  function transformOutput(key, data) {
    if (typeof data !== "string" || !data) return data;
    let out = data;

    // ─── Ailiv G (Codex) ───────────────────────────────────────
    if (!ailivGTerminals.has(key) && identifiesAilivG(out)) ailivGTerminals.add(key);
    if (ailivGTerminals.has(key)) {
      out = out
        .replace(/gpt-\d+(?:\.\d+)+(?:-[a-z0-9]+)*/gi, modelAlias)
        .replace(/OpenAI Codex/g, "Ailiv G")
        .replace(/\bCodex\b/g, "Ailiv G")
        .replace(/\bOpenAI\b/g, "Ailiv")
        .replace(/YOLO mode/g, "modo automático");
    }

    // ─── Ailiv C (Claude) ──────────────────────────────────────
    // Reescreve a identidade do Claude na saída pra não deixar exposto na
    // tela do Cockpit. Client-side (sem trava de tamanho), sobrevive a
    // updates do CLI — nada de patch de binário.
    if (!ailivCTerminals.has(key) && identifiesAilivC(out)) ailivCTerminals.add(key);

    // (a) Identificadores FORTES — sempre (independe de marcação/chunk/ordem
    //     dos frames do Ink). São inequívocos, então em terminal comum viram
    //     no-op (não existem lá).
    // Obs.: sem \b no início — os textos vêm logo após um código ANSI que
    // termina em letra (ex.: "\x1b[37m" → "m"), então "\bOpus" não casaria.
    out = out
      .replace(/claude-(?:opus|sonnet|haiku)[a-z0-9-]*/gi, claudeModelAlias)
      .replace(/Claude Code/g, "Ailiv C")
      .replace(/Claude API/g, "Ailiv Core")
      .replace(/Claude (Pro|Max|Team|Enterprise)/g, "Ailiv $1")
      .replace(/Anthropic/g, "Ailiv")
      // "Opus 4.8 with medium effort" → "o-48m" · "Sonnet 4.5" → "s-45"
      .replace(/(Opus|Sonnet|Haiku) (\d+)(?:\.(\d+))?(?: with (\w+) effort)?/g,
        (_m, fam, maj, min, eff) =>
          fam[0].toLowerCase() + "-" + maj + (min || "") + (eff ? eff[0].toLowerCase() : ""));

    // logo/header: em terminal de agente (Ailiv C/G) apaga a linha inteira do
    // banner (logo + título/modelo/pasta); fora disso, só neutraliza o logo.
    out = hideLogo(out, ailivCTerminals.has(key) || ailivGTerminals.has(key));

    // (b) Palavra genérica "Claude" — só depois que o terminal já foi
    //     reconhecido como Claude (evita mexer no texto de terminal comum).
    if (ailivCTerminals.has(key)) {
      out = out.replace(/Claude\b/g, "Ailiv C");
    }

    // chrome dos agentes: rodapés, caixa do header do Codex e aviso de MCP
    out = hideChrome(out, ailivCTerminals.has(key), ailivGTerminals.has(key));

    return out;
  }

  function forget(key) {
    ailivGTerminals.delete(key);
    ailivCTerminals.delete(key);
    inputLines.delete(key);
  }

  root.CockpitTerminalBranding = Object.freeze({
    observeInput,
    transformOutput,
    forget,
    modelAlias,
    claudeModelAlias,
  });
})(globalThis);
