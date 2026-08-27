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

## Console Ailiv (a cara web)

O daemon também sobe o **Console Ailiv** em `http://127.0.0.1:4747`
(`LIFEAI_CONSOLE_PORT` muda a porta; ocupada, ele cai numa porta livre e
registra no journal). É a LifeAi no navegador, com a identidade do Cockpit, e
funciona com o Cockpit **fechado**.

```sh
lifeai console            # imprime o endereço e abre o navegador
lifeai console --no-open  # só imprime
```

Três abas: **Conversa** (sessões, histórico, stream e cards de aprovação),
**Agenda** (tarefas recorrentes — criar, pausar, retomar, disparar) e **Estado**
(saúde, modelo, skills e toolsets).

Os arquivos ficam em `integrations/lifeai/web/` e são servidos como estão:
HTML + CSS + ESM nativo, **sem etapa de build**. Editar e dar F5 basta.

**Como a sessão funciona.** O endereço não é público: `lifeai console` pede ao
daemon um *ticket* de uso único (60 s), o navegador o troca por um cookie
`HttpOnly; SameSite=Strict` de 12 h e o ticket morre ali. Abrir a porta sem
ticket devolve 401 com a instrução. Reiniciar o serviço invalida os cookies
antigos — é só rodar `lifeai console` de novo.

A chave da LifeAi **nunca chega ao navegador**: quem a injeta é o proxy do
console (`lib/lifeai-console.js`), no servidor. O console escuta só em
loopback, exige `Host` local (contra DNS rebinding) e `Origin` próprio em
qualquer método de escrita.

> Interface local sem senha: qualquer processo do seu usuário pode pedir um
> ticket. É aceitável numa máquina pessoal; expor para fora exigiria
> autenticação de verdade, que não existe aqui.

No Cockpit, o botão **console** no topo do painel da LifeAi faz o mesmo — some
quando o serviço está fora do ar.

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
