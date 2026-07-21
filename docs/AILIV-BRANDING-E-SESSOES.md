# Runbook — Ailiv C, Ailiv G e sessões centralizadas

> Estado verificado em 21/07/2026. Este documento é o ponto de partida para reaplicar ou ajustar as personalizações depois de atualizações do Claude CLI, Codex CLI ou Cockpit.
>
> **Atualização 21/07/2026 (v0.12.x):** a discrição de tela do **Ailiv C (Claude)** agora é feita **em runtime** na saída dos terminais (igual ao Ailiv G), em `public/terminal-branding.js`. Isso **sobrevive a updates do CLI** (não depende mais do patch de binário pra esconder Claude/Opus/logo). Veja a seção **“Ailiv C — discrição de tela em runtime”**.

## Objetivo

O Cockpit apresenta os dois agentes com identidade interna Ailiv, sem alterar os executáveis, provedores ou nomes de modelo usados nas APIs:

| Nome visível | Provedor interno | Executável real | Perfil isolado |
|---|---|---|---|
| **Ailiv C** | `claude` | `claude` | `CLAUDE_CONFIG_DIR` dentro de `~/.cockpit` |
| **Ailiv G** | `openai` / `codex` | `codex` | `CODEX_HOME` por conta dentro de `~/.cockpit` |

Regra principal: **branding é visual; autenticação e protocolos continuam com os nomes originais**. Não renomear comandos, variáveis de ambiente, providers ou model IDs enviados às APIs.

## Visão geral da implementação

Há três camadas independentes:

1. **Cockpit:** usa `Ailiv C` e `Ailiv G` nos atalhos, configurações e resumo de consumo.
2. **Binários locais:** patches de tamanho fixo trocam as assinaturas principais dos dois CLIs, com backup e restauração.
3. **Saída do Ailiv G:** um filtro exclusivamente visual abrevia model IDs dinâmicos e substitui textos que não podem ser alterados com segurança dentro do binário.

As sessões são escolhidas pelo DevNX Control e injetadas somente em perfis isolados do Cockpit. Os CLIs não devem cair silenciosamente nas contas locais de `~/.claude` ou `~/.codex`.

## Ailiv C — patch do Claude CLI

### Arquivos

- `lib/ailiv-cli-branding.js`: assinaturas e função de replace.
- `scripts/patch-ailiv-cli.mjs`: aplicação, backup e restauração.
- `test/ailiv-cli-branding.test.js`: garante que todos os replaces preservem o tamanho em bytes.

### Replaces atuais

| Original | Visível depois do patch | Observação |
|---|---|---|
| `Claude Code` | `Ailiv Agent` | Cabeçalho e versão do agente. |
| `Claude API` | `Ailiv Core` | Identidade do backend na interface. |
| `Claude Pro` | `Ailiv Pro` | Espaço final preserva o tamanho. |
| `Claude Max` | `Ailiv Max` | Espaço final preserva o tamanho. |
| `Claude Team` | `Ailiv Team` | Espaço final preserva o tamanho. |
| `Claude Enterprise` | `Ailiv Enterprise` | Mesmo tamanho. |
| `Opus 4.8` | `O4.8` | Usa caracteres Unicode invisíveis para completar os bytes. |
| `Sonnet 5` | `S5` | Usa caracteres Unicode invisíveis para completar os bytes. |

O patch também contém duas alterações específicas da versão que estava instalada:

- troca o desenho ASCII original por uma marca geométrica mais neutra;
- desativa somente a estratégia problemática de cache global que causava o erro HTTP 400 em `cache_control.scope`, mantendo o restante do cache ativo.

Essas duas assinaturas são mais frágeis que os textos. Depois de atualizar o Claude CLI, revisar o diff do binário/JS e validar se o workaround de cache ainda é necessário antes de acrescentar novas assinaturas.

### Aplicar e restaurar

```bash
cd /home/ftgk/cockpit
node scripts/patch-ailiv-cli.mjs
```

O script resolve o executável com `which claude`, trabalha no caminho real e cria uma cópia ao lado dele com sufixo:

```text
.before-ailiv
```

Restauração:

```bash
node scripts/patch-ailiv-cli.mjs --restore
```

Na versão de referência, o resultado esperado era:

```text
2.1.207 (Ailiv Agent)
```

## Ailiv G — patch do Codex CLI

### Arquivos

- `lib/ailiv-g-cli-branding.js`: assinaturas binárias de tamanho fixo.
- `scripts/patch-ailiv-g-cli.mjs`: aplicação, backup e restauração.
- `test/ailiv-g-cli-branding.test.js`: valida comprimento e replaces.
- `public/terminal-branding.js`: aliases dinâmicos apenas na saída do xterm.
- `test/terminal-branding.test.js`: cobre nomes atuais e futuros de modelos.

### Replaces dentro do binário

| Original | Visível depois do patch |
|---|---|
| `OpenAI Codex` | `Ailiv G` |
| `Codex CLI` | `Ailiv G` |

Os replacements incluem caracteres Unicode invisíveis. Eles são intencionais: completam exatamente os bytes do texto original sem mostrar espaços ou mudar offsets internos. **Não reescrever essas strings manualmente como texto ASCII comum.**

### Aplicar e restaurar

```bash
cd /home/ftgk/cockpit
node scripts/patch-ailiv-g-cli.mjs
```

O backup é criado ao lado do executável real com o sufixo:

```text
.before-ailiv-g
```

Restauração:

```bash
node scripts/patch-ailiv-g-cli.mjs --restore
```

Na versão de referência, o binário standalone era `0.144.1`. `codex --help` começa com `Ailiv G`; `codex --version` ainda pode imprimir o identificador técnico `codex-cli`, pois ele não foi alterado para evitar atingir nomes usados internamente.

## Aliases dinâmicos do terminal Ailiv G

Model IDs vêm do catálogo do servidor e também são usados nas requisições. Alterá-los dentro do binário poderia impedir a seleção do modelo. Por isso `public/terminal-branding.js` transforma somente a saída recebida pelo xterm.

### Regras visuais

| Saída real | Saída visível |
|---|---|
| `OpenAI Codex` | `Ailiv G` |
| `Codex` | `Ailiv G` |
| `OpenAI` | `Ailiv` |
| `YOLO mode` | `modo automático` |
| `gpt-5.6-sol` | `g-5.6-s` |
| `gpt-6.1-terra` | `g-6.1-t` |
| `gpt-5.1-codex-max` | `g-5.1-c-m` |

Algoritmo dos modelos:

1. `gpt` vira `g`;
2. a versão numérica é mantida;
3. cada parte textual após a versão vira sua primeira letra.

O filtro completa com espaços à direita quando o alias fica menor, preservando o alinhamento desenhado pelo TUI. O valor real que sai pelo PTY e chega à API continua, por exemplo, `gpt-5.6-sol`.

### Como um terminal é identificado

O Cockpit marca o terminal como Ailiv G quando:

- o usuário executa um comando iniciado por `codex`; ou
- um buffer restaurado contém uma assinatura como `Ailiv G`, `OpenAI Codex`, `Codex can now` ou `YOLO mode`.

Depois de marcado, o filtro vale até o terminal ser destruído. Ele não deve ser aplicado globalmente a terminais comuns, para não alterar logs e arquivos que apenas mencionem GPT/Codex.

## Ailiv C — discrição de tela em runtime

> Adicionado na v0.12.x. É a forma **preferida** de esconder a identidade do Claude
> na tela do Cockpit, porque **não altera o binário e sobrevive a atualizações** do
> CLI. Objetivo: quem olhar a tela enquanto você desenvolve não associa a Claude/Opus/
> Anthropic. **Não engana usuário final** — é só discrição visual local; provider,
> comandos e model IDs enviados à API continuam os originais.

### Arquivo e integração

- `public/terminal-branding.js` → `CockpitTerminalBranding.transformOutput(key, data)`.
- Ligado em `public/index.html`:
  - entrada: `observeInput(k(projId,tid), data)` (marca o terminal ao digitar `claude`);
  - saída: `const branded = transformOutput(k(projId,tid), data) ?? data` antes de
    escrever no xterm (vale pra saída ao vivo **e** pro replay do buffer ao reconectar).
- Mesma estrutura do filtro do Ailiv G — Claude e Codex convivem no mesmo `transformOutput`.

### Como um terminal vira “Ailiv C”

Marcado (sticky até o terminal ser destruído) quando:

- o usuário roda um comando começando com `claude` (detecção por input); **ou**
- a saída casa `identifiesAilivC`: `Claude Code | Claude API | Anthropic | claude-(opus|sonnet|haiku)`.

As trocas de **identificadores fortes** rodam **sempre** (sem depender da marcação),
porque o Ink desenha o banner em frames e partes chegam antes de o terminal ser
marcado. Só a palavra genérica `Claude` e os rodapés dependem da marcação (pra não
mexer em terminal comum).

### Substituições (na saída, sem trava de tamanho)

| Saída real | Vira |
|---|---|
| `Claude Code` | `Ailiv C` |
| `Claude API` | `Ailiv Core` |
| `Claude Pro/Max/Team/Enterprise` | `Ailiv Pro/Max/Team/Enterprise` |
| `Anthropic` | `Ailiv` |
| `claude-opus-4-8-…` (model id) | `o-48` (família→inicial + versão; preenche com espaço) |
| `Opus 4.8 with medium effort` | `o-48m` (inicial + versão sem ponto + inicial do effort) |
| `Sonnet 4.5` / `Haiku 3.5` | `s-45` / `h-35` |
| `Claude` (isolado) | `Ailiv C` (só em terminal já marcado) |

**Detalhe crítico:** os textos do CLI vêm logo após um código ANSI que termina em
letra (ex.: `\x1b[37m` → `m`). Por isso **não usar `\b` no início** das regexes (ex.:
`\bOpus` nunca casaria depois do `m`). Casos com `\b` no fim continuam ok.

### Logo e header do banner (ocultar em vez de rebrandear)

O logo é arte ANSI de blocos desenhada **na mesma linha do título** (o cursor vai pra
coluna 12 e escreve o texto). Ou seja: as 3 linhas do topo (título+versão, modelo, pasta)
**são as mesmas linhas do logo** e todas têm glifos de **quadrante** (`▖▗▘▙▚▛▜▝▞▟` =
U+2596–U+259F), que barras de progresso, sparklines (`▁▂▃…█`) e tabelas **não** usam.

`hideLogo(data, full)`:

- `full = false` (terminal comum): só troca os glifos de bloco (`▀–▟`) por espaço —
  neutraliza um logo solto sem mexer no resto.
- `full = true` (terminal de agente **Ailiv C/G**, ligado em `transformOutput` via
  `ailivCTerminals.has(key) || ailivGTerminals.has(key)`): apaga a **linha inteira** que
  tiver quadrante. Como o header do CLI mora nessas linhas, isso **oculta o header todo
  (logo + título + modelo + pasta) sem depender do texto** — não precisa manter o
  rebrand do banner; se o CLI mudar as palavras, continua oculto.

- **Limitação conhecida:** sobra uma **sombra fraca** no canto (as células do logo têm
  cor de **fundo**; apago o conteúdo visível, mas o código de fundo permanece). O robô
  rosa e o texto do header somem; a sombra é sutil. Eliminar exigiria limpar também os
  códigos de fundo (mais risco de afetar outras cores).
- **Nota:** o aviso "⚠ N MCP server needs authentication · run /mcp" fica numa linha
  **sem** quadrante, então não é ocultado por aqui (e não cita Claude). Se quiser
  escondê-lo, dá pra adicionar a assinatura em `hideFooters`/uma regra própria.

### Chrome dos agentes: rodapés, header do Codex e aviso de MCP (`hideChrome`)

`hideChrome(data, isC, isG)` processa **linha a linha**; se o conteúdo **sem ANSI** casa
uma assinatura, `blankVisible` apaga só os caracteres **visíveis**, preservando os
códigos ANSI (não desalinha as colunas — os CLIs posicionam por coluna absoluta e
espalham códigos **entre** os tokens, então casar texto literal falharia).

Assinaturas (todas gated ao terminal do agente correspondente):

- **Rodapé Ailiv C:** `bypass permissions | accept edits | plan mode | manual mode` ou
  `shift+tab to cycle` ou `? for shortcuts`.
- **Rodapé Ailiv G:** linha com `g-<versão>` **e** `(xhigh|high|medium|low|minimal) · <cwd>`
  (ex.: `g-5.6-s   xhigh · ~`).
- **Header do Codex (caixa):** o banner do Codex é uma **caixa** desenhada com bordas
  `│ ─ ╭╮╰╯` (não usa quadrante, por isso não cai no `hideLogo`). Oculta: linhas com
  `Ailiv G (v…)` ou label do box precedida de borda (`│ model:`, `│ directory:`,
  `│ permissions:`, `reasoning:`, `approvals:`, `sandbox:`), as **bordas puras** do box
  e os **lados vazios** (`│      │`).
- **Aviso de MCP** (Claude e Codex): linha com `MCP server… authentication` ou `run /mcp`.

> Limitação: as labels do box só são casadas **precedidas de `│`** (pra não apagar um
> `model:` solto na saída do agente). Bordas puras de box (`─────`) num terminal de
> agente também são apagadas — se o agente desenhar outra caixa, a borda dela some
> (o conteúdo com texto permanece). É raro e cosmético.

### Vantagem e limitações

- **Sobrevive a updates**: como é `replace` de string no cliente, atualizar o Claude/
  Codex **não reverte** nada (diferente do patch de binário).
- **Só dentro do Cockpit**: o `claude` avulso no seu terminal continua normal.
- **Fronteira de chunk**: se um identificador vier partido entre dois chunks, aquele
  pedaço pode escapar (raro). Os identificadores fortes rodando “sempre” minimizam isso.

### Como ajustar depois que o Claude/Codex mudar a UI

Se algum texto/rodapé/logo voltar a aparecer após um update, **capture os bytes reais**
e ajuste as regexes (não precisa mexer em binário):

```bash
# banner/rodapé do Claude (roda ~6s e mata):
timeout 6 script -qefc "claude" /tmp/claude-banner.raw </dev/null >/dev/null 2>&1
cat -v /tmp/claude-banner.raw | head -30      # vê os escapes/glifos exatos
```

Ou, com um terminal já aberto no app, leia o rodapé direto do xterm pelo console do
navegador:

```js
let inst; xtermInstances.forEach((v,k)=>{ if(k.startsWith("voice:")) inst=v; });
const b=inst.term.buffer.active;
[...Array(12)].map((_,i)=>b.getLine(b.length-12+i)?.translateToString(true)).filter(Boolean);
```

Depois teste o `transformOutput` contra o arquivo capturado antes de publicar (há
exemplos no histórico: carregar o IIFE com `eval(fs.readFileSync(...))` e comparar
antes/depois).

## Identidade visível dentro do Cockpit

Os nomes internos continuam sendo usados em classes CSS, IDs, providers e comandos. Somente os rótulos apresentados ao usuário mudam:

- comandos rápidos padrão: `ailiv c` e `ailiv g`;
- presets de comandos: `ailiv c` e `ailiv g`;
- ação da paleta: `Iniciar Ailiv C aqui`;
- painel de sessões: `Ailiv C` e `Ailiv G`;
- resumo da sidebar: `Ailiv C` e `Ailiv G`;
- projetos já salvos em `projects.json`: labels atualizadas, comandos preservados.

Comandos reais:

```text
claude --dangerously-skip-permissions
codex --dangerously-bypass-approvals-and-sandbox
```

## Resumo de consumo e privacidade

O rodapé da sidebar foi reduzido para cartões compactos:

- título `Consumo`;
- nome Ailiv e plano;
- métricas identificadas como `5H` e `7D`;
- barra fina da janela de cinco horas;
- próximo reset abreviado.

O e-mail/label da conta não é inserido no HTML desse resumo, nem em `title` ou atributo oculto. A resposta interna ainda pode conter o label necessário para administração, mas `accBlock()` não o renderiza.

## Sessões centralizadas pelo DevNX Control

### Fluxo

1. O Cockpit conecta ao DevNX Control por HTTPS.
2. Login e senha são usados somente para obter um token de dispositivo.
3. O token mínimo é salvo em `~/.cockpit/team-auth.json`, com permissão `0600`.
4. No bootstrap, o Laravel escolhe a melhor conta disponível para `claude` e `openai`.
5. A sessão selecionada é mantida pelo broker do Cockpit e aplicada somente a novos terminais.
6. Consumo, validade, prioridade, renovação e disponibilidade continuam sendo responsabilidade do Laravel.

URL de produção usada nesta implantação:

```text
https://bcontrol.devnx.com.br
```

Nunca documentar usuário, senha, token de dispositivo, refresh token ou conteúdo de `auth.json`.

### Isolamento local

- O ambiente do host é limpo de `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` e overrides de refresh antes da seleção central.
- Mesmo desconectado, `CLAUDE_CONFIG_DIR` e `CODEX_HOME` apontam para áreas controladas pelo Cockpit. Isso faz o terminal falhar fechado em vez de herdar a conta local.
- Ailiv C recebe o OAuth central por `CLAUDE_CODE_OAUTH_TOKEN`.
- Ailiv G recebe um `CODEX_HOME` separado por conta. O diretório usa um hash do ID público da conta e preserva histórico por conta sem misturar autenticação.
- O refresh token verdadeiro do Ailiv G fica no Laravel. O `auth.json` isolado recebe uma capability efêmera, resolvida apenas pelo endpoint loopback do Cockpit.
- Ao desconectar ou encerrar, material sensível temporário é removido; preferências e histórico isolado podem ser preservados.

### Rotas locais do Cockpit

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/team/status` | Estado sanitizado da conexão. |
| `POST` | `/team/connect` | Login, emissão do token de dispositivo e bootstrap. |
| `POST` | `/team/disconnect` | Revogação best-effort e limpeza local. |
| `POST` | `/team/optimize` | Seleciona novamente as contas de menor pressão. |
| `POST` | `/team/openai/oauth/token` | Broker loopback sensível para refresh do Ailiv G. |
| `GET` | `/accounts/usage` | Tabela sanitizada usada pelo resumo de consumo. |

### Rotas esperadas no Laravel

A lista canônica está em `TEAM_API_PATHS`, dentro de `lib/team-accounts.js`:

```text
POST   /api/login
POST   /api/cockpit-ai/device-tokens
DELETE /api/cockpit-ai/device-token
GET    /api/cockpit-ai/accounts
POST   /api/cockpit-ai/select
POST   /api/cockpit-ai/accounts/upsert
POST   /api/cockpit-ai/accounts/{id}/refresh
POST   /api/cockpit-ai/accounts/{id}/sync-usage
POST   /api/cockpit-ai/sync-usage
```

O cron via `wget` e a regra de escolha/validade pertencem ao repositório Laravel `devnx-control`; este repositório apenas consome essas rotas. Conferir o `routes/api.php` publicado antes de alterar o contrato.

## Tema e onboarding do Ailiv C

O perfil Claude isolado é preparado para entrar diretamente no REPL central:

- `hasCompletedOnboarding: true`;
- confiança registrada somente para o projeto real aberto;
- confirmação de `--dangerously-skip-permissions` no perfil isolado;
- tema inicial `dark-ansi`, que preserva as cores ANSI/Dracula do Cockpit;
- escolhas posteriores feitas pelo usuário não são sobrescritas.

Se o terminal voltar a ficar cinza depois de uma atualização, verificar primeiro o `settings.json` do `CLAUDE_CONFIG_DIR` isolado e a remoção indevida das variáveis `NO_COLOR`/`COLOR`.

## Procedimento depois de atualizar um CLI

1. Fechar terminais do agente atualizado.
2. Confirmar os novos caminhos e versões:

   ```bash
   command -v claude
   readlink -f "$(command -v claude)"
   claude --version

   command -v codex
   readlink -f "$(command -v codex)"
   codex --version
   ```

3. Executar os testes do repositório antes do patch:

   ```bash
   cd /home/ftgk/cockpit
   npm test
   ```

4. Reaplicar os dois patches necessários:

   ```bash
   node scripts/patch-ailiv-cli.mjs
   node scripts/patch-ailiv-g-cli.mjs
   ```

5. Se aparecer `Nenhuma assinatura visual conhecida foi encontrada`, **não forçar replace no binário**. Restaurar, mapear as novas strings e atualizar o array de replacements com testes de tamanho.
6. Rodar `npm test` novamente.
7. Reiniciar a versão dev:

   ```bash
   npm start
   ```

8. Abrir um terminal novo de cada agente e conferir o checklist abaixo.

## Checklist visual e funcional

### Ailiv C (discrição de tela em runtime — v0.12.x)

- [ ] **Header do banner oculto** (logo + título/versão + modelo + pasta somem).
- [ ] Logo (robozinho rosa) não aparece (pode sobrar sombra fraca).
- [ ] Rodapé de modo/permissão (`bypass permissions on…`) some.
- [ ] Menções soltas: `Claude`→`Ailiv C`, `Opus 4.8`→`o-48m`, `Anthropic`→`Ailiv`
      (rede de segurança pro texto fora do banner).
- [ ] Terminal comum (sem claude) fica **intacto**.
- [ ] Tema ANSI colorido, sem tela cinza.
- [ ] Não abre wizard de login quando a sessão central é válida.
- [ ] Uma mensagem simples responde sem erro HTTP 400 de cache global.

### Ailiv G

- [ ] Cabeçalho mostra `Ailiv G`.
- [ ] Dicas não mostram `Codex`/`OpenAI Codex`.
- [ ] `gpt-5.6-sol` aparece como `g-5.6-s`.
- [ ] `YOLO mode` aparece como `modo automático`.
- [ ] `/model` continua funcionando e a API recebe o model ID real.
- [ ] A conta usada é a selecionada pelo DevNX Control.

### Cockpit

- [ ] Atalhos mostram `ailiv c` e `ailiv g`.
- [ ] Sidebar mostra `Ailiv C` e `Ailiv G` sem e-mails.
- [ ] Consumo `5H`/`7D` e reset aparecem corretamente.
- [ ] `npm test` passa por completo.

## Diagnóstico rápido

### Patch diz que já foi aplicado

É idempotência normal. O script encontrou as strings Ailiv e não precisa escrever novamente.

### Atualização criou outro caminho de release

Os scripts usam `which` + `realpath`, então devem atingir a versão ativa. O backup antigo fica no release anterior e um novo backup será criado no novo caminho.

### Ailiv G ainda mostra model ID completo

Verificar:

1. se `/terminal-branding.js` foi carregado;
2. se `public/index.html` chama `observeTerminalInput()` antes de enviar o comando;
3. se todas as escritas no xterm passam por `writeTerminalOutput()`;
4. se o terminal foi aberto depois do restart do Cockpit.

### Ailiv C volta a pedir login

Verificar se o DevNX Control selecionou uma conta Claude disponível, se `CLAUDE_CODE_OAUTH_TOKEN` está chegando apenas no PTY isolado e se `.claude.json` do perfil brokerado concluiu o onboarding.

### Ailiv G volta a pedir login

Verificar a seleção OpenAI, o `auth.json` materializado no `CODEX_HOME` da conta e o endpoint loopback `CODEX_REFRESH_TOKEN_URL_OVERRIDE`. Não copiar `~/.codex/auth.json` manualmente para o perfil brokerado.

## Segurança e publicação

- Nunca commitar backups `.before-ailiv*`; eles são binários externos e podem conter conteúdo proprietário.
- Nunca commitar `~/.cockpit/team-auth.json`, `auth.json`, tokens ou credenciais locais.
- Os scripts do repositório guardam somente padrões de branding; não devem conter sessões.
- O renderer recebe apenas metadados allowlisted. Rotas sensíveis rejeitam origem web e aceitam refresh apenas por loopback.
- Antes de push/release, rodar `git diff --check`, `npm test` e procurar padrões de segredo nos arquivos novos.

## Mapa dos arquivos alterados

| Arquivo | Responsabilidade |
|---|---|
| `public/index.html` | Labels Ailiv, consumo compacto, integração do filtro e escrita no xterm. |
| `public/terminal-branding.js` | Filtro de runtime: rebrand da saída do **Ailiv G e Ailiv C** (texto, model ID, logo, rodapés). Preferido pra discrição de tela. |
| `projects.json` | Labels dos comandos existentes. |
| `lib/ailiv-cli-branding.js` | Replace binário do Ailiv C. |
| `lib/ailiv-g-cli-branding.js` | Replace binário do Ailiv G. |
| `scripts/patch-ailiv-cli.mjs` | Aplicar/restaurar Ailiv C. |
| `scripts/patch-ailiv-g-cli.mjs` | Aplicar/restaurar Ailiv G. |
| `lib/team-accounts.js` | Cliente do Laravel, isolamento e materialização das sessões. |
| `lib/team-router.js` | Rotas locais, sanitização, seleção e tabela de uso. |
| `lib/terminal-env.js` | Ambiente colorido para terminais interativos. |
| `test/ailiv-cli-branding.test.js` | Segurança do patch Ailiv C. |
| `test/ailiv-g-cli-branding.test.js` | Segurança do patch Ailiv G. |
| `test/terminal-branding.test.js` | Regras dinâmicas de aliases. |
| `test/branding.test.js` | Identidade do Cockpit e privacidade do resumo. |
| `test/team-accounts.test.js` | Broker, isolamento, refresh e publicação controlada. |
| `test/team-router.test.js` | Rotas sanitizadas e bootstrap. |

## Regra para futuras alterações

Antes de adicionar um novo replace, decidir em qual camada ele pertence:

- **Discrição visual na tela do Cockpit (Claude ou Codex):** filtro de runtime em
  `public/terminal-branding.js` (`transformOutput`). **É a via preferida** — sobrevive
  a updates e não toca o binário. Cobre texto, model ID, logo e rodapés.
- **Texto estático do cabeçalho do CLI fora do Cockpit / workaround que só existe no
  binário (ex.: cache HTTP 400):** patch binário, somente se o tamanho em bytes for
  preservado. Lembrar que **reverte a cada update** do CLI.
- **Rótulo do Cockpit:** `public/index.html`/`projects.json`, mantendo provider e comando internos.
- **Autenticação, consumo ou seleção:** Laravel + `team-accounts.js`; nunca resolver isso com replace visual.

> Nota: desde a v0.12.x, esconder “Claude/Opus/Anthropic/logo/rodapé” **na tela** não
> precisa mais do patch de binário — faça no `terminal-branding.js`. O patch de binário
> do Claude fica reservado ao que o runtime não alcança (ex.: o workaround de cache).

Essa separação é o que permite atualizar a aparência sem quebrar login, renovação, histórico, escolha de conta ou compatibilidade com os provedores.
