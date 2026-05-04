# Changelog

Todas as mudanças relevantes do Cockpit. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

Datas em GMT-3 (Horário de Brasília).

## [Unreleased]

_(nada ainda)_

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
