# Modo Discreto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um toggle rápido (`Ctrl+Shift+H`) que oculta toda a identidade do agente de IA (Claude Code / Codex / Kimi) na renderização do Cockpit — tanto o chrome quanto o texto impresso pela CLI dentro do terminal.

**Architecture:** A lógica pura de redação (regex + mapa de rótulos) vive em `public/privacy.js` (módulo ESM, testável via `node --test`). O `public/index.html` faz a fiação: estado `privacyMode` persistido em `localStorage`, atalho global, `body.privacy-on` para CSS, um wrapper `writeToTerm` que redige o stream da CLI no único ponto de escrita do xterm, um ring buffer cru por terminal para re-renderizar o que já está na tela ao ligar/desligar, e `neutralizeLabel` aplicado nos rótulos de chrome (header, abas, chips do launcher).

**Tech Stack:** JavaScript vanilla (browser), xterm.js, `node:test` para os testes unitários da lógica pura.

## Global Constraints

- Todo o código novo vai em `public/privacy.js` (novo) e `public/index.html` (existente). Nada em `server.js` — a redação é só de renderização.
- A redação **nunca** pode quebrar o terminal: qualquer erro em `redactStream` retorna o texto original (fail-open).
- `privacyMode` default **desligado**; persistido na chave `cockpit-settings` do localStorage (helpers `getSetting`/`setSetting` já existem em `public/index.html:3377-3381`).
- Não parsear ANSI — substituição de texto sobre o stream cru.
- O repo é `"type": "module"`; testes usam `import ... from` + `node:test` (ver `test/team-accounts.test.js`).
- Comando de teste: `npm test` (roda `node --test`).
- O painel de gerenciamento de contas (modal de settings) **não** é redigido — o usuário precisa da identidade real para administrar contas.
- Commits em PT-BR, com trailer `Co-Authored-By: Ailiv <naoresponda@ailiv.com.br>`.

---

### Task 1: Módulo puro de redação + testes

**Files:**
- Create: `public/privacy.js`
- Test: `test/privacy.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `export const PRIVACY_PATTERNS: Array<{ re: RegExp, repl: string }>`
  - `export function redactStream(data: string, on: boolean): string`
  - `export function neutralizeLabel(label: string, on: boolean): string`

- [ ] **Step 1: Escrever os testes que falham**

Create `test/privacy.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { redactStream, neutralizeLabel } from "../public/privacy.js";

test("redactStream: desligado retorna o texto intacto", () => {
  const input = "Claude Code v2.1.206 · Opus 4.8 (1M context)";
  assert.equal(redactStream(input, false), input);
});

test("redactStream: entrada vazia/nula é segura", () => {
  assert.equal(redactStream("", true), "");
  assert.equal(redactStream(null, true), null);
});

test("redactStream: redige o banner do Claude Code", () => {
  const out = redactStream("Claude Code v2.1.206", true);
  assert.doesNotMatch(out, /Claude/i);
  assert.match(out, /v2\.1\.206/); // versão preservada
});

test("redactStream: redige a statusline do Claude", () => {
  const out = redactStream("Opus 4.8 (1M context) with high effort · Claude Max", true);
  assert.doesNotMatch(out, /Opus/i);
  assert.doesNotMatch(out, /Claude/i);
  assert.doesNotMatch(out, /1M context/i);
  assert.doesNotMatch(out, /effort/i);
});

test("redactStream: redige o box do Codex", () => {
  const out = redactStream("OpenAI Codex (v0.144.1)", true);
  assert.doesNotMatch(out, /Codex/i);
  assert.doesNotMatch(out, /OpenAI/i);
});

test("redactStream: redige o modelo gpt e o YOLO mode", () => {
  const out = redactStream("gpt-5.6-sol default · YOLO mode", true);
  assert.doesNotMatch(out, /gpt-5/i);
  assert.doesNotMatch(out, /YOLO/i);
});

test("redactStream: redige Kimi", () => {
  assert.doesNotMatch(redactStream("Kimi --yolo", true), /Kimi/i);
});

test("neutralizeLabel: rótulos de marca viram Agent numerado", () => {
  assert.equal(neutralizeLabel("claude", true), "Agent 1");
  assert.equal(neutralizeLabel("codex", true), "Agent 2");
  assert.equal(neutralizeLabel("kimi", true), "Agent 3");
});

test("neutralizeLabel: rótulo não-marca passa intacto", () => {
  assert.equal(neutralizeLabel("npm dev", true), "npm dev");
});

test("neutralizeLabel: desligado passa intacto", () => {
  assert.equal(neutralizeLabel("claude", false), "claude");
});

test("neutralizeLabel: string composta com marca é redigida via patterns", () => {
  const out = neutralizeLabel("claude --dangerously-skip-permissions", true);
  assert.doesNotMatch(out, /claude/i);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npm test`
Expected: FAIL — `Cannot find module '../public/privacy.js'` (arquivo ainda não existe).

- [ ] **Step 3: Implementar `public/privacy.js`**

Create `public/privacy.js`:

```js
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
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: PASS — todos os testes de `test/privacy.test.js` verdes (os testes de team-* continuam passando).

- [ ] **Step 5: Commit**

```bash
git add public/privacy.js test/privacy.test.js
git commit -m "feat(privacy): lógica pura de redação do Modo Discreto + testes

Co-Authored-By: Ailiv <naoresponda@ailiv.com.br>"
```

---

### Task 2: Estado, toggle global e chip de indicação

**Files:**
- Modify: `public/index.html` (carregar módulo ~L17; estado ~L3381; header HTML ~L3104-3109; CSS; listener global)

**Interfaces:**
- Consumes: `window.CockpitPrivacy.{redactStream,neutralizeLabel}` (Task 1), `getSetting`/`setSetting` (existentes).
- Produces (globais no escopo do script inline, usados por Tasks 3-4):
  - `let privacyMode: boolean`
  - `function setPrivacyMode(on: boolean): void`
  - `function redact(data: string): string` — aplica `redactStream(data, privacyMode)` com guarda de módulo não-carregado.
  - `function nlabel(s: string): string` — aplica `neutralizeLabel(s, privacyMode)` com guarda.

- [ ] **Step 1: Carregar o módulo no browser**

Em `public/index.html`, logo após a linha `<script src="/lsp-client.js"></script>` (L17), adicionar:

```html
  <script type="module">
    import * as Privacy from "/privacy.js";
    window.CockpitPrivacy = Privacy;
  </script>
```

- [ ] **Step 2: Adicionar o chip ao header**

Em `public/index.html`, dentro de `<div class="header-right">` (L3103), imediatamente antes de `<div class="agent-badge">` (L3104), inserir:

```html
          <span class="privacy-chip" id="privacyChip" title="Modo discreto ativo (Ctrl+Shift+H)">🕶 discreto</span>
```

- [ ] **Step 3: Adicionar o CSS do chip e a base do body.privacy-on**

Em `public/index.html`, dentro do `<style>` (perto das regras de `.agent-badge`, ~L747), adicionar:

```css
    .privacy-chip { display: none; }
    body.privacy-on .privacy-chip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; padding: 2px 8px; border-radius: 999px;
      background: rgba(148,163,184,.18); color: var(--text-secondary);
      user-select: none;
    }
```

- [ ] **Step 4: Adicionar estado e `setPrivacyMode`**

Em `public/index.html`, logo após o helper `setSetting` (fecha em L3381), adicionar:

```js
    // ============================================================
    // MODO DISCRETO
    // ============================================================
    let privacyMode = !!getSetting("privacyMode");

    function redact(data) {
      const P = window.CockpitPrivacy;
      return P ? P.redactStream(data, privacyMode) : data;
    }
    function nlabel(s) {
      const P = window.CockpitPrivacy;
      return (P && privacyMode) ? P.neutralizeLabel(s, true) : s;
    }

    function setPrivacyMode(on) {
      privacyMode = !!on;
      setSetting("privacyMode", privacyMode);
      document.body.classList.toggle("privacy-on", privacyMode);
      try { renderHeader(); } catch {}
      try { renderTabs(); } catch {}
      // Re-renderiza os terminais a partir do buffer cru, para redigir/restaurar
      // o conteúdo que já estava na tela (ex.: banner de inicialização).
      for (const inst of xtermInstances.values()) {
        if (!inst || inst.raw == null) continue;
        try { inst.term.reset(); inst.term.write(redact(inst.raw)); } catch {}
      }
    }
```

- [ ] **Step 5: Aplicar o estado inicial e registrar o atalho global**

Em `public/index.html`, no fim do bloco `MODO DISCRETO` do passo anterior, adicionar:

```js
    // Aplica o estado persistido assim que o DOM básico existe.
    document.body.classList.toggle("privacy-on", privacyMode);

    // Ctrl+Shift+H (ou Cmd+Shift+H) — liga/desliga o modo discreto.
    // Fase de captura para preceder o handler do xterm.
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey &&
          (e.key === "H" || e.key === "h")) {
        e.preventDefault();
        e.stopPropagation();
        setPrivacyMode(!privacyMode);
      }
    }, true);
```

- [ ] **Step 6: Verificação manual**

Run: `npm run server` e abrir o Cockpit no browser (ou `npm start` para o app Electron).
Verificar:
1. `Ctrl+Shift+H` faz o chip `🕶 discreto` aparecer no header; de novo, some.
2. No DevTools console: `document.body.classList.contains("privacy-on")` alterna com o atalho.
3. Recarregar a página com o modo ligado mantém o chip visível (persistência).

Expected: os três comportamentos confirmados. (Chrome/CLI ainda não redigidos — Tasks 3-4.)

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat(privacy): estado, toggle Ctrl+Shift+H e chip do Modo Discreto

Co-Authored-By: Ailiv <naoresponda@ailiv.com.br>"
```

---

### Task 3: Redação do texto da CLI + ring buffer

**Files:**
- Modify: `public/index.html` (createXterm ~L3709; helpers perto de `handleMessage` ~L6739; write sites L6744, L6785, L6998)

**Interfaces:**
- Consumes: `redact` (Task 2), `xtermInstances`, o objeto `inst` criado em `createXterm`.
- Produces:
  - Campo `inst.raw: string` (ring buffer cru por terminal).
  - `function writeToTerm(inst, data): void`
  - `function pushRaw(inst, data): void`

- [ ] **Step 1: Inicializar `raw` no objeto do terminal**

Em `public/index.html:3709`, a linha:

```js
      xtermInstances.set(k(proj.id, term.id), { term: xt, fitAddon: fit, container, ro, search: searchAddon, webgl: webglAddon });
```

passa a:

```js
      xtermInstances.set(k(proj.id, term.id), { term: xt, fitAddon: fit, container, ro, search: searchAddon, webgl: webglAddon, raw: "" });
```

- [ ] **Step 2: Adicionar os helpers de escrita**

Em `public/index.html`, imediatamente antes de `function handleMessage(msg) {` (L6739), adicionar:

```js
    // Ring buffer cru por terminal: guarda o stream ANTES da redação, para
    // permitir re-render ao ligar/desligar o Modo Discreto. Cap por bytes.
    const RAW_CAP = 256 * 1024;
    function pushRaw(inst, data) {
      if (!inst || data == null) return;
      inst.raw = (inst.raw || "") + data;
      if (inst.raw.length > RAW_CAP) {
        inst.raw = inst.raw.slice(inst.raw.length - RAW_CAP);
      }
    }
    function writeToTerm(inst, data) {
      if (!inst) return;
      pushRaw(inst, data);
      inst.term.write(redact(data));
    }
```

- [ ] **Step 3: Redirecionar os três pontos de escrita para `writeToTerm`**

Em `public/index.html`, três substituições:

L6744:
```js
          if (inst) inst.term.write(msg.data);
```
→
```js
          if (inst) writeToTerm(inst, msg.data);
```

L6785:
```js
            if (inst) inst.term.write(msg.terminal.buffer);
```
→
```js
            if (inst) writeToTerm(inst, msg.terminal.buffer);
```

L6998:
```js
            if (inst) inst.term.write(t.buffer);
```
→
```js
            if (inst) writeToTerm(inst, t.buffer);
```

- [ ] **Step 4: Verificação manual**

Run: `npm run server` (ou `npm start`), abrir o Cockpit, criar um terminal e rodar `claude` (ou `codex`).
Verificar:
1. Com o modo **ligado** antes de iniciar a CLI: o banner e a statusline aparecem já redigidos (sem "Claude", "Opus", "Codex", "gpt-…").
2. Ligar o modo **depois** do banner na tela: `Ctrl+Shift+H` redige o banner que já estava visível (via re-render do ring buffer).
3. Desligar restaura o texto original sem reiniciar o terminal.
4. Selecionar/copiar a statusline redigida não revela a marca.

Expected: os quatro comportamentos confirmados.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(privacy): redação do stream da CLI + ring buffer para re-render

Co-Authored-By: Ailiv <naoresponda@ailiv.com.br>"
```

---

### Task 4: Neutralização do chrome (header, abas, launcher, badges de uso)

**Files:**
- Modify: `public/index.html` (renderHeader L4716; renderTabs L4762; launcher pill L3779; CSS dos badges de uso ~L455-456)

**Interfaces:**
- Consumes: `nlabel` (Task 2), `redact` (Task 2).
- Produces: nada novo.

- [ ] **Step 1: Neutralizar o nome do agente no header**

Em `public/index.html:4716`:
```js
        document.getElementById("hdrAgent").textContent = t.name;
```
→
```js
        document.getElementById("hdrAgent").textContent = nlabel(t.name);
```

- [ ] **Step 2: Neutralizar o nome do terminal nas abas**

Em `public/index.html:4762`:
```js
            <span class="tab-name">${escapeHtml(t.name)}</span>
```
→
```js
            <span class="tab-name">${escapeHtml(nlabel(t.name))}</span>
```

- [ ] **Step 3: Neutralizar o rótulo e o tooltip dos chips do launcher**

Em `public/index.html:3778-3779`:
```js
        pill.title = c.cmd;
        pill.style.setProperty("--qcmd-color", col);
        pill.dataset.idx = i;
        pill.innerHTML = `<span class="qcmd-play">${ICONS.play}</span><span>${escapeHtml(c.label)}</span><span class="qcmd-remove" data-remove="${i}">${ICONS.x}</span>`;
```

Ajustar as duas linhas que expõem marca (`pill.title` e o `<span>` do label):
```js
        pill.title = redact(c.cmd);
```
```js
        pill.innerHTML = `<span class="qcmd-play">${ICONS.play}</span><span>${escapeHtml(nlabel(c.label))}</span><span class="qcmd-remove" data-remove="${i}">${ICONS.x}</span>`;
```

(As demais linhas do bloco permanecem iguais.)

- [ ] **Step 4: Neutralizar a cor dos badges de uso por plataforma**

Em `public/index.html`, no `<style>`, logo após as regras existentes:
```css
    .usage-acc-plat.claude { background: rgba(217,119,87,.18); color: #e0a07f; }
    .usage-acc-plat.codex  { background: rgba(74,222,128,.14); color: #74d39a; }
```
adicionar:
```css
    body.privacy-on .usage-acc-plat.claude,
    body.privacy-on .usage-acc-plat.codex {
      background: rgba(148,163,184,.16); color: var(--text-secondary);
    }
```

- [ ] **Step 5: Verificação manual**

Run: `npm run server` (ou `npm start`), abrir o Cockpit com o modo **ligado**.
Verificar:
1. O badge do header não mostra marca (um terminal chamado "claude" vira "Agent 1"; nomes comuns como "Terminal 1" ficam iguais).
2. As abas de terminal seguem a mesma regra.
3. O popover ⚡ mostra "Agent 1/2/3" nos chips claude/codex/kimi, e o tooltip não revela `claude --dangerously…`; "npm dev" permanece "npm dev".
4. Os badges de uso perdem a cor de marca (ficam neutros).
5. Desligar o modo restaura os rótulos e cores reais.

Expected: os cinco comportamentos confirmados.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat(privacy): neutraliza header, abas, launcher e badges de uso

Co-Authored-By: Ailiv <naoresponda@ailiv.com.br>"
```

---

## Notas de escopo (fora do plano, por decisão)

- **Modal de gerenciamento de contas** (settings) não é redigido: o usuário precisa
  ver a identidade real (Anthropic/Claude, Codex/ChatGPT) para administrar contas.
- **Sessões muito longas:** o ring buffer é capado em 256 KB; ao ligar o modo numa
  sessão longa, escapes ANSI de configuração muito antigos podem ter saído do buffer,
  causando no máximo pequenos deslizes de cor após o re-render. Aceito.
- **Alinhamento de box-drawing:** quando o texto neutro tem largura diferente do
  original, o desenho de caixas pode ficar 1-2 colunas torto. Aceito.
- **CLIs novas** que imprimam identificadores inéditos: resolver adicionando padrões a
  `PRIVACY_PATTERNS` em `public/privacy.js`.
