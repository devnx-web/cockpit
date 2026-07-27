#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http-server.js";
import { startStdioServer } from "./stdio-server.js";

function stderrLine(stderr, message) {
  stderr.write(`${String(message).replace(/[\r\n]+/g, " ")}\n`);
}

export function parseCliArgs(argv, env = process.env) {
  let transport = env.COCKPIT_MCP_TRANSPORT || "stdio";
  let explicit = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--stdio" || arg === "--http") {
      if (explicit) throw new Error("escolha somente --stdio ou --http");
      transport = arg.slice(2);
      explicit = true;
      continue;
    }
    throw new Error(`argumento desconhecido: ${arg}`);
  }
  return { help, transport };
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
} = {}) {
  const { help, transport } = parseCliArgs(argv, env);
  if (help) {
    stderrLine(
      stderr,
      "uso: cockpit-mcp [--stdio|--http] (padrão: --stdio)",
    );
    return { mode: "help" };
  }

  const config = loadConfig(env, { transport });
  if (transport === "stdio") {
    const runtime = await startStdioServer(config, {
      input: stdin,
      output: stdout,
      onError: (error) =>
        stderrLine(stderr, `[cockpit-mcp] erro MCP: ${error.message}`),
      ...dependencies,
    });
    const stop = () => {
      runtime.close().catch((error) => {
        stderrLine(stderr, `[cockpit-mcp] falha ao encerrar: ${error.message}`);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runtime.done;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return { mode: "stdio" };
  }

  const runtime = await startHttpServer(config, dependencies);
  const address =
    typeof runtime.address === "object" && runtime.address
      ? runtime.address.address
      : config.host;
  const port =
    typeof runtime.address === "object" && runtime.address
      ? runtime.address.port
      : config.port;
  stderrLine(
    stderr,
    `[cockpit-mcp] HTTP ativo em http://${address}:${port}/mcp`,
  );

  let stopPromise = null;
  const stop = () => {
    if (!stopPromise) stopPromise = runtime.close();
    return stopPromise;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { mode: "http", runtime, close: stop };
}

async function main() {
  await runCli();
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  main().catch((error) => {
    stderrLine(
      process.stderr,
      `[cockpit-mcp] falha de configuração/boot: ${error.message}`,
    );
    process.exitCode = 1;
  });
}
