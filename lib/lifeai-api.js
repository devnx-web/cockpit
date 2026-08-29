// Cliente HTTP do API server da LifeAi.
//
// Vive aqui porque os dois lados falam o mesmo protocolo: o daemon (que é dono
// do processo e sabe a porta e a chave porque as inventou) e o Cockpit (que as
// lê do descriptor). Um único parser de SSE, um único formato de erro.
//
// Tudo que sai daqui — texto do agente, nome de ferramenta, pedido de aprovação
// — é dado produzido por um processo. Quem consome exibe; nunca executa.

/**
 * @param {object} options
 * @param {string} options.url  base do API server, ex. http://127.0.0.1:41234
 * @param {string} options.key  API_SERVER_KEY correspondente
 */
export function createLifeAiApi({ url, key }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) throw new TypeError("url do API server é obrigatória");

  async function call(method, route, body, { signal } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!response.ok) {
      const detalhe = await response.text().catch(() => "");
      throw new Error(`LifeAi ${method} ${route} → ${response.status} ${detalhe.slice(0, 300)}`);
    }
    return response;
  }

  async function health({ timeoutMs = 0 } = {}) {
    const response = await call("GET", "/v1/health", null, {
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    return response.json().catch(() => ({}));
  }

  /**
   * Consome um stream SSE do núcleo entregando cada evento a `onEvent`.
   * Frames são separados por linha em branco; comentários (": …", o keepalive
   * de 30s) não têm payload e são descartados aqui.
   */
  async function consumeEvents(body, onEvent) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let corte;
      while ((corte = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        for (const linha of frame.split("\n")) {
          if (!linha.startsWith("data:")) continue;
          try { onEvent(JSON.parse(linha.slice(5).trim())); } catch { /* frame parcial */ }
        }
      }
    }
  }

  /**
   * Manda uma demanda e entrega os eventos do run conforme chegam. Devolve o
   * run_id assim que o run existe — o stream segue em background e termina
   * sozinho.
   *
   * `sessionKey` é a conversa: mandar sempre o mesmo valor faz o núcleo
   * continuar o histórico em vez de começar do zero. Cada cliente (painel,
   * Telegram) tem o seu, senão as conversas se misturam.
   */
  async function ask(prompt, { sessionKey = "cockpit", onEvent = () => {} } = {}) {
    const criado = await call("POST", "/v1/runs", {
      input: String(prompt),
      session_id: String(sessionKey),
    });
    const { run_id: runId } = await criado.json();
    if (!runId) throw new Error("LifeAi não devolveu run_id");

    (async () => {
      const stream = await call("GET", `/v1/runs/${runId}/events`);
      await consumeEvents(stream.body, onEvent);
    })().catch((error) => {
      onEvent({ event: "run.failed", run_id: runId, error: error.message });
    });

    return runId;
  }

  /** Resolve uma aprovação pendente. `choice`: once | session | always | deny. */
  async function approve(runId, choice) {
    const response = await call("POST", `/v1/runs/${runId}/approval`, { choice });
    return response.json();
  }

  async function stopRun(runId) {
    const response = await call("POST", `/v1/runs/${runId}/stop`, {});
    return response.json();
  }

  /**
   * Avisa que um terminal do Cockpit terminou o turno. Quem decide se algum
   * cron se importa é a LifeAi — daqui vai só o fato.
   */
  async function cronWake(payload, { timeoutMs = 3_000 } = {}) {
    const response = await call("POST", "/v1/cron/wake", payload, {
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    return response.json().catch(() => ({}));
  }

  return { base, call, health, ask, approve, stopRun, cronWake };
}
