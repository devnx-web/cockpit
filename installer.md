# Cockpit — Guia de Instalação

Cabine de comando para múltiplos agentes de IA em vários projetos. Roda como app desktop em Linux (Electron + node-pty + xterm.js).

Versão atual: **0.17.0** ([changelog](https://arquivos.devnx.com.br/cockpit/v0.17.0/CHANGELOG.md))

> Instalador one-liner: `curl -fsSL https://arquivos.devnx.com.br/cockpit/v0.17.0/install.sh | sudo bash`

---

## Pré-requisitos

- Linux x86_64 (Ubuntu 22.04+, Debian 12+, Fedora 38+, Arch, etc.)
- ~250 MB de espaço em disco (binário) + ~50 MB para config/cache
- Para o `.deb`: `sudo` e `dpkg`
- Para o AppImage: nada além do FUSE (já vem na maioria das distros)
- **Para o módulo de voz Járvis (opcional):** uma API key da OpenAI. Sem internet ou key, o cockpit funciona normalmente — só o Járvis fica desativado.

---

## Instalação rápida

### Opção 1 — `.deb` (recomendado pra Debian/Ubuntu)

```bash
curl -L https://arquivos.devnx.com.br/cockpit/v0.17.0/cockpit-devnx_0.17.0_amd64.deb -o /tmp/cockpit.deb
sudo dpkg -i /tmp/cockpit.deb
```

Se faltar dependência:
```bash
sudo apt -f install
```

Após instalar, o **Cockpit** aparece no menu de aplicativos. Ou abra pelo terminal:
```bash
/opt/Cockpit/cockpit
```

### Opção 2 — AppImage (qualquer distro Linux)

Não exige `sudo` nem instala nada no sistema.

```bash
curl -L https://arquivos.devnx.com.br/cockpit/v0.17.0/Cockpit-0.17.0.AppImage -o ~/Cockpit.AppImage
chmod +x ~/Cockpit.AppImage
~/Cockpit.AppImage
```

Para integrar com o menu de aplicativos, use o [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher).

### Opção 3 — Rodar do código-fonte (desenvolvedores)

```bash
git clone <repo-url> cockpit
cd cockpit
npm install        # roda o postinstall que copia vendor/ e rebuild do node-pty
npm start          # abre o Electron em modo dev
```

Para gerar os artefatos `.deb` e `.AppImage`:
```bash
npm run dist:linux
# → dist/cockpit_<versão>_amd64.deb
# → dist/Cockpit-<versão>.AppImage
```

---

## Ativar o Járvis (módulo de voz, opcional)

A partir da v0.6.0 o Járvis usa por padrão a API **OpenAI TTS** (cloud, voz `nova` feminina). Vantagens:

- Zero GPU
- Boot do daemon em ~2s
- Voz idêntica em qualquer máquina
- Funciona em hardware modesto (cliente sem placa de vídeo)

**Custo:** ~$0.030 por 1k chars com `tts-1-hd`. Em uso típico (frases curtas), ~R$ 5-25/mês.

### Configurar (uma vez)

1. Abra `~/.config/Cockpit/voice-config.json` (criado automaticamente na primeira execução)
2. Cole sua API key OpenAI no bloco `summarize.api_key` — a mesma key serve pro TTS e pro resumo:

```json
{
  "enabled": true,
  "tts_engine": "openai",
  "openai_voice": "nova",
  "openai_model": "tts-1-hd",
  "summarize": {
    "api_key": "sk-proj-XXXXXXXXXXXXX"
  }
}
```

3. No cockpit, clica no indicador 🎙 (canto superior direito) → liga o switch
4. Em ~2s aparece "pronto" — clica em "Falar" pra testar

### Trocar a voz

No popover do Járvis, dropdown "Voz (OpenAI)":

| Voz | Característica |
|---|---|
| **nova** (default) | feminina natural |
| **shimmer** | feminina suave |
| **alloy** | neutra/andrógina |
| **echo** | masculina média |
| **fable** | masculina britânica (estilo Jarvis Iron Man) |
| **onyx** | masculina grave |

Mudar a voz dispara `voice_reload` no daemon — sem precisar reiniciar nada.

### Modo off-line (sem internet/sem OpenAI)

Edite `voice-config.json` e troque `tts_engine` para:

- **`xtts`** — Coqui XTTS-v2 local. Clona a voz de `voice_ref.wav`. Precisa de:
  - venv Python em `~/.local/share/cockpit/venv-xtts/` com `coqui-tts==0.25.3`, `torch`, `transformers<4.50`, `sounddevice`, `torchcodec`
  - GPU NVIDIA com 3GB+ VRAM (ou CPU bem paciente)
  - ~6GB de disco (modelo + venv)

- **`omnivoice`** — engine legado da v0.4.x. GPU-only.

---

## Atualizar para uma nova versão

### A partir do `.deb`
```bash
pkill -f "/opt/Cockpit/cockpit" 2>/dev/null    # fecha o app
curl -L https://arquivos.devnx.com.br/cockpit/v0.17.0/cockpit-devnx_0.17.0_amd64.deb -o /tmp/cockpit.deb
sudo dpkg -i /tmp/cockpit.deb       # substitui a versão anterior
```

Não precisa desinstalar antes — o `dpkg -i` faz upgrade in-place. Suas configurações ficam preservadas em `~/.config/Cockpit/`.

### A partir do AppImage
Baixe o novo arquivo e substitua o antigo.

---

## Verificar instalação

```bash
# .deb
dpkg -l cockpit
# espera: ii  cockpit-devnx  0.17.0  amd64

# AppImage (sem dpkg)
~/Cockpit.AppImage --version
```

Se o app abrir e listar seus projetos, está tudo certo. A barra de título mostra a versão.

---

## Onde ficam os arquivos

| Item | Caminho |
|---|---|
| Binário (`.deb`) | `/opt/Cockpit/` |
| Configurações de usuário | `~/.config/Cockpit/` |
| Lista de projetos | `~/.config/Cockpit/projects.json` |
| Config do Járvis | `~/.config/Cockpit/voice-config.json` |
| Logs do daemon de voz | `~/.config/Cockpit/voice-logs/` |
| Cache do Electron | `~/.config/Cockpit/Cache/` |

> O `projects.json` é criado na primeira execução a partir de `projects.example.json`. O `voice-config.json` é semeado de `modules/voice/config.json` no asar. Edite pelo próprio app — só mexa direto se for trocar `tts_engine` ou colar a API key.

---

## Atalhos do terminal

| Atalho | Ação |
|---|---|
| `Ctrl+C` | Copia (com seleção) ou SIGINT (sem seleção) |
| `Ctrl+V` | Cola do clipboard |
| Botão direito | Menu Copiar/Colar/Selecionar tudo/Buscar/Limpar |
| Botão do meio | Cola rápido (convenção Linux) |
| `Ctrl+B` | Novo terminal |
| `Ctrl+P` | Busca arquivos por nome ou caminho |
| `Ctrl+W` | Fecha terminal atual |
| `Ctrl+F` | Busca no terminal |
| `Ctrl+L` | Limpa terminal |
| `Ctrl+Shift+1..9` | Seleciona aba 1..9 |
| Drag & drop nas abas | Reordena |

---

## Desinstalar

### `.deb`
```bash
sudo apt remove cockpit          # mantém a config do usuário
sudo apt purge cockpit           # remove tudo
rm -rf ~/.config/Cockpit         # opcional — apaga config/cache do usuário
```

### AppImage
```bash
rm ~/Cockpit.AppImage
rm -rf ~/.config/Cockpit         # opcional
```

---

## Troubleshooting

### "O Cockpit não abre depois do `dpkg -i`"
Outro processo do app pode estar segurando o binário. Mate o anterior antes:
```bash
pkill -f "/opt/Cockpit/cockpit"
sudo dpkg -i /tmp/cockpit.deb
```

### "Járvis aparece offline mesmo com API key configurada"
1. Verifique a key:
   ```bash
   curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $(jq -r .summarize.api_key ~/.config/Cockpit/voice-config.json)" | head -c 200
   ```
2. Veja o log:
   ```bash
   tail -f ~/.config/Cockpit/voice-logs/daemon.stdout.log
   ```

### "Quero usar voz local sem cloud"
Troque `tts_engine` para `xtts` no `voice-config.json` e siga a seção "Modo off-line". Precisa instalar venv Python com Coqui-TTS.

### "Letras com buracos no terminal"
Bug corrigido na 0.5.2 — atualize. A v0.6.x usa renderer DOM por padrão, com fallback nativo de fonte.

### "Erro de permissão do `chrome-sandbox`"
Em algumas distros o sandbox do Electron precisa de SUID:
```bash
sudo chown root:root /opt/Cockpit/chrome-sandbox
sudo chmod 4755 /opt/Cockpit/chrome-sandbox
```
O `.deb` já faz isso no `postinst`, mas se você copiou os arquivos manualmente, esse pode ser o motivo.

### "Falta libfuse" (AppImage)
```bash
# Ubuntu/Debian
sudo apt install libfuse2

# Fedora
sudo dnf install fuse-libs

# Arch
sudo pacman -S fuse2
```

---

## Versões anteriores

Disponíveis no mesmo bucket — basta trocar `v0.17.0` no path:

```
https://arquivos.devnx.com.br/cockpit/v<MAJOR.MINOR.PATCH>/cockpit_<versão>_amd64.deb
https://arquivos.devnx.com.br/cockpit/v<MAJOR.MINOR.PATCH>/Cockpit-<versão>.AppImage
```

Histórico completo: [CHANGELOG.md](./CHANGELOG.md)

---

## Como publicar uma nova versão (para mantenedores)

Tudo num único comando:

```bash
npm run release -- 0.17.0
```

Isso roda `scripts/release.sh`, que faz nesta ordem:

1. **Bump da versão** em `package.json`, `scripts/install.sh`, `README.md`, `installer.md`.
2. **`npm run dist:linux`** — gera `dist/cockpit-devnx_<versão>_amd64.deb` e `dist/Cockpit-<versão>.AppImage`.
3. **Sincroniza** `scripts/install.sh` em `dist/install.sh`.
4. **Sobe 4 artefatos** para `s3://arquivos.devnx.com.br/cockpit/v<versão>/`:
   - `cockpit-devnx_<versão>_amd64.deb`
   - `Cockpit-<versão>.AppImage`
   - `install.sh`
   - `CHANGELOG.md`

### Configuração de upload (Wasabi)

- **Bucket:** `arquivos.devnx.com.br` (sem o "c" no fim — o outro bucket `arquivosc.*` não tem CDN apontado).
- **Endpoint:** `https://s3.us-central-1.wasabisys.com` — precisa ser passado via `--endpoint-url` explícito; o aws-cli v2 **não** lê o `endpoint_url` aninhado de `~/.aws/config`.
- **Profile aws:** `wasabi` no `~/.aws/credentials`. A chave precisa de `s3:PutObject` no bucket. Sem ACL (`--acl public-read` resulta em AccessDenied; o bucket usa Bucket Policy para leitura pública).

### Overrides via env

```bash
COCKPIT_AWS_PROFILE=outro-profile  npm run release -- 0.17.0
COCKPIT_SKIP_UPLOAD=1              npm run release -- 0.17.0    # só local
COCKPIT_SKIP_BUILD=1               npm run release -- 0.17.0    # só upload
```

### Pós-release

Depois que o release subiu, valide:

```bash
curl -sI https://arquivos.devnx.com.br/cockpit/v0.17.0/install.sh   # HTTP/2 200
curl -fsSL https://arquivos.devnx.com.br/cockpit/v0.17.0/install.sh | sudo bash
```

Commitar a v0.17.0 (tag opcional):

```bash
git add -A && git commit -m "release: v0.17.0 — <resumo>"
git tag v0.17.0
git push --tags
```
