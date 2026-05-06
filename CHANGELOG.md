# Changelog

Todas as mudanças relevantes do Cockpit. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

Datas em GMT-3 (Horário de Brasília).

## [Unreleased]

_(nada ainda)_

---

## [0.6.5] — 2026-05-06

### Adicionado
- **Sidebar redimensionável** — arraste a borda direita da sidebar para ajustar a largura (160–480 px). Largura persiste no localStorage entre sessões. Terminais fazem fit automático ao soltar.
- **Header invertido** — status de conexão, voz e relógio agora ficam à esquerda; "COCKPIT · cabine de comando" e botões de janela à direita (ordem: 🟢🟡🔴).
- **Drag & drop de arquivo no terminal** — arraste um arquivo para a área do terminal para colar o caminho automaticamente.
- **Paste de arquivo/imagem copiado** — Ctrl+V e botão do meio detectam `text/uri-list` no clipboard (arquivo ou imagem copiados do gerenciador) e colam o caminho do arquivo em vez de dados binários.

---

## [0.6.3] — 2026-05-05

### Corrigido
- **Projetos ocultos voltavam a aparecer** ao reabrir o cockpit ou em qualquer broadcast `projects_changed`. Causa: o cliente populava o array `projects` copiando campos um-a-um e o `hidden` não estava na lista — ficava sempre `undefined` depois de uma reconexão. Agora `handleHello` e `handleProjectsChanged` incluem `hidden: !!p.hidden` em ambos os branches (criar e atualizar).

### Adicionado
- **Comandos rápidos padrão em projeto novo** — todo projeto recém-criado já vem com `claude`, `codex`, `kimi` e `npm dev` pré-cadastrados. Antes era array vazio e o usuário tinha que adicionar do zero em cada projeto. Edição de projeto existente continua mostrando os comandos originais (não sobrescreve).

### Alterado
- **Visual da seção "Projetos" na sidebar**: contagem virou pílula com border discreto, botões 👁 e ➕ ficaram 24×24 (era 18×18) com border-radius 6px, hover mais legível. O **botão ➕ ganhou destaque azul claro** (cor primária do app) — sinaliza que é a ação principal da seção.
- Botão 👁 marca estado **`.is-open`** enquanto o popover de visibilidade está aberto. Click novamente fecha.

---

## [0.6.2] — 2026-05-05

### Adicionado
- **Botão olho na sidebar de projetos** — ao lado do "+", abre um popover com a lista completa de projetos. Cada linha alterna entre visível/oculto com um clique. Atalhos "mostrar todos" / "ocultar todos" no header. Útil pra deixar a sidebar limpa quando você só está trabalhando em 2-3 projetos sem precisar excluir os outros.
- Campo `hidden: bool` em cada projeto. `false`/ausente é o default — projetos antigos aparecem normalmente.

### Alterado
- Contagem `N/M` no header da sidebar mostra `visíveis/total` quando há projetos ocultos.
- `validateProjectShape` no servidor não muda — `hidden` flui via `update_project` como qualquer outro campo opcional.

---

## [0.6.1] — 2026-05-05

### Corrigido
- **Ctrl+C no terminal não copiava** quando havia texto selecionado — sempre mandava SIGINT pra shell. Agora: com seleção ativa, copia pro clipboard; sem seleção, mantém o SIGINT (comportamento padrão de qualquer terminal moderno tipo iTerm2/Konsole).
- **Ctrl+V agora cola** do clipboard direto no pty.
- **Botão direito no terminal** abre menu de contexto novo: Copiar / Colar / Selecionar tudo / Buscar / Limpar. Antes não tinha menu — clicar com direito não fazia nada.
- **Botão do meio do mouse** cola do clipboard (convenção Linux clássica).

### Adicionado
- **Drag & drop pra reordenar abas de terminal**. Arrasta a aba pra esquerda/direita e solta. Indicador visual (linha colorida) mostra onde vai cair. A ordem fica só client-side (terminais não persistem entre sessões mesmo).

---

## [0.6.0] — 2026-05-04

Reescrita do módulo de voz com 3 engines TTS plugáveis. **Default agora é OpenAI TTS** (cloud, voz `nova`) em vez de OmniVoice local.

### Adicionado
- **Engine OpenAI TTS** (`tts_engine: "openai"`, default) — usa a API `tts-1-hd` da OpenAI. Vantagens: zero GPU, zero modelo carregado, boot do daemon em ~2s, voz idêntica sempre, funciona em qualquer máquina cliente. Custo ~$0.030 por 1k chars (~R$ 5-25/mês de uso típico). Reaproveita a `api_key` que o módulo `summarize` já configura.
- **Engine XTTS-v2** (`tts_engine: "xtts"`) — Coqui XTTS-v2 local. Opcional pra quem prefere off-line e tem GPU 3GB+. Clonagem de voz funcional mas não chegou na qualidade da OpenAI no caso Jarvis.
- **`daemon-openai.py`** — daemon novo, ~150 linhas, sem dependências de modelo. Usa `response_format=pcm` da OpenAI pra evitar decodificar MP3. Mesma API socket dos outros daemons (ping/speak/stop/reload/shutdown).
- **`daemon-xtts.py`** — daemon XTTS, mantém mesma API socket. Cacheia `gpt_cond_latent` no boot pra acelerar síntese (~5s pra 6s áudio em GPU).
- **Seletor de voz** no popover do Járvis — quando `tts_engine: openai`, aparece um dropdown com as 6 vozes (alloy/echo/fable/onyx/nova/shimmer). Trocar dispara `voice_reload` no daemon.

### Alterado
- **`lib/voice.js`**: `ENGINE_DEFAULTS` mapeia engine → script + venv. `spawnDaemon` lê `cfg.tts_engine` e escolhe o daemon correto. Suporta `omnivoice`, `xtts` e `openai`.
- **`server.js`**: whitelist do `voice_patch_config` aceita `tts_engine`, `openai_voice`, `openai_model`.
- **Config seed** vem com `tts_engine: "openai"` e `openai_voice: "nova"` por padrão. Cliente que prefere off-line muda manualmente.

### Notas técnicas
- OpenAI TTS suporta streaming nativo (~500ms primeira chunk). Não implementado nesta release — request/response inteiro fica em ~3s pra frases médias e está OK pro UX.
- XTTS é mais portável (roda em CPU também), mas em testes locais não reproduziu o timbre Jarvis específico — provavelmente porque a referência aprovada original foi gerada por TTS cloud. OmniVoice fica como fallback histórico.
- Venv do XTTS (~6GB) é opcional e fica em `~/.local/share/cockpit/venv-xtts/` quando o usuário escolher esse engine.

---

## [0.5.6] — 2026-05-04

### Corrigido
- **Voz Jarvis sintetizada estava com timbre degradado.** Causa raiz: o `voice_ref.txt` (transcrição da voz de referência) estava com **uma frase faltando** — o áudio diz "Senhor, renderização pronta. **Um pouco de ostentação, né?** Mil perdões, senhor. Afinal, o senhor é sempre tão discreto." mas o txt só tinha "Senhor, renderização pronta. Mil perdões, senhor. Afinal...". O OmniVoice usa áudio+texto pra alinhar fonemas e clonar voz; com o texto incompleto, o cloning saía ruim. Corrigido em `modules/voice/voice_ref.txt` e no `voice_ref_text` do config seed.
- **Switch do Járvis ficava preso em "offline" mesmo com daemon vivo**, especialmente após desativar/ativar várias vezes seguidas. O polling de status durava só 30s; depois disso a UI parava de checar. Agora o popover faz polling contínuo (2s) enquanto está aberto, e para quando fecha ou quando o daemon fica vivo.
- **CUDA out-of-memory ao clicar rápido no switch.** Cada toggle spawna/mata o daemon; tentativas em série não dão tempo da GPU liberar e o segundo daemon morre com OOM. Agora o switch tem debounce de 200ms e fica disabled por 3s após cada toggle, evitando o problema.

### Adicionado
- `scripts/voice-diag.py` — busca brute-force de `seed`/`speed` que produz síntese mais similar à `AMOSTRA_APROVADA.wav` (referência da voz Jarvis aprovada). Usa similaridade espectral log-mel pra rankear automaticamente. Útil pra reajustar parâmetros se o modelo OmniVoice for atualizado.

---

## [0.5.5] — 2026-05-04

### Corrigido
- **Daemon do Járvis nunca subia no `.deb` instalado.** Causa raiz: o `cwd` do `spawn(python3, ['daemon.py'])` apontava pra dentro do `app.asar` — e asar é um arquivo monolítico, não diretório, então Node retornava `ENOTDIR` silenciosamente. Os fixes anteriores (config no userData, fluxo do switch, polling) eram corretos mas não bastavam: o daemon Python literalmente não chegava a executar.
- **Socket zumbi em `/tmp/claude-voice.sock`** (de daemon morto sem cleanup) bloqueava o spawn do novo. Agora o `spawnDaemon` remove o socket stale antes de subir.
- **Logs do daemon iam pra um caminho hardcoded** (`/home/ftgk/cockpit/modules/voice/logs/`) que não existia fora da máquina do desenvolvedor — `try/except` no daemon escondia o erro. Agora `VOICE_LOG_FILE` env var aponta pra `userData/voice-logs/`, sempre gravável.

### Alterado
- **`asarUnpack`** em `package.json` agora inclui `modules/voice/**/*` — electron-builder extrai o módulo pra `app.asar.unpacked/modules/voice/` durante o build, transformando-o num diretório real.
- **`lib/voice.js`** detecta produção via path e substitui `app.asar` por `app.asar.unpacked` no `VOICE_DIR` antes de spawnar.
- **`voice.init({ configPath, logsDir })`** aceita os dois caminhos; electron-main passa userData/voice-logs/ como logsDir.
- **`daemon.py`** lê `VOICE_LOG_FILE` do ambiente como override do `log_file` no config.

---

## [0.5.4] — 2026-05-04

### Corrigido
- **Versão na barra de título estava cravada em `v0.4 · alpha`** desde o commit inicial — não acompanhava o `package.json`. Agora o servidor lê `version` do `package.json` no boot, manda no `helloPayload`, e o cliente exibe automaticamente. Nunca mais sai de sincronia.

---

## [0.5.3] — 2026-05-04

### Corrigido
- **Switch do Járvis ficava desabilitado quando o daemon estava offline**, criando um catch-22: pra subir o daemon você precisa ligar o switch, mas o switch só fica habilitado quando o daemon já está vivo. Agora ele reflete o estado de `enabled` na config — habilitado em qualquer cenário, com mensagem clara em caso de daemon offline ("ative no switch pra subir").
- **Feedback visual durante o boot do daemon**: o OmniVoice leva 10-30s pra carregar o modelo no GPU. Antes a UI fazia uma única checagem 150ms depois do `set_enabled` e mostrava "offline" pra sempre. Agora faz polling 1×/s por até 30s e mostra um toast "ativando Járvis (carregando modelo)…" enquanto isso.

---

## [0.5.2] — 2026-05-04

### Corrigido
- **Caracteres `⎿`, `⏺` e similares ainda apareciam pretos** mesmo com a fonte do sistema. Causa real: o renderer **WebGL** do xterm.js rasteriza tudo com UMA fonte só — quando o glyph cai em fonte de fallback do SO (`⎿` mora no Noto CJK, `⏺` no FreeMono no Linux), ele mostra "tofu" preto. Não tem nada a ver com fontes custom.

### Alterado
- **Renderer DOM agora é o default** no terminal — o browser faz fallback de fonte por glyph automaticamente, então qualquer caractere Unicode renderiza correto desde que alguma fonte do sistema o tenha.
- **Setting renomeado**: `ligatures` → `webglFast` (default `false`). Quem quiser a aceleração WebGL pra logs gigantes liga manualmente em Configurações → "Renderer WebGL (rápido, mas com limitações)". O hint deixa claro o trade-off.
- Ligaduras tipográficas (`=>`, `!==`, `>=`) ficam **sempre ativas** agora — o DOM honra; o WebGL ignora silenciosamente, e tudo bem.

---

## [0.5.1] — 2026-05-04

### Corrigido
- **Switch de ativação do Járvis ficava preso em "desativado"** no `.deb` instalado. Causa: `modules/voice/config.json` viajava dentro do `app.asar`, que é read-only — quando o switch tentava gravar `enabled: true`, o `fs.writeFileSync` falhava silenciosamente e o daemon nunca subia. Mesma armadilha que o `projects.json` já tinha resolvido em versão anterior.

### Alterado
- `voice-config.json` agora vive em `userData` (gravável em produção). Electron-main copia o seed do asar na primeira execução; depois disso é a fonte da verdade.
- `lib/voice.js` exporta `init({ configPath })` — o caminho do config é injetado pelo electron-main via `startServer({ voiceConfigPath })`. Em modo dev o caminho continua sendo `modules/voice/config.json` ao lado do código.
- `modules/voice/daemon.py` lê `VOICE_CONFIG_PATH` da env var (com fallback pro `config.json` ao lado do script). O cockpit Node passa essa env var ao spawnar o daemon, garantindo que ambos os processos leiam o mesmo arquivo.
- `VENV_PYTHON` em `lib/voice.js` agora respeita `COCKPIT_VOICE_PYTHON` (env var) — facilita apontar pra um Python diferente sem editar o source.

---

## [0.5.0] — 2026-05-04

Redesign do seletor de pastas — quebra a dependência do `/home/ftgk/` hardcoded
e prepara o app para distribuição a clientes em qualquer SO.

### Adicionado
- **`system` no `hello` payload** — servidor agora envia `home`, `platform`, `sep` e `commonPaths` (lista de atalhos detectados que existem de fato no SO do usuário).
- **Atalhos dinâmicos no picker** — sidebar agrupa locais por categoria (Início, Desktop, Documentos, Downloads, Projetos), populada a partir do que o servidor encontrou (`Documents`/`Documentos`, `code`, `dev`, `Projects`/`Projetos`, `GitHub` em vários locais comuns, etc.).
- **Badge "git"** ao lado de pastas que contêm `.git` — destaca repositórios na navegação.
- **Banner "✓ pasta com repositório Git"** quando o diretório atual é um repo — sinaliza um bom candidato a projeto.
- **Toggle "mostrar ocultos"** — controla pastas começando com `.` (Ctrl+H).
- **Atalhos de teclado**: `Backspace` sobe um nível, `↑/↓` navegam, `Enter` abre a pasta selecionada (ou confirma se nenhuma estiver selecionada), `~` no input expande pra HOME real.
- **Botão "Home"** dedicado na barra de ferramentas.

### Alterado
- **`showPathPicker`** reescrito com layout de 2 colunas (sidebar 180px + lista). Modal cresceu de 520px para 720px.
- **Caminho exibido com `~`** quando dentro do home — reduz ruído visual.
- **`listDirs` no servidor** retorna agora `entries` (com `name`, `hidden`, `isGit` por subpasta), `parent`, `home` e `isGitDir`. Campo legado `dirs` mantido para compat.
- **Default do picker** caiu de `/home/ftgk` para `systemInfo.home` — vindo do servidor, sempre correto pro SO atual.

### Removido
- Hardcode de `/home/ftgk` em `showPathPicker` e nos shortcuts.

---

## [0.4.2] — 2026-05-04

### Alterado
- **Fontes custom removidas** — JetBrains Mono e IBM Plex Mono saíram. App inteiro (UI, terminal, editor Monaco) agora usa a stack monospace nativa do SO: `ui-monospace, "SF Mono", "DejaVu Sans Mono", "Consolas", "Liberation Mono", monospace`. Decisão tomada após dois bugs seguidos (v0.4.0/v0.4.1) com glyphs faltando no boot por causa do atlas WebGL pré-rasterizando antes da `@font-face` baixar. Eliminar a `@font-face` elimina o problema de raiz, e a fonte do SO ainda traz suporte mais amplo a Unicode (acentos, box-drawing, símbolos) que os subsets latin do Fontsource não cobriam.

### Removido
- `@fontsource/jetbrains-mono` e `@fontsource/ibm-plex-mono` das dependências.
- Diretório `public/vendor/fonts/` e todos os preloads/`@font-face` no `<head>`.
- Warmup `document.fonts.load()` e o `clearTextureAtlas`/`refresh` no terminal — não são mais necessários sem fontes externas.

### Notas
- Bundle `public/vendor/` reduz ~200 KB (Monaco continua dominando com ~14 MB).
- Visual fica menos "premium" que com JetBrains Mono, mas o terminal **sempre** funciona — qualquer caractere que o sistema operacional desenha, o app desenha.

---

## [0.4.1] — 2026-05-04

### Corrigido
- **Botão ⚡ de comandos rápidos** agora aparece **sempre** na barra de abas, mesmo em projetos sem comandos cadastrados. Antes ele só era renderizado quando havia ao menos um comando — o que tornava impossível adicionar o primeiro pelo popover.
- Quando o popover é aberto sem comandos, mostra a mensagem "Nenhum comando ainda" e o ícone de engrenagem (⚙ Gerenciar comandos…) abre o modal de gerenciamento.
- **Atlas de glyphs do WebGL** é limpo e o terminal recebe `refresh()` quando `document.fonts.ready` resolve. Corrige bug em que palavras apareciam com letras faltando no boot, porque o WebGL pré-rasterizava o atlas antes da `@font-face` (servida localmente) terminar de carregar.

### Adicionado
- Preload das fontes 400 (`<link rel="preload" as="font">`) no head, reduz a janela em que o WebGL pode rasterizar com fallback.

---

## [0.4.0] — 2026-05-03

Modernização do terminal e independência de CDN. Tudo que o app carrega passa a ser servido localmente.

### Adicionado
- **xterm.js WebGL renderer** — renderização via GPU (3-5× mais FPS em logs grandes), com fallback automático pro renderer DOM em caso de context-loss.
- **Addon Unicode 11** — largura correta para emojis, CJK e símbolos modernos no terminal.
- **Addon Clipboard (OSC 52)** — copy/paste funciona quando vem de tmux ou SSH remoto.
- **Toggle "Ligaduras tipográficas"** nas configurações — quando ligado, alterna pro renderer DOM e ativa shaping nativo (`=>`, `!==`, `>=` viram glifos únicos). Trade-off: perde a aceleração WebGL. Persiste em `localStorage`.
- **Script `npm run vendor`** (`scripts/copy-vendor-assets.js`) — copia bundles de terceiros de `node_modules/` para `public/vendor/` durante `postinstall`. Cobre xterm + addons, monaco-editor e fontes.
- MIME types adicionais no servidor: `woff2`, `woff`, `ttf`, `ttc`, `map`, `ico`.

### Alterado
- **xterm.js** servido localmente em `/vendor/xterm/` (antes vinha de `cdn.jsdelivr.net`).
- **Monaco editor** servido localmente em `/vendor/monaco/vs/` (antes vinha de `cdn.jsdelivr.net`).
- **JetBrains Mono / IBM Plex Mono** servidas localmente em `/vendor/fonts/` (antes vinham de `fonts.googleapis.com`). Subset latin nos pesos efetivamente usados — ~200 KB total contra ~3.8 MB do pacote completo.

### Removido
- Dependência de runtime de CDNs externos (jsdelivr, Google Fonts). O app agora abre 100% offline.

### Notas técnicas
- Ligaduras via `@xterm/addon-ligatures` foi avaliado e descartado: precisa de Node API no renderer (`font-finder`/`font-ligatures`), incompatível com `nodeIntegration:false` + `contextIsolation:true` que mantemos por segurança. A solução via toggle DOM/WebGL atinge o mesmo efeito visual.
- Tamanho do `public/vendor/`: ~14.5 MB (Monaco domina com ~14 MB).

---

## [0.1.0] — antes de 2026-05-03

Commit inicial — versão funcional do Cockpit (cabine de comando para múltiplos agentes de IA em vários projetos, embarcada em Electron + node-pty + xterm.js).

Detalhes não documentados retroativamente.

---

## Como manter este arquivo

1. **Trabalho em andamento** entra em `[Unreleased]` no topo.
2. **Categorias** (Keep a Changelog):
   - `Adicionado` — features novas
   - `Alterado` — mudanças em comportamento existente
   - `Depreciado` — features marcadas para remoção
   - `Removido` — features que saíram
   - `Corrigido` — bugfixes
   - `Segurança` — fixes de segurança
3. **Quando lançar versão**:
   - Renomear `[Unreleased]` para `[X.Y.Z] — AAAA-MM-DD`
   - Criar nova seção `[Unreleased]` vazia no topo
   - Bumpar `version` em `package.json`
   - Commitar: `chore(release): vX.Y.Z`
   - Tag: `git tag -a vX.Y.Z -m "X.Y.Z"`
4. **SemVer**: `MAJOR.MINOR.PATCH` — quebras → MAJOR, features → MINOR, fixes → PATCH.
