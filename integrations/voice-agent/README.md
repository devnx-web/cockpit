# Maestro — agente de voz (experimento)

Agente de voz que **opera o Cockpit**: vigia os terminais dos projetos, resume
o que está acontecendo e desbloqueia agentes travados quando você pede falando.

Ele não programa. Ele olha as telas por você.

Substitui o módulo Járvis (`modules/voice/`), que era ditado — gravava,
transcrevia e escrevia no PTY, sem contexto nenhum do que estava rodando. O
Járvis continua no lugar até este aqui provar que funciona.

## Como funciona

```
você (mic/alto-falante)
      │
      ▼
agent.py — livekit-agents em console mode (local, sem servidor LiveKit)
      │    llm = openai.realtime.RealtimeModel  ← fala e raciocínio num modelo só
      │
      ▼  MCPServerStdio
node ../cockpit-mcp/src/index.js --stdio
      │
      ▼  HTTP loopback + Bearer (token de control.json)
lib/control-api.js → PTYs dos projetos
```

**Nenhuma ferramenta é definida aqui.** As 8 tools vêm do `cockpit-mcp` que já
existia: `cockpit_status`, `cockpit_list_projects`, `cockpit_list_terminals`,
`cockpit_read_terminal`, `cockpit_wait_terminal`, `cockpit_create_terminal`,
`cockpit_send_input`, `cockpit_interrupt_terminal`.

Console mode roda inteiramente na sua máquina: **não precisa de servidor
LiveKit nem de conta LiveKit.** A única credencial é a `OPENAI_API_KEY`.

## Rodar

```bash
./run.sh                 # conversa por voz
./run.sh --list-devices  # lista mic/alto-falante
./run.sh --text          # sem áudio, digitando (Ctrl+T alterna)
```

Coisas para experimentar:

- *"quais projetos você enxerga?"*
- *"o que está rodando agora?"*
- *"o terminal do Gralha já terminou?"*
- *"manda `ls` no terminal X"* → ele descreve e espera seu "libera"

## Configuração

`.env.local` (modo 0600, fora do Git) — gerado a partir da chave que já estava
em `~/.config/Cockpit/voice-config.json`:

| Variável | Para quê |
|---|---|
| `OPENAI_API_KEY` | Realtime API (fala + raciocínio) |
| `COCKPIT_MCP_ACTIONS` | ações de escrita liberadas no MCP |

O que o agente pode alcançar é decidido pelo Cockpit, não por este projeto, em
`~/.config/Cockpit/mcp-policy.json` (`projects`, `capabilities`,
`terminalAccess`).

**A policy é lida uma vez, no boot do servidor.** Editar o arquivo com o
Cockpit aberto não muda nada até o app subir de novo — o que acontece
naturalmente na próxima vez que você abrir o Cockpit. Não é preciso
reinstalar: o `dpkg -i` de um upgrade preserva `~/.config/Cockpit/` (veja
`installer.md`), e config não viaja no pacote.

## Segurança

Saída de terminal é dado não confiável — regra do `AGENTS.md` na raiz. Um repo
qualquer pode imprimir texto desenhado para manipular o agente. Defesas em
camadas:

1. instruções explícitas de não-obediência ao output, em `agent.py`;
2. `SERVER_INSTRUCTIONS` do próprio `cockpit-mcp`;
3. `confirm=true` obrigatório em toda tool de escrita;
4. a policy do Cockpit limita projetos, terminais e capabilities.

Nenhuma delas é perfeita. Enquanto isto for experimento, vale saber que o
caminho output → contexto do modelo → `send_input` existe.

## Descartar

```bash
rm -rf integrations/voice-agent
cp ~/.config/Cockpit/mcp-policy.json.bak ~/.config/Cockpit/mcp-policy.json
```

Do core, só o `.gitignore`.

A correção em `electron-main.js` (`app.exit(0)` no lugar de `app.quit()` quando
o lock de instância única falha) **não** faz parte do experimento e deve ficar:
é um bug independente — a segunda instância seguia carregando e sobrescrevia o
`control.json` da que já estava rodando, deixando-a inalcançável pela Control
API. Como é código, só chega na máquina instalada por uma nova versão
publicada (`npm run release`), não por edição de config.
