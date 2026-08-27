#!/usr/bin/env node
// lifeaictl — falar com a LifeAi de qualquer terminal.
//
// O serviço gera uma chave nova de API a cada subida e a publica no descriptor
// (0600). Este comando lê de lá, então nunca há segredo digitado à mão nem
// chave fixa em arquivo de shell.
//
// Uso:
//   lifeaictl status
//   lifeaictl ask "o que você precisa"
//   lifeaictl approve <runId> once|session|always|deny
//   lifeaictl stop <runId>
//   lifeaictl console [--no-open]

import { spawn } from "child_process";

import { createLifeAiClient } from "../lib/lifeai-client.js";

const SILENCIO = { log: () => {} };
const client = createLifeAiClient({ log: SILENCIO });

function uso(codigo = 1) {
  process.stderr.write([
    "uso: lifeaictl status",
    "     lifeaictl ask \"sua demanda\"",
    "     lifeaictl approve <runId> once|session|always|deny",
    "     lifeaictl stop <runId>",
    "     lifeaictl console [--no-open]",
    "",
  ].join("\n"));
  process.exit(codigo);
}

async function comandoStatus() {
  const state = await client.state();
  if (state.running) {
    process.stdout.write(`LifeAi de pé desde ${state.startedAt || "?"}\n`);
    return;
  }
  process.stdout.write(`LifeAi indisponível (${state.reason})\n${state.startCommand}\n`);
  process.exitCode = 1;
}

async function comandoConsole(abrir) {
  // O console vive no repositório lifeai-console e tem login próprio. Aqui só
  // se confere que ele está atendendo — se não estiver, a mensagem de erro diz
  // o que subir, em vez de abrir uma aba morta.
  const { url } = await client.consoleUrl();
  process.stdout.write(`${url}\n`);
  if (!abrir) return;
  const navegador = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  navegador.on("error", () => {
    process.stderr.write("não consegui abrir o navegador — cole o endereço acima\n");
  });
  navegador.unref();
}

async function comandoAsk(texto) {
  // Saída do agente é dado para ler, nunca instrução para executar: só imprime.
  let pendente = null;
  // O run manda o texto duas vezes: em pedaços (message.delta) e inteiro no
  // fim. Imprimir os dois mostraria a resposta duplicada.
  let houveDelta = false;
  const pronto = new Promise((resolve) => {
    client.ask(texto, {
      sessionKey: "lifeaictl",
      onEvent: (event) => {
        switch (event.event) {
          case "tool.started":
            process.stderr.write(`· ${event.tool || "ferramenta"}\n`);
            break;
          case "message.delta":
            if (event.delta) {
              houveDelta = true;
              process.stdout.write(String(event.delta));
            }
            break;
          case "approval.request":
            pendente = event;
            process.stderr.write(
              `\n⏸ pede aprovação: ${[event.title, event.command].filter(Boolean).join(" — ")}\n`
              + `  responda: lifeaictl approve ${event.run_id} once|deny\n`,
            );
            resolve();
            break;
          case "run.completed":
            if (houveDelta) process.stdout.write("\n");
            else if (event.output) process.stdout.write(`${String(event.output)}\n`);
            resolve();
            break;
          case "run.failed":
          case "run.cancelled":
            process.stderr.write(`\n✕ ${event.event}: ${event.error || ""}\n`);
            process.exitCode = 1;
            resolve();
            break;
          default:
            break;
        }
      },
    }).catch((error) => {
      process.stderr.write(`✕ ${error.message}\n`);
      process.exitCode = 1;
      resolve();
    });
  });
  await pronto;
  // Sem aprovação pendente o run acabou; com ela, o processo sai e o usuário
  // decide num segundo comando — travar o terminal esperando não ajuda.
  if (!pendente) process.stdout.write("");
}

const [comando, ...resto] = process.argv.slice(2);

try {
  if (comando === "status") await comandoStatus();
  else if (comando === "console") await comandoConsole(!resto.includes("--no-open"));
  else if (comando === "ask") {
    const texto = resto.join(" ").trim();
    if (!texto) uso();
    await comandoAsk(texto);
  } else if (comando === "approve") {
    const [runId, escolha] = resto;
    if (!runId || !["once", "session", "always", "deny"].includes(escolha)) uso();
    await client.approve(runId, escolha);
    process.stdout.write("ok\n");
  } else if (comando === "stop") {
    const [runId] = resto;
    if (!runId) uso();
    await client.stopRun(runId);
    process.stdout.write("ok\n");
  } else uso(comando ? 1 : 0);
} catch (error) {
  process.stderr.write(`✕ ${error.message}\n`);
  process.exit(1);
}
