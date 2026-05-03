// LSP bridge — spawna typescript-language-server por projeto e
// proxia stdio do servidor ↔ frames JSON-RPC sobre WebSocket.
//
// Frame LSP (stdio): "Content-Length: N\r\n\r\n<json>"
// Frame WS: cada mensagem WS contém um payload JSON-RPC inteiro.

import { spawn } from "child_process";
import path from "path";
import url from "url";
import fs from "fs";

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const TSSERVER_BIN = path.resolve(
  ROOT,
  "..",
  "node_modules",
  ".bin",
  "typescript-language-server"
);

// uma instância LSP por (projectId × language). Compartilhada entre clients
// WS do mesmo projeto pra economizar e manter cache de tipos.
const servers = new Map(); // key = `${projectId}:${language}` → ServerEntry

function makeKey(projectId, language) {
  return `${projectId}:${language}`;
}

function startTsServer(projectPath) {
  if (!fs.existsSync(TSSERVER_BIN)) {
    throw new Error(`typescript-language-server não encontrado em ${TSSERVER_BIN}`);
  }
  const proc = spawn(TSSERVER_BIN, ["--stdio"], {
    cwd: projectPath,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return proc;
}

class ServerEntry {
  constructor(projectId, projectPath, language) {
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.language = language;
    this.clients = new Set(); // WebSockets ativos
    this.proc = startTsServer(projectPath);
    this.buffer = Buffer.alloc(0);
    this.dead = false;

    this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk) => {
      // typescript-language-server costuma logar em stderr — útil pra debug
      const txt = chunk.toString();
      if (txt.trim()) console.log(`[lsp:${this.projectId}] ${txt.trim()}`);
    });
    this.proc.on("exit", (code) => {
      this.dead = true;
      console.log(`[lsp:${this.projectId}] exit code=${code}`);
      // notifica clients e remove do registro
      for (const ws of this.clients) {
        try { ws.close(1011, "lsp exited"); } catch {}
      }
      servers.delete(makeKey(this.projectId, this.language));
    });
    this.proc.on("error", (err) => {
      console.log(`[lsp:${this.projectId}] error ${err.message}`);
    });
  }

  onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const m = header.match(/Content-Length: *(\d+)/i);
      if (!m) {
        // header inválido — descarta e avança
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return; // espera mais bytes
      const payload = this.buffer.slice(start, start + len).toString("utf8");
      this.buffer = this.buffer.slice(start + len);
      // broadcast para todos os clients conectados nesse server
      for (const ws of this.clients) {
        if (ws.readyState === 1) ws.send(payload);
      }
    }
  }

  writeMessage(payload) {
    if (this.dead) return false;
    const body = Buffer.from(payload, "utf8");
    const header = `Content-Length: ${body.length}\r\n\r\n`;
    try {
      this.proc.stdin.write(header);
      this.proc.stdin.write(body);
      return true;
    } catch (e) {
      console.log(`[lsp:${this.projectId}] write error ${e.message}`);
      return false;
    }
  }

  attach(ws) {
    this.clients.add(ws);
  }

  detach(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      // ninguém mais usando — encerra após pequena janela pra reconexões
      setTimeout(() => {
        if (this.clients.size === 0 && !this.dead) {
          console.log(`[lsp:${this.projectId}] sem clients, encerrando`);
          try { this.proc.kill(); } catch {}
        }
      }, 30_000);
    }
  }
}

export function attachLspWebSocket(ws, { projectId, projectPath, language = "typescript" }) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "window/showMessage",
      params: { type: 1, message: `projeto inválido: ${projectPath}` },
    }));
    ws.close(1011, "invalid project");
    return;
  }
  const key = makeKey(projectId, language);
  let entry = servers.get(key);
  if (!entry || entry.dead) {
    entry = new ServerEntry(projectId, projectPath, language);
    servers.set(key, entry);
    console.log(`[lsp:${projectId}] spawn @ ${projectPath}`);
  }
  entry.attach(ws);

  ws.on("message", (raw) => {
    const text = raw.toString("utf8");
    entry.writeMessage(text);
  });
  ws.on("close", () => entry.detach(ws));
  ws.on("error", () => entry.detach(ws));
}

export function shutdownAllLsp() {
  for (const e of servers.values()) {
    try { e.proc.kill(); } catch {}
  }
  servers.clear();
}
