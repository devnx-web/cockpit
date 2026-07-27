# Cockpit Voice no Linux

Esta integração usa o aplicativo oficial ChatGPT/Codex dentro de uma VM Windows
11 com KVM. A prioridade é preservar o Voice incluído na assinatura: microfone,
resposta falada, interrupção natural e coordenação de tarefas Codex.

O Wine não é o runtime principal. O app Windows atual é um MSIX que depende de
AppX/Store, identidade de pacote, licenciamento, protocolo OAuth e integrações de
sandbox do Windows. Extraí-lo no Wine pode abrir a janela, mas não entrega uma
base confiável para Voice e Codex.

## Layout

Por padrão, dados grandes ficam fora do repositório:

```text
~/.local/share/Cockpit/windows-voice/
├── downloads/
│   ├── Windows11-Enterprise-Eval-25H2-pt-BR-x64.iso
│   └── ChatGPT-x64.msix
├── share/
└── vm/
    ├── windows11-codex.qcow2
    ├── OVMF_VARS_4M.ms.fd
    └── tpm/
```

Defina `COCKPIT_WINVOICE_HOME` para usar outro local.

## Recursos da VM

- KVM + CPU host;
- 6 vCPUs e 12 GiB de RAM por padrão;
- disco QCOW2 thin de 120 GiB;
- UEFI com chaves Microsoft e TPM 2.0;
- áudio duplex PipeWire exposto como Intel HDA;
- rede NAT de usuário;
- pacote MSIX servido somente em `127.0.0.1:18080` e acessado pela VM como
  `10.0.2.2`, sem duplicá-lo no pendrive FAT;
- janela padrão de 1280 × 800 com `Zoom To Fit`, reposicionada em 100 × 100;
- RDP futuro encaminhado somente em `127.0.0.1:3390`;
- disco compartilhado somente leitura com o instalador oficial.

Overrides:

```bash
COCKPIT_WINVOICE_MEMORY_MB=16384 \
COCKPIT_WINVOICE_VCPUS=8 \
./run-vm.sh
```

O tamanho da janela pode ser ajustado com
`COCKPIT_WINVOICE_WINDOW_WIDTH`, `COCKPIT_WINVOICE_WINDOW_HEIGHT`,
`COCKPIT_WINVOICE_WINDOW_X` e `COCKPIT_WINVOICE_WINDOW_Y`.

## Preparar

Os downloads usados são oficiais:

- Windows 11 Enterprise Evaluation 25H2 PT-BR:
  `https://aka.ms/Win11E-ISO-25H2-pt-br`
- ChatGPT/Codex x64:
  `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix`

`create-vm.sh` confere tamanho e SHA-256 dos dois arquivos antes de criar a
máquina. O hash esperado da ISO PT-BR é o publicado no PDF oficial da
Microsoft; um download parcial nunca é aceito.

Depois que os arquivos terminarem de baixar:

```bash
./create-vm.sh
./run-vm.sh
```

Enquanto o download estiver em andamento, `prepare-and-run-vm.sh` pode ficar
em um serviço do usuário: ele aguarda a unidade de download terminar, valida
as mídias, cria a VM e abre a janela do instalador.

Na primeira execução, `Autounattend.xml` instala o Windows em PT-BR no disco
virtual vazio e cria a conta local `Ailiv` sem senha. O pendrive virtual
somente leitura também contém `PRIMEIRO-BOOT.txt` e
`install-chatgpt.ps1`. No primeiro login, ele valida a assinatura do pacote,
instala o aplicativo, libera o microfone e abre a tela de login. Somente a
autenticação do ChatGPT continua manual.

Quando o QCOW2 ainda está vazio, `run-vm.sh` também responde automaticamente
ao prompt “pressione uma tecla para iniciar pelo DVD”. Depois que o disco
recebe o Windows, essa tecla deixa de ser enviada para evitar reinstalações.

## Critério de aprovação

Antes de conectar MCP, validar no app oficial:

1. login ChatGPT persistente;
2. Voice inicia e reconhece o microfone;
3. áudio de resposta não engasga;
4. interrupção durante a fala funciona;
5. Codex inicia uma tarefa e informa progresso por voz;
6. reiniciar a VM não perde login nem configurações.

Somente após esses seis itens a ponte MCP deve receber acesso ao Cockpit.

## Ponte segura para o Linux

A ponte usa um `sshd` user-mode extraído dos pacotes oficiais do Ubuntu. Ele
escuta somente em `127.0.0.1:22222`; a rede NAT do QEMU o alcança como
`10.0.2.2:22222`. As portas SSH e MCP não ficam disponíveis na Wi-Fi.

Prepare o host sem `sudo`:

```bash
./bridge/setup-host.sh
./bridge/start-enrollment.sh
```

O segundo comando mostra um token de uso único e um comando PowerShell. Esse
comando baixa o bootstrap pelo loopback mesmo se a VM já estiver ligada e o
disco FAT ainda não mostrar os novos arquivos.

O Windows cria duas chaves Ed25519 privadas e envia apenas as públicas:

- `cockpit-linux-mcp`: sem shell, sem PTY e com `permitopen` limitado a
  `127.0.0.1:3740`; o forced-command só mantém o túnel ativo;
- `cockpit-linux-dev`: conexão de desenvolvimento com shell, usada pelo suporte
  oficial do app a projetos em hosts SSH.

O MCP continua em loopback nos dois lados. O token fica em arquivo `0600` no
Linux e em uma variável de ambiente do usuário Windows; ele não é escrito no
`config.toml` nem em logs. A política do Cockpit permite somente o projeto
`cockpit`, as capacidades declaradas e terminais pertencentes à ponte.

Depois da matrícula, reinicie o Windows para o app herdar a variável de
autenticação MCP. O túnel reconecta sozinho após quedas. Em
**Settings > Connections**, habilite `cockpit-linux-dev` e selecione
`/home/ftgk/cockpit`. O app inicia `codex app-server` pelo SSH e trabalha
diretamente nos arquivos e no shell do Linux, conforme a documentação oficial de
[Remote connections](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host).

As instruções curtas que ficam disponíveis dentro da VM estão em
[`bridge/PASSO-FINAL-WINDOWS.txt`](./bridge/PASSO-FINAL-WINDOWS.txt).
