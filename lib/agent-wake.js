// Ponte "o agente parou" — Cockpit → LifeAi.
//
// O vigia da LifeAi acordava de 5 em 5 minutos e, na maioria das vezes, só
// descobria que o agente ainda estava ocupado. Aqui o caminho se inverte:
// quando o agente termina o turno, o Cockpit avisa, e a LifeAi acorda na hora.
//
// Dois sinais alimentam a mesma ponte:
//
//   · o hook `Stop` do Claude Code, que bate em POST /wake com o token do
//     próprio terminal — preciso, porque quem avisa é quem terminou;
//   · a heurística de status do server (`ocioso`, aos 30s sem saída), que cobre
//     agente que não é Claude Code ou que morreu sem disparar hook.
//
// A ponte não decide nada sobre o trabalho: ela só diz "esse terminal mexeu".
// Quem sabe qual vigia se importa é a LifeAi (wake_map.json), e quem decide se
// vale rodar agora é o cron — `trigger_job` marca a hora e o ticker respeita
// acordada em curso. Por isso um aviso a mais é barato, e um aviso a menos é
// coberto pelo cron de segurança.

const DEDUPE_MS = 20_000;
const HOURLY_CAP = 20;
const HOUR_MS = 60 * 60 * 1000;

function terminalKey(projectId, terminalId) {
  return `${projectId}/${terminalId}`;
}

/**
 * @param {object} options
 * @param {(payload: object) => Promise<any>} options.notifyLifeAi  entrega o aviso
 * @param {(token: string) => ({session: object, terminal: object}|null)} options.resolveToken
 * @param {() => ({uid: string|null})} [options.device]  identidade da máquina
 * @param {number} [options.dedupeMs]   janela em que o mesmo terminal só avisa uma vez
 * @param {number} [options.hourlyCap]  teto de avisos por terminal por hora
 */
export function createAgentWake({
  notifyLifeAi,
  resolveToken = () => null,
  device = () => ({ uid: null }),
  log = console,
  now = () => Date.now(),
  dedupeMs = DEDUPE_MS,
  hourlyCap = HOURLY_CAP,
} = {}) {
  /** chave do terminal → { sawRunning, lastNotifyAt, hourStart, hourCount } */
  const estado = new Map();

  function paraTerminal(key) {
    let atual = estado.get(key);
    if (!atual) {
      atual = { sawRunning: false, lastNotifyAt: 0, hourStart: now(), hourCount: 0 };
      estado.set(key, atual);
    }
    return atual;
  }

  /**
   * Decide se este aviso sai. As três recusas são a defesa contra o modo de
   * falha que já custou um dia de acordadas perdidas: vigia acordando em laço.
   */
  function podeAvisar(atual, agora) {
    // Terminal parado desde ontem dispararia a cada evento de status. Só avisa
    // quem trabalhou desde o último aviso.
    if (!atual.sawRunning) return "sem trabalho novo";
    // O hook e o `ocioso` contam o mesmo fato com segundos de diferença.
    if (agora - atual.lastNotifyAt < dedupeMs) return "repetido";
    if (agora - atual.hourStart >= HOUR_MS) {
      atual.hourStart = agora;
      atual.hourCount = 0;
    }
    // "ela manda → ele responde em 2s → ela manda": estourou o teto, o cron
    // volta a reger até virar a hora.
    if (atual.hourCount >= hourlyCap) return "teto da hora";
    return null;
  }

  /**
   * Registra o aviso e o entrega. Falha de entrega nunca sobe: a LifeAi
   * desligada é um estado normal, e o cron de segurança cobre o buraco.
   */
  function avisar(session, terminal, motivo) {
    const key = terminalKey(session.proj.id, terminal.id);
    const atual = paraTerminal(key);
    const agora = now();

    const recusa = podeAvisar(atual, agora);
    if (recusa) return { sent: false, reason: recusa };

    atual.sawRunning = false;
    atual.lastNotifyAt = agora;
    atual.hourCount += 1;

    // `front_uid` é o endereço que dura; `terminal_id` e `terminal_title` vão
    // junto como rótulo de log e como compatibilidade com o mapa antigo, que
    // ainda casa por prefixo de título.
    const payload = {
      project: session.proj.id,
      front_uid: terminal.frontUid || null,
      device_uid: device()?.uid || null,
      terminal_id: terminal.id,
      terminal_title: terminal.name || "",
      event: motivo,
    };

    Promise.resolve()
      .then(() => notifyLifeAi(payload))
      .then((resposta) => {
        const jobs = resposta?.triggered;
        if (Array.isArray(jobs) && jobs.length > 0) {
          log.log?.(`[wake] ${key} (${motivo}) acordou ${jobs.join(", ")}`);
        }
      })
      .catch((error) => {
        // Inclui LifeAiUnavailable. Uma linha, sem stack: isso acontece toda
        // vez que o serviço está reiniciando, e não é notícia.
        log.log?.(`[wake] ${key} não entregue: ${error.message}`);
      });

    return { sent: true, reason: motivo };
  }

  /**
   * Chamado pelo server a cada mudança de status — a mesma leitura de onde a
   * demanda deriva, sem heurística nova.
   */
  function onTerminalStatus(session, terminal, status, statusText = "") {
    const atual = paraTerminal(terminalKey(session.proj.id, terminal.id));
    if (status === "running") {
      atual.sawRunning = true;
      return { sent: false, reason: "trabalhando" };
    }
    // "pausado" é pausa curta entre blocos de saída; "ocioso" é o que o
    // server só declara aos 30s parado.
    if (status === "idle" && /ocioso/i.test(statusText)) return avisar(session, terminal, "ocioso");
    if (status === "waiting") return avisar(session, terminal, "aguardando");
    return { sent: false, reason: "sem mudança relevante" };
  }

  function lerCorpo(req, limite = 4096) {
    return new Promise((resolve) => {
      let bruto = "";
      req.on("data", (pedaco) => {
        bruto += pedaco;
        if (bruto.length > limite) {
          bruto = bruto.slice(0, limite);
          req.destroy();
        }
      });
      req.on("end", () => resolve(bruto));
      req.on("error", () => resolve(""));
      req.on("close", () => resolve(bruto));
    });
  }

  /**
   * POST /wake — o hook do agente. Autenticado pelo token do próprio terminal,
   * que não dá poder nenhum além de dizer "eu parei": o corpo é ignorado fora
   * do nome do evento, e a resposta é sempre 204 para não virar canal de
   * sondagem.
   */
  function handle(req, res, u) {
    if (u?.pathname !== "/wake") return false;
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return true;
    }

    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const alvo = token ? resolveToken(token) : null;
    if (!alvo) {
      res.writeHead(401);
      res.end();
      return true;
    }

    lerCorpo(req).then((bruto) => {
      let evento = "stop";
      try {
        const corpo = JSON.parse(bruto || "{}");
        if (typeof corpo.event === "string" && corpo.event) {
          evento = corpo.event.slice(0, 40).replace(/[^\w.-]/g, "");
        }
      } catch {
        // Corpo ilegível não invalida o aviso: o token já disse qual terminal é.
      }
      avisar(alvo.session, alvo.terminal, `hook:${evento || "stop"}`);
      res.writeHead(204);
      res.end();
    });
    return true;
  }

  /** Só para teste e diagnóstico. */
  function inspect(projectId, terminalId) {
    return estado.get(terminalKey(projectId, terminalId)) || null;
  }

  function forget(projectId, terminalId) {
    estado.delete(terminalKey(projectId, terminalId));
  }

  return { handle, onTerminalStatus, inspect, forget };
}
