// Console Ailiv — casca: abas, sinal de vida e a barra de aviso.

import { api } from "./api.js";
import { el } from "./dom.js";
import { montarConversa } from "./conversa.js";
import { montarAgenda } from "./agenda.js";
import { montarEstado } from "./estado.js";

const palco = document.getElementById("palco");
const ponto = document.getElementById("ponto");
const barraAviso = document.getElementById("aviso");

const ABAS = {
  conversa: montarConversa,
  agenda: montarAgenda,
  estado: montarEstado,
};

/**
 * Abas já montadas, por nome. Cada uma vive na própria <section> e some com
 * `hidden` em vez de ser destruída.
 *
 * Remontar a cada clique era o que fazia a Conversa perder o run em andamento:
 * a closure dela morria junto com a aba, o EventSource ficava órfão sem sequer
 * ser fechado, e o stream do núcleo não tem replay (nem Last-Event-ID nem
 * cursor) — o que passou enquanto a aba estava fora, passou. Manter viva em
 * memória é a única forma de acompanhar um run até o fim.
 */
const montadas = new Map();

let esconderAviso = null;

/** Um aviso por vez, sempre em texto puro: nunca vira interface clicável. */
export function avisar(mensagem) {
  barraAviso.textContent = String(mensagem);
  barraAviso.hidden = false;
  clearTimeout(esconderAviso);
  esconderAviso = setTimeout(() => { barraAviso.hidden = true; }, 9_000);
}

function abrir(nome) {
  if (!ABAS[nome]) nome = "conversa";
  for (const botao of document.querySelectorAll(".aba")) {
    botao.setAttribute("aria-selected", botao.dataset.aba === nome ? "true" : "false");
  }
  location.hash = `#${nome}`;

  if (!montadas.has(nome)) {
    const section = el("section", { class: "aba-conteudo" });
    palco.append(section);
    montadas.set(nome, section);
    try {
      ABAS[nome](section, { avisar });
    } catch (error) {
      // Sai do mapa: sem isso a aba viraria um caixão vazio para sempre, já que
      // ninguém mais tentaria montá-la.
      montadas.delete(nome);
      section.remove();
      avisar(`não consegui abrir "${nome}": ${error.message}`);
      return;
    }
  }
  for (const [outra, section] of montadas) section.hidden = outra !== nome;
}

document.getElementById("abas").addEventListener("click", (evento) => {
  const botao = evento.target.closest(".aba");
  if (botao) abrir(botao.dataset.aba);
});

/**
 * Sinal de vida. O console fica de pé mesmo com a LifeAi reiniciando, então o
 * ponto é a única forma de distinguir "quieta" de "fora do ar".
 */
async function pulsar() {
  try {
    const saude = await api.get("/v1/health");
    const ocupada = saude?.status && saude.status !== "ok" && saude.status !== "healthy";
    ponto.className = `ponto ${ocupada ? "ocupada" : "viva"}`;
    ponto.title = ocupada ? `LifeAi: ${saude.status}` : "LifeAi respondendo";
  } catch (error) {
    ponto.className = "ponto morta";
    ponto.title = error.status === 401 ? "sessão do console expirou" : "LifeAi não respondeu";
  }
}

abrir((location.hash || "#conversa").slice(1));
pulsar();
setInterval(pulsar, 15_000);
