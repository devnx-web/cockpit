# Cockpit

Cabine de comando para múltiplos agentes de IA em vários projetos. App desktop em Linux (Electron + node-pty + xterm.js) com terminal multi-aba, painel de arquivos, editor Monaco e módulo de voz Járvis.

**Versão atual:** 0.17.0 — [changelog](./CHANGELOG.md)

> Instalador one-liner: `curl -fsSL https://arquivos.devnx.com.br/cockpit/v0.17.0/install.sh | sudo bash`

---

## Instalação rápida

### `.deb` (Debian/Ubuntu)

```bash
curl -L https://arquivos.devnx.com.br/cockpit/v0.17.0/cockpit-devnx_0.17.0_amd64.deb -o /tmp/cockpit.deb
sudo dpkg -i /tmp/cockpit.deb
# Se faltar dependência:
sudo apt -f install
```

Abre pelo menu do sistema ou `/opt/Cockpit/cockpit`.

### AppImage (qualquer distro Linux)

```bash
curl -L https://arquivos.devnx.com.br/cockpit/v0.17.0/Cockpit-0.17.0.AppImage -o ~/Cockpit.AppImage
chmod +x ~/Cockpit.AppImage
~/Cockpit.AppImage
```

Detalhes completos (atualizar, troubleshooting, paths): **[installer.md](./installer.md)**.

---

## Configurar o Járvis (módulo de voz)

A partir da v0.6.0 o Járvis usa **OpenAI TTS** por padrão — sem GPU, voz `nova` (feminina). Pra ativar:

1. Abra o cockpit
2. Edite `~/.config/Cockpit/voice-config.json`
3. Cole sua API key da OpenAI no bloco `summarize.api_key` (essa key serve tanto pro resumo quanto pro TTS):

```json
{
  "tts_engine": "openai",
  "openai_voice": "nova",
  "openai_model": "tts-1-hd",
  "summarize": {
    "api_key": "sk-proj-..."
  }
}
```

4. No cockpit, clica no indicador 🎙 do Járvis (canto superior direito) → liga o switch
5. Daemon sobe em ~2s, escolhe a voz no dropdown "Voz (OpenAI)" se quiser trocar (alloy, echo, fable, onyx, nova, shimmer)

**Custo aproximado**: ~R$ 0,002 por frase média. Uso típico fica em R$ 5–25/mês.

### Alternativas off-line

Se preferir sem cloud, edite `voice-config.json` e troque `tts_engine` para `xtts` (Coqui XTTS-v2 local — precisa GPU 3GB+ ou CPU paciente) ou `omnivoice` (legado, GPU-only). Ambos clonam voz a partir de `voice_ref.wav`.

---

## Rodar do código-fonte (dev)

```bash
git clone <repo-url> cockpit
cd cockpit
npm install        # postinstall copia vendor/ e rebuilda node-pty
npm start          # abre Electron em modo dev
```

Gerar artefatos:

```bash
npm run dist:linux
# → dist/cockpit_<v>_amd64.deb
# → dist/Cockpit-<v>.AppImage
```

---

## Atalhos do terminal

- **Ctrl+C** — copia (com seleção) ou SIGINT (sem seleção)
- **Ctrl+V** — cola do clipboard
- **Botão direito** — menu Copiar/Colar/Selecionar tudo/Buscar/Limpar
- **Botão do meio** — cola rápido
- **Ctrl+B** — novo terminal
- **Ctrl+P** — busca arquivos por nome ou caminho
- **Ctrl+W** — fecha terminal
- **Ctrl+F** — busca no terminal
- **Ctrl+L** — limpa terminal
- **Ctrl+Shift+1..9** — seleciona aba 1..9
- **Drag & drop nas abas** — reordena

---

## Onde ficam os arquivos

| Item | Caminho |
|---|---|
| Binário (`.deb`) | `/opt/Cockpit/` |
| Configurações de usuário | `~/.config/Cockpit/` |
| `projects.json` | `~/.config/Cockpit/projects.json` |
| `voice-config.json` (Járvis) | `~/.config/Cockpit/voice-config.json` |
| Logs do daemon de voz | `~/.config/Cockpit/voice-logs/` |
| Cache do Electron | `~/.config/Cockpit/Cache/` |

---

## Versões anteriores

```
https://arquivos.devnx.com.br/cockpit/v<MAJOR.MINOR.PATCH>/cockpit_<v>_amd64.deb
https://arquivos.devnx.com.br/cockpit/v<MAJOR.MINOR.PATCH>/Cockpit-<v>.AppImage
```

Histórico completo no [CHANGELOG.md](./CHANGELOG.md).
