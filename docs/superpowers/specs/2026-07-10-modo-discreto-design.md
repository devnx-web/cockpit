# Modo Discreto — Design

**Data:** 2026-07-10
**Status:** Aprovado para implementação

## Problema

O Cockpit revela qual agente de IA está em uso (Claude Code, Codex, Kimi) em duas
frentes: o *chrome do Cockpit* (badge do header, botões do launcher, cores por
agente nas abas e nos badges de uso) e o *texto que a própria CLI imprime dentro
do terminal* (banner de boas-vindas, statusline persistente, box de inicialização,
nome do modelo). Ao gravar tela, tirar screenshot ou apresentar, o usuário não
quer divulgar qual ferramenta está usando.

## Objetivo

Um **Modo Discreto** com toggle rápido (`Ctrl+Shift+H`) que neutraliza toda a
identidade do agente na renderização — tanto o chrome do Cockpit quanto o texto
impresso pela CLI — e que volta ao normal quando desligado. Voltado a
gravação / screenshot / apresentação.

## Decisões

- **Acionamento:** toggle por atalho `Ctrl+Shift+H` (livre; handler central em
  `public/index.html:~3538`). Sem botão clicável nesta versão.
- **Persistência:** flag `privacyMode` em `cockpit-settings` (localStorage),
  default **desligado**. Persiste para que um reload no meio de uma gravação não
  exponha o usuário.
- **Indicador:** chip discreto `🕶 discreto` visível apenas com o modo ligado,
  para o usuário saber o estado atual.
- **Redação da CLI:** feita **no cliente**, na renderização (não no PTY nem no
  buffer do servidor). Substituição de texto sobre o stream cru — sem parsear ANSI.
- **Escopo cobre:** os dois — chrome do Cockpit **e** texto impresso pela CLI.

## Arquitetura

Tudo em `public/index.html` (arquivo único da UI). Três unidades independentes:

### Unidade 1 — Estado & toggle
- Flag `privacyMode` lida de `cockpitSettings` (helpers em ~3372-3380).
- Função `setPrivacyMode(on)`:
  - persiste em settings;
  - `document.body.classList.toggle("privacy-on", on)`;
  - re-renderiza chrome (header, abas, launcher) via os renderizadores existentes;
  - dispara o re-render dos terminais visíveis (Unidade 3).
- Atalho `Ctrl+Shift+H` no handler central de teclado chama `setPrivacyMode(!privacyMode)`.
- Chip `🕶 discreto` no DOM, exibido/escondido via CSS `.privacy-on`.

### Unidade 2 — Neutralização do chrome (CSS + JS)
- **JS:** função pura `neutralizeLabel(brand)` → mapa fixo
  `claude→"Agent 1"`, `codex→"Agent 2"`, `kimi→"Agent 3"`, fallback `"Agent"`.
  Aplicada, **somente quando `privacyMode` on**, nos pontos que renderizam nome
  de agente:
  - badge do header `#hdrAgent` / `#hdrRuntime` (~4716);
  - rótulos dos botões do launcher (~3332-3334 e ~3875-3876);
  - item de menu de contexto `act-claude` (~7036, 7164).
- **CSS `.privacy-on`:**
  - neutraliza cores por agente das abas e dos badges `.usage-acc-plat.claude` /
    `.usage-acc-plat.codex` (~455-456) para um accent único neutro;
  - esconde (`display:none`) os grupos de painel de conta que citam marcas
    ("Anthropic / Claude", "Codex / ChatGPT") — são fora do fluxo principal, mas
    revelam identidade.

### Unidade 3 — Redação do texto da CLI (stream, cliente)
- **Lista central de padrões** `PRIVACY_PATTERNS`: array de `{ re, repl }` com
  regex case-insensitive e substituição de tamanho aproximado para preservar
  alinhamento. Cobertura inicial:
  - `Claude Code`, `Claude Max`, `Opus 4\.8`, `\(1M context\)`,
    `with (high|medium|low) effort`
  - `OpenAI Codex`, `gpt-[\w.\-]+`, `YOLO mode`
  - `Kimi`, `kimi`
  - Ecos de comando de launch com marca → neutro.
- Função pura `redactStream(data)`: se `privacyMode` off, retorna `data` intacto;
  senão aplica todos os padrões e retorna o texto redigido.
- **Ponto de aplicação:** wrapper `writeToTerm(inst, data)` que chama
  `inst.term.write(redactStream(data))`, substituindo os `inst.term.write(...)`
  de dados de CLI em: `output` (~6744), replay de `terminal_added` (~6785),
  replay de troca de view (~6998).
- **Ring buffer no cliente:** cada `inst` ganha `inst.raw` (string, cap ~256 KB,
  FIFO por corte de prefixo). Todo `msg.data`/buffer recebido é anexado ao `raw`
  **cru** (antes da redação).
- **Re-render no toggle:** `setPrivacyMode` percorre os terminais visíveis e, para
  cada um, `term.clear()` + `term.write(redactStream(inst.raw))`. Isso redige (ou
  restaura) o conteúdo já na tela — inclusive o banner que já havia aparecido.

## Fluxo de dados

```
msg.data (cru) ──► inst.raw += data (ring buffer, cru)
                └► writeToTerm(inst, data) ──► redactStream(data) ──► term.write
Ctrl+Shift+H ──► setPrivacyMode(!on) ──► body.class + re-render chrome
                                      └► por terminal visível: clear + write(redact(inst.raw))
```

## Tratamento de erros / bordas

- `redactStream` nunca lança: em qualquer erro de regex, retorna `data` original
  (fail-open na renderização — nunca quebra o terminal).
- Ring buffer com cap por bytes; corte por prefixo de linha aproximado para não
  estourar memória com sessões longas.
- Alinhamento de box-drawing pode ficar 1-2 colunas torto quando o neutro tem
  tamanho diferente — aceito.

## Fora de escopo (YAGNI)

- Não altera o I/O real do PTY nem o buffer do servidor (`server.js`).
- Não parseia/reescreve ANSI; opera substituição de texto sobre o stream cru.
- Sem botão clicável (só atalho) nesta versão.
- Não cobre CLIs desconhecidas que imprimam identificadores inéditos — resolvido
  adicionando padrões a `PRIVACY_PATTERNS`.

## Critérios de sucesso

1. `Ctrl+Shift+H` liga/desliga o modo; chip `🕶 discreto` reflete o estado.
2. Com o modo ligado: header, abas, launcher e badges de uso não exibem marca.
3. Com o modo ligado: banner, statusline e box de init da CLI aparecem redigidos —
   inclusive conteúdo que já estava na tela antes de ligar.
4. Copiar texto redigido do terminal não revela a marca.
5. Desligar restaura tudo ao original sem reiniciar terminais.
6. Reload preserva o estado do modo.
