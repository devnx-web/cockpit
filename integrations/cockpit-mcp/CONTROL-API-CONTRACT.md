# Contrato pendente: Cockpit Internal Control API v1

Este documento é o contrato exato que o core do Cockpit precisa implementar
para o protótipo MCP funcionar em produção. Ele é deliberadamente separado do
WebSocket `/ws`: o WS existente é orientado à UI, transmite buffers completos,
usa broadcasts sem correlação e não fornece ACK de ações.

## 1. Transporte e autenticação

Base URL:

```text
http://127.0.0.1:<porta>/internal/control/v1/
```

Requisitos do servidor de controle:

1. Escutar somente em loopback.
2. Exigir em todas as rotas:

   ```text
   Authorization: Bearer <COCKPIT_CONTROL_TOKEN>
   X-Cockpit-Control-Version: 1
   Accept: application/json
   ```

3. Recusar token ausente/inválido com `401`, `WWW-Authenticate: Bearer` e
   `Cache-Control: no-store`.
4. Não aceitar token em query string, cookie ou body.
5. Não habilitar CORS.
6. Responder apenas JSON UTF-8 e limitar request/response bodies.
7. Nunca incluir env de projeto, credenciais, tokens ou buffers não solicitados
   nas respostas.

O token de controle deve ser independente do Bearer exposto pelo servidor MCP.

### Descriptor de descoberta

O core publica as informações efêmeras de conexão em `control.json`:

```json
{
  "schemaVersion": 1,
  "controlUrl": "http://127.0.0.1:3737/internal/control/v1/",
  "token": "token-aleatorio-com-pelo-menos-32-caracteres",
  "pid": 12345,
  "createdAt": "2026-07-25T12:00:00.000Z",
  "expiresAt": "2026-07-26T12:00:00.000Z"
}
```

O core deve:

1. criar o diretório de destino sem acesso de grupo/outros;
2. gravar um arquivo temporário regular com modo `0600`;
3. sincronizar e renomear atomicamente para `control.json`;
4. nunca criar symlink;
5. rotacionar o token quando o processo de controle reiniciar;
6. remover ou expirar o descriptor no shutdown.

Locais convencionais, em ordem de preferência:

1. `$XDG_RUNTIME_DIR/cockpit/control.json`;
2. `$HOME/.local/state/cockpit/control.json`;
3. `$HOME/.config/cockpit/control.json`.

O adapter aceita path explícito em `COCKPIT_CONTROL_DESCRIPTOR`. Ele abre o
arquivo com `O_NOFOLLOW`, valida owner/modo/tamanho/schema/expiração e mantém o
token apenas em memória.

## 2. Envelopes

Leitura bem-sucedida:

```json
{
  "ok": true,
  "cursor": "opaque-optional-cursor",
  "data": {}
}
```

Ação aceita:

```json
{
  "ok": true,
  "requestId": "830e543e-8bd3-40f6-9851-a6331f9d4d7b",
  "cursor": "opaque-optional-cursor",
  "ack": {
    "accepted": true,
    "completed": false,
    "at": "2026-07-25T12:00:00.000Z"
  },
  "data": {}
}
```

Erro:

```json
{
  "ok": false,
  "error": {
    "code": "TERMINAL_NOT_FOUND",
    "message": "terminal não encontrado"
  }
}
```

`message` deve ser pública, curta e sem dados sensíveis. Códigos mínimos:

- `UNAUTHORIZED` (`401`)
- `PROJECT_FORBIDDEN` (`403`)
- `PROJECT_NOT_FOUND` (`404`)
- `TERMINAL_NOT_FOUND` (`404`)
- `CURSOR_EXPIRED` (`410`)
- `REQUEST_ID_CONFLICT` (`409`)
- `OUTPUT_LIMIT_EXCEEDED` (`413`)
- `RATE_LIMITED` (`429`)
- `CONTROL_UNAVAILABLE` (`503`)

## 3. Cursores e eventos

Cursores são strings opacas de no máximo 512 caracteres. Um cursor identifica
uma posição estável no fluxo de eventos de um terminal.

Regras:

1. O consumidor devolve o cursor recebido no parâmetro `after`.
2. O servidor retorna somente eventos posteriores a `after`, sem duplicar
   eventos dentro da mesma geração do terminal.
3. O cursor da resposta aponta para a posição depois do último evento
   retornado. Se não houver evento novo, pode permanecer igual.
4. Reinício/recriação do terminal deve mudar a geração embutida no cursor.
5. Cursor expirado ou de outra geração retorna `410 CURSOR_EXPIRED`; o erro
   pode incluir `data.earliestCursor`.
6. `max_bytes` limita a soma dos bytes UTF-8 de `events[].data`, não o número
   de caracteres.

Evento:

```json
{
  "cursor": "terminal:t1:generation:4:sequence:91",
  "stream": "stdout",
  "data": "texto UTF-8",
  "ts": "2026-07-25T12:00:00.000Z"
}
```

`stream` é `stdout`, `stderr` ou `system`. A ordem do array é a ordem total do
fluxo observável.

## 4. Request ID, idempotência e ACK

Toda ação recebe o mesmo UUID em dois lugares:

```text
Idempotency-Key: <requestId>
```

```json
{
  "requestId": "<requestId>",
  "confirm": true
}
```

Contrato:

1. Header e body diferentes ou ausentes retornam `400`.
2. `confirm` diferente de `true` retorna `400`.
3. A primeira requisição válida reserva o `requestId` antes de executar.
4. Repetição com mesmo ID e mesmo payload devolve o mesmo resultado/ACK sem
   repetir a ação.
5. Mesmo ID com payload diferente retorna `409 REQUEST_ID_CONFLICT`.
6. A resposta repete exatamente `requestId`.
7. `ack.accepted=true` significa que o core admitiu a ação no terminal alvo.
8. `ack.completed=true` só pode ser usado quando o efeito solicitado já foi
   observado pelo core. `accepted=true, completed=false` é válido para input
   enfileirado.

O adapter rejeita respostas sem `requestId` idêntico ou sem
`ack.accepted=true`.

## 5. Endpoints

### `GET health`

Resposta:

```json
{
  "ok": true,
  "data": {
    "version": "v1",
    "cockpitVersion": "0.17.2"
  }
}
```

### `GET projects`

Resposta:

```json
{
  "ok": true,
  "cursor": "projects:revision:8",
  "data": {
    "projects": [
      {
        "id": "alpha",
        "name": "Alpha",
        "color": "#7c3aed"
      }
    ]
  }
}
```

Não retornar `env`, shell, credenciais ou paths absolutos. O MCP não precisa
desses campos.

### `GET projects/:projectId/terminals`

Resposta:

```json
{
  "ok": true,
  "cursor": "project:alpha:terminals:revision:12",
  "data": {
    "terminals": [
      {
        "id": "t1",
        "name": "Terminal 1",
        "status": "idle",
        "statusText": "aguardando"
      }
    ]
  }
}
```

Não incluir buffer de terminal nessa listagem.

### `GET projects/:projectId/terminals/:terminalId/output`

Query:

| Campo | Regra |
| --- | --- |
| `after` | cursor opaco opcional para leitura inicial |
| `max_bytes` | inteiro `1..1048576` |
| `wait_ms` | inteiro `0..30000` |

`wait_ms=0` é leitura imediata. Valor positivo faz long-poll até surgir evento,
o terminal mudar de estado ou o prazo expirar.

Resposta:

```json
{
  "ok": true,
  "cursor": "terminal:t1:generation:4:sequence:91",
  "data": {
    "status": "busy",
    "timedOut": false,
    "events": [
      {
        "cursor": "terminal:t1:generation:4:sequence:91",
        "stream": "stdout",
        "data": "feito\n",
        "ts": "2026-07-25T12:00:00.000Z"
      }
    ]
  }
}
```

Timeout sem evento retorna `200`, `events: []`, `timedOut: true` e o cursor
atual.

### `POST projects/:projectId/terminals`

Body:

```json
{
  "requestId": "830e543e-8bd3-40f6-9851-a6331f9d4d7b",
  "confirm": true,
  "name": "Agente 2"
}
```

Retorna `201` ou `202`, envelope de ação e `data.terminal` quando o terminal já
estiver materializado.

### `POST projects/:projectId/terminals/:terminalId/input`

Body:

```json
{
  "requestId": "830e543e-8bd3-40f6-9851-a6331f9d4d7b",
  "confirm": true,
  "data": "pwd\n"
}
```

`data` é texto UTF-8, no máximo 8192 caracteres, sem byte NUL. O core deve
admitir o payload como uma única ação idempotente.

### `POST projects/:projectId/terminals/:terminalId/interrupt`

Body:

```json
{
  "requestId": "830e543e-8bd3-40f6-9851-a6331f9d4d7b",
  "confirm": true,
  "kind": "interrupt"
}
```

`interrupt` é uma intenção semântica. O core decide a operação segura para o
PTY/process group; o adapter não injeta `Ctrl-C`, não escolhe PID e não executa
comando de shell.

## 6. Lacuna atual

O core atual oferece `/projects.json` e `/ws`, mas isso não satisfaz este
contrato:

- `/projects.json` não autentica nem fornece terminal cursor;
- o `hello` do WS inclui buffers completos;
- ações WS não têm `requestId`, idempotência ou ACK;
- respostas de criação/restart são broadcasts e podem ser correlacionadas
  incorretamente sob concorrência;
- `input` não devolve confirmação de admissão.

Por esses motivos, não há fallback automático para `/ws`.
