// Conversa com a LifeAi pelo proxy do console.
//
// Não há chave nenhuma aqui: o cookie de sessão do console autentica, e é o
// servidor que injeta a credencial da LifeAi ao repassar. Por isso todo pedido
// é same-origin e nenhum endereço da LifeAi aparece no navegador.

/** Erro com o texto que a LifeAi devolveu, para a aba mostrar em vez de sumir. */
export class ErroApi extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = "ErroApi";
    this.status = status;
  }
}

async function pedir(metodo, rota, corpo) {
  const resposta = await fetch(rota, {
    method: metodo,
    headers: corpo === undefined ? {} : { "content-type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await resposta.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { /* resposta não-JSON */ }
  if (!resposta.ok) {
    if (resposta.status === 401) {
      throw new ErroApi(401, "sessão do console expirou — rode: lifeaictl console");
    }
    const detalhe = dados?.erro || dados?.error?.message || dados?.error || texto.slice(0, 200);
    throw new ErroApi(resposta.status, detalhe || `falhou com ${resposta.status}`);
  }
  return dados;
}

export const api = {
  get: (rota) => pedir("GET", rota),
  post: (rota, corpo = {}) => pedir("POST", rota, corpo),
  patch: (rota, corpo = {}) => pedir("PATCH", rota, corpo),
  del: (rota) => pedir("DELETE", rota),
};

/**
 * Acompanha um run. Cada frame do stream é dado produzido pelo agente: quem
 * chama exibe, nunca executa.
 *
 * Devolve uma função para desistir. Fecha sozinho nos eventos terminais — sem
 * isso o EventSource reconectaria para sempre num run que já acabou.
 */
export function acompanhar(runId, aoEvento) {
  const fonte = new EventSource(`/v1/runs/${encodeURIComponent(runId)}/events`);
  const terminais = new Set(["run.completed", "run.failed", "run.cancelled"]);
  let fechada = false;

  const fechar = () => {
    if (fechada) return;
    fechada = true;
    fonte.close();
  };

  fonte.onmessage = (frame) => {
    let evento;
    try { evento = JSON.parse(frame.data); } catch { return; }
    aoEvento(evento);
    if (terminais.has(evento.event)) fechar();
  };
  fonte.onerror = () => {
    if (fechada) return;
    fechar();
    aoEvento({ event: "run.failed", run_id: runId, error: "o stream do run caiu" });
  };

  return fechar;
}

/** Data legível em horário de Brasília, ou traço quando não veio nada. */
export function quando(valor) {
  if (!valor) return "—";
  const data = typeof valor === "number" ? new Date(valor * 1000) : new Date(valor);
  if (Number.isNaN(data.getTime())) return String(valor);
  return data.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
