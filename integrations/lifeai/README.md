# LifeAi como serviço

A LifeAi não é mais processo filho do Cockpit. Ela roda como **systemd user
unit**, sobe no boot e sobrevive ao fechamento da janela — é o que faz o bot do
Telegram continuar respondendo do celular com o computador sem ninguém na
frente.

O daemon (`bin/lifeaid.js`) vive neste repositório porque precisa do broker
Claude do Cockpit (`lib/team-accounts.js`, `lib/team-router.js`), mas sobe um
broker **próprio**, com homes isoladas em `~/.lifeai/broker/`, lendo o mesmo
`~/.cockpit/team-auth.json`. Assim as duas coisas nunca disputam arquivo.

## Instalar

```sh
install -Dm644 integrations/lifeai/lifeai.service ~/.config/systemd/user/lifeai.service
systemctl --user daemon-reload
systemctl --user enable --now lifeai

# sem linger o serviço morre no logout — e aí o Telegram fica mudo
loginctl enable-linger "$USER"
```

Se o repositório não estiver em `/home/ftgk/cockpit`, ajuste o `ExecStart`
antes de instalar.

## Operar

```sh
systemctl --user status lifeai
systemctl --user restart lifeai
journalctl --user -u lifeai -f
```

## Dar comando de qualquer terminal

`bin/lifeaictl.js` lê o descriptor e conversa com o serviço. A chave da API é
gerada a cada subida e vive só no descriptor — não há segredo para digitar nem
guardar no shell.

```sh
alias lifeai='node /home/ftgk/cockpit/bin/lifeaictl.js'

lifeai status
lifeai ask "levanta o que quebrou no build de ontem"
lifeai approve <runId> once      # ou session | always | deny
lifeai stop <runId>
```

Quando ela pede aprovação, o comando devolve o `runId` e sai — responder num
segundo comando é melhor do que travar o terminal esperando.

> `~/lifeai/bin/lifeai` (o CLI do núcleo) **não** conversa com o serviço: ele
> abre outra instância, que não tem a credencial do broker no env. Use-o só
> para `doctor`, `gateway setup` e afins.

## Console (a cara web) — mora em outro repositório

O console **não é mais servido por este repositório**. Ele virou projeto
próprio, o `lifeai-console` (Vite + React na frente, BFF em Node atrás), que
sobe sozinho em `http://127.0.0.1:4750` e tem login, sessão e build próprios. O
daemon daqui não serve mais HTML, não faz proxy autenticado e não emite ticket.

O Cockpit só sabe **um endereço** e abre uma janela nele:

```sh
lifeai console            # confere que o console atende, imprime e abre
lifeai console --no-open  # só imprime
```

`LIFEAI_CONSOLE_URL` muda o endereço (padrão `http://127.0.0.1:4750`). Se
ninguém atender ali, tanto o comando quanto o botão do painel dizem isso em
texto — nada de aba em branco ou erro de Chromium.

No Cockpit, o botão **console** no topo do painel da LifeAi faz o mesmo. Ele
aparece mesmo com o serviço `lifeai` parado, porque o console é outro processo:
quem explica o que está fora do ar é a resposta do clique.

## Segredos

Tokens de gateway vão em `~/.lifeai/env`, nunca no `config.yaml` e nunca no Git:

```sh
install -d -m700 ~/.lifeai
printf 'TELEGRAM_BOT_TOKEN=...\n' > ~/.lifeai/env
chmod 600 ~/.lifeai/env
systemctl --user restart lifeai
```

## Como o Cockpit encontra a LifeAi

O daemon publica `$XDG_RUNTIME_DIR/lifeai/control.json` (0600) com `apiUrl` e
`apiKey` **só depois** do API server responder ao `/v1/health`. O Cockpit lê
esse arquivo (`lib/lifeai-client.js`), confere que o `pid` ainda existe e vira
cliente HTTP. Com o serviço parado, o painel mostra "desligada" e o comando
para ligar — o Cockpit nunca sobe nem desliga a LifeAi.

A recíproca não é verdadeira: o MCP `cockpit` da LifeAi depende do
`control.json` do Cockpit. Com o Cockpit fechado, as tools `mcp_cockpit_*`
ficam indisponíveis e o resto da LifeAi segue funcionando. É degradação
esperada.

Um detalhe operacional disso: se o serviço subir com o Cockpit fechado (o caso
normal, no boot), o núcleo tenta o MCP três vezes e o deixa *parked*. Abrir o
Cockpit depois não religa sozinho — `systemctl --user restart lifeai` religa.
