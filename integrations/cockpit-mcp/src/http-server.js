import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { bearerAuth } from "./auth.js";
import { createConfiguredControlClient } from "./reloading-control-client.js";
import { createCockpitMcpServer } from "./tools.js";

function jsonRpcError(res, status, message) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: status === 404 ? -32001 : -32000,
      message,
    },
    id: null,
  });
}

export function createHttpApp(config, dependencies = {}) {
  const client =
    dependencies.client ||
    createConfiguredControlClient(config);
  const createMcpServer =
    dependencies.createMcpServer ||
    (() => createCockpitMcpServer(config, client));
  const app = createMcpExpressApp({ host: config.host });
  const sessions = new Map();
  let pendingSessions = 0;

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    next();
  });

  const authenticate = bearerAuth(config.token);

  app.get("/healthz", authenticate, async (_req, res) => {
    try {
      const control = await client.health();
      res.json({
        ok: true,
        cockpit: true,
        cockpitVersion: control.data?.cockpitVersion || null,
        sessions: sessions.size,
      });
    } catch {
      res.status(503).json({
        ok: false,
        cockpit: false,
        sessions: sessions.size,
      });
    }
  });

  app.post("/mcp", authenticate, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      let entry = typeof sessionId === "string" ? sessions.get(sessionId) : null;

      if (!entry && !sessionId && isInitializeRequest(req.body)) {
        if (sessions.size + pendingSessions >= config.maxSessions) {
          jsonRpcError(res, 429, "Too many active MCP sessions");
          return;
        }

        pendingSessions += 1;
        let transport;
        let mcpServer;
        try {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, entry);
            },
          });
          mcpServer = createMcpServer();
          entry = { transport, mcpServer };
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) sessions.delete(id);
          };
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          await transport?.close().catch(() => {});
          await mcpServer?.close().catch(() => {});
          throw error;
        } finally {
          pendingSessions -= 1;
        }
        return;
      }

      if (!entry) {
        jsonRpcError(
          res,
          sessionId ? 404 : 400,
          sessionId
            ? "Unknown MCP session"
            : "Missing MCP session; initialize first",
        );
        return;
      }

      await entry.transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        jsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const entry =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!entry) {
      jsonRpcError(res, sessionId ? 404 : 400, "Invalid or missing MCP session");
      return;
    }
    try {
      await entry.transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  };

  app.get("/mcp", authenticate, handleSessionRequest);
  app.delete("/mcp", authenticate, handleSessionRequest);

  app.all("/mcp", authenticate, (_req, res) => {
    res.setHeader("Allow", "GET, POST, DELETE");
    jsonRpcError(res, 405, "Method not allowed");
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = error?.type === "entity.too.large" ? 413 : 400;
    res.status(status).json({ error: status === 413 ? "body_too_large" : "bad_request" });
  });

  return {
    app,
    client,
    sessions,
    async closeSessions() {
      const entries = [...new Set(sessions.values())];
      sessions.clear();
      await Promise.allSettled(
        entries.map(async ({ transport, mcpServer }) => {
          await transport.close().catch(() => {});
          await mcpServer.close().catch(() => {});
        }),
      );
    },
  };
}

export async function startHttpServer(config, dependencies = {}) {
  const runtime = createHttpApp(config, dependencies);
  const httpServer = await new Promise((resolve, reject) => {
    const server = runtime.app.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });

  return {
    ...runtime,
    httpServer,
    address: httpServer.address(),
    async close() {
      await runtime.closeSessions();
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
