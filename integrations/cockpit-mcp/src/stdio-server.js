import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConfiguredControlClient } from "./reloading-control-client.js";
import { createCockpitMcpServer } from "./tools.js";

export async function startStdioServer(config, dependencies = {}) {
  const input = dependencies.input || process.stdin;
  const output = dependencies.output || process.stdout;
  const onError = dependencies.onError || (() => {});
  const client =
    dependencies.client ||
    createConfiguredControlClient(config);
  const mcpServer =
    dependencies.mcpServer || createCockpitMcpServer(config, client);
  const transport = new StdioServerTransport(input, output);

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let closePromise = null;
  const removeInputListeners = () => {
    input.off("end", closeFromInput);
    input.off("close", closeFromInput);
  };
  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        removeInputListeners();
        await mcpServer.close();
      })().finally(resolveDone);
    }
    return closePromise;
  };
  const closeFromInput = () => {
    close().catch(onError);
  };

  transport.onerror = onError;
  transport.onclose = () => {
    removeInputListeners();
    resolveDone();
  };
  input.once("end", closeFromInput);
  input.once("close", closeFromInput);

  try {
    await mcpServer.connect(transport);
  } catch (error) {
    removeInputListeners();
    await transport.close().catch(() => {});
    throw error;
  }

  return {
    client,
    mcpServer,
    transport,
    done,
    close,
  };
}
