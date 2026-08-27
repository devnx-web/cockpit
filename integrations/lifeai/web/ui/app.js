// Console Ailiv — casca: abas, sinal de vida e a barra de aviso.

import { api } from "./api.js";
import { limpar } from "./dom.js";
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

let esconderAviso = null;

/** Um aviso por vez, sempre em texto puro: nunca vira interface clicável. */
export function avisar(mensagem) {
  barraAviso.textContent = String(mensagem);
  barraAviso.hidden = false;
  clearTimeout(esconderAviso);
  esconderAviso = setTimeout(() => { barraAviso.hidden = true; }, 9_000);
}

function abrir(nome) {
  const montar = ABAS[nome] || ABAS.conversa;
  for (const botao of document.querySelectorAll(".aba")) {
    botao.setAttribute("aria-selected", botao.dataset.aba === nome ? "true" : "false");
  }
  limpar(palco);
  location.hash = `#${nome}`;
  try {
    montar(palco, { avisar });
  } catch (error) {
    avisar(`não consegui abrir "${nome}": ${error.message}`);
  }
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
