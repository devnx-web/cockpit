/* LSP client — JSON-RPC sobre WebSocket. Uma instância por (projectId, language). */
(function () {
  const LANG_BY_EXT = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    jsx: "javascriptreact",
    ts: "typescript", mts: "typescript", cts: "typescript",
    tsx: "typescriptreact",
  };

  function languageIdForFile(filename) {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    return LANG_BY_EXT[ext] || null;
  }

  function isLspFile(filename) {
    return languageIdForFile(filename) !== null;
  }

  // map projeto → backend language server label (tsserver atende js+ts)
  function backendLangFor(filename) {
    const lid = languageIdForFile(filename);
    if (!lid) return null;
    if (lid.startsWith("javascript") || lid.startsWith("typescript")) return "typescript";
    return null;
  }

  class LspClient {
    constructor({ projectId, projectPath, backendLang }) {
      this.projectId = projectId;
      this.projectPath = projectPath;
      this.backendLang = backendLang;
      this.ws = null;
      this.nextId = 1;
      this.pending = new Map(); // id → {resolve, reject}
      this.notifications = new Map(); // method → handler[]
      this.openDocs = new Map(); // uri → version
      this.initPromise = null;
      this.dead = false;
      this.diagnosticsHandler = null;
    }

    onNotification(method, fn) {
      if (!this.notifications.has(method)) this.notifications.set(method, []);
      this.notifications.get(method).push(fn);
    }

    connect() {
      if (this.initPromise) return this.initPromise;
      this.initPromise = new Promise((resolve, reject) => {
        const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/lsp?project=${encodeURIComponent(this.projectId)}&lang=${encodeURIComponent(this.backendLang)}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.onopen = async () => {
          try {
            const initResult = await this.request("initialize", {
              processId: null,
              rootUri: "file://" + this.projectPath,
              workspaceFolders: [{ uri: "file://" + this.projectPath, name: this.projectId }],
              capabilities: {
                textDocument: {
                  synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
                  completion: {
                    completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
                  },
                  hover: { contentFormat: ["markdown", "plaintext"] },
                  signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
                  definition: { linkSupport: true },
                  typeDefinition: { linkSupport: true },
                  implementation: { linkSupport: true },
                  references: {},
                  documentSymbol: {},
                  rename: { prepareSupport: true },
                  publishDiagnostics: { relatedInformation: true },
                },
                workspace: { configuration: false, workspaceFolders: true },
              },
              initializationOptions: {
                preferences: {
                  includeCompletionsForModuleExports: true,
                  includeCompletionsWithInsertText: true,
                  importModuleSpecifierPreference: "shortest",
                },
              },
            });
            this.notify("initialized", {});
            resolve(initResult);
          } catch (e) {
            reject(e);
          }
        };
        this.ws.onmessage = (ev) => this.onMessage(ev.data);
        this.ws.onerror = (e) => {
          console.warn("[lsp] ws error", e);
        };
        this.ws.onclose = () => {
          this.dead = true;
          for (const { reject } of this.pending.values()) reject(new Error("lsp closed"));
          this.pending.clear();
        };
      });
      return this.initPromise;
    }

    onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || "lsp error"));
          else p.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        // notification ou request do server (ex.: workspace/configuration). Respondemos null.
        if (msg.id !== undefined) {
          this.send({ jsonrpc: "2.0", id: msg.id, result: null });
        }
        const handlers = this.notifications.get(msg.method) || [];
        for (const h of handlers) {
          try { h(msg.params); } catch (e) { console.warn("[lsp] handler err", e); }
        }
      }
    }

    send(obj) {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.ws.send(JSON.stringify(obj));
    }

    request(method, params) {
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.send({ jsonrpc: "2.0", id, method, params });
        // timeout defensivo
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`lsp ${method} timeout`));
          }
        }, 15000);
      });
    }

    notify(method, params) {
      this.send({ jsonrpc: "2.0", method, params });
    }

    didOpen({ uri, languageId, text }) {
      const version = 1;
      this.openDocs.set(uri, version);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
    }

    didChange({ uri, text }) {
      const v = (this.openDocs.get(uri) || 0) + 1;
      this.openDocs.set(uri, v);
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: v },
        contentChanges: [{ text }],
      });
    }

    didClose({ uri }) {
      this.openDocs.delete(uri);
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }

    isOpen(uri) {
      return this.openDocs.has(uri);
    }

    shutdown() {
      try {
        this.notify("exit", {});
      } catch {}
      try { this.ws && this.ws.close(); } catch {}
    }
  }

  // Pool: 1 cliente por (projectId, backendLang)
  const clients = new Map();

  function getClient(projectId, projectPath, filename) {
    const backendLang = backendLangFor(filename);
    if (!backendLang) return null;
    const key = `${projectId}:${backendLang}`;
    let c = clients.get(key);
    if (!c) {
      c = new LspClient({ projectId, projectPath, backendLang });
      clients.set(key, c);
    }
    return c;
  }

  function shutdownProject(projectId) {
    for (const [k, c] of clients.entries()) {
      if (k.startsWith(projectId + ":")) {
        c.shutdown();
        clients.delete(k);
      }
    }
  }

  window.LSP = {
    getClient,
    shutdownProject,
    languageIdForFile,
    isLspFile,
    backendLangFor,
  };
})();
