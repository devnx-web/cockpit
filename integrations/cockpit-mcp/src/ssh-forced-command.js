#!/usr/bin/env node

import { runCli } from "./index.js";

const requested = String(process.env.SSH_ORIGINAL_COMMAND || "").trim();
if (requested && requested !== "cockpit-mcp") {
  process.stderr.write("[cockpit-mcp] comando SSH recusado\n");
  process.exitCode = 126;
} else {
  runCli({ argv: ["--stdio"] }).catch((error) => {
    process.stderr.write(
      `[cockpit-mcp] falha de configuração/boot: ${String(error.message).replace(
        /[\r\n]+/g,
        " ",
      )}\n`,
    );
    process.exitCode = 1;
  });
}
