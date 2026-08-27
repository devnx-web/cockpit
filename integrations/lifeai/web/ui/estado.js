// Aba Estado — o que a LifeAi é agora: saúde, modelo, skills e toolsets.

import { api, quando } from "./api.js";
import { el, limpar, par, vazio } from "./dom.js";

/**
 * As listas de capacidade vêm ora como texto, ora como objeto com nome. Ler os
 * dois formatos custa três linhas e evita a aba em branco quando o núcleo muda.
 */
function nomes(dados, ...chaves) {
  let bruto = Array.isArray(dados) ? dados : null;
  for (const chave of chaves) {
    if (bruto) break;
    if (Array.isArray(dados?.[chave])) bruto = dados[chave];
  }
  if (!bruto) return [];
  return bruto
    .map((item) => (typeof item === "string" ? item : item?.name || item?.id || ""))
    .filter(Boolean);
}

function duracao(segundos) {
  const total = Number(segundos);
  if (!Number.isFinite(total) || total < 0) return null;
  const dias = Math.floor(total / 86_400);
  const horas = Math.floor((total % 86_400) / 3_600);
  const minutos = Math.floor((total % 3_600) / 60);
  if (dias) return `${dias}d ${horas}h`;
  if (horas) return `${horas}h ${minutos}min`;
  return `${minutos}min`;
}

function fichaEtiquetas(titulo, lista, vazioTexto) {
  return el("div", { class: "ficha" }, [
    el("h2", { texto: `${titulo} (${lista.length})` }),
    lista.length
      ? el("div", { class: "etiquetas" }, lista.map((nome) => el("span", { class: "etiqueta", texto: nome })))
      : vazio(vazioTexto),
  ]);
}

export function montarEstado(palco, { avisar }) {
  const painel = el("div", { class: "painel" });
  const rolagem = el("div", { class: "rolagem" });
  const corpo = el("div");
  painel.append(rolagem);
  palco.append(painel);

  const botaoAtualizar = el("button", { class: "acao", texto: "atualizar", onClick: () => carregar() });

  async function pegar(rota) {
    // Uma rota ausente não pode apagar as outras fichas: cada bloco falha só.
    try {
      return await api.get(rota);
    } catch (error) {
      if (error.status === 401) avisar(error.message);
      return null;
    }
  }

  async function carregar() {
    botaoAtualizar.disabled = true;
    limpar(corpo).append(vazio("lendo…"));
    const [saude, modelos, skills, toolsets] = await Promise.all([
      pegar("/health/detailed"),
      pegar("/v1/models"),
      pegar("/v1/skills"),
      pegar("/v1/toolsets"),
    ]);
    botaoAtualizar.disabled = false;
    limpar(corpo);

    if (!saude && !modelos && !skills && !toolsets) {
      corpo.append(vazio("a LifeAi não respondeu. Confira com: systemctl --user status lifeai"));
      return;
    }

    const emUso = modelos?.default || modelos?.current || modelos?.model
      || (Array.isArray(modelos?.data) ? modelos.data.find((m) => m?.default)?.id : null);

    corpo.append(el("div", { class: "ficha" }, [
      el("h2", { texto: "Serviço" }),
      el("dl", {}, [
        par("estado", saude?.status || (saude ? "de pé" : "sem resposta")),
        par("de pé há", duracao(saude?.uptime_seconds ?? saude?.uptime) || "—"),
        par("versão", saude?.version),
        par("modelo em uso", emUso),
        par("lido em", quando(new Date().toISOString())),
      ]),
    ]));

    const componentes = saude?.components || saude?.checks;
    if (componentes && typeof componentes === "object") {
      const pares = Object.entries(componentes).map(([nome, valor]) => par(
        nome,
        typeof valor === "object" && valor ? (valor.status || JSON.stringify(valor)) : String(valor),
      ));
      if (pares.length) corpo.append(el("div", { class: "ficha" }, [el("h2", { texto: "Componentes" }), el("dl", {}, pares)]));
    }

    corpo.append(
      fichaEtiquetas("Skills", nomes(skills, "skills", "data"), "nenhuma skill carregada."),
      fichaEtiquetas("Toolsets", nomes(toolsets, "toolsets", "data"), "nenhum toolset carregado."),
      fichaEtiquetas("Modelos", nomes(modelos, "models", "data"), "a LifeAi não listou modelos."),
    );
  }

  rolagem.append(
    el("div", { class: "titulo-secao" }, [
      el("span", { texto: "Estado da LifeAi  " }),
      botaoAtualizar,
    ]),
    corpo,
  );
  carregar();
}
