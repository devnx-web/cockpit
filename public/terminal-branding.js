(function installCockpitTerminalBranding(root) {
  const ailivGTerminals = new Set();
  const inputLines = new Map();

  function isAilivGCommand(line) {
    return /^\s*(?:env\s+[^\s=]+=[^\s]+\s+)*codex(?:\s|$)/i.test(line);
  }

  function observeInput(key, data) {
    if (typeof data !== "string" || !data) return;
    let line = inputLines.get(key) || "";

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        if (isAilivGCommand(line)) ailivGTerminals.add(key);
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

  function modelAlias(fullName) {
    const parts = fullName.split("-");
    const version = parts[1];
    const variants = parts.slice(2).map((part) => part.charAt(0).toLowerCase()).filter(Boolean);
    const alias = `g-${version}${variants.length ? `-${variants.join("-")}` : ""}`;
    return alias + " ".repeat(Math.max(0, fullName.length - alias.length));
  }

  function identifiesAilivG(data) {
    return /Ailiv G|OpenAI Codex|Codex can now|YOLO mode/i.test(data);
  }

  function transformOutput(key, data) {
    if (typeof data !== "string" || !data) return data;
    if (!ailivGTerminals.has(key) && identifiesAilivG(data)) ailivGTerminals.add(key);
    if (!ailivGTerminals.has(key)) return data;

    return data
      .replace(/gpt-\d+(?:\.\d+)+(?:-[a-z0-9]+)*/gi, modelAlias)
      .replace(/OpenAI Codex/g, "Ailiv G")
      .replace(/\bCodex\b/g, "Ailiv G")
      .replace(/\bOpenAI\b/g, "Ailiv")
      .replace(/YOLO mode/g, "modo automático");
  }

  function forget(key) {
    ailivGTerminals.delete(key);
    inputLines.delete(key);
  }

  root.CockpitTerminalBranding = Object.freeze({
    observeInput,
    transformOutput,
    forget,
    modelAlias,
  });
})(globalThis);
