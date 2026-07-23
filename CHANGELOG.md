# Changelog

Todas as mudanças relevantes do Cockpit. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

Datas em GMT-3 (Horário de Brasília).

## [Unreleased]

_(nada ainda)_

---

## [0.14.0] — 2026-07-23

### Adicionado (navegar entre terminais que aguardam)
- **Contador global de "aguardando" no topo** — um badge `⏳ N aguardando` aparece na barra
  de título sempre que houver terminais esperando resposta do agente. Some quando não há
  nenhum, atualiza ao vivo e é clicável (pula pro próximo pendente).
- **Atalho pra pular pro próximo que aguarda** — `Alt+↓` foca o próximo terminal `waiting`
  e `Alt+↑` o anterior, ciclando por todos os pendentes. Funciona tanto no modo foco quanto
  no mosaico (se o projeto estiver no grid, foca o card; senão abre em foco).
- **Command palette (Ctrl+K) agora lista terminais** — além de projetos e ações, a paleta
  enumera os terminais abertos. Sem busca, mostra no topo a seção **"Terminais aguardando"**
  (só os pendentes, pra Enter já cair no primeiro que espera). Com busca, filtra por nome do
  projeto, do terminal ou path, sempre com os `waiting` priorizados.

---

## [0.13.0] — 2026-07-22

### Adicionado / melhorado (mosaico)
- **Escolher um terminal específico já aberto pro card** — o picker de célula vazia
  ganhou a seção **"Terminais abertos"** no topo, listando todos os terminais ativos.
  Clicar num deles fixa o projeto naquela célula **com aquele terminal ativo** (não só o
  primeiro/ativo do projeto). A busca filtra também essa seção (nome do projeto, do
  terminal ou id).
- **Terminais aguardando aparecem primeiro no picker** — na seção "Terminais abertos", os
  que estão `waiting` (agente aguardando resposta) sobem pro topo com o badge **AGUARDANDO**.
- **Cor do projeto sempre visível no card** — a borda e o cabeçalho de cada card ganham um
  tom da cor do projeto o tempo todo (antes a cor só destacava no card focado), tornando
  cada projeto reconhecível de relance.
- **Aba ativa do card na cor do projeto** — a mini-aba ativa usa a cor do projeto (fundo
  tintado + borda), em vez do cinza genérico.
- **Realce de atenção no card** — o card inteiro pulsa numa cor de atenção quando algum
  terminal dele está aguardando resposta ou tem saída nova não lida; o pulso some ao abrir
  o terminal (e não pulsa enquanto o card está focado).
- **Fechar terminal pela mini-aba** — cada mini-aba do card ganhou um **×** (aparece no
  hover e fica visível na aba ativa). Fecha só aquele terminal, sem trocar de aba, com a
  mesma confirmação de segurança quando o terminal está rodando/aguardando.

### Adicionado (reorganizar o grid)
- **Arrastar cards pra reordenar** — cada card tem um **grip** (⠿) no cabeçalho; arraste-o
  pra outra célula pra **trocar** os cards de lugar (ou mover pra uma célula vazia). O corpo
  do terminal e as mini-abas seguem interativos — só o grip inicia o arraste.
- **Arrastar pra fora remove** — soltar um card arrastado fora do grid remove ele do
  mosaico (soltar na própria célula é no-op, não remove por engano).

---

## [0.12.5] — 2026-07-22

### Adicionado / melhorado (mosaico)
- **Picker de projeto do grid reaproveita o modal de "Visibilidade & grupos"** — ao
  clicar numa célula vazia do mosaico, abre a mesma lista rica (busca por nome/grupo/id/
  caminho, agrupamento e a lista completa de projetos), em vez do seletor pobre anterior.
- **Projetos ocultos aparecem no picker** (marcados com a tag **OCULTO**), então dá pra
  fixá-los num card mesmo estando escondidos na sidebar.
- **A ação no grid é "adicionar ao card", não ver/ocultar** — clicar numa linha fixa o
  projeto naquela célula (ícone ＋ no hover) e **não altera a visibilidade da sidebar**
  (o oculto continua oculto lá; ver/ocultar segue sendo função do modal de Visibilidade).
- **Atalho "＋ novo projeto"** direto no cabeçalho do picker.

---

## [0.12.4] — 2026-07-21

### Alterado
- Rebuild/republicação da 0.12.3 (mesmo conteúdo) sob novo número de versão.

---

## [0.12.3] — 2026-07-21

### Corrigido / melhorado (discrição de tela)
- **Header dos agentes ocultado por completo** dentro do Cockpit — o banner de início
  do Ailiv C (logo + título/versão + modelo + pasta) e a **caixa de header do Ailiv G
  (Codex)** somem, independente do texto (não precisa mais rebrandear o banner a cada
  update do CLI).
- **Rodapés ocultados** — barra de modo/permissão do Ailiv C ("bypass permissions on…")
  e a linha de status do Ailiv G ("g-5.6-s xhigh · ~").
- **Aviso de MCP ocultado** ("N MCP server needs authentication · run /mcp").
- **Modelo** aparece como `o-48m` (Opus 4.8 medium) / `o-48`; corrigido o caso em que
  "Opus 4.8" e o logo escapavam (o texto vinha após um código ANSI terminado em letra).
- Tudo na camada de saída do app (`public/terminal-branding.js`), **sem patch de
  binário** — sobrevive a atualizações do Claude/Codex. Barras de progresso, tabelas e
  o output normal do agente não são afetados. Documentado em
  `docs/AILIV-BRANDING-E-SESSOES.md`.

---

## [0.12.2] — 2026-07-21

### Adicionado
- **Discrição de tela nos terminais** — a saída do Claude passa a ser reescrita ao vivo dentro do Cockpit (Claude Code → Ailiv C, Claude API → Ailiv Core, Opus/Sonnet/Haiku e ids de modelo → alias, Anthropic → Ailiv) e o logo do banner é ocultado. É feito na camada de saída do app (sem patch de binário), então **sobrevive a atualizações do CLI**. Barras de progresso, tabelas e texto normal não são afetados.

---

## [0.12.1] — 2026-07-21

### Adicionado
- **Comandos rápidos no mosaico** — cada card do grid ganhou o botão ⚡ de comandos rápidos (os mesmos atalhos por projeto da barra de abas). Clicar num comando envia direto pro terminal daquele card.

---

## [0.12.0] — 2026-07-21

### Adicionado
- **Modo mosaico** — o espaço central vira um grid de vários projetos lado a lado, cada card mostrando o terminal ativo de um projeto (ideal pra acompanhar vários agentes em paralelo). Alterna com o modo foco tradicional pelo ícone de grade ou `Ctrl/⌘+Shift+M`.
  - **Layout customizável** — defina quantas linhas e quantas colunas por linha (colunas variáveis por linha), com presets rápidos (1×1, 1×2, 2×2, 3 col, 2×3, 3×3). O layout fica salvo.
  - **Escolher projetos por célula** — clique numa célula vazia e escolha o projeto num modal com busca.
  - No mosaico, a sidebar, o cabeçalho da pasta, a barra de abas e o rodapé somem; os controles globais (layout, configurações, sair) vão pro topo — o grid ocupa quase a tela toda.
- **Encerrar terminais ociosos** — um reaper libera memória fechando terminais sem uso há 2 horas. Nunca encerra terminais com processo rodando (dev server, agente…), aguardando você, ou visíveis; avisa antes com contagem e botão "Manter ativo". Ligado por padrão, com toggle nas Configurações (Terminais). Ajustável por env (`COCKPIT_IDLE_REAP_MS`).
- **Renomear aba no mosaico** — duplo-clique renomeia o terminal direto no card.
- **Persistência** — modo (foco/mosaico), layout do grid, projetos de cada célula e o terminal selecionado de cada projeto ficam salvos entre sessões.

### Corrigido
- **Espaço no rename de aba** — digitar um espaço ao renomear um terminal não encerra mais a edição; nomes com espaço agora funcionam (foco e mosaico).

### Removido
- **Painel de Consumo** na sidebar — o acompanhamento de consumo passou a ser responsabilidade do backend.

---

## [0.11.0] — 2026-07-20

### Adicionado
- **Busca rápida de arquivos** — o painel Arquivos agora localiza por nome ou caminho, aceita correspondência aproximada, abre o resultado pelo teclado e pode ser acessado com `Ctrl/⌘+P`.

---

## [0.10.4] — 2026-07-20

### Corrigido
- **Aba presa na tela de login do Ailiv G** — terminais criados durante uma indisponibilidade transitória agora recebem a sessão assim que o pool central se recupera, mesmo que o shell já esteja aberto.
- **Retentativa silenciosa de autenticação** — as telas locais `Not logged in` e de seleção de login também acionam a recuperação; uma seleção ausente é repetida uma vez em segundo plano.
- **Credencial removida entre abas** — o `auth.json` do Codex é rematerializado atomicamente antes de cada novo PTY, cobrindo limpeza concorrente por outra instância do Cockpit.

---

## [0.10.3] — 2026-07-13

### Alterado
- **Broker loopback real para Claude** — o processo Claude recebe somente uma capability local descartável; access tokens reais permanecem na memória do Cockpit e não entram mais no ambiente do PTY nem no arquivo de credenciais.
- **Proxy streaming da API Anthropic** — chamadas Claude passam pelo endpoint local protegido do Cockpit, preservando streaming e os cabeçalhos necessários da API.

### Corrigido
- **401 repetido em sessões abertas** — se a Anthropic revogar um access token, o Cockpit solicita a renovação ao DevNX Control e repete automaticamente a requisição uma vez com o novo token, sem reiniciar Claude, terminal ou aplicativo.
- **Rotação por arquivo insuficiente** — removida a dependência do reload de `.credentials.json`, pois o Claude podia manter o token anterior em memória mesmo depois da substituição atômica do arquivo.

---

## [0.10.2] — 2026-07-12

### Alterado
- **Seleção central atualizada a cada 15 minutos** — o Cockpit aberto por vários dias volta a consultar o DevNX Control periodicamente e mantém em memória as melhores sessões disponíveis de Claude e OpenAI.
- **Atualização antes de criar terminais** — PTYs novos ou reiniciados revalidam a seleção central quando o cache local está antigo, sem depender de reiniciar o aplicativo inteiro.
- **Credencial Claude rotativa** — o perfil isolado recebe apenas o access token selecionado pelo broker, em arquivo `0600`; o refresh token continua exclusivamente no DevNX Control.

### Corrigido
- **Sessão OAuth antiga em terminais novos** — uma instância do Cockpit deixada aberta não injeta mais em novos shells o access token carregado no boot anterior.
- **Sincronizações concorrentes deduplicadas** — criações simultâneas de terminais compartilham a mesma atualização do pool, evitando chamadas duplicadas ao backend.
- **401 sem reiniciar o terminal Claude** — ao detectar credenciais inválidas, o Cockpit sincroniza uso e seleção imediatamente; a sessão aberta lê a credencial substituída na tentativa seguinte.

---

## [0.10.0] — 2026-07-11

### Adicionado
- **Identidade Ailiv C e Ailiv G** — o Cockpit apresenta o agente Claude como Ailiv C e o agente GPT/Codex como Ailiv G nos comandos rápidos, presets, configurações e resumo de consumo, mantendo executáveis e providers originais internamente.
- **Patchers reversíveis dos dois CLIs** — scripts com backup por versão aplicam o branding Ailiv nos binários locais sem alterar o tamanho em bytes e permitem restaurar os executáveis originais.
- **Aliases dinâmicos do Ailiv G** — a saída visual do terminal abrevia modelos (`gpt-5.6-sol` → `g-5.6-s`), traduz `YOLO mode` para `modo automático` e remove referências visuais restantes ao produto, sem alterar o model ID enviado à API.
- **Runbook de manutenção** — documentação completa para reaplicar, restaurar, testar e diagnosticar branding, sessões centralizadas, tema e atualização dos CLIs.

### Alterado
- **Resumo de consumo mais compacto** — os cartões da sidebar agora identificam claramente as janelas `5H` e `7D`, usam barra fina e reset abreviado, ocupando menos espaço vertical.
- **Tema ANSI preservado nos perfis isolados** — o primeiro uso do Ailiv C adota `dark-ansi`; preferências escolhidas posteriormente continuam sendo respeitadas.

### Corrigido
- **Erro HTTP 400 no Ailiv C** — o patch desativa a estratégia incompatível de cache global da versão 2.1.207 que gerava erro em `cache_control.scope`, preservando o restante do cache.
- **Terminais isolados sem cores** — variáveis herdadas `NO_COLOR` e `COLOR` não tornam mais os terminais interativos monocromáticos, salvo quando o próprio projeto solicita isso explicitamente.

### Segurança
- **Identidade das contas removida da sidebar** — e-mail/label não é mais inserido no HTML, tooltip ou atributos ocultos do resumo de consumo.
- **Branding separado da autenticação** — transforms visuais nunca alteram comandos, provider IDs, model IDs reais, tokens ou os perfis isolados gerenciados pelo DevNX Control.

---

## [0.9.0] — 2026-07-11

### Adicionado
- **Pool central de contas OpenAI e Claude** — o Cockpit agora consulta o DevNX Control por HTTPS, escolhe automaticamente a conta disponível com menor pressão de uso e injeta a sessão apenas nos novos terminais.
- **Autenticação de dispositivo limitada** — o pareamento troca o login inicial por um token Sanctum com permissões específicas para leitura, seleção, renovação e sincronização das contas de IA.
- **Broker de renovação do Codex** — refresh tokens reais permanecem no Laravel; o Cockpit recebe uma capability efêmera e renova o acesso pelo endpoint loopback local.
- **Testes automatizados do pool central** — cobertura para conexão, seleção, isolamento dos perfis, renovação, sanitização de respostas, publicação controlada e roteamento HTTP.

### Alterado
- **Contas locais deixaram de ser fonte de autenticação** — terminais Claude e Codex usam perfis isolados em `~/.cockpit`; sessões locais só podem ser enviadas explicitamente ao painel central durante a migração.
- **Uso das contas vem exclusivamente do backend** — barra lateral e configurações mostram os metadados permitidos pelo DevNX Control, sem enumerar backups locais.

### Corrigido
- **Claude abria a tela de login mesmo com OAuth válido** — o perfil isolado agora registra apenas os metadados não sensíveis de onboarding, confiança do projeto aberto e confirmação do modo `--dangerously-skip-permissions`, entrando diretamente no REPL autenticado.

### Segurança
- **Credenciais não são expostas ao renderer** — respostas públicas usam allowlist, erros são redigidos e endpoints sensíveis exigem origem loopback válida.
- **Arquivos de autenticação endurecidos** — escrita atômica, permissões `0600`, diretórios `0700`, isolamento por conta no Codex e remoção de credenciais locais herdadas do ambiente.
- **Configuração de voz não é mais empacotada** — `modules/voice/config.json` permanece somente na máquina de desenvolvimento; builds usam um seed público sem chaves nem caminhos pessoais.
- **WebSocket atualizado para `ws 8.21.0`** — corrige as vulnerabilidades de exaustão de memória por fragmentos pequenos e divulgação de memória não inicializada; dependências de produção ficam com `npm audit` zerado.

---

## [0.8.5] — 2026-06-22

### Corrigido
- **Copiar e colar pararam de funcionar no terminal** — o handler de permissões do Electron (adicionado para liberar o microfone do ditado) só permitia `media`/`microphone`/`audioCapture` e negava todo o resto, inclusive `clipboard-read`. Como o copiar/colar do terminal usa `navigator.clipboard.read()`/`readText()`/`writeText()`, o paste passou a ser bloqueado — e o erro era engolido em silêncio (`catch {}`), por isso falhava sem aviso. Funcionava em outros apps porque o clipboard do SO estava OK; só a janela do Cockpit bloqueava. Agora `clipboard-read` e `clipboard-sanitized-write` estão liberados.
- **Ditado por voz não funcionava no app instalado** — o `dictation-preload.cjs` não estava na lista `build.files` do empacotamento, então não ia para dentro do asar. Sem ele, o worker oculto ficava sem a ponte IPC (`window.dictation`) e o Ctrl+Espaço gravava sem nunca transcrever. No 0.8.3 o ditado só funcionava rodando a partir do código (dev). Agora o preload é empacotado e o ditado funciona na instalação.

---

## [0.8.3] — 2026-06-20

### Adicionado
- **Ditado por voz global (Ctrl+Espaço)** — aperte o atalho em qualquer janela do desktop, fale, aperte de novo e o texto é transcrito e digitado no campo que estava focado. A transcrição usa o **Groq** (`whisper-large-v3-turbo`, rápido e preciso) e a captura do microfone roda num **AudioWorklet** (áudio limpo). É opt-in e configurável em `modules/voice/config.json` no bloco `dictation`: `enabled`, `hotkey` (ex. `Control+Space`), `model`, `language` e `api_key`. Requer uma chave do Groq (em `dictation.api_key`, no env `GROQ_API_KEY`, ou num arquivo `.groq-key`).

---

## [0.8.2] — 2026-06-17

### Corrigido
- **"Copiar como texto" do terminal agora cola desde o início** — a limpeza era conservadora demais (só `rtrim`) e mantinha toda a margem esquerda da TUI, fazendo o texto colar afastado do começo. Agora aplica _dedent_: remove a indentação comum a todas as linhas não-vazias, deixando o texto flush à esquerda como num bloco de notas, mas preservando a estrutura relativa da indentação (seguro pra código).

---

## [0.8.1] — 2026-06-11

### Adicionado
- **Modal de atalhos de teclado** — novo botão de ajuda (?) ao lado do título "COCKPIT" abre um painel com todos os atalhos, agrupados por contexto (Geral, Terminal, Editor, Voz e projetos, Seletor de pasta). Fecha com Esc, clique fora ou no botão.
- **Ctrl+Backspace no terminal** — apaga a palavra anterior (envia `ESC+DEL` = `backward-kill-word` do readline).

### Corrigido
- **Ctrl+Tab não trocava de aba de terminal** — o atalho só ciclava abas do editor (e só com 2+ arquivos abertos); fora disso vazava um TAB literal pro shell. Agora cicla as abas de terminal do projeto ativo (Ctrl+Shift+Tab volta), mantendo a prioridade das abas de editor quando há 2+ arquivos abertos.
- **Links do terminal abriam com clique simples** — agora só abrem com Ctrl/Cmd+click (estilo VS Code), evitando aberturas acidentais ao selecionar texto.

---

## [0.8.0] — 2026-06-09

### Adicionado
- **Gestão de contas Claude + Codex** — nova seção em Configurações → Contas para trocar, adicionar e remover contas das duas plataformas (Anthropic/Claude e ChatGPT/Codex), com a conta ativa destacada. A troca é global (vale pra todos os projetos).
- **Barra de uso na sidebar** — abaixo da lista de projetos, mostra o consumo da conta ativa do Claude (janela de 5h e semanal), com atualização automática a cada 20 min e botão ⟳ pra forçar agora.
- **Tabela de uso por conta** — cada conta mostra duas barras (5h e semanal) com a porcentagem usada, o plano (Max 20x/Max 5x no Claude; Pro 20x/Pro Lite 5x no Codex) e o horário de reset em Brasília (GMT-3), pra decidir qual conta usar.

### Técnico
- Uso obtido via HTTP direto e instantâneo por conta: Claude por `api/oauth/usage` e Codex por `backend-api/wham/usage` — sem `codex exec`, sem leitura de rollouts, sem dados cruzados entre contas. Cache de 20 min com refresh de token automático e distinção entre sessão expirada (401) e limite de consultas (429).

---

## [0.7.1] — 2026-06-06

### Corrigido
- **Modal de adicionar/editar projeto desalinhado** — a grade do formulário usava `grid-template-columns: 92px 1fr`, e o `1fr` (que é `minmax(auto,1fr)`) não encolhia abaixo do `min-content` dos itens longos (comandos, inputs), estourando as colunas e jogando labels e título pra fora do modal, à esquerda. Trocado por `minmax(0, 1fr)` + `min-width: 0` nos filhos da grade.
- **Drag de arquivo pra dentro do app pegava só o nome, não o caminho** — o Electron 32+ removeu `File.path`. Agora o caminho absoluto é resolvido via `webUtils.getPathForFile` (exposto no preload), com fallback pro comportamento antigo. Vale pro drop no terminal e na importação pelo gerenciador de arquivos.

### Mudado
- **Painel de arquivos sem caminho duplicado** — o header do painel "Arquivos" não repete mais o caminho da pasta, que já aparece no breadcrumb do topo ao lado do nome do projeto.
- **Painéis laterais redimensionáveis** — os painéis de Arquivos e Git agora têm alça de arraste (igual à sidebar de projetos), com largura persistida em `localStorage`.

---

## [0.7.0] — 2026-05-21

### Adicionado
- **Ditado integrado no terminal (STT)** — botão 🎙 no header do terminal e atalho `Ctrl+Espaço` (toggle). Captura mic via `MediaRecorder` no Electron, manda áudio webm/opus via WebSocket binary frame; novo daemon Python residente `modules/voice/stt-daemon.py` (faster-whisper `small` em CUDA com fallback CPU int8) transcreve e o servidor injeta o texto direto no PTY do terminal ativo — mesmo caminho do paste. **Sem `pynput`, sem `xdotool`, sem listener global de teclado.** Funciona em Wayland. `electron-main.js` libera permissão de microfone via `setPermissionRequestHandler`. Substitui o `dictation.py` global (que continua disponível como "ditado legado" pra digitar fora do cockpit).
- **Personalidade da voz via `instructions`** — campo novo no `gpt-4o-mini-tts` que controla **tom e personalidade da voz** (não o conteúdo). Default: tom calmo, elegante, britânico discreto. Configurável pela UI.
- **Settings view fullscreen estilo VSCode** — substitui o modal de 2 toggles. Sidebar de categorias (Geral · Áudio · Atalhos), tab bar dentro de Áudio (Áudio · Roteirizador · Pronúncia), search cross-categoria com badges de contagem por categoria e por aba. Schema declarativo + renderer genérico por tipo: `toggle`, `range`, `select`, `text`, `textarea`, `textarea-large`, `password`, `kv` (editor key/value), `test-tts`, `action`, `info`. Persistência transparente: settings locais → `localStorage`; settings de voz → WS `voice_patch_config` com merge nested.
- **Configurar OpenAI API key pela UI** (Geral → Integrações) — input tipo password, badge "configurada · `sk-pr…0xQT`" quando há chave, botões "Salvar" (mínimo 8 chars) e "Remover" (com confirm). Server **nunca devolve** a chave inteira pro front — só `api_key_set` + `api_key_hint` mascarado.
- **Cache LRU de áudio** — frases repetidas (saudações, confirmações típicas) retornam PCM instantâneo em vez de chamar a API. Key normalizada (lower+strip) + voz/modelo/speed/instructions. Tamanho configurável (0-500 entradas).

### Mudado
- **TTS em cascata streaming `gpt-4o-mini` → `gpt-4o-mini-tts`** — modo `summary` agora gera o roteiro frase a frase via `stream:true` no chat completions e dispara TTS em paralelo (producer/consumer com `queue.Queue`). Tempo até a primeira fala em respostas longas cai de ~9.4s pra ~2.7s; pausa entre frases vai a zero. Skip automático do mini pra textos curtos (<60 chars, threshold configurável) elimina overhead em confirmações tipo "feito senhor".
- **Pool de conexões HTTPS persistente** com keep-alive nas chamadas pra OpenAI (separado por slot: `chat` e `tts`). Primeira chamada paga TLS handshake; subsequentes reutilizam. TTS warm cai de ~4.7s pra ~1.3-1.8s.
- **Modelo TTS default**: `tts-1-hd` → `gpt-4o-mini-tts` (mais novo, mais barato, aceita `instructions`). Modo de fala default: `verbatim` → `summary`.
- **Painel "Ditado" virou "Ditado global (legado)"** no popover de voz — comportamento intacto, só sinaliza que a forma recomendada agora é o botão 🎙 do terminal.

### Custos & performance
- Custo total por resposta longa: ~$0.0001 (mini) + ~$0.0001 (TTS) ≈ **$0.20 por mil falas**. Cache hit → custo **zero**.
- Cenários medidos (output bruto longo, ~325 chars in):
  - **TTFB-mini**: 2.01s → **0.89s** (-55%)
  - **TTFB-play**: ~9.4s → **3.3s warm / 2.7s cache-friendly** (-65%)
  - **Pausa entre frases**: ~2.5s → **0s**
  - **Frase curta repetida** ("Pronto, senhor."): **1.7s total** (essencialmente o tempo do áudio em si).

---

## [0.6.15] — 2026-05-19

### Adicionado
- **Ocultar projeto direto no menu** — o menu do botão `⋮` do projeto na sidebar agora tem o item `Ocultar da sidebar` (ou `Mostrar na sidebar` se já estiver oculto), entre `Duplicar` e `Remover`. Antes a única forma de ocultar era passar pelo popover do olho 👁 no rodapé. Toast confirma a ação.
- **Busca e paginação no popover de visibilidade** — o popover do olho 👁 ganhou um campo de busca (filtra por nome, grupo, id ou caminho) e paginação automática quando há mais de 10 projetos (10 por página, com janela compacta `1 … 4 [5] 6 … 12`). Em projetos com 10+ a busca já vem focada ao abrir; `Esc` no campo limpa o filtro; `Esc` fora dele fecha o popover como antes.

---

## [0.6.14] — 2026-05-19

### Adicionado
- **Arrastar arquivo da árvore pra fora do Cockpit** — agora você pode pegar um arquivo na sidebar e arrastar pro Files/Nautilus (ou pra um campo de upload, anexo de e-mail etc). No Electron usa `webContents.startDrag` pra um drag SO-nativo de verdade; em browser puro, populamos `text/uri-list` como fallback (funciona pro drop interno no terminal). Pastas só funcionam pro drop interno (Electron exige arquivo).
- **Arrastar arquivo de fora pra dentro da árvore** — solte arquivos do Files/Nautilus em cima de uma pasta da árvore pra copiar pra lá; solte em cima de um arquivo pra cair na pasta-pai dele; solte na área vazia pra ir pra raiz do projeto. Pasta-alvo recebe um destaque colorido durante o drag. Múltiplos arquivos e pastas (recursivo) suportados. Se houver colisão de nome, pergunta sobrescrever ou pular. Novo endpoint WS `import_external` no servidor copia via `fs.cp`, com `safePath` no destino pra evitar escape do project root. Só funciona no Electron (browsers não expõem `file.path` por segurança).
- **"Abrir local do arquivo"** no menu de contexto da árvore (botão direito) — revela o arquivo no gerenciador de arquivos do SO via `shell.showItemInFolder`. Disponível só na versão desktop (Electron); no browser puro aparece toast "requer app desktop".

---

## [0.6.13] — 2026-05-18

### Adicionado
- **Bolinha azul de demanda terminada** — quando uma demanda termina (terminal entra em `waiting`) num projeto que não está aberto, a bolinha de status daquele projeto na barra lateral fica azul pulsante, complementando o toast (que some sozinho). O azul é persistente: fica lá até você abrir o projeto. Cabeçalho de grupo também fica azul se algum projeto filho tiver demanda não vista. Limpa ao selecionar o projeto.

### Corrigido
- **Ctrl+V colava 2x no terminal** — o handler de teclado custom enviava o texto colado e retornava `false`, mas `return false` no `attachCustomKeyEventHandler` não chama `preventDefault()` no evento nativo, então o navegador ainda disparava o `paste` nativo do xterm, colando de novo (`Ctrl+Shift+V` escapava por causa da guarda `!e.shiftKey`). Agora o paste é interceptado no evento `paste` em si, na fase de captura do container — antes de chegar ao textarea do xterm — colando uma única vez. Lógica de paste centralizada em `pasteIntoTerminal()`, reusada pelo botão do meio.

---

## [0.6.12] — 2026-05-11

### Adicionado
- **Visualizador de imagens e PDFs no editor** — clicar em `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.avif`/`.bmp`/`.ico`/`.svg` agora abre preview com fundo xadrez (mostra transparência); `.pdf` abre em iframe nativo do Chromium. Pra outros binários (`.zip`, `.exe` etc), em vez de tela preta, aparece um placeholder com botão **Abrir com app externo** (`xdg-open` no Linux, `open` no macOS, `explorer.exe` no Windows). Novo endpoint `GET /file/<projectId>/<relPath>` no servidor serve o conteúdo bruto com `safePath` (sem path traversal).
- **"Copiar como texto"** no menu de contexto do terminal (botão direito) — limpa o padding visual do xterm (rtrim por linha + tabs viram espaço + nbsp normalizado) antes de copiar. O `Copiar` original (Ctrl+C) continua intacto.
- **Aviso de path quebrado** dentro do terminal — quando o `path` do projeto não existe, o terminal nasce com `status: error` ("path do projeto não existe") e injeta linha amarela `[cockpit] Path do projeto não existe: … — Abrindo em … (fallback)` no buffer. Visível tanto em reload quanto em terminais criados ao vivo.

### Corrigido
- **Aba de arquivo voltando vazia ao alternar entre arquivos** — `applyVisibility` fazia `monacoEditor.setValue("// carregando…")` no model do arquivo anterior enquanto esperava o `read_file` do novo, com `suspendDirtyTracking` ligado. Resultado: o model do primeiro arquivo era sobrescrito sem atualizar `f.content`, e ao voltar pra aba o conteúdo aparecia como `"// carregando…"` ou vazio. Agora `applyVisibility` sempre chama `loadInMonaco(f)` (cria o model do arquivo certo) e `getOrCreateModel` ressincroniza o model em cache se ele estiver dessincronizado com `f.content`.
- **Buffer histórico do terminal em criação ao vivo** — `terminal_added` enviava `buffer: ""`, então qualquer output inicial (ex.: o aviso amarelo de path quebrado) só aparecia depois de reload da página. Agora envia `fresh.buffer.join("")` e o cliente faz replay imediato.

---

## [0.6.11] — 2026-05-07

### Corrigido
- **Scrollbar do terminal arrastável** — a barra estava sendo coberta pelo `.xterm-screen` (que ultrapassa o viewport em 8 px e por estar depois no DOM era pintado por cima). Não dava pra clicar/arrastar o thumb. Fix: z-index 6 no viewport, 1 no screen, override do `background-color: #000` do `xterm.css` pra não cobrir o texto, e customização da barra (12 px, thumb 18 % opacity, 32 % no hover, 48 % no active).
- **Scroll wheel do terminal** — meu próprio handler chamava `preventDefault()` mas `scrollLines()` não atualizava o display, fazendo o scroll ficar travado. Removido — agora o `xterm-viewport` rola nativamente. Ctrl+wheel continua ajustando font-size.

---

## [0.6.10] — 2026-05-07

### Corrigido
- **Scroll do mouse no terminal (segunda tentativa)** — `term.scrollLines()` pode não atualizar o display quando o renderer WebGL não recalcula o viewportY. Adicionado fallback: quando detectado que `buffer.active.viewportY` não mudou após `scrollLines`, rola o `.xterm-viewport.scrollTop` diretamente calculando `line-height × fontSize`.

---

## [0.6.9] — 2026-05-07

### Corrigido
- **Scroll do mouse no terminal (de verdade)** — o fix da v0.6.8 ficava no container, mas o canvas WebGL ainda processava o evento antes em capture phase. Agora o handler global em `document wheel { capture: true }` pega o evento primeiro e chama `term.scrollLines()` diretamente, garantindo que o scroll funciona independente do renderer.
- **Shift+Enter envia LF (de verdade)** — mesmo motivo: o handler do xterm `attachCustomKeyEventHandler` rodava depois de o evento já ter sido roteado. Agora o listener global em `document keydown { capture: true }` envia `\n` via WS antes do xterm processar como Enter normal.

---

## [0.6.8] — 2026-05-07

### Corrigido
- **Scroll do mouse no terminal** — a barra de rolagem existia mas era só visual: rolar o mousewheel não fazia nada quando o WebGL renderer estava ativo (o canvas capturava o wheel antes do xterm-viewport). Agora o wheel é interceptado e chama `xt.scrollLines()` explicitamente, rolando o histórico via API. Suporta delta em pixel e em line. Ctrl+wheel continua ajustando o font-size.

---

## [0.6.7] — 2026-05-07

### Adicionado
- **Sidebar colapsável** — botão na seção "Projetos" (ícone de painel com seta) recolhe a sidebar para foco total no projeto ativo. Botão de expandir aparece no header. O ícone do projeto ativo ganha aro com a cor do projeto pra ficar claro qual está em uso. Estado persiste no localStorage. Terminais re-fitam automaticamente.
- **Ctrl+Tab / Ctrl+Shift+Tab** — alterna entre abas do editor abertas (cíclico). Funciona com foco no terminal também.
- **Shift+Enter no terminal** — envia LF (`\n`) ao invés de submeter o comando. Útil em REPLs como Claude CLI / codex que interpretam `\n` como nova linha e `\r` como envio.

### Corrigido
- **Ordem dos botões de janela** — agora 🟡 amarelo · 🟢 verde · 🔴 vermelho da esquerda pra direita.

---

## [0.6.6] — 2026-05-06

### Corrigido
- **Sidebar invisível** — o `grid-row: 2` no handle de resize tirava o handle do auto-placement do grid; sidebar e main eram empurrados para colunas erradas e a aside ficava com 6 px de largura, escondendo projetos, busca e botões. Removido — flow natural coloca tudo nas colunas certas.

### Adicionado
- **Modal centralizado de visibilidade & grupos** — botão olho na sidebar agora abre um modal centralizado (520×680 max) com backdrop escuro e blur. Lista projetos agrupados por grupo, com header de seção, contador X/Y visíveis e N grupos, e botão "ocultar/mostrar grupo" inteiro em massa. Fecha com Esc, click no backdrop ou no X.

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
