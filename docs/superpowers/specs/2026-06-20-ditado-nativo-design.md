# Ditado nativo no Cockpit (STT por voz)

**Data:** 2026-06-20
**Status:** ✅ implementado — transcrição via **Groq** (whisper-large-v3-turbo)

> ## ⚠️ Arquitetura final (substitui o design WebGPU abaixo)
>
> O design original (Whisper local via transformers.js + WebGPU) foi
> **abandonado** depois de validar na prática:
> - **WebGPU**: carrega o modelo mas **trava a inferência** (Electron 41 + Linux
>   + NVIDIA) — congela em qualquer modelo testado.
> - **CPU/WASM**: funciona, mas o `whisper-base/small` local errava muito; e a
>   captura via `ScriptProcessorNode` (thread principal, travada pelo modelo)
>   **picotava o áudio** — até o whisper de referência lia lixo do WAV.
>
> **Solução final (a que está no código):**
> 1. **Captura** no worker oculto via **AudioWorklet** (thread de áudio, não
>    picota) → PCM 16k mono pro main.
> 2. **Transcrição** no **Groq** (`whisper-large-v3-turbo`), API compatível com a
>    da OpenAI. ~0,5–1s, qualidade excelente. Sem modelo local.
> 3. **Injeção** imediata via `xdotool type` na janela focada (o overlay não
>    rouba foco, então não precisa de `windowactivate`).
>
> **Gatilho/UX:** Ctrl+Espaço (toggle global) → overlay "Ouvindo…" →
> "Transcrevendo…" → texto na janela. Sem preview ao vivo (seria de um motor
> diferente do Groq = sempre divergente).
>
> **Config** (`modules/voice/config.json` → bloco `dictation`):
> `enabled`, `hotkey` (ex. `Control+Space`), `provider: "groq"`,
> `model: "whisper-large-v3-turbo"`, `language: "pt"`, `api_key` (opcional).
>
> **Chave Groq** (`getGroqKey`, nesta ordem): `dictation.api_key` no config →
> env `GROQ_API_KEY` → arquivo `.groq-key` (gitignored) ao lado do config
> (userData em produção) ou na raiz do projeto (dev). **Para distribuir, cada
> usuário usa a própria chave** — não embutir a chave pessoal no pacote.
>
> **Arquivos:** `lib/dictation-native.js` (orquestra + Groq + xdotool),
> `public/dictation/{worker.html,worker.js,capture-worklet.js,overlay.*}`,
> `dictation-preload.cjs`, wiring em `electron-main.js`.
>
> Removido no release: dependência `@huggingface/transformers` + onnxruntime e o
> vendor `public/vendor/transformers/`.
>
> ---
> _O texto abaixo é o design original (histórico), mantido por contexto._

## Problema

O ditado por voz global do Cockpit (segurar tecla → falar → texto digitado na
janela ativa) dependia de um venv Python **externo e hardcoded**
(`/home/ftgk/Documents/omnivoice-test/.venv`), consumido por `lib/dictation.js`
e `lib/stt.js`. Quando essa pasta foi apagada, o ditado morreu. Recriar o venv
no mesmo lugar só repetiria a fragilidade: nada disso vai junto quando o Cockpit
é reinstalado ou empacotado no AppImage.

## Objetivo

Reimplementar o ditado **100% dentro do Node/Electron do Cockpit**, sem Python,
de forma que acompanhe o app no install e no AppImage. A transcrição deve
aparecer **ao vivo** (frases se formando enquanto o usuário fala, tipo legenda de
ligação) e o texto **final corrigido** é digitado na janela que estava focada.

### Requisitos travados (decididos com o usuário)

- **Motor:** `@huggingface/transformers` (transformers.js) rodando Whisper via
  **WebGPU** (aproveita a RTX 4050); cai pra WASM/CPU se WebGPU faltar.
- **Gatilho:** `Ctrl+Espaço` como **toggle** (1º toque inicia, 2º para) — global.
- **Ao vivo:** texto se forma num **overlay** do Cockpit (parciais via janela
  deslizante ~0,5s). O Whisper corrige parciais conforme ouve mais.
- **Injeção:** o texto **final** (já corrigido) é digitado de uma vez na janela
  focada quando o usuário para. Nada é digitado no destino durante a fala.
- **Config:** liga/desliga via configuração; quando off, o atalho nem registra.

### Fora de escopo (follow-up)

- `lib/stt.js` (ditado dentro do terminal do Cockpit via mic do navegador)
  também aponta pro venv morto. Será consertado num passo separado.
- Suporte ao ditado global no modo `node server.js` (navegador puro) — exige
  Electron (`globalShortcut`/`BrowserWindow`). Aceito: ditar em outras janelas
  do desktop só faz sentido no app desktop.

## Arquitetura

Tudo no **processo main** do Electron orquestra; a inferência roda num renderer
oculto (única forma de usar WebGPU + `getUserMedia` em JS).

### Componentes

1. **`lib/dictation-native.js`** (main, ESM) — orquestrador. Lê config, cria as
   janelas worker/overlay, registra o `globalShortcut`, guarda/injeta janela
   ativa, repassa parciais worker→overlay, controla o ciclo de vida.

2. **Worker oculto** (`BrowserWindow` sem foco, `show:false`) carregando
   `/dictation/worker.html` — captura o mic (`getUserMedia`), roda Whisper via
   transformers.js no WebGPU em **janelas deslizantes**, emite `partial` e
   `final` por IPC.

3. **Overlay ao vivo** (`BrowserWindow` transparente, `alwaysOnTop`,
   `focusable:false`, `skipTaskbar`) carregando `/dictation/overlay.html` —
   mostra o texto se formando (vermelho=gravando, amarelo=finalizando). Não
   rouba foco, então a janela de destino permanece ativa.

4. **Injeção via `xdotool`** — no start: `xdotool getactivewindow` guarda o
   alvo. No stop: `xdotool windowactivate --sync <id>` + `xdotool type
   --clearmodifiers` digita o texto final. Reaproveita o filtro de alucinações
   do antigo `dictation.py` (frases fantasma em silêncio).

5. **Config** — bloco `dictation` no voice-config:
   ```json
   "dictation": {
     "enabled": true,
     "hotkey": "Control+Space",
     "model": "Xenova/whisper-base",
     "language": "pt"
   }
   ```
   `whisper-base` = parciais rápidos pro efeito ao vivo (trocável por `small`,
   mais preciso). Defaults também no código, pra funcionar sem config.

### Fluxo de dados

```
Ctrl+Espaço (1º) → main: xdotool getactivewindow → mostra overlay
                 → worker: start mic + loop de inferência
worker → main → overlay : partial "..." (atualiza ao vivo)
Ctrl+Espaço (2º) → worker: para mic, finaliza, devolve texto final
                 → main: esconde overlay → xdotool type no alvo guardado
```

### Persistência do modelo (origem estável)

transformers.js cacheia o modelo na **Cache API**, que é por origem
(scheme+host+**porta**). O server hoje usa `port: 0` (aleatória) → cache perdido
a cada abertura. **Decisão:** fixar uma porta de loopback
(`127.0.0.1:47817`, com fallback pra aleatória se ocupada) + `requestSingleInstanceLock`.
Origem estável → modelo baixado **1x** e reusado. Sem rota nova: o server.js já
serve `public/` estático, então `public/dictation/*` e
`public/vendor/transformers/*` são servidos direto.

### Empacotamento

- Dependência `@huggingface/transformers` adicionada ao `package.json`.
- `scripts/copy-vendor-assets.js` estendido pra copiar o dist do transformers.js
  (+ binários ort-wasm) pra `public/vendor/transformers/`, mantendo offline.
- `worker.html` importa o transformers.js vendorizado como módulo ES e aponta
  `env.backends.onnx.wasm.wasmPaths` pro caminho vendorizado.

## Tratamento de erros

- **Sem WebGPU:** fallback automático pra WASM/CPU (parciais mais lentos) com
  log; a feature nunca "não liga".
- **Sem `DISPLAY`/`xdotool`:** erro claro no log; overlay mostra aviso.
- **Modelo baixando (1ª vez):** overlay mostra "baixando modelo de voz…".
- **`enabled:false`:** `globalShortcut` não é registrado.
- **Mic negado:** já há `setPermissionRequestHandler` liberando `media` no
  main; o worker herda. Em falha, log + overlay de erro.

## Testes

Áudio/UI E2E é inviável de automatizar aqui. Cobertura prática:

- **Unidário:** parser/merge de config (defaults + override), lógica do toggle
  (estados idle→recording→finalizing→idle), limpeza do texto final (filtro de
  alucinações, trim, espaços).
- **Smoke manual:** abrir o app, Ctrl+Espaço, falar, conferir overlay ao vivo e
  o texto digitado no gedit/terminal.
- **Carga do worker:** verificar no console do worker que o modelo carrega e que
  `partial`/`final` chegam.

## Riscos

- WebGPU no Electron/Linux pode exigir flags (`enable-unsafe-webgpu`,
  `enable-features=Vulkan`); mitigado pelo fallback WASM.
- `Ctrl+Espaço` pode colidir com troca de input method (IBus) em alguns setups;
  por isso a tecla é configurável.
