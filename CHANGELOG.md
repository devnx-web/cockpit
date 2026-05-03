# Changelog

Todas as mudanças relevantes do Cockpit. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

Datas em GMT-3 (Horário de Brasília).

## [Unreleased]

_(nada ainda)_

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
